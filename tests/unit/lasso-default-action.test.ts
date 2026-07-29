// Drawing a shape has to draw an AREA.
//
// The lasso panel offers four actions — Assign, Status, Mark, Area — and only
// "Area" saves a polygon. It defaulted to "Assign", which is bulk LEAD
// reassignment: the ordinary flow (draw a loop, pick a rep, tap the button)
// moved the doors and created no territory at all. Nothing appeared on the
// manager's map or on the rep's, because nothing had been created, and the only
// clue was that "Area" was the fourth tab.
//
// This is a source-level assertion rather than a render test because the default
// lives in a useState initialiser inside a ~7,000-line map component that cannot
// be mounted without a live GL context and a Mapbox token. Pinning the literal
// is worth more than not pinning it at all: the failure mode is a one-word edit
// that silently returns the product to "I draw and nothing happens".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(process.cwd(), "client/src/pages/MapView.tsx"), "utf8");

describe("the lasso draws an area by default", () => {
  it("initialises lassoAction to 'area', not 'assign'", () => {
    const decl = src.match(
      /useState<"assign"\s*\|\s*"status"\s*\|\s*"mark"\s*\|\s*"area">\(\s*"([a-z]+)"/,
    );
    expect(decl, "lassoAction useState declaration not found — did it move?").not.toBeNull();
    expect(decl![1]).toBe("area");
  });

  it("resets to 'area' on exit, so the NEXT draw does not silently revert", () => {
    // Leaving exitLasso on "assign" would reproduce the bug on every draw after
    // the first, which is worse than the original because it looks intermittent.
    expect(src).toContain('setLassoAction("area")');
    expect(src).not.toContain('setLassoAction("assign")');
  });

  it("still offers the other three actions", () => {
    // The fix is a default, not a removal. Bulk assign/status/mark stay one tap
    // away — they are real tools, they just are not what drawing a shape means.
    for (const key of ["assign", "status", "mark", "area"]) {
      expect(src).toContain(`["${key}",`);
    }
  });

  it("previews the stroke in the colour the area will be saved in", () => {
    // The preview used a hardcoded teal, so the colour chosen before drawing
    // only became visible after saving — the one moment it could not be changed.
    expect(src).toContain('"fill-color": lassoColorRef.current');
    expect(src).toContain('"line-color": lassoColorRef.current');
    expect(src).not.toContain('"fill-color": "#2dd4bf"');
  });

  it("reads the colour through a ref, because the handler binds once", () => {
    // The stroke handler is attached at map init. Closing over lassoColor would
    // paint whatever the colour was when the map loaded, not when you drew.
    expect(src).toContain("lassoColorRef.current = lassoColor");
  });
});

// ── The second half of "I draw and nothing happens" ─────────────────────────
// Making "area" the default fixed WHICH tab is preselected. It did not fix
// whether you can reach any tab at all: the panel opened on
//
//     {lassoSelected.length === 0 ? (hint) : (actions)}
//
// and lassoSelected is the LEADS caught by the loop, not the loop. Draw around
// ground with no mapped doors — carving fresh territory, the exact case the
// feature exists for — and the hint stayed up. The stroke was already in
// lassoPoints; there was simply no Save button anywhere on screen.
//
// finish() sets lassoPoints unconditionally and lassoSelected to whatever it
// found, so the shape is the honest signal that a loop exists.
describe("the action panel opens on the SHAPE, not on what it caught", () => {
  it("gates the panel on the drawn stroke", () => {
    expect(src).toContain("const lassoDrawn = lassoPoints.length > 0");
    expect(src).toContain("{!lassoDrawn ? (");
  });

  it("never gates it on the lead selection again", () => {
    // The literal regression. An empty loop is a valid loop.
    expect(src).not.toContain("lassoSelected.length === 0 ?");
  });

  it("resolves an empty loop to Area, whatever tab was last used", () => {
    // Opening on "Assign" with nothing selected shows one disabled button and
    // reads as broken — the same dead end by a shorter route.
    expect(src).toContain("const lassoEffectiveAction = lassoHasLeads ? lassoAction : \"area\"");
    for (const key of ["assign", "status", "mark", "area"]) {
      expect(src).toContain(`{lassoEffectiveAction === "${key}" && (`);
    }
  });

  it("disables only the three actions that need lead IDs", () => {
    // Area needs the polygon and a rep. The others operate on lassoActiveIds and
    // would post an empty array.
    expect(src).toContain('const disabled = !lassoHasLeads && key !== "area"');
  });

  it("still sends the polygon, not the selection, when saving an area", () => {
    // Guards against a "fix" that derives the ring from the enclosed leads —
    // which for an empty loop is no ring at all.
    expect(src).toContain("polygon: lassoPoints");
  });
});
