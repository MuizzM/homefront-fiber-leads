import { describe, it, expect } from "vitest";
import { pointInPolygon } from "@shared/geo";

/**
 * CONTRACT (LOGIC agent): extract the ray-cast test currently inlined in
 * server/routes.ts into shared/geo.ts and export it unchanged, so the SAME
 * enclosure math backs assign-area, reclaim, and the client lasso preview.
 *   pointInPolygon(lat, lng, poly): boolean   // poly points are [lng, lat]
 * This is the geometry that decides which leads get reassigned/returned — a bug
 * here silently mis-assigns doors, so it is high-risk.
 */

// A simple 0.1° box around Rockwell NC (lng/lat pairs, matching stored polygons).
const BOX: [number, number][] = [
  [-80.40, 35.55],
  [-80.30, 35.55],
  [-80.30, 35.65],
  [-80.40, 35.65],
];

describe("pointInPolygon (ray-cast, [lng,lat] polygon)", () => {
  it("returns true for a point clearly inside", () => {
    expect(pointInPolygon(35.60, -80.35, BOX)).toBe(true);
  });

  it("returns false for a point clearly outside", () => {
    expect(pointInPolygon(35.60, -79.90, BOX)).toBe(false); // east of the box
    expect(pointInPolygon(35.90, -80.35, BOX)).toBe(false); // north of the box
  });

  it("handles a concave polygon correctly", () => {
    // L-shape ([lng,lat] = [x,y]): horizontal bar y∈[0,1] x∈[0,3] plus
    // vertical bar x∈[0,1] y∈[0,3]. The upper-right quadrant is OUTSIDE.
    const lShape: [number, number][] = [
      [0, 0],
      [3, 0],
      [3, 1],
      [1, 1],
      [1, 3],
      [0, 3],
    ];
    // pointInPolygon(lat, lng, poly) == pointInPolygon(y, x, poly)
    expect(pointInPolygon(2.5, 0.5, lShape)).toBe(true);  // inside vertical arm
    expect(pointInPolygon(0.5, 2.0, lShape)).toBe(true);  // inside horizontal arm
    expect(pointInPolygon(2.0, 2.0, lShape)).toBe(false); // empty notch → outside
  });
});
