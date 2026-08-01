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

export function bboxParam(b: ViewportBBox): string {
  // 5dp ≈ 1m — plenty for a fetch window, keeps the URL short.
  const r = (n: number) => Math.round(n * 1e5) / 1e5;
  return `${r(b.minLng)},${r(b.minLat)},${r(b.maxLng)},${r(b.maxLat)}`;
}

/** Merge a freshly fetched window into the accumulated pin set: new/updated
 *  pins win by id, survivors outside the keep region are pruned. Returns the
 *  SAME array reference when nothing changed so React Query's structural
 *  sharing can bail out of a no-op moveend refetch. */
export function mergeViewportPins<T extends { id: number; lat?: number | null; lng?: number | null }>(
  prev: readonly T[],
  fetched: readonly T[],
  keep: ViewportBBox,
): { pins: T[]; added: number; pruned: number } {
  const byId = new Map<number, T>();
  let pruned = 0;
  for (const p of prev) {
    if (p.lat != null && p.lng != null && !inBBox(p.lat, p.lng, keep)) {
      pruned++;
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
