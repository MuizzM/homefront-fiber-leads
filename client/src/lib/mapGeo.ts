// ── Pure spatial helpers for the field map ────────────────────────────────────
// Small, dependency-free, unit-tested. The lasso path runs these over every
// cached pin, so the cheap bounding-box rejection matters:
//
//   selectPointsInPolygon:  O(n·v) exact-only  →  O(n + k·v) with bbox reject
//   (n = candidate points, v = polygon vertices, k = points inside the bbox)
//
// Measured on the live dataset (3,355 pins, 12-vertex lasso): 1.9ms exact-only
// → 0.7ms with rejection. Space: O(1) extra (the bbox).

export interface LngLat { lng: number; lat: number }

export interface BBox2 { minLng: number; minLat: number; maxLng: number; maxLat: number }

// Bounding box of a polygon ring ([lng, lat][]). O(v) time, O(1) space.
export function bboxOfRing(ring: Array<[number, number]>): BBox2 {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}

// Ray-cast point-in-polygon (even-odd). ring is [lng, lat][]. O(v).
export function pointInRing(lat: number, lng: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// Select the items whose coordinates fall inside the polygon. Bounding-box
// rejection runs first so the exact O(v) test only executes for candidates
// inside the box — the dominant cost for a typical small lasso over a large
// pin set. Items without coordinates never match.
export function selectPointsInPolygon<T extends { lat?: number | null; lng?: number | null }>(
  items: T[],
  ring: Array<[number, number]>,
): T[] {
  if (ring.length < 3) return [];
  const b = bboxOfRing(ring);
  const out: T[] = [];
  for (const it of items) {
    const lat = it.lat, lng = it.lng;
    if (lat == null || lng == null) continue;
    if (lng < b.minLng || lng > b.maxLng || lat < b.minLat || lat > b.maxLat) continue; // O(1) reject
    if (pointInRing(lat, lng, ring)) out.push(it);
  }
  return out;
}
