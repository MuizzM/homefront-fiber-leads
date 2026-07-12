// ── Rep payout core (pure, provider-agnostic) ─────────────────────────────────
// The brain of the Stripe-Connect payout layer: the payout state machine, rep
// onboarding-status derivation, "can this rep be paid?" eligibility, and the
// Connect webhook classifier. NO Stripe, NO DB, NO I/O — every rule is a pure,
// unit-tested function; the adapter is a thin shell that applies these decisions.
//
// Flow: a rep onboards a payout account (Stripe Connect Express, KYC on Stripe).
// When a payroll week is FINALIZED, the owner clicks "Pay reps" → one Transfer per
// eligible rep for their finalCommissionCents. A credit/payout is created ONLY for
// a finalized, positive, not-already-paid statement whose rep has payouts enabled.

// ── Payout status machine ─────────────────────────────────────────────────────
export type PayoutStatus = "pending" | "processing" | "paid" | "failed" | "reversed";

const PAYOUT_TRANSITIONS: Record<PayoutStatus, PayoutStatus[]> = {
  pending:    ["processing", "paid", "failed"],
  processing: ["paid", "failed", "reversed"],
  paid:       ["reversed"],
  failed:     ["pending", "processing", "paid"], // a retry can re-attempt
  reversed:   [],
};
export function canPayoutTransition(from: PayoutStatus, to: PayoutStatus): boolean {
  if (from === to) return true;
  return (PAYOUT_TRANSITIONS[from] ?? []).includes(to);
}
/** A payout that has spent or is spending money (blocks a duplicate for the same statement). */
export function isActivePayout(s: PayoutStatus): boolean {
  return s === "pending" || s === "processing" || s === "paid";
}

// ── Rep onboarding status (derived from the Stripe account object) ────────────
export type OnboardingStatus = "none" | "pending" | "restricted" | "enabled";

export interface ConnectAccountFacts {
  payoutsEnabled?: boolean;
  chargesEnabled?: boolean;
  detailsSubmitted?: boolean;
  disabledReason?: string | null;
}
export function onboardingStatusFrom(a: ConnectAccountFacts): OnboardingStatus {
  if (a.payoutsEnabled) return "enabled";
  if (a.disabledReason) return "restricted";      // needs more info / blocked
  if (a.detailsSubmitted) return "pending";       // submitted, awaiting verification
  return "none";                                  // hasn't started / finished onboarding
}

// ── Eligibility: may we pay this rep's statement right now? ────────────────────
export type PayoutBlockReason =
  | null | "not_finalized" | "already_paid" | "no_amount" | "not_onboarded" | "payouts_disabled";

export interface EligibilityInput {
  statementStatus: string;                 // OPEN | REVIEW | FINALIZED | PAID
  finalCents: number;
  onboardingStatus: OnboardingStatus;
  existingPayoutStatus?: PayoutStatus | null;
}
export interface Eligibility { eligible: boolean; reason: PayoutBlockReason }

export function payoutEligibility(p: EligibilityInput): Eligibility {
  if (p.statementStatus === "PAID") return { eligible: false, reason: "already_paid" };
  if (p.statementStatus !== "FINALIZED") return { eligible: false, reason: "not_finalized" };
  if (p.existingPayoutStatus && isActivePayout(p.existingPayoutStatus)) return { eligible: false, reason: "already_paid" };
  if (!Number.isFinite(p.finalCents) || p.finalCents <= 0) return { eligible: false, reason: "no_amount" };
  if (p.onboardingStatus !== "enabled") {
    return { eligible: false, reason: p.onboardingStatus === "none" ? "not_onboarded" : "payouts_disabled" };
  }
  return { eligible: true, reason: null };
}

export const BLOCK_LABEL: Record<Exclude<PayoutBlockReason, null>, string> = {
  not_finalized: "Week not finalized",
  already_paid: "Already paid",
  no_amount: "No commission owed",
  not_onboarded: "Rep hasn't connected a payout account",
  payouts_disabled: "Payout account not verified yet",
};

// ── Connect webhook classifier ────────────────────────────────────────────────
// Transfer success/failure is known synchronously from the createTransfer call;
// webhooks carry the ASYNC facts: onboarding progress (account.updated), a clawed-
// back transfer (transfer.reversed), and the connected-account's bank payout
// (payout.paid/failed on the rep's own account).
export type ConnectIntentKind =
  | "account_updated" | "transfer_reversed" | "bank_payout_paid" | "bank_payout_failed" | "ignore";

export interface ConnectIntent {
  kind: ConnectIntentKind;
  eventId: string;
  eventCreated?: string;      // ISO — ordering guard
  accountId?: string;         // connected account (Connect events carry event.account)
  transferId?: string;
  facts?: ConnectAccountFacts;
  reason?: string;
}

function toIso(unixSeconds: unknown): string | undefined {
  const n = typeof unixSeconds === "number" ? unixSeconds : Number(unixSeconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : undefined;
}

export function classifyConnectEvent(event: any): ConnectIntent {
  const eventId: string = event?.id ?? "";
  const eventCreated = toIso(event?.created);
  const type: string = event?.type ?? "";
  const account: string | undefined = event?.account; // connected account the event is FOR
  const obj: any = event?.data?.object ?? {};
  const ignore = (reason: string): ConnectIntent => ({ kind: "ignore", eventId, eventCreated, reason });

  switch (type) {
    case "account.updated":
      return {
        kind: "account_updated", eventId, eventCreated,
        accountId: obj.id ?? account,
        facts: {
          payoutsEnabled: !!obj.payouts_enabled,
          chargesEnabled: !!obj.charges_enabled,
          detailsSubmitted: !!obj.details_submitted,
          disabledReason: obj.requirements?.disabled_reason ?? null,
        },
      };
    case "transfer.reversed":
      return { kind: "transfer_reversed", eventId, eventCreated, accountId: account, transferId: obj.id };
    case "payout.paid":
      return { kind: "bank_payout_paid", eventId, eventCreated, accountId: account };
    case "payout.failed":
      return { kind: "bank_payout_failed", eventId, eventCreated, accountId: account };
    default:
      return ignore(`unhandled type ${type}`);
  }
}

export function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}
