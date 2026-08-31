// ── Roster search: the one semantic every people list shares ─────────────────
// The contract under test: word-start matching with a substring fallback, an
// honest render cap, and recents that reorder ONLY the case they are for
// (long list, empty query - handled by the callers). These helpers back every
// picker in the app; a drift here changes how a manager finds any rep anywhere.
import { describe, expect, it } from "vitest";
import {
  matchPerson,
  withRecentsFirst,
  ROSTER_SEARCH_THRESHOLD,
  ROSTER_MAX_ROWS,
} from "../../client/src/lib/rosterSearch";

describe("matchPerson", () => {
  it("matches any word start - first or last name", () => {
    expect(matchPerson("Ann Rivera", "riv")).toBe(true);
    expect(matchPerson("Ann Rivera", "ann")).toBe(true);
  });

  it("falls back to substring, so a mid-name fragment still finds them", () => {
    expect(matchPerson("Ann Rivera", "iver")).toBe(true);
  });

  it("every term must match - 'an riv' finds Ann Rivera, 'an bo' does not", () => {
    expect(matchPerson("Ann Rivera", "an riv")).toBe(true);
    expect(matchPerson("Ann Rivera", "an bo")).toBe(false);
  });

  it("an empty or whitespace query matches everyone", () => {
    expect(matchPerson("Ann Rivera", "")).toBe(true);
    expect(matchPerson("Ann Rivera", "   ")).toBe(true);
  });

  it("is case-insensitive both ways", () => {
    expect(matchPerson("ANN RIVERA", "riv")).toBe(true);
    expect(matchPerson("ann rivera", "RIV")).toBe(true);
  });
});

describe("withRecentsFirst", () => {
  const list = [1, 2, 3, 4, 5].map((id) => ({ id, name: `Rep ${id}` }));

  it("floats recents to the front in recency order, rest order preserved", () => {
    expect(withRecentsFirst(list, [4, 2]).map((r) => r.id)).toEqual([4, 2, 1, 3, 5]);
  });

  it("ignores recent ids that are no longer in the list (deactivated reps)", () => {
    expect(withRecentsFirst(list, [99, 3]).map((r) => r.id)).toEqual([3, 1, 2, 4, 5]);
  });

  it("no recents means the list is untouched - same identity, no churn", () => {
    expect(withRecentsFirst(list, [])).toBe(list);
  });
});

describe("the scale constants", () => {
  it("search appears before a list becomes unscannable, cap is one flick of scroll", () => {
    // Not arbitrary pins: the threshold must stay below the point where
    // scanning beats typing (~10 rows), and the cap must stay small enough
    // that a phone renders it without jank yet large enough that a full
    // mid-size crew never sees the truncation note.
    expect(ROSTER_SEARCH_THRESHOLD).toBeLessThanOrEqual(10);
    expect(ROSTER_MAX_ROWS).toBeGreaterThanOrEqual(40);
    expect(ROSTER_MAX_ROWS).toBeLessThanOrEqual(100);
  });
});
