// ── Which door next — opportunity score meets walking distance ────────────────
// PURE and framework-free (like shared/knock.ts and shared/territory.ts). The
// single place that decides the ORDER of a rep's route, so Today and any future
// route surface can never disagree about what "next" means.
//
// The problem this solves. Today ranked doors by walking distance alone, which
// is a perfectly good answer to "which door is closest" and a poor answer to
// "which door should I knock". Meanwhile server/leadRanking.ts scores the same
// doors on signals no generic CRM can compute — a proven coming-soon →
// live flip, lit-age decay, confirmed-fresh density within 800m, expansion
// cluster yield — and the rep never saw any of it.
//
// THE MODEL: A SCORE BUYS METRES, IT DOES NOT BUY THE ROUTE.
//
// Naively sorting by score would march a rep across a subdivision for a door
// worth fifteen points, and walking is the most expensive thing they do all
// day. So a score never competes with distance directly. It buys a bounded
// DISCOUNT — "how much further I am willing to walk for this door" — and the
// route is then ordered by the discounted distance:
//
//     effectiveMeters = distanceMeters − discountMeters(score)
//
// A perfect score is worth DISCOUNT_MAX_M and not one metre more, so the worst
// case is bounded and explainable: the hottest door on the block can jump ahead
// of a door 250 m closer, and never ahead of one 300 m closer. That bound is
// the whole safety property, and it is pinned by a unit test.
//
// UNRANKED DOORS ARE NEUTRAL, NEVER PENALISED. rankLeads only pools leads with
// fresh_confirmed_at set (server/leadRanking.ts), so a rep whose book is mostly
// ordinary doors gets a sparse overlay. Those doors take a zero discount and
// keep their exact distance ordering — the feature can make a route better, and
// must never make it worse. With an EMPTY rank map this module reproduces the
// previous distance-only order door for door.
//
// WHAT THIS MODULE IS NOT. It does not decide whether a door is knockable —
// pinDisplayState owns that, and the caller must layer optimistic local state
// (client/src/lib/pendingKnockOverlay.ts) on top before calling in, so a door
// the rep dispositioned ten seconds ago can never be re-offered. Ranking only
// reorders and explains what already survived that filter.

import { haversineMeters, pinDisplayState, type LatLng, type RoutablePin } from "./knock";

/** The furthest a perfect opportunity score may pull a rep off the nearest
 *  door. Deliberately about a long block: enough that a proven newly-lit door
 *  wins the street it is on, small enough that it can never restructure a
 *  route. Raising this is a product decision, not a tuning knob — the bound is
 *  what makes the ordering defensible to a rep who asks "why that one?". */
export const DISCOUNT_MAX_M = 250;

/** Score at which the discount saturates. server/leadRanking.ts tops out near
 *  105 (40 recency + 20 newly-lit + 15 new-build + 15 density + 10 cluster +
 *  5 territory fit), but the signals that matter most — a fresh lit date plus
 *  the newly-lit flip — already clear 60 on their own, and a door should not
 *  need every bonus to be treated as hot. */
export const SCORE_SATURATION = 60;

/** A door the rep can still work: never knocked, or knocked with nobody home.
 *  Mirrors nearestUnworkedLead's rule so the two can never disagree about what
 *  is open. */
export function isOpenDoor(pin: { leadStatus: string; visited?: boolean | number | null; lastOutcome?: string | null }): boolean {
  const state = pinDisplayState(pin);
  return state === "unworked" || state === "not_home";
}

/**
 * Metres of walking a given opportunity score is worth. Linear to saturation,
 * then flat — a score of 120 buys exactly what a score of 60 buys.
 *
 * Non-finite and negative scores collapse to 0 rather than throwing or
 * producing a NaN that would poison every comparison in the sort below. A wire
 * payload is not a trusted number.
 */
export function discountMeters(score: number | null | undefined): number {
  // Non-finite includes Infinity, which is treated as no discount rather than
  // the maximum: an infinite score is a broken payload, not an infinitely good
  // door, and the conservative reading is the one that cannot move a rep.
  if (score == null || !Number.isFinite(score) || score <= 0) return 0;
  return DISCOUNT_MAX_M * Math.min(score / SCORE_SATURATION, 1);
}

/** The score + explanation server/leadRanking.ts computed for one door. */
export interface DoorRank {
  score: number;
  /** Human-readable, server-authored: "lit 43m ago", "newly lit - was coming soon". */
  reasons: string[];
}

export interface RankedDoorView<P> {
  pin: P;
  /** Straight-line metres from the rep, or null when there is no GPS fix. */
  distanceMeters: number | null;
  /** The ordering key actually used. Lower is better. */
  effectiveMeters: number | null;
  rank: DoorRank | null;
}

export interface NextDoorsResult<P> {
  hero: P | null;
  rest: P[];
  /** Every open door the rep can see, including skipped ones — the route total. */
  openCount: number;
  /** hero + rest, with the numbers behind the order, for rendering "why". */
  ranked: RankedDoorView<P>[];
}

interface Candidate<P> {
  pin: P;
  distance: number | null;
  effective: number;
  score: number;
  leadScore: number;
  id: number;
}

/**
 * Order a rep's open doors: nearest first, with hot doors buying their way
 * forward by at most DISCOUNT_MAX_M.
 *
 * Keeps the single-pass bounded top-N insertion Today already used — the screen
 * shows a hero and six rows, so only `limit` doors ever need ordering, and this
 * runs on every GPS fix and every skip tap. No intermediate arrays, no
 * O(n log n) sort over every pin the rep can see.
 *
 * With no GPS fix (`from` null) there is no distance to discount, so doors are
 * ordered by opportunity score and then by the persisted lead score — which is
 * strictly better than the previous lead-score-only fallback, and still fully
 * deterministic for tests.
 */
export function orderNextDoors<P extends RoutablePin>(
  from: LatLng | null,
  pins: readonly P[],
  rankById: ReadonlyMap<number, DoorRank>,
  skipIds: ReadonlySet<number> = new Set(),
  limit = 7,
): NextDoorsResult<P> {
  const top: Candidate<P>[] = [];
  let openCount = 0;
  const hasFix = from != null;

  // Lower is better in every branch, so one insertion rule serves both the
  // located and unlocated orders.
  const better = (a: Candidate<P>, b: Candidate<P>): boolean => {
    if (a.effective !== b.effective) return a.effective < b.effective;
    // Same effective distance: prefer the genuinely closer door, then the
    // better-scored one, then the lower id. Fully deterministic — two reps
    // opening the same route must see the same first door.
    const ad = a.distance ?? 0, bd = b.distance ?? 0;
    if (ad !== bd) return ad < bd;
    if (a.score !== b.score) return a.score > b.score;
    if (a.leadScore !== b.leadScore) return a.leadScore > b.leadScore;
    return a.id < b.id;
  };

  for (const pin of pins) {
    if (!isOpenDoor(pin)) continue;
    openCount += 1;
    if (skipIds.has(pin.id)) continue;

    const rank = rankById.get(pin.id) ?? null;
    const score = rank?.score ?? 0;
    const located = hasFix && Number.isFinite(pin.lat) && Number.isFinite(pin.lng);
    const distance = located ? haversineMeters(from!, pin) : null;
    // Two orderings, never mixed — the comparator below is a single "smaller is
    // better" rule, so both branches must produce numbers on the SAME scale.
    //
    //   WITH a fix, the scale is metres. A door whose coordinates are missing
    //   or corrupt cannot be routed, so it sorts LAST rather than competing.
    //   (It stays in the list: it is still a real door, just not a routable
    //   one. Giving it 0 here would put every broken row ahead of the whole
    //   route, which is the bug this comment exists to prevent recurring.)
    //
    //   WITHOUT a fix there are no metres at all, so every door uses the
    //   negated score scale: opportunity score dominates, persisted lead score
    //   breaks ties, and a door with neither sorts last.
    const effective = hasFix
      ? (distance != null ? distance - discountMeters(score) : Number.POSITIVE_INFINITY)
      : -(score * 1000 + (pin.leadScore ?? 0));

    const candidate: Candidate<P> = {
      pin, distance, effective, score, leadScore: pin.leadScore ?? 0, id: pin.id,
    };
    if (top.length === limit && !better(candidate, top[limit - 1])) continue;
    let i = top.length;
    while (i > 0 && better(candidate, top[i - 1])) i -= 1;
    top.splice(i, 0, candidate);
    if (top.length > limit) top.pop();
  }

  const ranked: RankedDoorView<P>[] = top.map((c) => ({
    pin: c.pin,
    distanceMeters: c.distance,
    effectiveMeters: c.distance != null ? c.effective : null,
    rank: rankById.get(c.id) ?? null,
  }));

  return {
    hero: top[0]?.pin ?? null,
    rest: top.slice(1).map((c) => c.pin),
    openCount,
    ranked,
  };
}
