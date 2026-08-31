import { describe, it, expect } from "vitest";
import { polygonCovers } from "@shared/geo";
import {
  MIN_RING_AREA_SQ_METERS,
  crossesAntimeridian,
  dedupeVertices,
  hasSelfIntersection,
  healSelfIntersections,
  ringAreaSqMeters,
  simplifyRing,
  validateRing,
  type Ring,
} from "@shared/polygonGeometry";

/**
 * WHY THIS FILE EXISTS
 *
 * shared/geo.ts is tested for "is this door inside that area?". Nothing tested
 * whether the AREA was ever a valid polygon in the first place, and that is the
 * failure mode with no symptom: `pointInPolygon` never throws. Hand it a bowtie
 * and it returns a confident, arbitrary answer — the parity flip in the crossing
 * region reports OUTSIDE for doors sitting visibly inside the shape a manager
 * drew. No error, no log line, just doors that quietly never get assigned.
 *
 * So these tests are less about "does the maths work" and more about the four
 * ways a freehand lasso stroke betrays the code downstream of it:
 *
 *   1. It self-intersects where the stroke doubled back  → hasSelfIntersection
 *   2. It repeats points where the finger paused         → dedupeVertices
 *   3. It is 600 points long, on every point-in-polygon  → simplifyRing
 *   4. It is not actually an area (a line, a tap)        → validateRing
 *
 * Two properties get the most scrutiny, because they are the ones a plausible
 * implementation gets wrong while still passing casual tests:
 *
 *   • simplifyRing must not INTRODUCE a self-intersection. Textbook
 *     Douglas-Peucker happily chords across the mouth of a concave bay and
 *     straight through the far wall. That converts a valid territory into an
 *     undefined one, and it happens precisely on the C-shaped areas managers
 *     actually draw around a subdivision.
 *   • ringAreaSqMeters must be sign-independent. Nothing enforces winding
 *     order — a manager can lasso clockwise or anticlockwise — so a signed
 *     shoelace returns a NEGATIVE area for half of all real strokes, and every
 *     "is this big enough?" comparison against a minimum then passes for shapes
 *     it should reject.
 *
 * CONVENTION under test: rings are [lng, lat] pairs and are OPEN — the last
 * point does not repeat the first, and the closing edge is implicit. Half the
 * assertions below exist to prove that closing edge is treated as a real edge.
 */

// A 0.01° box around Rockwell NC — roughly 1.1 km × 0.9 km, the size of a real
// territory. Wound counter-clockwise in [lng, lat] space.
const BOX_CCW: Ring = [
  [-80.40, 35.55],
  [-80.39, 35.55],
  [-80.39, 35.56],
  [-80.40, 35.56],
];

// ── test-local helpers ───────────────────────────────────────────────────────

/** Distance from p to segment ab, in degrees, planar. Deliberately written here
 *  rather than imported: the assertions about "within tolerance" must be checked
 *  against an independent expression of the idea, not against the same helper
 *  the implementation used to make its decision. */
function distanceToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Shortest distance from p to the OPEN polyline through `ring` (the path
 *  Douglas-Peucker is allowed to deviate from). */
function distanceToPath(p: [number, number], ring: Ring): number {
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    best = Math.min(best, distanceToSegment(p, ring[i], ring[i + 1]));
  }
  return best;
}

/** Deterministic LCG. A seeded generator, not Math.random: a flaky geometry test
 *  that only fails on one CI run in fifty is worse than no test. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** A circle whose RADIUS is jittered — the shape a finger traces when it is
 *  trying to draw a loop. Jittering the radius rather than the angle keeps the
 *  ring star-shaped, so the input is guaranteed simple and any self-intersection
 *  in the output is unambiguously the simplifier's doing. */
function noisyCircle(pointCount: number, radiusDeg: number, jitterDeg: number, seed: number): Ring {
  const random = makeRandom(seed);
  const ring: Ring = [];
  for (let i = 0; i < pointCount; i++) {
    const angle = (2 * Math.PI * i) / pointCount;
    const radius = radiusDeg + (random() * 2 - 1) * jitterDeg;
    ring.push([-80.40 + radius * Math.cos(angle), 35.55 + radius * Math.sin(angle)]);
  }
  return ring;
}

/** A spiral ribbon: outward along an Archimedean spiral, then back along the
 *  same spiral offset inward by `width`. Simple as long as width < pitch, but
 *  its arms run close together — so a chord that cuts a corner off one arm lands
 *  in the next one. This is the shape that actually breaks plain
 *  Douglas-Peucker; a C-shape's single bay is too forgiving to trip it. */
function spiralRibbon(turns: number, pointsPerTurn: number, r0: number, pitch: number, width: number): Ring {
  const ring: Ring = [];
  const total = turns * 2 * Math.PI;
  const steps = Math.round(pointsPerTurn * turns);
  const push = (angle: number, radius: number) =>
    ring.push([-80.40 + radius * Math.cos(angle), 35.55 + radius * Math.sin(angle)]);
  for (let i = 0; i <= steps; i++) {
    const angle = (total * i) / steps;
    push(angle, r0 + (pitch * angle) / (2 * Math.PI));
  }
  for (let i = steps; i >= 0; i--) {
    const angle = (total * i) / steps;
    push(angle, r0 + (pitch * angle) / (2 * Math.PI) - width);
  }
  return ring;
}

/** CONTROL: textbook Douglas-Peucker with no self-intersection guard. Its only
 *  job is to prove the guard in simplifyRing is load-bearing — that the
 *  tolerances swept below really do break an unguarded simplifier, rather than
 *  being tolerances at which nothing interesting happens. */
function naiveDouglasPeucker(points: Ring, tolerance: number): Ring {
  const n = points.length;
  if (n <= 2) return points.slice();
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let maxDistance = -1;
    let farthest = -1;
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment(points[i], points[first], points[last]);
      if (d > maxDistance) {
        maxDistance = d;
        farthest = i;
      }
    }
    if (farthest !== -1 && maxDistance > tolerance) {
      keep[farthest] = true;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** A C-shape: an outer arc out, an inner arc back. Concave, simple, and its
 *  mouth is exactly the kind of gap a simplifier wants to chord across. */
function cShape(pointsPerArc: number): Ring {
  const ring: Ring = [];
  const startDeg = 20;
  const endDeg = 340;
  const push = (radius: number, degrees: number) => {
    const angle = degrees * (Math.PI / 180);
    ring.push([-80.40 + radius * Math.cos(angle), 35.55 + radius * Math.sin(angle)]);
  };
  for (let i = 0; i < pointsPerArc; i++) {
    push(0.02, startDeg + ((endDeg - startDeg) * i) / (pointsPerArc - 1));
  }
  for (let i = 0; i < pointsPerArc; i++) {
    push(0.01, endDeg - ((endDeg - startDeg) * i) / (pointsPerArc - 1));
  }
  return ring;
}

// ── 1. hasSelfIntersection ───────────────────────────────────────────────────

describe("hasSelfIntersection reports only genuine crossings", () => {
  it("returns false for a simple convex ring", () => {
    expect(hasSelfIntersection(BOX_CCW)).toBe(false);
  });

  it("returns false for a concave ring", () => {
    // An L-shape is concave but simple. An implementation that mistook
    // concavity (a reflex interior angle) for self-intersection would reject
    // most real territories, which are drawn around street blocks.
    const lShape: Ring = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];
    expect(hasSelfIntersection(lShape)).toBe(false);
  });

  it("detects a bowtie whose crossing is in the middle of the ring", () => {
    // Edges (0→1) and (2→3) cross at the centre. This is the shape that makes
    // pointInPolygon return an arbitrary answer for the crossing region.
    const bowtie: Ring = [
      [-80.40, 35.55],
      [-80.39, 35.56],
      [-80.39, 35.55],
      [-80.40, 35.56],
    ];
    expect(hasSelfIntersection(bowtie)).toBe(true);
  });

  it("detects a crossing that involves the implicit closing edge", () => {
    // The only defect here is the final ring[4] → ring[0] segment slicing back
    // through the body of the shape. Because rings are stored OPEN, an
    // implementation that iterates i → i+1 without wrapping never looks at this
    // edge and calls the ring clean. That is the whole point of the convention.
    const closingEdgeCrosses: Ring = [
      [0, 0],
      [4, 0],
      [4, 4],
      [2, 4],
      [2, -2],
    ];
    expect(hasSelfIntersection(closingEdgeCrosses)).toBe(true);
  });

  it("does not flag adjacent edges, which always share a vertex", () => {
    // A very sharp spike: edges (1→2) and (2→3) meet at an almost-zero angle and
    // very nearly overlap. They share ring[2] by construction, so they must be
    // exempt — an implementation that compares every edge pair without excluding
    // neighbours reports true for every polygon ever drawn.
    const spike: Ring = [
      [0, 0],
      [4, 0],
      [4.0001, 2],
      [4, 4],
      [0, 4],
    ];
    expect(hasSelfIntersection(spike)).toBe(false);
  });

  it("never reports an intersection for a triangle, whose edges are all adjacent", () => {
    const triangle: Ring = [[0, 0], [1, 0], [0, 1]];
    expect(hasSelfIntersection(triangle)).toBe(false);
  });

  it("reports a collinear 4-point ring, whose closing edge retraces the path", () => {
    // [0,0] → [1,0] → [2,0] → [3,0] and then straight back over all three. Edge
    // (1→2) and the closing edge overlap along a whole interval, which is a real
    // (if degenerate) self-overlap. validateRing reports this as "degenerate"
    // instead, because that is the more useful thing to tell a user.
    expect(hasSelfIntersection([[0, 0], [1, 0], [2, 0], [3, 0]])).toBe(true);
  });

  it("returns false for degenerate inputs rather than throwing", () => {
    expect(hasSelfIntersection([])).toBe(false);
    expect(hasSelfIntersection([[0, 0]])).toBe(false);
    expect(hasSelfIntersection([[0, 0], [1, 1]])).toBe(false);
    expect(hasSelfIntersection([[0, 0], [0, 0], [0, 0]])).toBe(false);
  });
});

// ── 2. dedupeVertices ────────────────────────────────────────────────────────

describe("dedupeVertices cleans a stroke without changing its shape", () => {
  it("collapses consecutive repeated points", () => {
    // What a finger resting on the screen produces. The zero-length edges it
    // leaves behind make every orientation test meaningless.
    const paused: Ring = [[0, 0], [0, 0], [1, 0], [1, 0], [1, 0], [1, 1]];
    expect(dedupeVertices(paused)).toEqual([[0, 0], [1, 0], [1, 1]]);
  });

  it("drops a trailing point that repeats the first", () => {
    // GeoJSON closes its rings; this codebase stores them open. Left in place,
    // the repeat is a zero-length closing edge.
    const closed: Ring = [[0, 0], [1, 0], [1, 1], [0, 0]];
    expect(dedupeVertices(closed)).toEqual([[0, 0], [1, 0], [1, 1]]);
  });

  it("keeps points that repeat NON-consecutively", () => {
    // A stroke that legitimately passes back over a location. Collapsing these
    // would silently change the drawn shape, so only neighbours are compared.
    const revisits: Ring = [[0, 0], [1, 0], [0, 0], [1, 1], [0, 1]];
    expect(dedupeVertices(revisits)).toEqual(revisits);
  });

  it("honours a caller-supplied epsilon", () => {
    const nearlyEqual: Ring = [[0, 0], [0.004, 0], [1, 0], [1, 1]];
    // Default epsilon (~1e-9°) is far too small to merge points 0.004° apart.
    expect(dedupeVertices(nearlyEqual)).toHaveLength(4);
    // A 0.01° epsilon merges them.
    expect(dedupeVertices(nearlyEqual, 0.01)).toEqual([[0, 0], [1, 0], [1, 1]]);
  });

  it("reduces an all-identical ring to a single point", () => {
    // Not to zero: the first point is always kept, so callers get a length they
    // can reason about. validateRing turns this into "too-few-points".
    expect(dedupeVertices([[5, 5], [5, 5], [5, 5], [5, 5]])).toEqual([[5, 5]]);
  });

  it("handles empty and single-point input", () => {
    expect(dedupeVertices([])).toEqual([]);
    expect(dedupeVertices([[1, 2]])).toEqual([[1, 2]]);
  });

  it("does not mutate the input ring", () => {
    const input: Ring = [[0, 0], [0, 0], [1, 1]];
    dedupeVertices(input);
    expect(input).toHaveLength(3);
  });
});

// ── 3. ringAreaSqMeters ──────────────────────────────────────────────────────

describe("ringAreaSqMeters returns a positive area in human units", () => {
  it("matches the hand-computed size of a 0.01° box", () => {
    // 0.01° of latitude is 1111.95 m. 0.01° of longitude at 35.555°N is
    // 1111.95 × cos(35.555°) = 904.8 m. Expected ≈ 1.006e6 m².
    const expected = 1111.95 * (1111.95 * Math.cos(35.555 * (Math.PI / 180)));
    expect(ringAreaSqMeters(BOX_CCW)).toBeCloseTo(expected, -2); // ±50 m² of ~1e6
  });

  it("returns the SAME positive value regardless of winding direction", () => {
    // The load-bearing assertion. Nothing upstream enforces a winding order — a
    // manager lassoes whichever way their hand goes — so a signed shoelace makes
    // half of all real strokes return a negative "area", and every
    // `area < minimum` rejection check then passes for shapes it must reject.
    const clockwise: Ring = [...BOX_CCW].reverse() as Ring;
    expect(ringAreaSqMeters(clockwise)).toBeGreaterThan(0);
    expect(ringAreaSqMeters(clockwise)).toBeCloseTo(ringAreaSqMeters(BOX_CCW), 6);
  });

  it("scales linearly with width, so two rings compare correctly", () => {
    // Absolute accuracy is bounded by the spherical-Earth assumption (~0.5%),
    // but relative comparisons between nearby rings must be exact.
    const doubleWide: Ring = [
      [-80.40, 35.55],
      [-80.38, 35.55],
      [-80.38, 35.56],
      [-80.40, 35.56],
    ];
    expect(ringAreaSqMeters(doubleWide) / ringAreaSqMeters(BOX_CCW)).toBeCloseTo(2, 3);
  });

  it("is unaffected by which vertex the ring starts at", () => {
    const rotated: Ring = [BOX_CCW[2], BOX_CCW[3], BOX_CCW[0], BOX_CCW[1]];
    expect(ringAreaSqMeters(rotated)).toBeCloseTo(ringAreaSqMeters(BOX_CCW), 6);
  });

  it("returns 0 for shapes that enclose nothing", () => {
    expect(ringAreaSqMeters([])).toBe(0);
    expect(ringAreaSqMeters([[0, 0]])).toBe(0);
    expect(ringAreaSqMeters([[0, 0], [1, 1]])).toBe(0);
    expect(ringAreaSqMeters([[0, 0], [0, 0], [0, 0]])).toBe(0);
    // Collinear points: three vertices, still no interior.
    expect(ringAreaSqMeters([[0, 35], [1, 35], [2, 35]])).toBeCloseTo(0, 6);
  });
});

// ── 4. simplifyRing ──────────────────────────────────────────────────────────

describe("simplifyRing thins a stroke without breaking the ring", () => {
  it("always preserves the first and last points", () => {
    // These two are the ends of the implicit closing edge. Dropping either
    // rotates the ring and moves the closing edge somewhere the user never drew
    // — a silent change to which doors fall inside.
    const noisy = noisyCircle(400, 0.01, 0.0002, 12345);
    for (const tolerance of [0.0001, 0.0005, 0.002, 0.05, 5]) {
      const simplified = simplifyRing(noisy, tolerance);
      expect(simplified[0]).toEqual(noisy[0]);
      expect(simplified[simplified.length - 1]).toEqual(noisy[noisy.length - 1]);
    }
  });

  it("cuts a noisy freehand ring down substantially", () => {
    const noisy = noisyCircle(400, 0.01, 0.0002, 12345);
    const simplified = simplifyRing(noisy, 0.0005);
    // 400 pointer samples is a normal lasso drag, and every one of them costs a
    // ray-cast per door on every render.
    expect(simplified.length).toBeLessThan(noisy.length * 0.25);
    expect(simplified.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps every original point within tolerance of the simplified path", () => {
    // The Douglas-Peucker invariant, and the reason a caller can pick a
    // tolerance in degrees and reason about how far the boundary may move. An
    // implementation that dropped points by index (every other point, say)
    // would still shrink the ring but would violate this.
    const noisy = noisyCircle(400, 0.01, 0.0002, 999);
    const tolerance = 0.0005;
    const simplified = simplifyRing(noisy, tolerance);
    for (const point of noisy) {
      expect(distanceToPath(point, simplified)).toBeLessThanOrEqual(tolerance + 1e-12);
    }
  });

  it("only ever returns points that were in the input", () => {
    // Simplification selects vertices; it must never interpolate new ones.
    const noisy = noisyCircle(200, 0.01, 0.0002, 4242);
    const original = new Set(noisy.map((p) => `${p[0]},${p[1]}`));
    for (const point of simplifyRing(noisy, 0.001)) {
      expect(original.has(`${point[0]},${point[1]}`)).toBe(true);
    }
  });

  it("never introduces a self-intersection into a concave ring", () => {
    // Chording across a bay can send the new edge through the far wall, turning
    // a valid territory into one whose interior is undefined. A plain C-shape is
    // concave but too forgiving to trip it, so both shapes are swept.
    for (const concave of [cShape(60), spiralRibbon(2.5, 80, 0.006, 0.008, 0.003)]) {
      expect(hasSelfIntersection(concave)).toBe(false); // the input is clean
      for (const tolerance of [0.0005, 0.001, 0.002, 0.004, 0.006, 0.01, 0.015, 0.03]) {
        expect(hasSelfIntersection(simplifyRing(concave, tolerance))).toBe(false);
      }
    }
  });

  it("backs off tolerance where unguarded Douglas-Peucker would break the ring", () => {
    // Proof that the guard above is doing work rather than sitting on tolerances
    // that were harmless anyway. On this spiral at 0.01°, textbook
    // Douglas-Peucker cuts corners off one arm into the next and produces a
    // self-intersecting ring. simplifyRing must halve its way down to a
    // less-simplified — but valid — result.
    const spiral = spiralRibbon(2.5, 80, 0.006, 0.008, 0.003);
    const tolerance = 0.01;

    const unguarded = naiveDouglasPeucker(spiral, tolerance);
    expect(hasSelfIntersection(unguarded)).toBe(true); // the trap is live

    const guarded = simplifyRing(spiral, tolerance);
    expect(hasSelfIntersection(guarded)).toBe(false);
    // "Less simplified" is the price of staying valid — it must keep MORE points
    // than the broken version, not fall back to doing nothing at all.
    expect(guarded.length).toBeGreaterThan(unguarded.length);
    expect(guarded.length).toBeLessThan(spiral.length);
  });

  it("keeps doors well inside a concave ring inside it after simplification", () => {
    // Composes with the enclosure test in shared/geo.ts, which is the whole
    // reason simplification has to be safe. A point deep in the arm of the C
    // must not fall out of the territory because the outline was thinned.
    const c = cShape(60);
    const simplified = simplifyRing(c, 0.001);
    const deep: [number, number] = [-80.40 + 0.015 * Math.cos(3), 35.55 + 0.015 * Math.sin(3)];
    expect(polygonCovers(deep[1], deep[0], c)).toBe(true);
    expect(polygonCovers(deep[1], deep[0], simplified)).toBe(true);
  });

  it("is a no-op for non-positive tolerance", () => {
    expect(simplifyRing(BOX_CCW, 0)).toEqual(BOX_CCW);
    expect(simplifyRing(BOX_CCW, -1)).toEqual(BOX_CCW);
  });

  it("leaves an already-minimal ring alone", () => {
    // Every vertex of a box is a corner; none is within tolerance of the chord
    // between its neighbours, so nothing may be dropped.
    expect(simplifyRing(BOX_CCW, 0.0001)).toEqual(BOX_CCW);
  });

  it("drops collinear intermediate points", () => {
    const withRedundantPoints: Ring = [[0, 0], [1, 0], [2, 0], [3, 0], [3, 3], [0, 3]];
    expect(simplifyRing(withRedundantPoints, 0.001)).toEqual([[0, 0], [3, 0], [3, 3], [0, 3]]);
  });

  it("handles degenerate inputs rather than throwing", () => {
    expect(simplifyRing([], 0.001)).toEqual([]);
    expect(simplifyRing([[0, 0]], 0.001)).toEqual([[0, 0]]);
    expect(simplifyRing([[0, 0], [1, 1]], 0.001)).toEqual([[0, 0], [1, 1]]);
    // All-identical points: everything is within tolerance of the chord, so only
    // the two protected endpoints survive.
    expect(simplifyRing([[5, 5], [5, 5], [5, 5], [5, 5]], 0.001)).toEqual([[5, 5], [5, 5]]);
  });

  it("does not mutate the input ring", () => {
    const c = cShape(30);
    const before = JSON.stringify(c);
    simplifyRing(c, 0.005);
    expect(JSON.stringify(c)).toBe(before);
  });
});

// ── 5. validateRing ──────────────────────────────────────────────────────────

describe("validateRing gates a drawn stroke before it becomes a territory", () => {
  it("accepts a real territory and returns the cleaned ring", () => {
    // Success returns the DEDUPED ring, so what gets stored is the cleaned
    // geometry rather than the raw stroke with its paused-finger repeats.
    const withRepeats: Ring = [BOX_CCW[0], BOX_CCW[0], BOX_CCW[1], BOX_CCW[2], BOX_CCW[3], BOX_CCW[0]];
    const result = validateRing(withRepeats);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ring).toEqual(BOX_CCW);
  });

  it("accepts a territory drawn clockwise just as readily as anticlockwise", () => {
    // The user-visible consequence of a signed area. Roughly half of all real
    // lasso strokes go clockwise; if the area check sees a negative number, every
    // one of those 1 km² territories is rejected as "too-small" and the manager
    // is told to draw a bigger area than the one they just drew.
    const clockwise: Ring = [...BOX_CCW].reverse() as Ring;
    expect(validateRing(clockwise).ok).toBe(true);
  });

  it("rejects fewer than three distinct points as too-few-points", () => {
    expect(validateRing([])).toEqual({ ok: false, reason: "too-few-points" });
    expect(validateRing([[0, 0]])).toEqual({ ok: false, reason: "too-few-points" });
    expect(validateRing([[0, 0], [1, 1]])).toEqual({ ok: false, reason: "too-few-points" });
    // Five points, one location — a tap. Dedupe runs first, so this is
    // too-few-points and not some downstream confusion about zero area.
    expect(validateRing([[1, 1], [1, 1], [1, 1], [1, 1], [1, 1]]))
      .toEqual({ ok: false, reason: "too-few-points" });
  });

  it("rejects a line drawn instead of an area as degenerate", () => {
    // Collinear points have three-plus vertices but no interior. Reported ahead
    // of self-intersection even though the closing edge does retrace the path,
    // because "you drew a line" is the actionable message.
    expect(validateRing([[-80.40, 35.55], [-80.39, 35.55], [-80.38, 35.55]]))
      .toEqual({ ok: false, reason: "degenerate" });
    expect(validateRing([[-80.40, 35.55], [-80.39, 35.55], [-80.38, 35.55], [-80.37, 35.55]]))
      .toEqual({ ok: false, reason: "degenerate" });
    // A back-and-forth drag: out along a line and straight back.
    expect(validateRing([[-80.40, 35.55], [-80.38, 35.55], [-80.39, 35.55]]))
      .toEqual({ ok: false, reason: "degenerate" });
  });

  it("rejects a self-intersecting stroke", () => {
    // Territory-sized bowtie: comfortably above the area floor, so the only
    // thing wrong with it is the crossing.
    const bowtie: Ring = [
      [-80.40, 35.55],
      [-80.39, 35.56],
      [-80.39, 35.55],
      [-80.40, 35.56],
    ];
    expect(validateRing(bowtie)).toEqual({ ok: false, reason: "self-intersecting" });
  });

  it("rejects a stroke too small to be an area", () => {
    // ~1.1 m on a side: a tap with a twitch in it. A real shape, just not one
    // anybody meant to draw.
    const tiny: Ring = [
      [-80.40, 35.55],
      [-80.39999, 35.55],
      [-80.39999, 35.55001],
      [-80.40, 35.55001],
    ];
    expect(ringAreaSqMeters(tiny)).toBeLessThan(MIN_RING_AREA_SQ_METERS);
    expect(validateRing(tiny)).toEqual({ ok: false, reason: "too-small" });
  });

  it("exposes the area floor as a constant callers can raise", () => {
    expect(MIN_RING_AREA_SQ_METERS).toBeGreaterThan(0);
    // BOX_CCW is ~1e6 m²; a floor above that must reject it.
    expect(validateRing(BOX_CCW, { minAreaSqMeters: 5_000_000 }))
      .toEqual({ ok: false, reason: "too-small" });
    expect(validateRing(BOX_CCW, { minAreaSqMeters: 1 }).ok).toBe(true);
  });

  it("honours a caller-supplied epsilon when de-duplicating", () => {
    // With a coarse epsilon the box's corners merge into a single point, which
    // makes it too-few-points rather than a valid territory.
    expect(validateRing(BOX_CCW, { epsilon: 0.1 }))
      .toEqual({ ok: false, reason: "too-few-points" });
  });

  it("accepts a concave territory", () => {
    // Concavity is normal — an area drawn around a block is rarely convex — and
    // must not be confused with invalidity.
    expect(validateRing(cShape(40)).ok).toBe(true);
  });
});

// ── 6. crossesAntimeridian ───────────────────────────────────────────────────

describe("crossesAntimeridian flags rings the planar maths cannot handle", () => {
  it("returns false for an ordinary domestic territory", () => {
    expect(crossesAntimeridian(BOX_CCW)).toBe(false);
    expect(crossesAntimeridian(cShape(20))).toBe(false);
  });

  it("detects an edge that spans more than 180° of longitude", () => {
    // Fiji-style: -179 and +179 are 2° apart on the globe but 358° apart in the
    // numbers, and every routine in this module would compute the long way
    // round — an "area" the size of a hemisphere.
    expect(crossesAntimeridian([[179, 10], [-179, 10], [-179, 11], [179, 11]])).toBe(true);
  });

  it("detects a span that only occurs on the implicit closing edge", () => {
    // ring[2] → ring[0] is the only oversized jump. An implementation that stops
    // at the last stored point never sees it.
    expect(crossesAntimeridian([[-179, 10], [-178, 10], [179, 11]])).toBe(true);
  });

  it("does not flag a wide-but-legal ring", () => {
    // 179° of span is enormous and unambiguous. Only >180° is ambiguous.
    expect(crossesAntimeridian([[-100, 10], [79, 10], [79, 11], [-100, 11]])).toBe(false);
  });

  it("returns false for inputs with no edges", () => {
    expect(crossesAntimeridian([])).toBe(false);
    expect(crossesAntimeridian([[0, 0]])).toBe(false);
  });
});

describe("healSelfIntersections keeps the hand's intent and rejects only ambiguity", () => {
  // The failure this heals: rings are stored open, and a hand closing a loop
  // almost always overshoots the start by a few pixels — so the stroke's tail
  // GENUINELY crosses its own first segment, and validateRing alone rejected
  // nearly every careful draw with "that loop crosses over itself".
  const SQUARE: Ring = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]];

  it("a closing-seam overshoot heals to the intended loop, and the healed ring validates", () => {
    // The square, drawn by hand: the last stroke sails past the start point,
    // crossing the first edge. This is the every-draw case.
    const overshoot: Ring = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0.0005, -0.0008]];
    expect(hasSelfIntersection(overshoot)).toBe(true);

    const res = healSelfIntersections(overshoot);
    expect(res.healed).toBe(true);
    expect(res.discardedAreaRatio).toBeLessThan(0.05); // the sliver, not a lobe
    expect(hasSelfIntersection(res.ring)).toBe(false);
    // The kept loop is the square the hand meant, give or take the sliver.
    const ratio = ringAreaSqMeters(res.ring) / ringAreaSqMeters(SQUARE);
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThanOrEqual(1.000001);
    expect(validateRing(res.ring).ok).toBe(true);
  });

  it("a mid-stroke pigtail (wobble loop) heals away", () => {
    // A tiny loop-the-loop drawn along the bottom edge.
    const pigtail: Ring = [
      [0, 0], [0.005, 0], [0.006, 0.001], [0.0055, 0.0015], [0.005, 0.0008],
      [0.0065, 0], [0.01, 0], [0.01, 0.01], [0, 0.01],
    ];
    expect(hasSelfIntersection(pigtail)).toBe(true);

    const res = healSelfIntersections(pigtail);
    expect(res.healed).toBe(true);
    expect(res.discardedAreaRatio).toBeLessThan(0.05);
    expect(hasSelfIntersection(res.ring)).toBe(false);
    expect(ringAreaSqMeters(res.ring) / ringAreaSqMeters(SQUARE)).toBeGreaterThan(0.9);
  });

  it("a genuine figure-eight reports comparable lobes — the caller's cue to still reject", () => {
    // Two lobes of equal area: keeping either half would silently assign
    // ground the manager can see is outside their loop.
    const bowtie: Ring = [[0, 0], [0.01, 0.01], [0.01, 0], [0, 0.01]];
    const res = healSelfIntersections(bowtie);
    expect(res.healed).toBe(true);
    expect(res.discardedAreaRatio).toBeGreaterThan(0.9);
  });

  it("a clean ring passes through untouched", () => {
    const res = healSelfIntersections(SQUARE);
    expect(res.healed).toBe(false);
    expect(res.discardedAreaRatio).toBe(0);
    expect(res.ring).toEqual(SQUARE);
  });
});
