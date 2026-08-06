// ── "Here's what today is still worth" ──────────────────────────────────────
//
// A rep at 2 PM knows what they have banked. What they do not know — and what
// actually decides whether they work the next two hours — is what is still ON
// THE TABLE if they push.
//
// ── THE RULE THAT MAKES THIS TRUSTWORTHY ───────────────────────────────────
//
// Only count money the rep can still reach TODAY, from where they are standing
// RIGHT NOW. A figure that includes a rung they cannot physically walk to, or a
// campaign whose cutoff has passed, is a lie — and a motivation number a rep
// catches lying once is worse than no number at all, because it discredits every
// other number on the screen.
//
// So every contributor here is filtered by reachability, and the card says
// "still reachable" rather than "possible".
//
// PURE: no clock beyond the nowMs passed in, no database.

import { usd } from "./moneyFormat";

export interface UpsideInput {
  /** Banked today, already earned. Integer cents. */
  earnedTodayCents: number;
  /** Doors the rep has verified today — drives what's still walkable. */
  verifiedDoorsToday: number;
  /** Their own recent median doors/day. The realism anchor. */
  medianDoorsPerDay: number;
  /** Minutes left in the shift. 0 → nothing is reachable. */
  minutesLeftInShift: number;

  /** Live campaigns/challenges the rep has NOT yet met, with what they pay. */
  openRewards: Array<{
    label: string;
    rewardCents: number;
    /** Doors still needed (0 if the remaining work is a sale). */
    doorsNeeded: number;
    /** True when it also needs a sale the rep has not made. */
    needsSale: boolean;
    /** Minutes until it closes; Infinity for no deadline. */
    minutesLeft: number;
  }>;

  /** Commission on one more sale, if they close one. */
  perSaleCommissionCents: number;
}

export interface UpsideItem {
  label: string;
  amountCents: number;
  /** What has to happen. Short — it goes on one line. */
  requirement: string;
}

export interface DailyUpside {
  earnedTodayCents: number;
  /** Everything still reachable, summed. */
  reachableCents: number;
  /** earned + reachable — the "could finish on" number. */
  potentialTodayCents: number;
  items: UpsideItem[];
  /** The single best next move, or null when the day is done. */
  headline: string;
  subline: string;
}

/** Doors a rep can realistically still work, from their own pace. Deliberately
 *  conservative — overpromising here is how the whole card loses credibility. */
export function doorsStillWalkable(medianDoorsPerDay: number, minutesLeftInShift: number): number {
  const perDay = Math.max(1, Math.trunc(Number(medianDoorsPerDay) || 0) || 60);
  // An 8-hour shift is the denominator. A rep who normally does 60 doors a day
  // is credited with ~7.5/hour, not the 20/hour a burst rate would imply.
  const perMinute = perDay / (8 * 60);
  return Math.max(0, Math.floor(perMinute * Math.max(0, minutesLeftInShift)));
}

const cents = (n: unknown) => Math.max(0, Math.trunc(Number(n) || 0));

export function dailyUpside(input: UpsideInput, _nowMs?: number): DailyUpside {
  const walkable = doorsStillWalkable(input.medianDoorsPerDay, input.minutesLeftInShift);
  const items: UpsideItem[] = [];

  for (const r of input.openRewards) {
    const doorsNeeded = Math.max(0, Math.trunc(Number(r.doorsNeeded) || 0));
    // Unreachable on either axis → excluded entirely, not shown greyed out. A
    // list of things you cannot have is demotivating, which is the opposite of
    // this card's job.
    if (r.minutesLeft <= 0) continue;
    if (doorsNeeded > walkable) continue;
    // The door half also has to fit inside the reward's OWN deadline, not just
    // the shift — a 40-door campaign closing in 20 minutes is not reachable
    // however much of the shift is left.
    if (Number.isFinite(r.minutesLeft)
        && doorsNeeded > doorsStillWalkable(input.medianDoorsPerDay, r.minutesLeft)) continue;

    items.push({
      label: r.label,
      amountCents: cents(r.rewardCents),
      requirement: r.needsSale && doorsNeeded > 0
        ? `${doorsNeeded} more doors and a sale`
        : r.needsSale ? "one more sale"
        : `${doorsNeeded} more doors`,
    });
  }

  // One more sale is always reachable while the shift is running — it is the one
  // outcome that does not depend on how many doors are left, because the next
  // door might be it.
  if (input.minutesLeftInShift > 0 && cents(input.perSaleCommissionCents) > 0) {
    items.push({
      label: "One more sale",
      amountCents: cents(input.perSaleCommissionCents),
      requirement: "close one",
    });
  }

  items.sort((a, b) => b.amountCents - a.amountCents);
  const reachableCents = items.reduce((s, i) => s + i.amountCents, 0);
  const earned = cents(input.earnedTodayCents);

  let headline: string, subline: string;
  if (input.minutesLeftInShift <= 0) {
    headline = `${usd(earned)} today`;
    subline = "Shift's done. Nice work.";
  } else if (!items.length) {
    headline = `${usd(earned)} today`;
    subline = "Nothing else on the clock — every sale still pays.";
  } else {
    const best = items[0]!;
    headline = `${usd(earned + reachableCents)} if you finish it`;
    // Lead with the single biggest reachable thing and exactly what it takes.
    subline = `${usd(best.amountCents)} more for ${best.requirement}.`;
  }

  return {
    earnedTodayCents: earned,
    reachableCents,
    potentialTodayCents: earned + reachableCents,
    items,
    headline,
    subline,
  };
}

/** The one definition lives in ./moneyFormat (dependency-free, see its header
 *  for the bundle rationale). Re-exported here so existing importers keep
 *  working — the import flows INTO this module, never out of it. */
export { usd };
