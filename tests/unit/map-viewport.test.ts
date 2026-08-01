// Viewport windowing math for the 100k+-pin field map: fetch margin, keep
// region, bbox serialization, and the merge/prune that bounds client memory.
import { describe, expect, it } from "vitest";
import {
  MAP_VIEWPORT_MODE_THRESHOLD,
  VIEWPORT_FETCH_MARGIN,
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

// ── Gate-fix coverage (F1/F2/F4) ─────────────────────────────────────────────
import {
  bboxExceedsSpanGuard,
  fullFeedEnabled,
  viewportNotice,
  MAP_BBOX_MAX_SPAN_DEG,
} from "@/lib/mapViewport";

describe("bboxExceedsSpanGuard (F4)", () => {
  it("mirrors the server's 40° absolute ceiling on either axis", () => {
    expect(MAP_BBOX_MAX_SPAN_DEG).toBe(40);
    expect(bboxExceedsSpanGuard({ minLng: -100, minLat: 20, maxLng: -60, maxLat: 30 })).toBe(false); // exactly 40° ok
    expect(bboxExceedsSpanGuard({ minLng: -110, minLat: 20, maxLng: -60, maxLat: 30 })).toBe(true); // lng span 50°
    expect(bboxExceedsSpanGuard({ minLng: -80.5, minLat: 5, maxLng: -80.2, maxLat: 50 })).toBe(true); // lat span 45°
  });

  it("region/state zoom (over the OLD 3° guard) now fetches — the server samples it", () => {
    // The owner's blank-map report: a whole-state view must fetch, not skip.
    const state = { minLng: -84.5, minLat: 33.7, maxLng: -75.4, maxLat: 36.6 }; // all of NC ~9°
    expect(bboxExceedsSpanGuard(expandBBox(state, VIEWPORT_FETCH_MARGIN))).toBe(false);
  });

  it("a street-zoom view + 20% margin stays far under the guard", () => {
    const view = { minLng: -80.42, minLat: 35.53, maxLng: -80.39, maxLat: 35.55 };
    expect(bboxExceedsSpanGuard(expandBBox(view, VIEWPORT_FETCH_MARGIN))).toBe(false);
  });
});

describe("fullFeedEnabled (F2 first-load race)", () => {
  const T = 60_000;
  it("parks the full feed while the count probe is in flight", () => {
    expect(fullFeedEnabled({ signedIn: true, countIsError: false, countTotal: undefined, threshold: T })).toBe(false);
    expect(fullFeedEnabled({ signedIn: true, countIsError: false, countTotal: null, threshold: T })).toBe(false);
  });
  it("allows the full feed only when the probe answered at/below threshold", () => {
    expect(fullFeedEnabled({ signedIn: true, countIsError: false, countTotal: 36_000, threshold: T })).toBe(true);
    expect(fullFeedEnabled({ signedIn: true, countIsError: false, countTotal: 92_718, threshold: T })).toBe(false);
  });
  it("falls back to the full feed when the probe FAILED (never an empty map)", () => {
    expect(fullFeedEnabled({ signedIn: true, countIsError: true, countTotal: undefined, threshold: T })).toBe(true);
  });
  it("signed-out never fetches", () => {
    expect(fullFeedEnabled({ signedIn: false, countIsError: true, countTotal: 1, threshold: T })).toBe(false);
  });
});

describe("viewportNotice (F1/F4 chip wiring)", () => {
  const base = { viewportMode: true, spanTooWide: false, truncated: false, spanDismissed: false, sampleDismissed: false };
  it("truncated window → the sample notice", () => {
    expect(viewportNotice({ ...base, truncated: true })).toEqual({
      kind: "sample", message: "Showing a sample — zoom in for all pins",
    });
  });
  it("non-truncated window → no notice", () => {
    expect(viewportNotice(base)).toBeNull();
  });
  it("over-wide span → the zoom notice, and it beats a stale sample flag", () => {
    expect(viewportNotice({ ...base, spanTooWide: true, truncated: true })).toEqual({
      kind: "zoom", message: "Zoom in to load pins",
    });
  });
  it("dismissal hides only its own condition; full-feed mode never notices", () => {
    expect(viewportNotice({ ...base, truncated: true, sampleDismissed: true })).toBeNull();
    expect(viewportNotice({ ...base, spanTooWide: true, spanDismissed: true })).toBeNull();
    expect(viewportNotice({ ...base, viewportMode: false, truncated: true, spanTooWide: true })).toBeNull();
  });
});

describe("truncated latest-fetch wins (F1)", () => {
  // Simulates the cache writer at MapView's viewport merge: truncated is the
  // LATEST fetched window's flag — the window covers the viewport +20% margin,
  // so it is the honest answer for what's on screen.
  const write = (_old: any, truncated: boolean) => ({ truncated });

  it("panning dense → sparse CLEARS the flag (and re-arms the dismissal reset)", () => {
    let entry = write(undefined, true);   // dense window capped
    expect(entry.truncated).toBe(true);
    entry = write(entry, false);          // panned to a sparse window
    expect(entry.truncated).toBe(false);  // chip clears
  });

  it("dismiss in dense → pan sparse (chip gone) → pan to ANOTHER dense window (chip returns, undismissed)", () => {
    // The MapView wiring this pins: sampledPins = viewportMode && truncated;
    // the dismissal-reset effect fires on sampledPins false→true, so a flag
    // that CLEARS between dense windows is what re-arms the warning.
    let dismissed = false;
    const notice = (viewportMode: boolean, truncated: boolean) => {
      if (!truncated) dismissed = false; // the reset effect
      return viewportNotice({
        viewportMode, spanTooWide: false, truncated,
        spanDismissed: false, sampleDismissed: dismissed,
      });
    };
    // Dense window: chip shows; user dismisses it.
    expect(notice(true, true)?.kind).toBe("sample");
    dismissed = true;
    expect(notice(true, true)).toBeNull();
    // Pan to a sparse window: flag clears, chip gone, dismissal resets.
    expect(notice(true, false)).toBeNull();
    expect(dismissed).toBe(false);
    // Pan to ANOTHER dense truncated window: the warning returns.
    expect(notice(true, true)?.kind).toBe("sample");
  });
});

// ── First-use empty state gate (owner report: "no leads" over a full state) ──
import { firstUseEmptyStateEnabled } from "@/lib/mapViewport";

describe("firstUseEmptyStateEnabled", () => {
  it("NEVER shows in viewport mode — the mode itself proves the org has leads", () => {
    // Empty merged cache in viewport mode means unfetched/over-water/sampled,
    // not "no leads" — the count probe answered > threshold to get here.
    expect(firstUseEmptyStateEnabled({ viewportMode: true, pinsArrived: true, leadCount: 0 })).toBe(false);
    expect(firstUseEmptyStateEnabled({ viewportMode: true, pinsArrived: false, leadCount: 0 })).toBe(false);
  });

  it("full-feed mode keeps the old rule: payload arrived AND genuinely empty", () => {
    expect(firstUseEmptyStateEnabled({ viewportMode: false, pinsArrived: true, leadCount: 0 })).toBe(true);
    expect(firstUseEmptyStateEnabled({ viewportMode: false, pinsArrived: false, leadCount: 0 })).toBe(false); // fetch in flight
    expect(firstUseEmptyStateEnabled({ viewportMode: false, pinsArrived: true, leadCount: 12 })).toBe(false);
  });
});

// ── Sampled wide-window merges ───────────────────────────────────────────────
describe("mergeViewportPins with a sampled (thinned) wide window", () => {
  const pin = (id: number, lat: number, lng: number) => ({ id, lat, lng });

  it("a thinned fetch never evicts previously loaded in-window pins", () => {
    // The user loaded a dense street (ids 1..4), then zoomed out to a wide
    // window whose sample only returns every other id. The missing ids are
    // thinned, NOT deleted — they must survive the merge (and cluster).
    const wideView = { minLng: -84, minLat: 34, maxLng: -76, maxLat: 37 };
    const dense = [pin(1, 35.5, -80.4), pin(2, 35.5, -80.41), pin(3, 35.5, -80.42), pin(4, 35.5, -80.43)];
    const sample = [pin(2, 35.5, -80.41), pin(4, 35.5, -80.43), pin(9000, 34.2, -77.9)];
    const { pins, added, pruned } = mergeViewportPins(dense, sample, keepRegion(wideView));
    expect(pruned).toBe(0);
    expect(added).toBe(1); // only the genuinely-new far pin
    expect(pins.map((p) => p.id).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 9000]);
  });
});

// ── currentFetchWindow (fetch/refresher share ONE bounds read) ───────────────
import { currentFetchWindow } from "@/lib/mapViewport";

describe("currentFetchWindow", () => {
  const mapAt = (w: number, s: number, e: number, n: number) => ({
    getBounds: () => ({ getWest: () => w, getSouth: () => s, getEast: () => e, getNorth: () => n }),
  });

  it("returns raw view + margin-expanded window", () => {
    const r = currentFetchWindow(mapAt(-80.6, 35.4, -80.2, 35.6))!;
    expect(r.view).toEqual({ minLng: -80.6, minLat: 35.4, maxLng: -80.2, maxLat: 35.6 });
    expect(r.window.minLng).toBeCloseTo(-80.68, 6);
    expect(r.window.maxLat).toBeCloseTo(35.64, 6);
  });

  it("is null for a missing map, a throwing map, and degenerate bounds", () => {
    expect(currentFetchWindow(null)).toBeNull();
    expect(currentFetchWindow({ getBounds: () => { throw new Error("teardown"); } })).toBeNull();
    expect(currentFetchWindow(mapAt(0, 0, 0, 0))).toBeNull();
  });

  it("street and regional windows pass the ceiling; a continental one trips it", () => {
    const street = currentFetchWindow(mapAt(-80.42, 35.53, -80.39, 35.55))!;
    expect(bboxExceedsSpanGuard(street.window)).toBe(false);
    // Regional zoom used to trip the old 3° guard and blank the map — now it
    // fetches (the server samples the window).
    const region = currentFetchWindow(mapAt(-82, 34, -79, 36))!;
    expect(bboxExceedsSpanGuard(region.window)).toBe(false);
    const continent = currentFetchWindow(mapAt(-125, 25, -66, 49))!;
    expect(bboxExceedsSpanGuard(continent.window)).toBe(true);
  });
});
