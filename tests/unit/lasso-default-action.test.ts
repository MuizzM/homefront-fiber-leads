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
