// Ray-cast point-in-polygon — the ONE enclosure test shared by assign-area,
// reclaim, territory progress, and (conceptually) the client lasso. Polygon
// points are [lng, lat] to match how territories are stored.
export function pointInPolygon(lat: number, lng: number, poly: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) hit = !hit;
  }
  return hit;
}

// ── Boundary inclusion ───────────────────────────────────────────────────────
// pointInPolygon is a strict ray-cast: ST_Contains, not ST_Covers. A door lying
// exactly ON the drawn edge lands inside or outside depending on which side of a
// floating-point comparison it falls, and a vertex-crossing ray can flip the
// parity twice and report OUTSIDE for a point that is visibly on the line.
//
// That is not an abstract concern. Managers cut area boundaries down the middle
// of a street, and the houses on that street are exactly the ones whose
// coordinates sit on the edge — so the doors most likely to be silently dropped
// are the ones a rep can see from where they are standing.
//
// polygonCovers answers "inside OR on the boundary", which is what assignment
// means, and it is the behaviour ST_Covers gives you in PostGIS.

/** Degrees. ~1e-9° is around 0.1 mm — small enough that it only absorbs
 *  floating-point noise and rounding in stored coordinates, never a house that
 *  is genuinely on the other side of the line. */
export const BOUNDARY_EPSILON_DEG = 1e-9;

/** Distance from P to segment AB, in degrees, treating coordinates as planar.
 *  Over a single territory that approximation is far below the epsilon. */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  // Degenerate segment (a repeated vertex) — fall back to point distance so a
  // duplicated point in the stroke cannot divide by zero.
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** True when the point lies on any edge of the ring (within epsilon). */
export function pointOnPolygonBoundary(
  lat: number, lng: number, poly: [number, number][], epsilon = BOUNDARY_EPSILON_DEG,
): boolean {
  if (poly.length < 2) return false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (distanceToSegment(lng, lat, poly[j][0], poly[j][1], poly[i][0], poly[i][1]) <= epsilon) return true;
  }
  return false;
}

/**
 * ST_Covers equivalent: the point is inside the polygon OR on its boundary.
 *
 * This is the predicate territory membership uses. Interior is checked first
 * because it is the common case and cheaper; the boundary walk only runs for
 * points the ray-cast rejected.
 */
export function polygonCovers(
  lat: number, lng: number, poly: [number, number][], epsilon = BOUNDARY_EPSILON_DEG,
): boolean {
  if (poly.length < 3) return false;
  return pointInPolygon(lat, lng, poly) || pointOnPolygonBoundary(lat, lng, poly, epsilon);
}
