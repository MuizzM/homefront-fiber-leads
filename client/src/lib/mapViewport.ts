// ── Viewport (bbox) windowing for the 100k+-pin field map ───────────────────
// Past MAP_VIEWPORT_MODE_THRESHOLD scoped pins the full single-fetch model
// breaks: multi-MB payloads, a full serialize per poll, and 100k+ feature
// objects in client memory. In viewport mode the map fetches only the pins
// inside the current view (+ a margin) on moveend, merges them into the SAME
// ["/api/leads/map"] query cache the full feed writes (so every downstream
// consumer — dedupe, filters, reconcile, knock/assignment optimistic updates —
// works unchanged in both modes), and prunes pins that drifted far off-screen.
//
// Everything here is pure so the windowing rules are unit-testable without a
// map.

/** Scoped pin total above which the map switches from full feed to bbox
 *  windows. 60k: the packed full feed at 60k pins is ~2-3MB and a steady-state
 *  304 poll stays cheap; past it the windowed path wins outright. */
export const MAP_VIEWPORT_MODE_THRESHOLD = 60_000;

/** Fetch margin around the visible bounds: panning a little inside the margin
 *  needs no refetch, so ordinary door-to-door movement doesn't hit the server. */
export const VIEWPORT_FETCH_MARGIN = 0.2;

/** Pins are KEPT while inside the viewport expanded to this multiple of the
 *  viewport span (centered) — 3× means a one-screen pan in any direction never
 *  leaves the kept set, and memory stays bounded on long sessions. */
export const VIEWPORT_KEEP_MULTIPLE = 3;

/** Server-side per-window row cap (mirrors MAP_BBOX_ROW_CAP in routes.ts).
 *  Only used to surface truncation; the server is the authority. */
export const MAP_BBOX_ROW_CAP = 25_000;

/** Server-side pin-window span ceiling (mirrors MAP_BBOX_MAX_SPAN_DEG in
 *  routes.ts). Under it EVERY pin window is answerable — the server evenly
 *  samples over-dense windows instead of rejecting them, so nothing is a 400
 *  until a wider-than-40° (continental — effectively malformed) request. */
export const MAP_BBOX_MAX_SPAN_DEG = 40;

/** Pin-tier comfort boundary: at/under it a bbox window returns real pins
 *  (a ≤3° window over even the densest territory stays near the 25k row
 *  cap). Past it the server would answer with a heavily-thinned SAMPLE —
 *  the wrong thing to render as "pins" — so the client switches to the
 *  density-grid tier instead. This is a CLIENT tier boundary, not a server
 *  guard: the pin path accepts up to MAP_BBOX_MAX_SPAN_DEG. */
export const MAP_PIN_TIER_MAX_SPAN_DEG = 3;

/** Server-side span guard for the density grid (mirrors
 *  MAP_GRID_MAX_SPAN_DEG in routes.ts). Past it even an aggregate stops
 *  being meaningful territory, so the client CLAMPS its fetch window to the
 *  guard (centered) rather than ever letting a grid request 400. */
export const MAP_GRID_MAX_SPAN_DEG = 15;

/** Hard cap on grid cells per response (mirrors MAP_GRID_CELL_CAP). */
export const MAP_GRID_CELL_CAP = 5_000;

/** Grid response cache TTL: a cell-count view of the world may lag lead
 *  writes by a minute — the same freshness budget the full feed's poll has
 *  always had. Keyed by bbox+cell+tag (see gridCacheKey). */
export const MAP_GRID_CACHE_TTL_MS = 60_000;

/** True when the (already margin-expanded) fetch window is wider than the
 *  server's span guard on either axis. */
export function bboxExceedsSpanGuard(b: ViewportBBox, guard: number = MAP_BBOX_MAX_SPAN_DEG): boolean {
  return b.maxLng - b.minLng > guard || b.maxLat - b.minLat > guard;
}

/** Which loading tier a viewport window uses: "pins" (bbox pin windows +
 *  mapbox clusters) at/under the 3° pin-tier boundary, "grid" (aggregated
 *  density bubbles) past it — where a pin window would come back a heavily
 *  thinned sample. The tier is a pure function of the window so the fetch
 *  path, the layer-visibility sync, and the tests all agree. NOTE: the
 *  boundary is MAP_PIN_TIER_MAX_SPAN_DEG, NOT the 40° server ceiling. */
export function viewportTierForWindow(w: ViewportBBox): "pins" | "grid" {
  return bboxExceedsSpanGuard(w, MAP_PIN_TIER_MAX_SPAN_DEG) ? "grid" : "pins";
}

/** The cell pitch the server picks for ?cell=auto (mirrors gridCellForSpan
 *  in routes.ts): span/12 snapped to 0.05° steps, clamped to [0.05°, 5°] —
 *  ~12 cells across the view, so a bubble is always a tap target and the
 *  payload stays ~150 cells. The client computes the same value to key its
 *  response cache (never to override the server's choice). */
export function gridCellForSpan(spanDeg: number): number {
  const snapped = Math.round(spanDeg / 12 / 0.05) * 0.05;
  return Math.min(5, Math.max(0.05, Number(snapped.toFixed(2))));
}

/** Serialization headroom for the grid clamp. The fetch bbox is rounded to
 *  5dp (bboxParam) and re-parsed as binary doubles on the server, so a window
 *  clamped to EXACTLY the guard can read back as 15.000000000000002° and trip
 *  the server's `span > guard` rejection — a silent 400 that blanked the
 *  density tier in production (no bubbles, and no pins either: the pin fetch
 *  is tier-gated off past the pin boundary). Two 5dp rounding quanta (~2m on
 *  a 15° window — invisible) guarantee the serialized span can never exceed
 *  the guard, whatever direction each endpoint rounds. */
export const GRID_CLAMP_SERIALIZATION_EPS = 2e-5;

/** Shrink a window symmetric about its center until both axes fit INSIDE the
 *  grid guard (guard minus the serialization headroom — see
 *  GRID_CLAMP_SERIALIZATION_EPS). Zoomed out past 15° the fetch covers the
 *  central ~15° of the view — density where the user is looking, never a 400.
 *
 *  `center` (when given) anchors the shrink on the RAW VIEW center instead of
 *  the window's own midpoint: a world-spanning window has already been
 *  clamped to ±180/±90 (expandBBox), which drags its midpoint toward 0°/0° —
 *  clamping about THAT midpoint fetched density for Greenwich while the user
 *  was looking at their own territory. */
export function clampToGridGuard(
  b: ViewportBBox,
  guard: number = MAP_GRID_MAX_SPAN_DEG,
  center?: { lng: number; lat: number },
): ViewportBBox {
  const inner = guard - GRID_CLAMP_SERIALIZATION_EPS;
  const clampAxis = (min: number, max: number, mid: number): [number, number] => {
    const span = max - min;
    if (span <= inner) return [min, max];
    return [mid - inner / 2, mid + inner / 2];
  };
  const [minLng, maxLng] = clampAxis(b.minLng, b.maxLng, center?.lng ?? (b.minLng + b.maxLng) / 2);
  const [minLat, maxLat] = clampAxis(b.minLat, b.maxLat, center?.lat ?? (b.minLat + b.maxLat) / 2);
  return { minLng, minLat, maxLng, maxLat };
}

/** One aggregated density cell from /api/leads/map/grid: lat/lng are the
 *  cell CENTER, n the scoped lead count inside it. */
export interface MapGridCell {
  lat: number;
  lng: number;
  n: number;
}

export interface MapGridResponse {
  cells: MapGridCell[];
  /** The grid pitch in degrees (server-chosen — auto or snapped explicit). */
  cell: number;
  truncated: boolean;
}

/** Identity of one grid fetch — the 60s cache key. Rounded like bboxParam
 *  (5dp ≈ 1m) so jittered pans of the same territory hit the same entry. The
 *  view segment is appended ONLY when present, so an unfiltered key stays
 *  byte-identical to before (and a "latest" lens can never read it). */
export function gridCacheKey(b: ViewportBBox, cell: number, tag?: string, view?: string): string {
  return `${bboxParam(b)}|${cell}|${tag ?? ""}${view ? `|${view}` : ""}`;
}

/** The FCC source lens as a server-side tag prefix (the only source
 *  predicate /grid supports). "fcc_fresh"/"fcc_fiber" map to their tag
 *  families; "field_verified" is pin-level provenance (freshConfirmedAt) with
 *  no tag equivalent, so it returns undefined — the grid shows the unfiltered
 *  density and the filter sheet says the lens applies when zoomed in. */
export function sourceFilterToGridTag(source: string): string | undefined {
  if (source === "fcc_fresh") return "fcc_fresh";
  if (source === "fcc_fiber") return "fcc_fiber";
  return undefined;
}

/** The source lens as the server-side ?view= param (the content lens every
 *  map endpoint composes into the shared scope predicate). Only "latest" has
 *  a server view: the count probe, full feed, bbox windows, and the density
 *  grid all drop the established-footprint import; every other lens stays a
 *  client-side pin predicate and returns undefined (byte-stable URLs). */
export function sourceFilterToMapView(source: string): "latest" | undefined {
  return source === "latest" ? "latest" : undefined;
}

/** Grid cells → GeoJSON points for the density layers. `n` and `cell` ride
 *  as feature properties: n drives the graduated radius/color and the exact
 *  count label, cell lets the tap handler zoom to exactly the tapped cell's
 *  bounds. */
export function gridCellsToGeoJson(cells: readonly MapGridCell[], cell: number): any {
  return {
    type: "FeatureCollection",
    features: cells.map((c) => ({
      type: "Feature",
      properties: { n: c.n, cell },
      geometry: { type: "Point", coordinates: [c.lng, c.lat] },
    })),
  };
}

/** The bbox the viewport loader would fetch right now (`window` = current
 *  map bounds + fetch margin; `view` = the raw bounds, which the keep-region
 *  prune expands from), or null when the map is missing / mid-teardown /
 *  degenerate (pre-init bounds would trip the span guard). Shared by the
 *  fetch itself and the notice-state refresher so the two can never
 *  disagree. */
export function currentFetchWindow(
  map: any,
  margin: number = VIEWPORT_FETCH_MARGIN,
): { view: ViewportBBox; window: ViewportBBox } | null {
  if (!map) return null;
  let view: ViewportBBox;
  try {
    const b = map.getBounds();
    view = {
      minLng: b.getWest(), minLat: b.getSouth(),
      maxLng: b.getEast(), maxLat: b.getNorth(),
    };
  } catch {
    return null; // map mid-teardown
  }
  if (!(view.maxLng > view.minLng) || !(view.maxLat > view.minLat)) return null;
  return { view, window: expandBBox(view, margin) };
}

/** Which amber viewport notice (if any) the map should show. There is no
 *  "zoom in to load pins" notice anymore: past the pin span guard the map
 *  renders the density-grid tier, so territory is visible at EVERY zoom. The
 *  one remaining notice is the truncated-sample warning — a 25k+ pin window
 *  shows a sample, and the user must know. Dismissal resets when the
 *  condition clears (owned by the caller). */
export function viewportNotice(opts: {
  viewportMode: boolean;
  truncated: boolean;
  sampleDismissed: boolean;
}): { kind: "sample"; message: string } | null {
  if (!opts.viewportMode) return null;
  if (opts.truncated && !opts.sampleDismissed) {
    return { kind: "sample", message: "Showing a sample — zoom in for all pins" };
  }
  return null;
}

/** The full-feed gate (F2 race fix): the multi-MB full feed may only fire
 *  once the count probe has ANSWERED at/below the viewport threshold, or when
 *  the probe failed outright (fallback to today's behaviour — never an empty
 *  map). While the probe is in flight the full feed stays parked. */
export function fullFeedEnabled(opts: {
  signedIn: boolean;
  countIsError: boolean;
  countTotal: number | null | undefined;
  threshold?: number;
}): boolean {
  if (!opts.signedIn) return false;
  if (opts.countIsError) return true;
  if (opts.countTotal == null) return false;
  return opts.countTotal <= (opts.threshold ?? MAP_VIEWPORT_MODE_THRESHOLD);
}

/** Gate for the first-use "No leads on the map yet" overlay. In viewport mode
 *  the merged cache is a WINDOW of the org's pins — empty because nothing was
 *  fetched yet, because the view sits over water, or because a wide window
 *  came back as a thin sample. None of those mean "no leads": viewport mode
 *  only activates when the count probe answered > threshold, i.e. the org
 *  provably HAS leads — so the empty state never renders there (the zoom /
 *  sample chips carry the truth instead). In full-feed mode the old rule
 *  stands: the payload arrived and it is genuinely empty. */
export function firstUseEmptyStateEnabled(opts: {
  viewportMode: boolean;
  pinsArrived: boolean;
  leadCount: number;
}): boolean {
  if (opts.viewportMode) return false;
  return opts.pinsArrived && opts.leadCount === 0;
}

export interface ViewportBBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/** Expand a bbox by `fraction` of its span on every side. */
export function expandBBox(b: ViewportBBox, fraction: number): ViewportBBox {
  const dx = (b.maxLng - b.minLng) * fraction;
  const dy = (b.maxLat - b.minLat) * fraction;
  return {
    minLng: Math.max(-180, b.minLng - dx),
    maxLng: Math.min(180, b.maxLng + dx),
    minLat: Math.max(-90, b.minLat - dy),
    maxLat: Math.min(90, b.maxLat + dy),
  };
}

/** Expand a bbox to `multiple`× its span, centered (3× = one extra viewport on
 *  every side). This is the prune region: pins outside it are dropped from the
 *  merged cache. */
export function keepRegion(b: ViewportBBox, multiple: number = VIEWPORT_KEEP_MULTIPLE): ViewportBBox {
  return expandBBox(b, (multiple - 1) / 2);
}

export function inBBox(lat: number, lng: number, b: ViewportBBox): boolean {
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

/** True when the two boxes share any area (touching edges count — a snapshot
 *  window grazing the view is still worth seeding). */
export function bboxIntersects(a: ViewportBBox, b: ViewportBBox): boolean {
  return a.minLng <= b.maxLng && b.minLng <= a.maxLng && a.minLat <= b.maxLat && b.minLat <= a.maxLat;
}

/** Approximate visible bbox for a persisted camera (center + zoom) on a given
 *  screen — standard 512px-tile Web Mercator span, the same formula the map
 *  contract tests use. Exists so the COLD OPEN can decide, BEFORE the map (or
 *  even its container) exists, whether the persisted window snapshot overlaps
 *  what the restored camera will show. Approximation is fine: the consumer is
 *  an intersection test against a margin-expanded fetch window, and a false
 *  positive only seeds pins the immediate window fetch replaces anyway. */
export function cameraViewBBox(
  center: [number, number],
  zoom: number,
  widthPx: number,
  heightPx: number,
): ViewportBBox {
  const spanLng = (360 * (widthPx / 512)) / 2 ** zoom;
  // The 1.3 divisor mirrors the mercator lat compression the grid-window
  // contract test's map stub uses — close enough for an overlap decision.
  const spanLat = (360 * (heightPx / 512)) / 2 ** zoom / 1.3;
  const [lng, lat] = center;
  return {
    minLng: Math.max(-180, lng - spanLng / 2),
    maxLng: Math.min(180, lng + spanLng / 2),
    minLat: Math.max(-90, lat - spanLat / 2),
    maxLat: Math.min(90, lat + spanLat / 2),
  };
}

export function bboxParam(b: ViewportBBox): string {
  // 5dp ≈ 1m — plenty for a fetch window, keeps the URL short.
  const r = (n: number) => Math.round(n * 1e5) / 1e5;
  return `${r(b.minLng)},${r(b.minLat)},${r(b.maxLng)},${r(b.maxLat)}`;
}

/** Merge a freshly fetched window into the accumulated pin set: new/updated
 *  pins win by id, survivors outside the keep region are pruned. Returns the
 *  SAME array reference when nothing changed so React Query's structural
 *  sharing can bail out of a no-op moveend refetch.
 *
 *  Sampled (wide-zoom) windows ride the same rule on purpose: a thinned fetch
 *  omits most in-window ids by design, so absence from `fetched` must NOT
 *  evict a previously fetched pin — zooming out keeps the dense detail the
 *  user already loaded (it clusters), and the keep-region prune still bounds
 *  memory because the wide view's keep region covers everything retained.
 *
 *  `evictWindow` is the ONE sanctioned exception, for replacing a cold-open
 *  window-snapshot SEED with server truth: when the fetch is a COMPLETE
 *  (non-truncated) window, a prev pin inside that window that the fetch did
 *  not return no longer exists (deleted / suppressed / moved since last
 *  session) and must not linger. Callers pass the fetched window ONLY when
 *  the response was complete — a sampled fetch must never evict. */
export function mergeViewportPins<T extends { id: number; lat?: number | null; lng?: number | null }>(
  prev: readonly T[],
  fetched: readonly T[],
  keep: ViewportBBox,
  evictWindow?: ViewportBBox | null,
): { pins: T[]; added: number; pruned: number } {
  const byId = new Map<number, T>();
  const fetchedIds = evictWindow ? new Set(fetched.map((p) => p.id)) : null;
  let pruned = 0;
  for (const p of prev) {
    if (p.lat != null && p.lng != null && !inBBox(p.lat, p.lng, keep)) {
      pruned++;
      continue;
    }
    if (
      fetchedIds &&
      p.lat != null && p.lng != null &&
      inBBox(p.lat, p.lng, evictWindow!) &&
      !fetchedIds.has(p.id)
    ) {
      pruned++; // stale seeded row the complete window fetch disowned
      continue;
    }
    byId.set(p.id, p);
  }
  let added = 0;
  for (const p of fetched) {
    if (!byId.has(p.id)) added++;
    byId.set(p.id, p);
  }
  return { pins: [...byId.values()], added, pruned };
}
