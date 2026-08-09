// Doors ON the line belong to the area.
//
// pointInPolygon is a strict ray-cast — ST_Contains semantics. A door lying
// exactly on the drawn edge falls inside or outside depending on which way a
// floating-point comparison rounds, and a ray that passes through a vertex can
// flip parity twice and report OUTSIDE for a point visibly on the boundary.
//
// This is not theoretical. Managers cut boundaries down the middle of a street,
// so the houses whose coordinates sit exactly on the edge are precisely the ones
// a rep can see from where they are standing — and they were the ones being
// silently dropped from the assignment.
//
// polygonCovers is the ST_Covers equivalent: inside OR on the boundary.
import { describe, expect, it } from "vitest";
import { BOUNDARY_EPSILON_DEG, pointInPolygon, pointOnPolygonBoundary, polygonCovers } from "@shared/geo";

// A plain box, [lng, lat] like every stored polygon.
const BOX: [number, number][] = [
  [-80.40, 35.55],
  [-80.30, 35.55],
  [-80.30, 35.65],
  [-80.40, 35.65],
];

describe("polygonCovers keeps everything pointInPolygon already found", () => {
  it("still covers a point clearly inside", () => {
    expect(polygonCovers(35.60, -80.35, BOX)).toBe(true);
  });

  it("still excludes a point clearly outside", () => {
    expect(polygonCovers(35.60, -79.90, BOX)).toBe(false);
    expect(polygonCovers(35.90, -80.35, BOX)).toBe(false);
  });

  it("never disagrees with the interior test on interior points", () => {
    // Covers is a SUPERSET. If it ever excluded something pointInPolygon
    // accepted, membership would shrink on upgrade.
    for (let lat = 35.56; lat < 35.65; lat += 0.01) {
      for (let lng = -80.39; lng < -80.30; lng += 0.01) {
        if (pointInPolygon(lat, lng, BOX)) expect(polygonCovers(lat, lng, BOX)).toBe(true);
      }
    }
  });
});

describe("the boundary itself", () => {
  it("covers a door on the south edge - the street the line was drawn down", () => {
    expect(polygonCovers(35.55, -80.35, BOX)).toBe(true);
  });

  it("covers a door on each of the four edges", () => {
    expect(polygonCovers(35.55, -80.35, BOX)).toBe(true);   // south
    expect(polygonCovers(35.65, -80.35, BOX)).toBe(true);   // north
    expect(polygonCovers(35.60, -80.40, BOX)).toBe(true);   // west
    expect(polygonCovers(35.60, -80.30, BOX)).toBe(true);   // east
  });

  it("covers every corner, where a ray can flip parity twice", () => {
    for (const [lng, lat] of BOX) expect(polygonCovers(lat, lng, BOX)).toBe(true);
  });

  it("is the behaviour the strict ray-cast did NOT give - that is the bug", () => {
    // At least one of these edges/corners is rejected by the interior-only test.
    // Stated as a difference rather than pinning which one, because WHICH side a
    // ray-cast drops is a floating-point detail, not a contract.
    const onEdge: Array<[number, number]> = [
      [35.55, -80.35], [35.65, -80.35], [35.60, -80.40], [35.60, -80.30],
      ...BOX.map(([lng, lat]) => [lat, lng] as [number, number]),
    ];
    expect(onEdge.every(([lat, lng]) => polygonCovers(lat, lng, BOX))).toBe(true);
    expect(onEdge.some(([lat, lng]) => !pointInPolygon(lat, lng, BOX))).toBe(true);
  });

  it("does not swallow a door on the far side of the street", () => {
    // The epsilon absorbs float noise, not real distance. ~1e-4° is about 11 m.
    expect(polygonCovers(35.5499, -80.35, BOX)).toBe(false);
    expect(pointOnPolygonBoundary(35.5499, -80.35, BOX)).toBe(false);
  });

  it("keeps the tolerance genuinely tiny", () => {
    // 1e-9° ≈ 0.1 mm. If this ever grows to something like 1e-4 it would start
    // claiming houses across the road.
    expect(BOUNDARY_EPSILON_DEG).toBeLessThanOrEqual(1e-6);
    expect(BOUNDARY_EPSILON_DEG).toBeGreaterThan(0);
  });
});

describe("shapes a freehand stroke actually produces", () => {
  const L_SHAPE: [number, number][] = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];

  it("covers the boundary of a concave polygon, including the inner corner", () => {
    expect(polygonCovers(1, 1, L_SHAPE)).toBe(true);     // reflex vertex
    expect(polygonCovers(0.5, 1, L_SHAPE)).toBe(true);   // on the inner edge
    expect(polygonCovers(2, 2, L_SHAPE)).toBe(false);    // the notch is outside
  });

  it("survives a duplicated vertex, which a finger-drawn stroke produces", () => {
    // A stationary finger emits the same coordinate twice; a zero-length segment
    // must not divide by zero and take the whole membership query down.
    const dup: [number, number][] = [[0, 0], [2, 0], [2, 0], [2, 2], [0, 2]];
    expect(() => polygonCovers(1, 1, dup)).not.toThrow();
    expect(polygonCovers(1, 1, dup)).toBe(true);
    expect(polygonCovers(0, 1, dup)).toBe(true);          // on the duplicated edge
  });

  it("refuses a degenerate ring rather than guessing", () => {
    expect(polygonCovers(1, 1, [])).toBe(false);
    expect(polygonCovers(1, 1, [[0, 0]])).toBe(false);
    expect(polygonCovers(1, 1, [[0, 0], [1, 1]])).toBe(false);
  });

  it("treats an explicitly closed ring the same as an open one", () => {
    // Stored polygons are sometimes closed (first point repeated last) and
    // sometimes not. Membership must not depend on which.
    const closed: [number, number][] = [...BOX, BOX[0]];
    for (const [lat, lng] of [[35.60, -80.35], [35.55, -80.35], [35.65, -80.40]] as const) {
      expect(polygonCovers(lat, lng, closed)).toBe(polygonCovers(lat, lng, BOX));
    }
  });
});
