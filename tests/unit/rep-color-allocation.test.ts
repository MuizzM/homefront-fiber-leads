// Rep colours are ASSIGNED AT CREATION and persisted (team_members.color);
// everything that paints a person resolves through repColorOf. These tests pin
// the two pure pieces: the palette allocator (first free hue per tenant) and
// the resolver's fallback chain (persisted ?? legacy repId-hash ?? slate).
import { describe, expect, it } from "vitest";
import {
  REP_PALETTE, allocateRepColor, colorForRep, repColorOf,
} from "../../shared/repColors";

describe("allocateRepColor", () => {
  it("hands out the first palette hue when nothing is worn", () => {
    expect(allocateRepColor([])).toBe(REP_PALETTE[0]);
  });

  it("skips hues already worn by active members", () => {
    expect(allocateRepColor([REP_PALETTE[0], REP_PALETTE[1]])).toBe(REP_PALETTE[2]);
    // Order of the used list is irrelevant — only membership counts.
    expect(allocateRepColor([REP_PALETTE[2], REP_PALETTE[0]])).toBe(REP_PALETTE[1]);
  });

  it("treats a legacy member's HASH hue as taken (case-insensitively)", () => {
    // A pre-column row has color NULL but effectively wears colorForRep(id);
    // the caller feeds effective colours in, and casing must not fool the set.
    const legacyHue = colorForRep(1); // REP_PALETTE[1]
    expect(legacyHue).toBe(REP_PALETTE[1]);
    expect(allocateRepColor([REP_PALETTE[0], legacyHue.toLowerCase()]))
      .toBe(REP_PALETTE[2]);
  });

  it("never duplicates across sequential allocations until the palette is spent", () => {
    const used: string[] = [];
    for (let i = 0; i < REP_PALETTE.length; i++) {
      const next = allocateRepColor(used);
      expect(next).not.toBeNull();
      expect(used).not.toContain(next!);
      used.push(next!);
    }
    expect(new Set(used).size).toBe(REP_PALETTE.length);
  });

  it("returns null once all 24 hues are worn - the store-NULL / hash-fallback signal", () => {
    expect(allocateRepColor(REP_PALETTE)).toBeNull();
  });

  it("ignores null/undefined entries (members with no colour don't block a hue)", () => {
    expect(allocateRepColor([null, undefined, ""])).toBe(REP_PALETTE[0]);
  });
});

describe("repColorOf", () => {
  it("prefers the persisted colour over the hash", () => {
    expect(repColorOf({ id: 1, color: "#123456" })).toBe("#123456");
    expect(repColorOf({ id: 1, color: "#123456" })).not.toBe(colorForRep(1));
  });

  it("falls back to the legacy hash for a NULL column (pre-migration rows)", () => {
    expect(repColorOf({ id: 7, color: null })).toBe(colorForRep(7));
    expect(repColorOf({ id: 7 })).toBe(colorForRep(7));
  });

  it("degrades to the unassigned slate for no member at all", () => {
    expect(repColorOf(null)).toBe(colorForRep(null));
    expect(repColorOf(undefined)).toBe("#94a3b8");
    expect(repColorOf({ id: null })).toBe("#94a3b8");
  });
});
