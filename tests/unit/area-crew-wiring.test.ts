// ── Drawing an area for a CREW, not one rep ─────────────────────────────────
//
// An area is many-to-many everywhere in this product — assignee_ids, /share,
// /unassign, and rule 2 of shared/leadVisibility ("it sits in a territory they
// hold"). The one place that could not express it was the control that CREATES
// areas: the lasso panel had a single-select <select>, so a two-person patch had
// to be drawn for one rep and then shared as a second step, on a different
// screen, after the doors had already been handed to the wrong person.
//
// Source-level assertions, like tests/unit/lasso-default-action.test.ts and for
// the same reason: the picker lives in a ~9,000-line map component that cannot
// be mounted without a live GL context and a Mapbox token. Pinning the wiring is
// worth more than not pinning it — the failure mode is a quiet revert to
// one-rep-only that nothing else would catch.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const map = readFileSync(join(process.cwd(), "client/src/pages/MapView.tsx"), "utf8");
const areas = readFileSync(join(process.cwd(), "client/src/pages/Areas.tsx"), "utf8");
const detail = readFileSync(join(process.cwd(), "client/src/pages/AreaDetail.tsx"), "utf8");

describe("the lasso assigns an area to a crew", () => {
  it("holds the crew as an ORDERED list, not a single id", () => {
    expect(map).toMatch(/const \[lassoRepIds, setLassoRepIds\] = useState<number\[\]>\(\[\]\)/);
  });

  it("toggles a rep in and out rather than replacing the pick", () => {
    // The whole point of the control: tapping a second rep must ADD them.
    expect(map).toContain("prev.includes(repId) ? prev.filter((r) => r !== repId) : [...prev, repId]");
  });

  it("sends repIds to /assign-area, so the crew lands at creation", () => {
    const call = map.slice(map.indexOf('apiRequest("POST", "/api/territories/assign-area"'));
    expect(call.slice(0, 200)).toContain("repIds");
  });

  it("keeps the SEPARATE single-rep state for bulk 'Change Ownership'", () => {
    // Handing a lasso selection to somebody is one rep by definition; who walks
    // a patch is not. Collapsing the two would silently change bulk-assign.
    expect(map).toContain('const [lassoRepId, setLassoRepId] = useState("")');
    expect(map).toContain('repId: Number(lassoRepId),');
  });

  it("clears the crew on exit, so the next draw does not inherit it", () => {
    expect(map).toContain("setLassoRepIds([])");
  });

  it("disables Save until at least one rep is picked", () => {
    expect(map).toContain("disabled={!lassoRepIds.length || assignAreaMutation.isPending}");
  });

  it("marks the first pick as primary - it drives the colour, name and the doors' rep", () => {
    expect(map).toContain("idx === 0 && lassoRepIds.length > 1");
  });
});

describe("the Area tab shows and edits the whole crew", () => {
  it("reads holders through the ONE shared helper, on both screens", () => {
    // areaHolders() is where "a pool area has no holders" lives — repId
    // deliberately still names the LAST rep after a reclaim, and reading it as a
    // holder hands a reclaimed area back to the person it was taken from.
    expect(areas).toContain("areaHolders");
    expect(detail).toContain("areaHolders(area)");
  });

  it("removes ONE named rep via /unassign, not the primary by assumption", () => {
    expect(detail).toContain("`/api/territories/${id}/unassign`, { repId }");
    expect(detail).toContain("area-holder-remove-confirm-");
  });

  it("adds a rep via /share with the COMPLETE holder set", () => {
    // /share replaces the roster; sending a partial list silently drops people.
    expect(detail).toContain("[...holders.map(h => h.id), repId]");
  });

  it("arms removal before firing it - the doors go with the rep", () => {
    expect(detail).toContain("setConfirmRemoveId(h.id)");
  });
});
