import { describe, expect, it } from "vitest";
import {
  DEFAULT_SWEEP_POLICY, WORK_FACTOR_MIN, cellKey, cycleBudget, decideCell, houseNumberOf, neighborKeys,
  orderFlood, selectProbe, smoothedRate, type CellStats,
} from "../../shared/neighborhoodSweep";

const base: CellStats = {
  cellLat: 35.21, cellLng: -82.23, city: "tryon", state: "NC",
  scanned: 0, hits: 0, live: 0, unscanned: 120, staleNegatives: 0, unlinkedGreens: 0,
  lastHitDays: null, neighborHits: 0, neighborScanned: 0,
  expanding: false, buildEvidence: 0, comingSoon: 0, inFootprint: true,
  cityScanned: 500, cityHits: 50, cityLive: 120,
};

describe("decideCell", () => {
  it("floods any cell that has produced a hit, and ranks recent dense hits first", () => {
    const hot = decideCell({ ...base, scanned: 134, hits: 117, live: 120, unscanned: 132, lastHitDays: 10 });
    expect(hot.phase).toBe("flood");
    expect(hot.reasons).toContain("hit_in_cell");
    expect(hot.reasons).toContain("recent_hit");
    const stale = decideCell({ ...base, scanned: 134, hits: 117, live: 120, unscanned: 132, lastHitDays: 200 });
    expect(stale.phase).toBe("flood");
    expect(stale.score).toBeLessThan(hot.score);
    const sparse = decideCell({ ...base, scanned: 40, hits: 1, live: 1, unscanned: 132, lastHitDays: 10 });
    expect(sparse.phase).toBe("flood");
    expect(sparse.score).toBeLessThan(hot.score);
  });

  it("a single hit in a cell outranks every cold cell in the same city", () => {
    const oneHit = decideCell({ ...base, scanned: 5, hits: 1, live: 1, lastHitDays: 3 });
    const cold = decideCell({ ...base });
    expect(oneHit.phase).toBe("flood");
    expect(cold.phase).toBe("probe");
    expect(oneHit.score).toBeGreaterThan(cold.score);
  });

  it("marks a cell complete when there is nothing left to check", () => {
    expect(decideCell({ ...base, scanned: 200, hits: 80, live: 90, unscanned: 0 }).phase).toBe("complete");
  });

  it("parks a probed cell with nothing live, and a proven sink city", () => {
    const dead = decideCell({ ...base, scanned: 20, hits: 0, live: 0 });
    expect(dead.phase).toBe("parked");
    expect(dead.parkedReason).toBe("cell_no_fiber");
    const charlotte = decideCell({ ...base, city: "charlotte", cityScanned: 400, cityHits: 0, cityLive: 0 });
    expect(charlotte.phase).toBe("parked");
    expect(charlotte.parkedReason).toBe("city_sink");
  });

  it("official build evidence overrides the sink rules", () => {
    const announced = decideCell({ ...base, scanned: 20, hits: 0, live: 0, expanding: true });
    expect(announced.phase).toBe("probe");
    expect(announced.reasons).toContain("announced_build");
    const fcc = decideCell({ ...base, city: "charlotte", cityScanned: 400, cityHits: 0, cityLive: 0, buildEvidence: 4 });
    expect(fcc.phase).toBe("probe");
    expect(fcc.reasons).toContain("fcc_build_evidence");
  });

  it("parks cold cells outside the footprint unless evidence says otherwise", () => {
    expect(decideCell({ ...base, inFootprint: false }).parkedReason).toBe("outside_footprint");
    expect(decideCell({ ...base, inFootprint: false, comingSoon: 2 }).phase).toBe("probe");
    // A hit is a hit wherever it is.
    expect(decideCell({ ...base, inFootprint: false, scanned: 3, hits: 1, live: 1 }).phase).toBe("flood");
  });

  it("a cold cell beside hot cells outranks an isolated cold cell", () => {
    const beside = decideCell({ ...base, neighborHits: 60, neighborScanned: 80 });
    const alone = decideCell({ ...base });
    expect(beside.phase).toBe("probe");
    expect(beside.reasons).toContain("neighbor_hits");
    expect(beside.score).toBeGreaterThan(alone.score);
  });

  it("more work breaks ties, bounded by the work factor: a clearly better rate still wins", () => {
    const big = decideCell({ ...base, unscanned: 900 });
    const small = decideCell({ ...base, unscanned: 5 });
    expect(big.score).toBeGreaterThan(small.score);
    expect(big.score).toBeLessThanOrEqual(small.score / WORK_FACTOR_MIN + 1e-9);
    // A cell whose rate is 30% better with almost no work beats a huge cell at the lower rate.
    const betterSmall = decideCell({ ...base, scanned: 20, hits: 6, live: 6, unscanned: 5, lastHitDays: 200 });
    const worseBig = decideCell({ ...base, scanned: 20, hits: 4, live: 4, unscanned: 900, lastHitDays: 200 });
    expect(betterSmall.expectedRate / worseBig.expectedRate).toBeGreaterThan(1 / WORK_FACTOR_MIN);
    expect(betterSmall.score).toBeGreaterThan(worseBig.score);
  });

  it("an expired park earns one re-probe even in a sink", () => {
    expect(decideCell({ ...base, scanned: 20, hits: 0, live: 0 }).phase).toBe("parked");
    const again = decideCell({ ...base, scanned: 20, hits: 0, live: 0, parkExpired: true });
    expect(again.phase).toBe("probe");
    expect(again.reasons).toContain("park_expired");
    expect(decideCell({ ...base, city: "charlotte", cityScanned: 400, cityHits: 0, cityLive: 0, parkExpired: true }).phase).toBe("probe");
  });

  it("smoothedRate shrinks low-evidence cells toward the prior", () => {
    expect(smoothedRate(1, 1, 0.05, 12)).toBeLessThan(smoothedRate(8, 20, 0.05, 12));
    expect(smoothedRate(0, 0, 0.3, 12)).toBeCloseTo(0.3);
  });
});

describe("selectProbe", () => {
  const cands = [
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: n, streetKey: "OAK ST", houseNumber: n * 10 })),
    ...[9, 10, 11].map((n) => ({ id: n, streetKey: "ELM AVE", houseNumber: n })),
    { id: 12, streetKey: "PINE CT", houseNumber: 4 },
    { id: 13, streetKey: "", houseNumber: null },
  ];
  it("takes one address per street before a second from any street", () => {
    const picked = selectProbe(cands, 4);
    expect(picked).toHaveLength(4);
    const streets = picked.map((id) => cands.find((c) => c.id === id)!.streetKey);
    expect(new Set(streets).size).toBe(4);
    // Middle of the biggest street first.
    expect(picked[0]).toBe(5);
  });
  it("fills the remainder from the largest streets, never repeating an id", () => {
    const picked = selectProbe(cands, 9);
    expect(new Set(picked).size).toBe(9);
    expect(picked.filter((id) => id <= 8).length).toBeGreaterThanOrEqual(3);
  });
  it("is bounded by the candidate count and deterministic", () => {
    expect(selectProbe(cands, 50)).toHaveLength(cands.length);
    expect(selectProbe(cands, 6)).toEqual(selectProbe([...cands].reverse(), 6));
    expect(selectProbe([], 6)).toEqual([]);
  });
});

describe("orderFlood and houseNumberOf", () => {
  it("orders street by street, house numbers ascending", () => {
    const rows = [
      { id: 1, streetKey: "OAK ST", houseNumber: 120 },
      { id: 2, streetKey: "ELM AVE", houseNumber: 9 },
      { id: 3, streetKey: "OAK ST", houseNumber: 12 },
      { id: 4, streetKey: "", houseNumber: null },
    ];
    expect(orderFlood(rows).map((r) => r.id)).toEqual([2, 3, 1, 4]);
  });
  it("reads the leading house number only", () => {
    expect(houseNumberOf("123 Main St")).toBe(123);
    expect(houseNumberOf("123-A Main St")).toBe(123);
    expect(houseNumberOf("Main St")).toBeNull();
    expect(houseNumberOf(null)).toBeNull();
  });
});

describe("cycleBudget", () => {
  const i = { intervalMinutes: 10, pending: 0, floor: 300, cap: 5000, oversubscribe: 1.5 };
  it("follows the measured drain with a floor and a cap", () => {
    expect(cycleBudget({ ...i, drainPerMinute: 0 }).budget).toBe(300);
    expect(cycleBudget({ ...i, drainPerMinute: 30 }).budget).toBe(450);
    expect(cycleBudget({ ...i, drainPerMinute: 10_000 }).budget).toBe(5000);
  });
  it("subtracts its own pending work and skips when the backlog is warm", () => {
    expect(cycleBudget({ ...i, drainPerMinute: 30, pending: 100 }).budget).toBe(350);
    expect(cycleBudget({ ...i, drainPerMinute: 30, pending: 900 })).toEqual({ budget: 0, skip: "backlog_warm" });
  });
});

describe("grid keys", () => {
  it("builds stable keys and eight neighbors", () => {
    expect(cellKey(35.21, -82.23)).toBe("3521_-8223");
    const n = neighborKeys(35.21, -82.23);
    expect(n).toHaveLength(8);
    expect(n).toContain("3522_-8224");
    expect(n).not.toContain("3521_-8223");
  });
  it("policy defaults are the documented ones", () => {
    expect(DEFAULT_SWEEP_POLICY.probePerCell).toBe(12);
    expect(DEFAULT_SWEEP_POLICY.sinkCellMinScans).toBe(15);
  });
});
