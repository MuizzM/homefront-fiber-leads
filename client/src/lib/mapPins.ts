// ── Lead-pin paint + camera helpers ───────────────────────────────────────────
// Shared by MapView's init block AND its style.load re-add block so the two can
// never drift (they already had), and by tests. Colors come from @shared/knock —
// one palette for buttons, pins, and legend.

import { STATE_COLORS } from "@shared/knock";

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
  minzoom: 12,
  paint: {
    "circle-radius": 14, // detached ring: 6px gap around the 8px pin
    "circle-color": "hsla(172, 60%, 45%, 0.15)", // faint brand-teal halo
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
export function ensureHousenumLayer(map: any, styleMode: "satellite" | "streets" | "dark"): void {
  try {
    if (!map?.getSource?.("composite")) return;    // style without streets tiles
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
      source: "composite",
      "source-layer": "housenum_label",
      minzoom: 16.8, // route-planning zoom — the address IS the operational label
      layout: {
        "text-field": ["get", "house_num"],
        "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
        // Legible on a phone at arm's length: floor 11px, scales up close in.
        "text-size": ["interpolate", ["linear"], ["zoom"], 16.8, 11, 18.5, 13.5, 20, 16],
        // Sit the number BESIDE its house, not on top of it. Variable anchor lets
        // Mapbox place each label in whatever open space is nearest (preferring
        // below), and the collision engine keeps numbers off each other and off
        // street names — so a number never smothers a house, a pin, or a label.
        "text-variable-anchor": ["bottom", "top", "right", "left"],
        "text-radial-offset": 0.75,
        "text-justify": "auto",
        "text-padding": 4,
        "text-optional": true, // drop a number before letting it collide/overlap
      },
      paint: {
        "text-color": colors.text,
        "text-halo-color": colors.halo,
        "text-halo-width": 1.4,
        "text-halo-blur": 0.4,
        // Fade in across a third of a zoom level — appears, never pops/flickers.
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 16.8, 0, 17.15, 1],
      },
    }, before);
  } catch { /* a style variant without housenum tiles — skip, never fake it */ }
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
