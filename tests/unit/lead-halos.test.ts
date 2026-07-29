// Per-rep colour halos.
//
// The bug this module exists to kill is two reps knocking the same house: areas
// are many-to-many (territories.assignee_ids), but a pin only ever painted the
// SINGLE primary assignee's colour, so a shared door was pixel-identical to a
// door one rep owned alone. These tests pin the three things that have to hold
// for the halo to be trusted in the field:
//
//   1. IDENTITY — a rep must find their own hue on a door they work, whether
//      they own it alone or share it with three other people.
//   2. DETERMINISM — the same crew must paint the same ring order on every door
//      in the area, and across renders. A colour that moves between doors is
//      noise a rep learns to ignore.
//   3. LEGIBILITY — the halo is a RING AROUND the pin. The moment a ring covers
//      the dot it is hiding the status colour, which is the thing the rep
//      actually came to the map to read.
//
// Everything here runs against the real palette and the real UNCLUSTERED_PAINT,
// never a fixture copy — a retune of the pin radius must either move the halos
// with it or fail this file, which is the drift these specs were extracted to
// stop.
import { describe, expect, it } from "vitest";
import {
  HALO_BEFORE_CANDIDATES,
  HALO_COUNT_PROP,
  HALO_LAYER_IDS,
  HALO_MAX_RINGS,
  HALO_MIN_ZOOM,
  HALO_OVERFLOW_COLOR,
  HALO_PROP,
  HALO_RING_SCALE,
  HALO_SOURCE_ID,
  haloBeforeId,
  haloColorsForLead,
  haloFeatureProps,
  haloLayerId,
  haloLayerSpecs,
  haloRingColors,
  haloRingFilter,
  haloRingPaint,
  haloSignature,
  haloSlotProp,
  pinRadiusStops,
  repIdsForDoor,
} from "../../client/src/lib/leadHalos";
import { UNCLUSTERED_PAINT } from "../../client/src/lib/mapPins";
import { REP_PALETTE, colorForRep } from "../../shared/repColors";

// ── Minimal Mapbox expression evaluators ─────────────────────────────────────
// Asserting the SHAPE of a filter proves nothing about what it lets through, and
// the one behaviour that matters most here is negative: an unassigned door must
// paint no ring at all. So the filter is executed against feature props rather
// than shape-matched. Unknown ops throw on purpose — if the filter grows an
// operator this evaluator does not model, that is a test that stopped testing.
function evalFilter(expr: unknown, props: Record<string, unknown>): any {
  if (!Array.isArray(expr)) return expr;
  const [op, ...args] = expr as any[];
  switch (op) {
    case "all":
      return args.every((a) => !!evalFilter(a, props));
    case "!":
      return !evalFilter(args[0], props);
    case "has":
      return Object.prototype.hasOwnProperty.call(props, evalFilter(args[0], props));
    case "get":
      return props[evalFilter(args[0], props) as string];
    case "coalesce":
      // Mapbox's ["get"] on a missing prop yields null; JS yields undefined.
      // Both must fall through, or a pre-halo cached feature errors the tile.
      for (const a of args) {
        const v = evalFilter(a, props);
        if (v !== undefined && v !== null) return v;
      }
      return null;
    case ">":
      return evalFilter(args[0], props) > evalFilter(args[1], props);
    case "==":
      return evalFilter(args[0], props) === evalFilter(args[1], props);
    default:
      throw new Error(`evalFilter: unsupported operator ${String(op)}`);
  }
}

/** ["interpolate", ["linear"], ["zoom"], z0, v0, ...] at a zoom, clamping at the
 *  ends exactly as Mapbox does — the clamp is why z11 and z21 are checkable. */
function evalZoomInterpolate(expr: unknown, zoom: number): number {
  const e = expr as any[];
  const stops: Array<[number, number]> = [];
  for (let i = 3; i + 1 < e.length; i += 2) stops.push([e[i], e[i + 1]]);
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (zoom <= first[0]) return first[1];
  if (zoom >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i++) {
    const [z0, v0] = stops[i - 1];
    const [z1, v1] = stops[i];
    if (zoom <= z1) return v0 + ((v1 - v0) * (zoom - z0)) / (z1 - z0);
  }
  return last[1];
}

/** Two reps can collide on a hue (allocation is repId % REP_PALETTE.length),
 *  which would make a "distinct colours" assertion pass for the wrong reason.
 *  Every fixture below is checked against this so a palette resize fails loudly
 *  instead of quietly weakening the test. */
function assertDistinctHues(...repIds: number[]): void {
  const hues = new Set(repIds.map((id) => colorForRep(id)));
  expect(hues.size, `fixture reps ${repIds.join(",")} collide on a hue`).toBe(repIds.length);
}

describe("the rep set on a door", () => {
  it("puts the owner first and the rest in a stable ascending order", () => {
    // The innermost ring is the one hugging the pin — the one a rep reads first
    // — so it is always the area's primary, never whichever id sorted lowest.
    expect(repIdsForDoor(9, [3, 7])).toEqual([9, 3, 7]);
  });

  it("reads assignee_ids as the raw JSON text the column travels in", () => {
    expect(repIdsForDoor(4, "[7,3]")).toEqual([4, 3, 7]);
  });

  it("degrades a legacy or NULL assignee list to owner-only instead of throwing", () => {
    // Mid-render is the worst possible place to discover a malformed column.
    expect(repIdsForDoor(4, null)).toEqual([4]);
    expect(repIdsForDoor(4, "")).toEqual([4]);
    expect(repIdsForDoor(4, "not json")).toEqual([4]);
    expect(repIdsForDoor(4, '{"nope":1}')).toEqual([4]);
  });

  it("collapses an owner who is also listed as an assignee", () => {
    // Common in real rows — the owner gets added to their own area's assignees.
    // Without the collapse the door claims two reps and paints two rings.
    expect(repIdsForDoor(4, [4, 7, 7])).toEqual([4, 7]);
  });

  it("treats a stringified id as the same rep as its number", () => {
    // The wire ships numeric ids as strings in places; "3" and 3 must not land
    // on different palette slots and paint the same person twice.
    expect(repIdsForDoor("4" as any, ["7", 3])).toEqual([4, 3, 7]);
  });

  it("drops the ids that mean unassigned", () => {
    // 0 and null are both "nobody" in this schema.
    expect(repIdsForDoor(0, [null, undefined, 0, 5])).toEqual([5]);
    expect(repIdsForDoor(null, [])).toEqual([]);
  });
});

describe("a door worked by one rep", () => {
  it("gets exactly that rep's colour and one ring", () => {
    const props = haloFeatureProps(repIdsForDoor(5, []));
    expect(props.haloCount).toBe(1);
    expect(props.halo0).toBe(colorForRep(5));
    // A lone rep must not pick up phantom rings — slots 1 and 2 stay absent so
    // their layer filters exclude the feature entirely.
    expect(props.halo1).toBeUndefined();
    expect(props.halo2).toBeUndefined();
  });

  it("paints only the innermost ring layer", () => {
    const props = { ...haloFeatureProps(repIdsForDoor(5, [])) } as Record<string, unknown>;
    expect(evalFilter(haloRingFilter(0), props)).toBe(true);
    expect(evalFilter(haloRingFilter(1), props)).toBe(false);
    expect(evalFilter(haloRingFilter(2), props)).toBe(false);
  });
});

describe("a shared door", () => {
  it("surfaces every assigned rep's colour, not just the owner's", () => {
    // The whole point of the feature: this door and a door owned solely by rep 4
    // must not render identically.
    assertDistinctHues(4, 3, 7);
    const shared = haloFeatureProps(repIdsForDoor(4, [7, 3]));
    const alone = haloFeatureProps(repIdsForDoor(4, []));

    expect(shared.haloCount).toBe(3);
    expect([shared.halo0, shared.halo1, shared.halo2]).toEqual([
      colorForRep(4), // owner innermost
      colorForRep(3),
      colorForRep(7),
    ]);
    expect(shared).not.toEqual(alone);
  });

  it("gives each rep a visually distinct ring", () => {
    assertDistinctHues(1, 2, 3);
    const rings = haloColorsForLead(repIdsForDoor(1, [2, 3]));
    expect(new Set(rings).size).toBe(rings.length);
  });

  it("paints the same ring order for the same crew no matter how the ids arrive", () => {
    // assignee_ids has no ordering guarantee — the DB, the API and an admin
    // re-save can all hand back a different permutation of the same crew. Any of
    // them changing the ring order would make the map flicker its meaning.
    const permutations = [
      [7, 3, 9],
      [9, 7, 3],
      [3, 9, 7],
      [9, 3, 7],
    ];
    const rendered = permutations.map((ids) => JSON.stringify(haloFeatureProps(repIdsForDoor(4, ids))));
    expect(new Set(rendered).size).toBe(1);
  });

  it("renders identically on a repeat call — no hidden per-call state", () => {
    // reconcileLeadFeatures calls this once per door per snapshot and compares
    // the result to a cached signature; a non-deterministic output would rebuild
    // every feature on every refetch.
    const ids = repIdsForDoor(4, [7, 3]);
    expect(haloFeatureProps(ids)).toEqual(haloFeatureProps(ids));
    expect(haloSignature(ids)).toBe(haloSignature(ids));
  });

  it("counts distinct COLOURS, so a hue collision does not fake a second rep", () => {
    // Allocation is repId % REP_PALETTE.length, so a rep one full palette away
    // genuinely shares a hue. Two identical concentric rings would read as one
    // fat ring — a lie about how many people are on the door — so the duplicate
    // collapses. Derived from the palette length rather than hard-coded: the
    // point is the behaviour at the wrap boundary, wherever that boundary sits.
    const twin = 1 + REP_PALETTE.length;
    expect(colorForRep(twin)).toBe(colorForRep(1));
    const props = haloFeatureProps(repIdsForDoor(1, [twin]));
    expect(props.haloCount).toBe(1);
    expect(props.halo1).toBeUndefined();
  });

  // ── The collision boundary itself ──────────────────────────────────────────
  // Collapsing a duplicate is the honest answer to two reps who truly share a
  // hue, but it costs the second rep their ring — on a shared door they see no
  // color of their own, and the door reads as one rep's. That is tolerable at
  // the edge of the palette and NOT tolerable at a dozen reps, which is an
  // ordinary sales team. These pin how far the boundary now sits.
  it("gives every rep in a 24-person org a hue of their own", () => {
    // Fails against the old 12-hue palette: rep 13 collided with rep 1.
    const hues = new Set(Array.from({ length: 24 }, (_, i) => colorForRep(i + 1)));
    expect(hues.size).toBe(24);
  });

  it("keeps reps 12-23 off their old twins, and leaves reps 1-11 exactly where they were", () => {
    // The second twelve are append-only precisely so the first twelve never move
    // — a working rep's territory must not repaint because the palette grew.
    expect(REP_PALETTE.slice(0, 12)).toEqual([
      "#2563EB", "#F97316", "#16A34A", "#DB2777", "#06B6D4", "#EAB308",
      "#8B5CF6", "#EF4444", "#14B8A6", "#EC4899", "#84CC16", "#A855F7",
    ]);
    for (let id = 12; id <= 23; id++) expect(colorForRep(id)).not.toBe(colorForRep(id - 12));
  });

  it("paints TWO rings on a door shared by reps a dozen apart", () => {
    // The bug this whole boundary exists to kill: reps 3 and 15 shared #DB2777,
    // so a door they worked together collapsed to one ring and was pixel-
    // identical to a door only rep 3 works. Fails against the 12-hue palette.
    expect(colorForRep(15)).not.toBe(colorForRep(3));
    const shared = haloFeatureProps(repIdsForDoor(3, [15]));
    const solo = haloFeatureProps(repIdsForDoor(3, []));
    expect(shared.haloCount).toBe(2);
    expect(solo.haloCount).toBe(1);
    expect(shared.halo1).toBeDefined();       // rep 15 has a ring of their own
    expect(shared.halo0).not.toBe(shared.halo1);
  });

  it("never hands a real rep the unassigned slate", () => {
    // #94a3b8 is the "nobody" sentinel. A rep allocated that exact hue would
    // render as an unowned door — worse than a collision, because it is wrong
    // rather than merely ambiguous.
    const slate = colorForRep(null);
    for (let id = 1; id <= REP_PALETTE.length * 2; id++) {
      expect(colorForRep(id)).not.toBe(slate);
    }
  });
});

describe(`beyond ${HALO_MAX_RINGS} reps`, () => {
  it("paints every rep while the crew still fits the ring budget", () => {
    assertDistinctHues(1, 2, 3);
    expect(haloRingColors([colorForRep(1), colorForRep(2), colorForRep(3)])).toEqual([
      colorForRep(1),
      colorForRep(2),
      colorForRep(3),
    ]);
  });

  it("keeps the first reps identifiable and turns the outermost ring to slate", () => {
    // A fourth ring would grow the layer count; dropping the fourth rep silently
    // would claim the door is less shared than it is. Slate says "and others".
    assertDistinctHues(1, 2, 3, 5);
    const props = haloFeatureProps(repIdsForDoor(1, [2, 3, 5]));
    expect(props.haloCount).toBe(4); // uncapped — the count is the truth
    expect(props.halo0).toBe(colorForRep(1));
    expect(props.halo1).toBe(colorForRep(2));
    expect(props.halo2).toBe(HALO_OVERFLOW_COLOR);
  });

  it("costs a 6-rep door exactly what a 3-rep door costs", () => {
    assertDistinctHues(1, 2, 3, 5, 6, 7);
    const six = haloFeatureProps(repIdsForDoor(1, [2, 3, 5, 6, 7]));
    expect(Object.keys(six).sort()).toEqual([HALO_COUNT_PROP, "halo0", "halo1", "halo2"].sort());
    expect(haloLayerSpecs()).toHaveLength(HALO_MAX_RINGS);
  });

  it("leaves haloCount as the only thing separating a 4-rep door from a 5-rep one", () => {
    // Past the cap the colour lists are IDENTICAL, so leadFeatureSignature would
    // reuse a stale feature on reassignment if the count were not in the props.
    assertDistinctHues(1, 2, 3, 5, 6);
    const four = haloFeatureProps(repIdsForDoor(1, [2, 3, 5]));
    const five = haloFeatureProps(repIdsForDoor(1, [2, 3, 5, 6]));
    expect([four.halo0, four.halo1, four.halo2]).toEqual([five.halo0, five.halo1, five.halo2]);
    expect(four.haloCount).not.toBe(five.haloCount);
    expect(haloSignature(repIdsForDoor(1, [2, 3, 5]))).toBe(haloSignature(repIdsForDoor(1, [2, 3, 5, 6])));
  });

  it("still paints all three ring layers on an over-cap door", () => {
    const props = { ...haloFeatureProps(repIdsForDoor(1, [2, 3, 5, 6])) } as Record<string, unknown>;
    for (let slot = 0; slot < HALO_MAX_RINGS; slot++) {
      expect(evalFilter(haloRingFilter(slot), props), `slot ${slot}`).toBe(true);
    }
  });
});

describe("an unassigned door", () => {
  it("carries no halo props at all", () => {
    // On a fresh import this is most of the map — 5k features must not each pay
    // for three empty strings over the wire and into the tile buckets.
    expect(haloFeatureProps(null)).toEqual({ haloCount: 0 });
    expect(haloFeatureProps([])).toEqual({ haloCount: 0 });
    expect(haloFeatureProps(repIdsForDoor(null, "[]"))).toEqual({ haloCount: 0 });
    expect(haloFeatureProps(repIdsForDoor(0, [0, null]))).toEqual({ haloCount: 0 });
  });

  it("is excluded by every ring layer's filter", () => {
    const props = { ...haloFeatureProps(null) } as Record<string, unknown>;
    for (let slot = 0; slot < HALO_MAX_RINGS; slot++) {
      expect(evalFilter(haloRingFilter(slot), props), `slot ${slot} painted an unassigned door`).toBe(false);
    }
  });

  it("cannot be confused with the over-cap slate ring", () => {
    // Slate doubles as colorForRep(unassigned), which is only safe BECAUSE an
    // unassigned door paints nothing — if it ever started painting slot 0, slate
    // would mean two different things on the same map.
    expect(HALO_OVERFLOW_COLOR).toBe(colorForRep(null));
    expect(haloFeatureProps(null).halo0).toBeUndefined();
  });

  it("contributes an empty signature, so halos never churn the feature cache", () => {
    expect(haloSignature(null)).toBe("");
  });

  it("excludes clusters and any feature cached before halos existed", () => {
    // A cluster carries point_count and no halo props; a stale cached feature
    // carries neither. Both must miss the filter rather than error the tile.
    expect(evalFilter(haloRingFilter(0), { point_count: 12, haloCount: 3, halo0: "#fff" })).toBe(false);
    expect(evalFilter(haloRingFilter(0), { id: 1, status: "prospect" })).toBe(false);
  });
});

describe("the halo paint expression", () => {
  const slots = Array.from({ length: HALO_MAX_RINGS }, (_, i) => i);

  it("draws a ring, never a disc — the pin's status colour stays visible", () => {
    for (const slot of slots) {
      const paint = haloRingPaint(slot);
      // Fully transparent fill. A tinted fill under a pin shifts its status hue.
      expect(paint["circle-color"]).toBe("rgba(0,0,0,0)");
      expect(paint["circle-stroke-opacity"]).toBeGreaterThan(0);
      expect(paint["circle-stroke-opacity"]).toBeLessThanOrEqual(1);
    }
  });

  it("reads each slot's colour from that slot's own documented feature property", () => {
    // A hand-copied halo0 in slot 2 is precisely the drift bug this module was
    // extracted to stop, and it would be invisible on screen until two reps
    // shared a door.
    for (const slot of slots) {
      const stroke = haloRingPaint(slot)["circle-stroke-color"] as any[];
      expect(stroke[0]).toBe("coalesce");
      expect(stroke[1]).toEqual(["get", `${HALO_PROP}${slot}`]);
      expect(stroke[1][1]).toBe(haloSlotProp(slot));
      // Missing prop must degrade to a neutral ring, not an undefined colour.
      expect(stroke[2]).toBe(HALO_OVERFLOW_COLOR);
    }
  });

  it("gates each slot on the documented count property", () => {
    for (const slot of slots) {
      expect(JSON.stringify(haloRingFilter(slot))).toContain(`"${HALO_COUNT_PROP}"`);
    }
  });

  it("emits zoom expressions Mapbox will accept", () => {
    for (const slot of slots) {
      const paint = haloRingPaint(slot);
      for (const key of ["circle-radius", "circle-stroke-width"]) {
        const expr = paint[key] as any[];
        expect(expr[0], `${key} slot ${slot}`).toBe("interpolate");
        expect(expr[1]).toEqual(["linear"]);
        // A "zoom" expression is legal only at the TOP LEVEL of a paint
        // property — nesting it inside a case is the mistake this asserts away.
        expect(expr[2]).toEqual(["zoom"]);
        const args = expr.slice(3);
        expect(args.length % 2, `${key} has a dangling stop`).toBe(0);
        expect(args.length).toBeGreaterThanOrEqual(4);
        let previousZoom = -Infinity;
        for (let i = 0; i < args.length; i += 2) {
          expect(Number.isFinite(args[i])).toBe(true);
          expect(Number.isFinite(args[i + 1])).toBe(true);
          expect(args[i], `${key} stops must ascend`).toBeGreaterThan(previousZoom);
          previousZoom = args[i];
        }
      }
    }
  });

  it("builds one layer per slot, all on the lead source, all under the pins", () => {
    const specs = haloLayerSpecs();
    expect(specs.map((s) => s.id)).toEqual(HALO_LAYER_IDS);
    expect(new Set(specs.map((s) => s.id)).size).toBe(specs.length);
    specs.forEach((spec, slot) => {
      expect(spec.id).toBe(haloLayerId(slot));
      expect(spec.type).toBe("circle");
      expect(spec.source).toBe(HALO_SOURCE_ID);
      expect(spec.minzoom).toBe(HALO_MIN_ZOOM);
      expect(spec.filter).toEqual(haloRingFilter(slot));
      expect(spec.paint).toEqual(haloRingPaint(slot));
    });
  });

  it("goes under the fresh ring when it exists, under the pins otherwise", () => {
    const [freshHalo, unclustered] = HALO_BEFORE_CANDIDATES;
    expect(haloBeforeId((id) => id === freshHalo || id === unclustered)).toBe(freshHalo);
    expect(haloBeforeId((id) => id === unclustered)).toBe(unclustered);
    // Neither exists yet → nothing to be under, rather than a throw from addLayer.
    expect(haloBeforeId(() => false)).toBeUndefined();
    // style.load re-adds run while the layer stack is half-rebuilt.
    expect(
      haloBeforeId(() => {
        throw new Error("map mid-teardown");
      }),
    ).toBeUndefined();
  });
});

describe("a halo reads as a ring around the door, never over it", () => {
  // Zooms a rep actually works at, plus both clamp ends of the interpolation.
  const ZOOMS = [11, 12, 13.5, 15, 16.2, 17, 18.5, 20, 21];
  const pinRadius = UNCLUSTERED_PAINT["circle-radius"];
  // Read from source, not hardcoded: the visited state carries the FATTER white
  // stroke, so it is the case the innermost ring has to clear.
  const widestPinStroke = Math.max(
    ...(UNCLUSTERED_PAINT["circle-stroke-width"] as any[]).filter((v): v is number => typeof v === "number"),
  );

  /** Outer edge of a stroked circle — Mapbox centres the stroke on the radius. */
  const outerEdge = (radius: number, stroke: number) => radius + stroke / 2;
  const innerEdge = (radius: number, stroke: number) => radius - stroke / 2;

  it("keeps every ring strictly outside the pin at every zoom", () => {
    for (const zoom of ZOOMS) {
      const pin = outerEdge(evalZoomInterpolate(pinRadius, zoom), widestPinStroke);
      for (let slot = 0; slot < HALO_MAX_RINGS; slot++) {
        const paint = haloRingPaint(slot);
        const ring = evalZoomInterpolate(paint["circle-radius"], zoom);
        const stroke = evalZoomInterpolate(paint["circle-stroke-width"], zoom);
        expect(ring, `slot ${slot} radius at z${zoom}`).toBeGreaterThan(
          evalZoomInterpolate(pinRadius, zoom),
        );
        // The strict version: the ring's INNER edge clears the pin's outer edge,
        // so no part of the stroke ever lands on the dot.
        expect(innerEdge(ring, stroke), `slot ${slot} stroke overlaps the pin at z${zoom}`).toBeGreaterThan(pin);
      }
    }
  });

  it("keeps consecutive rings separated, so N reps read as N rings", () => {
    // Touching rings merge into one thick band and the door looks like it has
    // fewer reps than it does.
    for (const zoom of ZOOMS) {
      for (let slot = 1; slot < HALO_MAX_RINGS; slot++) {
        const inner = haloRingPaint(slot - 1);
        const outer = haloRingPaint(slot);
        const innerOuterEdge = outerEdge(
          evalZoomInterpolate(inner["circle-radius"], zoom),
          evalZoomInterpolate(inner["circle-stroke-width"], zoom),
        );
        const outerInnerEdge = innerEdge(
          evalZoomInterpolate(outer["circle-radius"], zoom),
          evalZoomInterpolate(outer["circle-stroke-width"], zoom),
        );
        expect(outerInnerEdge, `slots ${slot - 1}/${slot} touch at z${zoom}`).toBeGreaterThan(innerOuterEdge);
      }
    }
  });

  it("scales the rings off the live pin stops, so a pin retune moves the halos", () => {
    // The reason the radius is derived rather than typed: whoever retunes the pin
    // next must not leave a ring sitting on top of the dot.
    expect(pinRadiusStops()).toEqual([
      [12, 3.75],
      [15, 5.25],
      [17, 6.5],
      [20, 9],
    ]);
    const retuned = ["interpolate", ["linear"], ["zoom"], 12, 10, 20, 20];
    const paint = haloRingPaint(0, pinRadiusStops(retuned));
    expect(evalZoomInterpolate(paint["circle-radius"], 12)).toBeCloseTo(10 * HALO_RING_SCALE[0], 5);
    expect(evalZoomInterpolate(paint["circle-radius"], 20)).toBeCloseTo(20 * HALO_RING_SCALE[0], 5);
  });

  it("falls back rather than emitting a wrong radius for an expression it cannot read", () => {
    // A future step/case pin radius must not be half-parsed into a ring that
    // silently swallows the pin.
    const fromStep = pinRadiusStops(["step", ["zoom"], 4, 15, 6]);
    expect(pinRadiusStops("nonsense")).toEqual(fromStep);
    expect(pinRadiusStops(["interpolate", ["linear"], ["zoom"], 12, "big"])).toEqual(fromStep);

    // One shared fallback, and it has to be a usable ramp — a single stop or an
    // empty list is rejected by Mapbox outright and takes the whole layer down.
    expect(fromStep.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < fromStep.length; i++) {
      expect(fromStep[i][0]).toBeGreaterThan(fromStep[i - 1][0]);
      expect(fromStep[i][1]).toBeGreaterThan(fromStep[i - 1][1]);
    }

    // And the rings it produces still clear the live pin. The fallback is a
    // safety net, not a licence to cover the dot.
    const paint = haloRingPaint(0, fromStep);
    for (const zoom of ZOOMS) {
      expect(evalZoomInterpolate(paint["circle-radius"], zoom), `fallback ring at z${zoom}`).toBeGreaterThan(
        evalZoomInterpolate(pinRadius, zoom),
      );
    }
  });
});
