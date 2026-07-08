// ── Lead-pin paint + camera helpers ───────────────────────────────────────────
// Shared by MapView's init block AND its style.load re-add block so the two can
// never drift (they already had), and by tests. Colors come from @shared/knock —
// one palette for buttons, pins, and legend.

import { STATE_COLORS, type PinDisplayState } from "@shared/knock";

// Flat GPU match on the precomputed `ds` feature prop — no nested case logic.
// MAP-ONLY overrides for terminal states: alpha-dimming muddied into satellite
// texture, and sold #10b981 read as a green twin of unworked #22c55e at 8px in
// sunlight. Pre-mixed solid "quiet" hexes (≈45% toward slate) keep edges crisp
// and unmistakably darker than the bright actionable pins. Buttons/chips keep
// the vivid STATE_COLORS.
const MAP_DIM: Record<string, string> = {
  sold: "#20836d",           // deep sea-green — clearly not "fresh door" green
  not_interested: "#9a434c", // muted brick — quiet but still reads red
};
export const PIN_DS_COLOR: any = [
  "match", ["get", "ds"],
  ...Object.entries(STATE_COLORS).flatMap(([k, v]) => [k, MAP_DIM[k] ?? v]),
  STATE_COLORS.unworked, // fallback
];

// Done-vs-left at a glance: terminal states are quiet via their pre-mixed hue
// (above), not via alpha. Actionable knocked states (not_home, follow_up,
// interested, contacted) stay bright — the rep still owes them a visit.
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

// Single source for the sheet's peek height — LeadKnockSheet imports this so
// the camera padding can never drift from the actual sheet lip again.
export const SHEET_PEEK_BASE_PX = 292;

// Camera bottom padding = peek height + a small margin so the selected pin sits
// just above the sheet lip; capped at 35vh for short/landscape viewports.
export const sheetPeekPaddingPx = (): number =>
  Math.min(SHEET_PEEK_BASE_PX + 24, Math.round((typeof window !== "undefined" ? window.innerHeight : 800) * 0.35));

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
