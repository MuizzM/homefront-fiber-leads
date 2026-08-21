import { describe, expect, it } from "vitest";
import { titleCaseAddress } from "../../client/src/lib/leadDisplay";

// Display-layer casing for county-GIS shout-case imports. The invariant that
// matters most: anything NOT fully shouted passes through byte-identical, so
// hand-entered addresses can never be mangled.
describe("titleCaseAddress", () => {
  it("cases a shouted GIS address the way a person would write it", () => {
    expect(titleCaseAddress("1032 CORNELL STREET, UNIT B")).toBe("1032 Cornell Street, Unit B");
    expect(titleCaseAddress("2210 GUESS RD")).toBe("2210 Guess Rd");
    expect(titleCaseAddress("DURHAM")).toBe("Durham");
  });

  it("keeps directionals and unit letters uppercase", () => {
    expect(titleCaseAddress("1012 E OAK DR")).toBe("1012 E Oak Dr");
    expect(titleCaseAddress("400 NW BROAD ST")).toBe("400 NW Broad St");
    expect(titleCaseAddress("US HIGHWAY 64")).toBe("US Highway 64");
  });

  it("lowers ordinal suffixes but leaves other digit-led tokens alone", () => {
    expect(titleCaseAddress("119 5TH AVE")).toBe("119 5th Ave");
    expect(titleCaseAddress("123B MAIN ST")).toBe("123B Main St");
    expect(titleCaseAddress("27707")).toBe("27707");
  });

  it("cases each side of hyphens and slashes", () => {
    expect(titleCaseAddress("WINSTON-SALEM")).toBe("Winston-Salem");
    expect(titleCaseAddress("1/2 KENT ST")).toBe("1/2 Kent St");
  });

  it("never touches text that is not fully shouted", () => {
    expect(titleCaseAddress("106 Verify St")).toBe("106 Verify St");
    expect(titleCaseAddress("McDonald Ct")).toBe("McDonald Ct");
    expect(titleCaseAddress("van der Berg Way")).toBe("van der Berg Way");
  });

  it("handles empty and null input", () => {
    expect(titleCaseAddress("")).toBe("");
    expect(titleCaseAddress(null)).toBe("");
    expect(titleCaseAddress(undefined)).toBe("");
  });
});
