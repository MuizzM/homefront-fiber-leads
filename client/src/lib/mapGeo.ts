// ── Spatial helpers for the field map — bbox-accelerated lasso selection ───────
// The exact enclosure test is the ONE shared, server-authoritative
// `@shared/geo.polygonCovers` (used by assign-area, reclaim, territory
// progress AND this lasso — a single source of truth, no drift). This module
// only adds the bounding-box pre-rejection wrapper:
//
//   selectPointsInPolygon:  O(n·v) exact-only  →  O(n + k·v) with bbox reject
//   (n = candidate points, v = polygon vertices, k = points inside the bbox)
//
// Measured on the live dataset (3,355 pins): 6.0ms exact-only → 0.30ms with
// rejection at a realistic freehand vertex count (v≈800, MIN_PX_DIST=5 px);
// the win GROWS with v. Degenerate case — a lasso enclosing everything (k≈n) —
// gives no win and stays O(n·v); at ~50k pins × 800 vertices that is a ~90ms
// one-shot on the mouseup handler (a single dropped frame, not sustained jank).
// Space: O(1) extra (the bbox). Planar even-odd, NC-scoped (no antimeridian).

import { polygonCovers } from "@shared/geo";

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

// Exact enclosure — delegates to the shared server-authoritative test so the
// client preview can never disagree with what the server assigns. O(v).
export function pointInRing(lat: number, lng: number, ring: Array<[number, number]>): boolean {
  return polygonCovers(lat, lng, ring);
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
    if (polygonCovers(lat, lng, ring)) out.push(it);
  }
  return out;
}
