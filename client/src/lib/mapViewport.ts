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
 *  windows.
 *
 *  WAS 75k, on this reasoning: "measured Aug 2026 at 62k pins the packed feed
 *  is ~980KB on the wire (gzip) and loads in under a second". That measurement
 *  was taken on a healthy box and no longer describes production.
 *
 *  Measured in production 2026-08-10 (perf-report.yml, 14:13-14:28 window):
 *      GET /api/leads/map   rows=69059  truncated=0  cache=miss
 *                           dbMs=2130   TOTAL=32698ms
 *  69,059 sat just under the 75k threshold, so every field map took the FULL
 *  FEED path - which has no row cap at all (the bbox path caps at
 *  MAP_BBOX_ROW_CAP). One such request materialises ~69k rows, builds ~69k pin
 *  objects and packs them synchronously on an HTTP worker: 30.5s of the 32.7s
 *  was spent outside SQLite. The same report shows per-minute event-loop lag
 *  maxima of 62-97s, which a 30s synchronous serialize fully accounts for.
 *  The host is I/O-saturated (PSI io full avg60=42.7%) against an 18.8GB
 *  database, so the old "under a second" assumption cannot hold.
 *
 *  Aligned to MAP_BBOX_ROW_CAP: above one window's worth of pins, take
 *  windows. The 2026 concern about crossing this line (sampled windows, per-pan
 *  fetches) was resolved when the windowed path started rendering honest
 *  density aggregates instead of thinned samples - crossing is no longer a
 *  cliff, which is what makes lowering it safe now. */
export const MAP_VIEWPORT_MODE_THRESHOLD = 25_000;

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

/** Evidence from the last over-cap pin window: the window's span/area and the
 *  server's TRUE row count for it (shipped on truncated responses). Lets the
 *  tier decision predict "this window would truncate again" and go straight
 *  to the density grid instead of paying a fetch that comes back thinned. */
export interface TruncationEvidence {
  /** Area (lng-span × lat-span, deg²) of the window that truncated. */
  area: number;
  /** The server's true row count for that window. */
  windowCount: number;
}

/** Safety factor on the over-cap prediction: only retry the pin path when the
 *  scaled estimate sits comfortably under the cap, so a borderline zoom-in
 *  doesn't ping-pong pins→grid→pins on density noise. */
export const TRUNCATION_RETRY_FACTOR = 0.85;

/** Predicted row count for `w` given evidence from a previously truncated
 *  window, assuming uniform density (the honest first-order model — density
 *  is NOT uniform, hence the retry factor + the server re-checking). Returns
 *  null with no evidence. */
export function predictWindowCount(w: ViewportBBox, evidence: TruncationEvidence | null | undefined): number | null {
  if (!evidence || !(evidence.area > 0) || !(evidence.windowCount > 0)) return null;
  const area = (w.maxLng - w.minLng) * (w.maxLat - w.minLat);
  if (!(area > 0)) return null;
  return evidence.windowCount * (area / evidence.area);
}

/** Which loading tier a viewport window uses: "pins" (bbox pin windows +
 *  mapbox clusters) when a complete window is plausible, "grid" (aggregated
 *  density bubbles with REAL counts) when it is not — either because the
 *  window is wider than the 3° pin-tier boundary, or because evidence from
 *  the last truncated fetch predicts this window would blow the row cap too.
 *  A sampled window is never rendered as if it were pins: thinned "pins" are
 *  indistinguishable from missing leads, which is exactly the failure the
 *  grid tier exists to kill. Pure function of (window, evidence) so the fetch
 *  path, the layer-visibility sync, and the tests all agree. NOTE: the span
 *  boundary is MAP_PIN_TIER_MAX_SPAN_DEG, NOT the 40° server ceiling. */
export function viewportTierForWindow(w: ViewportBBox, evidence?: TruncationEvidence | null): "pins" | "grid" {
  if (bboxExceedsSpanGuard(w, MAP_PIN_TIER_MAX_SPAN_DEG)) return "grid";
  const predicted = predictWindowCount(w, evidence);
  if (predicted != null && predicted > MAP_BBOX_ROW_CAP * TRUNCATION_RETRY_FACTOR) return "grid";
  return "pins";
}

/** The cell pitch the server picks for ?cell=auto (mirrors gridCellForSpan
 *  in routes.ts): span/24 snapped to 0.01° steps, clamped to [0.01°, 5°] —
 *  ~24 cells across the view, so the density tier reads like a cluster map
 *  (fine enough to see WHERE in a city the leads sit) while the payload
 *  stays bounded: ~24×24 core cells + margin ≈ well under the 5k cell cap at
 *  every span. (Was span/12 on an 0.05° lattice — at city spans that painted
 *  a dozen 5km bubbles: honest counts, useless geometry. The divisor is the
 *  knob that matters; the finer lattice just lets small spans use it.) The
 *  client computes the same value to key its response cache (never to
 *  override the server's choice). */
export function gridCellForSpan(spanDeg: number): number {
  const snapped = Math.round(spanDeg / 24 / 0.01) * 0.01;
  return Math.min(5, Math.max(0.01, Number(snapped.toFixed(2))));
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
 *  cell CENTER, n the scoped lead count inside it. `fresh` counts the
 *  confirmed-fresh leads in the cell (same predicate as the cluster ring's
 *  fresh_count — lead_tag = 'fresh_fiber_confirmed') so the money layer stays
 *  visible on the density tier too; absent/0 on older servers. */
export interface MapGridCell {
  lat: number;
  lng: number;
  n: number;
  fresh?: number;
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
      properties: { n: c.n, cell, fresh: c.fresh ?? 0 },
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
 *  shows a sample, and the user must know. It never shows on the grid tier:
 *  an over-cap window now FLIPS to the grid (real counts, nothing hidden), so
 *  warning there would cry wolf over an honest display. Dismissal resets when
 *  the condition clears (owned by the caller). */
export function viewportNotice(opts: {
  viewportMode: boolean;
  truncated: boolean;
  sampleDismissed: boolean;
  tier?: "pins" | "grid";
}): { kind: "sample"; message: string } | null {
  if (!opts.viewportMode) return null;
  if (opts.tier === "grid") return null;
  if (opts.truncated && !opts.sampleDismissed) {
    return { kind: "sample", message: "Showing a sample - zoom in for all pins" };
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
