// Three-tier field map wiring (source-level): the tier dispatch, the no-gap
// handoff, and the shared-layer installer are ordering/structure properties
// the source states directly — rendering MapView for real needs mapbox + ~8k
// lines of page (same spirit as map-one-tap-add.test.ts). The pure math
// behind each assertion lives in map-grid.test.ts / map-viewport.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "client/src/pages/MapView.tsx"), "utf8");
const pins = readFileSync(join(ROOT, "client/src/lib/mapPins.ts"), "utf8");

describe("tier dispatch — refreshViewportPins is the ONE entry point", () => {
  const body = src.slice(
    src.indexOf("const refreshViewportPins = useCallback"),
    src.indexOf("const refreshViewportPinsRef"),
  );

  it("picks the tier from the fetch window via the shared pure function", () => {
    expect(body).toContain("viewportTierForWindow(bounds.window)");
  });

  it("grid tier fetches the grid; pins tier fetches pins — never both", () => {
    expect(body).toContain('if (tier === "grid") fetchViewportGridRef.current();');
    expect(body).toContain("else fetchViewportPinsRef.current();");
  });

  it("owns the tier React state (change-only) so the fetch callbacks stay pure", () => {
    expect(body).toContain("setViewportTier((prev) => (prev === tier ? prev : tier))");
  });
});

describe("the grid→pins handoff has NO empty gap", () => {
  it("a crossing to the pins tier arms the landed-guard (density lingers)", () => {
    const refresh = src.slice(
      src.indexOf("const refreshViewportPins = useCallback"),
      src.indexOf("const refreshViewportPinsRef"),
    );
    expect(refresh).toContain("pinWindowLandedRef.current = false");
  });

  it("the pin window landing releases the guard and syncs layers immediately", () => {
    const fetchBody = src.slice(
      src.indexOf("const fetchViewportPins = useCallback"),
      src.indexOf("const fetchViewportPinsRef"),
    );
    const land = fetchBody.indexOf("pinWindowLandedRef.current = true");
    expect(land).toBeGreaterThan(-1);
    expect(fetchBody.indexOf("syncViewportTierLayers(mapRef.current)")).toBeGreaterThan(-1);
    // …BEFORE the cache merge — the handoff is a map-thread op, not a render.
    expect(fetchBody.indexOf('qc.setQueryData(["/api/leads/map"]')).toBeGreaterThan(land);
  });

  it("the layer sync hides stale pin clusters in the grid tier and vice versa", () => {
    const sync = src.slice(
      src.indexOf("const syncViewportTierLayers = useCallback"),
      src.indexOf("// INVISIBLE by contract"),
    );
    expect(sync).toContain("DENSITY_LAYER_IDS");
    expect(sync).toContain("GRID_TIER_HIDDEN_LAYER_IDS");
    // Density shows once the active tier's window has LANDED: immediately in
    // a landed grid tier, or while a pins-tier window is still in flight.
    expect(sync).toContain('gridActive ? gridWindowLandedRef.current : !pinWindowLandedRef.current');
    // …and pin clusters stay up in the grid tier until its first window
    // lands (the pins→grid handoff) — never both tiers dark.
    expect(sync).toContain('!gridActive || !gridWindowLandedRef.current');
  });

  it("a pins→grid crossing arms the grid landed-guard (stale pins linger)", () => {
    const refresh = src.slice(
      src.indexOf("const refreshViewportPins = useCallback"),
      src.indexOf("const refreshViewportPinsRef"),
    );
    expect(refresh).toContain("gridWindowLandedRef.current = false");
  });

  it("the grid window landing releases the guard — success only", () => {
    const body = src.slice(
      src.indexOf("const fetchViewportGrid = useCallback"),
      src.indexOf("const fetchViewportGridRef"),
    );
    // Fresh response: mark landed + hand off BEFORE the cache write.
    const land = body.indexOf("gridWindowLandedRef.current = true");
    expect(land).toBeGreaterThan(-1);
    expect(body.indexOf('qc.setQueryData(["/api/leads/map/grid"], data)')).toBeGreaterThan(land);
    // Cache hit ALSO counts as landed (a cached window is a landed window).
    const hitBranch = body.slice(body.indexOf("if (hit &&"), body.indexOf("gridAbortRef.current?.abort()"));
    expect(hitBranch).toContain("gridWindowLandedRef.current = true");
    expect(hitBranch).toContain("syncViewportTierLayers(mapRef.current)");
  });

  it("a FAILED grid fetch re-shows the pin layers (never both tiers dark)", () => {
    const body = src.slice(
      src.indexOf("const fetchViewportGrid = useCallback"),
      src.indexOf("const fetchViewportGridRef"),
    );
    const catchBranch = body.slice(body.indexOf('.catch((err: any)'));
    // Non-abort failure: re-sync (gridWindowLandedRef stayed false → the
    // sync's showPins rule puts the stale pin clusters back on screen).
    expect(catchBranch).toContain("syncViewportTierLayers(mapRef.current)");
    // …and the catch must NOT mark the window landed.
    expect(catchBranch).not.toContain("gridWindowLandedRef.current = true");
  });

  it("tier visibility re-syncs on style swaps (setStyle wipes layout props)", () => {
    const effect = src.slice(
      src.indexOf("syncViewportTierLayers(mapRef.current);\n  }, [viewportTier"),
    );
    expect(effect.length).toBeGreaterThan(0);
  });
});

describe("density layers — one shared installer, init and style.load", () => {
  it("MapView never hand-copies the layer specs (the drift trap)", () => {
    expect(src).not.toContain("lead-density-circles\"\n");
    // Both install sites call the shared helper…
    const installs = src.split("ensureDensityLayers(map)").length - 1;
    expect(installs).toBe(2); // init block + style.load re-add block
    // …and the specs live in the lib exactly once.
    expect(pins.split("lead-density-circles").length - 1).toBeGreaterThanOrEqual(1);
    expect(pins).toContain("export function ensureDensityLayers");
  });

  it("the count label binds the EXACT cell count (no abbreviation)", () => {
    expect(pins).toContain('"text-field": ["to-string", ["get", "n"]]');
  });

  it("a tap on a bubble zooms to exactly that cell", () => {
    const clickIdx = src.indexOf('map.on("click", DENSITY_CIRCLES_LAYER');
    expect(clickIdx).toBeGreaterThan(-1);
    const handler = src.slice(clickIdx, clickIdx + 900);
    expect(handler).toContain("map.fitBounds(");
    expect(handler).toContain("f?.properties?.cell");
  });
});

describe("the grid loader has pin-fetch parity", () => {
  const body = src.slice(
    src.indexOf("const fetchViewportGrid = useCallback"),
    src.indexOf("const fetchViewportGridRef"),
  );

  it("clamps the fetch window to the server's 15° grid guard (never a 400)", () => {
    expect(body).toContain("clampToGridGuard(bounds.window");
    // …anchored on the CAMERA center (view-mid fallback) so world-clamped
    // windows keep the density under the user's territory instead of
    // drifting to Greenwich-ocean.
    expect(body).toContain("mapRef.current?.getCenter?.()");
    expect(body).toContain("bounds.view.minLng + bounds.view.maxLng");
    expect(body).toContain("bounds.view.minLat + bounds.view.maxLat");
  });

  it("caches 60s keyed by bbox+cell+tag+view", () => {
    expect(body).toContain("gridCacheKey(window, cell, tag, view)");
    expect(body).toContain("MAP_GRID_CACHE_TTL_MS");
  });

  it("aborts the superseded in-flight fetch (debounce parity)", () => {
    expect(body).toContain("gridAbortRef.current?.abort()");
    expect(body).toContain('err?.name === "AbortError"');
  });

  it("passes the FCC source lens as the server-side tag", () => {
    expect(body).toContain("sourceFilterToGridTag(filterSourceRef.current)");
    expect(body).toContain("&tag=${encodeURIComponent(tag)}");
  });

  it("passes the Latest-fiber lens as the server-side view (grid tier honors the default)", () => {
    expect(body).toContain("sourceFilterToMapView(filterSourceRef.current)");
    expect(body).toContain("&view=${view}");
  });
});

describe("the filter sheet never silently under-filters the grid tier", () => {
  it("the zoomedOutNote names EVERY lens the aggregate can't express — status, rep, field-verified", () => {
    const lensesStart = src.indexOf("const gridHiddenLenses = [");
    const lenses = src.slice(
      lensesStart,
      src.indexOf("].filter(Boolean)", lensesStart),
    );
    // Status + field-verified were covered from the start; the rep lens must
    // be there too — a manager's rep filter scopes PINS client-side, and the
    // grid bubbles would otherwise silently count every scoped door.
    expect(lenses).toContain('filterStatus !== "all"');
    expect(lenses).toContain('filterRep !== "all"');
    expect(lenses).toContain('filterSource === "field_verified"');
    // …and the note renders whenever any of them is active in the grid tier.
    const note = src.slice(src.indexOf("zoomedOutNote={"), src.indexOf("shown={mapTotalLeads.length}"));
    expect(note).toContain('viewportTier === "grid"');
    expect(note).toContain("gridHiddenLenses.length > 0");
    expect(note).toContain("apply");
  });
});

describe("no dead state remains", () => {
  it("no zoom-in chip path, no span-guard skip in the pin fetch", () => {
    expect(src).not.toContain("Zoom in to load pins");
    expect(src).not.toContain("bboxExceedsSpanGuard");
  });

  it("the map reopens on the persisted camera so the first fetch is immediate", () => {
    expect(src).toContain("readPersistedMapCamera()");
    expect(src).toContain("persistMapCamera(");
    // persist on moveend (debounced), restore at init.
    const init = src.indexOf("readPersistedMapCamera()");
    const persist = src.indexOf("persistMapCamera(");
    expect(init).toBeGreaterThan(-1);
    expect(persist).toBeGreaterThan(-1);
  });

  it("lead-write invalidations bust the 60s grid cache (no stale density)", () => {
    // The SSE map-changed handler and the visibilitychange path both clear
    // the grid cache before refreshing.
    const busts = src.split("gridCacheRef.current.clear()").length - 1;
    expect(busts).toBeGreaterThanOrEqual(2);
  });
});
