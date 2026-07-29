// Tapping an area on the map to manage it.
//
// The area panel — rename, recolour, per-rep removal, Pull Back Area — has
// always worked. Reaching it was the problem, and the tap handler had three
// separate defects:
//
//   1. It matched /^territory-\d+$/ against the layer id, which accepts the
//      FILL layer and rejects `territory-42-outline`. A tap on the boundary was
//      queried, found, and thrown away — and the boundary is what a manager
//      aims at, because the line is the thing they can see.
//   2. It took feats.find(), the first match, so overlapping areas resolved to
//      whichever happened to be drawn on top. That is how somebody pulls back
//      the wrong territory.
//   3. It ran for every role, so a rep's tap opened a panel whose every button
//      would come back 403.
import { describe, expect, it } from "vitest";
import {
  TERRITORY_LAYER_PREFIX,
  resolveTerritoryTap,
  territoriesUnderTap,
  territoryIdFromLayer,
  territoryLayerId,
  territoryTapLayers,
} from "../../client/src/lib/territoryPick";

/** Shape mapbox hands back from queryRenderedFeatures. */
const feat = (layerId: string, tid?: number) => ({
  layer: { id: layerId },
  properties: tid == null ? {} : { tid },
});

describe("reading the territory id off a feature", () => {
  it("reads the fill layer", () => {
    expect(territoryIdFromLayer("territory-42")).toBe(42);
  });

  it("reads the OUTLINE layer — the boundary tap that used to be discarded", () => {
    expect(territoryIdFromLayer("territory-42-outline")).toBe(42);
  });

  it("ignores layers that are not territories", () => {
    for (const id of ["lead-unclustered", "lead-clusters", "territory-", "territory-abc", "territoryish-3", ""]) {
      expect(territoryIdFromLayer(id)).toBeNull();
    }
  });

  it("refuses junk rather than producing NaN", () => {
    for (const id of [null, undefined, 42, {}, "territory--1", "territory-0"]) {
      expect(territoryIdFromLayer(id)).toBeNull();
    }
  });

  it("builds the id the renderer actually uses", () => {
    expect(territoryLayerId(7)).toBe(`${TERRITORY_LAYER_PREFIX}7`);
  });
});

describe("what is under the finger", () => {
  it("collapses the fill and outline of ONE area to one entry", () => {
    // Both layers match a tap near the edge. Without de-duplication a single
    // area would open the "which one?" picker against itself.
    expect(territoriesUnderTap([feat("territory-42", 42), feat("territory-42-outline", 42)])).toEqual([42]);
  });

  it("keeps distinct overlapping areas, in draw order", () => {
    expect(territoriesUnderTap([feat("territory-3", 3), feat("territory-9", 9)])).toEqual([3, 9]);
  });

  it("prefers the feature property over the layer id", () => {
    // properties.tid is what the source carries; the layer id is the fallback.
    expect(territoriesUnderTap([feat("territory-3", 88)])).toEqual([88]);
  });

  it("falls back to the layer id when the property is absent", () => {
    expect(territoriesUnderTap([feat("territory-3")])).toEqual([3]);
  });

  it("ignores lead layers sharing the hit test", () => {
    expect(territoriesUnderTap([feat("lead-unclustered"), feat("territory-5", 5)])).toEqual([5]);
  });

  it("returns nothing for an empty or missing result", () => {
    expect(territoriesUnderTap([])).toEqual([]);
    expect(territoriesUnderTap(null)).toEqual([]);
    expect(territoriesUnderTap(undefined)).toEqual([]);
  });
});

describe("what a tap means", () => {
  it("selects the one area under the finger", () => {
    expect(resolveTerritoryTap([feat("territory-42", 42)])).toEqual({ kind: "select", territoryId: 42 });
  });

  it("selects from a BOUNDARY tap — the case that did nothing before", () => {
    expect(resolveTerritoryTap([feat("territory-42-outline", 42)])).toEqual({ kind: "select", territoryId: 42 });
  });

  it("offers a choice when areas overlap instead of guessing", () => {
    expect(resolveTerritoryTap([feat("territory-3", 3), feat("territory-9", 9)])).toEqual({
      kind: "choose", territoryIds: [3, 9],
    });
  });

  it("resolves to nothing on empty map, which closes the panel", () => {
    expect(resolveTerritoryTap([])).toEqual({ kind: "none" });
  });

  it("does not open a panel for someone who cannot manage the area", () => {
    // Server authorization is the real gate; this stops a rep's tap from opening
    // a panel whose every button would 403.
    expect(resolveTerritoryTap([feat("territory-42", 42)], () => false)).toEqual({ kind: "none" });
  });

  it("filters BEFORE counting, so an unmanageable neighbour cannot force a picker", () => {
    // A manager taps their own area where it overlaps another team's. They
    // should go straight in, not be asked to choose between one area they can
    // act on and one they cannot.
    const outcome = resolveTerritoryTap(
      [feat("territory-3", 3), feat("territory-9", 9)],
      (id) => id === 3,
    );
    expect(outcome).toEqual({ kind: "select", territoryId: 3 });
  });

  it("treats every area as manageable when no gate is supplied", () => {
    expect(resolveTerritoryTap([feat("territory-1", 1)])).toEqual({ kind: "select", territoryId: 1 });
  });
});

describe("choosing which layers to hit-test", () => {
  it("asks for both the fill and the outline of each area", () => {
    expect(territoryTapLayers([7], () => true)).toEqual(["territory-7", "territory-7-outline"]);
  });

  it("skips layers that are not on the map — querying a missing layer throws", () => {
    const present = new Set(["territory-7"]);
    expect(territoryTapLayers([7, 8], (id) => present.has(id))).toEqual(["territory-7"]);
  });

  it("survives a map mid-teardown", () => {
    expect(territoryTapLayers([7], () => { throw new Error("style gone"); })).toEqual([]);
  });
});
