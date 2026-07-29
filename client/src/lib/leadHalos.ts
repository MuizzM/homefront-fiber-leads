// ── Per-rep colour halos ─────────────────────────────────────────────────────
// Areas are many-to-many (territories.assignee_ids), so one door can belong to
// several reps at once. The existing `repColor` feature prop only ever encodes
// the SINGLE primary assignee, so a shared door paints as if it were one rep's
// — which is exactly how two reps end up knocking the same house. This module
// derives the full ordered colour set for a door and builds the Mapbox paint
// for the ring(s) drawn UNDER the pin, so a shared door reads as shared without
// a tap.
//
// Pure by contract: no mapbox-gl import, no DOM, no React. MapView owns the
// only addLayer calls (init block AND the style.load re-add block — both must
// use the specs from here, since hand-copied paint in those two places is the
// drift bug FRESH_HALO_PAINT/UNCLUSTERED_PAINT were extracted to stop).

import { colorForRep } from "@shared/repColors";
import { UNCLUSTERED_PAINT } from "./mapPins";

export type RepColorFn = (repId: number | null | undefined) => string;

// ── Feature-property contract ────────────────────────────────────────────────
// Mapbox expressions cannot index a JSON array through ["get"], and
// clusterProperties will not aggregate one, so the rep set is flattened onto
// scalar props at feature-build time: one colour per ring slot plus the count.
// `haloCount` counts DISTINCT COLOURS, not reps — the palette is `repId % 12`,
// so two reps can legitimately collide on the same hue and a second identical
// ring would read as one fat ring, i.e. a lie about how many reps are on the
// door. Every field here must also be added to leadFeatureSignature, or a lead
// whose assignment changed keeps its cached (stale) feature.
export const HALO_PROP = "halo"; // ring slot i lives on `${HALO_PROP}${i}`
export const HALO_COUNT_PROP = "haloCount";

/** Ring slots we are willing to paint. See HALO_OVERFLOW_COLOR for >N doors. */
export const HALO_MAX_RINGS = 3;

// Slate — the same "nobody in particular" hue colorForRep() gives an unassigned
// lead. Safe to reuse: an unassigned door paints NO halo at all (see
// haloFeatureProps), so slate can only ever mean "and more reps beyond these".
export const HALO_OVERFLOW_COLOR = "#94a3b8";

export const haloSlotProp = (slot: number): string => `${HALO_PROP}${slot}`;
export const haloLayerId = (slot: number): string => `lead-rep-halo-${slot}`;

/** For MapView's show-leads visibility loop and ensureHousenumLayer's `before` list. */
export const HALO_LAYER_IDS: string[] = Array.from({ length: HALO_MAX_RINGS }, (_, i) => haloLayerId(i));

// Fixed shape rather than an index signature so a typo in a slot name is a
// compile error at the call site. Keep in sync with HALO_MAX_RINGS.
export interface HaloFeatureProps {
  /** Distinct rep colours on this door, UNCAPPED — drives the per-slot filters. */
  haloCount: number;
  halo0?: string;
  halo1?: string;
  halo2?: string;
}

// ── Rep set for a door ───────────────────────────────────────────────────────
// A door's reps = its area's primary + every assignee. Primary goes FIRST so the
// innermost ring (the one hugging the pin, the one a rep reads first) is always
// the owner; the rest sort ascending so the same crew paints the same ring order
// on every door in the area — a colour that swaps position door to door is
// noise, not information. Accepts the raw assignee_ids JSON text because that is
// how the column travels to the client; a legacy/NULL row degrades to "primary
// only" rather than throwing mid-render.
export function repIdsForDoor(
  primaryRepId: number | null | undefined,
  assigneeIds: string | readonly (number | string | null | undefined)[] | null | undefined,
): number[] {
  let raw: readonly unknown[] = [];
  if (Array.isArray(assigneeIds)) raw = assigneeIds;
  else if (typeof assigneeIds === "string" && assigneeIds.trim()) {
    try {
      const parsed = JSON.parse(assigneeIds);
      if (Array.isArray(parsed)) raw = parsed;
    } catch {
      /* legacy row — primary only */
    }
  }

  const primary = normalizeRepId(primaryRepId);
  const rest: number[] = [];
  for (const value of raw) {
    const id = normalizeRepId(value);
    if (id == null || id === primary || rest.includes(id)) continue;
    rest.push(id);
  }
  rest.sort((a, b) => a - b);
  return primary == null ? rest : [primary, ...rest];
}

// 0 and null both mean "unassigned" in this schema, and the wire ships numeric
// ids as strings in places — coerce once here so callers never hand a "3" to
// colorForRep and get a different hue than they got for 3.
function normalizeRepId(value: unknown): number | null {
  const id = typeof value === "string" ? Number(value) : (value as number);
  return typeof id === "number" && Number.isFinite(id) && id > 0 ? Math.trunc(id) : null;
}

// ── Colours for a door ───────────────────────────────────────────────────────
/**
 * Ordered, distinct halo colours for the reps on a door — EVERY assigned rep's
 * colour, not just the primary, because a shared door that shows one colour is
 * indistinguishable from a door only that rep owns. Caller order is preserved
 * (see repIdsForDoor: owner first); duplicate ids and duplicate hues collapse.
 * `colorFor` is injectable purely so tests can assert ordering/overflow against
 * a trivial palette instead of the real 12-hue mod arithmetic.
 */
export function haloColorsForLead(
  repIds: readonly (number | string | null | undefined)[] | null | undefined,
  colorFor: RepColorFn = colorForRep,
): string[] {
  if (!repIds || repIds.length === 0) return [];
  const colors: string[] = [];
  const seenIds: number[] = [];
  for (const value of repIds) {
    const id = normalizeRepId(value);
    // includes() over an array beats a Set here: a door has a handful of reps,
    // and this runs once per lead per snapshot across ~5k+ leads.
    if (id == null || seenIds.includes(id)) continue;
    seenIds.push(id);
    const color = colorFor(id);
    if (color && !colors.includes(color)) colors.push(color);
  }
  return colors;
}

// ── The multi-rep decision: CONCENTRIC RINGS, capped at 3 ────────────────────
// A circle layer paints ONE colour, so N reps cannot live in one ring. The two
// honest options were concentric rings (one layer per slot) or a primary ring
// plus a count badge. Rings win:
//   • The badge answers "how many" but not "who" — and "who" is the whole point;
//     a rep needs to see their own hue on a door to know it is theirs to knock.
//   • A badge is a SYMBOL layer: glyph atlas + collision detection on every pan,
//     the most expensive layer type we could add, and at pin size the digit is
//     unreadable on a phone in sunlight anyway.
//   • Rings cost draw calls, and we cap that hard: slot 0 paints only on
//     ASSIGNED doors (unassigned doors carry no halo props at all — on a fresh
//     import that is most of the map, painting nothing), and slots 1-2 are
//     filtered to the genuinely shared minority. Worst realistic case is 1 extra
//     circle draw over assigned pins; 3 only where an area is actually shared.
// Beyond 3 distinct colours the outermost ring goes neutral slate: the first two
// reps stay identifiable and the slate ring says "and others" without ever
// growing the layer count — a 6-rep door costs exactly what a 3-rep door costs.
export function haloRingColors(colors: readonly string[]): string[] {
  if (colors.length <= HALO_MAX_RINGS) return colors.slice();
  return [...colors.slice(0, HALO_MAX_RINGS - 1), HALO_OVERFLOW_COLOR];
}

/** Feature props for one door. Unassigned → `{ haloCount: 0 }`: no slot keys, so
 *  5k unassigned features do not each carry three empty strings over the wire
 *  and into the tile buckets. */
export function haloFeatureProps(
  repIds: readonly (number | string | null | undefined)[] | null | undefined,
  colorFor: RepColorFn = colorForRep,
): HaloFeatureProps {
  const colors = haloColorsForLead(repIds, colorFor);
  const props: HaloFeatureProps = { haloCount: colors.length };
  const rings = haloRingColors(colors);
  if (rings[0]) props.halo0 = rings[0];
  if (rings[1]) props.halo1 = rings[1];
  if (rings[2]) props.halo2 = rings[2];
  return props;
}

/** Contribution to leadFeatureSignature — reassigning an area must invalidate
 *  the cached feature, and the cache compares signature strings only. */
export function haloSignature(
  repIds: readonly (number | string | null | undefined)[] | null | undefined,
  colorFor: RepColorFn = colorForRep,
): string {
  return haloRingColors(haloColorsForLead(repIds, colorFor)).join(",");
}

// ── Paint ────────────────────────────────────────────────────────────────────
export const HALO_SOURCE_ID = "leads-cluster";
export const HALO_MIN_ZOOM = 12; // matches every other unclustered lead layer

// Ring radius as a MULTIPLE of the pin radius, innermost first. Multiplicative
// (not "+Npx") so the rings shrink with the pin when the rep zooms out and the
// halo never swallows the dot it belongs to. At the z17 pin radius of 6.5 this
// is 10.4 / 13.7 / 16.9 — the innermost clears the pin's 1.5px white stroke by
// ~2px, and consecutive rings leave ~1px of daylight at a 2.2px stroke.
export const HALO_RING_SCALE = [1.6, 2.1, 2.6];

// A "zoom" expression is legal only at the TOP LEVEL of a paint property, so the
// radius cannot be ["*", <pin radius expr>, k] — the pin's own interpolate is
// zoom-driven. The stops are therefore READ off UNCLUSTERED_PAINT and rescaled:
// whoever retunes the pin radius next moves the halos with it automatically,
// instead of leaving a ring sitting under (or on top of) the dot.
const PIN_RADIUS_FALLBACK: Array<[number, number]> = [[12, 3.75], [15, 5.25], [17, 6.5], [20, 9]];

export function pinRadiusStops(expr: unknown = UNCLUSTERED_PAINT["circle-radius"]): Array<[number, number]> {
  const e = expr as unknown[];
  const fallback = () => PIN_RADIUS_FALLBACK.map((s) => [s[0], s[1]] as [number, number]);
  // Only the exact shape we know how to rescale; a future step/case expression
  // falls back rather than emitting a silently wrong radius.
  if (!Array.isArray(e) || e[0] !== "interpolate" || !Array.isArray(e[2]) || (e[2] as unknown[])[0] !== "zoom") {
    return fallback();
  }
  const stops: Array<[number, number]> = [];
  for (let i = 3; i + 1 < e.length; i += 2) {
    const z = e[i];
    const r = e[i + 1];
    if (typeof z !== "number" || typeof r !== "number") return fallback();
    stops.push([z, r]);
  }
  return stops.length >= 2 ? stops : fallback();
}

/** Only unclustered doors with more distinct rep colours than this slot index.
 *  `coalesce` guards clusters and any pre-halo cached feature: a missing prop
 *  reads as 0 instead of erroring the filter for every feature in the tile. */
export const haloRingFilter = (slot: number): any => [
  "all",
  ["!", ["has", "point_count"]],
  [">", ["coalesce", ["get", HALO_COUNT_PROP], 0], slot],
];

/**
 * Paint for one ring slot: a stroke-only circle (transparent fill — a ring, so
 * it never tints the status colour of the pin sitting on top of it). The
 * data-driven stroke colour resolves once per feature at bucket build, not per
 * frame; the per-pan cost of a halo is the extra draw call, which is what
 * HALO_MAX_RINGS and haloRingFilter exist to bound.
 */
export function haloRingPaint(slot: number, stops: Array<[number, number]> = pinRadiusStops()): Record<string, any> {
  const scale = HALO_RING_SCALE[Math.min(slot, HALO_RING_SCALE.length - 1)];
  const radius: any[] = ["interpolate", ["linear"], ["zoom"]];
  for (const [z, r] of stops) radius.push(z, Math.round(r * scale * 100) / 100);
  return {
    "circle-radius": radius,
    "circle-color": "rgba(0,0,0,0)",
    // Legal as a top-level interpolate; it could NOT be nested inside a case.
    // Thin enough at z12 that dense blocks stay readable, thumb-visible at z20.
    "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 12, 1.5, 17, 2.2, 20, 3],
    "circle-stroke-color": ["coalesce", ["get", haloSlotProp(slot)], HALO_OVERFLOW_COLOR],
    // Just short of opaque: the rep hue stays true over satellite imagery while
    // the basemap still reads through, so a halo never looks like a solid target.
    "circle-stroke-opacity": 0.9,
  };
}

/** All ring layers, innermost first. The rings are concentric and non-
 *  overlapping by construction, so insertion order among themselves is cosmetic
 *  — what matters is that ALL of them go in under the pins (see haloBeforeId). */
export function haloLayerSpecs(stops: Array<[number, number]> = pinRadiusStops()): any[] {
  return Array.from({ length: HALO_MAX_RINGS }, (_, slot) => ({
    id: haloLayerId(slot),
    type: "circle",
    source: HALO_SOURCE_ID,
    filter: haloRingFilter(slot),
    minzoom: HALO_MIN_ZOOM,
    paint: haloRingPaint(slot, stops),
  }));
}

// Insert under the fresh-confirmed halo when it exists (that keeps the halos
// below the fresh ring AND below lead-unclustered, which is added after it),
// else under the pins themselves. Same defensive "first layer that exists"
// pattern as ensureHousenumLayer, because the style.load re-add runs while the
// layer stack is half-rebuilt. `undefined` means neither exists yet, i.e. there
// is nothing to be under. lead-status-icons needs no entry — it is added with no
// beforeId and therefore always draws on top.
export const HALO_BEFORE_CANDIDATES = ["lead-fresh-confirmed-halo", "lead-unclustered"];

export function haloBeforeId(hasLayer: (id: string) => boolean): string | undefined {
  return HALO_BEFORE_CANDIDATES.find((id) => {
    try {
      return !!hasLayer(id);
    } catch {
      return false; // map mid-teardown
    }
  });
}
