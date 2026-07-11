import { describe, it, expect } from "vitest";
import { parseStreetAddress, neighborNumbers, fringeCandidates, normAddr } from "../../shared/fringe";

// Fringe expansion is the completeness moat: one NEW FIBER seed must flood-fill the
// rest of a subdivision OSM never listed, WITHOUT wandering off-street or re-probing.
// Pure generation, so pinned exactly.

describe("parseStreetAddress", () => {
  it("splits a leading house number from the street", () => {
    expect(parseStreetAddress("160 Bald Eagle Dr")).toEqual({ number: 160, street: "Bald Eagle Dr" });
    expect(parseStreetAddress("  12   Main  St ")).toEqual({ number: 12, street: "Main St" });
  });
  it("returns null for anything without a leading house number", () => {
    expect(parseStreetAddress("PO Box 5")).toBeNull();
    expect(parseStreetAddress("Rural Route 2")).toBeNull();
    expect(parseStreetAddress("Bald Eagle Dr")).toBeNull();
    expect(parseStreetAddress("0 Nowhere St")).toBeNull();
    expect(parseStreetAddress("")).toBeNull();
  });
});

describe("neighborNumbers", () => {
  it("radiates outward, nearest-first, both sides of the street", () => {
    expect(neighborNumbers(160, 3)).toEqual([161, 159, 162, 158, 163, 157]);
  });
  it("never emits zero or negative house numbers near the low end", () => {
    expect(neighborNumbers(2, 3)).toEqual([3, 1, 4, 5]); // 0 and -1 skipped
    expect(neighborNumbers(1, 2)).toEqual([2, 3]);        // 0 and -1 skipped
  });
});

describe("fringeCandidates", () => {
  it("builds neighbor addresses on the SAME street, nearest-first", () => {
    expect(fringeCandidates("160 Bald Eagle Dr", 2).map(c => c.address))
      .toEqual(["161 Bald Eagle Dr", "159 Bald Eagle Dr", "162 Bald Eagle Dr", "158 Bald Eagle Dr"]);
  });
  it("filters out already-seen addresses (case/space-insensitive)", () => {
    const seen = new Set(["159 bald eagle dr", normAddr("162  BALD EAGLE DR")]);
    expect(fringeCandidates("160 Bald Eagle Dr", 2, seen).map(c => c.address))
      .toEqual(["161 Bald Eagle Dr", "158 Bald Eagle Dr"]);
  });
  it("returns nothing for an unparseable seed (never wanders off a real street)", () => {
    expect(fringeCandidates("PO Box 9", 5)).toEqual([]);
  });
});
