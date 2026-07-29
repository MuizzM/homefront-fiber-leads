// The geometry gate was built, tested, and never plugged in.
//
// shared/polygonGeometry.ts exists to stop three specific things reaching the
// territories table: a ring that crosses itself, a ring made of duplicate
// pointer samples, and a sliver with no interior. It has 46 specs of its own and
// it had zero production importers — MapView's lasso posted the raw freehand
// stroke straight to /api/territories/assign-area. So the defects the module was
// written to prevent were live in the product the whole time it was green.
//
// The self-intersecting case is the expensive one, and it is silent. A bowtie
// still answers pointInPolygon; it just answers arbitrarily. The parity flip in
// the crossing region reports "outside" for doors the rep can plainly see inside
// the boundary on their phone. No error, no log line — the doors simply never
// get assigned, and nobody finds out until a street goes unknocked.
//
// These are source-level assertions, the same as lasso-default-action.test.ts
// and for the same reason: finish() lives inside a ~7,500-line map component
// that cannot be mounted without a live WebGL context and a Mapbox token. What
// is worth pinning is the WIRING — that the cleanup runs, that a rejection stops
// the save rather than warning beside it, and that the ring that is stored is
// the same ring the doors were tested against. Each of those is a one-line edit
// away from silently reverting.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(process.cwd(), "client/src/pages/MapView.tsx"), "utf8");

/** The body of finish() — from its declaration to the next sibling handler. */
const finishBody = (() => {
  const at = src.indexOf("const finish = () => {");
  expect(at, "finish() not found in MapView — did the lasso effect move?").toBeGreaterThan(-1);
  const end = src.indexOf("const cancelStroke", at);
  expect(end, "cancelStroke not found after finish() — cannot bound the body").toBeGreaterThan(at);
  return src.slice(at, end);
})();

describe("the lasso stroke is cleaned before it is treated as a polygon", () => {
  it("imports the geometry module that was written for this", () => {
    // The whole point of the change: polygonGeometry stops being dead code.
    expect(src).toMatch(/from\s+"@shared\/polygonGeometry"/);
  });

  it("de-duplicates the pointer samples first", () => {
    // A finger resting on the screen emits the same coordinate many times. Those
    // zero-length edges make the orientation tests meaningless — a valid ring
    // reads as one that touches itself.
    expect(finishBody).toContain("dedupeVertices(stroke)");
  });

  it("simplifies the de-duplicated ring, not the raw stroke", () => {
    // Douglas-Peucker on raw samples would be given duplicate points to chord
    // through, and hasSelfIntersection inside simplifyRing is O(n²) on up to
    // MAX_POINTS vertices. Order matters for correctness and for cost.
    const dedupeAt = finishBody.indexOf("dedupeVertices(");
    const simplifyAt = finishBody.indexOf("simplifyRing(");
    expect(simplifyAt, "simplifyRing is never called").toBeGreaterThan(-1);
    expect(simplifyAt).toBeGreaterThan(dedupeAt);
    expect(finishBody).toMatch(/simplifyRing\(\s*deduped\s*,/);
  });
});

describe("the simplification tolerance cannot visibly move the boundary", () => {
  // simplifyRing's invariant is that every input point is within the tolerance
  // of the output boundary, so this constant IS the ceiling on how far the saved
  // edge can drift from the drawn one. Territories are sold on the promise that
  // the notch a manager cut around a park survives; a loose tolerance rounds it
  // off, and nothing else in the system would notice.
  const declared = (() => {
    const m = src.match(/const LASSO_SIMPLIFY_TOLERANCE_DEG\s*=\s*([0-9.e+-]+)/i);
    expect(m, "LASSO_SIMPLIFY_TOLERANCE_DEG not found — was the tolerance inlined?").not.toBeNull();
    return Number(m![1]);
  })();

  it("is a real, positive tolerance — simplification actually happens", () => {
    // simplifyRing treats a non-positive tolerance as a no-op copy, which would
    // leave up to MAX_POINTS vertices on every point-in-polygon call forever.
    expect(Number.isFinite(declared)).toBe(true);
    expect(declared).toBeGreaterThan(0);
  });

  it("stays under two metres of possible boundary movement", () => {
    // 1e-4° is ~11 m and would visibly straighten a drawn inlet. The ceiling
    // here is deliberately below the ~5 px MIN_PX_DIST the stroke was sampled
    // at, so the tolerance is smaller than the input's own noise floor.
    const metresPerDegLat = 111_320;
    expect(declared * metresPerDegLat).toBeLessThan(2);
  });

  it("is used as the tolerance passed to simplifyRing", () => {
    // A constant that is documented and then not passed is worse than no
    // constant: the comment describes a guarantee the code does not make.
    expect(finishBody).toContain("simplifyRing(deduped, LASSO_SIMPLIFY_TOLERANCE_DEG)");
  });
});

describe("a ring that fails validation is not saved", () => {
  it("runs validateRing on the cleaned ring", () => {
    expect(finishBody).toContain("validateRing(cleaned)");
  });

  it("returns out of finish() on failure, before anything is selected or stored", () => {
    // The failure mode this guards is a "warn and continue" refactor: toast the
    // problem and save the broken ring anyway, which is the original bug plus a
    // notification. The early return must come before setLassoPoints.
    const failAt = finishBody.indexOf("if (!verdict.ok)");
    expect(failAt, "validateRing's result is never branched on").toBeGreaterThan(-1);
    const storeAt = finishBody.indexOf("setLassoPoints(ring)");
    expect(storeAt, "the ring is never stored — did the state setter change?").toBeGreaterThan(-1);
    expect(failAt).toBeLessThan(storeAt);

    const failureBlock = finishBody.slice(failAt, storeAt);
    expect(failureBlock, "the failure branch does not return").toContain("return;");
    expect(failureBlock, "the failure branch does not clear the preview").toContain("clearPreview()");
    expect(failureBlock, "a rejected loop must leave no saveable polygon behind")
      .toContain("setLassoPoints([])");
  });

  it("tells the user in the app's own toast, destructively", () => {
    // Every other error surface in MapView is a destructive toast. A console
    // warning here would be indistinguishable from the silent failure it
    // replaces: the manager taps Save and nothing happens.
    const failureBlock = finishBody.slice(finishBody.indexOf("if (!verdict.ok)"));
    expect(failureBlock).toContain("toast(");
    expect(failureBlock).toContain('variant: "destructive"');
  });
});

describe("each rejection reason is a sentence a rep can act on", () => {
  const table = (() => {
    const at = src.indexOf("const LASSO_RING_REJECTION");
    expect(at, "no rejection message table — is the raw enum being shown?").toBeGreaterThan(-1);
    return src.slice(at, src.indexOf("\n};", at));
  })();

  it("covers all four failures validateRing can report", () => {
    // The reasons are a closed string union. Missing one means that path shows
    // `undefined` in the toast title, which reads as a crash.
    for (const reason of ["too-few-points", "degenerate", "self-intersecting", "too-small"]) {
      expect(table, `no message for "${reason}"`).toContain(reason);
    }
  });

  it("never puts the raw enum in front of the user", () => {
    // "self-intersecting" as a title is jargon; it is fine as a key.
    const titles = [...table.matchAll(/title:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(titles).toHaveLength(4);
    for (const title of titles) {
      expect(title).not.toMatch(/too-few-points|self-intersecting|too-small|degenerate/);
      expect(title.length).toBeGreaterThan(10);
    }
  });

  it("tells them what to do differently, not just what went wrong", () => {
    // A message that only names the defect leaves the manager tapping the same
    // gesture again. Every description ends in an instruction.
    const descriptions = [...table.matchAll(/description:\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(descriptions).toHaveLength(4);
    for (const description of descriptions) {
      expect(description, `not actionable: ${description}`).toMatch(/Draw|Zoom/);
    }
  });

  it("is typed against the union, so a new reason is a compile error", () => {
    // Record<RingValidationFailure, …> is what makes this table impossible to
    // leave incomplete when polygonGeometry grows a fifth reason.
    expect(src).toMatch(/Record<\s*RingValidationFailure,/);
  });
});

describe("a loop that wraps the globe is refused, not measured", () => {
  it("screens crossesAntimeridian before anything computes an area", () => {
    // Every routine involved — ringAreaSqMeters, the shoelace inside it, and
    // pointInPolygon on the server — is planar. An edge spanning >180° of
    // longitude is computed the long way round the world, so the area, the
    // enclosure test and the rendered fill are all meaningless rather than
    // merely wrong. Screening after validation would let validateRing report
    // "too-small" for a shape the size of a hemisphere.
    const screenAt = finishBody.indexOf("crossesAntimeridian(");
    expect(screenAt, "crossesAntimeridian is never called").toBeGreaterThan(-1);
    expect(screenAt).toBeLessThan(finishBody.indexOf("validateRing("));
    expect(screenAt).toBeLessThan(finishBody.indexOf("simplifyRing("));
  });

  it("refuses it with its own message rather than a generic failure", () => {
    const block = finishBody.slice(
      finishBody.indexOf("crossesAntimeridian("),
      finishBody.indexOf("simplifyRing("),
    );
    expect(block).toContain("toast(");
    expect(block).toContain('variant: "destructive"');
    expect(block).toContain("return;");
    expect(block).toContain("clearPreview()");
  });
});

describe("what is saved and what is selected are the same shape", () => {
  // The subtle version of the original bug. Cleaning the ring for storage but
  // running point-in-polygon on the raw stroke — or the reverse — means the
  // doors handed to the rep were chosen against a boundary that is not the
  // boundary they will see. Both must read the validated ring.
  it("stores the validated ring, not the stroke", () => {
    expect(finishBody).toContain("const ring = verdict.ring");
    expect(finishBody).toContain("setLassoPoints(ring)");
    expect(finishBody).not.toContain("setLassoPoints(stroke)");
  });

  it("runs the point-in-polygon selection against that same ring", () => {
    expect(finishBody).toContain("selectPointsInPolygon(source, ring)");
    expect(finishBody).not.toContain("selectPointsInPolygon(source, stroke)");
  });

  it("previews the ring that will be saved", () => {
    // render() draws from `stroke`. Rebinding it to the validated ring before
    // the closing render is what makes the filled shape on screen the shape in
    // the database — otherwise the manager approves a preview of the raw stroke.
    const assignAt = finishBody.indexOf("stroke = ring");
    expect(assignAt, "the preview still renders the raw stroke").toBeGreaterThan(-1);
    expect(assignAt).toBeLessThan(finishBody.indexOf("render(true)"));
  });

  it("still posts lassoPoints — the polygon, never the enclosed leads", () => {
    // Pinned in lasso-default-action.test.ts too, and worth restating here:
    // now that lassoPoints holds the CLEANED ring, this is the line that carries
    // the whole fix to the server.
    expect(src).toContain("polygon: lassoPoints");
  });
});

describe("the cheap accidental-tap guard is left alone", () => {
  it("still discards a stroke under 8 points before any geometry runs", () => {
    // An accidental tap should cost a length check, not a Douglas-Peucker pass
    // and an O(n²) self-intersection scan. It also must not produce a toast:
    // brushing the screen is not an error the user needs told about.
    const tapAt = finishBody.indexOf("stroke.length < 8");
    expect(tapAt, "the accidental-tap guard was removed").toBeGreaterThan(-1);
    expect(tapAt).toBeLessThan(finishBody.indexOf("dedupeVertices("));
    expect(finishBody.slice(0, tapAt)).not.toContain("toast(");
  });
});
