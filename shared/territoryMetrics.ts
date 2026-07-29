// One place that decides what an area's numbers mean.
//
// The spec's requirement is not really "show more stats" — it is that a status
// is mapped to a metric bucket in ONE place, with ONE set of denominators.
// Scattered `status === "sold"` checks across components is how two screens end
// up disagreeing about the same area, and how a rate quietly changes meaning
// when someone adds a status.
//
// Two rules carry most of the weight:
//
//   EVER-KNOCKED IS NOT A STATUS. A door is "knocked" once it has at least one
//   qualifying knock, and it stays knocked forever. If knocked-ness were read
//   off the current disposition, a door that went not_home → sold would leave
//   the not_home bucket and the unique-knocked count would FALL, which is not a
//   thing that can happen. Attempts are counted separately so a rep going back
//   three times does not inflate doors-knocked.
//
//   ONE DENOMINATOR. Every rate below divides by available_base, never by
//   total, so the percentages on a card add up against each other. A door that
//   cannot be sold — do-not-knock, or worked to a terminal no — is removed from
//   the base rather than counted as a failure to sell it.

/** Lead statuses this codebase actually persists (see shared/knock.ts). */
export type MetricLeadStatus =
  | "prospect" | "contacted" | "interested" | "sold" | "not_interested" | "follow_up";

/** What one door contributes. `everKnocked` and `attempts` come from the knock
 *  log, NOT from the status — that separation is the point. */
export interface LeadMetricInput {
  status: MetricLeadStatus | string | null | undefined;
  everKnocked: boolean;
  /** Total knocks logged on this door, however many times a rep went back. */
  attempts?: number;
  /** Someone answered at least once. Distinct from having knocked. */
  everContacted?: boolean;
  /** Excluded from the base: nobody may knock here. */
  doNotKnock?: boolean;
}

export interface TerritoryMetrics {
  totalLeads: number;
  /** total − unavailable − disqualified. The denominator for every rate. */
  availableBase: number;
  untouchedCount: number;
  /** DISTINCT doors with at least one knock — never decreases. */
  knockedCount: number;
  /** Every knock ever logged, including repeat visits to one door. */
  attemptCount: number;
  contactedCount: number;
  notHomeCount: number;
  followUpCount: number;
  /** Always 0 today: this product has no appointment outcome. See the note in
   *  APPOINTMENT_UNSUPPORTED rather than reading anything into the zero. */
  appointmentCount: number;
  soldCount: number;
  unavailableCount: number;
  disqualifiedCount: number;
  penetrationRate: number;
  knockCompletionRate: number;
  contactRate: number;
}

/**
 * There is no appointment disposition in this product's taxonomy. The funnel
 * asks for one, and the honest answer is a zero with an explanation rather than
 * mapping `interested` onto it — `interested` is a status reps set today with a
 * different meaning, and folding it in would both overstate appointments and
 * corrupt contact_rate, whose denominator is doors knocked.
 *
 * Adding one is a product decision, not a refactor. When it exists, give it a
 * bucket here and every surface picks it up.
 */
export const APPOINTMENT_UNSUPPORTED = true;

/** Terminal no. leadQualify already treats not_interested as disqualifying, and
 *  this agrees with it deliberately — two definitions of "dead lead" would put
 *  two different denominators on the same card. */
export function isDisqualified(status: unknown): boolean {
  return status === "not_interested";
}

/** Someone answered the door. not_home is a knock with no contact, which is
 *  exactly the distinction contact_rate exists to measure. */
export function isContactStatus(status: unknown): boolean {
  return status === "sold" || status === "interested" || status === "follow_up" || status === "contacted";
}

/**
 * Percent, with division-by-zero returning 0 rather than NaN or Infinity.
 *
 * An empty area is the common case — a freshly drawn one has no doors yet — and
 * "NaN%" on a card is worse than "0%" because it looks like a crash.
 */
export function safeRate(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 100; // 2dp
}

export function computeTerritoryMetrics(leads: readonly LeadMetricInput[]): TerritoryMetrics {
  let totalLeads = 0;
  let knockedCount = 0, attemptCount = 0, contactedCount = 0;
  let notHomeCount = 0, followUpCount = 0, soldCount = 0;
  let unavailableCount = 0, disqualifiedCount = 0;

  for (const lead of leads) {
    totalLeads++;
    const status = lead.status;

    // Unavailable wins over disqualified so one door is never removed twice
    // from the base — that would push available_base below the real figure and
    // inflate every rate on the card.
    if (lead.doNotKnock) unavailableCount++;
    else if (isDisqualified(status)) disqualifiedCount++;

    if (lead.everKnocked) knockedCount++;
    attemptCount += Math.max(0, Math.trunc(lead.attempts ?? (lead.everKnocked ? 1 : 0)));
    if (lead.everContacted ?? isContactStatus(status)) contactedCount++;

    if (status === "sold") soldCount++;
    else if (status === "follow_up") followUpCount++;
    // A door knocked with nobody home keeps status prospect — "knocked but no
    // contact" is the fact, and it cannot be read from the status alone.
    else if (lead.everKnocked && !(lead.everContacted ?? isContactStatus(status))) notHomeCount++;
  }

  const availableBase = Math.max(0, totalLeads - unavailableCount - disqualifiedCount);
  // Clamped: a door can be knocked and later become unavailable, which would
  // otherwise report a negative "untouched".
  const untouchedCount = Math.max(0, availableBase - knockedCount);

  return {
    totalLeads,
    availableBase,
    untouchedCount,
    knockedCount,
    attemptCount,
    contactedCount,
    notHomeCount,
    followUpCount,
    appointmentCount: 0,
    soldCount,
    unavailableCount,
    disqualifiedCount,
    penetrationRate: safeRate(soldCount, availableBase),
    knockCompletionRate: safeRate(knockedCount, availableBase),
    contactRate: safeRate(contactedCount, knockedCount),
  };
}

/** "24 of 80 knocked" — the line a rep reads before deciding where to walk. */
export function knockSummary(m: Pick<TerritoryMetrics, "knockedCount" | "availableBase">): string {
  return `${m.knockedCount} of ${m.availableBase} knocked`;
}
