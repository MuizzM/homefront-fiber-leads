import { describe, expect, it } from "vitest";
import {
  mergeAreaAddressSources,
  normalizeAreaAddress,
  planUnifiedAreaScan,
} from "../../server/areaScanStrategy";

describe("planUnifiedAreaScan", () => {
  it("automatically enables a dense grid for a normal field box", () => {
    const plan = planUnifiedAreaScan(
      { south: 35.82, north: 35.83, west: -80.26, east: -80.25 },
      { hasMapboxToken: true, autoGridMaxPoints: 900, harvestCap: 5000 },
    );

    expect(plan.strategy).toBe("unified");
    expect(plan.gridEnabled).toBe(true);
    expect(plan.gridPoints).toBeLessThanOrEqual(900);
    expect(plan.gridStep).toBeLessThanOrEqual(0.0012);
  });

  it("skips paid augmentation for a large box instead of coarsening it under the limit", () => {
    const plan = planUnifiedAreaScan(
      { south: 35.70, north: 35.90, west: -80.40, east: -80.10 },
      { hasMapboxToken: true, autoGridMaxPoints: 900, harvestCap: 5000 },
    );

    expect(plan.gridPoints).toBeGreaterThan(900);
    expect(plan.gridEnabled).toBe(false);
  });

  it("continues without a grid when Mapbox is not configured", () => {
    const plan = planUnifiedAreaScan(
      { south: 35.82, north: 35.83, west: -80.26, east: -80.25 },
      { hasMapboxToken: false },
    );
    expect(plan.gridEnabled).toBe(false);
  });

  it("ELECTED box: a denser ceiling + higher cap keeps a big box on the paid grid that the default tier would skip", () => {
    // A neighbourhood-plus box (~5.5 km): >900 grid points at the default 0.0012
    // ceiling (so the default tier SKIPS it) but well under the elected cap.
    const bbox = { south: 35.80, north: 35.85, west: -80.30, east: -80.24 };
    // Default tier skips this box.
    const dflt = planUnifiedAreaScan(bbox, { hasMapboxToken: true, autoGridMaxPoints: 900, harvestCap: 5000 });
    expect(dflt.gridEnabled).toBe(false);
    // Elected tier: denser spacing + higher cap → still augmented.
    const elected = planUnifiedAreaScan(bbox, {
      hasMapboxToken: true, autoGridMaxPoints: 8000, harvestCap: 12000, ceilDeg: 0.0008, minSamplesPerSide: 10,
    });
    expect(elected.gridEnabled).toBe(true);
    expect(elected.gridStep).toBeLessThanOrEqual(0.0008);      // denser than the 0.0012 default ceiling
    expect(elected.gridPoints).toBeGreaterThan(dflt.gridPoints); // more samples than the default plan
    expect(elected.gridPoints).toBeLessThanOrEqual(12000);      // hard ceiling still enforced
  });

  it("ELECTED tier still enforces a hard ceiling (never truly unlimited)", () => {
    // An absurdly large box is still capped — Mapbox is separately billed.
    const plan = planUnifiedAreaScan(
      { south: 34.0, north: 36.5, west: -83.0, east: -78.0 },
      { hasMapboxToken: true, autoGridMaxPoints: 8000, harvestCap: 12000, ceilDeg: 0.0008 },
    );
    expect(plan.gridPoints).toBeGreaterThan(8000);
    expect(plan.gridEnabled).toBe(false); // over even the elected auto cap → skip, not a runaway bill
  });
});

describe("mergeAreaAddressSources", () => {
  it("unions mapped and grid-only homes while deduping suffix variants", () => {
    const merged = mergeAreaAddressSources([
      [{ address: "101 New Fiber Street", city: "Lexington", state: "NC", zip: "27292", lat: 35.82, lng: -80.25 }],
      [{ address: "101 New Fiber St.", city: "", state: "NC", zip: "", lat: 35.8201, lng: -80.2501 }],
      [{ address: "103 New Fiber St", city: "Lexington", state: "NC", zip: "27292", lat: 35.8202, lng: -80.2502 }],
    ], { city: "Lexington", state: "NC" });

    expect(merged).toHaveLength(2);
    expect(merged.map(item => normalizeAreaAddress(item.address))).toEqual([
      "101 new fiber st",
      "103 new fiber st",
    ]);
    expect(merged[0]).toMatchObject({ city: "Lexington", state: "NC", zip: "27292" });
  });
});
