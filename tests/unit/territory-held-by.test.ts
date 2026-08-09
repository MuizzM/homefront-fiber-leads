// "Does this rep work this area?" — the rule three surfaces disagreed on.
//
// Areas are many-to-many (assignee_ids). territories.repId is only the PRIMARY
// marker, kept for colour and history, and it deliberately still names the last
// holder after everyone has been removed. That single fact is what made three
// separate copies of this rule leak in two different ways:
//
//   • checking repId ONLY   → the 2nd/3rd rep on a shared area saw nothing
//   • checking repId FIRST  → a rep kept access to an area reclaimed from them
//
// Both are visibility failures on ground somebody is or isn't allowed to work,
// so the rule gets its own file rather than living implicitly inside whichever
// endpoint happens to call it.
import { describe, expect, it } from "vitest";
import { parseAssigneeIds, territoryHeldByAny } from "../../shared/territory";

describe("parseAssigneeIds", () => {
  it("reads the JSON text the column actually stores", () => {
    expect(parseAssigneeIds("[3,7]")).toEqual([3, 7]);
  });

  it("passes an already-parsed array straight through", () => {
    // Client-side callers hold real arrays; server-side ones hold TEXT.
    expect(parseAssigneeIds([3, 7])).toEqual([3, 7]);
  });

  it("reports an EMPTY list as a list, not as absence", () => {
    // The distinction the whole rule turns on: "[]" means nobody holds this,
    // which is a real answer. null means the column was never written, which is
    // the only case allowed to fall back to repId.
    expect(parseAssigneeIds("[]")).toEqual([]);
    expect(parseAssigneeIds("[]")).not.toBeNull();
  });

  it("treats an unwritten or unreadable column as absent", () => {
    for (const v of [null, undefined, "", "   ", "not json", "{}", '"7"', "7"]) {
      expect(parseAssigneeIds(v)).toBeNull();
    }
  });

  it("drops non-numeric ids rather than trusting them into a comparison", () => {
    expect(parseAssigneeIds('[3,"7",null,9]')).toEqual([3, 9]);
  });
});

describe("territoryHeldByAny", () => {
  it("says yes to the primary holder", () => {
    expect(territoryHeldByAny({ repId: 3, assigneeIds: "[3]" }, [3])).toBe(true);
  });

  it("says yes to a rep who shares the area but is NOT primary", () => {
    // The first leak: repId names only rep 3, so rep 7 was invisible to every
    // surface that keyed on it — including their own area's progress card.
    expect(territoryHeldByAny({ repId: 3, assigneeIds: "[3,7]" }, [7])).toBe(true);
  });

  it("says NO once the rep has been removed, even though repId still names them", () => {
    // The second leak, and the more serious one. This is the shape a row has
    // right after a reclaim: the holder list is emptied, repId is left alone.
    expect(territoryHeldByAny({ repId: 3, assigneeIds: "[]" }, [3])).toBe(false);
  });

  it("says NO when the area was handed to someone else entirely", () => {
    expect(territoryHeldByAny({ repId: 3, assigneeIds: "[9]" }, [3])).toBe(false);
  });

  it("falls back to repId ONLY for a legacy row with no list at all", () => {
    expect(territoryHeldByAny({ repId: 3, assigneeIds: null }, [3])).toBe(true);
    expect(territoryHeldByAny({ repId: 3 }, [3])).toBe(true);
    expect(territoryHeldByAny({ repId: 9, assigneeIds: null }, [3])).toBe(false);
  });

  it("matches when ANY id in the scope holds it - a team lead's whole roster", () => {
    // leadVisibilityScope hands in [self, ...reports], so one hit is enough.
    expect(territoryHeldByAny({ repId: 3, assigneeIds: "[3]" }, [11, 12, 3])).toBe(true);
    expect(territoryHeldByAny({ repId: 3, assigneeIds: "[3]" }, [11, 12])).toBe(false);
  });

  it("says no to an empty scope instead of matching everything", () => {
    // A rep with no teamMemberId must fail CLOSED. An [].some() would already
    // return false, but an early return makes that a decision rather than luck.
    expect(territoryHeldByAny({ repId: 3, assigneeIds: "[3]" }, [])).toBe(false);
    expect(territoryHeldByAny({ repId: null, assigneeIds: null }, [])).toBe(false);
  });

  it("says no when nobody owns the row at all", () => {
    expect(territoryHeldByAny({ repId: null, assigneeIds: null }, [3])).toBe(false);
    expect(territoryHeldByAny({ repId: null, assigneeIds: "[]" }, [3])).toBe(false);
  });

  it("does not let a corrupt list silently promote repId into an answer", () => {
    // Unparseable → legacy → repId. Documented, and worth pinning: the
    // alternative (deny everything) would black out a tenant on one bad row.
    expect(territoryHeldByAny({ repId: 3, assigneeIds: "[[[" }, [3])).toBe(true);
  });
});
