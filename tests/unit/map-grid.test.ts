// Density-grid tier math for the wide-zoom field map: tier selection by span,
// the auto cell formula (mirrors the server), the 15° clamp, the response
// cache key, the FCC source→tag mapping, and the GeoJSON the density layers
// render. Pure — no map, no network.
import { describe, expect, it } from "vitest";
import {
  MAP_BBOX_MAX_SPAN_DEG,
  MAP_PIN_TIER_MAX_SPAN_DEG,
  MAP_GRID_MAX_SPAN_DEG,
  MAP_GRID_CACHE_TTL_MS,
  viewportTierForWindow,
  gridCellForSpan,
  clampToGridGuard,
  gridCacheKey,
  sourceFilterToGridTag,
  sourceFilterToMapView,
  gridCellsToGeoJson,
  bboxParam,
  expandBBox,
  currentFetchWindow,
  type MapGridCell,
} from "@/lib/mapViewport";

describe("viewportTierForWindow — tier selection by span", () => {
  const win = (lngSpan: number, latSpan: number) => ({
    minLng: -80, minLat: 35, maxLng: -80 + lngSpan, maxLat: 35 + latSpan,
  });

  it("is the pins tier at and under the 3° span guard", () => {
    expect(viewportTierForWindow(win(0.05, 0.03))).toBe("pins"); // street
    expect(viewportTierForWindow(win(3, 3))).toBe("pins");       // exactly at the guard
  });

  it("is the grid tier past the guard on EITHER axis", () => {
    expect(viewportTierForWindow(win(3.01, 1))).toBe("grid");
    expect(viewportTierForWindow(win(1, 3.01))).toBe("grid");
    expect(viewportTierForWindow(win(9, 5))).toBe("grid");       // NC state view
  });

  it("a state view + 20% margin is grid; a city view + margin stays pins", () => {
    const state = { minLng: -84.5, minLat: 33.7, maxLng: -75.3, maxLat: 36.7 };
    expect(viewportTierForWindow(expandBBox(state, 0.2))).toBe("grid");
    const city = { minLng: -80.9, minLat: 35.2, maxLng: -80.5, maxLat: 35.5 };
    expect(viewportTierForWindow(expandBBox(city, 0.2))).toBe("pins");
  });

  it("shares currentFetchWindow's bounds read with the pin path", () => {
    const mapAt = (w: number, s: number, e: number, n: number) => ({
      getBounds: () => ({ getWest: () => w, getSouth: () => s, getEast: () => e, getNorth: () => n }),
    });
    const street = currentFetchWindow(mapAt(-80.42, 35.53, -80.39, 35.55))!;
    expect(viewportTierForWindow(street.window)).toBe("pins");
    const region = currentFetchWindow(mapAt(-82, 34, -79, 36))!;
    expect(viewportTierForWindow(region.window)).toBe("grid");
  });
});

describe("gridCellForSpan — the ?cell=auto formula (mirrors the server)", () => {
  it("is span/12 snapped to 0.05° steps, clamped to [0.05°, 5°]", () => {
    expect(gridCellForSpan(3)).toBe(0.25);     // the mission's example
    expect(gridCellForSpan(6)).toBe(0.5);
    expect(gridCellForSpan(9)).toBe(0.75);
    expect(gridCellForSpan(15)).toBe(1.25);
    expect(gridCellForSpan(0.36)).toBe(0.05);  // tiny window → minimum pitch
    expect(gridCellForSpan(60)).toBe(5);       // clamped at the max
  });

  it("keeps ~12 cells across the view at every zoom", () => {
    for (const span of [3.2, 5, 8, 12, 15]) {
      const cellsAcross = span / gridCellForSpan(span);
      expect(cellsAcross).toBeGreaterThanOrEqual(11);
      expect(cellsAcross).toBeLessThanOrEqual(13.5);
    }
  });
});

describe("clampToGridGuard", () => {
  it("leaves an inside-guard window untouched", () => {
    const w = { minLng: -84, minLat: 34, maxLng: -76, maxLat: 37 };
    expect(clampToGridGuard(w)).toEqual(w);
  });

  it("shrinks an over-guard window symmetric about its center, INSIDE the guard", () => {
    const w = { minLng: -100, minLat: 25, maxLng: -60, maxLat: 50 }; // 40° x 25°
    const c = clampToGridGuard(w);
    // Strictly inside the guard (serialization headroom), never exactly ON it:
    // an exactly-15° window rounds/parses to 15.000000000000002° server-side
    // and 400s — the production blank-density defect.
    expect(c.maxLng - c.minLng).toBeLessThan(MAP_GRID_MAX_SPAN_DEG);
    expect(c.maxLng - c.minLng).toBeGreaterThan(MAP_GRID_MAX_SPAN_DEG - 1e-3);
    expect(c.maxLat - c.minLat).toBeLessThan(MAP_GRID_MAX_SPAN_DEG);
    expect(c.maxLat - c.minLat).toBeGreaterThan(MAP_GRID_MAX_SPAN_DEG - 1e-3);
    // centered on the original view — density where the user is looking
    expect((c.minLng + c.maxLng) / 2).toBeCloseTo((w.minLng + w.maxLng) / 2, 9);
    expect((c.minLat + c.maxLat) / 2).toBeCloseTo((w.minLat + w.maxLat) / 2, 9);
  });

  it("clamps only the axis that exceeds the guard", () => {
    const w = { minLng: -84, minLat: 0, maxLng: -76, maxLat: 40 };
    const c = clampToGridGuard(w);
    expect(c.minLng).toBe(-84);
    expect(c.maxLng).toBe(-76);
    expect(c.maxLat - c.minLat).toBeLessThan(15);
    expect(c.maxLat - c.minLat).toBeGreaterThan(14.999);
  });

  // ── Regression: the production blank-map incident ─────────────────────────
  // A clamped window serialized with bboxParam (5dp) and re-parsed as binary
  // doubles (exactly what the server does) MUST never exceed the 15° guard.
  // Before the headroom fix, a view centered near lng -80.4 clamped to
  // [-87.9, -72.9], whose parsed span is 15.000000000000002 → the server
  // 400'd, the catch swallowed it, and the density tier rendered NOTHING —
  // no bubbles AND no pins (the pin fetch is tier-gated off past 3°).
  it("a clamped window NEVER serializes to a span the server rejects", () => {
    const centers = [
      [-80.4, 35.3],   // the observed production repro (Rockwell territory)
      [-80.41, 35.545],
      [-97.7431, 30.2672],
      [-118.2437, 34.0522],
      [151.2093, -33.8688],
    ] as const;
    for (const [lng, lat] of centers) {
      for (const viewSpan of [16, 21.1, 28, 42.2, 94.7]) {
        const w = {
          minLng: lng - viewSpan / 2, maxLng: lng + viewSpan / 2,
          minLat: lat - viewSpan / 4, maxLat: lat + viewSpan / 4,
        };
        const clamped = clampToGridGuard(w);
        const parsed = bboxParam(clamped).split(",").map(Number);
        expect(parsed[2] - parsed[0], `lng span for center ${lng},${lat} view ${viewSpan}`)
          .toBeLessThanOrEqual(MAP_GRID_MAX_SPAN_DEG);
        expect(parsed[3] - parsed[1], `lat span for center ${lng},${lat} view ${viewSpan}`)
          .toBeLessThanOrEqual(MAP_GRID_MAX_SPAN_DEG);
      }
    }
  });

  // ── Regression: world-zoom windows must cover the VIEW, not Greenwich ─────
  // A world-spanning fetch window has already been clamped to ±180/±90 by
  // expandBBox, dragging its midpoint to 0°,0°. Clamping about THAT midpoint
  // fetched density for the Greenwich ocean while the user looked at their
  // territory — deterministic empty cells (a blank map) at world zooms. The
  // view-center anchor keeps the density under the user's territory.
  it("anchors the clamp on the raw view center when given (world-clamped windows)", () => {
    const world = { minLng: -180, minLat: -85, maxLng: 180, maxLat: 85 };
    const c = clampToGridGuard(world, undefined, { lng: -80.4, lat: 35.5 });
    expect(c.minLng).toBeLessThan(-80.4);
    expect(c.maxLng).toBeGreaterThan(-80.4);
    expect(c.minLat).toBeLessThan(35.5);
    expect(c.maxLat).toBeGreaterThan(35.5);
    // …and Greenwich is NOT in the fetched window.
    expect(c.maxLng).toBeLessThan(0);
  });
});

describe("gridCacheKey — 60s response cache identity", () => {
  const w = { minLng: -84.3, minLat: 33.8, maxLng: -75.5, maxLat: 36.6 };

  it("is bbox + cell + tag", () => {
    expect(gridCacheKey(w, 0.75)).toBe(`${bboxParam(w)}|0.75|`);
    expect(gridCacheKey(w, 0.75, "fcc_fiber")).toBe(`${bboxParam(w)}|0.75|fcc_fiber`);
  });

  it("tag changes re-key the fetch (FCC lens applies in the grid tier)", () => {
    expect(gridCacheKey(w, 0.75, "fcc_fresh")).not.toBe(gridCacheKey(w, 0.75, "fcc_fiber"));
  });

  it("the view segment re-keys the lens and is absent (byte-stable) when unfiltered", () => {
    expect(gridCacheKey(w, 0.75, undefined, "latest")).toBe(`${bboxParam(w)}|0.75||latest`);
    expect(gridCacheKey(w, 0.75, undefined, "latest")).not.toBe(gridCacheKey(w, 0.75));
    expect(gridCacheKey(w, 0.75, "fcc_fiber", "latest")).not.toBe(gridCacheKey(w, 0.75, "fcc_fiber"));
  });

  it("the TTL mirrors the full feed's freshness budget", () => {
    expect(MAP_GRID_CACHE_TTL_MS).toBe(60_000);
  });
});

describe("sourceFilterToGridTag", () => {
  it("maps the FCC tag families to their server-side prefixes", () => {
    expect(sourceFilterToGridTag("fcc_fresh")).toBe("fcc_fresh");
    expect(sourceFilterToGridTag("fcc_fiber")).toBe("fcc_fiber");
  });

  it("returns undefined for lenses the aggregate can't express", () => {
    expect(sourceFilterToGridTag("all")).toBeUndefined();
    // field_verified is pin-level provenance (freshConfirmedAt), no tag —
    // the filter sheet carries the "applies when zoomed in" hint instead.
    expect(sourceFilterToGridTag("field_verified")).toBeUndefined();
  });
});

describe("sourceFilterToMapView — the lens as the server-side ?view=", () => {
  it("maps ONLY latest to a view; every other lens keeps a byte-stable URL", () => {
    expect(sourceFilterToMapView("latest")).toBe("latest");
    expect(sourceFilterToMapView("all")).toBeUndefined();
    expect(sourceFilterToMapView("fcc_fresh")).toBeUndefined();
    expect(sourceFilterToMapView("fcc_fiber")).toBeUndefined();
    expect(sourceFilterToMapView("field_verified")).toBeUndefined();
  });

  it("latest has NO grid tag equivalent (view and tag are orthogonal lenses)", () => {
    expect(sourceFilterToGridTag("latest")).toBeUndefined();
    expect(sourceFilterToMapView("latest")).toBe("latest");
  });
});

describe("gridCellsToGeoJson — what the density bubble renders", () => {
  const cells: MapGridCell[] = [
    { lat: 35.375, lng: -80.375, n: 1241 },
    { lat: 35.875, lng: -79.875, n: 7 },
  ];

  it("emits one point feature per cell with the EXACT count + cell pitch", () => {
    const gj = gridCellsToGeoJson(cells, 0.25);
    expect(gj.type).toBe("FeatureCollection");
    expect(gj.features).toHaveLength(2);
    const [a, b] = gj.features;
    expect(a.geometry).toEqual({ type: "Point", coordinates: [-80.375, 35.375] });
    expect(a.properties.n).toBe(1241); // drives radius/color AND the count label
    expect(a.properties.cell).toBe(0.25); // the tap-to-zoom handler's bounds
    expect(b.properties.n).toBe(7);
  });

  it("an empty grid is an empty collection (never a crash on first paint)", () => {
    expect(gridCellsToGeoJson([], 0.5).features).toEqual([]);
  });
});

describe("guard constants mirror the server", () => {
  it("pin ceiling 40° (#91), pin-tier boundary 3°, grid span guard 15°", () => {
    // The 40° pin-window ceiling is #91's sampled-overview contract (server
    // never 400s below it); the 3° boundary is where the CLIENT stops
    // rendering pins and switches to the density tier.
    expect(MAP_BBOX_MAX_SPAN_DEG).toBe(40);
    expect(MAP_PIN_TIER_MAX_SPAN_DEG).toBe(3);
    expect(MAP_GRID_MAX_SPAN_DEG).toBe(15);
  });
});
