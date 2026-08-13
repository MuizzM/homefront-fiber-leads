// "Show leads" must stay off once a rep turns it off.
//
// THE BUG THIS PINS. Three different code paths write `visibility` on the lead
// layers, and only one of them used to know about the toggle:
//
//   1. the toggle's own effect (showLeads)                     - knew
//   2. syncViewportTierLayers (pins <-> density tier handoff)  - did NOT
//   3. the rep-colour effect's repColorMode ON branch          - did NOT
//
// (2) is the damaging one, because it is called straight out of the window and
// grid FETCH CALLBACKS - not from an effect. React effect ordering cannot
// sequence it, so in viewport mode (which is what production runs at ~69k
// scoped pins) the first pan after hiding the pins put every one of them back.
// Reproduced in the browser before the fix: "Show leads" off in the sheet, and
// the map fully covered in pins.
//
// (3) is reachable by any manager: hide the pins, then turn "Color pins by rep"
// on, and the circle layer was forced visible regardless.
//
// Source-level assertions, same spirit as map-viewport-wiring.test.ts: MapView
// cannot be mounted without a live GL context.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "client/src/pages/MapView.tsx"), "utf8");

describe("showLeads is readable from the imperative (non-effect) writers", () => {
  it("keeps a ref mirror of the toggle", () => {
    // The fetch callbacks cannot read the state variable out of a closure -
    // they are bound once and outlive every render that changes it.
    expect(src).toContain("const showLeadsRef = useRef(showLeads);");
    expect(src).toContain("showLeadsRef.current = showLeads;");
  });
});

describe("syncViewportTierLayers honours the toggle", () => {
  const start = src.indexOf("const syncViewportTierLayers = useCallback(");
  const body = src.slice(start, src.indexOf("}, []);", start));

  it("is the region under test", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("DENSITY_LAYER_IDS");
    expect(body).toContain("GRID_TIER_HIDDEN_LAYER_IDS");
  });

  it("reads the toggle from the ref", () => {
    expect(body).toContain("showLeadsRef.current");
  });

  it("gates the PIN layers on it", () => {
    // Without this the window fetch callback flips lead-clusters,
    // lead-unclustered, lead-status-icons and the selection ring back on.
    expect(body).toMatch(/const showPins = leadsOn &&/);
  });

  it("gates the DENSITY layers on it too", () => {
    // The density bubbles are the wide-zoom rendering of the same lead set;
    // hiding the pins while leaving the bubbles up just relocates what the rep
    // asked to get rid of.
    expect(body).toMatch(/const showDensity = leadsOn &&/);
  });
});

describe("the rep-colour effect honours the toggle", () => {
  const start = src.indexOf("if (repColorMode) {");
  const body = src.slice(start, src.indexOf("} else {", start));

  it("is the region under test", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('map.setPaintProperty("lead-unclustered", "circle-color", ["get", "repColor"]);');
  });

  it("does not force the circle layer visible when leads are hidden", () => {
    // Rep-colour mode changes WHICH layer draws the pins, never WHETHER.
    expect(body).not.toContain('map.setLayoutProperty("lead-unclustered", "visibility", "visible");');
    expect(body).toContain('map.setLayoutProperty("lead-unclustered", "visibility", showLeads ? "visible" : "none");');
  });
});

describe("the toggle effect defers the tier-owned layers to one owner", () => {
  const start = src.indexOf("// ── Lead-layer visibility (control-rail toggle)");
  const body = src.slice(start, src.indexOf("}, [showLeads, mapReady, styleEpoch", start));

  it("is the region under test", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('const vis = showLeads ? "visible" : "none";');
  });

  it("hands the final word to syncViewportTierLayers", () => {
    // Otherwise turning the toggle back ON while the density tier is active
    // would raise the stale pin clusters over the bubbles - the same
    // competing-writers bug in the opposite direction.
    expect(body).toContain("syncViewportTierLayers(map);");
    expect(src).toContain("}, [showLeads, mapReady, styleEpoch, syncViewportTierLayers]);");
  });
});

describe("rep-colour mode owns the glyph layer", () => {
  // Rep-colour mode swaps the status glyphs out for rep-coloured circles at
  // every zoom. The other two writers walk the same layer list and used to put
  // the glyphs straight back, so a manager with "Color pins by rep" on saw BOTH
  // representations stacked - green glyph pins with rep-coloured rings peeking
  // out underneath. Reproduced in the browser before the fix.
  it("tracks the mode in a ref the imperative writers can read", () => {
    expect(src).toContain("const repColorActiveRef = useRef(false);");
    // Gated on canManage because the rep-colour effect itself bails without it -
    // the ref must not claim the layer for a user whose effect never runs.
    expect(src).toContain("repColorActiveRef.current = canManage && repColorMode;");
  });

  it("keeps the tier sync from re-showing the glyphs", () => {
    const start = src.indexOf("const syncViewportTierLayers = useCallback(");
    const body = src.slice(start, src.indexOf("}, []);", start));
    expect(body).toContain("id === STATUS_ICON_LAYER && repColorActiveRef.current");
  });

  it("keeps the Show-leads effect from re-showing the glyphs", () => {
    const start = src.indexOf("// ── Lead-layer visibility (control-rail toggle)");
    const body = src.slice(start, src.indexOf("}, [showLeads, mapReady, styleEpoch", start));
    expect(body).toContain("id === STATUS_ICON_LAYER && (!fieldMap || repColorActiveRef.current)");
  });
});

describe("the window loader does not refetch on a bare rebind", () => {
  const start = src.indexOf("const firstViewportFetchRef = useRef(true);");
  const body = src.slice(start, src.indexOf("}, [mapReady, styleEpoch, viewportMode]);", start));

  it("is the region under test", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('map.on("moveend", onMoveEnd);');
  });

  it("tracks the viewportMode it was last bound with", () => {
    expect(body).toContain("const wasOn = lastBoundViewportModeRef.current;");
    expect(body).toContain("lastBoundViewportModeRef.current = viewportMode;");
  });

  it("records the mode BEFORE the early return, so an off-cycle is still seen", () => {
    // Otherwise a false -> true flip is indistinguishable from a style rebind.
    const recordAt = body.indexOf("lastBoundViewportModeRef.current = viewportMode;");
    const guardAt = body.indexOf("if (!map || !mapReady || !viewportMode) return;");
    expect(recordAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(recordAt);
  });

  it("only fires the catch-up fetch on a genuine mode flip", () => {
    // This effect also re-runs on every styleEpoch bump. A style swap wipes
    // LAYERS, not the query cache - the pins are re-pushed onto the fresh style
    // from cache by the visibleLeads effect - so refetching there re-paid a full
    // synchronous server query for a window the client already held. Measured on
    // one boot before the fix: EIGHT identical bbox fetches for one window.
    expect(body).toContain("} else if (!wasOn) {");
    expect(body).not.toMatch(/}\s*else\s*{\s*onMoveEnd\(\);/);
  });
});
