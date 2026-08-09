import { describe, it, expect } from "vitest";
import { bboxOfRing, pointInRing, selectPointsInPolygon } from "../../client/src/lib/mapGeo";

/**
 * Lasso spatial helpers. The bbox-rejected selection must return EXACTLY the
 * same set as a naive exact-only pass — the optimization changes speed, not
 * results (House Rule 12/13: never trade correctness for a Big-O claim).
 */

// A unit square [0,0]–[10,10] as a [lng,lat] ring.
const SQUARE: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];

describe("bboxOfRing", () => {
  it("computes tight bounds", () => {
    expect(bboxOfRing(SQUARE)).toEqual({ minLng: 0, minLat: 0, maxLng: 10, maxLat: 10 });
  });
});

describe("pointInRing", () => {
  it("inside / outside / near edges", () => {
    expect(pointInRing(5, 5, SQUARE)).toBe(true);      // center
    expect(pointInRing(5, 15, SQUARE)).toBe(false);    // east of the box
    expect(pointInRing(-1, 5, SQUARE)).toBe(false);    // south
    expect(pointInRing(9.99, 0.01, SQUARE)).toBe(true); // just inside a corner
  });
  it("handles a concave (L-shaped) polygon", () => {
    // L: bottom row lng0–6,lat0–3 + left column lng0–3,lat0–6. Missing corner
    // is lng3–6 × lat3–6. Ring is [lng,lat].
    const L: Array<[number, number]> = [[0, 0], [6, 0], [6, 3], [3, 3], [3, 6], [0, 6]];
    expect(pointInRing(4.5, 4.5, L)).toBe(false); // missing corner → outside
    expect(pointInRing(4.5, 1.5, L)).toBe(true);  // left column → inside (lat=4.5, lng=1.5)
    expect(pointInRing(1.5, 4.5, L)).toBe(true);  // bottom row → inside (lat=1.5, lng=4.5)
  });
});

describe("selectPointsInPolygon - bbox rejection matches exact-only", () => {
  // 2,000 pseudo-random points across a 30×30 area (deterministic, no RNG).
  const pts = Array.from({ length: 2000 }, (_, i) => ({
    id: i,
    lng: ((i * 73) % 300) / 10 - 5,   // -5 … 25
    lat: ((i * 149) % 300) / 10 - 5,
  }));

  const naive = pts.filter(p => pointInRing(p.lat, p.lng, SQUARE));
  const optimized = selectPointsInPolygon(pts, SQUARE);

  it("returns an identical set to the exact-only scan", () => {
    expect(optimized.map(p => p.id).sort((a, b) => a - b))
      .toEqual(naive.map(p => p.id).sort((a, b) => a - b));
    expect(optimized.length).toBeGreaterThan(0);
    expect(optimized.every(p => p.lng >= 0 && p.lng <= 10 && p.lat >= 0 && p.lat <= 10)).toBe(true);
  });

  it("skips items without coordinates and degenerate rings", () => {
    const withNulls = [...pts, { id: -1, lng: null, lat: null }, { id: -2, lng: 5, lat: undefined as any }];
    expect(selectPointsInPolygon(withNulls, SQUARE).some(p => p.id < 0)).toBe(false);
    expect(selectPointsInPolygon(pts, [[0, 0], [1, 1]])).toEqual([]); // <3 vertices
  });
});
