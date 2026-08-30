// The lasso's "Add doors" action - wiring, not painting.
//
// MapView is ~9,000 lines and its lasso panel only mounts after a freehand
// drag, so this asserts the wiring at the source level the way
// map-chrome-minimal.test.ts does for the map chrome. The BEHAVIOUR of the
// endpoint it calls is covered end-to-end in
// tests/integration/address-point-authority.test.ts.
//
// What would silently break without these:
//   - the tile exists but "create" is not in the action union, so clicking it
//     falls through to whatever branch renders last
//   - the tile exists but an empty loop forces the action back to "area",
//     disabling the one action a manager opened the panel for
//   - the button exists but posts the ring to the assign endpoint
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "client/src/pages/MapView.tsx"), "utf8");

describe("lasso: add doors from the county address file", () => {
  it("'create' is a real action, not just a tile", () => {
    expect(src).toMatch(/useState<"assign" \| "status" \| "mark" \| "area" \| "create">/);
    expect(src).toContain('["create", "Add doors", Plus]');
    expect(src).toContain('data-testid={`lasso-action-${key}`}');
  });

  it("survives an EMPTY loop - the case it exists for", () => {
    // A loop with no leads is exactly the loop drawn over virgin territory.
    // (Assign joined the exceptions when the server preview learned to count
    // unsampled doors - lasso-default-action.test.ts pins the full rule.)
    expect(src).toMatch(
      /lassoHasLeads \|\|\s*lassoAction === "create" \|\|/,
    );
    // …and the tile is never disabled on an empty loop either.
    expect(src).toMatch(/key === "area" \|\| key === "create"\s*\? false/);
  });

  it("posts the RING to the create endpoint, never the assign one", () => {
    expect(src).toContain('"/api/leads/create-from-selection"');
    const call = src.slice(src.indexOf('"/api/leads/create-from-selection"'));
    // The ring travels; an id list never does. Same contract as assign-selection.
    expect(call.slice(0, 220)).toContain("polygon");
    expect(src).toContain('data-testid="lasso-create-doors"');
  });

  it("the tile row grew to fit five actions rather than dropping one", () => {
    // grid-cols-4 with five children silently wraps the fifth onto its own row,
    // which reads as a rendering bug rather than a fifth action.
    expect(src).toContain("grid grid-cols-5 gap-1.5");
  });

  it("reports the result, because the map cannot show it", () => {
    // "82 added" and "they were already yours" look identical on a map that
    // has just refetched. This is the one lasso outcome that must be told.
    expect(src).toMatch(/door\$\{d\.created === 1 \? "" : "s"\} added/);
    expect(src).toContain("No new doors - they were already on the map");
  });
});
