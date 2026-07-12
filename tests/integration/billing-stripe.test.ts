import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Stripe webhook → billing state, end to end through the real DB: activate on
 * checkout, past_due on payment failure (resolved by subscription-id lookup),
 * renew resets the credit cycle, cancel, no-tenant-match, event idempotency, and
 * the scan-gate block reasons. No network — handleStripeEvent applies intents.
 */
let A: typeof import("../../server/stripeAdapter");
let B: typeof import("../../server/billingStore");
let rawDb: import("better-sqlite3").Database;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-stripe-"));
  process.env.STRIPE_PRICE_STARTER = "price_starter";
  process.env.STRIPE_PRICE_GROWTH = "price_growth";
  process.env.STRIPE_PRICE_PROFESSIONAL = "price_pro";
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));
  B = await import("../../server/billingStore");
  A = await import("../../server/stripeAdapter");
  // The tenantExists guard (finding #6) only trusts a Stripe event's tenantId if
  // it's a REAL tenant — so seed the test tenants (7, 8). 99999 stays absent.
  for (const id of [7, 8]) {
    rawDb.prepare("INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (?,?,?,?,?,?)")
      .run(id, `t${id}`, `Test ${id}`, `Owner ${id}`, `owner${id}@test.com`, `Brand ${id}`);
  }
});
beforeEach(() => {
  rawDb.prepare("DELETE FROM tenant_billing").run();
  rawDb.prepare("DELETE FROM lead_credit_ledger").run();
  rawDb.prepare("DELETE FROM billing_events").run();
});

const evt = (id: string, type: string, object: any, created?: number) => ({ id, type, created, data: { object } });

describe("Stripe webhook → billing lifecycle", () => {
  it("checkout.session.completed activates the tenant with plan + provider ids", () => {
    const r = A.handleStripeEvent(evt("evt_a", "checkout.session.completed", {
      mode: "subscription", payment_status: "paid", client_reference_id: "7",
      metadata: { planKey: "growth" }, customer: "cus_7", subscription: "sub_7",
    }));
    expect(r).toMatchObject({ applied: true, kind: "activate", tenantId: 7 });
    const row = B.getBilling(7)!;
    expect(row.planKey).toBe("growth");
    expect(row.state).toBe("active");
    expect(row.creditsIncluded).toBe(1500);
    expect(row.providerCustomerId).toBe("cus_7");
    expect(row.providerSubscriptionId).toBe("sub_7");
  });

  it("payment_failed → past_due, resolved by subscription-id lookup + grace stamped", () => {
    A.handleStripeEvent(evt("evt_a", "checkout.session.completed", { mode: "subscription", payment_status: "paid", client_reference_id: "7", metadata: { planKey: "growth" }, customer: "cus_7", subscription: "sub_7" }));
    const r = A.handleStripeEvent(evt("evt_b", "invoice.payment_failed", { customer: "cus_7", subscription: "sub_7" }));
    expect(r).toMatchObject({ applied: true, kind: "past_due", tenantId: 7 });
    const row = B.getBilling(7)!;
    expect(row.state).toBe("past_due");
    expect(row.graceEndsAt).toBeTruthy();
  });

  it("invoice.paid renews: back to active + credit cycle reset", () => {
    A.handleStripeEvent(evt("evt_a", "checkout.session.completed", { mode: "subscription", payment_status: "paid", client_reference_id: "7", metadata: { planKey: "growth" }, customer: "cus_7", subscription: "sub_7" }));
    B.meterQualifiedLead(7, 111); // spend a credit
    expect(B.getBilling(7)!.creditsUsed).toBe(1);
    const r = A.handleStripeEvent(evt("evt_c", "invoice.paid", {
      customer: "cus_7", subscription: "sub_7",
      lines: { data: [{ price: { id: "price_growth" }, period: { start: 1751328000, end: 1753920000 } }] },
    }));
    expect(r.kind).toBe("renew");
    const row = B.getBilling(7)!;
    expect(row.state).toBe("active");
    expect(row.creditsUsed).toBe(0);                 // cycle reset
    expect(row.cycleEnd).toBe(new Date(1753920000 * 1000).toISOString());
  });

  it("subscription.deleted cancels", () => {
    A.handleStripeEvent(evt("evt_a", "checkout.session.completed", { mode: "subscription", payment_status: "paid", client_reference_id: "7", metadata: { planKey: "growth" }, customer: "cus_7", subscription: "sub_7" }));
    A.handleStripeEvent(evt("evt_d", "customer.subscription.deleted", { id: "sub_7", customer: "cus_7" }));
    expect(B.getBilling(7)!.state).toBe("canceled");
  });

  it("an event for an unknown subscription applies nothing", () => {
    const r = A.handleStripeEvent(evt("evt_z", "invoice.payment_failed", { customer: "cus_none", subscription: "sub_none" }));
    expect(r).toMatchObject({ applied: false, tenantId: null });
  });

  it("an event with a BOGUS tenantId (not a real tenant) is not matched", () => {
    const r = A.handleStripeEvent(evt("evt_bogus", "checkout.session.completed", {
      mode: "subscription", payment_status: "paid", client_reference_id: "99999", metadata: { planKey: "growth" }, customer: "cus_x", subscription: "sub_x",
    }));
    expect(r).toMatchObject({ applied: false, tenantId: null }); // tenant 99999 doesn't exist
    expect(B.getBilling(99999)).toBeNull();
  });

  it("repeated payment_failed does NOT slide the dunning grace window forward", () => {
    A.handleStripeEvent(evt("a", "checkout.session.completed", { mode: "subscription", payment_status: "paid", client_reference_id: "7", metadata: { planKey: "growth" }, customer: "cus_7", subscription: "sub_7" }));
    A.handleStripeEvent(evt("b1", "invoice.payment_failed", { customer: "cus_7", subscription: "sub_7", created: 1 } as any));
    const grace1 = B.getBilling(7)!.graceEndsAt;
    A.handleStripeEvent(evt("b2", "invoice.payment_failed", { customer: "cus_7", subscription: "sub_7", created: 2 } as any));
    const grace2 = B.getBilling(7)!.graceEndsAt;
    expect(grace2).toBe(grace1); // grace stamped once, on FIRST entry into past_due
  });

  it("a duplicate invoice.paid for the SAME period does not double-reset credits", () => {
    A.handleStripeEvent(evt("a", "checkout.session.completed", { mode: "subscription", payment_status: "paid", client_reference_id: "7", metadata: { planKey: "growth" }, customer: "cus_7", subscription: "sub_7" }));
    const inv = { customer: "cus_7", subscription: "sub_7", lines: { data: [{ price: { id: "price_growth" }, period: { start: 1751328000, end: 1753920000 } }] } };
    A.handleStripeEvent(evt("in1", "invoice.paid", inv));
    B.meterQualifiedLead(7, 55); // spend 1 after the reset
    expect(B.getBilling(7)!.creditsUsed).toBe(1);
    A.handleStripeEvent(evt("in2", "invoice.paid", inv)); // same period again
    expect(B.getBilling(7)!.creditsUsed).toBe(1); // NOT zeroed — period-idempotent
  });

  it("a trailing invoice.paid does NOT resurrect a canceled subscription", () => {
    A.handleStripeEvent(evt("a", "checkout.session.completed", { mode: "subscription", payment_status: "paid", client_reference_id: "7", metadata: { planKey: "growth" }, customer: "cus_7", subscription: "sub_7" }));
    A.handleStripeEvent(evt("d", "customer.subscription.deleted", { id: "sub_7", customer: "cus_7", created: 100 } as any));
    A.handleStripeEvent(evt("late", "invoice.paid", { customer: "cus_7", subscription: "sub_7", created: 90, lines: { data: [{ price: { id: "price_growth" }, period: { start: 1, end: 2 } }] } } as any));
    expect(B.getBilling(7)!.state).toBe("canceled"); // stays canceled
  });

  it("a stale (older) event does not overwrite newer state", () => {
    A.handleStripeEvent(evt("a", "checkout.session.completed", { mode: "subscription", payment_status: "paid", client_reference_id: "7", metadata: { planKey: "growth" }, customer: "cus_7", subscription: "sub_7" }, 100));
    // A LATER-created renewal establishes last_event_at.
    A.handleStripeEvent(evt("new", "invoice.paid", { customer: "cus_7", subscription: "sub_7", lines: { data: [{ price: { id: "price_growth" }, period: { start: 5, end: 6 } }] } }, 200));
    // An OLDER payment_failed arriving late must be dropped, not flip to past_due.
    const r = A.handleStripeEvent(evt("stale", "invoice.payment_failed", { customer: "cus_7", subscription: "sub_7" }, 150));
    expect(r.reason).toBe("stale event");
    expect(B.getBilling(7)!.state).toBe("active");
  });

  it("processWebhookEvent is atomic + idempotent; unmatched events are retriable and not recorded", () => {
    // Unmatched (row doesn't exist yet) → retriable, NOT recorded (so Stripe retries).
    const unmatched = A.processWebhookEvent(evt("evt_early", "invoice.paid", { customer: "cus_z", subscription: "sub_z", lines: { data: [{ price: { id: "price_growth" }, period: { start: 1, end: 2 } }] } }));
    expect(unmatched.retriable).toBe(true);
    expect(B.wasEventProcessed("evt_early")).toBe(false); // not recorded
    // A matched event records atomically; a replay is a no-op duplicate.
    A.handleStripeEvent(evt("a", "checkout.session.completed", { mode: "subscription", payment_status: "paid", client_reference_id: "7", metadata: { planKey: "growth" }, customer: "cus_7", subscription: "sub_7" }));
    const first = A.processWebhookEvent(evt("evt_pd", "invoice.payment_failed", { customer: "cus_7", subscription: "sub_7" }));
    expect(first.applied).toBe(true);
    expect(B.wasEventProcessed("evt_pd")).toBe(true);
    const replay = A.processWebhookEvent(evt("evt_pd", "invoice.payment_failed", { customer: "cus_7", subscription: "sub_7" }));
    expect(replay.duplicate).toBe(true);
  });

  it("event idempotency: record once, re-delivery is recognized", () => {
    expect(B.wasEventProcessed("evt_x")).toBe(false);
    B.recordEvent("evt_x", { type: "invoice.paid", tenantId: 7, intent: "renew" });
    expect(B.wasEventProcessed("evt_x")).toBe(true);
    B.recordEvent("evt_x", { type: "invoice.paid" }); // duplicate insert → no throw, still one row
    const c: any = rawDb.prepare("SELECT COUNT(*) c FROM billing_events WHERE event_id='evt_x'").get();
    expect(c.c).toBe(1);
  });
});

describe("scanBlockReason (scan-gate)", () => {
  it("a dark tenant is never blocked", () => {
    expect(B.scanBlockReason(999)).toBeNull();
  });
  it("exhausted credits under stop mode block scanning", () => {
    B.ensureBilling(8, { planKey: "starter", state: "active", overageMode: "stop" });
    rawDb.prepare("UPDATE tenant_billing SET credits_included = 1 WHERE tenant_id = 8").run();
    B.meterQualifiedLead(8, 1); // spend the 1 credit
    const block = B.scanBlockReason(8);
    expect(block?.code).toBe("credits_exhausted");
  });
  it("allow_overage never blocks on exhaustion", () => {
    B.ensureBilling(8, { planKey: "starter", state: "active", overageMode: "allow_overage" });
    rawDb.prepare("UPDATE tenant_billing SET credits_included = 0 WHERE tenant_id = 8").run();
    expect(B.scanBlockReason(8)).toBeNull();
  });
  it("suspended/canceled block scanning regardless of credits", () => {
    B.ensureBilling(8, { planKey: "growth", state: "active" });
    B.setBillingState(8, "past_due");
    B.setBillingState(8, "suspended");
    expect(B.scanBlockReason(8)?.code).toBe("billing_suspended");
  });
});
