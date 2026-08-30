// The lasso's Assign must send the RING, never the ids.
//
// Shipping ids capped the action twice over, both invisibly:
//   1. The global API body limit is 64 KB and a production lead id costs ~8
//      bytes, so a large lasso died at the PARSER - before the route, so the
//      friendly BULK_TOO_LARGE message never ran and the browser showed only a
//      network failure ("Load failed" in Safari).
//   2. Past the sampling threshold the map ships a SAMPLE of the window's pins,
//      and the client can only enumerate pins it holds - so Assign silently
//      skipped every unsampled door inside the loop.
//
// Source-level assertions for the same reason lasso-default-action.test.ts uses
// them: this lives in a ~7,000-line map component that cannot be mounted without
// a live GL context and a Mapbox token. The endpoint's own behaviour is covered
// through the real HTTP stack in tests/integration/assign-selection.test.ts.
// See docs/architecture/BULK_ASSIGNMENT.md.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(process.cwd(), "client/src/pages/MapView.tsx"), "utf8");

// The bulkAssignMutation body, isolated so a match in some other mutation
// cannot make these pass by accident.
const assignMutation = (() => {
  const start = src.indexOf("const bulkAssignMutation");
  expect(start, "bulkAssignMutation not found - did it move?").toBeGreaterThan(-1);
  const end = src.indexOf("const bulkStatusMutation", start);
  return src.slice(start, end > start ? end : start + 4_000);
})();

describe("lasso Assign posts a ring", () => {
  it("calls /api/leads/assign-selection, not the id-based route", () => {
    expect(assignMutation).toContain("/api/leads/assign-selection");
    expect(assignMutation).not.toContain("/api/leads/bulk-assign");
  });

  it("sends the polygon and never a leadIds array", () => {
    expect(assignMutation).toContain("polygon");
    // The whole point: the payload must not scale with the door count.
    expect(assignMutation).not.toMatch(/leadIds\s*[,:]/);
  });

  it("retries a dead connection, because assigning twice is the same end state", () => {
    // A server stall window is seconds; without this the manager sees a failure
    // for something that would have succeeded a moment later.
    expect(assignMutation).toContain("apiRequestIdempotent");
  });

  it("posts the SAME selection body the preview confirmed, plus rep and opId", () => {
    // One body serves the preview query and the apply (lassoSelectionBody), so
    // the count shown and the set assigned cannot drift. The mutation spreads
    // it verbatim and adds only the rep and the per-attempt idempotency key.
    expect(assignMutation).toContain("...selection");
    expect(assignMutation).toContain("repId");
    expect(assignMutation).toContain("opId");
  });
});

describe("the selection body carries every lens the panel can draw under", () => {
  const bodyDecl = (() => {
    const start = src.indexOf("const lassoSelectionBody");
    expect(start, "lassoSelectionBody not found - did it move?").toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("const lassoPreviewQuery", start));
  })();

  it("maps the source filter to the server view and pin-source lenses", () => {
    expect(bodyDecl).toContain("sourceFilterToMapView");
    expect(bodyDecl).toContain("source");
  });

  it("forwards the rep filter", () => {
    expect(bodyDecl).toContain("repFilter");
    expect(bodyDecl).toContain('"unassigned"');
  });

  it("the preview and the mutation read one body", () => {
    // The preview queries with the body; the mutation spreads the same object.
    const preview = src.slice(
      src.indexOf("const lassoPreviewQuery"),
      src.indexOf("const lassoPreview =", src.indexOf("const lassoPreviewQuery")),
    );
    expect(preview).toContain("/api/leads/assign-selection/preview");
    expect(preview).toContain("lassoSelectionBody");
  });
});

describe("the status refinement survives the trip", () => {
  it("derives includeStates from the canonical state list, not from the selection", () => {
    // Deriving it from the states PRESENT in the client's sample would exclude
    // every unsampled door in a state the sample happened to miss - reintroducing
    // the bug the ring exists to fix, in a harder-to-see form.
    const decl = src.slice(src.indexOf("const lassoEnabledStates"), src.indexOf("const lassoActive"));
    expect(decl).toContain("Object.keys(STATE_COLORS)");
    expect(decl).toContain("lassoDisabled");
    expect(decl).not.toContain("lassoSelected");
    // The map's own status filter folds into the same refinement - the panel
    // only SHOWS that state, so the server must only move that state.
    expect(decl).toContain("filterStatus");
  });

  it("sends nothing at all when the manager refined nothing", () => {
    // undefined must mean "every state" server-side; sending a list built from
    // an empty refinement would mean "only these".
    const decl = src.slice(src.indexOf("const lassoEnabledStates"), src.indexOf("const lassoActive"));
    expect(decl).toContain("enabled.length === all.length ? undefined : enabled");
    const bodyDecl = src.slice(src.indexOf("const lassoSelectionBody"), src.indexOf("const lassoPreviewQuery"));
    expect(bodyDecl).toContain("...(lassoEnabledStates ? { includeStates: lassoEnabledStates } : {})");
  });
});

describe("the sampled-window warning tells the truth", () => {
  it("no longer claims Assign is limited to the loaded doors", () => {
    // JSX wraps the sentence across lines, so compare on collapsed whitespace.
    const warn = src.slice(
      src.indexOf('data-testid="lasso-sample-warning"'),
      src.indexOf('data-testid="lasso-empty-note"'),
    ).replace(/\s+/g, " ");
    expect(warn).toContain("Status and Mark apply only to the doors loaded");
    expect(warn).toContain("Assign covers every door inside the loop");
    // The old copy named Assign first among the limited actions.
    expect(warn).not.toContain("Assign, Status and Mark apply only");
  });
});
