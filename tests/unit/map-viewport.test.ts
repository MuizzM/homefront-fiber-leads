// Viewport windowing math for the 100k+-pin field map: fetch margin, keep
// region, bbox serialization, and the merge/prune that bounds client memory.
import { describe, expect, it } from "vitest";
import {
  MAP_VIEWPORT_MODE_THRESHOLD,
  MAP_BBOX_ROW_CAP,
  VIEWPORT_FETCH_MARGIN,
  expandBBox,
  keepRegion,
  inBBox,
  bboxParam,
  mergeViewportPins,
  fullFeedEnabled,
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

  it("merges by id - fetched wins, survivors keep their objects", () => {
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
  it("is one window's worth of pins - never more than the bbox path would cap", () => {
    // WAS 75k, on an Aug 2026 measurement of "62k pins = ~980KB gzipped, <1s
    // load". Production 2026-08-10 (perf-report.yml) measured what that
    // actually costs now:
    //     GET /api/leads/map  rows=69059  truncated=0  dbMs=2130  TOTAL=32698ms
    // 69,059 sat just under 75k, so every field map took the FULL FEED path,
    // which has NO row cap - 30.5s of that request was spent outside SQLite
    // building and packing ~69k pin objects synchronously on an HTTP worker.
    // The same report shows per-minute event-loop lag maxima of 62-97s.
    //
    // The threshold is now tied to the per-window cap: if a scope holds more
    // pins than one window may return, it takes windows.
    expect(MAP_VIEWPORT_MODE_THRESHOLD).toBe(MAP_BBOX_ROW_CAP);
    expect(MAP_VIEWPORT_MODE_THRESHOLD).toBe(25_000);
  });

  it("routes the measured 69k production scope to windows, not the full feed", () => {
    // The regression this exists to prevent: a scope that fits under the
    // threshold takes an uncapped full feed and blocks a worker for ~30s.
    expect(fullFeedEnabled({ signedIn: true, countIsError: false, countTotal: 69_059 })).toBe(false);
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

  it("region/state zoom (over the OLD 3° guard) now fetches - the server samples it", () => {
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

describe("viewportNotice (F1 chip wiring)", () => {
  const base = { viewportMode: true, truncated: false, sampleDismissed: false };
  it("truncated window → the sample notice", () => {
    expect(viewportNotice({ ...base, truncated: true })).toEqual({
      kind: "sample", message: "Showing a sample - zoom in for all pins",
    });
  });
  it("non-truncated window → no notice", () => {
    expect(viewportNotice(base)).toBeNull();
  });
  it("there is NO zoom-in notice anymore - wide zooms render the density grid", () => {
    // The old spanTooWide/"Zoom in to load pins" dead state is gone: past the
    // pin span guard the grid tier renders, so the notice function has no
    // zoom branch at all.
    expect(viewportNotice(base)).toBeNull();
    expect("spanTooWide" in base).toBe(false);
  });
  it("dismissal hides the chip; full-feed mode never notices", () => {
    expect(viewportNotice({ ...base, truncated: true, sampleDismissed: true })).toBeNull();
    expect(viewportNotice({ ...base, viewportMode: false, truncated: true })).toBeNull();
  });
  it("never warns on the grid tier - density bubbles are complete counts, not a sample", () => {
    expect(viewportNotice({ ...base, truncated: true, tier: "grid" })).toBeNull();
    expect(viewportNotice({ ...base, truncated: true, tier: "pins" })).not.toBeNull();
  });
});

// ── Honest-tier flip: over-cap windows render the grid, never a sample ──────
import { predictWindowCount, viewportTierForWindow as tierFor, MAP_BBOX_ROW_CAP, TRUNCATION_RETRY_FACTOR } from "@/lib/mapViewport";

describe("truncation evidence → tier prediction", () => {
  // A city window (0.4°×0.3°) the server declared over-cap at 40k rows.
  const CITY = { minLng: -80.8, minLat: 35.2, maxLng: -80.4, maxLat: 35.5 };
  const evidence = { area: 0.4 * 0.3, windowCount: 40_000 };

  it("scales the observed count by area ratio (uniform-density model)", () => {
    expect(predictWindowCount(CITY, evidence)).toBeCloseTo(40_000, 5);
    const half = { minLng: -80.8, minLat: 35.2, maxLng: -80.6, maxLat: 35.35 }; // quarter area
    expect(predictWindowCount(half, evidence)).toBeCloseTo(10_000, 5);
    expect(predictWindowCount(CITY, null)).toBeNull();
    expect(predictWindowCount(CITY, { area: 0, windowCount: 10 })).toBeNull();
  });

  it("keeps an over-cap-predicted window on the grid tier - a thinned sample is never rendered as pins", () => {
    expect(tierFor(CITY, evidence)).toBe("grid");
    // Without evidence the same window is pins-tier (≤3° span).
    expect(tierFor(CITY)).toBe("pins");
  });

  it("re-tries pins only once the estimate sits comfortably under the cap (retry hysteresis)", () => {
    // Shrink until predicted < cap × factor: a borderline zoom-in must not
    // ping-pong pins→grid→pins on density noise.
    const atFactor = MAP_BBOX_ROW_CAP * TRUNCATION_RETRY_FACTOR;
    const justOver = { minLng: -80.8, minLat: 35.2, maxLng: -80.8 + 0.4 * Math.sqrt((atFactor + 500) / 40_000), maxLat: 35.2 + 0.3 * Math.sqrt((atFactor + 500) / 40_000) };
    const justUnder = { minLng: -80.8, minLat: 35.2, maxLng: -80.8 + 0.4 * Math.sqrt((atFactor - 500) / 40_000), maxLat: 35.2 + 0.3 * Math.sqrt((atFactor - 500) / 40_000) };
    expect(tierFor(justOver, evidence)).toBe("grid");
    expect(tierFor(justUnder, evidence)).toBe("pins");
  });

  it("span guard still wins regardless of evidence", () => {
    const state = { minLng: -84.5, minLat: 33.7, maxLng: -75.3, maxLat: 36.7 };
    expect(tierFor(state, null)).toBe("grid");
    expect(tierFor(state, { area: 100, windowCount: 1 })).toBe("grid");
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
        viewportMode, truncated,
        sampleDismissed: dismissed,
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
  it("NEVER shows in viewport mode - the mode itself proves the org has leads", () => {
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
