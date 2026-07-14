import { describe, expect, it } from "vitest";
import { applyDiscoveryMapPointBatch } from "../../client/src/lib/discoveryMapFeatures";

describe("incremental discovery map features", () => {
  it("publishes only cross-gated confirmed leads", () => {
    const features = new Map<string, any>();
    expect(applyDiscoveryMapPointBatch(features, "job-1", [{
      canonicalAddressId: 42, address: "42 Fiber Way", city: "Lexington", state: "NC",
      zip: "27292", lat: 35.82, lng: -80.25, scanStatus: "checking",
    }], 100)).toBe(0);
    expect(features.size).toBe(0);

    expect(applyDiscoveryMapPointBatch(features, "job-1", [{
      canonicalAddressId: 42, address: "42 Fiber Way", city: "Lexington", state: "NC",
      zip: "27292", lat: 35.82, lng: -80.25, scanStatus: "fresh_confirmed",
      fiberStatus: "new_fiber", billingStatus: "N", maxDownloadMbps: 1000,
    }], 200)).toBe(1);
    expect(features.size).toBe(1);
    expect(features.get("job-1:42")).toEqual(expect.objectContaining({
      geometry: { type: "Point", coordinates: [-80.25, 35.82] },
      properties: expect.objectContaining({
        address: "42 Fiber Way", scanStatus: "fresh_confirmed", isNewFiber: true,
        fiberStatus: "new_fiber", billingStatus: "N", maxDownloadMbps: 1000, receivedAt: 200,
      }),
    }));
  });

  it("suppresses active-service and negative outcomes", () => {
    const features = new Map<string, any>();
    expect(applyDiscoveryMapPointBatch(features, "job-1", [
      { canonicalAddressId: 1, lat: 35.82, lng: -80.25, scanStatus: "fresh_confirmed", billingStatus: "Y" },
      { canonicalAddressId: 2, lat: 35.83, lng: -80.26, scanStatus: "no_service" },
      { canonicalAddressId: 3, lat: 35.84, lng: -80.27, scanStatus: "unverified" },
    ])).toBe(0);
    expect(features.size).toBe(0);
  });

  it("drops invalid coordinates instead of creating broken Mapbox features", () => {
    const features = new Map<string, any>();
    expect(applyDiscoveryMapPointBatch(features, "job-1", [
      { address: "Bad", lat: Number.NaN, lng: -80, scanStatus: "checking" },
    ])).toBe(0);
    expect(features.size).toBe(0);
  });
});
