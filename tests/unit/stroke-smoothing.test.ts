import { describe, it, expect } from "vitest";
import {
  simplifyStroke,
  chaikinSmooth,
  resampleStroke,
  smoothLassoRing,
  type Pt,
} from "@shared/strokeSmoothing";

/**
 * CONTRACT (shared/strokeSmoothing.ts): pure planar stroke pipeline for the
 * map lasso. RDP keeps endpoints and is monotone in epsilon; Chaikin is
 * contraction-only (output stays inside the drawn bounds) with exact vertex
 * counts (open: 2^k(n-2)+2, closed: 2^k*n) and exact open-endpoint
 * preservation; resampling is uniform at the requested arc-length spacing;
 * smoothLassoRing rejects degenerate gestures with [] and always emits an
 * open-stored closed ring (no duplicated closing point).
 */

const P = (x: number, y: number): Pt => ({ x, y });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

const square: Pt[] = [P(0, 0), P(10, 0), P(10, 10), P(0, 10)];

/** Max deviation-from-straight angle (degrees) over interior vertices. */
function maxTurnDeg(pts: Pt[]): number {
  let max = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const ax = pts[i].x - pts[i - 1].x;
    const ay = pts[i].y - pts[i - 1].y;
    const bx = pts[i + 1].x - pts[i].x;
    const by = pts[i + 1].y - pts[i].y;
    const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
    const ang = Math.acos(Math.min(1, Math.max(-1, cos)));
    if (ang > max) max = ang;
  }
  return (max * 180) / Math.PI;
}

function inBBox(pts: Pt[], ref: Pt[]): boolean {
  const xs = ref.map((p) => p.x);
  const ys = ref.map((p) => p.y);
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  return pts.every(
    (p) => p.x >= minX - 1e-9 && p.x <= maxX + 1e-9 && p.y >= minY - 1e-9 && p.y <= maxY + 1e-9,
  );
}

describe("simplifyStroke - Ramer-Douglas-Peucker", () => {
  it("drops collinear interior points and keeps the exact endpoints", () => {
    const line = [P(0, 0), P(1, 0), P(2, 0), P(3, 0), P(4, 0)];
    expect(simplifyStroke(line, 0.5)).toEqual([P(0, 0), P(4, 0)]);
  });

  it("keeps corners beyond epsilon, drops sub-epsilon jitter", () => {
    const stroke = [P(0, 0), P(5, 0.4), P(10, 0), P(10, 5)];
    // (10,0) deviates ~4.47 from the (0,0)->(10,5) baseline: kept.
    // (5,0.4) deviates 0.4 from the (0,0)->(10,0) baseline: dropped.
    expect(simplifyStroke(stroke, 1)).toEqual([P(0, 0), P(10, 0), P(10, 5)]);
  });

  it("epsilon 0 returns the input dedup'd but otherwise untouched", () => {
    const withDups = [P(0, 0), P(0, 0), P(1, 1), P(1, 1), P(1, 1), P(2, 0)];
    expect(simplifyStroke(withDups, 0)).toEqual([P(0, 0), P(1, 1), P(2, 0)]);
  });

  it("never yields NaN on duplicate points or a stroke that closes on its start", () => {
    // First == last (non-consecutive) degenerates the RDP baseline to a point.
    const loop = [P(0, 0), P(0, 0), P(5, 5), P(10, 0), P(10, 0), P(0, 0)];
    const out = simplifyStroke(loop, 1);
    expect(out).toEqual([P(0, 0), P(5, 5), P(10, 0), P(0, 0)]);
    expect(out.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });

  it("is monotone in epsilon: larger tolerance never keeps more points", () => {
    const jagged: Pt[] = [];
    for (let i = 0; i <= 40; i++) {
      jagged.push(P(i, Math.sin(i * 1.7) * 4 + ((i % 3) - 1) * 0.6));
    }
    const epsilons = [0.1, 0.5, 1, 2, 4, 8, 100];
    const counts = epsilons.map((e) => simplifyStroke(jagged, e).length);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    expect(counts[0]).toBeGreaterThan(2); // small epsilon keeps real corners
    expect(counts[counts.length - 1]).toBe(2); // huge epsilon leaves only endpoints
  });
});

describe("chaikinSmooth - corner cutting", () => {
  const open5 = [P(0, 0), P(2, 3), P(5, 1), P(7, 4), P(9, 0)];

  it("open vertex count follows 2^k * (n - 2) + 2, and default is 2 iterations", () => {
    expect(chaikinSmooth(open5, 1).length).toBe(2 * (5 - 2) + 2); // 8
    expect(chaikinSmooth(open5, 2).length).toBe(4 * (5 - 2) + 2); // 14
    expect(chaikinSmooth(open5)).toEqual(chaikinSmooth(open5, 2));
  });

  it("closed vertex count follows 2^k * n with no duplicated closing point", () => {
    expect(chaikinSmooth(square, 1, true).length).toBe(8);
    const out = chaikinSmooth(square, 2, true);
    expect(out.length).toBe(16);
    expect(out[0]).not.toEqual(out[out.length - 1]);
  });

  it("strictly reduces the max corner angle on a zigzag, iteration over iteration", () => {
    const zigzag = [P(0, 0), P(1, 1), P(2, 0), P(3, 1), P(4, 0)];
    const raw = maxTurnDeg(zigzag); // 90 degrees
    const once = maxTurnDeg(chaikinSmooth(zigzag, 1));
    const twice = maxTurnDeg(chaikinSmooth(zigzag, 2));
    expect(raw).toBeCloseTo(90, 6);
    expect(once).toBeLessThan(raw);
    expect(twice).toBeLessThan(once);
  });

  it("preserves the exact first and last points of an open stroke", () => {
    const out = chaikinSmooth(open5, 3, false);
    expect(out[0]).toEqual(P(0, 0));
    expect(out[out.length - 1]).toEqual(P(9, 0));
  });

  it("closed ring: cuts at 0.25/0.75 and smooths across the seam", () => {
    const out = chaikinSmooth(square, 1, true);
    expect(out[0]).toEqual(P(2.5, 0)); // 0.25 cut of the first edge
    expect(out[1]).toEqual(P(7.5, 0)); // 0.75 cut of the first edge
    // Every raw corner — including the seam corner (0,0) — is cut away.
    for (const c of square) {
      expect(out.some((p) => p.x === c.x && p.y === c.y)).toBe(false);
    }
    expect(out[0]).not.toEqual(out[out.length - 1]);
  });
});

describe("resampleStroke - even arc-length spacing", () => {
  it("exact-multiple open stroke: uniform spacing, both endpoints kept", () => {
    const out = resampleStroke([P(0, 0), P(10, 0)], 1);
    expect(out.length).toBe(11);
    expect(out[0]).toEqual(P(0, 0));
    expect(out[out.length - 1]).toEqual(P(10, 0));
    for (let i = 1; i < out.length; i++) {
      expect(Math.abs(dist(out[i - 1], out[i]) - 1)).toBeLessThan(1e-6);
    }
  });

  it("non-multiple open stroke: uniform except a shorter final segment", () => {
    const out = resampleStroke([P(0, 0), P(10, 0)], 3);
    expect(out.length).toBe(5); // 0, 3, 6, 9, then the exact endpoint
    for (let i = 1; i < out.length - 1; i++) {
      expect(Math.abs(dist(out[i - 1], out[i]) - 3)).toBeLessThan(1e-6);
    }
    expect(dist(out[3], out[4])).toBeCloseTo(1, 6);
    expect(out[out.length - 1]).toEqual(P(10, 0));
  });

  it("closed ring wraps the implicit closing edge without repeating the start", () => {
    const out = resampleStroke(square, 5, true); // perimeter 40
    expect(out.length).toBe(8);
    expect(out[0]).toEqual(P(0, 0));
    expect(out[out.length - 1]).not.toEqual(out[0]);
    for (let i = 1; i < out.length; i++) {
      expect(Math.abs(dist(out[i - 1], out[i]) - 5)).toBeLessThan(1e-6);
    }
    expect(Math.abs(dist(out[out.length - 1], out[0]) - 5)).toBeLessThan(1e-6); // wrap gap
  });

  it("throws on spacing <= 0 or NaN", () => {
    expect(() => resampleStroke(square, 0)).toThrow();
    expect(() => resampleStroke(square, -2)).toThrow();
    expect(() => resampleStroke(square, Number.NaN)).toThrow();
  });
});

describe("smoothLassoRing - lasso completion pipeline", () => {
  it("returns [] below minPoints distinct points; duplicates do not count", () => {
    const triangle = [P(0, 0), P(10, 0), P(5, 8)];
    expect(smoothLassoRing(triangle)).toEqual([]);
    // Nine samples but only three distinct points: still rejected.
    const stuttered = triangle.flatMap((p) => [p, p, p]);
    expect(smoothLassoRing(stuttered)).toEqual([]);
    // minPoints override: a 4-corner square fails a 5-point minimum.
    expect(smoothLassoRing(square, { minPoints: 5 })).toEqual([]);
  });

  it("returns [] when the stroke simplifies to a line (no drawable area)", () => {
    const nearlyCollinear = [P(0, 0), P(1, 0.1), P(2, -0.1), P(3, 0.05), P(4, 0)];
    expect(smoothLassoRing(nearlyCollinear)).toEqual([]); // default epsilon 2 flattens it
    expect(smoothLassoRing(square, { epsilon: 100 })).toEqual([]);
  });

  it("square ring: more points than input, all inside the drawn bounding box", () => {
    const out = smoothLassoRing(square);
    expect(out.length).toBe(16); // RDP keeps all 4 corners, then 2 closed Chaikin passes
    expect(out.length).toBeGreaterThan(square.length);
    expect(inBBox(out, square)).toBe(true); // contraction-only: never escapes the stroke
    expect(out[0]).not.toEqual(out[out.length - 1]); // open-stored ring, no closing dup
    for (let i = 1; i < out.length; i++) expect(out[i]).not.toEqual(out[i - 1]);
  });

  it("dedupes repeated samples: a stuttered square smooths identically to a clean one", () => {
    const stuttered = [...square.flatMap((p) => [p, p, p]), P(0, 0)]; // + closing dup
    expect(smoothLassoRing(stuttered)).toEqual(smoothLassoRing(square));
  });

  it("jagged ring stays inside its own bounding box (convex-combination property)", () => {
    const jaggedRing: Pt[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * 2 * Math.PI;
      const r = 10 + (i % 2 === 0 ? 3 : -3) + Math.sin(i * 7) * 1.5;
      jaggedRing.push(P(Math.cos(a) * r, Math.sin(a) * r));
    }
    const out = smoothLassoRing(jaggedRing, { epsilon: 0.5, iterations: 3 });
    expect(out.length).toBeGreaterThan(4);
    expect(inBBox(out, jaggedRing)).toBe(true);
  });
});
