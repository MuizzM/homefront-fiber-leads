// ── Stripe Connect adapter (SDK-free) — rep payouts ───────────────────────────
// The payout provider behind shared/payouts.ts. Uses Stripe Connect Express:
// each rep is a connected account (KYC/bank handled on Stripe's hosted onboarding);
// a payout is a Transfer from the platform balance → the rep's connected account.
//
// FULLY INERT WITHOUT KEYS: reuses the platform STRIPE_SECRET_KEY (connectConfigured
// = stripeConfigured). No key → onboarding/transfer throw and the webhook 503s, so
// shipping this moves ZERO money until the owner sets keys AND clicks "Pay reps".
//
// Env to go live (owner sets these; the owner clicks the pay button — never the app):
//   STRIPE_SECRET_KEY               (shared with billing — the platform key)
//   STRIPE_CONNECT_WEBHOOK_SECRET   whsec_… for the *Connect* webhook endpoint
import { stripeRequest, stripeConfigured, verifyStripeSignature } from "./stripeAdapter";
import { classifyConnectEvent, onboardingStatusFrom } from "../shared/payouts";
import * as store from "./payoutStore";
import { rawDb } from "./db";

export function connectConfigured(): boolean {
  return stripeConfigured();
}
export function connectWebhookConfigured(): boolean {
  return !!process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
}

// ── Onboarding ────────────────────────────────────────────────────────────────
/** Create an Express connected account for a rep (KYC/bank collected on Stripe). */
export async function createConnectedAccount(p: { email?: string | null; repId: number; tenantId: number }): Promise<string> {
  const acct = await stripeRequest("/v1/accounts", {
    "type": "express",
    "country": "US",
    "email": p.email ?? undefined,
    "business_type": "individual",
    "capabilities[transfers][requested]": "true",
    "metadata[repId]": String(p.repId),
    "metadata[tenantId]": String(p.tenantId),
    "settings[payouts][schedule][interval]": "manual", // owner controls when Stripe pays the rep's bank
  });
  return acct.id;
}

/** A hosted onboarding link the rep opens to finish KYC + connect a bank. */
export async function createAccountLink(accountId: string, refreshUrl: string, returnUrl: string): Promise<string> {
  const link = await stripeRequest("/v1/account_links", {
    "account": accountId,
    "refresh_url": refreshUrl,
    "return_url": returnUrl,
    "type": "account_onboarding",
  });
  return link.url;
}

/** Read the live account state (payouts_enabled etc.) to refresh onboarding status. */
export async function fetchAccount(accountId: string): Promise<{ payoutsEnabled: boolean; chargesEnabled: boolean; detailsSubmitted: boolean; disabledReason: string | null }> {
  const a = await stripeRequest(`/v1/accounts/${accountId}`, undefined, { method: "GET" });
  return {
    payoutsEnabled: !!a.payouts_enabled,
    chargesEnabled: !!a.charges_enabled,
    detailsSubmitted: !!a.details_submitted,
    disabledReason: a.requirements?.disabled_reason ?? null,
  };
}

// ── The money movement ────────────────────────────────────────────────────────
/** Transfer platform funds → a rep's connected account. Idempotency-Key makes a
 *  retry safe (Stripe returns the SAME transfer, never a second one). Throws on
 *  Stripe error (e.g. insufficient platform balance) so the caller marks it failed. */
export async function createTransfer(p: {
  amountCents: number; destinationAccountId: string; idempotencyKey: string;
  transferGroup?: string; metadata?: Record<string, string>;
}): Promise<{ transferId: string }> {
  const form: Record<string, string | undefined> = {
    "amount": String(p.amountCents),
    "currency": "usd",
    "destination": p.destinationAccountId,
    "transfer_group": p.transferGroup,
  };
  for (const [k, v] of Object.entries(p.metadata ?? {})) form[`metadata[${k}]`] = v;
  const t = await stripeRequest("/v1/transfers", form, { idempotencyKey: p.idempotencyKey });
  return { transferId: t.id };
}

/** RECONCILE: has a transfer already been made for this statement's transfer_group?
 *  Used before (re)paying so a lost-response / >24h retry ADOPTS the existing
 *  transfer instead of sending a second one (the idempotency key only lives 24h). */
export async function findTransferByGroup(transferGroup: string): Promise<{ transferId: string; reversed: boolean } | null> {
  const res = await stripeRequest("/v1/transfers", { transfer_group: transferGroup, limit: "1" }, { method: "GET" });
  const t = res?.data?.[0];
  if (!t?.id) return null;
  return { transferId: t.id, reversed: (t.amount_reversed ?? 0) > 0 };
}

// ── Webhook (Connect) ─────────────────────────────────────────────────────────
export function verifyConnectSignature(rawBody: string | Buffer, sigHeader: string | undefined): boolean {
  return verifyStripeSignature(rawBody, sigHeader, process.env.STRIPE_CONNECT_WEBHOOK_SECRET);
}

export interface ConnectApplyResult { applied: boolean; kind: string; reason?: string; duplicate?: boolean }

function applyConnectEvent(event: any): ConnectApplyResult {
  const intent = classifyConnectEvent(event);
  switch (intent.kind) {
    case "account_updated": {
      if (!intent.accountId || !intent.facts) return { applied: false, kind: intent.kind, reason: "no account" };
      store.updateAccountFromStripe(intent.accountId, {
        payoutsEnabled: !!intent.facts.payoutsEnabled,
        chargesEnabled: !!intent.facts.chargesEnabled,
        detailsSubmitted: !!intent.facts.detailsSubmitted,
        disabledReason: intent.facts.disabledReason ?? null,
        onboardingStatus: onboardingStatusFrom(intent.facts),
        eventCreated: intent.eventCreated ?? null, // ordering guard
      });
      return { applied: true, kind: intent.kind };
    }
    case "transfer_reversed": {
      if (intent.transferId) {
        const matched = store.markPayoutReversedByTransfer(intent.transferId);
        // A reversal we can't match to a payout row (e.g. a transfer whose response
        // was lost, so no row carries its id) must be surfaced, not silently acked.
        if (matched === 0) console.warn(`[payouts] transfer.reversed ${intent.transferId} matched no payout row — needs reconciliation`);
      }
      return { applied: true, kind: intent.kind };
    }
    case "bank_payout_paid":
    case "bank_payout_failed":
      // Connected-account bank payout — informational; the per-statement payout
      // status is driven by the transfer call, so ack without a state change.
      return { applied: false, kind: intent.kind, reason: "informational" };
    default:
      return { applied: false, kind: "ignore", reason: intent.reason };
  }
}

/** Atomic idempotent Connect-webhook processing (idempotency check + apply + record
 *  in one transaction). Mirrors the billing webhook. */
export function processConnectWebhook(event: any): ConnectApplyResult {
  const eventId: string = event?.id ?? "";
  const tx = rawDb.transaction((): ConnectApplyResult => {
    if (eventId && store.wasConnectEventProcessed(eventId)) return { applied: false, kind: "duplicate", duplicate: true };
    const r = applyConnectEvent(event);
    if (eventId) store.recordConnectEvent(eventId, event?.type, r.kind);
    return r;
  });
  return tx.immediate();
}
