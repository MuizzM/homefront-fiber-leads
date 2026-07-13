// ── Lead-pin paint + camera helpers ───────────────────────────────────────────
// Shared by MapView's init block AND its style.load re-add block so the two can
// never drift (they already had), and by tests. Colors come from @shared/knock —
// one palette for buttons, pins, and legend.

import { STATE_COLORS } from "@shared/knock";

// Flat GPU match on the precomputed `ds` feature prop — no nested case logic.
// Pin hue = STATE_COLORS verbatim: one color per status, identical on the map,
// the card chip, and the status buttons. (The old sold/not_interested map-dim
// overrides existed because unworked was green and clashed with sold — unworked
// is prospect ORANGE now, so every state is distinct at full saturation.)
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
  "circle-radius": 8,
  "circle-stroke-width": ["case", ["==", ["get", "visited"], 1], 3, 2],
  "circle-stroke-color": "rgba(255,255,255,0.95)",
  "circle-opacity": PIN_DS_OPACITY,
};

export const UNCLUSTERED_GLOW_PAINT: any = {
  "circle-color": PIN_DS_COLOR,
  "circle-radius": 14,
  "circle-opacity": 0.18,
  "circle-stroke-width": 0,
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
