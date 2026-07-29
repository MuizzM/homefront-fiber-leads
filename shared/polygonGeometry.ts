// Ring geometry for hand-drawn territories.
//
// shared/geo.ts answers ONE question — "is this door inside that area?" — and it
// answers it well. This module answers the questions that come BEFORE that one,
// about the ring itself:
//
//   Is the shape a manager just lassoed even a valid polygon?
//   How big is it, in units a human can argue with (square metres, not degrees²)?
//   Can we throw away 90% of the 600 touch points a freehand drag produced
//   without changing which doors fall inside?
//
// Why this matters: a lasso stroke is not a polygon. It is a stream of pointer
// samples with duplicate points where the finger paused, a hairline crossing
// where the stroke doubled back, and enough vertices to make every subsequent
// point-in-polygon call — one per door, on every render — cost real time. If a
// self-intersecting ring reaches the database, `pointInPolygon` still returns an
// answer, just an arbitrary one: the parity flip in the bowtie's crossing region
// reports "outside" for doors a rep can see inside the shape they drew. There is
// no error, no log line, only doors that quietly never get assigned.
//
// CONVENTION (matches shared/geo.ts and every stored territory): a ring is an
// array of [lng, lat] pairs and is NOT closed — the last point does not repeat
// the first, and the closing edge from ring[n-1] back to ring[0] is implicit.
// Every function here treats that closing edge as a real edge. Forgetting it is
// how a ring that self-intersects only on its final segment passes validation.
//
// The enclosure test itself is NOT reimplemented here. Callers keep using
// pointInPolygon / polygonCovers from shared/geo.ts; this module only decides
// which rings are worth handing them. BOUNDARY_EPSILON_DEG is reused as the
// default tolerance so "two points are the same point" means the same thing here
// as "this door is on the boundary" does there.

import { BOUNDARY_EPSILON_DEG } from "./geo";

/** A polygon ring: [lng, lat] pairs, open (no repeated closing point). */
export type Ring = [number, number][];

const DEG2RAD = Math.PI / 180;

/** Authalic (equal-area) Earth radius — the sphere with the same surface area as
 *  the WGS84 ellipsoid. Using it instead of the equatorial radius keeps
 *  `ringAreaSqMeters` unbiased on average rather than uniformly ~0.7% high. */
const EARTH_AUTHALIC_RADIUS_M = 6371007.2;

// ── Low-level primitives ─────────────────────────────────────────────────────
// These are planar operations on raw degree coordinates. Over one territory
// (kilometres, not continents) the planar approximation is far below the
// epsilons involved — the same argument shared/geo.ts makes for its own
// distance-to-segment helper. That helper is module-private over there, so the
// two-line version below is a deliberate local re-derivation, not a second
// implementation of an exported API.

/** Twice the signed area of triangle OAB. Sign gives the turn direction of
 *  O→A→B: positive = counter-clockwise, negative = clockwise, 0 = collinear. */
function cross(
  ox: number, oy: number, ax: number, ay: number, bx: number, by: number,
): number {
  return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
}

/** Is P inside the axis-aligned box of AB? Only meaningful once P is known to be
 *  collinear with AB — together they mean "P lies on segment AB". */
function withinSegmentBox(
  ax: number, ay: number, bx: number, by: number, px: number, py: number,
): boolean {
  return (
    px >= Math.min(ax, bx) && px <= Math.max(ax, bx) &&
    py >= Math.min(ay, by) && py <= Math.max(ay, by)
  );
}

/** Distance from P to segment AB, in degrees, treated as planar. */
function distanceToSegmentDeg(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  // Degenerate segment (repeated vertex): fall back to point distance so a
  // duplicated sample in the stroke cannot divide by zero.
  if (lengthSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Do segments P1P2 and P3P4 share at least one point?
 *
 * The classic orientation test, INCLUDING the collinear cases. Touching counts:
 * a vertex landing exactly on another edge, or two collinear edges overlapping,
 * are both real defects in a drawn ring — a ring pinched to a point at a vertex
 * has an interior that no ray-cast agrees on — so they are reported, not
 * excused. Orientation is compared against exact zero rather than an epsilon:
 * coordinates that are genuinely collinear (a straight drag, a rectangle typed
 * in by hand) produce an exact zero, and coordinates that are merely close
 * produce a crossing that either happened or did not. A fuzzy zero here would
 * invent intersections between parallel streets a metre apart.
 */
function segmentsIntersect(
  p1: [number, number], p2: [number, number], p3: [number, number], p4: [number, number],
): boolean {
  const d1 = cross(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1]);
  const d2 = cross(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1]);
  const d3 = cross(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  const d4 = cross(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1]);

  // Proper crossing: each segment strictly straddles the other's line.
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) return true;

  // Touching / collinear-overlap cases.
  if (d1 === 0 && withinSegmentBox(p3[0], p3[1], p4[0], p4[1], p1[0], p1[1])) return true;
  if (d2 === 0 && withinSegmentBox(p3[0], p3[1], p4[0], p4[1], p2[0], p2[1])) return true;
  if (d3 === 0 && withinSegmentBox(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1])) return true;
  if (d4 === 0 && withinSegmentBox(p1[0], p1[1], p2[0], p2[1], p4[0], p4[1])) return true;

  return false;
}

// ── 1. Self-intersection ─────────────────────────────────────────────────────

/**
 * True when any two NON-ADJACENT edges of the ring touch or cross.
 *
 * Adjacent edges are excluded because they always share a vertex by
 * construction — reporting that as an intersection would flag every polygon ever
 * drawn. Two pairs are adjacent: (i, i+1) for every i, and (0, n-1), which meet
 * at ring[0] across the implicit closing edge. That second pair is the one that
 * is easy to forget and the reason a triangle (three edges, all mutually
 * adjacent) can never self-intersect.
 *
 * O(n²). A lasso stroke is thousands of points, so run `simplifyRing` or
 * `dedupeVertices` first if the input is raw pointer samples.
 */
export function hasSelfIntersection(ring: Ring): boolean {
  const n = ring.length;
  // 3 edges or fewer means every pair of edges is adjacent.
  if (n < 4) return false;

  for (let i = 0; i < n; i++) {
    const a1 = ring[i];
    const a2 = ring[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1) continue;            // consecutive edges share ring[j]
      if (i === 0 && j === n - 1) continue; // first and closing edge share ring[0]
      if (segmentsIntersect(a1, a2, ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

// ── 2. Vertex de-duplication ─────────────────────────────────────────────────

/**
 * Drop consecutive points that are within `epsilon` degrees of each other, and
 * drop a trailing point that has come back around to the first.
 *
 * Two separate defects, one pass:
 *   • A finger resting on the screen emits the same coordinate many times. Those
 *     zero-length edges make orientation tests meaningless and turn a valid ring
 *     into one that "touches itself".
 *   • Some clients (and every GeoJSON export) close the ring by repeating the
 *     first point. This codebase stores rings OPEN, so that repeat is a
 *     zero-length closing edge and must go.
 *
 * Distance is compared with `<=` so that `epsilon = 0` still collapses exactly
 * equal points, which is the case worth handling for free. Only CONSECUTIVE
 * points are compared: a ring that legitimately revisits a location later in the
 * stroke keeps both copies, because collapsing them would change the shape.
 * Returns a new array; the input is never mutated.
 */
export function dedupeVertices(ring: Ring, epsilon: number = BOUNDARY_EPSILON_DEG): Ring {
  if (ring.length === 0) return [];

  const out: Ring = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const prev = out[out.length - 1];
    if (Math.hypot(ring[i][0] - prev[0], ring[i][1] - prev[1]) <= epsilon) continue;
    out.push(ring[i]);
  }

  // Trailing point that closes the ring. One pop is enough: consecutive
  // duplicates are already gone, so the new last point is further than epsilon
  // from the one we removed and therefore cannot itself coincide with the first.
  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(last[0] - first[0], last[1] - first[1]) <= epsilon) out.pop();
  }

  return out;
}

// ── 3. Area ──────────────────────────────────────────────────────────────────

/**
 * Area of the ring in square metres, always positive.
 *
 * METHOD. Project to a local equirectangular (plate carrée) plane anchored at
 * the ring's mean latitude — one degree of latitude is a fixed distance, one
 * degree of longitude is that distance times cos(mean latitude) — then take the
 * shoelace sum. Coordinates are made relative to the first vertex before
 * scaling; the shoelace sum is translation-invariant, and subtracting the offset
 * keeps the products at territory scale instead of differencing numbers around
 * -80° where the significant digits go to the offset rather than the shape.
 *
 * SIGN. The shoelace sum is negative for a clockwise ring and positive for a
 * counter-clockwise one. Callers care about size, and nothing upstream enforces
 * a winding order — a manager can lasso in either direction — so the absolute
 * value is returned. Any caller that needs orientation must compute it itself
 * rather than reading it off this number.
 *
 * ERROR BOUND. Two independent approximations:
 *
 *   1. Constant cos(latitude) over the ring. The true area element is
 *      R²·cos φ·dφ·dλ; we use cos φ₀. Writing φ = φ₀ + δ, the ratio is
 *      cos δ − sin δ·tan φ₀ ≈ 1 − δ·tan φ₀ − δ²/2. Anchoring φ₀ at the MEAN
 *      latitude makes the mean of δ ≈ 0, so the first-order term largely
 *      cancels and the residual is O(δ²/2). For a ring spanning 0.1° of
 *      latitude (~11 km, larger than any real territory) δ ≤ 8.7e-4 rad and the
 *      error is under 1 part in 2,000,000 — utterly negligible. Even a 1°
 *      ring stays under 0.005%.
 *
 *   2. Sphere instead of ellipsoid. The local equal-area radius of WGS84 varies
 *      from ~6357 km near the equator to ~6400 km at the poles, so a single
 *      radius costs up to ~0.5% across the continental US and ~1% at extreme
 *      latitudes. This dominates, and it is a scale error: the same ring always
 *      returns the same number, and two rings compare correctly against each
 *      other. It is well inside what "is this territory big enough to assign?"
 *      needs. Anything billed on area should use PostGIS geography instead.
 *
 * Rings that cross the antimeridian are NOT handled — the shoelace runs the
 * long way around the world and the result is meaningless. Screen with
 * `crossesAntimeridian` first. Fewer than 3 points encloses nothing: 0.
 */
export function ringAreaSqMeters(ring: Ring): number {
  const n = ring.length;
  if (n < 3) return 0;

  let latSum = 0;
  for (const point of ring) latSum += point[1];
  const meanLatRad = (latSum / n) * DEG2RAD;

  const metresPerDegLat = EARTH_AUTHALIC_RADIUS_M * DEG2RAD;
  const metresPerDegLng = metresPerDegLat * Math.cos(meanLatRad);

  const lng0 = ring[0][0];
  const lat0 = ring[0][1];

  let twiceSignedArea = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = (ring[i][0] - lng0) * metresPerDegLng;
    const yi = (ring[i][1] - lat0) * metresPerDegLat;
    const xj = (ring[j][0] - lng0) * metresPerDegLng;
    const yj = (ring[j][1] - lat0) * metresPerDegLat;
    twiceSignedArea += xj * yi - xi * yj;
  }

  return Math.abs(twiceSignedArea) / 2;
}

// ── 4. Simplification ────────────────────────────────────────────────────────

/** How many times `simplifyRing` halves the tolerance looking for a simplified
 *  ring that is still simple. Eight halvings take any tolerance to 1/256th of
 *  itself, at which point the output is nearly the input anyway. */
const MAX_SIMPLIFY_BACKOFFS = 8;

/** Douglas-Peucker on the ring treated as an OPEN polyline from ring[0] to
 *  ring[n-1]. Iterative rather than recursive: a raw stroke can be thousands of
 *  points and the recursion depth is data-dependent. */
function douglasPeucker(points: Ring, toleranceDeg: number): Ring {
  const n = points.length;
  if (n <= 2) return points.slice();

  const keep = new Array<boolean>(n).fill(false);
  // The endpoints anchor every recursion and are never candidates for removal.
  keep[0] = true;
  keep[n - 1] = true;

  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const span = stack.pop()!;
    const first = span[0];
    const last = span[1];

    let maxDistance = -1;
    let farthest = -1;
    for (let i = first + 1; i < last; i++) {
      const distance = distanceToSegmentDeg(points[i], points[first], points[last]);
      if (distance > maxDistance) {
        maxDistance = distance;
        farthest = i;
      }
    }

    if (farthest !== -1 && maxDistance > toleranceDeg) {
      keep[farthest] = true;
      stack.push([first, farthest]);
      stack.push([farthest, last]);
    }
  }

  const out: Ring = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * Douglas-Peucker simplification that cannot make a good ring bad.
 *
 * GUARANTEES.
 *   • ring[0] and ring[n-1] are always in the output, in that order. They are
 *     the two ends of the implicit closing edge; dropping either one rotates the
 *     ring and moves the closing edge somewhere the user never drew.
 *   • Every point of the input lies within `toleranceDeg` of the output
 *     polyline — that is the Douglas-Peucker invariant, and it is what lets a
 *     caller pick a tolerance in degrees and reason about how far the boundary
 *     can move.
 *   • If the input does NOT self-intersect, neither does the output. This is the
 *     part plain Douglas-Peucker gets wrong: on a concave shape, chording across
 *     a bay can push the new edge straight through the far wall, turning a valid
 *     territory into one whose interior is undefined. When that happens the
 *     tolerance is halved and the whole simplification retried, up to
 *     MAX_SIMPLIFY_BACKOFFS times; the last resort is a copy of the input, so
 *     the worst case is "no simplification", never "broken ring".
 *
 * A ring that ALREADY self-intersects is simplified without the guard — there is
 * nothing left to protect, and refusing to simplify would just make the broken
 * ring expensive as well as broken.
 *
 * At a large enough tolerance the output can fall to two points. That is honest
 * Douglas-Peucker behaviour (everything really is within tolerance of that
 * chord), not a bug — run `validateRing` afterwards, which reports
 * "too-few-points" for it. Non-positive tolerances are a no-op copy.
 */
export function simplifyRing(ring: Ring, toleranceDeg: number): Ring {
  if (ring.length <= 2 || !(toleranceDeg > 0)) return ring.slice();

  const inputWasSimple = !hasSelfIntersection(ring);
  let tolerance = toleranceDeg;

  for (let attempt = 0; attempt <= MAX_SIMPLIFY_BACKOFFS; attempt++) {
    const candidate = douglasPeucker(ring, tolerance);
    // Nothing was dropped, so nothing can have been broken.
    if (candidate.length === ring.length) return candidate;
    if (!inputWasSimple || !hasSelfIntersection(candidate)) return candidate;
    tolerance /= 2;
  }

  return ring.slice();
}

// ── 5. Validation ────────────────────────────────────────────────────────────

/** Why a ring was rejected. A string union rather than free text so callers can
 *  switch on it and map each case to its own message. */
export type RingValidationFailure =
  | "too-few-points"
  | "too-small"
  | "self-intersecting"
  | "degenerate";

export type RingValidationResult =
  | { ok: true; ring: Ring }
  | { ok: false; reason: RingValidationFailure };

/**
 * Smallest ring worth accepting, in square metres. 100 m² is a 10 m × 10 m
 * square — smaller than any single-parcel territory, but far larger than the
 * sliver an accidental tap-and-twitch produces. The point is to reject strokes
 * that were never meant to be areas, not to impose a business minimum.
 */
export const MIN_RING_AREA_SQ_METERS = 100;

export interface ValidateRingOptions {
  /** Reject rings smaller than this. Defaults to MIN_RING_AREA_SQ_METERS. */
  minAreaSqMeters?: number;
  /** Coincidence tolerance in degrees, used for both de-duplication and the
   *  degeneracy test. Defaults to BOUNDARY_EPSILON_DEG. */
  epsilon?: number;
}

/** True when the ring has no interior: every vertex sits (within epsilon) on the
 *  line through its two most distant vertices. That covers all-identical points,
 *  a straight back-and-forth drag, and any collinear ring, without depending on
 *  an area threshold in degrees² — squaring coordinates near -80° leaves an
 *  absolute noise floor that no fixed epsilon can straddle safely. */
function isDegenerateRing(ring: Ring, epsilon: number): boolean {
  const n = ring.length;
  if (n < 3) return true;

  // The most distant pair of vertices defines the ring's dominant axis.
  let bestDistance = -1;
  let a = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const distance = Math.hypot(ring[j][0] - ring[i][0], ring[j][1] - ring[i][1]);
      if (distance > bestDistance) {
        bestDistance = distance;
        a = i;
        b = j;
      }
    }
  }
  // Every vertex within epsilon of every other: the ring is a single point.
  if (bestDistance <= epsilon) return true;

  for (let i = 0; i < n; i++) {
    if (distanceToSegmentDeg(ring[i], ring[a], ring[b]) > epsilon) return false;
  }
  return true;
}

/**
 * The gate a drawn ring passes through before it becomes a territory.
 *
 * De-duplication runs FIRST and the deduped ring is what gets returned on
 * success, so downstream code stores the cleaned geometry rather than the raw
 * stroke. Rejections are then ordered from most to least fundamental, because a
 * broken ring usually trips several checks at once and the first reason should
 * be the one that explains the others:
 *
 *   too-few-points   → fewer than 3 distinct points; not a polygon at all.
 *   degenerate       → 3+ points but no interior (collinear / a zero-width
 *                      sliver). Checked before self-intersection: a collinear
 *                      ring's closing edge retraces the outbound path, so it
 *                      *is* self-overlapping, but "you drew a line" is the
 *                      useful thing to say.
 *   self-intersecting→ a real shape, but one whose inside is undefined.
 *   too-small        → a valid simple ring, just below the area floor.
 */
export function validateRing(ring: Ring, opts: ValidateRingOptions = {}): RingValidationResult {
  const epsilon = opts.epsilon ?? BOUNDARY_EPSILON_DEG;
  const minArea = opts.minAreaSqMeters ?? MIN_RING_AREA_SQ_METERS;

  const cleaned = dedupeVertices(ring, epsilon);

  if (cleaned.length < 3) return { ok: false, reason: "too-few-points" };
  if (isDegenerateRing(cleaned, epsilon)) return { ok: false, reason: "degenerate" };
  if (hasSelfIntersection(cleaned)) return { ok: false, reason: "self-intersecting" };
  if (ringAreaSqMeters(cleaned) < minArea) return { ok: false, reason: "too-small" };

  return { ok: true, ring: cleaned };
}

// ── 6. Antimeridian ──────────────────────────────────────────────────────────

/**
 * True when any edge — including the closing edge — spans more than 180° of
 * longitude.
 *
 * Such an edge is ambiguous: the short way round crosses ±180°, the long way
 * round is what every planar routine in this file (and `pointInPolygon` in
 * shared/geo.ts) actually computes. Rather than guess, callers detect the case
 * and refuse. This service operates in the continental US, so the honest
 * behaviour is to flag the ring as unsupported rather than to silently return
 * an area the size of a hemisphere.
 *
 * Exactly 180° is not flagged: that is a genuine antipodal edge, still
 * ambiguous, but it cannot arise from a drawn stroke and reporting it would
 * make the boundary of this predicate depend on floating-point equality.
 */
export function crossesAntimeridian(ring: Ring): boolean {
  const n = ring.length;
  if (n < 2) return false;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (Math.abs(ring[i][0] - ring[j][0]) > 180) return true;
  }
  return false;
}
