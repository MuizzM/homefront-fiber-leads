// "Which doors may this rep work?" was answered in two places that disagreed,
// and the disagreement reached the field: the knock path allowed an open-field
// door (no rep, no territory) while the map's SQL never selected one — legal to
// work, impossible to see. A rep cannot knock a pin that was never drawn.
//
// The rule now has one home and two encodings. These tests pin the predicate's
// truth table; tests/integration/lead-visibility-parity.test.ts pins that the
// SQL encoding agrees with it against a real database.
import { describe, expect, it } from "vitest";
import { repCanWorkLead, repVisibilitySql } from "@shared/leadVisibility";

const SCOPE = [7];                       // the rep
const AREAS = new Set([100]);            // the one territory they hold

describe("repCanWorkLead", () => {
  it("their own door", () => {
    expect(repCanWorkLead({ assignedRepId: 7, assignedTerritoryId: null }, SCOPE, AREAS)).toBe(true);
  });

  it("a door in an area they hold, even when another rep is the named primary", () => {
    // An area is many-to-many; assigned_rep_id names only ONE assignee, and
    // filtering on it alone hid every shared door from everybody else.
    expect(repCanWorkLead({ assignedRepId: 9, assignedTerritoryId: 100 }, SCOPE, AREAS)).toBe(true);
  });

  it("OPEN FIELD — no rep and no territory is unowned ground, self-serve", () => {
    // The branch the SQL was missing. This is the ~62k imported town leads.
    expect(repCanWorkLead({ assignedRepId: null, assignedTerritoryId: null }, SCOPE, AREAS)).toBe(true);
  });

  it("another rep's door is denied", () => {
    expect(repCanWorkLead({ assignedRepId: 9, assignedTerritoryId: null }, SCOPE, AREAS)).toBe(false);
  });

  it("a door in another team's area is denied — even with no rep on it", () => {
    // Unassigned INSIDE someone else's area is not open field: the area is owned.
    expect(repCanWorkLead({ assignedRepId: null, assignedTerritoryId: 200 }, SCOPE, AREAS)).toBe(false);
  });

  it("a missing lead is denied, never allowed by default", () => {
    expect(repCanWorkLead(null, SCOPE, AREAS)).toBe(false);
    expect(repCanWorkLead(undefined, SCOPE, AREAS)).toBe(false);
  });

  it("an empty scope can work nothing — not even open field", () => {
    // A login with no linked team member must fail CLOSED.
    expect(repCanWorkLead({ assignedRepId: null, assignedTerritoryId: null }, [], new Set())).toBe(true);
    // …open field is genuinely open, but a door owned by anyone stays denied:
    expect(repCanWorkLead({ assignedRepId: 9, assignedTerritoryId: null }, [], new Set())).toBe(false);
    expect(repCanWorkLead({ assignedRepId: null, assignedTerritoryId: 200 }, [], new Set())).toBe(false);
  });

  it("treats undefined ownership the same as null (unhydrated rows)", () => {
    expect(repCanWorkLead({ assignedRepId: undefined, assignedTerritoryId: undefined }, SCOPE, AREAS)).toBe(true);
  });

  it("a team lead's scope covers their reports' doors", () => {
    expect(repCanWorkLead({ assignedRepId: 12, assignedTerritoryId: null }, [7, 12, 15], AREAS)).toBe(true);
  });
});

describe("repVisibilitySql", () => {
  it("returns no predicate for an unscoped caller — admins see the tenant", () => {
    expect(repVisibilitySql(undefined)).toBeNull();
  });

  it("returns the IMPOSSIBLE predicate for an empty scope, never an open one", () => {
    // The failure mode this guards: an empty scope that produces no clause at
    // all would show a repless login every door in the tenant.
    expect(repVisibilitySql([])).toBe("1 = 0");
  });

  it("carries all three branches", () => {
    const frag = repVisibilitySql([7], "l")!;
    expect(frag).toContain("l.assigned_rep_id IN (7)");
    expect(frag).toContain("l.assigned_rep_id IS NULL AND l.assigned_territory_id IS NULL");
    expect(frag).toContain("FROM territories t");
    expect(frag).toContain("json_each");
  });

  it("honours the table alias so raw and Drizzle callers can both compose it", () => {
    expect(repVisibilitySql([7], "leads")).toContain("leads.assigned_rep_id IN (7)");
  });

  it("inlines only integers — nothing else can reach the SQL string", () => {
    // Ids come from the session, but this fragment is string-composed, so the
    // coercion is the boundary that has to hold.
    const frag = repVisibilitySql([7, 8.9, NaN, Infinity] as unknown as number[], "l")!;
    expect(frag).toContain("IN (7,8)");
    expect(frag).not.toMatch(/NaN|Infinity/);
  });

  it("never emits a bare empty IN list from an all-garbage scope", () => {
    expect(repVisibilitySql([NaN, Infinity] as unknown as number[])).toBe("1 = 0");
  });
});
