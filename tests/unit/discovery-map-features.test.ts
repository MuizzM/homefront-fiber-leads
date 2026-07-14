import { describe, expect, it } from "vitest";
import { applyDiscoveryMapPointBatch } from "../../client/src/lib/discoveryMapFeatures";

describe("incremental discovery map features", () => {
  it("updates a rooftop in place as qualification resolves", () => {
    const features = new Map<string, any>();
    expect(applyDiscoveryMapPointBatch(features, "job-1", [{
      canonicalAddressId: 42, address: "42 Fiber Way", city: "Lexington", state: "NC",
      zip: "27292", lat: 35.82, lng: -80.25, scanStatus: "checking",
    }], 100)).toBe(1);
    expect(features.size).toBe(1);
    expect(features.get("job-1:42").properties.scanStatus).toBe("checking");

    applyDiscoveryMapPointBatch(features, "job-1", [{
      canonicalAddressId: 42, lat: 35.82, lng: -80.25, scanStatus: "fresh_candidate",
      fiberStatus: "new_fiber", billingStatus: "N", maxDownloadMbps: 1000,
    }], 200);
    expect(features.size).toBe(1);
    expect(features.get("job-1:42")).toEqual(expect.objectContaining({
      geometry: { type: "Point", coordinates: [-80.25, 35.82] },
      properties: expect.objectContaining({
        address: "42 Fiber Way", scanStatus: "fresh_candidate", isNewFiber: true,
        fiberStatus: "new_fiber", billingStatus: "N", maxDownloadMbps: 1000, receivedAt: 200,
      }),
    }));
  });

  it("drops invalid coordinates instead of creating broken Mapbox features", () => {
    const features = new Map<string, any>();
    expect(applyDiscoveryMapPointBatch(features, "job-1", [
      { address: "Bad", lat: Number.NaN, lng: -80, scanStatus: "checking" },
    ])).toBe(0);
    expect(features.size).toBe(0);
  });
});
