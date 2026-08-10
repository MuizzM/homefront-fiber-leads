// Ranking, territory grouping and route ordering.
//
// Every test injects nowMs, so none of this drifts as the clock moves - the
// repo has been bitten before by tests that only pass outside a midnight
// window (see the CI time-flake notes).
import { describe, expect, it } from "vitest";
import {
  BUILD_RANK_WEIGHTS,
  PROXIMITY_RADIUS_M,
  groupIntoTerritories,
  haversineApproxM,
  rankBuilds,
  routeOrder,
  scoreBuildLead,
  type BuildRankSignals,
} from "@shared/kineticBuildRanking";

const NOW = Date.parse("2026-08-10T12:00:00Z");
const daysAgo = (n: number) => NOW - n * 86_400_000;

const baseline = (over: Partial<BuildRankSignals> = {}): BuildRankSignals => ({
  confidence: "high",
  firstConfirmedAtMs: daysAgo(1),
  lastVerifiedAtMs: daysAgo(1),
  nowMs: NOW,
  ...over,
});

describe("scoring", () => {
  it("puts serviceability confidence ahead of everything else", () => {
    const high = scoreBuildLead(baseline({ confidence: "high" })).score;
    const low = scoreBuildLead(baseline({ confidence: "low" })).score;
    expect(high - low).toBeGreaterThanOrEqual(BUILD_RANK_WEIGHTS.CONFIDENCE_MAX * 0.7);
  });

  it("decays the 2026 recency bonus smoothly, with no cliff at the half-life", () => {
    const at = (days: number) => scoreBuildLead(baseline({ firstConfirmedAtMs: daysAgo(days) })).components.recency;
    expect(at(0)).toBeCloseTo(BUILD_RANK_WEIGHTS.RECENCY_MAX, 0);
    expect(at(30)).toBeCloseTo(BUILD_RANK_WEIGHTS.RECENCY_MAX / 2, 0);
    expect(at(60)).toBeCloseTo(BUILD_RANK_WEIGHTS.RECENCY_MAX / 4, 0);
    // No step: 29 and 31 days differ by well under a point.
    expect(Math.abs(at(29) - at(31))).toBeLessThan(1);
  });

  it("penalises a stale verification even when the confirmation was recent", () => {
    const fresh = scoreBuildLead(baseline({ lastVerifiedAtMs: daysAgo(2) }));
    const stale = scoreBuildLead(baseline({ lastVerifiedAtMs: daysAgo(200) }));
    expect(fresh.score).toBeGreaterThan(stale.score);
    expect(stale.explanation.join(" ")).toContain("not re-verified in over 90 days");
  });

  it("says so when an address was never verified", () => {
    expect(scoreBuildLead(baseline({ lastVerifiedAtMs: null })).explanation).toContain("Never verified");
  });

  it("rewards confirmed neighbours up to a cap", () => {
    const at = (n: number) => scoreBuildLead(baseline({ nearbyConfirmedCount: n })).components.proximity;
    expect(at(0)).toBe(0);
    expect(at(4)).toBeCloseTo(BUILD_RANK_WEIGHTS.PROXIMITY_MAX / 2, 1);
    expect(at(8)).toBeCloseTo(BUILD_RANK_WEIGHTS.PROXIMITY_MAX, 1);
    expect(at(50)).toBeCloseTo(BUILD_RANK_WEIGHTS.PROXIMITY_MAX, 1);   // capped
  });

  it("values a phone number above the other contact channels", () => {
    const phone = scoreBuildLead(baseline({ hasPhone: true })).components.contact;
    const email = scoreBuildLead(baseline({ hasEmail: true })).components.contact;
    expect(phone).toBeGreaterThan(email);
  });

  it("rewards a provable quarter", () => {
    const proven = scoreBuildLead(baseline({ quarterProven: true })).score;
    const not = scoreBuildLead(baseline({ quarterProven: false })).score;
    expect(proven - not).toBe(BUILD_RANK_WEIGHTS.QUARTER_PROVEN_BONUS);
  });
});

describe("previous outreach is a decay, not a filter", () => {
  it("demotes a door knocked yesterday", () => {
    const knocked = scoreBuildLead(baseline({ knockCount: 2, lastKnockedAtMs: daysAgo(1) }));
    const untouched = scoreBuildLead(baseline());
    expect(knocked.score).toBeLessThan(untouched.score);
    expect(knocked.explanation.join(" ")).toContain("Knocked 2 times recently");
  });

  it("restores the door once the cooldown has passed", () => {
    const cooled = scoreBuildLead(baseline({ knockCount: 2, lastKnockedAtMs: daysAgo(BUILD_RANK_WEIGHTS.OUTREACH_COOLDOWN_DAYS + 1) }));
    expect(cooled.score).toBe(scoreBuildLead(baseline()).score);
  });

  it("never drives a score below zero", () => {
    const battered = scoreBuildLead(baseline({
      confidence: "none", firstConfirmedAtMs: null, lastVerifiedAtMs: null,
      knockCount: 99, lastKnockedAtMs: NOW,
    }));
    expect(battered.score).toBe(0);
  });
});

describe("rankBuilds ordering", () => {
  it("sorts highest first and breaks ties on id for a stable list", () => {
    const pool = [
      { id: 3, ...baseline({ confidence: "low" }) },
      { id: 1, ...baseline({ confidence: "high" }) },
      { id: 2, ...baseline({ confidence: "high" }) },
    ];
    expect(rankBuilds(pool, NOW).map((r) => r.id)).toEqual([1, 2, 3]);
    // Same input, same order, every time.
    expect(rankBuilds(pool, NOW).map((r) => r.id)).toEqual(rankBuilds(pool, NOW).map((r) => r.id));
  });
});

describe("distance", () => {
  it("measures roughly 111km per degree of latitude", () => {
    const d = haversineApproxM({ id: 1, lat: 35.0, lng: -80.0 }, { id: 2, lat: 36.0, lng: -80.0 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it("shortens a degree of longitude at latitude 35", () => {
    const d = haversineApproxM({ id: 1, lat: 35.0, lng: -80.0 }, { id: 2, lat: 35.0, lng: -79.0 });
    expect(d).toBeGreaterThan(89_000);
    expect(d).toBeLessThan(93_000);
  });
});

describe("territory grouping", () => {
  /** Two tight neighbourhoods about 9km apart - far beyond any walk. */
  const cluster = (baseLat: number, baseLng: number, startId: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: startId + i,
      lat: baseLat + (i % 5) * 0.0008,
      lng: baseLng + Math.floor(i / 5) * 0.0008,
    }));

  const NEIGHBOURHOOD_A = cluster(35.400, -80.600, 1, 25);
  const NEIGHBOURHOOD_B = cluster(35.480, -80.600, 101, 25);

  it("keeps two distant neighbourhoods in separate territories", () => {
    const groups = groupIntoTerritories([...NEIGHBOURHOOD_A, ...NEIGHBOURHOOD_B], { maxDoors: 200, maxRadiusM: 1_200 });
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      const ids = new Set(group.doors);
      const fromA = NEIGHBOURHOOD_A.filter((d) => ids.has(d.id)).length;
      const fromB = NEIGHBOURHOOD_B.filter((d) => ids.has(d.id)).length;
      // No territory straddles the gap.
      expect(fromA === 0 || fromB === 0).toBe(true);
    }
  });

  it("respects the door cap", () => {
    const groups = groupIntoTerritories(NEIGHBOURHOOD_A, { maxDoors: 10, maxRadiusM: 1_200 });
    expect(groups.every((g) => g.doors.length <= 10)).toBe(true);
    expect(groups.reduce((n, g) => n + g.doors.length, 0)).toBe(NEIGHBOURHOOD_A.length);
  });

  it("keeps every territory inside the radius limit", () => {
    const groups = groupIntoTerritories([...NEIGHBOURHOOD_A, ...NEIGHBOURHOOD_B], { maxDoors: 200, maxRadiusM: 1_200 });
    expect(groups.every((g) => g.radiusM <= 1_200)).toBe(true);
  });

  it("assigns every door exactly once", () => {
    const doors = [...NEIGHBOURHOOD_A, ...NEIGHBOURHOOD_B];
    const groups = groupIntoTerritories(doors, { maxDoors: 7, maxRadiusM: 1_200 });
    const assigned = groups.flatMap((g) => g.doors).sort((a, b) => a - b);
    expect(assigned).toEqual(doors.map((d) => d.id).sort((a, b) => a - b));
  });

  it("isolates a lone outlier rather than stretching a territory to reach it", () => {
    const outlier = { id: 999, lat: 36.9, lng: -81.9 };
    const groups = groupIntoTerritories([...NEIGHBOURHOOD_A, outlier], { maxDoors: 200, maxRadiusM: 1_200 });
    const solo = groups.find((g) => g.doors.includes(999))!;
    expect(solo.doors).toEqual([999]);
  });

  it("is deterministic", () => {
    const a = groupIntoTerritories(NEIGHBOURHOOD_A, { maxDoors: 8, maxRadiusM: 1_200 });
    const b = groupIntoTerritories(NEIGHBOURHOOD_A, { maxDoors: 8, maxRadiusM: 1_200 });
    expect(a).toEqual(b);
  });

  it("handles an empty input", () => {
    expect(groupIntoTerritories([])).toEqual([]);
  });
});

describe("route ordering", () => {
  it("visits every door exactly once", () => {
    const doors = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, lat: 35.4 + i * 0.001, lng: -80.6 }));
    expect(routeOrder(doors).sort((a, b) => a - b)).toEqual(doors.map((d) => d.id));
  });

  it("walks a straight street in order rather than zig-zagging", () => {
    // Ten doors down one side of a street. A nearest-neighbour walk from the
    // middle should never jump back and forth across the whole run.
    const doors = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, lat: 35.4 + i * 0.0005, lng: -80.6 }));
    const order = routeOrder(doors);
    const byId = new Map(doors.map((d) => [d.id, d]));
    let total = 0;
    for (let i = 1; i < order.length; i++) total += haversineApproxM(byId.get(order[i - 1])!, byId.get(order[i])!);
    // The street is ~500m end to end; an optimal walk from the middle is under
    // 800m. A zig-zag would be several times that.
    expect(total).toBeLessThan(900);
  });

  it("short-circuits trivial routes", () => {
    expect(routeOrder([])).toEqual([]);
    expect(routeOrder([{ id: 5, lat: 35, lng: -80 }])).toEqual([5]);
  });

  it("keeps proximity meaningful at the ranking radius", () => {
    expect(PROXIMITY_RADIUS_M).toBe(800);
  });
});
