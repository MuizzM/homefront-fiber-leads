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
