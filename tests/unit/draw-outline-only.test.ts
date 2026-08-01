// Drawing tools show a boundary, never a live fill (SalesRabbit reference,
// owner directive: "draw dotted line without filling inside — fill after").
//
// Contract: while a stroke/drag is in progress the map shows ONLY the dashed
// or dotted outline; a fill may appear only for the COMPLETED shape. Source-
// level assertions in the map-chrome-minimal.test.ts spirit — the properties
// pinned here are wiring facts the source states directly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "client/src/pages/MapView.tsx"), "utf8");

describe("scan box drag is outline-only", () => {
  it("the draw-bbox fill layer is gone from every add site", () => {
    // Two add sites exist (init + post-setStyle restore) — neither may fill.
    expect(src).not.toContain('"draw-bbox-fill"');
    expect(src).not.toContain("draw-bbox-fill");
  });

  it("the dashed outline layer remains at both add sites", () => {
    const matches = src.match(/id: "draw-bbox-outline"/g) ?? [];
    expect(matches.length).toBe(2);
  });
});

describe("lasso fills only the COMPLETED ring", () => {
  it("mid-draw geometry is an open LineString (fill layers ignore it); the ring closes only on release", () => {
    // render(closeRing) builds a Polygon only when closeRing is true —
    // in-progress repaints call render(false) via the coalesced flush.
    const renderStart = src.indexOf("const render = (closeRing: boolean)");
    expect(renderStart).toBeGreaterThan(-1);
    const body = src.slice(renderStart, renderStart + 2400);
    expect(body).toContain('return closeRing && disp.length >= 3');
    expect(body).toContain('type: "LineString" as const');
    expect(src).toContain("if (drawing) render(false)");
  });

  it("the lasso outline is the round-dot boundary in the area's color", () => {
    const outline = src.indexOf('id: "lasso-outline"');
    expect(outline).toBeGreaterThan(-1);
    const spec = src.slice(outline, outline + 700);
    expect(spec).toContain('"line-dasharray": [0, 2.2]');
    expect(spec).toContain('"line-cap": "round"');
  });
});
