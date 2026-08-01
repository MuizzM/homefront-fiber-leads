// Does MapView actually hand TerritoryDetailPanel the callbacks it needs?
//
// This test exists because of a specific failure that shipped: the per-rep
// "remove from this area" control was built, unit-tested, integration-tested and
// merged — and no user could ever see it, because MapView never passed
// onUnassignRep. The panel hides that control unless the handler is present, so
// the feature was invisible while every test stayed green.
//
// Every RTL test for the panel injects its props directly, which is what makes
// them good component tests and exactly why they cannot catch this: they assert
// "given the handler, the button renders", and the bug was that nothing ever
// gave it the handler. Rendering MapView for real means a map, a query client,
// geolocation and ~6k lines of page — so this checks the wiring at the source
// level instead. Coarse, but it fails when the connection is missing, which is
// the only property that matters here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const mapView = readFileSync(join(ROOT, "client/src/pages/MapView.tsx"), "utf8");
const panel = readFileSync(join(ROOT, "client/src/components/TerritoryDetailPanel.tsx"), "utf8");

/** Props the panel treats as "no handler → hide the control entirely". */
const HANDLER_GATED_CONTROLS = [
  "onUnassignRep",   // remove one rep from an area
  "onStartNextPass", // re-open the area for another sweep
  "onReclaim",       // pull the whole area back
  "onViewHistory",
] as const;

describe("MapView ↔ TerritoryDetailPanel wiring", () => {
  it.each(HANDLER_GATED_CONTROLS)("MapView passes %s", (prop) => {
    // The panel must actually gate on it (otherwise this test guards nothing)…
    expect(panel).toContain(prop);
    // …and MapView must actually supply it.
    expect(mapView, `MapView never passes ${prop}, so its control can never render`)
      .toMatch(new RegExp(`${prop}\\s*=\\s*\\{`));
  });

  it("mounts the next-pass dialog, not just the button that opens it", () => {
    // A button that sets state nothing reads is the same bug in a new costume.
    expect(mapView).toContain("StartNextPassDialog");
    expect(mapView).toMatch(/setNextPassTerritoryId\(/);
    expect(mapView).toMatch(/nextPassTerritoryId\s*!=\s*null\s*&&/);
  });

  it("hits the real endpoints for the actions it wires", () => {
    expect(mapView).toMatch(/territories\/\$\{[^}]+\}\/unassign/);
    expect(mapView).toMatch(/territories\/\$\{[^}]+\}\/next-pass/);
  });
});

describe("UI gates follow the permission table, not hard-coded role lists", () => {
  it("MapView derives territory capability from can()", () => {
    // The original read `user?.role === "admin" || user?.role === "manager"`,
    // which silently outranked shared/permissions: team leads were granted
    // reclaim server-side while the UI kept hiding every control from them.
    expect(mapView).toMatch(/roleCan\(\s*user\?\.role,\s*"assign_territory"\s*\)/);
    expect(mapView).toMatch(/roleCan\(\s*user\?\.role,\s*"reclaim_territory"\s*\)/);
    expect(mapView).toMatch(/roleCan\(\s*user\?\.role,\s*"reset_territory_pass"\s*\)/);
  });

  it("no hard-coded admin/manager role comparison guards territory actions", () => {
    const hardCoded = /const\s+canManage\s*=\s*user\?\.role\s*===/;
    expect(mapView).not.toMatch(hardCoded);
  });
});

// ── Territory-UI audit (owner report: overlap / doesn't close / stale) ───────
// These pin MapView-side fixes that RTL cannot reach without mounting the whole
// 8k-line page: chooser lifecycle, close-control placement, and per-mode
// pending guards around the reclaim mutation.
describe("reclaim flow hygiene in MapView", () => {
  it("disarms the reclaim mode chooser whenever the selected territory changes", () => {
    // Without this, closing the panel with the chooser open and reopening the
    // same area showed the destructive mode menu already armed.
    expect(mapView).toMatch(
      /useEffect\(\(\)\s*=>\s*\{\s*setReclaimMenuId\(null\);\s*\},\s*\[selectedTerritoryId\]\)/,
    );
  });

  it("locks every reclaim mode control while one mode is committing", () => {
    // A double-tap on "Return leads to pool" used to fire the POST twice.
    // Two buttons + a select in the panel chooser, and the same trio in the
    // sidebar chooser, all disable on reclaimMutation.isPending.
    const guards = mapView.match(/disabled=\{reclaimMutation\.isPending\}/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(6);
    // And the tapped mode owns the wait visibly (per-control pending state).
    expect(mapView).toMatch(/reclaimPendingMode/);
  });

  it("keeps the panel's close control OUTSIDE the scroll container", () => {
    // Inside it, the X's negative offsets sat in clipped overflow and the
    // button scrolled off-screen the moment the panel was scrolled down to the
    // reclaim chooser — an open panel with no visible way to close it.
    const closeIdx = mapView.indexOf('aria-label="Close territory panel"');
    expect(closeIdx).toBeGreaterThan(-1);
    // The scrollable wrapper starts AFTER the close button in the tree.
    const scrollIdx = mapView.indexOf("overflow-y-auto overscroll-contain rounded-2xl", closeIdx);
    expect(scrollIdx).toBeGreaterThan(closeIdx);
  });

  it("the share dialog closes from the scrim, not only from Cancel", () => {
    expect(mapView).toContain('data-testid="share-dialog-scrim"');
  });

  it("reports next-pass and unassign failures instead of silence", () => {
    // Both mutations lacked onError: a failed reset left the dialog open with
    // no spinner and no explanation.
    expect(mapView).toMatch(/Couldn't start the next pass/);
    expect(mapView).toMatch(/Couldn't remove the rep from this area/);
  });

  it("uses lucide icons, never raw arrow glyphs, on reclaim controls", () => {
    expect(mapView).not.toContain("↩"); // "↩" — the old text-glyph buttons
    expect(mapView).toMatch(/Undo2/);
  });

  it("reserves the assignee bar's strip when both surfaces are mounted", () => {
    // Panel and bottom bar mount for the same selected area; the panel's
    // max-height backs off when the bar is on screen instead of scrolling
    // underneath it.
    expect(mapView).toMatch(/assigneeBarShown/);
  });
});

describe("currentPass reaches the client", () => {
  it("is declared on the territories schema, not only as a raw ALTER", () => {
    // A column added by migration but absent from the Drizzle table is never
    // SELECTed, so the map cannot label which pass an area is on.
    const schema = readFileSync(join(ROOT, "shared/schema.ts"), "utf8");
    expect(schema).toMatch(/currentPass:\s*integer\("current_pass"\)/);
  });
});
