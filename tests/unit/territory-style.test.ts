// How an area is painted — the module that carried "the polygon doesn't show up
// on the rep's phone".
//
// The polygon was never missing. It was fetched, added to the map, and filled at
// 0.05 opacity behind a 1.75px hairline because the viewer could not ASSIGN
// territories — which is every rep. These specs pin the two things that made it
// invisible and the one that made it the wrong colour:
//
//   1. VIEWER-INDEPENDENCE — role is not an input. Two people looking at the
//      same ground see the same ground.
//   2. VISIBILITY — an assigned area is filled inside the band that actually
//      reads over satellite imagery, with a crisp border.
//   3. THE ADMIN'S COLOUR — the colour chosen while drawing wins over the rep's
//      palette hue, because the colour describes the ground, not the person.
//
// Plus stacking: areas sit UNDER the pins. A translucent sheet over the doors is
// how you make a map you cannot work.
import { describe, expect, it } from "vitest";
import {
  TERRITORY_BEFORE_CANDIDATES,
  TERRITORY_FILL_OPACITY,
  TERRITORY_LINE_OPACITY,
  TERRITORY_LINE_WIDTH,
  TERRITORY_POOL_COLOR,
  darkenHex,
  territoryBeforeId,
  territoryColor,
  territoryPaint,
  territoryVisualStatus,
  pickUnusedTerritoryColor,
} from "../../client/src/lib/territoryStyle";

const GREEN = "#14C985";        // the colour from the spec's example feature
const REP_FALLBACK = "#2563EB"; // what colorForRep would have returned

describe("an assigned area is actually visible", () => {
  it("fills inside the band that reads over satellite, not the old 0.05", () => {
    const paint = territoryPaint({ color: GREEN, status: "active" }, REP_FALLBACK);
    expect(paint.fillOpacity).toBeGreaterThanOrEqual(0.18);
    expect(paint.fillOpacity).toBeLessThanOrEqual(0.3);
  });

  it("draws a border a rep can navigate by", () => {
    const paint = territoryPaint({ color: GREEN, status: "active" }, REP_FALLBACK);
    expect(paint.lineWidth).toBeGreaterThanOrEqual(2);
    expect(paint.lineWidth).toBeLessThanOrEqual(3);
    expect(paint.lineOpacity).toBeGreaterThanOrEqual(0.9);
    expect(paint.lineOpacity).toBeLessThanOrEqual(1);
  });

  it("is more than four times the fill the old code gave a rep", () => {
    // The regression this file exists to prevent, stated as a number rather than
    // a range so a future "tidy-up" back toward 0.05 fails loudly.
    expect(TERRITORY_FILL_OPACITY.active / 0.05).toBeGreaterThan(4);
  });
});

describe("the viewer's role is not an input", () => {
  it("takes no viewer argument at all", () => {
    // The bug was a `canAssign` branch. The strongest guard against it coming
    // back is that there is nowhere to put it: the function's whole signature is
    // (territory, fallbackColor).
    expect(territoryPaint.length).toBe(2);
  });

  it("paints identically for every caller, given the same area", () => {
    const area = { color: GREEN, status: "active" };
    expect(territoryPaint(area, REP_FALLBACK)).toEqual(territoryPaint(area, REP_FALLBACK));
  });
});

describe("the colour the admin picked", () => {
  it("wins over the rep's palette hue", () => {
    // Requirement: never replace the territory colour with the rep's profile
    // colour. The old renderer did exactly that.
    expect(territoryColor({ color: GREEN, status: "active" }, REP_FALLBACK)).toBe(GREEN);
    expect(territoryPaint({ color: GREEN, status: "active" }, REP_FALLBACK).fillColor).toBe(GREEN);
  });

  it("expands shorthand and preserves the exact stored string otherwise", () => {
    // Case is NOT folded: the stored value is the colour the admin chose, and
    // returning a re-cased variant would make a "has the colour changed?" check
    // upstream answer yes on a value nobody edited.
    expect(territoryColor({ color: "#0F0", status: "active" }, REP_FALLBACK)).toBe("#00FF00");
    expect(territoryColor({ color: "  #14c985  ", status: "active" }, REP_FALLBACK)).toBe("#14c985");
    expect(territoryColor({ color: GREEN, status: "active" }, REP_FALLBACK)).toBe(GREEN);
  });

  it("falls back to the rep hue only when no colour was ever stored", () => {
    // Rows written before the colour was captured must still render.
    for (const color of [null, undefined, "", "   ", "not-a-colour", "rgb(1,2,3)"]) {
      expect(territoryColor({ color, status: "active" }, REP_FALLBACK)).toBe(REP_FALLBACK);
    }
  });

  it("gives nobody's ground the slate, whatever colour it used to carry", () => {
    // A reclaimed area keeps its stored colour in the DB; showing it still green
    // would say it belongs to someone.
    for (const status of ["unassigned", "reclaimed"]) {
      expect(territoryColor({ color: GREEN, status }, REP_FALLBACK)).toBe(TERRITORY_POOL_COLOR);
    }
  });
});

describe("the border is a darker version of the fill", () => {
  it("keeps the hue and only drops luminance", () => {
    // A green area must not get a grey edge — the border is how you read WHICH
    // area you are standing in when two abut.
    const border = darkenHex(GREEN);
    expect(border).not.toBe(GREEN);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(border.slice(i, i + 2), 16));
    expect(g).toBeGreaterThan(r); // still green-dominant
    expect(g).toBeGreaterThan(b);
  });

  it("darkens every channel", () => {
    expect(darkenHex("#ffffff", 0.5)).toBe("#808080");
    expect(darkenHex("#000000")).toBe("#000000"); // already floor, stays valid
  });

  it("returns something paintable even for input it cannot read", () => {
    // A slightly wrong border beats mapbox throwing on an undefined paint value
    // and taking the whole layer down.
    expect(darkenHex("nonsense")).toBe("nonsense");
  });

  it("uses the darkened colour for the line, not the raw fill", () => {
    const paint = territoryPaint({ color: GREEN, status: "active" }, REP_FALLBACK);
    expect(paint.lineColor).toBe(darkenHex(GREEN));
    expect(paint.lineColor).not.toBe(paint.fillColor);
  });
});

describe("status changes the treatment without hiding the area", () => {
  it("maps the lifecycle onto three visual states", () => {
    expect(territoryVisualStatus("active")).toBe("active");
    expect(territoryVisualStatus("shared")).toBe("active");   // shared is live ground
    expect(territoryVisualStatus("completed")).toBe("completed");
    expect(territoryVisualStatus("unassigned")).toBe("pool");
    expect(territoryVisualStatus("reclaimed")).toBe("pool");
    expect(territoryVisualStatus(undefined)).toBe("active");  // legacy rows are live
  });

  it("dashes the pool so 'unclaimed' needs no legend", () => {
    expect(territoryPaint({ status: "unassigned" }, REP_FALLBACK).lineDasharray).toEqual([3, 2]);
    expect(territoryPaint({ status: "active" }, REP_FALLBACK).lineDasharray).toBeUndefined();
  });

  it("keeps a done or pooled area quieter than live ground, but still drawn", () => {
    expect(TERRITORY_FILL_OPACITY.completed).toBeLessThan(TERRITORY_FILL_OPACITY.active);
    expect(TERRITORY_FILL_OPACITY.pool).toBeLessThan(TERRITORY_FILL_OPACITY.active);
    for (const v of Object.values(TERRITORY_FILL_OPACITY)) expect(v).toBeGreaterThan(0);
    for (const v of Object.values(TERRITORY_LINE_WIDTH)) expect(v).toBeGreaterThanOrEqual(2);
    for (const v of Object.values(TERRITORY_LINE_OPACITY)) expect(v).toBeGreaterThan(0.5);
  });
});

describe("areas sit under the pins", () => {
  it("picks the lowest lead layer present as the insertion point", () => {
    const present = new Set(["lead-clusters", "lead-unclustered"]);
    expect(territoryBeforeId((id) => present.has(id))).toBe("lead-clusters");
  });

  it("prefers the very bottom of the lead stack when everything is up", () => {
    expect(territoryBeforeId(() => true)).toBe(TERRITORY_BEFORE_CANDIDATES[0]);
  });

  it("returns undefined when no lead layer exists yet", () => {
    // Correct, not a failure: the pins are added after us in that case, so
    // appending still leaves the area underneath.
    expect(territoryBeforeId(() => false)).toBeUndefined();
  });

  it("survives a map mid-teardown instead of throwing into the render", () => {
    expect(territoryBeforeId(() => { throw new Error("style not loaded"); })).toBeUndefined();
  });

  it("names only lead layers - never another territory layer", () => {
    // Inserting an area before another AREA would reintroduce the stacking bug
    // one polygon at a time.
    for (const id of TERRITORY_BEFORE_CANDIDATES) expect(id.startsWith("lead-")).toBe(true);
  });
});

// ── Choosing a colour for a new area ────────────────────────────────────────
// Colour IS the identifier on a map. Two areas wearing the same one read as a
// single region split by a road, which is worse than any individual colour
// being unattractive.
describe("a new area takes a colour nothing else is using", () => {
  const PAL = ["#AA0000", "#00BB00", "#0000CC"];

  it("takes the first free swatch", () => {
    expect(pickUnusedTerritoryColor(["#AA0000"], PAL)).toBe("#00BB00");
  });

  it("takes the first swatch when nothing is drawn yet", () => {
    expect(pickUnusedTerritoryColor([], PAL)).toBe("#AA0000");
  });

  it("does not collide the way random would", () => {
    // The real point. Random over 12 swatches is better-than-even to duplicate
    // by the fifth area — exactly the size of a working patch. Taking every
    // area in turn must yield the whole palette before anything repeats.
    const used: string[] = [];
    for (let i = 0; i < PAL.length; i++) used.push(pickUnusedTerritoryColor(used, PAL));
    expect(new Set(used).size).toBe(PAL.length);
  });

  it("spreads instead of clumping once every swatch is taken", () => {
    // Past the palette size a repeat is unavoidable. It should land on the
    // LEAST used colour, not always on the first one.
    const used = ["#AA0000", "#AA0000", "#00BB00", "#0000CC"];
    expect(pickUnusedTerritoryColor(used, PAL)).toBe("#00BB00");
  });

  it("matches case-insensitively, so #aa0000 counts as taken", () => {
    // Stored colours preserve the case they were saved in, so a case-sensitive
    // comparison would hand out a duplicate that merely looked different.
    expect(pickUnusedTerritoryColor(["#aa0000"], PAL)).toBe("#00BB00");
  });

  it("ignores rows with no colour, or an unreadable one", () => {
    expect(pickUnusedTerritoryColor([null, undefined, "", "nonsense"], PAL)).toBe("#AA0000");
  });

  it("counts a shorthand colour as the swatch it expands to", () => {
    expect(pickUnusedTerritoryColor(["#A00"], ["#AA0000", "#00BB00"])).toBe("#00BB00");
  });

  it("returns something paintable even with an empty palette", () => {
    expect(pickUnusedTerritoryColor([], [])).toBe(TERRITORY_POOL_COLOR);
  });
});
