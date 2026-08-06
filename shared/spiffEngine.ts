// ── Spiff engine (sales-incentive recognition) ────────────────────────────────
// A SPIFF is a surprise recognition bonus awarded on a field sale, worth a
// VARIABLE $25–$50 in $5 steps — some land at random (a surprise that keeps
// every sale exciting), the rest when a performance ALGORITHM sees a rep
// "locking in": on a selling streak, measurably improving over their own
// baseline, or crossing a lifetime-sales milestone.
//
// THIS FILE IS PURE. Nothing here reads the clock, rolls dice, or touches a
// database. `decideSpiff` is a deterministic function of (sale context, a
// performance snapshot, a caller-supplied roll in [0,1), config); `heatScore`
// is a deterministic function of the snapshot alone. The server supplies the
// snapshot (built read-only from sale history), the seeded roll, and the
// timestamp at the call site — which is exactly what makes both the "random"
// award AND its dollar amount reproducible in a unit test.
//
// MONEY GUARDRAIL: a spiff is a SEPARATE recognition ledger. This module never
// computes, reads, or writes commission/payroll. It only decides whether a
// recognition bonus is earned and how big it is; a spiff is TRACKED
// (earned → approved → paid), never auto-injected into pay.

/** Tunable award policy. All amounts are integer cents. */
export interface SpiffConfig {
  /** Bottom of the award band, in cents. Default 2500 = $25. */
  minAmountCents: number;
  /** Top of the award band, in cents. Default 5000 = $50. */
  maxAmountCents: number;
  /** Award granularity, in cents. Default 500 = $5 steps, so a spiff always
   *  reads like a real prize ($35) and never like a rounding artefact ($37.41). */
  incrementCents: number;
  /** BACK-COMPAT ALIAS. When set, the band collapses to this exact flat amount
   *  (min = max = amountCents) — the pre-band behaviour, kept so an existing
   *  caller/config that pins a single value keeps working. Leave it undefined to
   *  use the band. */
  amountCents?: number;
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
  /** Hard cap on the NUMBER of spiffs a single rep can earn in one day. */
  dailyCapPerRep: number;
  /** Hard cap on the total CENTS a single rep can earn in spiffs in one day —
   *  the anti-farming backstop that actually bounds money now that the amount
   *  varies. A draw that would breach it is trimmed down to the largest whole
   *  increment that still fits, and suppressed entirely if even the band
   *  minimum no longer fits. Default 10000 = $100/day. */
  dailyCapCentsPerRep: number;
}

/** Sensible, documented defaults. A modest random chance keeps most sales
 *  spiff-free while every sale still carries a real chance of a surprise; the
 *  deterministic triggers do the motivational heavy lifting. */
export const DEFAULT_SPIFF_CONFIG: SpiffConfig = {
  minAmountCents: 2500,      // $25
  maxAmountCents: 5000,      // $50
  incrementCents: 500,       // $5 steps → 25/30/35/40/45/50
  randomChancePct: 12,       // ~1 in 8 sales gets a surprise
  streakThresholdDays: 3,    // 3 consecutive selling days
  improvementPct: 50,        // 50% above their own trailing average
  milestoneEvery: 10,        // every 10th career sale
  dailyCapPerRep: 2,         // at most 2 spiffs/day per rep
  dailyCapCentsPerRep: 10000, // …and never more than $100/day per rep
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
  /** Number of spiffs already earned by this rep today — feeds the count cap. */
  spiffsGrantedToday: number;
  /** CENTS already earned in spiffs by this rep today — feeds the money cap.
   *  Integer cents; never a float dollar amount. */
  spiffCentsGrantedToday: number;
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
 * Coerce to a non-negative whole number — the only shape money (integer cents)
 * or a count is ever allowed to take here. A missing/NaN/negative input reads as
 * 0, which for a SPEND-SO-FAR or a CAP means the engine fails CLOSED (it
 * withholds an award) rather than paying out on a malformed config.
 */
function wholeNonNegative(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0;
  return v < 0 ? 0 : v;
}

// ── Amount band ───────────────────────────────────────────────────────────────

/** The resolved, integer-cent award band a config describes. */
export interface SpiffAmountBand {
  minCents: number;
  maxCents: number;
  incrementCents: number;
  /** Number of distinct payable amounts in the band (≥ 1). */
  steps: number;
}

/**
 * Resolve a config into a sane integer band. Tolerates a reversed or degenerate
 * band and honours the `amountCents` back-compat alias by collapsing to a flat
 * single-value band.
 */
export function spiffAmountBand(config: SpiffConfig = DEFAULT_SPIFF_CONFIG): SpiffAmountBand {
  if (config.amountCents != null) {
    const flat = wholeNonNegative(config.amountCents);
    return { minCents: flat, maxCents: flat, incrementCents: Math.max(1, wholeNonNegative(config.incrementCents) || 1), steps: 1 };
  }
  const rawMin = wholeNonNegative(config.minAmountCents);
  const rawMax = wholeNonNegative(config.maxAmountCents);
  const minCents = Math.min(rawMin, rawMax);
  const maxCents = Math.max(rawMin, rawMax);
  const incrementCents = Math.max(1, wholeNonNegative(config.incrementCents) || 1);
  const steps = Math.floor((maxCents - minCents) / incrementCents) + 1;
  return { minCents, maxCents, incrementCents, steps: Math.max(1, steps) };
}

/** Every payable amount in the band, low → high. Used by the UI to show reps
 *  exactly what the prize ladder looks like. */
export function spiffAmountLadder(config: SpiffConfig = DEFAULT_SPIFF_CONFIG): number[] {
  const band = spiffAmountBand(config);
  const out: number[] = [];
  for (let i = 0; i < band.steps; i++) out.push(Math.min(band.maxCents, band.minCents + i * band.incrementCents));
  return out;
}

/**
 * WEIGHTING — why a rep gets $45 instead of $25.
 *
 * Each reason carries a straight-line TILT across the band, written as the
 * relative weight of the LOWEST step vs the HIGHEST step. Every step in between
 * is a linear interpolation of the two, in integer arithmetic (no Math.pow, no
 * floats — the same inputs must produce the same dollar amount on every engine,
 * forever, because this is money).
 *
 * The rarer / more-earned the trigger, the more the draw leans to the top of the
 * band. Over the default $25–$50 / $5 ladder that works out to:
 *
 *   random       9 : 1   low-tilted   → averages ≈ $32.83  (a lucky drop, common)
 *   improvement  5 : 3   mildly low   → averages ≈ $36.04
 *   streak       3 : 5   mildly high  → averages ≈ $38.96
 *   milestone    1 : 9   high-tilted  → averages ≈ $42.17  (rarest, most earned)
 *
 * Every amount in the band stays reachable for every reason — a lucky drop CAN
 * pay $50, it just does so about a ninth as often as a milestone does.
 */
export const SPIFF_AMOUNT_TILT: Record<SpiffReason, readonly [low: number, high: number]> = {
  random: [9, 1],
  improvement: [5, 3],
  streak: [3, 5],
  milestone: [1, 9],
};

/**
 * Draw the award amount for a reason, in integer cents.
 *
 * PURE + DETERMINISTIC: identical (reason, amountRoll, config) → identical cents.
 * The result is always inside the band and always on an increment boundary.
 *
 * @param amountRoll a value in [0,1); the server derives it from the same seeded
 *   roll used for the award decision (see `deriveAmountRoll`).
 */
export function drawSpiffAmountCents(
  reason: SpiffReason,
  amountRoll: number,
  config: SpiffConfig = DEFAULT_SPIFF_CONFIG,
): number {
  const band = spiffAmountBand(config);
  if (band.steps <= 1) return band.minCents;

  const [low, high] = SPIFF_AMOUNT_TILT[reason] ?? SPIFF_AMOUNT_TILT.random;
  const last = band.steps - 1;
  // Integer weight per step: a straight line from `low` at the bottom of the
  // band to `high` at the top.
  const weights: number[] = [];
  let total = 0;
  for (let i = 0; i <= last; i++) {
    const w = low * (last - i) + high * i;
    const safe = w > 0 ? w : 1; // a 0-weight step would be unreachable
    weights.push(safe);
    total += safe;
  }

  const u = Number.isFinite(amountRoll) ? clamp(amountRoll, 0, 0.999999999) : 0;
  let ticket = Math.floor(u * total);
  if (ticket >= total) ticket = total - 1;
  if (ticket < 0) ticket = 0;

  for (let i = 0; i <= last; i++) {
    ticket -= weights[i];
    if (ticket < 0) return Math.min(band.maxCents, band.minCents + i * band.incrementCents);
  }
  return band.maxCents;
}

/**
 * Decorrelate a second uniform draw out of the award roll, with pure integer
 * mixing (an avalanche hash on the roll's 32-bit source).
 *
 * WHY: the award roll is compared against `randomChancePct`, so a "random" spiff
 * only ever happens when the roll sits in a thin slice near 0. Reusing that roll
 * for the amount would pin every lucky drop to the same dollar value. Mixing it
 * gives a fresh, uniform, still fully DETERMINISTIC draw from the same seed.
 */
export function deriveAmountRoll(roll: number): number {
  const base = Number.isFinite(roll) ? clamp(roll, 0, 0.999999999) : 0;
  let h = (Math.floor(base * 0x100000000) ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0x100000000;
}

/** Largest whole increment at or below `budget` that is still ≥ the band floor;
 *  0 when the band floor does not fit at all. */
function trimToBudget(amount: number, budget: number, band: SpiffAmountBand): number {
  if (budget >= amount) return amount;
  if (budget < band.minCents) return 0;
  const stepsThatFit = Math.floor((budget - band.minCents) / band.incrementCents);
  return band.minCents + stepsThatFit * band.incrementCents;
}

/**
 * Decide whether a sale earns a spiff, how big it is, and why.
 *
 * PURE + DETERMINISTIC: identical (sale, perf, roll, config, amountRoll) →
 * identical result. At most ONE spiff per sale (money stays bounded), and never
 * any spiff once the rep has hit either daily cap (anti-farming). Precedence
 * puts the meaningful, "algorithm-saw-it" triggers ahead of the random surprise:
 *
 *   1. daily caps   — hard stop (count AND cents), no award
 *   2. milestone    — this is the rep's Nth lifetime sale
 *   3. streak       — on/through the consecutive-selling-day threshold
 *   4. improvement  — current pace beats their trailing average by improvementPct
 *   5. random       — roll < randomChancePct
 *
 * The AMOUNT is then drawn from the $25–$50 band with a per-reason tilt (see
 * SPIFF_AMOUNT_TILT) and trimmed, never silently, so the day's total can't
 * exceed dailyCapCentsPerRep.
 *
 * @param roll a caller-supplied value in [0,1); the server derives it from a
 *   seed so the "random" branch is reproducible in tests.
 * @param amountRoll a second [0,1) draw for the amount. Defaults to a pure,
 *   deterministic mix of `roll`, so callers keep a single seed.
 */
export function decideSpiff(
  sale: SaleContext,
  perf: PerfSnapshot,
  roll: number,
  config: SpiffConfig = DEFAULT_SPIFF_CONFIG,
  amountRoll: number = deriveAmountRoll(roll),
): SpiffDecision {
  const band = spiffAmountBand(config);

  // 1a. Anti-farming COUNT cap — the backstop that keeps every trigger below
  // from being milked. Reaching it suppresses ALL awards for the day.
  if (config.dailyCapPerRep <= 0 || wholeNonNegative(perf.spiffsGrantedToday) >= config.dailyCapPerRep) {
    return NO_AWARD;
  }
  // 1b. Anti-farming MONEY cap — the one that actually bounds spend now that the
  // amount varies. If not even the band floor fits in what's left of today's
  // budget, nothing is awarded.
  const capCents = wholeNonNegative(config.dailyCapCentsPerRep);
  const remainingCents = capCents - wholeNonNegative(perf.spiffCentsGrantedToday);
  if (remainingCents < band.minCents) return NO_AWARD;

  const award = (reason: SpiffReason): SpiffDecision => {
    const drawn = drawSpiffAmountCents(reason, amountRoll, config);
    const amountCents = trimToBudget(drawn, remainingCents, band);
    if (amountCents <= 0) return NO_AWARD;
    return { awarded: true, amountCents, reason };
  };

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
  // long streak keeps paying out (bounded by the daily caps).
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
    case "random": return "Lucky drop";
    case "streak": return "Hot streak";
    case "improvement": return "On the rise";
    case "milestone": return "Milestone sale";
    default: return "Bonus";
  }
}

/** Plain-language one-liner shown on a rep's spiff card — what actually
 *  happened, in words a rep would use. Deliberately amount-free: the amount is
 *  its own (much bigger) piece of the card. */
export function spiffReasonBlurb(reason: SpiffReason | null): string {
  switch (reason) {
    case "random": return "Lucky drop — this one landed at random.";
    case "streak": return "Sales on back-to-back days. The streak paid.";
    case "improvement": return "You outpaced your own average — best stretch yet.";
    case "milestone": return "Another career milestone in the books.";
    default: return "Recognition bonus earned.";
  }
}

/** How each trigger fires, in plain language, for the "what can I earn" panel.
 *  Derived from the live config so the copy can never drift from the rules. */
export function spiffTriggerGuide(config: SpiffConfig = DEFAULT_SPIFF_CONFIG): Array<{
  reason: SpiffReason;
  title: string;
  how: string;
}> {
  return [
    {
      reason: "milestone",
      title: spiffReasonLabel("milestone"),
      how: `Every ${config.milestoneEvery} career sales. Pays toward the top of the band.`,
    },
    {
      reason: "streak",
      title: spiffReasonLabel("streak"),
      how: `Sell on ${config.streakThresholdDays} days in a row — and again every ${config.streakThresholdDays} days after that.`,
    },
    {
      reason: "improvement",
      title: spiffReasonLabel("improvement"),
      how: `Run ${config.improvementPct}% above your own trailing average.`,
    },
    {
      reason: "random",
      title: spiffReasonLabel("random"),
      how: `Roughly 1 in ${Math.max(1, Math.round(100 / Math.max(1, config.randomChancePct)))} sales drops one at random.`,
    },
  ];
}
