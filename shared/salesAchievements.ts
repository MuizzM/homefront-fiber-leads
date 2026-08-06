// ── Sales achievements — the bonus a rep can actually picture hitting ────────
// The recognition spiff (shared/spiffEngine.ts) is a SURPRISE: it fires off a
// seeded roll and a performance snapshot, and a rep cannot aim at it. That is
// its job, and it is also its limit. Nobody has ever worked an extra hour to
// improve their odds on something they do not know the odds of.
//
// This is the other half: a small, PUBLISHED, boringly reachable ladder.
//
//     2 sales in a day        → $25
//     4 sales in a day        → $50
//     10 / 25 / 50 / 100 career sales → $25 / $25 / $50 / $50
//
// Every rung is a number a rep can hold in their head at 4pm with one sale
// already on the board. "One more today and it's $25" is a sentence that
// changes what somebody does with their afternoon; "you have a 12% chance of a
// $25–$50 surprise" is not.
//
// ── WHO IT IS FOR ───────────────────────────────────────────────────────────
// Everyone off the ramp. A rep in their first two weeks is on the ramp bonus
// (shared/rampBonus.ts) — paid to learn, because they cannot yet clear a sales
// bar — and steps onto this ladder when that window closes. `excludeRampReps`
// is what enforces the handover, and turning it off pays both at once.
//
// ── RUNGS ARE INDEPENDENT, AND EACH FIRES ONCE PER PERIOD ───────────────────
// Clearing 4 in a day pays the 4 rung ON TOP of the 2 rung already banked, the
// same shape as the knock-milestone ladder — a rep who watches an earned bonus
// get "upgraded" into the same total reads it as the system taking something
// back. Daily rungs reset with the org's local day; career rungs fire exactly
// once, ever.
//
// PURE: no clock, no database, no randomness. The caller supplies the counts.

export interface AchievementRung {
  /** Sales required. */
  sales: number;
  /** Flat award, integer cents. Money is never a float. */
  rewardCents: number;
}

export type AchievementScope = "day" | "career";

export interface SalesAchievementConfig {
  enabled: boolean;
  /** Rungs measured inside the org's local day. */
  daily: AchievementRung[];
  /** Rungs measured against lifetime qualified sales. */
  career: AchievementRung[];
  /** New hires inside the ramp window are on the ramp bonus instead. */
  excludeRampReps: boolean;
  /** Hard ceiling on achievement cents one rep can bank in a day — the
   *  anti-farming backstop that bounds spend if someone edits the ladder into
   *  something silly. 0 = uncapped. */
  maxCentsPerRepPerDay: number;
}

export const DEFAULT_SALES_ACHIEVEMENT_CONFIG: SalesAchievementConfig = {
  enabled: true,
  daily: [
    { sales: 2, rewardCents: 2_500 },   // $25 — a good afternoon
    { sales: 4, rewardCents: 5_000 },   // $50 — a genuinely big day
  ],
  career: [
    { sales: 10, rewardCents: 2_500 },
    { sales: 25, rewardCents: 2_500 },
    { sales: 50, rewardCents: 5_000 },
    { sales: 100, rewardCents: 5_000 },
  ],
  excludeRampReps: true,
  maxCentsPerRepPerDay: 10_000,         // $100/day/rep across every rung
};

const cents = (n: unknown) => Math.max(0, Math.trunc(Number(n) || 0));

/** Ascending, de-duplicated, positive — a ladder with two rungs at 2 sales, or
 *  a 4-sale rung listed first, would pay in an order no rep could predict. */
export function normalizeRungs(rungs: AchievementRung[] | undefined): AchievementRung[] {
  const seen = new Set<number>();
  return (rungs ?? [])
    .map(r => ({ sales: Math.trunc(Number(r?.sales) || 0), rewardCents: cents(r?.rewardCents) }))
    .filter(r => r.sales > 0 && r.rewardCents > 0)
    .filter(r => (seen.has(r.sales) ? false : (seen.add(r.sales), true)))
    .sort((a, b) => a.sales - b.sales);
}

export function normalizeAchievementConfig(config: SalesAchievementConfig): SalesAchievementConfig {
  const c = { ...DEFAULT_SALES_ACHIEVEMENT_CONFIG, ...config };
  return {
    enabled: c.enabled !== false,
    daily: normalizeRungs(c.daily),
    career: normalizeRungs(c.career),
    excludeRampReps: c.excludeRampReps !== false,
    maxCentsPerRepPerDay: cents(c.maxCentsPerRepPerDay),
  };
}

/** One earned rung, ready to be booked. */
export interface AchievementAward {
  scope: AchievementScope;
  sales: number;
  amountCents: number;
  /** The ledger line — and what the rep reads on their pay statement six weeks
   *  later, so it says what they DID, not which internal rung fired. */
  reason: string;
  /** Stable per-rung suffix for the idempotency key. */
  key: string;
}

export function achievementReason(scope: AchievementScope, rung: AchievementRung): string {
  return scope === "day"
    ? `${rung.sales} sales in a day`
    : `${rung.sales} career sales`;
}

export interface AchievementCounts {
  /** Qualified sales in the org's local day. */
  dailySales: number;
  /** Lifetime qualified sales, including today's. */
  careerSales: number;
  /** Achievement cents this rep already banked today — feeds the daily cap. */
  centsAlreadyToday: number;
  /** True while the rep is inside the ramp window. */
  isRampRep: boolean;
}

/**
 * Every rung this rep has cleared, in payout order (daily first — it is the one
 * they were chasing this afternoon), trimmed to the daily cents cap.
 *
 * Returning the FULL cleared set rather than only the newest is deliberate: the
 * caller books each one against a unique key, so re-running this after every
 * sale re-proposes rungs that are already paid and the database ignores them.
 * That is what makes the whole path safe to call on every single sale.
 */
export function achievementsCleared(
  counts: AchievementCounts,
  config: SalesAchievementConfig = DEFAULT_SALES_ACHIEVEMENT_CONFIG,
): AchievementAward[] {
  const cfg = normalizeAchievementConfig(config);
  if (!cfg.enabled) return [];
  if (cfg.excludeRampReps && counts?.isRampRep) return [];

  const daily = Math.max(0, Math.trunc(Number(counts?.dailySales) || 0));
  const career = Math.max(0, Math.trunc(Number(counts?.careerSales) || 0));

  const out: AchievementAward[] = [];
  for (const rung of cfg.daily) {
    if (daily >= rung.sales) {
      out.push({
        scope: "day", sales: rung.sales, amountCents: rung.rewardCents,
        reason: achievementReason("day", rung), key: `day:${rung.sales}`,
      });
    }
  }
  for (const rung of cfg.career) {
    if (career >= rung.sales) {
      out.push({
        scope: "career", sales: rung.sales, amountCents: rung.rewardCents,
        reason: achievementReason("career", rung), key: `career:${rung.sales}`,
      });
    }
  }

  if (cfg.maxCentsPerRepPerDay <= 0) return out;

  // The cap counts what is ALREADY banked today, so it holds across calls — not
  // just within one evaluation. A rung that does not fit is dropped whole; part
  // of a bonus is not a bonus.
  let budget = cfg.maxCentsPerRepPerDay - Math.max(0, Math.trunc(Number(counts?.centsAlreadyToday) || 0));
  const capped: AchievementAward[] = [];
  for (const award of out) {
    if (award.amountCents <= budget) {
      capped.push(award);
      budget -= award.amountCents;
    }
  }
  return capped;
}

export interface AchievementProgress {
  enabled: boolean;
  dailySales: number;
  careerSales: number;
  /** The daily rung being chased right now, or null once the day is topped. */
  nextDaily: AchievementRung | null;
  /** The career rung being chased, or null once topped out. */
  nextCareer: AchievementRung | null;
  /** Banked from this ladder today. */
  earnedTodayCents: number;
  /** Every rung, so the rep can see the whole ladder — a bonus nobody can
   *  recite motivates nobody. */
  daily: AchievementRung[];
  career: AchievementRung[];
  /** Null while the rep is on the ramp bonus instead. */
  headline: string | null;
}

export function achievementProgress(
  counts: AchievementCounts,
  config: SalesAchievementConfig = DEFAULT_SALES_ACHIEVEMENT_CONFIG,
): AchievementProgress {
  const cfg = normalizeAchievementConfig(config);
  const daily = Math.max(0, Math.trunc(Number(counts?.dailySales) || 0));
  const career = Math.max(0, Math.trunc(Number(counts?.careerSales) || 0));
  const nextDaily = cfg.daily.find(r => daily < r.sales) ?? null;
  const nextCareer = cfg.career.find(r => career < r.sales) ?? null;
  const onRamp = cfg.excludeRampReps && !!counts?.isRampRep;

  let headline: string | null = null;
  if (onRamp) headline = null;
  else if (nextDaily) {
    const need = nextDaily.sales - daily;
    headline = `${need} more sale${need === 1 ? "" : "s"} today for ${usd(nextDaily.rewardCents)}`;
  } else if (nextCareer) {
    const need = nextCareer.sales - career;
    headline = `${need} more career sale${need === 1 ? "" : "s"} for ${usd(nextCareer.rewardCents)}`;
  } else if (cfg.daily.length || cfg.career.length) {
    headline = "Every achievement bonus earned";
  }

  return {
    enabled: cfg.enabled && !onRamp && (cfg.daily.length > 0 || cfg.career.length > 0),
    dailySales: daily,
    careerSales: career,
    nextDaily,
    nextCareer,
    earnedTodayCents: Math.max(0, Math.trunc(Number(counts?.centsAlreadyToday) || 0)),
    daily: cfg.daily,
    career: cfg.career,
    headline,
  };
}

/** Integer cents → "$25" / "$27.50". */
export function usd(c: number): string {
  const v = Math.trunc(Number.isFinite(c) ? c : 0);
  const whole = Math.floor(Math.abs(v) / 100).toLocaleString("en-US");
  const rem = Math.abs(v) % 100;
  const body = rem === 0 ? `$${whole}` : `$${whole}.${String(rem).padStart(2, "0")}`;
  return v < 0 ? `-${body}` : body;
}

/** The most one rep can take from this ladder in a day, before the cap: every
 *  daily rung plus every career rung, which is the day a rep tops out both. */
export function achievementCeilingCents(config: SalesAchievementConfig = DEFAULT_SALES_ACHIEVEMENT_CONFIG): number {
  const cfg = normalizeAchievementConfig(config);
  const raw = [...cfg.daily, ...cfg.career].reduce((s, r) => s + r.rewardCents, 0);
  return cfg.maxCentsPerRepPerDay > 0 ? Math.min(raw, cfg.maxCentsPerRepPerDay) : raw;
}

/** Shared by the API and the admin form. Returns null when valid. */
export function validateAchievementConfig(input: unknown): string | null {
  const c = input as SalesAchievementConfig | null;
  if (!c || typeof c !== "object") return "The achievement ladder is missing.";
  if (!Array.isArray(c.daily) || !Array.isArray(c.career)) {
    return "The ladder needs a daily list and a career list.";
  }
  if (c.daily.length > 6 || c.career.length > 8) {
    return "Use at most 6 daily and 8 career rungs — a ladder nobody can recite is not an incentive.";
  }

  for (const [label, rungs, max] of [["daily", c.daily, 50], ["career", c.career, 10_000]] as const) {
    for (const r of rungs) {
      const sales = Number(r?.sales), reward = Number(r?.rewardCents);
      if (!Number.isInteger(sales) || sales < 1 || sales > max) {
        return `Each ${label} rung must be between 1 and ${max.toLocaleString("en-US")} sales.`;
      }
      if (!Number.isInteger(reward) || reward < 1) {
        return `Each ${label} rung must pay a whole number of cents above zero.`;
      }
      if (reward > 100_000) return "An achievement cannot pay more than $1,000.";
    }
  }

  const cap = Number(c.maxCentsPerRepPerDay);
  if (!Number.isInteger(cap) || cap < 0 || cap > 1_000_000) {
    return "The daily cap must be between $0 (uncapped) and $10,000.";
  }
  if (c.enabled !== false) {
    const norm = normalizeAchievementConfig(c);
    if (norm.daily.length === 0 && norm.career.length === 0) {
      return "Add at least one rung before turning this on.";
    }
    // A cap below the cheapest rung silently pays nothing — the worst possible
    // failure mode, because the ladder still renders and never fires.
    const cheapest = Math.min(...[...norm.daily, ...norm.career].map(r => r.rewardCents));
    if (norm.maxCentsPerRepPerDay > 0 && norm.maxCentsPerRepPerDay < cheapest) {
      return `The daily cap (${usd(norm.maxCentsPerRepPerDay)}) is below the smallest rung (${usd(cheapest)}), so nothing would ever pay.`;
    }
  }
  return null;
}
