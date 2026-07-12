import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { classifyStripeEvent, resolvePlan } from "../../shared/stripeEvents";
import { verifyStripeSignature } from "../../server/stripeAdapter";

const PRICE_MAP = { price_starter: "starter", price_growth: "growth", price_pro: "professional" } as const;

describe("classifyStripeEvent", () => {
  it("checkout.session.completed → activate with tenant + plan + ids", () => {
    const i = classifyStripeEvent({
      id: "evt_1", type: "checkout.session.completed",
      data: { object: { mode: "subscription", payment_status: "paid", client_reference_id: "42", metadata: { planKey: "growth" }, customer: "cus_1", subscription: "sub_1" } },
    }, PRICE_MAP);
    expect(i.kind).toBe("activate");
    expect(i.ref).toEqual({ tenantId: 42, customerId: "cus_1", subscriptionId: "sub_1" });
    expect(i.planKey).toBe("growth");
  });
  it("ignores a non-subscription or unpaid checkout", () => {
    expect(classifyStripeEvent({ id: "e", type: "checkout.session.completed", data: { object: { mode: "payment" } } }).kind).toBe("ignore");
    expect(classifyStripeEvent({ id: "e", type: "checkout.session.completed", data: { object: { mode: "subscription", payment_status: "unpaid" } } }).kind).toBe("ignore");
  });
  it("invoice.paid → renew with the billing period window + plan from price", () => {
    const i = classifyStripeEvent({
      id: "in_1", type: "invoice.paid",
      data: { object: { customer: "cus_1", subscription: "sub_1", lines: { data: [{ price: { id: "price_pro" }, period: { start: 1751328000, end: 1753920000 } }] } } },
    }, PRICE_MAP);
    expect(i.kind).toBe("renew");
    expect(i.planKey).toBe("professional");
    expect(i.periodStart).toBe(new Date(1751328000 * 1000).toISOString());
    expect(i.periodEnd).toBe(new Date(1753920000 * 1000).toISOString());
    expect(i.ref.subscriptionId).toBe("sub_1");
  });
  it("invoice.payment_failed → past_due", () => {
    expect(classifyStripeEvent({ id: "e", type: "invoice.payment_failed", data: { object: { customer: "cus_9", subscription: "sub_9" } } }).kind).toBe("past_due");
  });
  it("invoice.payment_succeeded is IGNORED (paid/succeeded pair would double-reset)", () => {
    const i = classifyStripeEvent({ id: "e", type: "invoice.payment_succeeded", data: { object: { customer: "c", subscription: "s" } } });
    expect(i.kind).toBe("ignore");
  });
  it("stamps eventCreated from event.created for the ordering guard", () => {
    const i = classifyStripeEvent({ id: "e", type: "invoice.payment_failed", created: 1751328000, data: { object: { subscription: "s" } } });
    expect(i.eventCreated).toBe(new Date(1751328000 * 1000).toISOString());
  });
  it("customer.subscription.deleted → canceled", () => {
    const i = classifyStripeEvent({ id: "e", type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1" } } });
    expect(i.kind).toBe("canceled");
    expect(i.ref.subscriptionId).toBe("sub_1");
  });
  it("subscription.updated maps status → state; past_due/canceled/active", () => {
    const mk = (status: string, priceId?: string) => classifyStripeEvent({ id: "e", type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status, items: { data: [{ price: { id: priceId } }] } } } }, PRICE_MAP);
    expect(mk("active", "price_growth").kind).toBe("activate");
    expect(mk("past_due").kind).toBe("past_due");
    expect(mk("canceled").kind).toBe("canceled");
  });
  it("unhandled event types are ignored, never throw", () => {
    expect(classifyStripeEvent({ id: "e", type: "customer.created", data: { object: {} } }).kind).toBe("ignore");
    expect(classifyStripeEvent({}).kind).toBe("ignore");
  });
  it("resolvePlan maps configured price ids only", () => {
    expect(resolvePlan("price_growth", PRICE_MAP)).toBe("growth");
    expect(resolvePlan("price_unknown", PRICE_MAP)).toBeUndefined();
    expect(resolvePlan(null, PRICE_MAP)).toBeUndefined();
  });
});

describe("verifyStripeSignature", () => {
  const secret = "whsec_test_secret";
  const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
  const sign = (t: number, body = payload, key = secret) =>
    crypto.createHmac("sha256", key).update(`${t}.${body}`, "utf8").digest("hex");

  it("accepts a valid, fresh signature", () => {
    const t = 1_700_000_000;
    const header = `t=${t},v1=${sign(t)}`;
    expect(verifyStripeSignature(payload, header, secret, 300, t)).toBe(true);
  });
  it("rejects a tampered payload", () => {
    const t = 1_700_000_000;
    const header = `t=${t},v1=${sign(t)}`;
    expect(verifyStripeSignature(payload + "x", header, secret, 300, t)).toBe(false);
  });
  it("rejects a wrong secret", () => {
    const t = 1_700_000_000;
    const header = `t=${t},v1=${sign(t, payload, "whsec_other")}`;
    expect(verifyStripeSignature(payload, header, secret, 300, t)).toBe(false);
  });
  it("rejects a stale timestamp (replay protection)", () => {
    const t = 1_700_000_000;
    const header = `t=${t},v1=${sign(t)}`;
    expect(verifyStripeSignature(payload, header, secret, 300, t + 10_000)).toBe(false);
  });
  it("rejects missing header / missing secret", () => {
    expect(verifyStripeSignature(payload, undefined, secret)).toBe(false);
    expect(verifyStripeSignature(payload, "t=1,v1=abc", undefined)).toBe(false);
    expect(verifyStripeSignature(payload, "garbage", secret)).toBe(false);
  });
});
