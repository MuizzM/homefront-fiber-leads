// ── Pure Stripe webhook classification ────────────────────────────────────────
// Turns a raw Stripe event into a normalized, provider-agnostic INTENT that the
// adapter applies to billingStore. Pure + fully unit-testable — no SDK, no I/O,
// no DB. The adapter resolves the intent's tenant ref and calls billingStore.
//
// Tenant identity flows through Stripe as `client_reference_id` (set to the
// tenantId at checkout) and `metadata.tenantId`; renewals/failures that lack it
// are matched by the stored customer/subscription id instead.
import type { PlanKey } from "./billing";

export type StripeIntentKind = "activate" | "renew" | "past_due" | "canceled" | "plan_change" | "ignore";

export interface StripeRef {
  tenantId?: number;        // from client_reference_id / metadata (authoritative)
  customerId?: string;      // Stripe customer id (fallback lookup)
  subscriptionId?: string;  // Stripe subscription id (fallback lookup)
}

export interface StripeIntent {
  kind: StripeIntentKind;
  eventId: string;
  ref: StripeRef;
  planKey?: PlanKey;
  periodStart?: string;     // ISO — for renew cycle window
  periodEnd?: string;
  eventCreated?: string;    // ISO of event.created — ordering guard against stale webhooks
  reason?: string;          // human note (why ignored, etc.)
}

/** Map a Stripe price id → our plan key using the owner-configured env map. */
export function resolvePlan(priceId: string | undefined | null, priceMap: Record<string, PlanKey>): PlanKey | undefined {
  if (!priceId) return undefined;
  return priceMap[priceId];
}

function toIso(unixSeconds: unknown): string | undefined {
  const n = typeof unixSeconds === "number" ? unixSeconds : Number(unixSeconds);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n * 1000).toISOString();
}

function parseTenantId(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Classify a Stripe event into a billing intent. Returns kind "ignore" (never
 * null) for events we don't act on, so the caller can still ack + record them.
 * Stamps eventCreated (from event.created) so the adapter can drop stale/out-of-
 * order webhooks.
 */
export function classifyStripeEvent(event: any, priceMap: Record<string, PlanKey> = {}): StripeIntent {
  const intent = classifyInner(event, priceMap);
  intent.eventCreated = toIso(event?.created);
  return intent;
}

function classifyInner(event: any, priceMap: Record<string, PlanKey>): StripeIntent {
  const eventId: string = event?.id ?? "";
  const type: string = event?.type ?? "";
  const obj: any = event?.data?.object ?? {};
  const ignore = (reason: string): StripeIntent => ({ kind: "ignore", eventId, ref: {}, reason });

  switch (type) {
    case "checkout.session.completed": {
      // Only subscription-mode, actually-paid sessions activate billing.
      if (obj.mode && obj.mode !== "subscription") return ignore(`checkout mode ${obj.mode}`);
      if (obj.payment_status && obj.payment_status !== "paid" && obj.payment_status !== "no_payment_required") {
        return ignore(`checkout payment_status ${obj.payment_status}`);
      }
      const ref: StripeRef = {
        tenantId: parseTenantId(obj.client_reference_id) ?? parseTenantId(obj.metadata?.tenantId),
        customerId: typeof obj.customer === "string" ? obj.customer : obj.customer?.id,
        subscriptionId: typeof obj.subscription === "string" ? obj.subscription : obj.subscription?.id,
      };
      const planKey = (obj.metadata?.planKey as PlanKey | undefined)
        ?? resolvePlan(obj.metadata?.priceId, priceMap);
      return { kind: "activate", eventId, ref, planKey };
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const status: string = obj.status ?? "";
      const ref: StripeRef = {
        tenantId: parseTenantId(obj.metadata?.tenantId),
        customerId: typeof obj.customer === "string" ? obj.customer : obj.customer?.id,
        subscriptionId: obj.id,
      };
      const priceId = obj.items?.data?.[0]?.price?.id ?? obj.plan?.id;
      const planKey = resolvePlan(priceId, priceMap);
      // Status drives the billing state; a plan/price change maps to plan_change.
      if (status === "active" || status === "trialing") return { kind: "activate", eventId, ref, planKey };
      if (status === "past_due" || status === "unpaid") return { kind: "past_due", eventId, ref };
      if (status === "canceled" || status === "incomplete_expired") return { kind: "canceled", eventId, ref };
      if (planKey) return { kind: "plan_change", eventId, ref, planKey };
      return ignore(`subscription status ${status}`);
    }

    // Stripe fires BOTH invoice.paid AND invoice.payment_succeeded for one payment
    // (distinct event ids). Act on ONLY invoice.paid so a renewal resets the cycle once.
    case "invoice.payment_succeeded":
      return ignore("duplicate of invoice.paid");

    case "invoice.paid": {
      // Renewal → reset the credit cycle for the new billing period.
      const line = obj.lines?.data?.[0] ?? {};
      const period = line.period ?? obj.period ?? {};
      const ref: StripeRef = {
        tenantId: parseTenantId(obj.metadata?.tenantId) ?? parseTenantId(line.metadata?.tenantId),
        customerId: typeof obj.customer === "string" ? obj.customer : obj.customer?.id,
        subscriptionId: typeof obj.subscription === "string" ? obj.subscription : obj.subscription?.id,
      };
      const priceId = line.price?.id ?? line.plan?.id;
      return {
        kind: "renew", eventId, ref,
        planKey: resolvePlan(priceId, priceMap),
        periodStart: toIso(period.start),
        periodEnd: toIso(period.end),
      };
    }

    case "invoice.payment_failed": {
      const ref: StripeRef = {
        tenantId: parseTenantId(obj.metadata?.tenantId),
        customerId: typeof obj.customer === "string" ? obj.customer : obj.customer?.id,
        subscriptionId: typeof obj.subscription === "string" ? obj.subscription : obj.subscription?.id,
      };
      return { kind: "past_due", eventId, ref };
    }

    case "customer.subscription.deleted": {
      const ref: StripeRef = {
        tenantId: parseTenantId(obj.metadata?.tenantId),
        customerId: typeof obj.customer === "string" ? obj.customer : obj.customer?.id,
        subscriptionId: obj.id,
      };
      return { kind: "canceled", eventId, ref };
    }

    default:
      return ignore(`unhandled type ${type}`);
  }
}
