// Narrowing the area list — the screen a manager uses to find one territory
// among hundreds.
//
// This file exists because list filtering is where two already-settled rules go
// to be quietly re-broken:
//
//   • "who holds this area" — territories.repId still names the LAST holder after
//     a reclaim, so a `t.repId === repId` filter hands the area back to the rep it
//     was taken from. That exact mistake leaked twice before the rule was
//     consolidated into territoryHeldByAny; a filter is just another surface that
//     can get it wrong, so the leak is pinned here as its own test.
//
//   • "what counts as a search hit" — the rep picker matches on WORD STARTS.
//     Two search behaviours in one product is a bug, so the negative case
//     ("iver" must not find "Rivera") is asserted, not assumed.
//
// The sort tests exist for a different reason: Array.sort stability is a promise
// about elements the ENGINE considers equal, not about rows that happen to share
// a name. A comparator that returns 0 on a tie makes the list reorder itself when
// the same rows arrive from a different endpoint in a different order, which
// reads as data loss. So the comparators are asserted to be TOTAL — same rows,
// same order, whatever order they came in.
import { describe, expect, it } from "vitest";
import {
  filterTerritories,
  matchesQuery,
  sortTerritories,
  type TerritoryFilterContext,
  type TerritoryListItem,
} from "../../shared/territoryFilter";

const CTX: TerritoryFilterContext = {
  repNameById: { 3: "Ann Rivera", 7: "Marcus Webb", 9: "Dana Cole" },
};

/** Rows in the shapes the DB actually produces: assignee_ids as JSON TEXT, an
 *  emptied list after a reclaim, and one legacy row where the column was never
 *  written at all. */
function rows(): TerritoryListItem[] {
  return [
    {
      // Ann's live area.
      id: 1, name: "Maple Ridge", status: "active",
      repId: 3, assigneeIds: "[3]",
      lastActivityAt: "2026-07-20T10:00:00Z", doorCount: 80, knockedCount: 40,
    },
    {
      // Shared: Ann is primary, Marcus is the second holder.
      id: 2, name: "Oakwood Commons", status: "shared",
      repId: 3, assigneeIds: "[3,7]",
      lastActivityAt: "2026-07-10T10:00:00Z", doorCount: 120, knockedCount: 30,
    },
    {
      // RECLAIMED FROM ANN. The holder list was emptied; repId was left alone.
      id: 3, name: "Cedar Hollow", status: "reclaimed",
      repId: 3, assigneeIds: "[]",
      lastActivityAt: "2026-06-01T10:00:00Z", doorCount: 50, knockedCount: 50,
    },
    {
      // In the pool, never worked — no lastActivityAt, no doors counted yet.
      id: 4, name: "Birchwood Park", status: "unassigned",
      repId: 9, assigneeIds: "[]",
      lastActivityAt: null, doorCount: 0, knockedCount: 0,
    },
    {
      // Legacy row: assignee_ids predates the column, so repId is the only answer.
      id: 5, name: "Riverbend South", status: "completed",
      repId: 7, assigneeIds: null,
      lastActivityAt: "2026-07-25T10:00:00Z", doorCount: 10, knockedCount: 1,
    },
  ];
}

const ids = (list: readonly TerritoryListItem[]) => list.map((t) => t.id);
const all = (f: Parameters<typeof filterTerritories>[1]) => filterTerritories(rows(), f, CTX);

describe("matchesQuery matches on word starts, the way the rep picker does", () => {
  it("finds a surname by its first letters", () => {
    expect(matchesQuery("Ann Rivera", "riv")).toBe(true);
  });

  it("finds a second word of an area name", () => {
    expect(matchesQuery("Maple Ridge", "map")).toBe(true);
    expect(matchesQuery("Maple Ridge", "ridge")).toBe(true);
  });

  it("does NOT match the middle of a word", () => {
    // The whole point of word-start. A substring implementation passes this
    // string ("Rivera".includes("iver")) and would drag half the list into every
    // three-letter search.
    expect(matchesQuery("Ann Rivera", "iver")).toBe(false);
    expect(matchesQuery("Maple Ridge", "aple")).toBe(false);
    expect(matchesQuery("Oakwood Commons", "wood")).toBe(false);
  });

  it("requires EVERY term to hit some word", () => {
    expect(matchesQuery("Ann Rivera", "ann riv")).toBe(true);
    expect(matchesQuery("Ann Rivera", "ann zzz")).toBe(false);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(matchesQuery("Ann Rivera", "  ANN  ")).toBe(true);
  });

  it("treats a blank query as no filter at all", () => {
    // An empty search box must not empty the screen.
    expect(matchesQuery("Maple Ridge", "")).toBe(true);
    expect(matchesQuery("Maple Ridge", "   ")).toBe(true);
    expect(matchesQuery(null, "")).toBe(true);
  });

  it("says no when there is no text to match against", () => {
    expect(matchesQuery(null, "map")).toBe(false);
    expect(matchesQuery("", "map")).toBe(false);
  });
});

describe("query searches area names and the names of reps who HOLD the area", () => {
  it("finds an area by a word start in its name", () => {
    expect(ids(all({ query: "map" }))).toEqual([1]);
  });

  it("finds an area by the name of a rep who holds it", () => {
    // Ann holds 1 and 2. Cedar Hollow (3) was taken from her — see below.
    expect(ids(all({ query: "rivera" }))).toEqual([1, 2]);
  });

  it("finds an area by a NON-primary holder's name", () => {
    // Marcus is only the second entry in assignee_ids on area 2, and the sole
    // legacy-row holder on area 5. A repId-keyed search would miss area 2.
    expect(ids(all({ query: "marcus" }))).toEqual([2, 5]);
  });

  it("does not find an area by the middle of a rep's name", () => {
    expect(ids(all({ query: "iver" }))).toEqual([]);
  });

  it("does not invent names for reps the context does not know", () => {
    expect(ids(all({ query: "unknownrep" }))).toEqual([]);
  });

  it("returns everything for a blank query", () => {
    expect(ids(all({ query: "   " }))).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("rep filtering asks territoryHeldByAny, never repId", () => {
  it("does NOT return an area reclaimed from the rep, though repId still names them", () => {
    // SECURITY-FLAVOURED. Area 3 is the exact shape a row has right after a
    // reclaim: assignee_ids emptied to "[]", repId left at 3 for colour/history.
    // A `t.repId === 3` filter returns it, and the rep it was taken from goes on
    // seeing (and on a scoped screen, working) ground that is no longer theirs.
    const held = filterTerritories(rows(), { repIds: [3] }, CTX);
    expect(ids(held)).toEqual([1, 2]);
    expect(ids(held)).not.toContain(3);
  });

  it("does not surface a reclaimed area through the old holder's NAME either", () => {
    // Same leak, other door: search is a filter too.
    expect(ids(all({ query: "ann" }))).not.toContain(3);
  });

  it("returns a shared area to its non-primary holder", () => {
    expect(ids(all({ repIds: [7] }))).toEqual([2, 5]);
  });

  it("treats an EMPTY assignee list as an answer meaning nobody holds it", () => {
    // "[]" is not missing data. Areas 3 and 4 both have an empty list, so no rep
    // filter — not even one naming their repId — may return them.
    const anyRep = filterTerritories(rows(), { repIds: [3, 7, 9] }, CTX);
    expect(ids(anyRep)).not.toContain(3);
    expect(ids(anyRep)).not.toContain(4);
    expect(ids(all({ repIds: [9] }))).toEqual([]);
  });

  it("still honours repId for a LEGACY row whose column was never written", () => {
    // Area 5 has assigneeIds null — genuinely absent, the one case that falls back.
    expect(ids(all({ repIds: [7] }))).toContain(5);
  });

  it("treats an omitted or empty rep list as 'no rep filter', not 'nobody'", () => {
    expect(ids(all({}))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(all({ repIds: [] }))).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("status filtering", () => {
  it("keeps only the chosen statuses", () => {
    expect(ids(all({ status: ["active"] }))).toEqual([1]);
    expect(ids(all({ status: ["shared", "reclaimed"] }))).toEqual([2, 3]);
  });

  it("treats an omitted or empty status set as ALL statuses", () => {
    // Including statuses that are not offered as chips — an unused filter must
    // never silently drop draft/archived rows off the screen.
    expect(ids(all({ status: [] }))).toEqual([1, 2, 3, 4, 5]);
    const withDraft = filterTerritories(
      [...rows(), { id: 6, name: "Draft Area", status: "draft" }],
      {},
      CTX,
    );
    expect(ids(withDraft)).toContain(6);
  });
});

describe("activity date bounds", () => {
  it("treats activeSince as INCLUSIVE and activeBefore as EXCLUSIVE", () => {
    // Area 2 is stamped exactly 2026-07-10T10:00:00Z: it is in for a since-bound
    // on that instant and out for a before-bound on it. Documented so callers can
    // page [since, before) windows without double-counting a row.
    expect(ids(all({ activeSince: "2026-07-10T10:00:00Z" }))).toEqual([1, 2, 5]);
    expect(ids(all({ activeBefore: "2026-07-10T10:00:00Z" }))).toEqual([3]);
  });

  it("windows on both bounds at once", () => {
    expect(ids(all({ activeSince: "2026-07-01", activeBefore: "2026-07-21" }))).toEqual([1, 2]);
  });

  it("EXCLUDES rows with no recorded activity whenever a bound is set", () => {
    // Documented choice: an area nobody has ever worked cannot satisfy "active
    // since Monday". Area 4 has lastActivityAt null and must never appear in a
    // windowed list, whichever bound is set.
    expect(ids(all({ activeSince: "2000-01-01" }))).not.toContain(4);
    expect(ids(all({ activeBefore: "2099-01-01" }))).not.toContain(4);
  });

  it("includes rows with no recorded activity when NO bound is set", () => {
    expect(ids(all({}))).toContain(4);
  });

  it("ignores a bound that is not a usable date instead of blanking the list", () => {
    // This runs on every keystroke behind a date input; a half-typed value must
    // not empty the screen or throw. Note what "unusable" means: Date.parse is
    // lenient enough that "2026-07-" IS a real instant, so only genuinely
    // unparseable text falls back to "no bound".
    expect(ids(all({ activeSince: "2026-07-xx" }))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(all({ activeBefore: "2026-13-40" }))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(all({ activeSince: "" }))).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not let an unparseable lastActivityAt sneak past a lower bound", () => {
    // Garbage must not be read as epoch 0 (which would pass every before-bound)
    // nor as "now"; it is absent, and absent rows are out of a window.
    const odd = filterTerritories(
      [{ id: 9, name: "Odd", status: "active", assigneeIds: "[3]", lastActivityAt: "not a date" }],
      { activeSince: "2000-01-01" },
      CTX,
    );
    expect(ids(odd)).toEqual([]);
  });
});

describe("filters INTERSECT - each one narrows the list, never widens it", () => {
  it("requires query AND status AND rep together", () => {
    // Ann holds 1 (active) and 2 (shared). Adding a status chip must cut, not add.
    expect(ids(all({ query: "rivera", repIds: [3] }))).toEqual([1, 2]);
    expect(ids(all({ query: "rivera", repIds: [3], status: ["shared"] }))).toEqual([2]);
  });

  it("returns nothing when the clauses cannot all be satisfied", () => {
    // A union implementation returns rows here — "Maple Ridge" matches the query
    // and area 2 matches the rep — so an empty result is the assertion that
    // matters.
    expect(ids(all({ query: "map", repIds: [7] }))).toEqual([]);
    expect(ids(all({ query: "map", status: ["completed"] }))).toEqual([]);
  });

  it("intersects a date window with the other clauses", () => {
    expect(ids(all({ repIds: [3], activeSince: "2026-07-15" }))).toEqual([1]);
  });
});

describe("filterTerritories never mutates its input", () => {
  it("returns a new array and leaves the original list and rows untouched", () => {
    const input = rows();
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = filterTerritories(input, { query: "map", repIds: [3], status: ["active"] }, CTX);
    expect(out).not.toBe(input);
    expect(input).toEqual(snapshot);
    expect(input).toHaveLength(5);
  });
});

describe("sortTerritories orders by the chosen key", () => {
  it("sorts by name A→Z", () => {
    expect(ids(sortTerritories(rows(), "name"))).toEqual([4, 3, 1, 2, 5]);
  });

  it("sorts by most recent activity first, with never-worked areas last", () => {
    expect(ids(sortTerritories(rows(), "recent"))).toEqual([5, 1, 2, 3, 4]);
  });

  it("sorts by door count, biggest first", () => {
    expect(ids(sortTerritories(rows(), "doors"))).toEqual([2, 1, 3, 5, 4]);
  });

  it("sorts by progress, furthest along first, with door-less areas last", () => {
    // 3: 50/50 = 100%, 1: 40/80 = 50%, 2: 30/120 = 25%, 5: 1/10 = 10%,
    // 4: no doors → no answer → last.
    expect(ids(sortTerritories(rows(), "progress"))).toEqual([3, 1, 2, 5, 4]);
  });

  it("puts unnamed rows last rather than at the top under an empty string", () => {
    const list: TerritoryListItem[] = [
      { id: 1, name: null },
      { id: 2, name: "Alder" },
    ];
    expect(ids(sortTerritories(list, "name"))).toEqual([2, 1]);
  });
});

describe("sort comparators are TOTAL - equal primary keys still order the same way", () => {
  // Every case here feeds the SAME rows in two different input orders and demands
  // the same output. A comparator that returns 0 on a tie passes the first
  // assertion and fails the second, because Array.sort would just preserve
  // whatever order it was handed.
  const bothOrders = (list: TerritoryListItem[], sort: Parameters<typeof sortTerritories>[1]) => [
    ids(sortTerritories(list, sort)),
    ids(sortTerritories([...list].reverse(), sort)),
  ];

  it("breaks a name tie by id", () => {
    const list: TerritoryListItem[] = [
      { id: 8, name: "Maple Ridge" },
      { id: 2, name: "Maple Ridge" },
      { id: 5, name: "Maple Ridge" },
    ];
    expect(bothOrders(list, "name")).toEqual([[2, 5, 8], [2, 5, 8]]);
  });

  it("breaks a recency tie by id", () => {
    const at = "2026-07-20T10:00:00Z";
    const list: TerritoryListItem[] = [
      { id: 8, name: "A", lastActivityAt: at },
      { id: 2, name: "B", lastActivityAt: at },
    ];
    expect(bothOrders(list, "recent")).toEqual([[2, 8], [2, 8]]);
  });

  it("breaks a door-count tie by id", () => {
    const list: TerritoryListItem[] = [
      { id: 8, name: "A", doorCount: 40 },
      { id: 2, name: "B", doorCount: 40 },
    ];
    expect(bothOrders(list, "doors")).toEqual([[2, 8], [2, 8]]);
  });

  it("breaks a progress tie by id, including between two areas with NO progress", () => {
    // Both "no answer" rows compare equal on the primary key; without the id
    // tiebreak their order is whatever the caller happened to pass in.
    const list: TerritoryListItem[] = [
      { id: 8, name: "A", doorCount: 0, knockedCount: 0 },
      { id: 2, name: "B", doorCount: null, knockedCount: null },
      { id: 5, name: "C", doorCount: 10, knockedCount: 5 },
    ];
    expect(bothOrders(list, "progress")).toEqual([[5, 2, 8], [5, 2, 8]]);
  });

  it("orders identical rows deterministically regardless of arrival order", () => {
    // The real-world shape: the same page fetched from two endpoints that ORDER
    // BY differently must render the same list.
    const a: TerritoryListItem = { id: 4, name: "Same", doorCount: 10, lastActivityAt: "2026-07-01T00:00:00Z" };
    const b: TerritoryListItem = { id: 1, name: "Same", doorCount: 10, lastActivityAt: "2026-07-01T00:00:00Z" };
    for (const key of ["name", "recent", "doors", "progress"] as const) {
      expect(bothOrders([a, b], key)).toEqual([[1, 4], [1, 4]]);
    }
  });
});

describe("sortTerritories never mutates its input", () => {
  it("returns a new array and leaves the caller's order alone", () => {
    const input = rows();
    const before = ids(input);
    const out = sortTerritories(input, "progress");
    expect(out).not.toBe(input);
    expect(ids(input)).toEqual(before);
  });
});
