// Viewport windowing math for the 100k+-pin field map: fetch margin, keep
// region, bbox serialization, and the merge/prune that bounds client memory.
import { describe, expect, it } from "vitest";
import {
  MAP_VIEWPORT_MODE_THRESHOLD,
  expandBBox,
  keepRegion,
  inBBox,
  bboxParam,
  mergeViewportPins,
} from "@/lib/mapViewport";

const VIEW = { minLng: -80.6, minLat: 35.4, maxLng: -80.2, maxLat: 35.6 }; // 0.4° x 0.2°

describe("expandBBox", () => {
  it("adds the fraction of span on EVERY side", () => {
    const b = expandBBox(VIEW, 0.2);
    expect(b.minLng).toBeCloseTo(-80.68, 6);
    expect(b.maxLng).toBeCloseTo(-80.12, 6);
    expect(b.minLat).toBeCloseTo(35.36, 6);
    expect(b.maxLat).toBeCloseTo(35.64, 6);
  });

  it("clamps to world bounds", () => {
    const b = expandBBox({ minLng: -179.9, minLat: 89.9, maxLng: 179.9, maxLat: 90 }, 1);
    expect(b.minLng).toBe(-180);
    expect(b.maxLng).toBe(180);
    expect(b.maxLat).toBe(90);
  });
});

describe("keepRegion", () => {
  it("defaults to a centered 3× region (one full viewport of margin per side)", () => {
    const k = keepRegion(VIEW);
    expect(k.maxLng - k.minLng).toBeCloseTo(3 * (VIEW.maxLng - VIEW.minLng), 6);
    expect(k.maxLat - k.minLat).toBeCloseTo(3 * (VIEW.maxLat - VIEW.minLat), 6);
    // centered: midpoints agree
    expect((k.minLng + k.maxLng) / 2).toBeCloseTo((VIEW.minLng + VIEW.maxLng) / 2, 9);
    expect((k.minLat + k.maxLat) / 2).toBeCloseTo((VIEW.minLat + VIEW.maxLat) / 2, 9);
  });
});

describe("inBBox / bboxParam", () => {
  it("inBBox is inclusive on every edge", () => {
    expect(inBBox(35.5, -80.4, VIEW)).toBe(true);
    expect(inBBox(35.4, -80.6, VIEW)).toBe(true);
    expect(inBBox(35.61, -80.4, VIEW)).toBe(false);
    expect(inBBox(35.5, -80.19, VIEW)).toBe(false);
  });

  it("bboxParam serializes minLng,minLat,maxLng,maxLat (the server's order)", () => {
    expect(bboxParam(VIEW)).toBe("-80.6,35.4,-80.2,35.6");
  });
});

describe("mergeViewportPins", () => {
  const pin = (id: number, lat: number, lng: number) => ({ id, lat, lng });

  it("merges by id — fetched wins, survivors keep their objects", () => {
    const stale = pin(1, 35.5, -80.4);
    const fresh = { ...stale, leadStatus: "sold" } as any;
    const kept = pin(2, 35.45, -80.3);
    const { pins, added, pruned } = mergeViewportPins([stale, kept], [fresh], keepRegion(VIEW));
    expect(added).toBe(0); // id 1 already known — an update, not an add
    expect(pruned).toBe(0);
    expect(pins.find((p) => p.id === 1)).toBe(fresh);
    expect(pins.find((p) => p.id === 2)).toBe(kept);
  });

  it("prunes pins outside the keep region so a long session stays bounded", () => {
    const near = pin(1, 35.5, -80.4);
    const far = pin(2, 40.0, -70.0); // states away
    const { pins, pruned } = mergeViewportPins([near, far], [], keepRegion(VIEW));
    expect(pruned).toBe(1);
    expect(pins.map((p) => p.id)).toEqual([1]);
  });

  it("counts genuinely-new pins so the caller can skip a no-op cache write", () => {
    const a = pin(1, 35.5, -80.4);
    const b = pin(2, 35.55, -80.35);
    const { pins, added } = mergeViewportPins([a], [a, b], keepRegion(VIEW));
    expect(added).toBe(1);
    expect(pins).toHaveLength(2);
  });

  it("pins without coordinates are never pruned (they paint nothing anyway)", () => {
    const noGeo = { id: 9, lat: null, lng: null };
    const { pruned, pins } = mergeViewportPins([noGeo], [], keepRegion(VIEW));
    expect(pruned).toBe(0);
    expect(pins).toHaveLength(1);
  });
});

describe("mode threshold", () => {
  it("is the 60k the server-side windowing was designed for", () => {
    expect(MAP_VIEWPORT_MODE_THRESHOLD).toBe(60_000);
  });
});
