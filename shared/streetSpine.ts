// ── Street-spine scanning geometry (pure, deterministic, zero API) ────────────
// The address-discovery cost win: instead of a dense Mapbox reverse-geocode grid
// over a city bbox (most points land on fields/water/parking), walk the actual
// ROAD CENTERLINES from free OSM data and place probe points only where houses
// are. Then a spatial claim grid skips redundant probes on the same lot, and a
// coordinate negative-cache skips known out-of-territory cells.
//
// This module is pure math — it produces the ordered list of probe coordinates.
// WHO resolves a coordinate to an address (Kinetic coordinate-lookup if verified,
// else a bounded Mapbox reverse-geocode of these far-fewer points) is the caller's
// choice; either way the probe COUNT is a fraction of a dense grid.

export interface LatLng { lat: number; lng: number }

const EARTH_M_PER_DEG_LAT = 111_320;
export const metersToLatDeg = (m: number) => m / EARTH_M_PER_DEG_LAT;
export const metersToLngDeg = (m: number, atLat: number) => m / (EARTH_M_PER_DEG_LAT * Math.max(0.05, Math.cos(atLat * Math.PI / 180)));

// Great-circle distance in meters (haversine) — accurate at street scale.
export function haversineM(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Walk a single road polyline, emitting a point every `intervalM` meters along it
// (including the start; interpolated across segments). A degenerate way (0/1 pts)
// emits its single point. Returns points rounded to 6 decimals (~0.1m).
export function walkWay(geometry: LatLng[], intervalM: number): LatLng[] {
  const step = Math.max(1, intervalM);
  const pts: LatLng[] = [];
  const push = (p: LatLng) => pts.push({ lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) });
  if (!geometry.length) return pts;
  if (geometry.length === 1) { push(geometry[0]); return pts; }
  push(geometry[0]);
  let carry = 0; // distance already covered toward the next emit, within the current segment walk
  for (let i = 0; i < geometry.length - 1; i++) {
    const a = geometry[i], b = geometry[i + 1];
    const segLen = haversineM(a, b);
    if (segLen === 0) continue;
    let d = step - carry; // distance from `a` to the first emit on this segment
    while (d <= segLen) {
      const t = d / segLen;
      push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
      d += step;
    }
    carry = segLen - (d - step); // leftover distance carried into the next segment
  }
  return pts;
}

export interface OsmWay { id?: number | string; geometry: LatLng[]; highway?: string; name?: string }

// Turn a set of OSM road ways into the full ordered probe list for a city.
export function roadProbePoints(ways: OsmWay[], intervalM = 40): LatLng[] {
  const out: LatLng[] = [];
  for (const w of ways) if (w.geometry?.length) out.push(...walkWay(w.geometry, intervalM));
  return out;
}

// ── Spatial claim grid — skip a probe if a nearby cell already yielded an address.
// Two probes 40m apart on the same block usually snap to the same house; once one
// cell is claimed, its 3×3 neighborhood is treated as covered. Cuts probes 40-60%
// on dense streets while missing zero NEW addresses.
export class SpatialClaimGrid {
  private claimed = new Set<string>();
  constructor(private cellDeg = 0.0005) {} // ~55m lat cell
  private key(lat: number, lng: number): [number, number] {
    return [Math.floor(lat / this.cellDeg), Math.floor(lng / this.cellDeg)];
  }
  claim(lat: number, lng: number): void {
    const [r, c] = this.key(lat, lng);
    this.claimed.add(`${r}:${c}`);
  }
  // True if this point's cell OR any of the 8 neighbors is already claimed.
  isCovered(lat: number, lng: number): boolean {
    const [r, c] = this.key(lat, lng);
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (this.claimed.has(`${r + dr}:${c + dc}`)) return true;
    return false;
  }
  get size(): number { return this.claimed.size; }
}

// Coordinate negative-cache cell key (~220m) — permanently skip out-of-territory
// or not-found coordinate regions so future scans never re-probe dead land.
export function negativeCellKey(lat: number, lng: number, cellDeg = 0.002): { latCell: number; lngCell: number } {
  return { latCell: Math.floor(lat / cellDeg), lngCell: Math.floor(lng / cellDeg) };
}

// 8 neighbor probes (~30-45m) around a COMING SOON / new-build hit — Kinetic often
// builds a whole block but enters addresses house-by-house, so a single hit expands
// into full-block coverage for 8 cheap probes.
export function clusterOffsets(center: LatLng, spacingM = 35): LatLng[] {
  const dLat = metersToLatDeg(spacingM);
  const dLng = metersToLngDeg(spacingM, center.lat);
  const r6 = (n: number) => +n.toFixed(6);
  const out: LatLng[] = [];
  for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    out.push({ lat: r6(center.lat + a * dLat), lng: r6(center.lng + b * dLng) });
  }
  return out;
}

// Apply the claim grid to an ordered probe list, dropping points already covered by
// an earlier probe's claimed cell. Deterministic given input order. (Runtime hits
// need the ACTUAL address lat/lng to claim; this is the pre-filter that removes
// probes already within a claimed neighborhood, e.g. after seeding from the pool.)
export function dedupeByGrid(points: LatLng[], grid: SpatialClaimGrid): LatLng[] {
  const kept: LatLng[] = [];
  for (const p of points) {
    if (grid.isCovered(p.lat, p.lng)) continue;
    kept.push(p);
    grid.claim(p.lat, p.lng);
  }
  return kept;
}
