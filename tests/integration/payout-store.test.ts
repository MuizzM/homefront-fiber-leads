import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * payoutStore against a real temp DB: connected-account lifecycle, the
 * UNIQUE(statement_id) double-pay guard, payout status transitions, tenant
 * scoping, and Connect-webhook event idempotency.
 */
let P: typeof import("../../server/payoutStore");
let rawDb: import("better-sqlite3").Database;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-payout-"));
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));
  P = await import("../../server/payoutStore");
});
beforeEach(() => {
  rawDb.prepare("DELETE FROM rep_payouts").run();
  rawDb.prepare("DELETE FROM rep_payout_accounts").run();
  rawDb.prepare("DELETE FROM billing_events").run();
});

describe("connected accounts", () => {
  it("ensurePayoutAccount is idempotent; stripe id + status sync by account id", () => {
    const a = P.ensurePayoutAccount(10, 1);
    expect(a.onboardingStatus).toBe("none");
    P.ensurePayoutAccount(10, 1);
    expect(rawDb.prepare("SELECT COUNT(*) c FROM rep_payout_accounts").get()).toMatchObject({ c: 1 });

    P.setStripeAccountId(10, "acct_10");
    expect(P.getPayoutAccountByStripeId("acct_10")?.repId).toBe(10);

    P.updateAccountFromStripe("acct_10", { payoutsEnabled: true, chargesEnabled: true, detailsSubmitted: true, disabledReason: null, onboardingStatus: "enabled" });
    const fresh = P.getPayoutAccount(10)!;
    expect(fresh.payoutsEnabled).toBe(true);
    expect(fresh.onboardingStatus).toBe("enabled");
  });

  it("account.updated ordering guard: an OLDER event can't flip payouts back on", () => {
    P.ensurePayoutAccount(10, 1);
    P.setStripeAccountId(10, "acct_10");
    // A newer event RESTRICTS the rep (payouts off).
    P.updateAccountFromStripe("acct_10", { payoutsEnabled: false, chargesEnabled: true, detailsSubmitted: true, disabledReason: "requirements.past_due", onboardingStatus: "restricted", eventCreated: "2026-07-12T10:00:00Z" });
    expect(P.getPayoutAccount(10)!.onboardingStatus).toBe("restricted");
    // A STALE (older) enabled event arrives late → must be ignored.
    P.updateAccountFromStripe("acct_10", { payoutsEnabled: true, chargesEnabled: true, detailsSubmitted: true, disabledReason: null, onboardingStatus: "enabled", eventCreated: "2026-07-12T09:00:00Z" });
    expect(P.getPayoutAccount(10)!.onboardingStatus).toBe("restricted"); // NOT flipped back on
    expect(P.getPayoutAccount(10)!.payoutsEnabled).toBe(false);
  });
});

describe("payout ledger — double-pay guard + transitions", () => {
  it("UNIQUE(statement_id): a second createPendingPayout for the same statement returns the existing row", () => {
    const first = P.createPendingPayout({ tenantId: 1, repId: 10, statementId: 500, amountCents: 124000, destinationAccountId: "acct_10", createdBy: 1 });
    expect(first.created).toBe(true);
    const second = P.createPendingPayout({ tenantId: 1, repId: 10, statementId: 500, amountCents: 124000, destinationAccountId: "acct_10", createdBy: 1 });
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(rawDb.prepare("SELECT COUNT(*) c FROM rep_payouts WHERE statement_id = 500").get()).toMatchObject({ c: 1 });
  });

  it("markPaid/failed/reversed drive the status + fields", () => {
    const { row } = P.createPendingPayout({ tenantId: 1, repId: 10, statementId: 501, amountCents: 5000, destinationAccountId: "acct_10", createdBy: 1 });
    P.markPayoutPaid(row.id, "tr_501");
    let r = P.getPayoutById(row.id)!;
    expect(r.status).toBe("paid");
    expect(r.stripeTransferId).toBe("tr_501");
    expect(r.paidAt).toBeTruthy();

    P.markPayoutReversedByTransfer("tr_501");
    expect(P.getPayoutById(row.id)!.status).toBe("reversed");

    const { row: f } = P.createPendingPayout({ tenantId: 1, repId: 11, statementId: 502, amountCents: 5000, destinationAccountId: "acct_11", createdBy: 1 });
    P.markPayoutFailed(f.id, "balance insufficient");
    const fr = P.getPayoutById(f.id)!;
    expect(fr.status).toBe("failed");
    expect(fr.failureReason).toContain("insufficient");
  });

  it("markReversed matches by transfer id regardless of status (never drops a reversal), never re-reverses", () => {
    const { row } = P.createPendingPayout({ tenantId: 1, repId: 10, statementId: 503, amountCents: 100, destinationAccountId: "a", createdBy: 1 });
    rawDb.prepare("UPDATE rep_payouts SET stripe_transfer_id='tr_503' WHERE id=?").run(row.id);
    expect(P.markPayoutReversedByTransfer("tr_503")).toBe(1);          // applied even though not 'paid'
    expect(P.getPayoutById(row.id)!.status).toBe("reversed");
    expect(P.markPayoutReversedByTransfer("tr_503")).toBe(0);          // idempotent — no re-reverse
    expect(P.markPayoutReversedByTransfer("tr_unknown")).toBe(0);      // unknown transfer → no match
  });

  it("markPayoutFailed refuses to downgrade a row that already holds a transfer id", () => {
    const { row } = P.createPendingPayout({ tenantId: 1, repId: 10, statementId: 504, amountCents: 100, destinationAccountId: "a", createdBy: 1 });
    P.markPayoutPaid(row.id, "tr_504");            // money moved
    P.markPayoutFailed(row.id, "late error");      // must be a NO-OP (has transfer id)
    expect(P.getPayoutById(row.id)!.status).toBe("paid");
  });

  it("resetPayoutForRetry clears a transferless stuck row but never one that moved money", () => {
    const a = P.createPendingPayout({ tenantId: 1, repId: 10, statementId: 505, amountCents: 100, destinationAccountId: "x", createdBy: 1 }).row;
    P.markPayoutProcessing(a.id);
    P.resetPayoutForRetry(a.id);                   // processing + no transfer id → deleted
    expect(P.getPayoutById(a.id)).toBeNull();
    const b = P.createPendingPayout({ tenantId: 1, repId: 11, statementId: 506, amountCents: 100, destinationAccountId: "x", createdBy: 1 }).row;
    P.markPayoutPaid(b.id, "tr_506");
    P.resetPayoutForRetry(b.id);                   // paid + transfer id → NOT deleted
    expect(P.getPayoutById(b.id)?.status).toBe("paid");
  });

  it("listPayouts is tenant-scoped", () => {
    P.createPendingPayout({ tenantId: 1, repId: 10, statementId: 600, amountCents: 100, destinationAccountId: "a", createdBy: 1 });
    P.createPendingPayout({ tenantId: 2, repId: 20, statementId: 601, amountCents: 100, destinationAccountId: "b", createdBy: 1 });
    expect(P.listPayouts(1).length).toBe(1);
    expect(P.listPayouts(2).length).toBe(1);
    expect(P.listPayouts(1, { repId: 20 }).length).toBe(0);
  });
});

describe("connect webhook idempotency", () => {
  it("records once, recognizes re-delivery", () => {
    expect(P.wasConnectEventProcessed("evt_c1")).toBe(false);
    P.recordConnectEvent("evt_c1", "account.updated", "account_updated");
    expect(P.wasConnectEventProcessed("evt_c1")).toBe(true);
    P.recordConnectEvent("evt_c1", "account.updated", "account_updated"); // dup → no throw
    expect(rawDb.prepare("SELECT COUNT(*) c FROM billing_events WHERE event_id='evt_c1'").get()).toMatchObject({ c: 1 });
  });
});
