// Freehand stroke smoothing for the field map lasso and saved territory outlines.
//
// WHY THIS EXISTS: a rep drawing a territory with a thumb on a phone in the sun
// does not produce a clean curve. Pointer events arrive as a jittery stream —
// duplicate samples where the finger paused, stair-step wobble from touch
// quantization, and hundreds of vertices for a shape that needs a dozen. Drawn
// raw, the lasso looks amateur next to SalesRabbit; stored raw, every vertex
// taxes each later point-in-polygon call. The fix is the classic three-stage
// pipeline, each stage pure planar math over { x, y } pairs so the SAME code
// runs on screen pixels mid-gesture and on lng/lat rings at save time:
//
//   1. simplifyStroke  — Ramer-Douglas-Peucker: drop vertices that do not
//      change the shape by more than epsilon. Kills the touch jitter.
//   2. chaikinSmooth   — Chaikin corner cutting (0.25 / 0.75): replace each
//      corner with two points a quarter of the way along its edges. Two
//      iterations approximate a quadratic B-spline. Chaikin, and NOT a
//      Catmull-Rom or other interpolating spline, is deliberate: every output
//      point is a convex combination of two adjacent input points, so the
//      curve is contraction-only — it can never escape the drawn bounds or
//      swing outside the stroke the way overshooting splines do. A rep who
//      lassos around a house never gets a smoothed ring that clips it.
//   3. resampleStroke  — even arc-length resampling, for dotted-line
//      rendering and stable vertex density regardless of drawing speed.
//
// Because Chaikin only cuts corners, one iteration applied to a SIMPLE
// (non-self-intersecting) ring yields another simple ring: each new edge lies
// inside the triangle spanned by an original corner, so no new crossings can
// appear. This module therefore never makes self-intersection WORSE than the
// input; it does NOT attempt to repair crossings the rep actually drew — that
// is shared/polygonGeometry.ts's department.
//
// CONVENTION (matches shared/geo.ts and shared/polygonGeometry.ts): a closed
// ring is stored OPEN — the last point does not repeat the first; the closing
// edge is implicit. Every `closed` code path here honors that.
//
// No imports. Pure geometry, safe for client, server, and tests alike.

/** A 2-D point. Works for screen pixels or [lng, lat] alike — it is pure math;
 *  callers keep both coordinates in the same units as any epsilon/spacing. */
export interface Pt {
  x: number;
  y: number;
}

// ── Private helpers ──────────────────────────────────────────────────────────

/** Clone-and-drop consecutive duplicate points. With `cyclic`, also drop
 *  trailing points equal to the first (a finger that ends exactly on the start
 *  point, or a caller that passed a closed ring with the closing point
 *  repeated). Deduping FIRST is the NaN guard for everything downstream:
 *  zero-length segments are what make perpendicular distances and arc-length
 *  parameters divide by zero. */
function dedupeConsecutive(points: Pt[], cyclic: boolean): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (!prev || prev.x !== p.x || prev.y !== p.y) out.push({ x: p.x, y: p.y });
  }
  if (cyclic) {
    while (out.length > 1) {
      const first = out[0];
      const last = out[out.length - 1];
      if (first.x === last.x && first.y === last.y) out.pop();
      else break;
    }
  }
  return out;
}

/** Point at fraction t along segment a→b (0 = a, 1 = b). */
function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Distance from p to the infinite line through a and b — the classic RDP
 *  deviation measure. When a and b coincide (a stroke that loops back onto its
 *  exact start point makes the recursion's endpoints equal even after
 *  consecutive dedupe) the line is undefined, so fall back to plain distance
 *  to the point instead of dividing by zero. */
function lineDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / Math.sqrt(len2);
}

// ── 1. Simplify ──────────────────────────────────────────────────────────────

/**
 * Ramer-Douglas-Peucker simplification. Always keeps both endpoints; drops
 * every interior vertex whose deviation from the local baseline is <= epsilon
 * (same units as the points: pixels for screen strokes, degrees for rings).
 * epsilon of 0 (or negative / NaN) performs no simplification and returns the
 * input dedup'd. Larger epsilon never keeps MORE points than smaller epsilon:
 * the split vertex (farthest point) is epsilon-independent, so the kept set
 * only shrinks as epsilon grows.
 */
export function simplifyStroke(points: Pt[], epsilon: number): Pt[] {
  const pts = dedupeConsecutive(points, false);
  if (!(epsilon > 0) || pts.length < 3) return pts;

  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;

  // Explicit stack, not recursion: a slow drag can produce thousands of
  // samples and adversarial orderings recurse O(n) deep.
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = lineDistance(pts[i], pts[lo], pts[hi]);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist > epsilon) {
      keep[maxIdx] = true;
      stack.push([lo, maxIdx], [maxIdx, hi]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// ── 2. Smooth ────────────────────────────────────────────────────────────────

/** One Chaikin corner-cutting pass. Open strokes keep their exact endpoints
 *  (first and last output points ARE the input endpoints; the cuts adjacent to
 *  them are dropped so the curve stays anchored where the finger started and
 *  stopped). Closed rings cut every corner including the implicit closing
 *  edge, so the seam smooths like any other corner. */
function chaikinOnce(pts: Pt[], closed: boolean): Pt[] {
  const n = pts.length;
  const out: Pt[] = [];
  if (closed) {
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      out.push(lerp(a, b, 0.25), lerp(a, b, 0.75));
    }
  } else {
    out.push(pts[0]);
    for (let i = 0; i < n - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (i > 0) out.push(lerp(a, b, 0.25));
      if (i < n - 2) out.push(lerp(a, b, 0.75));
    }
    out.push(pts[n - 1]);
  }
  return out;
}

/**
 * Chaikin corner cutting (0.25 / 0.75 cuts), `iterations` passes (default 2 —
 * visually indistinguishable from the limit B-spline at map scale, at a
 * quarter of the vertex count of 4 passes).
 *
 * Vertex-count formulas (n = distinct input points, k = iterations, n >= 3):
 *   open:   2^k * (n - 2) + 2   — endpoint-anchored, so each pass maps
 *                                  m -> 2m - 2 (exact first/last preserved)
 *   closed: 2^k * n             — every corner (seam included) yields 2 points
 *
 * `closed` treats the input as a cyclic ring per the module convention (open
 * storage, implicit closing edge); the output is likewise a closed ring
 * WITHOUT a duplicated first/last point. Inputs with fewer than 3 distinct
 * points are returned dedup'd unchanged — there is no corner to cut.
 */
export function chaikinSmooth(points: Pt[], iterations = 2, closed = false): Pt[] {
  let pts = dedupeConsecutive(points, closed);
  if (pts.length < 3) return pts;
  const passes = Math.max(0, Math.floor(iterations));
  for (let k = 0; k < passes; k++) pts = chaikinOnce(pts, closed);
  return pts;
}

// ── 3. Resample ──────────────────────────────────────────────────────────────

/**
 * Evenly-spaced points along the polyline at arc-length interval `spacing`
 * (same units as the points). Used for dotted in-progress lasso rendering and
 * for pinning vertex density independent of how fast the finger moved.
 *
 * Always keeps the exact start point. Open strokes also keep the exact end
 * point, so the final gap may be shorter than `spacing` when the total length
 * is not an exact multiple. Closed rings wrap the implicit closing edge and
 * do NOT repeat the start point — the wrap-around gap absorbs the remainder.
 * spacing <= 0 (or NaN) throws: a non-positive step would loop forever.
 */
export function resampleStroke(points: Pt[], spacing: number, closed = false): Pt[] {
  if (!(spacing > 0)) {
    throw new Error(`resampleStroke: spacing must be > 0, got ${spacing}`);
  }
  const pts = dedupeConsecutive(points, closed);
  const n = pts.length;
  if (n === 0) return [];
  if (n === 1) return [{ x: pts[0].x, y: pts[0].y }];

  const edgeCount = closed ? n : n - 1;
  let total = 0;
  const lengths: number[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    lengths.push(len);
    total += len;
  }

  // Relative tolerance keeps "landed exactly on the end" stable across the
  // floating-point drift of accumulating many segment lengths.
  const eps = total * 1e-9;
  const out: Pt[] = [{ x: pts[0].x, y: pts[0].y }];
  let target = spacing;
  let acc = 0;
  for (let i = 0; i < edgeCount; i++) {
    const len = lengths[i];
    if (len === 0) continue;
    const a = pts[i];
    const b = pts[(i + 1) % n];
    while (target <= acc + len + eps && target < total - eps) {
      const t = Math.min(Math.max((target - acc) / len, 0), 1);
      out.push(lerp(a, b, t));
      target += spacing;
    }
    acc += len;
  }
  if (!closed) out.push({ x: pts[n - 1].x, y: pts[n - 1].y });
  return out;
}

// ── The lasso pipeline ───────────────────────────────────────────────────────

/**
 * One-call pipeline run when a lasso gesture completes: dedupe -> RDP
 * simplify (default epsilon 2 — about touch-jitter magnitude in CSS pixels)
 * -> closed Chaikin (default 2 iterations). Input is the raw pointer trail;
 * output is an open-stored closed ring ready for polygonGeometry validation
 * and storage.
 *
 * Returns [] when the gesture is not a drawable ring: fewer than
 * `minPoints` (default 4) DISTINCT input points — repeated samples from a
 * held-still finger do not count — or a stroke that simplifies to a line
 * (fewer than 3 vertices survive RDP). Callers treat [] as "ignore the
 * gesture", never as a valid territory.
 *
 * Self-intersection: per the module header, Chaikin cannot introduce new
 * crossings on a simple ring, so the result is never worse than what the rep
 * drew; crossings present in the input are NOT repaired here.
 */
export function smoothLassoRing(
  raw: Pt[],
  opts: { epsilon?: number; iterations?: number; minPoints?: number } = {},
): Pt[] {
  const { epsilon = 2, iterations = 2, minPoints = 4 } = opts;
  const pts = dedupeConsecutive(raw, true);
  if (pts.length < Math.max(minPoints, 3)) return [];

  // RDP runs open (its endpoint anchoring is harmless on a ring — the seam
  // gets smoothed by the closed Chaikin pass right after).
  const simplified = simplifyStroke(pts, epsilon);
  if (simplified.length < 3) return [];

  return chaikinSmooth(simplified, iterations, true);
}
