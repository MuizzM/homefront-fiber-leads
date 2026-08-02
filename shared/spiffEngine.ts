// ── Spiff engine (sales-incentive recognition) ────────────────────────────────
// A SPIFF is a $50 recognition bonus awarded on a field sale — some at random
// (a surprise that keeps every sale exciting), the rest triggered when a
// performance ALGORITHM sees a rep "locking in": on a selling streak, measurably
// improving over their own baseline, or crossing a lifetime-sales milestone.
//
// THIS FILE IS PURE. Nothing here reads the clock, rolls dice, or touches a
// database. `decideSpiff` is a deterministic function of (sale context, a
// performance snapshot, a caller-supplied roll in [0,1), config); `heatScore`
// is a deterministic function of the snapshot alone. The server supplies the
// snapshot (built read-only from sale history), the seeded roll, and the
// timestamp at the call site — which is exactly what makes the "random" award
// reproducible in a unit test.
//
// MONEY GUARDRAIL: a spiff is a SEPARATE recognition ledger. This module never
// computes, reads, or writes commission/payroll. It only decides whether a
// recognition bonus is earned; a spiff is TRACKED (earned → approved → paid),
// never auto-injected into pay.

/** Tunable award policy. All amounts in integer cents; defaults = $50. */
export interface SpiffConfig {
  /** Award amount, in cents. Default 5000 = $50. */
  amountCents: number;
  /** Base per-sale chance (percent, 0..100) of a RANDOM surprise spiff. */
  randomChancePct: number;
  /** Consecutive selling-day streak length that earns a streak spiff (and each
   *  further multiple of it — 3, 6, 9 …). */
  streakThresholdDays: number;
  /** Improvement bar (percent): current velocity must beat the rep's trailing
   *  average by at least this much to earn an improvement spiff. Default 50. */
  improvementPct: number;
  /** Every Nth LIFETIME sale earns a milestone spiff (10, 20, 30 …). */
  milestoneEvery: number;
  /** Hard cap on spiffs a single rep can earn in one day — the anti-farming
   *  backstop. Bounds a rep's daily spiff spend to dailyCapPerRep × amountCents. */
  dailyCapPerRep: number;
}

/** Sensible, documented defaults. A modest random chance keeps most sales
 *  spiff-free while every sale still carries a real chance of a surprise; the
 *  deterministic triggers do the motivational heavy lifting. */
export const DEFAULT_SPIFF_CONFIG: SpiffConfig = {
  amountCents: 5000,        // $50
  randomChancePct: 12,      // ~1 in 8 sales gets a surprise
  streakThresholdDays: 3,   // 3 consecutive selling days
  improvementPct: 50,       // 50% above their own trailing average
  milestoneEvery: 10,       // every 10th career sale
  dailyCapPerRep: 2,        // at most $100/day of spiffs per rep
};

/** A rep's recent-performance snapshot — the "algorithm data" the award
 *  decision and the heat meter both read. Built server-side, read-only, from
 *  sale history; every field is a plain number so the logic stays pure. */
export interface PerfSnapshot {
  /** Lifetime completed sales for this rep (used for milestone cadence). */
  totalSales: number;
  /** Sales inside the trailing recent window. */
  recentSalesCount: number;
  /** Length in days of the recent window recentSalesCount covers. */
  windowDays: number;
  /** recentSalesCount / windowDays — the rep's current pace. */
  salesVelocityPerDay: number;
  /** Baseline pace over the window BEFORE the recent one (what "improvement"
   *  is measured against). */
  trailingAvgPerDay: number;
  /** Consecutive calendar days with ≥1 sale, ending at the latest sale day. */
  currentStreakDays: number;
  /** Signed short-term momentum: recent-week sales minus prior-week sales. */
  recentTrend: number;
  /** Spiffs already earned by this rep today — feeds the daily cap. */
  spiffsGrantedToday: number;
}

/** The sale being evaluated. */
export interface SaleContext {
  /** Stable per-sale reference (e.g. "knock:1234") — the ledger idempotency key. */
  saleRef: string;
  /** 1-based ordinal of THIS sale in the rep's lifetime (== totalSales at the
   *  moment of the sale). Drives the milestone trigger. */
  lifetimeSaleNumber: number;
}

export type SpiffReason = "random" | "streak" | "improvement" | "milestone";

export interface SpiffDecision {
  awarded: boolean;
  amountCents: number;
  /** Why it was awarded; null when nothing was awarded. */
  reason: SpiffReason | null;
}

const NO_AWARD: SpiffDecision = { awarded: false, amountCents: 0, reason: null };

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Decide whether a sale earns a $50 spiff, and why.
 *
 * PURE + DETERMINISTIC: identical (sale, perf, roll, config) → identical result.
 * At most ONE spiff per sale (money stays bounded), and never any spiff once the
 * rep has hit the daily cap (anti-farming). Precedence puts the meaningful,
 * "algorithm-saw-it" triggers ahead of the random surprise:
 *
 *   1. daily cap    — hard stop, no award
 *   2. milestone    — this is the rep's Nth lifetime sale
 *   3. streak       — on/through the consecutive-selling-day threshold
 *   4. improvement  — current pace beats their trailing average by improvementPct
 *   5. random       — roll < randomChancePct
 *
 * @param roll a caller-supplied value in [0,1); the server derives it from a
 *   seed so the "random" branch is reproducible in tests.
 */
export function decideSpiff(
  sale: SaleContext,
  perf: PerfSnapshot,
  roll: number,
  config: SpiffConfig = DEFAULT_SPIFF_CONFIG,
): SpiffDecision {
  const amountCents = Math.max(0, Math.round(config.amountCents));
  const award = (reason: SpiffReason): SpiffDecision => ({ awarded: true, amountCents, reason });

  // 1. Anti-farming cap — the backstop that keeps every trigger below from
  // being milked. Reaching the cap suppresses ALL awards for the day.
  if (config.dailyCapPerRep <= 0 || perf.spiffsGrantedToday >= config.dailyCapPerRep) {
    return NO_AWARD;
  }

  // 2. Milestone — every Nth career sale (10th, 20th, …).
  if (
    config.milestoneEvery > 0 &&
    sale.lifetimeSaleNumber > 0 &&
    sale.lifetimeSaleNumber % config.milestoneEvery === 0
  ) {
    return award("milestone");
  }

  // 3. Streak — the algorithm sees a rep selling day after day. Fires when the
  // streak reaches the threshold and again at each further multiple of it, so a
  // long streak keeps paying out (bounded by the daily cap).
  if (
    config.streakThresholdDays > 0 &&
    perf.currentStreakDays >= config.streakThresholdDays &&
    perf.currentStreakDays % config.streakThresholdDays === 0
  ) {
    return award("streak");
  }

  // 4. Improvement — current pace is measurably above the rep's OWN trailing
  // average. Requires a real baseline and a couple of recent sales so a single
  // sale off a cold week can't masquerade as a hot streak.
  if (
    perf.trailingAvgPerDay > 0 &&
    perf.recentSalesCount >= 2 &&
    perf.salesVelocityPerDay >= perf.trailingAvgPerDay * (1 + config.improvementPct / 100)
  ) {
    return award("improvement");
  }

  // 5. Random surprise — the base excitement layer. roll is in [0,1); award when
  // it lands under the configured chance.
  if (config.randomChancePct > 0 && roll >= 0 && roll < config.randomChancePct / 100) {
    return award("random");
  }

  return NO_AWARD;
}

/**
 * Heat score 0..100 — a single number summarizing how "locked in" a rep is right
 * now. This is the algorithm data admins see on the team leaderboard.
 *
 * PURE and MONOTONIC in every locked-in signal: raising the current streak, the
 * sales velocity, or the recent sales count (holding the others fixed) can only
 * raise the score, never lower it. Weighted so no single signal saturates it.
 */
export function heatScore(perf: PerfSnapshot): number {
  // Streak — up to 35 pts, maxed at a full week of consecutive selling days.
  const streakPart = clamp(perf.currentStreakDays / 7, 0, 1) * 35;
  // Velocity — up to 30 pts, maxed at ~3 sales/day.
  const velocityPart = clamp(perf.salesVelocityPerDay / 3, 0, 1) * 30;
  // Recent volume — up to 20 pts, maxed at 15 sales in the recent window.
  const volumePart = clamp(perf.recentSalesCount / 15, 0, 1) * 20;
  // Improvement over baseline — up to 15 pts, maxed at 2× the trailing average.
  // A rep selling with no prior baseline reads as improving (they went from
  // nothing to something); increasing velocity only ever raises this part.
  const ratio = perf.trailingAvgPerDay > 0
    ? perf.salesVelocityPerDay / perf.trailingAvgPerDay
    : (perf.salesVelocityPerDay > 0 ? 2 : 1);
  const improvementPart = clamp(ratio - 1, 0, 1) * 15;

  return Math.round(clamp(streakPart + velocityPart + volumePart + improvementPart, 0, 100));
}

/** Human label for a reason, reused by the rep feed and the admin console. */
export function spiffReasonLabel(reason: SpiffReason | null): string {
  switch (reason) {
    case "random": return "Lucky spiff";
    case "streak": return "Hot streak";
    case "improvement": return "On the rise";
    case "milestone": return "Milestone sale";
    default: return "Spiff";
  }
}

/** Short, motivational one-liner shown on a rep's spiff card. */
export function spiffReasonBlurb(reason: SpiffReason | null): string {
  switch (reason) {
    case "random": return "A random $50 spiff landed on this sale.";
    case "streak": return "You're selling day after day — keep the streak alive.";
    case "improvement": return "You're pacing well above your average. Locked in.";
    case "milestone": return "Another career milestone in the books.";
    default: return "Recognition bonus earned.";
  }
}
