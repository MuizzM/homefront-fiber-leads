import { describe, expect, it } from "vitest";
import { clusterFreshFiber, type FreshFiberPoint } from "@shared/freshFiberClusters";

const point = (id: number, lat: number, lng: number, confidence: FreshFiberPoint["confidence"] = "single_source_provisional"): FreshFiberPoint => ({
  id, address: `${id} Main St`, city: "Lexington", state: "NC", lat, lng,
  firstSeenLiveAt: "2026-07-13T12:00:00.000Z", confidence, sources: ["kinetic"],
});

describe("clusterFreshFiber", () => {
  it("groups nearby address-level flips and separates distant streets", () => {
    const clusters = clusterFreshFiber([
      point(1, 35.8240, -80.2534), point(2, 35.8244, -80.2531),
      point(3, 35.8400, -80.2700),
    ], { radiusMeters: 250, nowMs: Date.parse("2026-07-13T13:00:00Z") });
    expect(clusters).toHaveLength(2);
    expect(clusters[0].density).toBe(2);
    expect(clusters[0].addresses.map((p) => p.id).sort()).toEqual([1, 2]);
  });

  it("keeps cross-source confidence explicit and increases priority", () => {
    const clusters = clusterFreshFiber([
      point(1, 35.8240, -80.2534, "cross_verified"),
      point(2, 35.8243, -80.2532),
    ], { nowMs: Date.parse("2026-07-13T13:00:00Z") });
    expect(clusters[0]).toMatchObject({ confirmed: 1, provisional: 1, density: 2 });
    expect(clusters[0].score).toBeGreaterThan(50);
  });

  it("never merges points across state or city boundaries", () => {
    const other = { ...point(2, 35.8241, -80.2534), city: "Thomasville" };
    expect(clusterFreshFiber([point(1, 35.8240, -80.2534), other])).toHaveLength(2);
  });
});
