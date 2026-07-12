import { describe, it, expect } from "vitest";
import { normalizeState, tileBbox } from "../../server/overpass";

describe("normalizeState", () => {
  it("maps full state names to USPS 2-letter (the form Kinetic expects)", () => {
    expect(normalizeState("North Carolina", "NC")).toBe("NC");
    expect(normalizeState("south carolina", "NC")).toBe("SC");
    expect(normalizeState("West Virginia", "NC")).toBe("WV");
  });
  it("passes through existing 2-letter codes (upper-cased)", () => {
    expect(normalizeState("sc", "NC")).toBe("SC");
    expect(normalizeState("NC", "SC")).toBe("NC");
  });
  it("falls back to the caller's state when the tag is missing or unknown", () => {
    expect(normalizeState("", "NC")).toBe("NC");
    expect(normalizeState(undefined, "SC")).toBe("SC");
    expect(normalizeState("Nowhereland", "NC")).toBe("NC");
  });
});

describe("tileBbox", () => {
  const bbox = { south: 35.0, west: -81.0, north: 35.3, east: -80.7 }; // 0.3° × 0.3°

  it("splits a big bbox into a covering grid clamped to the edges", () => {
    const tiles = tileBbox(bbox, 0.06); // 5 × 5
    expect(tiles).toHaveLength(25);
    for (const t of tiles) {
      expect(t.north).toBeLessThanOrEqual(bbox.north + 1e-9);
      expect(t.east).toBeLessThanOrEqual(bbox.east + 1e-9);
      expect(t.north).toBeGreaterThan(t.south);
      expect(t.east).toBeGreaterThan(t.west);
    }
    // Tiles cover the whole span (first tile at SW corner, last reaches NE corner).
    expect(tiles[0].south).toBeCloseTo(bbox.south, 9);
    expect(tiles[0].west).toBeCloseTo(bbox.west, 9);
    expect(Math.max(...tiles.map((t) => t.north))).toBeCloseTo(bbox.north, 9);
    expect(Math.max(...tiles.map((t) => t.east))).toBeCloseTo(bbox.east, 9);
  });

  it("returns a single tile for a small bbox", () => {
    expect(tileBbox({ south: 35.0, west: -80.5, north: 35.03, east: -80.47 }, 0.06)).toHaveLength(1);
  });
});
