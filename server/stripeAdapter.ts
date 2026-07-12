// ── Stripe adapter (SDK-free provider seam) ───────────────────────────────────
// The payment-provider implementation behind the pure billing engine. Talks to
// Stripe over its REST API (no npm dependency) and verifies webhook signatures
// with node crypto. Maps Stripe events → billingStore mutations.
//
// FULLY INERT WITHOUT KEYS: every entry point checks stripeConfigured() (needs
// STRIPE_SECRET_KEY). No key → checkout/portal throw a clear "not configured"
// error and the webhook route 503s. So shipping this changes nothing in prod
// until you set the env vars — matching the dark-by-default billing layer.
//
// Required env to go live (you set these; I never handle them):
//   STRIPE_SECRET_KEY           sk_live_… / sk_test_…
//   STRIPE_WEBHOOK_SECRET       whsec_…  (for signature verification)
//   STRIPE_PRICE_STARTER        price_…  ┐ map a Stripe recurring price to each plan
//   STRIPE_PRICE_GROWTH         price_…  │
//   STRIPE_PRICE_PROFESSIONAL   price_…  ┘  (Enterprise is sales-led, no self-serve)
import crypto from "crypto";
import type { PlanKey } from "../shared/billing";
import { DUNNING_GRACE_DAYS } from "../shared/billing";
import { classifyStripeEvent } from "../shared/stripeEvents";
import * as store from "./billingStore";
import { rawDb } from "./db";

const STRIPE_API = process.env.STRIPE_API_BASE || "https://api.stripe.com";

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}
export function webhookConfigured(): boolean {
  return !!process.env.STRIPE_WEBHOOK_SECRET;
}

/** Owner-configured price-id → plan-key map (only the entries that are set). */
export function priceMap(): Record<string, PlanKey> {
  const m: Record<string, PlanKey> = {};
  if (process.env.STRIPE_PRICE_STARTER) m[process.env.STRIPE_PRICE_STARTER] = "starter";
  if (process.env.STRIPE_PRICE_GROWTH) m[process.env.STRIPE_PRICE_GROWTH] = "growth";
  if (process.env.STRIPE_PRICE_PROFESSIONAL) m[process.env.STRIPE_PRICE_PROFESSIONAL] = "professional";
  return m;
}
export function priceIdForPlan(planKey: PlanKey): string | undefined {
  return {
    starter: process.env.STRIPE_PRICE_STARTER,
    growth: process.env.STRIPE_PRICE_GROWTH,
    professional: process.env.STRIPE_PRICE_PROFESSIONAL,
    enterprise: undefined,
  }[planKey];
}

// ── Webhook signature verification (Stripe scheme) ────────────────────────────
// Header: "t=<unix>,v1=<hex hmac>[,v1=<hex hmac>…]". signed_payload = "t.body".
// Constant-time compare; reject stale timestamps (replay protection).
export function verifyStripeSignature(
  rawBody: string | Buffer, sigHeader: string | undefined,
  secret = process.env.STRIPE_WEBHOOK_SECRET, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!sigHeader || !secret) return false;
  const parts = sigHeader.split(",").map(p => p.trim());
  let t = "";
  const v1s: string[] = [];
  for (const p of parts) {
    const [k, v] = p.split("=");
    if (k === "t") t = v;
    else if (k === "v1" && v) v1s.push(v);
  }
  if (!t || v1s.length === 0) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;
  const payload = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex");
  const expBuf = Buffer.from(expected, "hex");
  return v1s.some(sig => {
    try {
      const sigBuf = Buffer.from(sig, "hex");
      return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
    } catch { return false; }
  });
}

// ── Stripe REST helper ────────────────────────────────────────────────────────
async function stripePost(path: string, form: Record<string, string | undefined>): Promise<any> {
  if (!stripeConfigured()) throw new Error("Stripe is not configured (STRIPE_SECRET_KEY unset)");
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v != null) body.append(k, v);
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2024-06-20",
    },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe ${path} ${res.status}: ${json?.error?.message ?? "error"}`);
  return json;
}

export interface CheckoutOpts {
  tenantId: number; planKey: PlanKey;
  successUrl: string; cancelUrl: string;
  customerId?: string | null; customerEmail?: string | null;
}
/** Create a Stripe Checkout session for a plan → returns the hosted URL. */
export async function createCheckoutSession(o: CheckoutOpts): Promise<{ url: string; id: string }> {
  const price = priceIdForPlan(o.planKey);
  if (!price) throw new Error(`No Stripe price configured for plan "${o.planKey}"`);
  const form: Record<string, string | undefined> = {
    "mode": "subscription",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    "success_url": o.successUrl,
    "cancel_url": o.cancelUrl,
    "client_reference_id": String(o.tenantId),
    "metadata[tenantId]": String(o.tenantId),
    "metadata[planKey]": o.planKey,
    "subscription_data[metadata][tenantId]": String(o.tenantId),
    "subscription_data[metadata][planKey]": o.planKey,
  };
  if (o.customerId) form["customer"] = o.customerId;
  else if (o.customerEmail) form["customer_email"] = o.customerEmail;
  const s = await stripePost("/v1/checkout/sessions", form);
  return { url: s.url, id: s.id };
}

/** Stripe billing portal — lets a tenant manage/cancel their subscription. */
export async function createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }> {
  const s = await stripePost("/v1/billing_portal/sessions", { customer: customerId, return_url: returnUrl });
  return { url: s.url };
}

export interface ApplyResult { applied: boolean; kind: string; tenantId: number | null; reason?: string }

/**
 * Apply a verified Stripe event to billing. Idempotency is enforced by the ROUTE
 * (wasEventProcessed/recordEvent) around this call; here we classify, resolve the
 * tenant, and mutate billingStore. Pure of I/O beyond the DB.
 */
export function handleStripeEvent(event: any): ApplyResult {
  const intent = classifyStripeEvent(event, priceMap());
  if (intent.kind === "ignore") return { applied: false, kind: "ignore", tenantId: null, reason: intent.reason };
  const tenantId = store.resolveTenantFromRef(intent.ref);
  if (tenantId == null) return { applied: false, kind: intent.kind, tenantId: null, reason: "no tenant match" };
  // Ordering guard: drop an event older than the last one we applied for this
  // tenant (Stripe doesn't guarantee webhook order — a delayed payment_failed must
  // not overwrite a subsequent invoice.paid).
  if (store.isStaleEvent(tenantId, intent.eventCreated)) {
    return { applied: false, kind: intent.kind, tenantId, reason: "stale event" };
  }

  switch (intent.kind) {
    case "activate":
      store.activateFromStripe(tenantId, { planKey: intent.planKey, customerId: intent.ref.customerId, subscriptionId: intent.ref.subscriptionId });
      break;
    case "renew": {
      const start = intent.periodStart ?? new Date().toISOString();
      const end = intent.periodEnd ?? new Date(Date.now() + 30 * 86400000).toISOString();
      // Stamp any provider ids that arrived with the invoice, then reset the cycle.
      store.setProvider(tenantId, { provider: "stripe", customerId: intent.ref.customerId ?? null, subscriptionId: intent.ref.subscriptionId ?? null });
      store.renewFromStripe(tenantId, { planKey: intent.planKey, cycleStart: start, cycleEnd: end });
      break;
    }
    case "past_due":
      store.markPastDueFromStripe(tenantId, new Date(Date.now() + DUNNING_GRACE_DAYS * 86400000).toISOString());
      break;
    case "canceled":
      store.cancelFromStripe(tenantId);
      break;
    case "plan_change":
      if (intent.planKey) store.changePlanFromStripe(tenantId, intent.planKey);
      break;
  }
  store.bumpLastEvent(tenantId, intent.eventCreated);
  return { applied: true, kind: intent.kind, tenantId };
}

export interface ProcessResult extends ApplyResult { duplicate?: boolean; retriable?: boolean }

/**
 * Atomically process a verified webhook event: idempotency check + apply + record,
 * all in ONE transaction so a crash can't apply mutations without recording the id
 * (which would let a Stripe retry double-apply). An event that can't yet be matched
 * to a tenant is NOT recorded and is marked `retriable` so the route returns non-2xx
 * and Stripe re-delivers it once the tenant's row exists (out-of-order first cycle).
 */
export function processWebhookEvent(event: any): ProcessResult {
  const eventId: string = event?.id ?? "";
  const tx = rawDb.transaction((): ProcessResult => {
    if (eventId && store.wasEventProcessed(eventId)) return { applied: false, kind: "duplicate", tenantId: null, duplicate: true };
    const r = handleStripeEvent(event);
    const unmatched = !r.applied && r.reason === "no tenant match";
    if (eventId && !unmatched) store.recordEvent(eventId, { provider: "stripe", type: event?.type, tenantId: r.tenantId, intent: r.kind });
    return { ...r, retriable: unmatched };
  });
  return tx.immediate();
}
