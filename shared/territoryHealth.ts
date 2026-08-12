// ── Territory health and reclaim recommendations ─────────────────────────────
//
// PURE. Decides what an area's numbers MEAN, and - separately - whether a human
// should look at it. Those are two different questions and this file never
// collapses them.
//
// The load-bearing rule: NOTHING HERE RECLAIMS ANYTHING. Every output is a
// recommendation with its reasoning attached, addressed to a person who holds
// the capability to act. The spec is explicit that reclaim must be review-only
// and audited, and the shape of this module is what makes that true rather than
// a promise: it returns text and a flag, and has no way to reach a database.
//
// The second rule: A RECOMMENDATION MUST SURVIVE BEING READ ALOUD TO THE REP.
// "Assigned 4 days, 8% attempted, no activity in 36 hours, 47 fresh doors
// untouched" is a case a manager can put to somebody. A score of 0.31 is not.
// So every recommendation carries the counts that produced it, and the reasons
// are a list of sentences rather than a weighted sum.

import { rate } from "./repMetrics";

export const TERRITORY_STATUSES = [
  "fully_worked",
  "high_conversion",
  "healthy",
  "high_opportunity",
  "needs_attention",
  "underworked",
  "stale",
  "reclaim_candidate",
] as const;
export type TerritoryStatus = (typeof TERRITORY_STATUSES)[number];

export const TERRITORY_STATUS_LABEL: Record<TerritoryStatus, string> = {
  fully_worked: "Fully worked",
  high_conversion: "High conversion",
  healthy: "Healthy",
  high_opportunity: "High opportunity",
  needs_attention: "Needs attention",
  underworked: "Underworked",
  stale: "Stale",
  reclaim_candidate: "Reclaim candidate",
};

/** Semantic tone for the badge. Kept here so every surface colours a status the
 *  same way and no component invents its own mapping. */
export const TERRITORY_STATUS_TONE: Record<TerritoryStatus, "success" | "info" | "neutral" | "warning" | "destructive"> = {
  fully_worked: "success",
  high_conversion: "success",
  healthy: "info",
  high_opportunity: "info",
  needs_attention: "warning",
  underworked: "warning",
  stale: "warning",
  reclaim_candidate: "destructive",
};

// ── Thresholds ───────────────────────────────────────────────────────────────
//
// Every one of these is a product decision, not a constant of nature. They live
// together so an org tuning them changes one block, and so a review can see the
// whole policy at once instead of inferring it from nine comparisons.

export interface TerritoryThresholds {
  /** Utilization at or above this = the area has been worked through. */
  fullyWorkedUtilization: number;
  /** Below this, with age, the area is underworked. */
  underworkedUtilization: number;
  /** Hours with no meaningful activity before an area reads as stale. */
  staleHours: number;
  /** Days an assignment may sit below the underworked bar before reclaim is
   *  recommended. */
  reclaimAgeDays: number;
  /** Utilization below which reclaim may be recommended at all. */
  reclaimUtilization: number;
  /** Hours of silence required before reclaim may be recommended. */
  reclaimSilentHours: number;
  /** Conversion at or above this marks the area as high-converting. */
  highConversionRate: number;
  /** Untouched eligible doors that make an area a standout opportunity. */
  highOpportunityDoors: number;
  /** An area smaller than this is never given a status beyond healthy: the
   *  rates are too noisy to act on and a 3-door area at 0% is not a finding. */
  minDoorsForJudgement: number;
}

export const DEFAULT_TERRITORY_THRESHOLDS: TerritoryThresholds = {
  fullyWorkedUtilization: 0.9,
  underworkedUtilization: 0.25,
  staleHours: 48,
  reclaimAgeDays: 4,
  reclaimUtilization: 0.15,
  reclaimSilentHours: 36,
  highConversionRate: 0.12,
  highOpportunityDoors: 150,
  minDoorsForJudgement: 20,
};

// ── Input ────────────────────────────────────────────────────────────────────

export interface TerritoryFacts {
  territoryId: number;
  territoryName: string;
  eligibleDoors: number;
  assignedDoors: number;
  unassignedDoors: number;
  doorsAttempted: number;
  verifiedVisits: number;
  everWorkedDoors: number;
  contacts: number;
  submittedOrders: number;
  installedOrders: number;
  paidOrders: number;
  freshAssigned: number;
  freshAttempted: number;
  activeRepCount: number;
  /** Epoch ms of the last knock in this area. null = never. */
  lastActivityAtMs: number | null;
  /** Epoch ms the area was assigned. null = unassigned. */
  assignedAtMs: number | null;
  callbacksDue: number;
  openRecoveryCases: number;
  estimatedCommissionCents: number;
  paidCommissionCents: number;
}

export interface TerritoryHealth {
  status: TerritoryStatus;
  utilizationRate: number | null;
  coverageRate: number | null;
  conversionRate: number | null;
  freshUtilizationRate: number | null;
  untouchedDoors: number;
  hoursSinceActivity: number | null;
  assignmentAgeHours: number | null;
  /** Plain sentences, each independently checkable against the counts above. */
  reasons: string[];
  /** True only when EVERY reclaim condition holds. Advisory - see the file
   *  header. Nothing in this codebase acts on it without a human decision. */
  reclaimRecommended: boolean;
  /** The case, as it would be put to a manager. null when not recommended. */
  reclaimRationale: string | null;
}

/**
 * Classify one area.
 *
 * Order matters and is deliberate: the best-case labels are tested FIRST, so an
 * area that has been worked through never gets tagged "underworked" merely
 * because there is nothing left in it to knock. That inversion is the single
 * easiest way for a board like this to punish the people who finished.
 */
export function assessTerritory(
  f: TerritoryFacts,
  nowMs: number,
  thresholds: TerritoryThresholds = DEFAULT_TERRITORY_THRESHOLDS,
): TerritoryHealth {
  const utilizationRate = rate(f.everWorkedDoors, f.eligibleDoors);
  const coverageRate = rate(f.doorsAttempted, f.eligibleDoors);
  const conversionRate = rate(f.submittedOrders, f.doorsAttempted);
  const freshUtilizationRate = rate(f.freshAttempted, f.freshAssigned);
  const untouchedDoors = Math.max(0, f.eligibleDoors - f.everWorkedDoors);

  const hoursSinceActivity = f.lastActivityAtMs != null
    ? Math.max(0, (nowMs - f.lastActivityAtMs) / 3_600_000)
    : null;
  const assignmentAgeHours = f.assignedAtMs != null
    ? Math.max(0, (nowMs - f.assignedAtMs) / 3_600_000)
    : null;

  const reasons: string[] = [];

  // Too small to judge. Returned early so none of the rate-based labels below
  // can fire on a denominator of nine doors.
  if (f.eligibleDoors < thresholds.minDoorsForJudgement) {
    return {
      status: "healthy",
      utilizationRate, coverageRate, conversionRate, freshUtilizationRate,
      untouchedDoors, hoursSinceActivity, assignmentAgeHours,
      reasons: [`Only ${f.eligibleDoors} eligible doors - too few for a utilization judgement.`],
      reclaimRecommended: false,
      reclaimRationale: null,
    };
  }

  // ── Best case first ────────────────────────────────────────────────────────
  if (utilizationRate != null && utilizationRate >= thresholds.fullyWorkedUtilization) {
    reasons.push(`${pct(utilizationRate)} of eligible doors have been worked.`);
    if (conversionRate != null && conversionRate >= thresholds.highConversionRate) {
      reasons.push(`${pct(conversionRate)} of attempts produced a submitted order.`);
    }
    return done("fully_worked");
  }

  if (conversionRate != null && conversionRate >= thresholds.highConversionRate && f.doorsAttempted >= 50) {
    reasons.push(`${pct(conversionRate)} of ${f.doorsAttempted} attempts produced a submitted order.`);
    reasons.push(`${untouchedDoors} eligible doors remain - this area is worth finishing.`);
    return done("high_conversion");
  }

  // ── Reclaim: every condition, or none ──────────────────────────────────────
  // Written as an explicit conjunction rather than a score so that a manager
  // reading the rationale sees the same four facts the code checked.
  const ageDays = assignmentAgeHours != null ? assignmentAgeHours / 24 : null;
  const reclaimConditions =
    f.assignedAtMs != null &&
    ageDays != null && ageDays >= thresholds.reclaimAgeDays &&
    utilizationRate != null && utilizationRate < thresholds.reclaimUtilization &&
    (hoursSinceActivity == null || hoursSinceActivity >= thresholds.reclaimSilentHours);

  if (reclaimConditions) {
    const parts = [
      `Assigned for ${Math.floor(ageDays!)} days.`,
      `${pct(utilizationRate)} of ${f.eligibleDoors} eligible doors attempted.`,
      hoursSinceActivity == null
        ? "No activity has ever been recorded here."
        : `No activity in ${Math.floor(hoursSinceActivity)} hours.`,
    ];
    const freshRemaining = Math.max(0, f.freshAssigned - f.freshAttempted);
    if (freshRemaining > 0) parts.push(`${freshRemaining} newly lit doors remain untouched.`);
    reasons.push(...parts);
    const rationale =
      `${parts.join(" ")} Recommend manager review for reclaim or reassignment. ` +
      `This is a recommendation only - no doors move without an authorized decision.`;
    return {
      status: "reclaim_candidate",
      utilizationRate, coverageRate, conversionRate, freshUtilizationRate,
      untouchedDoors, hoursSinceActivity, assignmentAgeHours,
      reasons,
      reclaimRecommended: true,
      reclaimRationale: rationale,
    };
  }

  // ── Degraded states ────────────────────────────────────────────────────────
  if (hoursSinceActivity != null && hoursSinceActivity >= thresholds.staleHours && f.assignedAtMs != null) {
    reasons.push(`No activity in ${Math.floor(hoursSinceActivity)} hours.`);
    reasons.push(`${untouchedDoors} eligible doors still untouched.`);
    return done("stale");
  }

  if (utilizationRate != null && utilizationRate < thresholds.underworkedUtilization
      && assignmentAgeHours != null && assignmentAgeHours >= 24) {
    reasons.push(`${pct(utilizationRate)} utilization after ${Math.floor(assignmentAgeHours / 24)} day(s) assigned.`);
    if (f.activeRepCount === 0) reasons.push("No rep has been active here recently.");
    return done("underworked");
  }

  if (untouchedDoors >= thresholds.highOpportunityDoors && f.unassignedDoors > 0) {
    reasons.push(`${untouchedDoors} eligible doors have never been knocked.`);
    reasons.push(`${f.unassignedDoors} of them are not assigned to anyone.`);
    return done("high_opportunity");
  }

  if (f.callbacksDue > 10 || f.openRecoveryCases > 5) {
    if (f.callbacksDue > 10) reasons.push(`${f.callbacksDue} callbacks are due here.`);
    if (f.openRecoveryCases > 5) reasons.push(`${f.openRecoveryCases} orders are in recovery.`);
    return done("needs_attention");
  }

  reasons.push(`${pct(utilizationRate)} of eligible doors worked, ${untouchedDoors} remaining.`);
  return done("healthy");

  function done(status: TerritoryStatus): TerritoryHealth {
    return {
      status,
      utilizationRate, coverageRate, conversionRate, freshUtilizationRate,
      untouchedDoors, hoursSinceActivity, assignmentAgeHours,
      reasons,
      reclaimRecommended: false,
      reclaimRationale: null,
    };
  }
}

/**
 * Reclaimed-risk score, 0..1, for SORTING a manager's queue only.
 *
 * Deliberately not a status and never shown as a grade. The status above is
 * what a person reads; this is what puts the most urgent area at the top of the
 * list. Keeping them separate is what stops "0.72" turning into a number
 * somebody quotes at a rep.
 */
export function reclaimRiskScore(
  h: Pick<TerritoryHealth, "utilizationRate" | "hoursSinceActivity" | "assignmentAgeHours" | "untouchedDoors">,
  thresholds: TerritoryThresholds = DEFAULT_TERRITORY_THRESHOLDS,
): number {
  const idle = h.hoursSinceActivity == null ? 1 : clamp01(h.hoursSinceActivity / (thresholds.staleHours * 2));
  const unused = h.utilizationRate == null ? 0.5 : clamp01(1 - h.utilizationRate);
  const age = h.assignmentAgeHours == null ? 0 : clamp01(h.assignmentAgeHours / (thresholds.reclaimAgeDays * 24 * 2));
  const size = clamp01(h.untouchedDoors / 200);
  return Math.round((idle * 0.35 + unused * 0.35 + age * 0.2 + size * 0.1) * 100) / 100;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function pct(r: number | null): string {
  return r == null ? "—" : `${Math.round(r * 100)}%`;
}
