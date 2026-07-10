import { describe, it, expect } from "vitest";
import {
  haversineM, walkWay, roadProbePoints, SpatialClaimGrid, negativeCellKey,
  clusterOffsets, dedupeByGrid, metersToLatDeg, type LatLng,
} from "../../shared/streetSpine";

// Street-spine geometry is the address-discovery moat's cost core — it must place
// probe points ONLY on roads at correct spacing, dedup redundant probes, and expand
// a hit into its block. Pure + deterministic, so fully unit-testable.

describe("haversine + unit conversions", () => {
  it("measures street-scale distance accurately", () => {
    // 0.001° of latitude ≈ 111.3 m.
    expect(haversineM({ lat: 35.5, lng: -80.4 }, { lat: 35.501, lng: -80.4 })).toBeCloseTo(111.3, 0);
    expect(metersToLatDeg(111320)).toBeCloseTo(1, 5);
  });
});

describe("walkWay", () => {
  it("emits a point every intervalM along a straight road, start included", () => {
    // A ~111m north segment, 40m interval → points at 0, 40, 80 m (110m not reached).
    const seg: LatLng[] = [{ lat: 35.5, lng: -80.4 }, { lat: 35.501, lng: -80.4 }];
    const pts = walkWay(seg, 40);
    expect(pts.length).toBe(3);
    // Consecutive spacing ≈ 40 m.
    expect(haversineM(pts[0], pts[1])).toBeCloseTo(40, 0);
    expect(haversineM(pts[1], pts[2])).toBeCloseTo(40, 0);
  });
  it("carries leftover distance across segment joints (no double/'skipped' points at corners)", () => {
    // Two 60m-ish legs meeting at a corner; spacing must stay ~40m THROUGH the joint.
    const dLat = metersToLatDeg(60);
    const path: LatLng[] = [{ lat: 35.5, lng: -80.4 }, { lat: 35.5 + dLat, lng: -80.4 }, { lat: 35.5 + dLat, lng: -80.4 + 0.0007 }];
    const pts = walkWay(path, 40);
    // Straight-line spacing stays 40m on straights and ≥ 40/√2 ≈ 28m across a 90°
    // corner — never clustered (a bug would put two points ~0m apart at the joint).
    for (let i = 1; i < pts.length; i++) expect(haversineM(pts[i - 1], pts[i])).toBeGreaterThan(25);
  });
  it("degenerate ways: empty → none, single node → that node", () => {
    expect(walkWay([], 40)).toEqual([]);
    expect(walkWay([{ lat: 1, lng: 2 }], 40)).toEqual([{ lat: 1, lng: 2 }]);
  });
  it("roadProbePoints concatenates all ways", () => {
    const pts = roadProbePoints([
      { geometry: [{ lat: 35.5, lng: -80.4 }, { lat: 35.501, lng: -80.4 }] },
      { geometry: [{ lat: 36.0, lng: -80.0 }, { lat: 36.001, lng: -80.0 }] },
    ], 40);
    expect(pts.length).toBe(6); // 3 + 3
  });
});

describe("SpatialClaimGrid", () => {
  it("covers the 3×3 neighborhood of a claimed cell (skips nearby redundant probes)", () => {
    const g = new SpatialClaimGrid(0.0005);
    expect(g.isCovered(35.5, -80.4)).toBe(false);
    g.claim(35.5, -80.4);
    expect(g.isCovered(35.5, -80.4)).toBe(true);           // same cell
    expect(g.isCovered(35.5 + 0.0004, -80.4)).toBe(true);  // adjacent cell (~44m)
    expect(g.isCovered(35.5 + 0.01, -80.4)).toBe(false);   // far away (~1.1km)
  });
  it("dedupeByGrid drops probes within a claimed neighborhood, keeps distant ones", () => {
    const pts: LatLng[] = [
      { lat: 35.5000, lng: -80.4 },   // kept, claims
      { lat: 35.5003, lng: -80.4 },   // ~33m → covered, dropped
      { lat: 35.5100, lng: -80.4 },   // ~1.1km → kept, claims
    ];
    const kept = dedupeByGrid(pts, new SpatialClaimGrid(0.0005));
    expect(kept.map(p => p.lat)).toEqual([35.5, 35.51]);
  });
});

describe("negative cache + cluster", () => {
  it("negativeCellKey buckets nearby coords to the same ~220m cell", () => {
    const a = negativeCellKey(35.5001, -80.4001), b = negativeCellKey(35.5009, -80.4009);
    expect(a).toEqual(b);                                   // within one 0.002° cell
    expect(negativeCellKey(35.53, -80.4)).not.toEqual(a);   // far → different cell
  });
  it("clusterOffsets returns 8 distinct neighbors ~35m out (full-block expansion)", () => {
    const c = { lat: 35.5, lng: -80.4 };
    const off = clusterOffsets(c, 35);
    expect(off).toHaveLength(8);
    expect(new Set(off.map(o => `${o.lat},${o.lng}`)).size).toBe(8);
    for (const o of off) { const d = haversineM(c, o); expect(d).toBeGreaterThan(20); expect(d).toBeLessThan(75); }
  });
});
