// ── Which door next — the blend, pinned ───────────────────────────────────────
// shared/doorPriority.ts decides the order of a rep's whole day, so the two
// properties that make it safe to ship are the ones this file exists to hold:
//
//   1. AN EMPTY RANK MAP REPRODUCES THE OLD ORDER EXACTLY. Most doors are never
//      scored (the ranker pools confirmed-fresh leads only) and the fetch fails
//      outright in a dead zone. A feature that improves the ranked minority by
//      degrading everyone else is a net loss, so "no ranks" must be byte-for-
//      byte the previous nearest-first route.
//
//   2. THE DISCOUNT IS BOUNDED. A score buys at most DISCOUNT_MAX_M of extra
//      walking. Without this pinned, tuning the weights server-side could one
//      day march a rep across a subdivision, and nobody would find out until a
//      rep complained about their step count.
import { describe, expect, it } from "vitest";
import {
  DISCOUNT_MAX_M, SCORE_SATURATION, discountMeters, isOpenDoor, orderNextDoors,
  type DoorRank,
} from "@shared/doorPriority";
import { haversineMeters, type RoutablePin } from "@shared/knock";

const HOME = { lat: 34.9, lng: -79.9 };
const DEG_PER_METER = 1 / 111_195; // latitude degrees per metre — exact enough at street scale

function pin(id: number, metersNorth: number, extra: Partial<RoutablePin> = {}): RoutablePin {
  return {
    id,
    lat: HOME.lat + metersNorth * DEG_PER_METER,
    lng: HOME.lng,
    leadStatus: "prospect",
    ...extra,
  };
}

function ranks(entries: Record<number, number>): Map<number, DoorRank> {
  return new Map(Object.entries(entries).map(([id, score]) => [Number(id), { score, reasons: [] }]));
}

const NO_RANKS = new Map<number, DoorRank>();

describe("discountMeters", () => {
  it("is zero for an unranked door, so an unscored route is never penalised", () => {
    expect(discountMeters(undefined)).toBe(0);
    expect(discountMeters(null)).toBe(0);
    expect(discountMeters(0)).toBe(0);
  });

  it("saturates at DISCOUNT_MAX_M - a score can never buy more walking than that", () => {
    expect(discountMeters(SCORE_SATURATION)).toBe(DISCOUNT_MAX_M);
    expect(discountMeters(SCORE_SATURATION * 2)).toBe(DISCOUNT_MAX_M);
    // The engine's theoretical ceiling (40+20+15+15+10+5) still buys no more.
    expect(discountMeters(105)).toBe(DISCOUNT_MAX_M);
  });

  it("scales linearly below saturation", () => {
    expect(discountMeters(SCORE_SATURATION / 2)).toBeCloseTo(DISCOUNT_MAX_M / 2, 6);
  });

  it("treats hostile numbers as no discount rather than poisoning the sort", () => {
    // A NaN here would make every comparison false and the order arbitrary.
    expect(discountMeters(NaN)).toBe(0);
    // Infinity is a broken payload, not an infinitely good door: the safe read
    // is the one that cannot move a rep, so it buys nothing.
    expect(discountMeters(Infinity)).toBe(0);
    expect(discountMeters(-40)).toBe(0);
  });
});

describe("isOpenDoor", () => {
  it("counts never-knocked and nobody-home doors, and nothing else", () => {
    expect(isOpenDoor({ leadStatus: "prospect" })).toBe(true);
    expect(isOpenDoor({ leadStatus: "prospect", visited: 1, lastOutcome: "not_home" })).toBe(true);
    for (const status of ["sold", "not_interested", "interested", "follow_up"]) {
      expect(isOpenDoor({ leadStatus: status, visited: 1 })).toBe(false);
    }
  });
});

describe("orderNextDoors - with no ranks it is the old distance route", () => {
  it("orders purely by distance", () => {
    const pins = [pin(1, 300), pin(2, 50), pin(3, 150)];
    const r = orderNextDoors(HOME, pins, NO_RANKS);
    expect(r.hero?.id).toBe(2);
    expect(r.rest.map(p => p.id)).toEqual([3, 1]);
  });

  it("skips worked doors in favour of a farther open one, and counts only open doors", () => {
    const pins = [
      pin(1, 10, { leadStatus: "sold", visited: 1 }),
      pin(2, 20, { leadStatus: "not_interested", visited: 1 }),
      pin(3, 30, { leadStatus: "interested", visited: 1 }),
      pin(4, 300),
    ];
    const r = orderNextDoors(HOME, pins, NO_RANKS);
    expect(r.hero?.id).toBe(4);
    expect(r.openCount).toBe(1);
  });

  it("includes a not_home door - a not-home door is a revisit, not a dead end", () => {
    const notHome = pin(1, 50, { visited: 1, lastOutcome: "not_home" });
    const r = orderNextDoors(HOME, [notHome, pin(2, 200)], NO_RANKS);
    expect(r.hero?.id).toBe(1);
  });

  it("honours skip ids but still counts them in the route total", () => {
    const r = orderNextDoors(HOME, [pin(1, 50), pin(2, 200)], NO_RANKS, new Set([1]));
    expect(r.hero?.id).toBe(2);
    expect(r.openCount).toBe(2); // skipping a door does not remove it from the day
  });

  it("skips doors with unusable coordinates instead of crashing", () => {
    const bad: RoutablePin[] = [
      { id: 1, lat: NaN, lng: HOME.lng, leadStatus: "prospect" },
      { id: 2, lat: HOME.lat, lng: undefined as unknown as number, leadStatus: "prospect" },
    ];
    const r = orderNextDoors(HOME, [...bad, pin(3, 500)], NO_RANKS);
    // The unlocatable doors sort last (no distance), never first, and never throw.
    expect(r.hero?.id).toBe(3);
    expect(r.openCount).toBe(3);
  });

  it("returns a null hero when every door is worked, and on an empty list", () => {
    const allWorked = [pin(1, 10, { leadStatus: "sold", visited: 1 })];
    expect(orderNextDoors(HOME, allWorked, NO_RANKS).hero).toBeNull();
    expect(orderNextDoors(HOME, [], NO_RANKS).hero).toBeNull();
  });

  it("bounds the result to the limit while still counting the whole route", () => {
    const pins = Array.from({ length: 40 }, (_, i) => pin(i + 1, (i + 1) * 10));
    const r = orderNextDoors(HOME, pins, NO_RANKS, new Set(), 7);
    expect(r.hero?.id).toBe(1);
    expect(r.rest).toHaveLength(6);
    expect(r.openCount).toBe(40);
  });
});

describe("orderNextDoors - a score buys metres", () => {
  it("lets a hot door win the block it is on", () => {
    // 120 m away and hot, versus 40 m away and cold. A max score buys 250 m, so
    // the hot door's effective distance is negative and it goes first.
    const r = orderNextDoors(HOME, [pin(1, 40), pin(2, 120)], ranks({ 2: SCORE_SATURATION }));
    expect(r.hero?.id).toBe(2);
  });

  it("does NOT let a hot door pull a rep past the discount bound", () => {
    // The same maximum score against a door 400 m further: beyond the bound, so
    // the nearer door still wins. This is the safety property.
    const far = pin(2, 40 + DISCOUNT_MAX_M + 150);
    const r = orderNextDoors(HOME, [pin(1, 40), far], ranks({ 2: SCORE_SATURATION }));
    expect(r.hero?.id).toBe(1);
    // And the bound is exactly DISCOUNT_MAX_M, not "roughly": just inside it flips.
    const justInside = pin(3, 40 + DISCOUNT_MAX_M - 20);
    const flipped = orderNextDoors(HOME, [pin(1, 40), justInside], ranks({ 3: SCORE_SATURATION }));
    expect(flipped.hero?.id).toBe(3);
  });

  it("leaves unranked doors on their true distance, never demoting them", () => {
    // Door 1 is unranked and nearest; door 2 is ranked but modestly, and far
    // enough that its discount does not close the gap. Nearest still wins.
    const r = orderNextDoors(HOME, [pin(1, 100), pin(2, 400)], ranks({ 2: 15 }));
    expect(r.hero?.id).toBe(1);
  });

  it("orders two hot doors by their discounted distance, not by raw score", () => {
    // Door 1: 300 m, score 60 -> effective 50. Door 2: 20 m, score 6 -> effective ~-5.
    // The much-lower-scored door is still closer after the discount.
    const r = orderNextDoors(HOME, [pin(1, 300), pin(2, 20)], ranks({ 1: 60, 2: 6 }));
    expect(r.hero?.id).toBe(2);
    expect(r.ranked[0]?.effectiveMeters).toBeLessThan(r.ranked[1]!.effectiveMeters!);
  });

  it("reports the numbers behind the order so the card can explain itself", () => {
    const r = orderNextDoors(HOME, [pin(1, 120)], new Map([[1, { score: 30, reasons: ["lit 2h ago"] }]]));
    const view = r.ranked[0]!;
    expect(view.distanceMeters).toBeCloseTo(haversineMeters(HOME, pin(1, 120)), 3);
    expect(view.effectiveMeters).toBeCloseTo(view.distanceMeters! - DISCOUNT_MAX_M / 2, 3);
    expect(view.rank?.reasons).toEqual(["lit 2h ago"]);
  });

  it("is deterministic for identical doors - two reps see the same first door", () => {
    const a = orderNextDoors(HOME, [pin(9, 50), pin(2, 50), pin(5, 50)], NO_RANKS);
    const b = orderNextDoors(HOME, [pin(5, 50), pin(9, 50), pin(2, 50)], NO_RANKS);
    expect(a.hero?.id).toBe(2);
    expect(b.hero?.id).toBe(2);
    expect(a.rest.map(p => p.id)).toEqual(b.rest.map(p => p.id));
  });

  it("breaks a distance tie by opportunity score, then persisted lead score", () => {
    const byScore = orderNextDoors(HOME, [pin(1, 50), pin(2, 50)], ranks({ 2: 25 }));
    expect(byScore.hero?.id).toBe(2);
    const byLeadScore = orderNextDoors(
      HOME, [pin(1, 50, { leadScore: 10 }), pin(2, 50, { leadScore: 90 })], NO_RANKS,
    );
    expect(byLeadScore.hero?.id).toBe(2);
  });
});

describe("orderNextDoors - no GPS fix", () => {
  it("falls back to opportunity score, then lead score", () => {
    const pins = [
      pin(1, 10, { leadScore: 95 }),
      pin(2, 20, { leadScore: 5 }),
      pin(3, 30, { leadScore: 50 }),
    ];
    const r = orderNextDoors(null, pins, ranks({ 2: 40 }));
    // Door 2 has the only opportunity score, so it leads despite the worst
    // lead score; the rest fall back to lead score order.
    expect(r.hero?.id).toBe(2);
    expect(r.rest.map(p => p.id)).toEqual([1, 3]);
  });

  it("reports no distance rather than a fake zero", () => {
    const r = orderNextDoors(null, [pin(1, 10)], NO_RANKS);
    expect(r.ranked[0]?.distanceMeters).toBeNull();
    expect(r.ranked[0]?.effectiveMeters).toBeNull();
  });

  it("still returns doors when coordinates are missing entirely", () => {
    const noCoords: RoutablePin[] = [
      { id: 1, lat: null as unknown as number, lng: null as unknown as number, leadStatus: "prospect", leadScore: 20 },
      { id: 2, lat: null as unknown as number, lng: null as unknown as number, leadStatus: "prospect", leadScore: 80 },
    ];
    const r = orderNextDoors(null, noCoords, NO_RANKS);
    expect(r.hero?.id).toBe(2);
  });
});
