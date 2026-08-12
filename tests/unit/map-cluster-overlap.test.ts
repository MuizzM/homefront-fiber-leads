// Cluster bubbles must never be able to draw on top of each other.
//
// supercluster's `clusterRadius` is a GROUPING distance: points within it join
// one cluster. It promises nothing about how far apart the resulting centroids
// land, so if the artwork is wider than the grouping distance, wide zooms
// stack full-size bubbles a few pixels apart and the map reads as one dark
// blob with a count on it.
//
// Measured on the Lexington set (1,500 doors) at clusterRadius 50 with a 64px
// circle and an 84px glow — pairs of rendered clusters overlapping:
//   z13 0% · z12 83% (worst 37%) · z11 100% (worst 69%) · z10 100% (worst 84%)
//
// The cure is an invariant rather than a nicer number: the widest thing a
// cluster paints must fit inside the distance at which two clusters can form.
// These assertions are the guard - they read the real style objects, so a
// future tweak to any radius in the ramp has to keep the relationship.
import { describe, expect, it } from "vitest";
import {
  LEADS_CLUSTER_SOURCE_SPEC,
  clusterLayerSpecs,
  CLUSTER_MAX_RADIUS,
  CLUSTER_GLOW_PAD,
  CLUSTER_RADIUS_PX,
} from "../../client/src/lib/mapPins";

/** Largest value a ["step", input, base, stopN, valN, …] expression can yield. */
function maxOfStep(expr: any): number {
  if (typeof expr === "number") return expr;
  if (!Array.isArray(expr)) throw new Error(`not an expression: ${JSON.stringify(expr)}`);
  if (expr[0] === "step") {
    // [ "step", input, base, stop1, val1, stop2, val2, … ] — values at 2, 4, 6…
    const vals = [expr[2], ...expr.slice(3).filter((_: any, i: number) => i % 2 === 1)];
    return Math.max(...vals.map(maxOfStep));
  }
  if (expr[0] === "+") return expr.slice(1).map(maxOfStep).reduce((a, b) => a + b, 0);
  throw new Error(`unhandled expression head: ${expr[0]}`);
}

const layers = clusterLayerSpecs();
const byId = (id: string) => {
  const l = layers.find((x: any) => x.id === id);
  if (!l) throw new Error(`layer ${id} missing`);
  return l;
};

describe("cluster artwork fits inside the clustering distance", () => {
  it("the source groups at the shared constant, not a bare literal", () => {
    expect(LEADS_CLUSTER_SOURCE_SPEC.clusterRadius).toBe(CLUSTER_RADIUS_PX);
  });

  it.each([
    ["lead-clusters", 0],
    ["lead-clusters-glow", 0],
    ["lead-fresh-cluster-ring", 3], // stroke-width straddles the radius: half each side
  ])("%s never draws wider than one clustering distance", (id, strokeWidth) => {
    const layer = byId(id);
    const maxRadius = maxOfStep(layer.paint["circle-radius"]) + strokeWidth / 2;
    const drawnDiameter = maxRadius * 2;
    expect(
      drawnDiameter,
      `${id} paints ${drawnDiameter}px across but clusters can form ${CLUSTER_RADIUS_PX}px apart`,
    ).toBeLessThanOrEqual(CLUSTER_RADIUS_PX);
  });

  it("the glow hugs the circle rather than becoming a second bubble", () => {
    // The glow was the widest element on the map (84px) and merged with its
    // neighbours before the circles themselves touched.
    const glow = maxOfStep(byId("lead-clusters-glow").paint["circle-radius"]);
    const circle = maxOfStep(byId("lead-clusters").paint["circle-radius"]);
    expect(circle).toBe(CLUSTER_MAX_RADIUS);
    expect(glow - circle).toBe(CLUSTER_GLOW_PAD);
    expect(CLUSTER_GLOW_PAD).toBeLessThanOrEqual(8);
  });

  it("the fresh ring sits on the same pad, so the two rings never disagree", () => {
    const ring = maxOfStep(byId("lead-fresh-cluster-ring").paint["circle-radius"]);
    const glow = maxOfStep(byId("lead-clusters-glow").paint["circle-radius"]);
    expect(ring).toBe(glow);
  });
});

describe("the geometry that produced the blob cannot come back", () => {
  it("a 50px grouping distance with today's artwork is rejected", () => {
    // The exact pre-fix configuration, asserted as a failure so the numbers
    // that caused it stay documented in an executable form.
    const drawn = (CLUSTER_MAX_RADIUS + CLUSTER_GLOW_PAD) * 2;
    expect(drawn).toBeGreaterThan(50);
    expect(drawn).toBeLessThanOrEqual(CLUSTER_RADIUS_PX);
  });
});
