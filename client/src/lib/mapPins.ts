// ── Lead-pin paint + camera helpers ───────────────────────────────────────────
// Shared by MapView's init block AND its style.load re-add block so the two can
// never drift (they already had), and by tests. Colors come from @shared/knock —
// one palette for buttons, pins, and legend.

import { STATE_COLORS, haversineMeters } from "@shared/knock";
import { GLYPH_FONT_BOLD, GLYPH_FONT_REGULAR } from "@/lib/basemapStyles";

// Flat GPU match on the precomputed `ds` feature prop — no nested case logic.
// Pin hue = STATE_COLORS verbatim: one color per status, identical on the map,
// the card chip, and the status buttons. Sales Rabbit-aligned palette — fresh
// leads RED, Not Home YELLOW, Callback BLUE, Follow-up ORANGE, Sold GREEN, Not
// Interested BLACK — every state distinct at full saturation.
export const PIN_DS_COLOR: any = [
  "match", ["get", "ds"],
  ...Object.entries(STATE_COLORS).flatMap(([k, v]) => [k, v]),
  STATE_COLORS.unworked, // fallback
];

export const PIN_DS_OPACITY: any = [
  "match", ["get", "ds"],
  "unworked", 0.95,
  0.9,
];

export const UNCLUSTERED_PAINT: any = {
  "circle-color": PIN_DS_COLOR,
  // Zoom-scaled radius: small when zoomed out (less overdraw, and no blobby merge
  // in the pin-overlap band) → a real thumb target up close where a rep works
  // individual doors. Lane E2 tightened every stop ~15-20% (was 4.5/6.5/8/11) —
  // pin density first; the ±16px fat-finger hit box keeps adjacent doors
  // individually tappable even though the painted dot is smaller.
  "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 3.75, 15, 5.25, 17, 6.5, 20, 9],
  // Visited doors keep the bolder ring. NB: a "zoom" expression may only appear at
  // the TOP LEVEL of a paint property (not nested in a case), so the stroke width
  // stays zoom-independent — only the radius is zoom-scaled.
  "circle-stroke-width": ["case", ["==", ["get", "visited"], 1], 2.5, 1.5],
  "circle-stroke-color": "rgba(255,255,255,0.95)",
  "circle-opacity": PIN_DS_OPACITY,
};

// ── Selection dimming ─────────────────────────────────────────────────────────
// While a lead is selected, every OTHER unclustered pin drops to ~45% opacity so
// the selected door (full color + the white ring) owns the eye; deselect
// restores the canonical ds-opacity. Pure predicate + expression builder so the
// rule is unit-testable and the two call sites (circle layer, icon layer) agree.
// NO dimming. Pins hold their canonical opacity before, during and after a
// selection. 0.45 washed the map out — a rep almost always has a door selected,
// so the dimmed state WAS the resting state, and full colour only ever appeared
// under the pin already beneath their thumb. On a shared area several reps read
// the same doors at once, and a pin that changes strength because someone
// touched something else is noise. The selected pin is carried by its heavier
// ring and its open card; it never needed its neighbours dimmed.
export const DIMMED_PIN_OPACITY = 1;

export function isPinDimmed(
  selectedId: number | null | undefined,
  pinId: number,
): boolean {
  return selectedId != null && pinId !== selectedId;
}

// circle-opacity for lead-unclustered: selected pin keeps its ds-opacity,
// everything else dims. With no selection this IS PIN_DS_OPACITY (identity).
// The nested match inside case is legal — only "zoom" is top-level-restricted.
export function unclusteredOpacityExpr(selectedId: number | null): any {
  if (selectedId == null) return PIN_DS_OPACITY;
  return [
    "case",
    ["==", ["get", "id"], selectedId],
    PIN_DS_OPACITY,
    DIMMED_PIN_OPACITY,
  ];
}

// icon-opacity for the (opt-in) glyph pin layer — same rule, flat 1/0.45.
export function iconOpacityExpr(selectedId: number | null): any {
  if (selectedId == null) return 1;
  return ["case", ["==", ["get", "id"], selectedId], 1, DIMMED_PIN_OPACITY];
}

// (The secondary-chrome auto-hide machine and the compact status-filter pill
// machine were removed with the chrome they drove. The auto-hide's
// `interact-start → {hidden, reshowAt:null}` transition could strand the whole
// control rail at opacity-0 whenever the matching end event was swallowed —
// which is how the lasso button "disappeared" for managers. The rail is
// primary chrome now: always visible, like the SalesRabbit reference.)

// ── Persisted status filter ───────────────────────────────────────────────────
// The rep's last selection persists across launches. The Filters sheet is the
// one filter surface; an active filter shows as the top-center chip.
export const FILTER_STATUS_LS_KEY = "hf.mapFilterStatus.v1";

export function readPersistedFilterStatus(validStatuses: readonly string[]): string {
  try {
    const v = localStorage.getItem(FILTER_STATUS_LS_KEY);
    if (!v || v === "all") return "all";
    return validStatuses.includes(v) ? v : "all";
  } catch {
    return "all"; // storage blocked (private mode) — session-only filter
  }
}

export function persistFilterStatus(status: string): void {
  try {
    localStorage.setItem(FILTER_STATUS_LS_KEY, status);
  } catch {
    /* storage blocked — filter just won't survive a reload */
  }
}

// ── Persisted map camera ────────────────────────────────────────────────────
// The map reopens where the rep LEFT it, so the first viewport fetch (pins or
// density grid) targets real territory the moment the count probe answers —
// no default-city flash, no zoomed-out dead frame while geolocate spins up.
export const MAP_CAMERA_LS_KEY = "hf.mapCamera.v1";

export interface PersistedMapCamera {
  center: [number, number]; // [lng, lat]
  zoom: number;
}

export function readPersistedMapCamera(): PersistedMapCamera | null {
  try {
    const raw = localStorage.getItem(MAP_CAMERA_LS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const lng = Number(v?.center?.[0]);
    const lat = Number(v?.center?.[1]);
    const zoom = Number(v?.zoom);
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || !Number.isFinite(zoom)) return null;
    if (Math.abs(lat) > 85 || Math.abs(lng) > 180 || zoom < 2 || zoom > 20) return null;
    return { center: [lng, lat], zoom };
  } catch {
    return null; // storage blocked (private mode) — session-only camera
  }
}

export function persistMapCamera(center: [number, number], zoom: number): void {
  try {
    localStorage.setItem(MAP_CAMERA_LS_KEY, JSON.stringify({ center, zoom }));
  } catch {
    /* storage blocked — the camera just won't survive a reload */
  }
}

// ── Density grid (wide-zoom aggregate tier) ────────────────────────────────
// Past the pin path's 3° span guard the map renders /api/leads/map/grid cells
// as count-scaled bubbles — the same visual family as the pin clusters
// (neutral teal density ramp, count label, white ring), so zooming across the
// tier boundary reads as "the bubbles got honest", never as a different map.
// ONE spec factory shared by the map-init block AND the style.load re-add
// block (the drift that reverted the Frontier halo colour is why these can
// never be hand-copied twice).
export const DENSITY_SOURCE = "lead-density";
export const DENSITY_CIRCLES_LAYER = "lead-density-circles";
export const DENSITY_COUNT_LAYER = "lead-density-count";
export const DENSITY_FRESH_RING_LAYER = "lead-density-fresh-ring";
export const DENSITY_LAYER_IDS = [DENSITY_CIRCLES_LAYER, DENSITY_FRESH_RING_LAYER, DENSITY_COUNT_LAYER] as const;

/** Every pin-family layer hidden while the density tier is active (the stale
 *  cached pins from the last close-zoom window must not double-render over
 *  the bubbles). The unclustered layers ARE listed now: they render at every
 *  zoom since the isolated-lead fix (a lone door >1 cluster radius from its
 *  neighbors never forms a cluster, and a minzoom floor made it invisible at
 *  survey zooms), so the density tier must hide them explicitly. */
export const GRID_TIER_HIDDEN_LAYER_IDS = [
  "lead-clusters-glow",
  "lead-fresh-cluster-ring",
  "lead-clusters",
  "lead-cluster-count",
  "lead-unclustered",
  "lead-fresh-confirmed-halo",
  "lead-status-icons",
  "lead-selected-ring",
] as const;

// ── Cluster + unclustered layer specs — ONE factory for both install sites ──
// The map-init block and the style.load re-add block used to carry two
// hand-copied versions of these five layers, and they HAD drifted (different
// radius steps, opacity, text sizes). Same cure as the density/halo specs:
// one spec factory, imported by both.
//
// ZOOM CONTRACT (the "leads only appear when I zoom way in" fixes, Aug 2026):
//   * The source clusters tiles up to clusterMaxZoom 13, which means cluster
//     FEATURES exist for every display zoom below 14 — so the cluster layers'
//     maxzoom must be 14, not 13.5. The old 13.5 cap left a dead half-zoom
//     band [13.5, 14) where nearly every residential lead sat in a cluster
//     that no layer would draw: a neighborhood at survey zoom rendered blank.
//   * The unclustered layers have NO minzoom. A lead further than one cluster
//     radius from its neighbors never joins a cluster, and the old minzoom 12
//     floor made exactly those isolated/rural doors invisible at z<12 — not
//     sampled, not clustered, just unrendered. The circle layer is one cheap
//     GPU draw; the row cap bounds its feature count.
export const CLUSTER_MAX_ZOOM = 13; // source: collapse clusters below this tile zoom
export const CLUSTER_LAYER_MAX_ZOOM = CLUSTER_MAX_ZOOM + 1; // layers: clusters EXIST until display z14

// ── The one invariant that keeps the wide view readable ────────────────────
// A cluster's DRAWN extent must never exceed the distance at which two
// clusters can form. supercluster only promises that points within
// `clusterRadius` join a cluster - it says nothing about how far apart the
// resulting CENTROIDS land, so at wide zoom several towns collapse to
// centroids a few px apart while each still paints a full-size bubble.
//
// Measured on the Lexington set (1,500 doors) before this was enforced, with
// clusterRadius 50 against a 64px circle and an 84px glow:
//   z13    0% of cluster pairs overlapping
//   z12   83%, worst pair 37% merged
//   z11  100%, worst 69%
//   z10  100%, worst 84%  <- four bubbles rendering as one dark blob
// Raising the grouping distance past the artwork makes those four MERGE into
// one honest bubble instead of stacking: fewer, larger, readable.
//
// Keep these three in step. CLUSTER_MAX_RADIUS is the largest `circle-radius`
// in the ramp below, CLUSTER_GLOW_PAD the halo drawn behind it; the guard in
// tests/unit/map-cluster-overlap.test.ts fails if the drawn diameter ever
// grows past the grouping distance again.
export const CLUSTER_MAX_RADIUS = 32;
export const CLUSTER_GLOW_PAD = 6;
export const CLUSTER_RADIUS_PX = 80;
/** The zoom where per-pin detail (glyph icons, halos) becomes legible; the
 *  plain circle layer runs at every zoom underneath. */
export const PIN_DETAIL_MIN_ZOOM = 12;

export const LEADS_CLUSTER_SOURCE_SPEC: any = {
  type: "geojson",
  data: { type: "FeatureCollection", features: [] },
  cluster: true,
  clusterMaxZoom: CLUSTER_MAX_ZOOM,
  clusterRadius: CLUSTER_RADIUS_PX, // px radius to cluster within - see the invariant above
  clusterProperties: { fresh_count: ["+", ["get", "fresh"]] },
};

export function clusterLayerSpecs(): any[] {
  return [
    {
      // Cluster outer glow ring (behind main circle)
      id: "lead-clusters-glow",
      type: "circle",
      source: "leads-cluster",
      filter: ["has", "point_count"],
      maxzoom: CLUSTER_LAYER_MAX_ZOOM,
      paint: {
        "circle-color": ["step", ["get", "point_count"], "#0d9488", 10, "#0f766e", 30, "#115e59"],
        // A halo hugging the circle, not a second bubble around it. At the old
        // 26/33/42 the glow was the WIDEST thing on the map (84px across) and
        // neighbouring haloes merged into a haze well before the circles
        // themselves touched - the blob had soft edges for that reason.
        "circle-radius": ["step", ["get", "point_count"],
          18 + CLUSTER_GLOW_PAD, 10, 24 + CLUSTER_GLOW_PAD, 30, CLUSTER_MAX_RADIUS + CLUSTER_GLOW_PAD],
        "circle-opacity": 0.25,
        "circle-stroke-width": 0,
      },
    },
    {
      // A confirmed-fresh ring makes the money layer visible without changing
      // the disposition color inside the cluster. The count is aggregated in
      // the Mapbox worker, so this remains one GeoJSON source and zero DOM pins.
      id: "lead-fresh-cluster-ring",
      type: "circle",
      source: "leads-cluster",
      filter: ["all", ["has", "point_count"], [">", ["get", "fresh_count"], 0]],
      maxzoom: CLUSTER_LAYER_MAX_ZOOM,
      paint: {
        "circle-radius": ["+", ["step", ["get", "point_count"], 18, 10, 24, 30, CLUSTER_MAX_RADIUS], CLUSTER_GLOW_PAD],
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-width": 3,
        "circle-stroke-color": "#22c55e",
        "circle-opacity": 0.95,
      },
    },
    {
      // Cluster circles — neutral teal DENSITY ramp: clusters mean "how many,"
      // never a status (green/red are reserved for sold/dead pins; reusing
      // them here would contradict the pin colors at close zoom).
      id: "lead-clusters",
      type: "circle",
      source: "leads-cluster",
      filter: ["has", "point_count"],
      maxzoom: CLUSTER_LAYER_MAX_ZOOM,
      paint: {
        "circle-color": ["step", ["get", "point_count"], "#0d9488", 10, "#0f766e", 30, "#115e59"],
        "circle-radius": ["step", ["get", "point_count"], 18, 10, 24, 30, CLUSTER_MAX_RADIUS],
        "circle-opacity": 0.92,
        "circle-stroke-width": 2.5,
        "circle-stroke-color": "rgba(255,255,255,0.9)",
      },
    },
    {
      // Cluster count labels — the REAL aggregated number.
      id: "lead-cluster-count",
      type: "symbol",
      source: "leads-cluster",
      filter: ["has", "point_count"],
      maxzoom: CLUSTER_LAYER_MAX_ZOOM,
      layout: {
        "text-field": "{point_count_abbreviated}",
        "text-font": [GLYPH_FONT_BOLD],
        "text-size": ["step", ["get", "point_count"], 13, 10, 14, 30, 16],
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(0,0,0,0.3)",
        "text-halo-width": 0.5,
      },
    },
  ];
}

/** The unclustered pin circle + confirmed-fresh halo. No minzoom on either —
 *  see the zoom contract above. The halo filter (fresh === 1) keeps its draw
 *  set tiny at wide zoom, so painting it everywhere costs nothing visible. */
export function unclusteredLayerSpecs(): any[] {
  return [
    {
      id: "lead-unclustered",
      type: "circle",
      source: "leads-cluster",
      filter: ["!", ["has", "point_count"]],
      paint: UNCLUSTERED_PAINT,
    },
    {
      id: "lead-fresh-confirmed-halo",
      type: "circle",
      source: "leads-cluster",
      filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "fresh"], 1]],
      paint: FRESH_HALO_PAINT,
      before: "lead-unclustered",
    },
  ];
}

export function densityLayerSpecs(): any[] {
  return [
    {
      id: DENSITY_CIRCLES_LAYER,
      type: "circle",
      source: DENSITY_SOURCE,
      paint: {
        // sqrt-ish growth: a 100x count difference stays readable without the
        // big cells swallowing the small ones. Same teal family as clusters —
        // density means "how many", never a status.
        "circle-radius": [
          "interpolate", ["exponential", 0.5], ["get", "n"],
          1, 12,
          50, 20,
          500, 30,
          5000, 42,
          50000, 54,
        ],
        "circle-color": [
          "step", ["get", "n"],
          "#0d9488",
          25, "#0f766e",
          250, "#115e59",
          2500, "#134e4a",
        ],
        "circle-opacity": 0.88,
        "circle-stroke-width": 2.5,
        "circle-stroke-color": "rgba(255,255,255,0.9)",
      },
    },
    {
      // Confirmed-fresh ring — the SAME green ring the pin clusters carry
      // (cluster fresh_count ↔ the grid's per-cell fresh aggregate, identical
      // predicate server-side), so the money layer stays visible on the
      // density tier and the tier crossing never changes what fresh means.
      id: DENSITY_FRESH_RING_LAYER,
      type: "circle",
      source: DENSITY_SOURCE,
      filter: [">", ["get", "fresh"], 0],
      paint: {
        "circle-radius": [
          "+",
          ["interpolate", ["exponential", 0.5], ["get", "n"],
            1, 12,
            50, 20,
            500, 30,
            5000, 42,
            50000, 54,
          ],
          5,
        ],
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-width": 3,
        "circle-stroke-color": "#22c55e",
        "circle-opacity": 0.95,
      },
    },
    {
      id: DENSITY_COUNT_LAYER,
      type: "symbol",
      source: DENSITY_SOURCE,
      layout: {
        // The EXACT cell count — a density bubble that abbreviates ("1.2k")
        // reads as an estimate; the grid's whole job is honest territory.
        "text-field": ["to-string", ["get", "n"]],
        "text-font": [GLYPH_FONT_BOLD],
        "text-size": ["step", ["get", "n"], 13, 25, 14, 250, 16],
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(0,0,0,0.3)",
        "text-halo-width": 0.5,
      },
    },
  ];
}

/** Idempotent density source+layer install — called by the map-init block and
 *  the style.load re-add block (setStyle wipes custom sources). Density sits
 *  UNDER the pin clusters, so during the tier handoff (both visible for one
 *  fetch round-trip) the pins read on top. */
export function ensureDensityLayers(map: any): void {
  if (!map.getSource(DENSITY_SOURCE)) {
    map.addSource(DENSITY_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  }
  for (const spec of densityLayerSpecs()) {
    if (!map.getLayer(spec.id)) map.addLayer(spec);
  }
}

// Counts are glanceable context, never the headline: raw under 10k, compact
// above so a 5-6 digit tally can't dominate the pill ("12.3k", "235k").
export function formatFilterCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 10_000) return String(Math.round(n));
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

// (The per-pin glow layer was removed — it was a 2nd fill draw under EVERY pin,
// doubling the unclustered draw cost at 5.5k+ leads for a barely-visible halo.
// The zoom-scaled radius + white stroke give enough pop at a fraction of the cost.)

// ── Confirmed-fresh halo ──────────────────────────────────────────────────────
// ONE paint definition shared by the map-init block AND the style.load re-add
// block. They used to carry two hand-copied versions that drifted: the re-add
// copy lost the carrier case, so after any basemap toggle a Frontier fresh lead
// silently reverted to the Kinetic-green halo. Kinetic fresh = green ring,
// Frontier fresh = red ring — always, on every style.
export const FRESH_HALO_PAINT: any = {
  "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 10, 18, 16],
  "circle-color": ["case", ["==", ["get", "carrier"], "frontier"], "rgba(239,68,68,0.16)", "rgba(34,197,94,0.16)"],
  "circle-stroke-width": 2.5,
  "circle-stroke-color": ["case", ["==", ["get", "carrier"], "frontier"], "#ef4444", "#22c55e"],
};

// ── Selected-pin ring ─────────────────────────────────────────────────────────
// A dedicated layer driven by setFilter — NOT feature-state: on a cluster:true
// source, cluster ids regenerate on every setData/zoom so state attaches
// unreliably, and feature-state can't drive filters. setFilter is a pure
// style-thread update: no source rebuild, no re-cluster, no React pin work.
export const SELECTED_RING_FILTER = (id: number | null): any =>
  ["all", ["!", ["has", "point_count"]], ["==", ["get", "id"], id ?? -1]];

export const SELECTED_RING_SPEC: any = {
  id: "lead-selected-ring",
  type: "circle",
  source: "leads-cluster",
  filter: SELECTED_RING_FILTER(null), // matches nothing until a pin is selected
  // No minzoom: the filter matches ONE pin, and a selection made at close zoom
  // must survive zooming out (the old 12 floor made the ring vanish mid-gesture).
  paint: {
    "circle-radius": 14, // detached ring: 6px gap around the 8px pin
    // Dark neutral scrim (not the old 0.15 teal): the ring's white stroke is
    // what carries selection, and white-on-light-streets was near-invisible. A
    // soft dark disc under the stroke gives it an edge on the light basemap
    // while staying subtle over satellite/dark, where the stroke already reads.
    "circle-color": "rgba(15,23,42,0.28)",
    "circle-stroke-width": 3,
    "circle-stroke-color": "#ffffff",
    "circle-stroke-opacity": 0.95,
  },
};

// ── Field-mode startup camera ─────────────────────────────────────────────────
// The rep map must open where the rep is standing, at door-knocking zoom — never
// a regional overview. Live GPS is async, so launch renders instantly on the
// best cached guess and the GeolocateControl recenters the moment a fix lands.
export const STREET_ZOOM = 17;
export const LAST_FIX_KEY = "hf.lastFix.v1";
export const LAST_FIX_TTL_MS = 24 * 60 * 60 * 1000; // stale beyond a day — rep likely drove elsewhere

export type CachedFix = { lat: number; lng: number; at: number };
export type StartCamera = {
  center: [number, number]; // [lng, lat]
  zoom: number;
  source: "gps-cache";
};

// Live GPS is the only anchor (SalesRabbit behavior — no resume/session camera).
// This just answers "where do we paint while the live fix warms up?": the last
// known GPS fix at street zoom, or null → caller frames the assigned leads.
// Pure so the launch contract is unit-testable without a map.
export function pickRepStartCamera(cachedFix: CachedFix | null, now: number): StartCamera | null {
  if (cachedFix && now - cachedFix.at < LAST_FIX_TTL_MS
      && Number.isFinite(cachedFix.lat) && Number.isFinite(cachedFix.lng)) {
    return { center: [cachedFix.lng, cachedFix.lat], zoom: STREET_ZOOM, source: "gps-cache" };
  }
  return null;
}

export function readCachedFix(): CachedFix | null {
  try {
    const raw = localStorage.getItem(LAST_FIX_KEY);
    if (!raw) return null;
    const f = JSON.parse(raw);
    return typeof f?.lat === "number" && typeof f?.lng === "number" && typeof f?.at === "number" ? f : null;
  } catch { return null; }
}

let lastFixWriteAt = 0;
export function writeCachedFix(lat: number, lng: number, at: number): void {
  if (at - lastFixWriteAt < 10_000) return; // ~1 fix/s in follow mode — don't hammer storage
  lastFixWriteAt = at;
  try { localStorage.setItem(LAST_FIX_KEY, JSON.stringify({ lat, lng, at })); } catch { /* storage blocked */ }
}

// Single source for the sheet's peek height — LeadKnockSheet imports this so
// the camera padding can never drift from the actual sheet lip again.
//
// The v3 peek layout VARIES per lead (status line, recent-activity line, the
// collapsible "+ Add note" chip), so a single hardcoded number would always be
// wrong for someone. The mounted LeadKnockSheet therefore MEASURES its real
// peek block (drag header + peek body) via a ResizeObserver and publishes it
// through setMeasuredPeekPx(); sheetPeekPaddingPx() consumes that live value so
// the map camera's bottom padding tracks the actual content. The constant below
// is only the pre-measure / no-sheet fallback.
let measuredPeekPx: number | null = null;
export function setMeasuredPeekPx(px: number | null): void {
  measuredPeekPx = px != null && Number.isFinite(px) && px > 0 ? px : null;
}

// Live "the rep's finger is dragging the sheet" flag, published by
// LeadKnockSheet on the same channel as the measured peek height. MapView's
// selected-pin pulse loop reads it to PAUSE its rAF paint-writes for the whole
// drag — a sheet drag must never compete with a forced full-GL repaint.
let sheetDragActive = false;
export function setSheetDragActive(active: boolean): void {
  sheetDragActive = !!active;
}
export const isSheetDragActive = (): boolean => sheetDragActive;

// Fallback ONLY (before the first measure, or when no sheet is mounted). Sized
// to the new peek layout: status-dot header + hero address + status line +
// action-pill row + wrapped 7-pill grid + recent line + the "+ Add note" chip.
// Real height comes from setMeasuredPeekPx at runtime.
export const SHEET_PEEK_BASE_PX = 320;

// Camera bottom padding = live peek height (or fallback) + a small margin so the
// selected pin sits just above the sheet lip; capped at 35vh for short/landscape
// viewports.
export const sheetPeekPaddingPx = (): number =>
  Math.min((measuredPeekPx ?? SHEET_PEEK_BASE_PX) + 24, Math.round((typeof window !== "undefined" ? window.innerHeight : 800) * 0.35));

// All programmatic camera moves in the rep flow go through this — jumpTo under
// prefers-reduced-motion and in headless/jsdom (no easeTo) so the camera never
// strands mid-animation.
export function moveCamera(map: any, opts: any): void {
  if (!map) return;
  let reduce = false;
  try {
    reduce = typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch { /* jsdom */ }
  try {
    if (reduce || typeof map.easeTo !== "function") map.jumpTo(opts);
    else map.easeTo(opts);
  } catch { /* map mid-teardown */ }
}

// ── Progressive house numbers — PROVIDER-NATIVE, never fabricated ─────────────
// None of our three basemaps ship a housenum layer, but they all carry the
// mapbox-streets-v8 `composite` vector source, which includes the native
// `housenum_label` source-layer. This enables it as one symbol layer: numbers
// fade in from z17.2 (well past street level), Mapbox's collision engine
// culls overlaps, and the layer sits BELOW our operational layers so a house
// number never covers a lead pin, territory, or selection. Called from BOTH
// the init layer-setup and every style.load re-add (setStyle wipes layers).
// Cost: one GPU symbol layer over existing tiles — zero DOM, zero extra fetch.
export const HOUSENUM_SOURCE = "hf-housenum-src";

export function ensureHousenumLayer(map: any, styleMode: "satellite" | "streets" | "dark"): void {
  try {
    if (!map?.addLayer) return;
    // Our OWN GeoJSON source, fed from /api/address-points (county E911). It
    // used to be Mapbox's `composite` vector source, which no longer exists
    // under a raster basemap - and which was never ours to begin with: it
    // rendered whatever Mapbox had, at whatever coverage, with no way to ask
    // it what a house number was, only to draw it.
    if (!map.getSource(HOUSENUM_SOURCE)) {
      map.addSource(HOUSENUM_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (map.getLayer("hf-housenum")) map.removeLayer("hf-housenum");
    const colors = styleMode === "satellite"
      ? { text: "#ffffff", halo: "rgba(0,0,0,0.85)" }   // over imagery: white + dark halo
      : styleMode === "dark"
      ? { text: "#93a3b1", halo: "rgba(10,14,20,0.9)" }
      : { text: "#57626c", halo: "rgba(255,255,255,0.92)" };
    // Insert below the first of our operational layers that exists, so lead
    // pins / clusters / selection rings always draw ON TOP of house numbers.
    const before = ["lead-unclustered-glow", "lead-clusters-glow", "lead-clusters", "lead-selected-ring"]
      .find(id => { try { return !!map.getLayer(id); } catch { return false; } });
    map.addLayer({
      id: "hf-housenum",
      type: "symbol",
      source: HOUSENUM_SOURCE,
      minzoom: 16.8, // route-planning zoom — the address IS the operational label
      layout: {
        "text-field": ["get", "n"],
        "text-font": [GLYPH_FONT_REGULAR],
        // Legible on a phone at arm's length: floor 11px, scales up close in.
        "text-size": ["interpolate", ["linear"], ["zoom"], 16.6, 11.5, 18.5, 14.5, 20, 17.5],
        // ON the roof, not beside it. The E911 point IS the structure, so a
        // centred label reads as "this building is 412" with no ambiguity
        // about which of two adjacent houses it belongs to - which is exactly
        // the ambiguity the old variable-anchor placement introduced, since it
        // pushed each number into whatever whitespace was nearest.
        "text-anchor": "center",
        "text-padding": 2,
        // NOT optional, and allowed to overlap nothing: every house that has a
        // number shows it. `text-optional` let the collision engine silently
        // drop numbers in dense blocks, and a missing number reads to a rep as
        // "not a door" rather than "we hid this one".
        "text-allow-overlap": false,
        "text-ignore-placement": false,
      },
      paint: {
        "text-color": colors.text,
        "text-halo-color": colors.halo,
        "text-halo-width": 1.8, // heavier halo: readable over rooftops in sun
        "text-halo-blur": 0.4,
        // Fade in across a third of a zoom level — appears, never pops/flickers.
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 16.8, 0, 17.15, 1],
      },
    }, before);
  } catch { /* never let a label layer take the map down */ }
}

/**
 * Push a viewport's worth of house numbers into the layer.
 *
 * Returns false when the layer is not installed or the payload was truncated -
 * the caller HIDES the numbers in that case rather than drawing a partial set.
 * A map showing numbers for an arbitrary subset of the houses on screen is
 * worse than one showing none, because a rep cannot tell which houses were
 * left out and will read a missing number as "not a house".
 */
export function setHousenumData(
  map: any,
  points: Array<[number, number, string]>,
  truncated: boolean,
): boolean {
  try {
    const src = map?.getSource?.(HOUSENUM_SOURCE);
    if (!src?.setData) return false;
    if (truncated) {
      src.setData({ type: "FeatureCollection", features: [] });
      return false;
    }
    src.setData({
      type: "FeatureCollection",
      features: points
        .filter(([, , n]) => n !== "")
        .map(([lng, lat, n]) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lng, lat] },
          properties: { n },
        })),
    });
    return true;
  } catch {
    return false;
  }
}

// Counterpart for the settings toggle: unmount the layer entirely (not just
// visibility) so an OFF map does zero symbol/collision work for numbers.
export function removeHousenumLayer(map: any): void {
  try {
    if (map?.getLayer?.("hf-housenum")) map.removeLayer("hf-housenum");
  } catch { /* style mid-swap — the fresh style starts without the layer anyway */ }
}

// ── House-numbers preference ──────────────────────────────────────────────────
// OFF by default (owner's minimal-map directive); an explicit opt-in from the
// Map settings sheet persists across launches, same pattern as the status
// filter above. Storage-blocked browsers degrade to session-only.
// v2: the owner wants numbers ON by default (v1 shipped default-off for a few
// hours and may have persisted "0" without the user ever touching the toggle —
// the key bump re-defaults everyone to ON while still honoring future choices).
export const HOUSE_NUMBERS_LS_KEY = "hf.mapHouseNumbers.v2";

export function readPersistedHouseNumbers(): boolean {
  try {
    return localStorage.getItem(HOUSE_NUMBERS_LS_KEY) !== "0"; // default ON
  } catch {
    return true;
  }
}

export function persistHouseNumbers(on: boolean): void {
  try {
    localStorage.setItem(HOUSE_NUMBERS_LS_KEY, on ? "1" : "0");
  } catch {
    /* storage blocked — preference just won't survive a reload */
  }
}

// ── Persisted basemap mode ──────────────────────────────────────────────────
// The other three controls in the Map settings sheet (status filter, source
// lens, house numbers) all persist; the basemap did not, so a rep who works
// nights on Dark got thrown back to Satellite on every launch and had to
// re-pick it. Same storage pattern and same storage-blocked degradation as its
// neighbours. Unknown/corrupt values fall back to the satellite default rather
// than handing basemapStyle() a mode it has no tiles for.
export const BASEMAP_MODE_LS_KEY = "hf.mapBasemap.v1";

export type PersistedBasemapMode = "satellite" | "streets" | "dark";

export const DEFAULT_BASEMAP_MODE: PersistedBasemapMode = "satellite";

export function readPersistedBasemapMode(): PersistedBasemapMode {
  try {
    const v = localStorage.getItem(BASEMAP_MODE_LS_KEY);
    return v === "satellite" || v === "streets" || v === "dark" ? v : DEFAULT_BASEMAP_MODE;
  } catch {
    return DEFAULT_BASEMAP_MODE; // storage blocked (private mode) — session-only
  }
}

export function persistBasemapMode(mode: PersistedBasemapMode): void {
  try {
    localStorage.setItem(BASEMAP_MODE_LS_KEY, mode);
  } catch {
    /* storage blocked — the choice just won't survive a reload */
  }
}

// ── Add-mode tap arbitration ────────────────────────────────────────────────
// In tap-to-add mode a tap must hit-test existing pins FIRST: landing on (or
// gloved-near-missing) a pin opens that lead instead of reverse-geocoding +
// POSTing a duplicate pin 1-2m away. Pure decision so the map handler stays
// thin and the rule is unit-testable.
export type AddModeTapDecision =
  | { action: "open-lead"; leadId: number }
  | { action: "add-lead" };

export function decideAddModeTap(
  hitLeadId: number | null | undefined,
): AddModeTapDecision {
  return hitLeadId != null
    ? { action: "open-lead", leadId: hitLeadId }
    : { action: "add-lead" };
}

// ── rAF-coalesced source repaint ────────────────────────────────────────────
// A disposition tap needs at most ONE worker re-cluster + repaint per frame,
// no matter how many optimistic updates land inside the same gesture. The
// flush closure reads the live data ref at fire time, so a coalesced call
// always paints the latest collection; intermediate calls collapse onto the
// pending flag.
export function createRafCoalescedFlush(
  flush: () => void,
  raf: (cb: () => void) => unknown = (cb) => requestAnimationFrame(cb),
): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    raf(() => {
      pending = false;
      flush();
    });
  };
}

export const STREET_LABEL_SOURCE = "hf-streetname-src";

/**
 * Street names, drawn from the same E911 points as the house numbers.
 *
 * These draw only where the E911 import has actually been run - the source is
 * fed from /api/address-points and stays an empty FeatureCollection otherwise,
 * so an uncovered county silently gets nothing from this layer rather than a
 * partial set. The basemap is hybrid (lyrs=y) and carries Google's own street
 * names underneath, which is what a county with no import falls back to.
 *
 * They turn on EARLIER than house numbers (z14 vs z16.8): knowing which street
 * you are on matters while you are still driving to it.
 */
export function ensureStreetLabelLayer(map: any, styleMode: "satellite" | "streets" | "dark"): void {
  try {
    if (!map?.addLayer) return;
    if (!map.getSource(STREET_LABEL_SOURCE)) {
      map.addSource(STREET_LABEL_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
    }
    if (map.getLayer("hf-streetname")) map.removeLayer("hf-streetname");

    const colors = styleMode === "satellite"
      ? { text: "#ffffff", halo: "rgba(0,0,0,0.9)" }
      : styleMode === "dark"
      ? { text: "#aebac7", halo: "rgba(10,14,20,0.92)" }
      : { text: "#46505a", halo: "rgba(255,255,255,0.94)" };

    // Inserted ABOVE hf-housenum, deliberately.
    //
    // MapLibre places symbols in style order, and whatever is placed first
    // wins the collision. Sitting this layer below the house numbers therefore
    // gave STREET names priority over door numbers - the exact inversion of
    // what a rep needs - and produced overlaps like "Broa100treet" where a
    // street name and a house number were both drawn into the same pixels.
    // Above hf-housenum, the numbers are placed first and the street name
    // yields (it is text-optional; a house number is not).
    const before = ["lead-clusters-glow", "lead-clusters", "lead-selected-ring"]
      .find(id => { try { return !!map.getLayer(id); } catch { return false; } });

    map.addLayer({
      id: "hf-streetname",
      type: "symbol",
      source: STREET_LABEL_SOURCE,
      minzoom: 14,
      layout: {
        "text-field": ["get", "n"],
        "text-font": [GLYPH_FONT_REGULAR],
        "text-size": ["interpolate", ["linear"], ["zoom"], 14, 11, 18, 13.5],
        "text-anchor": "center",
        "text-padding": 14,
        // A street name IS optional in a way a house number is not: dropping a
        // colliding one costs a rep nothing, because the street is still
        // visible and usually labelled again nearby.
        "text-optional": true,
        "text-letter-spacing": 0.04,
        "text-max-width": 9,
      },
      paint: {
        "text-color": colors.text,
        "text-halo-color": colors.halo,
        "text-halo-width": 1.6,
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 14.6, 1],
      },
    }, before);
  } catch { /* never let a label layer take the map down */ }
}

export function setStreetLabelData(map: any, streets: Array<[number, number, string]>): void {
  try {
    const src = map?.getSource?.(STREET_LABEL_SOURCE);
    if (!src?.setData) return;
    src.setData({
      type: "FeatureCollection",
      features: streets.map(([lng, lat, n]) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: { n },
      })),
    });
  } catch { /* stale map handle */ }
}

export function removeStreetLabelLayer(map: any): void {
  try { if (map?.getLayer?.("hf-streetname")) map.removeLayer("hf-streetname"); } catch { /* gone */ }
}

// ── Rep→door proximity link ───────────────────────────────────────────────────
// While a card is open the map draws a dotted guide from the rep's fix to the
// selected door — the SalesRabbit "proximity indicator", as a quiet overlay on
// the working map instead of a separate screen. Display only: the knock's
// GPS evidence and the server's distance verdict are untouched.
export const REP_LINK_SOURCE = "rep-door-link";
export const REP_LINK_LAYER = "rep-door-link-line";

/** Don't draw a guide to a door the rep plainly isn't walking to — past ~3 km
 *  the line is chart junk crossing the whole viewport. */
export const REP_LINK_MAX_METERS = 3000;

export const REP_LINK_LAYER_SPEC: any = {
  id: REP_LINK_LAYER,
  type: "line",
  source: REP_LINK_SOURCE,
  layout: { "line-cap": "round" },
  paint: {
    // Rounded dashes on a white 55% line — legible on satellite and streets
    // alike without competing with pins (which draw above this layer).
    "line-color": "#ffffff",
    "line-opacity": 0.55,
    "line-width": 1.75,
    "line-dasharray": [0.1, 2.2],
  },
};

/** LineString feature for the guide, or null when there is nothing honest to
 *  draw (missing ends, or the pair is beyond REP_LINK_MAX_METERS). Pure. */
export function repDoorLinkFeature(
  rep: { lat: number; lng: number } | null | undefined,
  door: { lat: number | null | undefined; lng: number | null | undefined } | null | undefined,
): { type: "Feature"; geometry: { type: "LineString"; coordinates: [number, number][] }; properties: {} } | null {
  if (!rep || door?.lat == null || door?.lng == null) return null;
  if (![rep.lat, rep.lng, door.lat, door.lng].every(Number.isFinite)) return null;
  const meters = haversineMeters({ lat: rep.lat, lng: rep.lng }, { lat: door.lat, lng: door.lng });
  if (meters > REP_LINK_MAX_METERS) return null;
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [[rep.lng, rep.lat], [door.lng, door.lat]] },
    properties: {},
  };
}

/** Push the guide into the map (or clear it with null). Safe on a stale map. */
export function setRepDoorLink(
  map: any,
  feature: ReturnType<typeof repDoorLinkFeature>,
): void {
  try {
    const src = map?.getSource?.(REP_LINK_SOURCE);
    if (!src?.setData) return;
    src.setData(feature
      ? { type: "FeatureCollection", features: [feature] }
      : { type: "FeatureCollection", features: [] });
  } catch { /* stale map handle */ }
}
