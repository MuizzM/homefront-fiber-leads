import { describe, expect, it } from "vitest";
import {
  DENSITY_RADIUS_M,
  NEW_BUILD_CONFIDENCE_FACTOR,
  parseDbTime,
  RANK_WEIGHTS,
  scoreLead,
  type LeadRankSignals,
} from "../../server/leadRanking";

// Deterministic clock — every expectation is computed against this instant.
const NOW = Date.parse("2026-07-17T12:00:00.000Z");
const minutesAgo = (min: number) => new Date(NOW - min * 60_000).toISOString();

const base = (overrides: Partial<LeadRankSignals> = {}): LeadRankSignals => ({
  freshConfirmedAt: null,
  ...overrides,
});

describe("parseDbTime", () => {
  it("reads ISO and SQLite formats as the same UTC instant", () => {
    expect(parseDbTime("2026-07-16 20:21:14")).toBe(Date.parse("2026-07-16T20:21:14Z"));
    expect(parseDbTime("2026-07-16T20:21:14.000Z")).toBe(Date.parse("2026-07-16T20:21:14Z"));
    expect(parseDbTime(null)).toBeNull();
    expect(parseDbTime("not a date")).toBeNull();
  });
});

describe("scoreLead — recency", () => {
  it("gives a just-lit lead the full recency weight and a 'lit just now' reason", () => {
    const { score, reasons } = scoreLead(base({ freshConfirmedAt: minutesAgo(0) }), NOW);
    expect(score).toBeCloseTo(RANK_WEIGHTS.RECENCY_MAX, 0);
    expect(reasons).toContain("lit just now");
  });

  it("halves recency points at exactly one half-life", () => {
    const fresh = scoreLead(base({ freshConfirmedAt: minutesAgo(0) }), NOW).score;
    const halfLife = scoreLead(base({ freshConfirmedAt: minutesAgo(RANK_WEIGHTS.RECENCY_HALF_LIFE_MIN) }), NOW).score;
    expect(halfLife).toBeCloseTo(fresh / 2, 1);
  });

  it("formats the age into the reason ('lit 43m ago')", () => {
    expect(scoreLead(base({ freshConfirmedAt: minutesAgo(43) }), NOW).reasons).toContain("lit 43m ago");
    expect(scoreLead(base({ freshConfirmedAt: minutesAgo(3 * 60) }), NOW).reasons).toContain("lit 3h ago");
    expect(scoreLead(base({ freshConfirmedAt: minutesAgo(2 * 1440) }), NOW).reasons).toContain("lit 2d ago");
  });

  it("falls back to createdAt with an 'added' reason when never confirmed fresh", () => {
    const { reasons } = scoreLead(base({ createdAt: minutesAgo(10) }), NOW);
    expect(reasons).toContain("added 10m ago");
  });

  it("no timestamps and no signals → zero score, zero reasons", () => {
    expect(scoreLead(base(), NOW)).toEqual({ score: 0, reasons: [] });
  });
});

describe("scoreLead — newly lit (the coming-soon flip)", () => {
  it("awards the flat bonus and names the prior state", () => {
    const comingSoon = scoreLead(base({ newlyLit: { priorState: "coming_soon" } }), NOW);
    expect(comingSoon.score).toBe(RANK_WEIGHTS.NEWLY_LIT_BONUS);
    expect(comingSoon.reasons).toContain("newly lit — was coming soon");

    const unavailable = scoreLead(base({ newlyLit: { priorState: "unavailable" } }), NOW);
    expect(unavailable.reasons).toContain("newly lit — was unavailable");
  });
});

describe("scoreLead — new-build confidence", () => {
  it("scales the bonus by source confidence", () => {
    const authoritative = scoreLead(base({ newBuild: { buildStage: "addressed", confidence: "authoritative" } }), NOW);
    expect(authoritative.score).toBe(RANK_WEIGHTS.NEW_BUILD_MAX * NEW_BUILD_CONFIDENCE_FACTOR.authoritative);
    expect(authoritative.reasons).toContain("new build (authoritative)");

    const observed = scoreLead(base({ newBuild: { buildStage: "addressed", confidence: "observed" } }), NOW);
    expect(observed.score).toBe(RANK_WEIGHTS.NEW_BUILD_MAX * NEW_BUILD_CONFIDENCE_FACTOR.observed);
    expect(observed.score).toBeLessThan(authoritative.score);
  });
});

describe("scoreLead — nearby green density", () => {
  it("scales with neighbor count and saturates at the cap", () => {
    const three = scoreLead(base({ nearbyFreshCount: 3 }), NOW);
    expect(three.score).toBeCloseTo(RANK_WEIGHTS.DENSITY_MAX * 3 / RANK_WEIGHTS.DENSITY_NEIGHBOR_CAP, 5);
    expect(three.reasons).toContain(`3 fresh leads within ${DENSITY_RADIUS_M}m`);

    const atCap = scoreLead(base({ nearbyFreshCount: RANK_WEIGHTS.DENSITY_NEIGHBOR_CAP }), NOW).score;
    const overCap = scoreLead(base({ nearbyFreshCount: RANK_WEIGHTS.DENSITY_NEIGHBOR_CAP * 5 }), NOW).score;
    expect(atCap).toBe(RANK_WEIGHTS.DENSITY_MAX);
    expect(overCap).toBe(RANK_WEIGHTS.DENSITY_MAX);
  });

  it("uses the singular form for one neighbor and skips zero", () => {
    expect(scoreLead(base({ nearbyFreshCount: 1 }), NOW).reasons).toContain(`1 fresh lead within ${DENSITY_RADIUS_M}m`);
    expect(scoreLead(base({ nearbyFreshCount: 0 }), NOW)).toEqual({ score: 0, reasons: [] });
  });
});

describe("scoreLead — expansion cluster yield", () => {
  it("awards proportional points and the 'cluster yielded N leads' reason", () => {
    const { score, reasons } = scoreLead(base({ clusterFreshFound: 6 }), NOW);
    expect(score).toBe(RANK_WEIGHTS.CLUSTER_YIELD_MAX * 6 / RANK_WEIGHTS.CLUSTER_YIELD_CAP);
    expect(reasons).toContain("cluster yielded 6 leads");
  });

  it("saturates at the cap and ignores empty clusters", () => {
    expect(scoreLead(base({ clusterFreshFound: 100 }), NOW).score).toBe(RANK_WEIGHTS.CLUSTER_YIELD_MAX);
    expect(scoreLead(base({ clusterFreshFound: 0 }), NOW)).toEqual({ score: 0, reasons: [] });
    expect(scoreLead(base({ clusterFreshFound: null }), NOW)).toEqual({ score: 0, reasons: [] });
  });
});

describe("scoreLead — territory fit", () => {
  it("adds the small bonus for a routed lead, preferring the assigned-rep wording", () => {
    const assigned = scoreLead(base({ assignedRepId: 7 }), NOW);
    expect(assigned.score).toBe(RANK_WEIGHTS.TERRITORY_FIT_BONUS);
    expect(assigned.reasons).toContain("assigned — actionable now");

    const territory = scoreLead(base({ assignedTerritoryId: 3 }), NOW);
    expect(territory.score).toBe(RANK_WEIGHTS.TERRITORY_FIT_BONUS);
    expect(territory.reasons).toContain("inside an assigned territory");
  });
});

describe("scoreLead — composite", () => {
  it("sums every signal for the perfect door", () => {
    const { score, reasons } = scoreLead({
      freshConfirmedAt: minutesAgo(0),
      newlyLit: { priorState: "coming_soon" },
      newBuild: { buildStage: "addressed", confidence: "authoritative" },
      nearbyFreshCount: RANK_WEIGHTS.DENSITY_NEIGHBOR_CAP,
      clusterFreshFound: RANK_WEIGHTS.CLUSTER_YIELD_CAP,
      assignedRepId: 7,
    }, NOW);
    const expected = RANK_WEIGHTS.RECENCY_MAX + RANK_WEIGHTS.NEWLY_LIT_BONUS + RANK_WEIGHTS.NEW_BUILD_MAX
      + RANK_WEIGHTS.DENSITY_MAX + RANK_WEIGHTS.CLUSTER_YIELD_MAX + RANK_WEIGHTS.TERRITORY_FIT_BONUS;
    expect(score).toBeCloseTo(expected, 0);
    expect(reasons).toHaveLength(6);
  });

  it("ranks a just-lit unrouted lead above a stale routed one (recency dominates)", () => {
    const hot = scoreLead(base({ freshConfirmedAt: minutesAgo(30) }), NOW).score;
    const stale = scoreLead(base({ freshConfirmedAt: minutesAgo(7 * 1440), assignedRepId: 1 }), NOW).score;
    expect(hot).toBeGreaterThan(stale);
  });
});
