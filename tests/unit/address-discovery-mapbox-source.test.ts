import { describe, expect, it, vi } from "vitest";
import { createMapboxAddressSource } from "../../server/addressDiscovery/sources";
import { bboxPolygon } from "../../server/addressDiscovery/types";

describe("Mapbox address discovery source", () => {
  it("turns reverse-geocode results into rooftop candidates inside the drawn geometry", async () => {
    const harvest = vi.fn(async () => [
      {
        address: "101 Fiber Way",
        city: "Lexington",
        state: "NC",
        zip: "27292",
        lat: 35.82,
        lng: -80.25,
      },
      {
        address: "999 Outside Rd",
        city: "Lexington",
        state: "NC",
        zip: "27292",
        lat: 36.1,
        lng: -80.25,
      },
    ]);
    const bbox = { south: 35.81, west: -80.26, north: 35.83, east: -80.24 };
    const source = createMapboxAddressSource(
      harvest as any,
      () => "test-token",
    );

    const page = await source.discover({
      tenantId: 1,
      jobId: "job-1",
      tileId: "tile-1",
      bbox,
      geometry: bboxPolygon(bbox),
      city: "Lexington",
      state: "NC",
      signal: new AbortController().signal,
    });

    expect(harvest).toHaveBeenCalledOnce();
    expect(page.partial).toBe(false);
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({
      fullAddress: "101 Fiber Way",
      city: "Lexington",
      state: "NC",
      postalCode: "27292",
      coordinateQuality: "rooftop",
      evidenceKind: "reverse_geocode",
    });
  });

  it("is unavailable without a token and never attempts a request", async () => {
    const harvest = vi.fn();
    const source = createMapboxAddressSource(harvest as any, () => "");
    expect(source.available(1)).toBe(false);
    await expect(source.healthCheck(1)).resolves.toMatchObject({ ok: false });
    expect(harvest).not.toHaveBeenCalled();
  });
});
