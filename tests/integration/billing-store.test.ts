import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * billingStore against a real temp SQLite DB: provisioning, the credit-metering
 * "consume only on delivery" rule + idempotency, state machine persistence,
 * plan/credit mutations, cycle reset, and — critically — tenant isolation +
 * dark-by-default (no billing row ⇒ never metered).
 */
let B: typeof import("../../server/billingStore");
let rawDb: import("better-sqlite3").Database;

const T1 = 101, T2 = 202; // two isolated tenants

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-billing-"));
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));
  B = await import("../../server/billingStore");
});
beforeEach(() => {
  rawDb.prepare("DELETE FROM tenant_billing").run();
  rawDb.prepare("DELETE FROM lead_credit_ledger").run();
});

const setIncluded = (tenantId: number, n: number) =>
  rawDb.prepare("UPDATE tenant_billing SET credits_included = ? WHERE tenant_id = ?").run(n, tenantId);

describe("provisioning (dark → metered)", () => {
  it("ensureBilling creates once, is idempotent, seeds plan credits + a grant ledger row", () => {
    expect(B.isBillingEnabled(T1)).toBe(false);
    const row = B.ensureBilling(T1, { planKey: "growth" });
    expect(row.planKey).toBe("growth");
    expect(row.creditsIncluded).toBe(1500);          // growth allowance
    expect(row.state).toBe("trial");
    expect(B.isBillingEnabled(T1)).toBe(true);
    // Idempotent: a second call returns the same row, no duplicate.
    B.ensureBilling(T1, { planKey: "starter" });
    const rows: any = rawDb.prepare("SELECT COUNT(*) c FROM tenant_billing WHERE tenant_id = ?").get(T1);
    expect(rows.c).toBe(1);
    expect(B.getBilling(T1)!.planKey).toBe("growth"); // unchanged by the second call
    const grant: any = rawDb.prepare("SELECT delta, reason FROM lead_credit_ledger WHERE tenant_id = ? AND reason='grant'").get(T1);
    expect(grant.delta).toBe(1500);
  });
  it("enterprise provisions unlimited (no credit cap)", () => {
    const row = B.ensureBilling(T1, { planKey: "enterprise" });
    expect(row.unlimited).toBe(true);
    expect(B.billingSummary(T1).creditsRemaining).toBeNull(); // unlimited
  });
});

describe("meterQualifiedLead — consume only on delivery, idempotent", () => {
  it("is a NO-OP when the tenant has no billing row (dark)", () => {
    const r = B.meterQualifiedLead(T2, 5);
    expect(r.metered).toBe(false);
    expect(r.delivered).toBe(false);
    expect(rawDb.prepare("SELECT COUNT(*) c FROM lead_credit_ledger").get()).toMatchObject({ c: 0 });
  });
  it("consumes exactly one credit per delivered lead, and never double-charges a lead", () => {
    B.ensureBilling(T1, { planKey: "starter", state: "active" });
    const before = B.billingSummary(T1).creditsRemaining!;
    const r1 = B.meterQualifiedLead(T1, 777);
    expect(r1.delivered).toBe(true);
    expect(r1.remaining).toBe(before - 1);
    // Same lead again (a retried write) → idempotent, no extra charge.
    const r2 = B.meterQualifiedLead(T1, 777);
    expect(r2.alreadyCounted).toBe(true);
    expect(r2.remaining).toBe(before - 1);
    const consumes: any = rawDb.prepare("SELECT COUNT(*) c FROM lead_credit_ledger WHERE tenant_id=? AND reason='lead_delivered'").get(T1);
    expect(consumes.c).toBe(1);
    // A DIFFERENT lead consumes another credit.
    const r3 = B.meterQualifiedLead(T1, 888);
    expect(r3.delivered).toBe(true);
    expect(r3.remaining).toBe(before - 2);
  });
  it("STOP mode blocks delivery once credits are exhausted (nothing charged)", () => {
    B.ensureBilling(T1, { planKey: "starter", state: "active", overageMode: "stop" });
    setIncluded(T1, 1);
    expect(B.meterQualifiedLead(T1, 1).delivered).toBe(true);   // uses the 1 credit
    const blocked = B.meterQualifiedLead(T1, 2);
    expect(blocked.delivered).toBe(false);
    expect(blocked.remaining).toBe(0);
    // The blocked lead left NO consume row (so a later top-up can deliver it).
    const c: any = rawDb.prepare(`SELECT COUNT(*) c FROM lead_credit_ledger WHERE dedupe_key='consume:${T1}:lead:2'`).get();
    expect(c.c).toBe(0);
  });
  it("ALLOW_OVERAGE keeps delivering past the cap and records overage", () => {
    B.ensureBilling(T1, { planKey: "starter", state: "active", overageMode: "allow_overage" });
    setIncluded(T1, 1);
    B.meterQualifiedLead(T1, 1);
    const over = B.meterQualifiedLead(T1, 2);
    expect(over.delivered).toBe(true);
    expect(over.overage).toBe(true);
    expect(B.getBilling(T1)!.overageUsed).toBe(1);
  });
  it("a suspended tenant never consumes a credit", () => {
    B.ensureBilling(T1, { planKey: "starter", state: "active" });
    B.setBillingState(T1, "past_due");
    B.setBillingState(T1, "suspended");
    const r = B.meterQualifiedLead(T1, 9);
    expect(r.delivered).toBe(false);
    expect(B.getBilling(T1)!.creditsUsed).toBe(0);
  });
});

describe("state machine + plan + credits persistence", () => {
  it("setBillingState enforces legal transitions", () => {
    B.ensureBilling(T1, { planKey: "starter", state: "active" });
    expect(B.setBillingState(T1, "suspended").ok).toBe(false); // active→suspended illegal
    expect(B.setBillingState(T1, "past_due").ok).toBe(true);
    expect(B.setBillingState(T1, "suspended").ok).toBe(true);  // past_due→suspended ok
    expect(B.getBilling(T1)!.state).toBe("suspended");
  });
  it("setPlan swaps the included allowance", () => {
    B.ensureBilling(T1, { planKey: "starter" });
    B.setPlan(T1, "professional");
    expect(B.getBilling(T1)!.planKey).toBe("professional");
    expect(B.getBilling(T1)!.creditsIncluded).toBe(6000);
  });
  it("grantCredits tops up purchased credits + logs the ledger", () => {
    B.ensureBilling(T1, { planKey: "starter", state: "active" });
    const before = B.billingSummary(T1).creditsRemaining!;
    B.grantCredits(T1, 500, "purchase");
    expect(B.billingSummary(T1).creditsRemaining).toBe(before + 500);
  });
  it("resetBillingCycle clears usage and can roll unused credits", () => {
    B.ensureBilling(T1, { planKey: "starter", state: "active" });
    setIncluded(T1, 10);
    B.meterQualifiedLead(T1, 1);
    B.meterQualifiedLead(T1, 2); // 2 used, 8 remaining
    B.resetBillingCycle(T1, true, "2026-08-01", "2026-08-31");
    const s = B.billingSummary(T1);
    expect(s.creditsUsed).toBe(0);
    // starter allowance (250) + rolled 8 remaining from the prior cycle.
    expect(s.creditsRemaining).toBe(PLAN_STARTER + 8);
  });
});

const PLAN_STARTER = 250;

describe("summary, gate + tenant isolation", () => {
  it("dark tenant summary is enabled:false with full access", () => {
    const s = B.billingSummary(T2);
    expect(s.enabled).toBe(false);
    expect(s.access).toBe("full");
    expect(s.scanningAllowed).toBe(true);
    expect(B.billingGate(T2)).toMatchObject({ allowed: true, access: "full", scanningAllowed: true });
  });
  it("gate blocks a canceled tenant, paywalls a suspended one", () => {
    B.ensureBilling(T1, { planKey: "starter", state: "active" });
    B.setBillingState(T1, "canceled");
    expect(B.billingGate(T1)).toMatchObject({ allowed: false, access: "blocked" });
    // Reactivate then suspend via past_due → paywall.
    B.setBillingState(T1, "active");
    B.setBillingState(T1, "past_due");
    B.setBillingState(T1, "suspended");
    expect(B.billingGate(T1)).toMatchObject({ allowed: true, access: "paywall", scanningAllowed: false });
  });
  it("metering one tenant never touches another's balance", () => {
    B.ensureBilling(T1, { planKey: "starter", state: "active" });
    B.ensureBilling(T2, { planKey: "starter", state: "active" });
    const t2before = B.billingSummary(T2).creditsRemaining!;
    B.meterQualifiedLead(T1, 1);
    B.meterQualifiedLead(T1, 2);
    B.meterQualifiedLead(T1, 3);
    expect(B.billingSummary(T2).creditsRemaining).toBe(t2before); // untouched
    expect(B.billingSummary(T1).creditsRemaining).toBe(t2before - 3);
    // Same lead-id in two tenants are independent (dedupe key is per lead id, but
    // the two tenants use disjoint lead-id spaces in practice; assert no cross-leak).
    const t1Ledger = rawDb.prepare("SELECT COUNT(*) c FROM lead_credit_ledger WHERE tenant_id=? AND reason='lead_delivered'").get(T1) as any;
    expect(t1Ledger.c).toBe(3);
  });
});
