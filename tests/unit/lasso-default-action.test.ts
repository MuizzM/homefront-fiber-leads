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

// ── Drawing on a phone ──────────────────────────────────────────────────────
// Completing a freshly drawn lasso on mobile web scrolled the page down and,
// from scroll top, reloaded it. The arming step is the cause: Mapbox drives the
// canvas's touch-action from classes it applies only while drag-pan AND
// touch-zoom-rotate are enabled, so disabling both — which the lasso must do to
// stop the map sliding under the stroke — drops the canvas to touch-action:auto
// and hands the finger to the browser. Behaviour of the lock itself is covered
// in lasso-gesture-lock.test.ts; these pin the wiring.
describe("arming the lasso suspends the browser's gestures too", () => {
  it("takes the lock in the same effect that disables the map's handlers", () => {
    // The two must move together. Disabling map gestures without taking the
    // lock IS the bug, so they belong in one place with no branch between them.
    const armIndex = src.indexOf("map.touchZoomRotate.disable()");
    const lockIndex = src.indexOf("lockGesturesForDrawing(mapGestureTarget(map))");
    expect(armIndex, "map gesture disable not found — did it move?").toBeGreaterThan(-1);
    expect(lockIndex, "gesture lock is never acquired").toBeGreaterThan(armIndex);
  });

  it("releases before anything that could throw in the cleanup", () => {
    // Cleanup then calls map.off / map.dragPan.enable inside try blocks against
    // a map that may already be torn down. Releasing after them would risk
    // leaving the page permanently unable to scroll — worse than the original.
    const cleanup = src.slice(src.indexOf("(window as any).__lassoActive = false;"));
    const release = cleanup.indexOf("releaseGestures()");
    const reEnable = cleanup.indexOf("map.dragPan.enable()");
    expect(release).toBeGreaterThan(-1);
    expect(reEnable).toBeGreaterThan(-1);
    expect(release).toBeLessThan(reEnable);
  });

  it("re-enables the map's own gestures when the tool disarms", () => {
    // Restoring one half without the other leaves the map dead to touch.
    for (const call of [
      "map.dragPan.enable()",
      "map.touchZoomRotate.enable()",
      "map.doubleClickZoom.enable()",
    ]) {
      expect(src).toContain(call);
    }
  });
});

describe("no control in the lasso panel can navigate or submit", () => {
  // A <button> with no type attribute defaults to type="submit". The panel sits
  // in a page that has no <form> today, so nothing submits — but that is an
  // accident of the surrounding markup, not a property of these controls, and
  // "the page reloaded when I finished a lasso" is exactly the symptom an
  // implicit submit produces if a form is ever wrapped around this.
  const PANEL_CONTROLS = ["lasso-exit", "lasso-assign", "lasso-set-status", "lasso-set-mark"];

  it("declares type=\"button\" on every one of them", () => {
    for (const testid of PANEL_CONTROLS) {
      const attr = `data-testid="${testid}"`;
      let from = 0;
      let seen = 0;
      for (;;) {
        const at = src.indexOf(attr, from);
        if (at === -1) break;
        seen++;
        from = at + attr.length;
        // The opening "<button" / "<Button" for this control, then everything
        // between it and the testid — where the type attribute must appear.
        const tagStart = Math.max(
          src.lastIndexOf("<button", at),
          src.lastIndexOf("<Button", at),
        );
        expect(tagStart, `${testid}: no button tag before it`).toBeGreaterThan(-1);
        expect(
          src.slice(tagStart, at).includes('type="button"'),
          `${testid} has no explicit type="button" — it would submit a surrounding form`,
        ).toBe(true);
      }
      expect(seen, `${testid} not found in MapView`).toBeGreaterThan(0);
    }
  });

  it("types the four action tabs, whose testid is interpolated", () => {
    // Rendered from a map(), so `lasso-action-assign` never appears literally.
    const tab = src.indexOf("data-testid={`lasso-action-${key}`}");
    expect(tab, "action tab not found — did the testid change?").toBeGreaterThan(-1);
    const tagStart = src.lastIndexOf("<button", tab);
    expect(src.slice(tagStart, tab)).toContain('type="button"');
  });

  it("has no form element around the map at all", () => {
    expect(src).not.toContain("<form");
  });
});

// ── The numbers were on the wire and nobody passed them ─────────────────────
// Reported from production: an area card showing "AREA WORKED 0.00% — 0 of 1150
// leads worked" and nothing else. No penetration, no completion, no sold count.
//
// The metrics were not missing. /api/territories/progress returns knocked, sold,
// availableBase and the three canonical rates from shared/territoryMetrics, and
// TerritoryDetailPanel renders all of them — behind `progress.knocked != null`.
// MapView built the `progress` prop as a hand-picked literal of eight fields
// that did not include knocked, so the gate never opened and the entire stats
// block was dead code in the shipped app while passing its own unit tests
// against a hand-built fixture.
//
// Source-level, for the same reason as the rest of this file: the literal lives
// deep inside a component that cannot be mounted without a GL context.
describe("the area card is handed the numbers the server sent", () => {
  const propBlock = (() => {
    const at = src.indexOf("progress={");
    expect(at, "progress prop not found — did it move?").toBeGreaterThan(-1);
    return src.slice(at, at + 2600);
  })();

  it("passes the operational counts, not just the location-verified ones", () => {
    // knocked is the one the panel's whole stats section is gated on.
    for (const field of ["knocked:", "sold:", "availableBase:"]) {
      expect(propBlock, `${field} is not forwarded — the panel cannot show it`).toContain(field);
    }
  });

  it("passes all three canonical rates", () => {
    // Defined once in shared/territoryMetrics so every surface agrees. Computing
    // them and then not forwarding them is how two screens end up disagreeing.
    for (const field of ["penetrationRate:", "knockCompletionRate:", "contactRate:"]) {
      expect(propBlock, `${field} is not forwarded`).toContain(field);
    }
  });

  it("still passes the location-verified fields it always did", () => {
    // The fix adds; it must not drop what was working.
    for (const field of ["verifiedWorkedLeads:", "areaWorkedPct:", "maxAllowedDistanceM:"]) {
      expect(propBlock).toContain(field);
    }
  });
});

// ── Reps keep the numbers, not the controls ─────────────────────────────────
// The area card is deliberately visible to a rep — knowing how much ground is
// left is the point of holding an area. What a rep must NOT get is any control
// that changes who works it, what it is called, or whether it still exists.
//
// Every management handler is gated on canManage (assign_territory, which a rep
// does not have) so the panel receives `undefined` and renders nothing. The
// pool-assign block was the exception: gated on the area's STATUS alone.
describe("management controls are gated on the viewer's role, not the area's status", () => {
  it("gates the pool assign block on canManage, not only isPool", () => {
    // The one control on this card that hands an area to a rep was the one that
    // never asked who was looking.
    expect(src).toContain("{isPool && canManage && (");
    expect(src).not.toMatch(/\{isPool && \(\s*$/m);
  });

  it("gates every area-mutating handler on a capability", () => {
    // Reading these as source is the only option — MapView cannot be mounted
    // without a GL context. Each must be a conditional, never passed bare.
    for (const handler of ["onRename=", "onRecolor=", "onUnassignRep=", "onEditAssignees="]) {
      const at = src.indexOf(handler);
      expect(at, `${handler} not found — did it move?`).toBeGreaterThan(-1);
      const block = src.slice(at, at + 220);
      expect(block, `${handler} is not role-gated`).toMatch(/canManage|canAssign|can\w*\(/);
    }
  });

  it("gates the on-map assignee bar too", () => {
    // The shortcut must not be a way around the gate the long route enforces.
    expect(src).toContain("selectedTerritoryId != null && canManage");
  });

  it("gates pass reset on its own capability, not on generic management", () => {
    // Resetting a pass clears a whole team's outcomes — heavier than assignment,
    // and manager+ rather than team_lead+.
    expect(src).toContain("canResetPass ? () => setNextPassTerritoryId(t.id) : undefined");
  });
});
