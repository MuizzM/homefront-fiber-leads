// ── Incentive engine (PURE) — the rule half of the event-driven engine ──────
//
// `shared/spiffCampaign.ts` already models the manager's knock-shaped contest
// ("$75 a sale until 6 PM"). This module generalizes that idea to every
// incentive the platform pays: training, first sale, goals, product spiffs,
// territory and campaign bonuses, attendance, referrals, and mileage.
//
// It is the DECISION layer only. It answers one question —
//
//     given this campaign, this event, and these counters, does anyone earn
//     money, and how much?
//
// — and it answers it with no clock, no database, and no randomness, so the
// same event replayed a year later produces the identical decision.
//
// ── WHY EVENTS, NOT CALL SITES ──────────────────────────────────────────────
// The existing bonuses are awarded inline at the write site. That is correct
// but closed: the set of things that can pay money is whatever someone
// remembered to wire up. Driving awards off `shared/domainEvents.ts` means an
// admin can add a campaign for TRAINING_PASSED without anyone editing the
// training route, and every award can cite the exact fact that caused it.
//
// ── ONE EVENT, ONE REWARD, FOREVER ──────────────────────────────────────────
// The engine never dedupes in memory. Every award carries `rewardKey(campaign,
// event, recipient)`, which lands in `spiffs.sale_ref` under the UNIQUE index
// that table already has. Re-running the subscriber over the same events pays
// nothing extra because the DATABASE refuses the second write — not because
// this code remembered.

import { rewardKey, type DomainEventType } from "./domainEvents";

// ── Incentive taxonomy ──────────────────────────────────────────────────────

export const INCENTIVE_TYPES = [
  "TRAINING_COMPLETION",
  "TRAINING_ASSESSMENT",
  "FIRST_SALE",
  "SALES_GOAL",
  "PRODUCT_SPIFF",
  "TERRITORY_CAMPAIGN",
  "ATTENDANCE",
  "REFERRAL_REWARD",
  "MILEAGE_REIMBURSEMENT",
] as const;
export type IncentiveType = (typeof INCENTIVE_TYPES)[number];

/**
 * Which event each incentive type reacts to.
 *
 * Declared as data rather than a switch so a campaign can be validated against
 * it at save time: an admin cannot create a TRAINING_COMPLETION campaign that
 * silently never fires because nothing emits the event it waits for.
 */
export const INCENTIVE_TRIGGER_EVENT: Record<IncentiveType, DomainEventType> = {
  TRAINING_COMPLETION: "TRAINING_COMPLETED",
  TRAINING_ASSESSMENT: "TRAINING_PASSED",
  FIRST_SALE: "SALE_APPROVED",
  SALES_GOAL: "SALE_APPROVED",
  PRODUCT_SPIFF: "SALE_APPROVED",
  TERRITORY_CAMPAIGN: "SALE_APPROVED",
  ATTENDANCE: "SALE_APPROVED",
  REFERRAL_REWARD: "REFERRAL_THRESHOLD_REACHED",
  MILEAGE_REIMBURSEMENT: "MILEAGE_APPROVED",
};

/**
 * Which incentive types the ENGINE owns the earnings row for.
 *
 * Two campaign types deliberately do NOT appear here, and the omission is the
 * whole point: mileage money is decided by the org's rate at trip approval, and
 * referral money by the programme config at reward approval. Those decisions
 * belong to `mileageStore` and `referralStore`, which already write the
 * earnings row when they make them.
 *
 * A campaign of either type still writes a `spiffs` row — that is how the money
 * reaches the commission statement and the payout — but it must NOT also write
 * an earnings row, because the owning store already did. Letting both write
 * produces two rows for one debt under two different idempotency keys, which no
 * uniqueness constraint can catch: they are, as far as the database can tell,
 * two different earnings.
 *
 * The rule in one line: the ledger row belongs to whoever decided the amount.
 */
export const ENGINE_OWNS_EARNINGS: ReadonlySet<IncentiveType> = new Set<IncentiveType>([
  "TRAINING_COMPLETION", "TRAINING_ASSESSMENT", "FIRST_SALE", "SALES_GOAL",
  "PRODUCT_SPIFF", "TERRITORY_CAMPAIGN", "ATTENDANCE",
]);

export function engineOwnsEarnings(type: IncentiveType): boolean {
  return ENGINE_OWNS_EARNINGS.has(type);
}

// ── Amount basis ────────────────────────────────────────────────────────────

export type AmountBasis =
  /** A fixed number of cents. */
  | "FLAT"
  /** Basis points of an amount carried on the event (a sale's value, a trip's
   *  reimbursement). 10000 bp = 100%. Basis points, not a percent float,
   *  because 8.25% of $1,234.56 must be reproducible to the cent. */
  | "PERCENT"
  /** The event's own computed amount, passed through unchanged. This is what a
   *  mileage reimbursement is: the money was already decided by the approval,
   *  and the campaign only decides that it flows. */
  | "PASSTHROUGH";

// ── Eligibility filters ─────────────────────────────────────────────────────

/**
 * Optional narrowing. Every field is "unset = no restriction", so an empty
 * filter object means the campaign applies to the whole org — which is the
 * behaviour an admin expects from a form they left blank.
 */
export interface IncentiveFilters {
  /** Fibre providers this campaign pays on, e.g. ["kinetic"]. */
  providers?: string[] | null;
  /** Product/plan codes. */
  products?: string[] | null;
  /** Market or metro keys. */
  markets?: string[] | null;
  /** Territory ids. */
  territoryIds?: number[] | null;
  /** Explicit rep allow-list. Null = everyone eligible by the other rules. */
  repIds?: number[] | null;
  /** Member roles that may earn it. Null = every role. */
  roles?: string[] | null;
}

// ── Clawback ────────────────────────────────────────────────────────────────

export interface ClawbackPolicy {
  /** Does a SALE_CANCELLED reverse this award at all? */
  enabled: boolean;
  /** Days after the award within which a cancellation reverses it. 0 = forever. */
  windowDays: number;
  /** Reverse the whole award, or in proportion to what was lost. */
  mode: "FULL" | "PRORATED";
}

export const DEFAULT_CLAWBACK: ClawbackPolicy = { enabled: true, windowDays: 90, mode: "FULL" };

// ── Campaign ────────────────────────────────────────────────────────────────

export interface IncentiveCampaign {
  id: number;
  tenantId: number;
  name: string;
  description: string;
  incentiveType: IncentiveType;
  amountBasis: AmountBasis;
  /** FLAT only. Integer cents. */
  rewardCents: number;
  /** PERCENT only. Basis points of the event's amount. */
  percentageBp: number;
  filters: IncentiveFilters;
  /** Inclusive start / exclusive end, epoch ms. */
  startsAtMs: number;
  endsAtMs: number;
  /** 0 = unlimited. The COUNT of awards one user may earn from this campaign —
   *  distinct from the cents caps, which bound money rather than occurrences. */
  maximumRewardsPerUser: number;
  /** 0 = uncapped. Bounds one rep's total take. */
  perRepCapCents: number;
  /** 0 = uncapped. The campaign's whole liability ceiling. */
  campaignCapCents: number;
  /** Does an award land as 'earned' (pending review) or straight to 'approved'? */
  approvalRequired: boolean;
  clawbackPolicy: ClawbackPolicy;
  active: boolean;
}

/** What the engine knows about the recipient at decision time. */
export interface RecipientCounters {
  repId: number;
  role: string | null;
  /** Awards this rep has already earned from THIS campaign. */
  awardsFromCampaign: number;
  /** Cents this rep has already earned from THIS campaign. */
  centsFromCampaign: number;
  /** Cents every rep has earned from THIS campaign. */
  centsFromCampaignTotal: number;
  /** Lifetime approved sales — the FIRST_SALE trigger reads this. */
  lifetimeApprovedSales?: number;
}

/** The facts an event carries that a rule may read. */
export interface EventFacts {
  eventId: number;
  type: DomainEventType;
  occurredAtMs: number;
  /** The rep the event is about. */
  subjectRepId: number | null;
  /** Money already computed by the source (a trip's reimbursement, a referral's
   *  reward). PASSTHROUGH and PERCENT read this. */
  amountCents?: number | null;
  provider?: string | null;
  product?: string | null;
  market?: string | null;
  territoryId?: number | null;
  /** For FIRST_SALE — this sale's 1-based ordinal in the rep's lifetime. */
  lifetimeSaleNumber?: number | null;
}

// ── Skip reasons ────────────────────────────────────────────────────────────

export type IncentiveSkip =
  | "inactive"
  | "wrong_event"
  | "window_closed"
  | "no_recipient"
  | "filter_provider"
  | "filter_product"
  | "filter_market"
  | "filter_territory"
  | "filter_rep"
  | "filter_role"
  | "trigger_unmet"
  | "max_rewards_reached"
  | "rep_cap_reached"
  | "campaign_cap_reached"
  | "zero_amount";

export interface IncentiveAward {
  campaignId: number;
  eventId: number;
  recipientRepId: number;
  amountCents: number;
  /** The idempotency key — lands in `spiffs.sale_ref`. */
  rewardKey: string;
  /** Short, rep-readable. Goes on the ledger row. */
  reason: string;
  /** 'earned' when the campaign wants review, 'approved' when it does not. */
  status: "earned" | "approved";
  incentiveType: IncentiveType;
}

export type IncentiveDecision =
  | { awarded: true; award: IncentiveAward; skip: null }
  | { awarded: false; award: null; skip: IncentiveSkip };

const no = (skip: IncentiveSkip): IncentiveDecision => ({ awarded: false, award: null, skip });

const cents = (n: unknown) => Math.trunc(Number(n) || 0);

/** Does an optional allow-list admit this value? Unset = admits everything. */
function admits<T>(list: readonly T[] | null | undefined, value: T | null | undefined): boolean {
  if (!list || list.length === 0) return true;
  if (value == null) return false;   // the campaign narrowed; the event cannot prove it belongs
  return list.includes(value);
}

/**
 * The gross amount before caps, from the campaign's basis.
 *
 * PERCENT rounds ONCE, half away from zero, from an integer basis-point
 * multiplication — never a float percentage — so 825 bp of 123456 cents is the
 * same number on every machine and in every replay.
 */
export function grossAmountCents(campaign: IncentiveCampaign, facts: EventFacts): number {
  switch (campaign.amountBasis) {
    case "FLAT":
      return Math.max(0, cents(campaign.rewardCents));
    case "PASSTHROUGH":
      return Math.max(0, cents(facts.amountCents));
    case "PERCENT": {
      const base = Math.max(0, cents(facts.amountCents));
      const bp = Math.max(0, Math.trunc(campaign.percentageBp));
      if (base === 0 || bp === 0) return 0;
      return Math.round((base * bp) / 10_000);
    }
    default:
      return 0;
  }
}

/**
 * Trim an award so it breaches neither cap.
 *
 * Trims rather than suppresses: a rep who is $10 from their cap should earn
 * that $10, not nothing. Only a trim to zero suppresses, and the caller reports
 * that as the specific cap that bit.
 */
export function applyCaps(
  gross: number,
  campaign: IncentiveCampaign,
  counters: RecipientCounters,
): { amount: number; skip: IncentiveSkip | null } {
  let amount = Math.max(0, cents(gross));

  const repCap = Math.max(0, cents(campaign.perRepCapCents));
  if (repCap > 0) {
    const room = repCap - Math.max(0, cents(counters.centsFromCampaign));
    if (room <= 0) return { amount: 0, skip: "rep_cap_reached" };
    amount = Math.min(amount, room);
  }

  const campaignCap = Math.max(0, cents(campaign.campaignCapCents));
  if (campaignCap > 0) {
    const room = campaignCap - Math.max(0, cents(counters.centsFromCampaignTotal));
    if (room <= 0) return { amount: 0, skip: "campaign_cap_reached" };
    amount = Math.min(amount, room);
  }

  return { amount, skip: amount > 0 ? null : "zero_amount" };
}

/**
 * Does the event satisfy this incentive type's own condition, beyond matching
 * the trigger event?
 *
 * Only two types carry an extra condition today. FIRST_SALE is the interesting
 * one: it must fire on the rep's FIRST approved sale and never again, and the
 * ordinal comes from the event rather than from a count taken at decision time,
 * so a replay of that same event still sees "sale number 1".
 */
export function triggerMet(campaign: IncentiveCampaign, facts: EventFacts, counters: RecipientCounters): boolean {
  switch (campaign.incentiveType) {
    case "FIRST_SALE": {
      const ordinal = facts.lifetimeSaleNumber;
      if (ordinal != null) return ordinal === 1;
      // No ordinal on the event — fall back to the counter, which is only
      // correct at the moment of the sale and is why the ordinal is preferred.
      return (counters.lifetimeApprovedSales ?? 0) <= 1;
    }
    case "MILEAGE_REIMBURSEMENT":
      // Mileage only flows if the approval actually computed money. A trip
      // approved while the org's reimbursement switch is off carries zero.
      return cents(facts.amountCents) > 0;
    default:
      return true;
  }
}

/**
 * The whole decision, for ONE campaign against ONE event.
 *
 * Ordered so the cheapest and most explanatory checks run first: an admin
 * debugging "why did nobody get paid?" is better served by "window_closed"
 * than by a cap reason that only happened to be evaluated first.
 */
export function evaluateIncentive(
  campaign: IncentiveCampaign,
  facts: EventFacts,
  counters: RecipientCounters,
  /** Who receives it. Usually the event's subject rep, but a referral reward
   *  pays the REFERRER for an event about someone else, so the caller decides. */
  recipientRepId: number | null,
): IncentiveDecision {
  if (!campaign.active) return no("inactive");
  if (INCENTIVE_TRIGGER_EVENT[campaign.incentiveType] !== facts.type) return no("wrong_event");
  if (facts.occurredAtMs < campaign.startsAtMs || facts.occurredAtMs >= campaign.endsAtMs) return no("window_closed");
  if (recipientRepId == null) return no("no_recipient");

  const f = campaign.filters ?? {};
  if (!admits(f.providers, facts.provider)) return no("filter_provider");
  if (!admits(f.products, facts.product)) return no("filter_product");
  if (!admits(f.markets, facts.market)) return no("filter_market");
  if (!admits(f.territoryIds, facts.territoryId)) return no("filter_territory");
  if (!admits(f.repIds, recipientRepId)) return no("filter_rep");
  if (!admits(f.roles, counters.role)) return no("filter_role");

  if (!triggerMet(campaign, facts, counters)) return no("trigger_unmet");

  const maxAwards = Math.max(0, Math.trunc(campaign.maximumRewardsPerUser));
  if (maxAwards > 0 && counters.awardsFromCampaign >= maxAwards) return no("max_rewards_reached");

  const { amount, skip } = applyCaps(grossAmountCents(campaign, facts), campaign, counters);
  if (skip) return no(skip);

  return {
    awarded: true,
    skip: null,
    award: {
      campaignId: campaign.id,
      eventId: facts.eventId,
      recipientRepId,
      amountCents: amount,
      rewardKey: rewardKey(campaign.id, facts.eventId, recipientRepId),
      reason: campaign.name,
      // An award that needs review lands as 'earned'; one that does not is
      // 'approved' immediately. Both are ledger rows either way — the status
      // decides whether a human has to look before it can be paid.
      status: campaign.approvalRequired ? "earned" : "approved",
      incentiveType: campaign.incentiveType,
    },
  };
}

// ── Clawback ────────────────────────────────────────────────────────────────

export interface ClawbackDecision {
  reverse: boolean;
  amountCents: number;
  reason: string | null;
}

/**
 * Should a cancellation reverse an award, and by how much?
 *
 * The window is measured from when the award was EARNED, not from the sale, so
 * an org's clawback period means the same thing for every incentive type
 * regardless of how long the underlying event took to settle.
 */
export function evaluateClawback(p: {
  policy: ClawbackPolicy;
  awardedAtMs: number;
  cancelledAtMs: number;
  awardAmountCents: number;
  /** PRORATED only: how much of the qualifying basis was lost, in basis points. */
  lostFractionBp?: number;
}): ClawbackDecision {
  if (!p.policy?.enabled) return { reverse: false, amountCents: 0, reason: null };

  const windowDays = Math.max(0, Math.trunc(p.policy.windowDays));
  if (windowDays > 0) {
    const elapsedDays = (p.cancelledAtMs - p.awardedAtMs) / 86_400_000;
    if (elapsedDays > windowDays) {
      return { reverse: false, amountCents: 0, reason: "outside_clawback_window" };
    }
  }

  const award = Math.max(0, cents(p.awardAmountCents));
  if (award === 0) return { reverse: false, amountCents: 0, reason: null };

  if (p.policy.mode === "PRORATED") {
    const bp = Math.max(0, Math.min(10_000, Math.trunc(p.lostFractionBp ?? 10_000)));
    const amount = Math.round((award * bp) / 10_000);
    return { reverse: amount > 0, amountCents: amount, reason: "sale_cancelled" };
  }

  return { reverse: true, amountCents: award, reason: "sale_cancelled" };
}

// ── Validation ──────────────────────────────────────────────────────────────

export function validateCampaign(c: Partial<IncentiveCampaign>): string[] {
  const problems: string[] = [];

  if (!c.name || !String(c.name).trim()) problems.push("name is required");
  if (!c.incentiveType || !(INCENTIVE_TYPES as readonly string[]).includes(c.incentiveType)) {
    problems.push("incentiveType is not a known incentive");
  }
  if (!c.amountBasis || !["FLAT", "PERCENT", "PASSTHROUGH"].includes(c.amountBasis)) {
    problems.push("amountBasis must be FLAT, PERCENT, or PASSTHROUGH");
  }
  if (c.amountBasis === "FLAT" && (!Number.isInteger(c.rewardCents) || (c.rewardCents as number) <= 0)) {
    problems.push("a FLAT campaign needs a rewardCents greater than zero");
  }
  if (c.amountBasis === "PERCENT") {
    if (!Number.isInteger(c.percentageBp) || (c.percentageBp as number) <= 0) {
      problems.push("a PERCENT campaign needs a percentageBp greater than zero");
    } else if ((c.percentageBp as number) > 10_000) {
      // Paying more than the thing is worth is almost always a units mistake
      // (50 meaning 50% entered as 5000 bp, or the reverse).
      problems.push("percentageBp cannot exceed 10000 (100%)");
    }
  }
  if (c.startsAtMs != null && c.endsAtMs != null && c.endsAtMs <= c.startsAtMs) {
    problems.push("the campaign must end after it starts");
  }
  for (const key of ["maximumRewardsPerUser", "perRepCapCents", "campaignCapCents"] as const) {
    const v = c[key];
    if (v != null && (!Number.isInteger(v) || v < 0)) problems.push(`${key} must be a whole number, 0 for unlimited`);
  }
  if (c.clawbackPolicy) {
    if (!["FULL", "PRORATED"].includes(c.clawbackPolicy.mode)) problems.push("clawback mode must be FULL or PRORATED");
    if (!Number.isInteger(c.clawbackPolicy.windowDays) || c.clawbackPolicy.windowDays < 0) {
      problems.push("clawback windowDays must be a whole number of days");
    }
  }
  return problems;
}
