import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateScanBbox,
  adaptiveGridStep,
  pooledMap,
  backoffDelayMs,
  type BboxLL,
} from "../../server/bboxScan";
import { harvestBboxAddresses } from "../../server/mapbox-addresses";

// ── The regression this whole change exists for ───────────────────────────────
// A box drawn over a NEW-CONSTRUCTION subdivision (Nard Ln) returned "No addresses
// found in that box" even though the homes exist. Root causes: unvalidated bbox,
// a too-coarse reverse-geocode grid, and a strict inside-box filter that dropped
// edge houses. These tests pin each fix.

describe("validateScanBbox", () => {
  const good = { minLat: 35.500, maxLat: 35.503, minLng: -80.410, maxLng: -80.407 };

  it("accepts a valid subdivision box and canonicalizes to south/north/west/east", () => {
    const v = validateScanBbox(good);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.bbox).toEqual({ south: 35.500, north: 35.503, west: -80.410, east: -80.407 });
      expect(v.corrected).toBe(false);
      expect(v.approxKm2).toBeGreaterThan(0);
    }
  });

  it("rejects missing / non-numeric coordinates", () => {
    const v = validateScanBbox({ minLat: 35.5, maxLat: 35.6, minLng: undefined, maxLng: -80.4 } as any);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("bbox_missing");
  });

  it("rejects a zero-area (click, not drag) box", () => {
    const v = validateScanBbox({ minLat: 35.5, maxLat: 35.5, minLng: -80.4, maxLng: -80.4 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("bbox_degenerate");
  });

  it("rejects out-of-range coordinates (e.g. lat/lng swapped)", () => {
    // Longitudes fed into the latitude slots → lat = -80 is out of range.
    const v = validateScanBbox({ minLat: -80.410, maxLat: -80.407, minLng: 35.500, maxLng: 35.503 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("bbox_range");
  });

  it("auto-corrects a min>max (reverse drag) box and flags it", () => {
    const v = validateScanBbox({ minLat: 35.503, maxLat: 35.500, minLng: -80.407, maxLng: -80.410 });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.corrected).toBe(true);
      expect(v.bbox).toEqual({ south: 35.500, north: 35.503, west: -80.410, east: -80.407 });
    }
  });

  it("rejects an implausibly huge box", () => {
    const v = validateScanBbox({ minLat: 30, maxLat: 40, minLng: -90, maxLng: -75 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("bbox_too_large");
  });
});

describe("adaptiveGridStep", () => {
  it("samples a tight box densely - far finer than the old fixed 0.0012° step", () => {
    const tight: BboxLL = { south: 35.500, north: 35.503, west: -80.410, east: -80.407 };
    const step = adaptiveGridStep(tight, { minSamplesPerSide: 6, maxPoints: 5000 });
    // shortSide 0.003° / 6 = 0.0005° → denser than 0.0012, above the 0.00035 floor.
    expect(step).toBeLessThan(0.0012);
    expect(step).toBeGreaterThanOrEqual(0.00035);
  });

  it("never exceeds the point budget for a large box", () => {
    const big: BboxLL = { south: 35.4, north: 35.7, west: -80.6, east: -80.3 };
    const maxPoints = 2500;
    const step = adaptiveGridStep(big, { minSamplesPerSide: 6, maxPoints });
    const cols = Math.floor((big.east - big.west) / step) + 1;
    const rows = Math.floor((big.north - big.south) / step) + 1;
    expect(cols * rows).toBeLessThanOrEqual(maxPoints);
  });

  it("respects the floor and ceiling when the budget isn't binding", () => {
    const speck: BboxLL = { south: 35.5, north: 35.50001, west: -80.4, east: -80.39999 };
    expect(adaptiveGridStep(speck, { floorDeg: 0.00035 })).toBeGreaterThanOrEqual(0.00035);
    // Budget high enough that the ceiling is the binding constraint → step == ceil.
    const huge: BboxLL = { south: 30, north: 40, west: -90, east: -80 };
    expect(adaptiveGridStep(huge, { ceilDeg: 0.006, maxPoints: 10_000_000 })).toBeLessThanOrEqual(0.006);
  });

  it("lets the point budget override the ceiling for a huge box (cost guard wins)", () => {
    const huge: BboxLL = { south: 30, north: 40, west: -90, east: -80 };
    const maxPoints = 500;
    const step = adaptiveGridStep(huge, { ceilDeg: 0.006, maxPoints });
    const cols = Math.floor((huge.east - huge.west) / step) + 1;
    const rows = Math.floor((huge.north - huge.south) / step) + 1;
    expect(cols * rows).toBeLessThanOrEqual(maxPoints); // budget honored even past ceil
  });
});

describe("pooledMap", () => {
  it("preserves input order regardless of completion order", async () => {
    const out = await pooledMap([5, 1, 3], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30]);
  });

  it("never runs more than `limit` tasks at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await pooledMap(Array.from({ length: 20 }, (_, i) => i), 4, async (i) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // it really did run concurrently
  });

  it("handles limit >= n and an empty list", async () => {
    expect(await pooledMap([], 8, async () => 1)).toEqual([]);
    expect(await pooledMap([1, 2], 99, async (n) => n + 1)).toEqual([2, 3]);
  });
});

describe("backoffDelayMs", () => {
  it("stays within [0, exp) and grows with attempts", () => {
    const d0 = backoffDelayMs(0, { baseMs: 400, capMs: 3000, rand: () => 0.999 });
    const d2 = backoffDelayMs(2, { baseMs: 400, capMs: 3000, rand: () => 0.999 });
    expect(d0).toBeGreaterThanOrEqual(0);
    expect(d0).toBeLessThan(400);
    expect(d2).toBeGreaterThan(d0);
  });

  it("is capped", () => {
    const d = backoffDelayMs(20, { baseMs: 400, capMs: 3000, rand: () => 0.999 });
    expect(d).toBeLessThan(3000);
  });
});

// ── The headline test: a bbox over Nard Ln resolves a non-empty address list ──
// Mapbox is stubbed with realistic reverse-geocode responses. Coordinates are
// representative of a Rowan County, NC subdivision; the point is the ENUMERATION
// logic (adaptive grid + dedupe + edge buffer), not the live geocoder.
describe("harvestBboxAddresses over a new-construction box (Nard Ln)", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Tight box around the new street.
  const box: BboxLL = { south: 35.5000, north: 35.5030, west: -80.4100, east: -80.4070 };

  // Six real homes inside the box, one edge home just PAST the north edge (kept
  // by the one-step buffer), and one far-away home that must be dropped.
  const HOMES = [
    { addr: "402 Nard Ln", lng: -80.4085, lat: 35.5015 },
    { addr: "403 Nard Ln", lng: -80.4088, lat: 35.5018 },
    { addr: "407 Nard Ln", lng: -80.4082, lat: 35.5012 },
    { addr: "410 Nard Ln", lng: -80.4079, lat: 35.5010 },
    { addr: "411 Nard Ln", lng: -80.4076, lat: 35.5008 },
    { addr: "414 Nard Ln", lng: -80.4073, lat: 35.5033 }, // 0.0003° past north edge → within buffer
    { addr: "900 Faraway Rd", lng: -80.4200, lat: 35.5200 }, // well outside box + buffer → dropped
  ];

  function stubMapbox() {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        features: HOMES.map((h) => ({
          place_name: `${h.addr}, Rockwell, North Carolina 28138, United States`,
          center: [h.lng, h.lat],
        })),
      }),
    })));
  }

  it("returns a NON-EMPTY address list (regression: was 0)", async () => {
    stubMapbox();
    const out = await harvestBboxAddresses(box, "NC", "test-token");
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((a) => /nard ln/i.test(a.address))).toBe(true);
  });

  it("keeps an edge house just past the box edge (buffer), drops a far one", async () => {
    stubMapbox();
    const out = await harvestBboxAddresses(box, "NC", "test-token");
    const addrs = out.map((a) => a.address.toLowerCase());
    expect(addrs).toContain("414 nard ln");        // buffered edge house kept
    expect(addrs).not.toContain("900 faraway rd");  // beyond the buffer, dropped
  });

  it("dedupes repeated hits across grid points", async () => {
    stubMapbox();
    const out = await harvestBboxAddresses(box, "NC", "test-token");
    const uniq = new Set(out.map((a) => a.address.toLowerCase()));
    expect(uniq.size).toBe(out.length); // no duplicate addresses despite many grid samples
  });
});
