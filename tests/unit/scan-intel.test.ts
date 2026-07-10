import { describe, it, expect } from "vitest";
import { estimateScanCost, bytesToUsd, budgetTiers, MAX_CHECKS_PER_RUN } from "../../shared/scanEconomics";
import { scoreMarket, type MarketAggregate } from "../../shared/marketIntel";
import { clusterOpportunities, convexHull, padHull, type OppPoint } from "../../shared/opportunity";
import { rankTargets, type PoolTarget } from "../../shared/scanPriority";
import { classifyAvailabilityTransition } from "../../shared/fiberDetect";

// ── Economics — the cost an operator sees must be deterministic ───────────────
describe("scanEconomics", () => {
  it("estimates cost deterministically and scales linearly", () => {
    const a = estimateScanCost(1000, { bytesPerCheck: 12000, usdPerGb: 3 });
    expect(a.checks).toBe(1000);
    expect(a.estBytes).toBe(12_000_000);
    expect(estimateScanCost(2000, { bytesPerCheck: 12000, usdPerGb: 3 }).estBytes).toBe(a.estBytes * 2);
  });
  it("floors and never goes negative", () => {
    expect(estimateScanCost(-5).checks).toBe(0);
    expect(estimateScanCost(3.9).checks).toBe(3);
  });
  it("bytesToUsd round-trips with the estimate", () => {
    const est = estimateScanCost(500, { usdPerGb: 4 });
    expect(bytesToUsd(est.estBytes, { usdPerGb: 4 })).toBeCloseTo(est.estUsd, 6);
  });
  it("budget tiers never exceed the pool remaining or the hard cap", () => {
    const tiers = budgetTiers(300);
    expect(tiers.every(t => t.checks <= 300)).toBe(true);
    expect(budgetTiers(1e9).every(t => t.checks <= MAX_CHECKS_PER_RUN)).toBe(true);
    expect(budgetTiers(0)).toEqual([]);
  });
});

// ── Market scoring — the "where to launch" score must be explainable ──────────
describe("scoreMarket", () => {
  const now = Date.UTC(2026, 6, 10);
  const base: MarketAggregate = {
    city: "Testville", state: "NC", poolSize: 1000, verified: 0, verifiedNewFiber: 0,
    newlyLive: 0, leads: 0, unworkedLeads: 0, workedLeads: 0, soldLeads: 0, lastVerifiedAtMs: null,
  };

  it("a fresh unworked market with verified new-fiber outscores a saturated one", () => {
    const fresh = scoreMarket({ ...base, verified: 200, verifiedNewFiber: 80, leads: 80, unworkedLeads: 78, workedLeads: 2, lastVerifiedAtMs: now - 86400000 }, now);
    const worn = scoreMarket({ ...base, verified: 200, verifiedNewFiber: 80, leads: 80, unworkedLeads: 5, workedLeads: 75, soldLeads: 10, lastVerifiedAtMs: now - 86400000 }, now);
    expect(fresh.priority).toBeGreaterThan(worn.priority);
  });

  it("newly-live flips dominate freshness and surface in reasons", () => {
    const m = scoreMarket({ ...base, verified: 300, verifiedNewFiber: 40, newlyLive: 12, leads: 40, unworkedLeads: 40, lastVerifiedAtMs: now - 3 * 86400000 }, now);
    expect(m.reasons.some(r => /just went live/.test(r))).toBe(true);
    expect(m.priorityBand === "hot" || m.priorityBand === "warm").toBe(true);
  });

  it("field conversion history lifts a proven market and penalizes a busted one", () => {
    const proven = scoreMarket({ ...base, verified: 300, verifiedNewFiber: 60, leads: 60, unworkedLeads: 40, workedLeads: 20,
      outcome: { knocks: 100, contacts: 40, sales: 15, lastDeployedAtMs: now - 5 * 86400000 } }, now);
    const busted = scoreMarket({ ...base, verified: 300, verifiedNewFiber: 60, leads: 60, unworkedLeads: 40, workedLeads: 20,
      outcome: { knocks: 100, contacts: 10, sales: 1, lastDeployedAtMs: now - 5 * 86400000 } }, now);
    expect(proven.priority).toBeGreaterThan(busted.priority);
    expect(proven.conversionRate).toBeCloseTo(0.15, 3);
  });

  it("confidence reflects evidence volume", () => {
    expect(scoreMarket({ ...base, verified: 5 }, now).confidence).toBe("low");
    expect(scoreMarket({ ...base, verified: 500, verifiedNewFiber: 50 }, now).confidence).toBe("high");
  });

  it("an unverified pool still earns discoverability, not zero", () => {
    const m = scoreMarket({ ...base, poolSize: 5000, verified: 0 }, now);
    expect(m.priority).toBeGreaterThan(0);
    expect(m.reasons.some(r => /never checked|never verified/.test(r))).toBe(true);
  });
});

// ── Clustering — deterministic, correct, and fast ─────────────────────────────
describe("clusterOpportunities", () => {
  it("separates two dense blobs and ignores noise", () => {
    const pts: OppPoint[] = [];
    let id = 1;
    // Blob A around (35.50, -80.40)
    for (let i = 0; i < 30; i++) pts.push({ id: id++, lat: 35.500 + (i % 6) * 0.0008, lng: -80.400 + Math.floor(i / 6) * 0.0008, isNewFiber: true });
    // Blob B around (35.55, -80.30), 0.05deg away (~5km) — must be separate
    for (let i = 0; i < 20; i++) pts.push({ id: id++, lat: 35.550 + (i % 5) * 0.0008, lng: -80.300 + Math.floor(i / 5) * 0.0008, isNewFiber: true });
    // Noise: 2 isolated points
    pts.push({ id: id++, lat: 35.7, lng: -80.1 }, { id: id++, lat: 35.8, lng: -80.0 });

    const clusters = clusterOpportunities(pts, { minPoints: 4 });
    expect(clusters.length).toBe(2);
    expect(clusters[0].size + clusters[1].size).toBe(50);
    // Every cluster hull is a valid ring the map can draw.
    for (const c of clusters) expect(c.hull.length).toBeGreaterThanOrEqual(3);
  });

  it("is deterministic — same input, same clusters and ids", () => {
    const pts: OppPoint[] = Array.from({ length: 40 }, (_, i) => ({ id: i, lat: 35.5 + (i % 8) * 0.0006, lng: -80.4 + Math.floor(i / 8) * 0.0006, isNewFiber: true }));
    const a = clusterOpportunities(pts);
    const b = clusterOpportunities([...pts].reverse());
    expect(a.map(c => c.score)).toEqual(b.map(c => c.score));
    expect(a[0].id).toBe("c0");
  });

  it("scores an unworked fresh cluster above a mostly-worked one", () => {
    const mk = (baseId: number, worked: boolean): OppPoint[] =>
      Array.from({ length: 20 }, (_, i) => ({ id: baseId + i, lat: 35.5 + (baseId ? 0.05 : 0) + (i % 5) * 0.0007, lng: -80.4 + Math.floor(i / 5) * 0.0007, isNewFiber: true, worked }));
    const clusters = clusterOpportunities([...mk(0, false), ...mk(100, true)]);
    const fresh = clusters.find(c => c.unworked === c.size)!;
    const worn = clusters.find(c => c.unworked === 0)!;
    expect(fresh.score).toBeGreaterThan(worn.score);
  });

  it("handles 35,000 points in well under a second", () => {
    const pts: OppPoint[] = Array.from({ length: 35_000 }, (_, i) => ({
      id: i, lat: 35.0 + (i % 200) * 0.001, lng: -80.9 + Math.floor(i / 200) * 0.001, isNewFiber: i % 3 === 0,
    }));
    const t0 = performance.now();
    const clusters = clusterOpportunities(pts);
    const ms = performance.now() - t0;
    expect(clusters.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(800);
  });
});

describe("convexHull / padHull", () => {
  it("hull of a square is the 4 corners; interior points dropped", () => {
    const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [3, 7]]);
    expect(hull.length).toBe(4);
  });
  it("padHull expands outward around the centroid", () => {
    const hull: Array<[number, number]> = [[-80.4, 35.5], [-80.39, 35.5], [-80.39, 35.51], [-80.4, 35.51]];
    const padded = padHull(hull, 50);
    // Every padded vertex is farther from centroid than the original.
    const cLat = 35.505, cLng = -80.395;
    for (let i = 0; i < hull.length; i++) {
      const d0 = Math.hypot(hull[i][0] - cLng, hull[i][1] - cLat);
      const d1 = Math.hypot(padded[i][0] - cLng, padded[i][1] - cLat);
      expect(d1).toBeGreaterThan(d0);
    }
  });
});

// ── Target ranking — budget goes to the highest-EV addresses ──────────────────
describe("rankTargets", () => {
  it("prefers never-scanned addresses near known new-fiber", () => {
    const known = [{ lat: 35.500, lng: -80.400 }];
    const targets: PoolTarget[] = [
      { id: 1, lat: 35.5005, lng: -80.4005, lastScannedAtMs: null }, // near known + never scanned → top
      { id: 2, lat: 36.900, lng: -79.100, lastScannedAtMs: null },   // far + never scanned
      { id: 3, lat: 35.5005, lng: -80.4005, lastScannedAtMs: Date.now() }, // near but freshly scanned
    ];
    const ranked = rankTargets(targets, known, { nowMs: Date.now() });
    expect(ranked.find(r => r.id === 1)!.seq).toBe(0);
    expect(ranked.find(r => r.id === 1)!.ev).toBeGreaterThan(ranked.find(r => r.id === 2)!.ev);
    expect(ranked.find(r => r.id === 2)!.ev).toBeGreaterThan(ranked.find(r => r.id === 3)!.ev);
  });

  it("is deterministic and stable across input order (resumable runs)", () => {
    const known = [{ lat: 35.5, lng: -80.4 }];
    const targets: PoolTarget[] = Array.from({ length: 50 }, (_, i) => ({
      id: i, lat: 35.5 + (i % 10) * 0.001, lng: -80.4 + Math.floor(i / 10) * 0.001, lastScannedAtMs: null,
    }));
    const a = rankTargets(targets, known);
    const b = rankTargets([...targets].reverse(), known);
    expect(a.map(r => r.id)).toEqual(b.map(r => r.id));
  });

  it("spreads budget within a dense cell instead of stacking one street", () => {
    // 10 targets in one cell — within-cell rank decays EV so they don't all tie.
    const targets: PoolTarget[] = Array.from({ length: 10 }, (_, i) => ({ id: i, lat: 35.5001 + i * 1e-6, lng: -80.4001, lastScannedAtMs: null }));
    const ranked = rankTargets(targets, []);
    const evs = ranked.map(r => r.ev);
    expect(new Set(evs).size).toBeGreaterThan(1); // not all identical
  });
});

// ── The hard law: a failed check is NEVER a negative ──────────────────────────
describe("failed-check safety (product law)", () => {
  it("a failed check on a known-live address does NOT go stale and is not recorded", () => {
    const prev = { everScanned: true, wasLive: true };
    const out = classifyAvailabilityTransition(prev, { isNewFiber: false, fiberAvailable: false, billingStatus: null, checkFailed: true });
    expect(out.status).toBe("check_failed");
    expect(out.recordSnapshot).toBe(false);
    expect(out.isNewlyLive).toBe(false);
    expect(out.shouldCreateLead).toBe(false);
  });

  it("a real negative on a known-live address DOES go stale (contrast)", () => {
    const prev = { everScanned: true, wasLive: true };
    const out = classifyAvailabilityTransition(prev, { isNewFiber: false, fiberAvailable: false, billingStatus: null });
    expect(out.status).toBe("went_stale");
    expect(out.recordSnapshot).toBe(true);
  });

  it("a real unavailable->live flip is the money event", () => {
    const out = classifyAvailabilityTransition({ everScanned: true, wasLive: false }, { isNewFiber: true, fiberAvailable: true, billingStatus: "N" });
    expect(out.status).toBe("newly_live");
    expect(out.isNewlyLive).toBe(true);
    expect(out.recordSnapshot).toBe(true);
  });
});
