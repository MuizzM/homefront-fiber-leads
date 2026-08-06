// ── Knock milestones — the standing bonus that pays for working ──────────────
// A SPIFF campaign is a manager-launched contest with an end date. This is the
// other half: a ladder that is ALWAYS on, needs nobody to launch it, and pays
// into the rep's commission statement the moment they cross a rung.
//
// "Hit 100 verified doors this week → $25 on your check" is a promise a rep can
// hold in their head on a Wednesday afternoon when nothing is closing. That is
// the whole point — a rep who has sold nothing all week still has something to
// chase, and the thing they chase is the input that produces sales.
//
// ── THE COUNTER IS DISTINCT VERIFIED DOORS, AND THAT IS THE WHOLE DESIGN ─────
//
// Paying per logged knock pays for taps on a screen. Two exploits kill this
// feature on day one if the counter is naive:
//
//   1. Standing at one door and tapping 100 times. Defeated by counting
//      DISTINCT leads — the hundredth tap on the same house is worth zero.
//   2. Logging knocks from the couch. Defeated by counting only knocks the
//      server's own geo check rated `verified` — the rep's phone is evidence,
//      never authority (see shared/geoVerify.ts; distance and verdict are
//      computed server-side and cannot be forged by the client).
//
// Both filters live in the SQL that feeds this module. This file is pure: it
// takes a door count and decides what it is worth.
//
// ── RUNGS ARE INDEPENDENT, NOT REPLACEMENTS ─────────────────────────────────
// Crossing 250 pays the 250 rung on top of the 100 rung already banked. The
// alternative — the ladder pays only the highest rung reached, minus what you
// already got — is arithmetically similar and psychologically worse: a rep who
// watches "$25 earned" turn into "$25 earned" again at the next rung reads it as
// a system that took something back.

import { usd } from "./moneyFormat";

export interface MilestoneRung {
  /** Distinct verified doors required in the period. */
  doors: number;
  /** Flat award, integer cents. Money is never a float. */
  rewardCents: number;
}

export type MilestonePeriod = "week" | "day";

export interface MilestoneLadder {
  enabled: boolean;
  period: MilestonePeriod;
  /** Ascending by `doors`. Normalised on read so a hand-edited config cannot
   *  produce a ladder that pays out of order. */
  rungs: MilestoneRung[];
}

// The default ladder. A committed rep runs 60–100 doors a day, so 100 in a week
// is a floor that almost anyone who actually goes out clears — that is
// deliberate. The bottom rung exists to pull the bottom half of the board off
// the couch, not to reward the top. The top rung is a real week's grind.
export const DEFAULT_MILESTONE_LADDER: MilestoneLadder = {
  enabled: true,
  period: "week",
  rungs: [
    { doors: 100, rewardCents: 2_500 },
    { doors: 250, rewardCents: 5_000 },
    { doors: 500, rewardCents: 10_000 },
  ],
};

const cents = (n: unknown) => Math.max(0, Math.trunc(Number(n) || 0));

/** Ascending, de-duplicated, positive. A config with two rungs at 100 doors, or
 *  a 250-door rung listed before the 100, would otherwise pay in an order no
 *  rep could predict. */
export function normalizeLadder(ladder: MilestoneLadder): MilestoneLadder {
  const seen = new Set<number>();
  const rungs = (ladder.rungs ?? [])
    .map(r => ({ doors: Math.trunc(Number(r?.doors) || 0), rewardCents: cents(r?.rewardCents) }))
    .filter(r => r.doors > 0 && r.rewardCents > 0)
    .filter(r => (seen.has(r.doors) ? false : (seen.add(r.doors), true)))
    .sort((a, b) => a.doors - b.doors);
  return {
    enabled: ladder.enabled !== false,
    period: ladder.period === "day" ? "day" : "week",
    rungs,
  };
}

/** Every rung the rep has cleared at this door count. */
export function rungsCleared(ladder: MilestoneLadder, doors: number): MilestoneRung[] {
  const n = Math.max(0, Math.trunc(Number(doors) || 0));
  return normalizeLadder(ladder).rungs.filter(r => n >= r.doors);
}

/** Total the ladder owes at this door count, before idempotency. */
export function ladderValueAt(ladder: MilestoneLadder, doors: number): number {
  return rungsCleared(ladder, doors).reduce((sum, r) => sum + r.rewardCents, 0);
}

/** The most a single rep can take from this ladder in one period — the number a
 *  manager needs before turning it on, and the one nobody computes by hand. */
export function ladderCeilingCents(ladder: MilestoneLadder): number {
  return normalizeLadder(ladder).rungs.reduce((sum, r) => sum + r.rewardCents, 0);
}

/** The rung being chased right now, or null once the ladder is topped out. */
export function nextRung(ladder: MilestoneLadder, doors: number): MilestoneRung | null {
  const n = Math.max(0, Math.trunc(Number(doors) || 0));
  return normalizeLadder(ladder).rungs.find(r => n < r.doors) ?? null;
}

export interface MilestoneProgress {
  /** Distinct verified doors so far this period. */
  doors: number;
  /** Doors needed for the next rung; 0 once topped out. */
  target: number;
  /** Doors still to go; 0 once topped out. */
  remaining: number;
  /** 0–100 toward the NEXT rung, measured from the previous rung — not from
   *  zero. A rep at 240 of 250 should see a nearly-full bar, not 96% of a bar
   *  that has been creeping since Monday. */
  pct: number;
  /** What the next rung pays; 0 once topped out. */
  nextRewardCents: number;
  /** Banked this period. */
  earnedCents: number;
  toppedOut: boolean;
  /** One line the rep reads. Concrete, second-person, never a slogan. */
  headline: string;
}

/**
 * What the rep's card says. Derived from the SAME ladder the award logic reads,
 * so the bar cannot promise a rung the ledger then refuses to pay.
 */
export function milestoneProgress(
  ladder: MilestoneLadder, doors: number, period: MilestonePeriod = ladder.period,
): MilestoneProgress {
  const norm = normalizeLadder(ladder);
  const n = Math.max(0, Math.trunc(Number(doors) || 0));
  const cleared = norm.rungs.filter(r => n >= r.doors);
  const earnedCents = cleared.reduce((s, r) => s + r.rewardCents, 0);
  const next = norm.rungs.find(r => n < r.doors) ?? null;
  const when = period === "day" ? "today" : "this week";

  if (!next) {
    return {
      doors: n, target: 0, remaining: 0, pct: 100, nextRewardCents: 0,
      earnedCents, toppedOut: true,
      headline: norm.rungs.length
        ? `${n} verified doors ${when} — every bonus earned`
        : `${n} verified doors ${when}`,
    };
  }

  // Measure the bar from the rung just cleared, so each rung is its own climb.
  const floor = cleared.length ? cleared[cleared.length - 1].doors : 0;
  const span = Math.max(1, next.doors - floor);
  const pct = Math.max(0, Math.min(100, Math.round(((n - floor) / span) * 100)));
  const remaining = next.doors - n;

  return {
    doors: n, target: next.doors, remaining, pct,
    nextRewardCents: next.rewardCents, earnedCents, toppedOut: false,
    headline: `${remaining} more verified door${remaining === 1 ? "" : "s"} ${when} for ${usd(next.rewardCents)}`,
  };
}

/** Integer cents → "$25" / "$27.50". No float ever reaches a rendered digit.
 *  The one definition lives in ./moneyFormat (dependency-free, see its header
 *  for the bundle rationale). Re-exported here so existing importers keep
 *  working — the import flows INTO this module, never out of it. */
export { usd };

/** The ledger line, which is also what the rep reads on their pay statement six
 *  weeks later. It has to say what they DID, not which internal rung fired. */
export function milestoneReason(rung: MilestoneRung, period: MilestonePeriod): string {
  return `${rung.doors} verified doors ${period === "day" ? "in a day" : "in a week"}`;
}

/** Shared by the API and the admin form, so the server and the UI agree on what
 *  a sane ladder is. Returns null when valid. */
export function validateLadder(input: unknown): string | null {
  const l = input as MilestoneLadder | null;
  if (!l || typeof l !== "object") return "The ladder is missing.";
  if (l.period !== "week" && l.period !== "day") return "The period must be a week or a day.";
  if (!Array.isArray(l.rungs)) return "The ladder needs a list of milestones.";
  if (l.rungs.length > 8) return "Use at most 8 milestones — a ladder nobody can recite is not an incentive.";

  for (const r of l.rungs) {
    const doors = Number(r?.doors), reward = Number(r?.rewardCents);
    if (!Number.isInteger(doors) || doors < 1 || doors > 5_000) {
      return "Each milestone must be between 1 and 5,000 doors.";
    }
    if (!Number.isInteger(reward) || reward < 1) {
      return "Each milestone must pay a whole number of cents above zero.";
    }
    // A four-figure milestone bonus is a fat finger, not an incentive — the same
    // ceiling the campaign validator enforces, for the same reason.
    if (reward > 100_000) return "A milestone cannot pay more than $1,000.";
  }
  // Enabling a ladder whose rungs collapse to nothing would silently do nothing.
  if (l.enabled !== false && normalizeLadder(l).rungs.length === 0) {
    return "Add at least one milestone before turning this on.";
  }
  return null;
}
