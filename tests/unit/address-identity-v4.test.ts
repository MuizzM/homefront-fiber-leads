import { describe, expect, it } from "vitest";
import {
  canonicalAddressPart, normalizeKineticAddressKey, kineticLeadKeyOrNull,
  normalizeZip5, splitDisplayAddress, premiseBaseKey, addressIdentityIssues,
  NORMALIZATION_VERSION,
} from "../../shared/addressKey";

// v4 canonical premise identity: unit unification, ZIP+4 folding (display),
// decomposition for the pin card, and the shared ADDRESS_REVIEW validation.

describe("v4 unit unification", () => {
  it("APT / UNIT / STE / # are ONE premise-unit identity", () => {
    const variants = [
      "123 Main St Apt 4", "123 Main Street Unit 4", "123 MAIN ST STE 4",
      "123 Main St #4", "123 Main St # 4", "123 Main St Apartment 4",
    ];
    const keys = new Set(variants.map((a) => normalizeKineticAddressKey(a, "Concord", "NC", "")));
    expect(keys.size).toBe(1);
  });

  it("units remain DISTINCT records: no-unit, Unit 4, Unit 5 are three identities", () => {
    const keys = new Set([
      normalizeKineticAddressKey("123 Main St", "Concord", "NC", ""),
      normalizeKineticAddressKey("123 Main St Unit 4", "Concord", "NC", ""),
      normalizeKineticAddressKey("123 Main St Unit 5", "Concord", "NC", ""),
    ]);
    expect(keys.size).toBe(3);
  });

  it("suffix + directional aliases still fold (v3 behavior preserved)", () => {
    expect(normalizeKineticAddressKey("106 Poplar Tr", "Concord", "NC", ""))
      .toBe(normalizeKineticAddressKey("106 Poplar Trail", "Concord", "NC", ""));
    expect(normalizeKineticAddressKey("10 North Main Street", "Concord", "NC", ""))
      .toBe(normalizeKineticAddressKey("10 N Main St", "Concord", "NC", ""));
    // Directional ORDER preserved — corner-lot pairs never merge.
    expect(normalizeKineticAddressKey("10 N Main St", "Concord", "NC", ""))
      .not.toBe(normalizeKineticAddressKey("10 Main St N", "Concord", "NC", ""));
  });

  it("blank-vs-populated ZIP never splits identity (v3) and version is 4", () => {
    expect(normalizeKineticAddressKey("485 Brown Acres Rd", "Salisbury", "NC", ""))
      .toBe(normalizeKineticAddressKey("485 Brown Acres Rd", "Salisbury", "NC", "28146"));
    expect(NORMALIZATION_VERSION).toBe(4);
  });

  it("keyless addresses stay null (never false-merge two blanks)", () => {
    expect(kineticLeadKeyOrNull("", "Concord", "NC", "")).toBeNull();
    expect(kineticLeadKeyOrNull("   ", "Concord", "NC", "")).toBeNull();
  });
});

describe("normalizeZip5", () => {
  it("folds ZIP+4 and garbage to five digits or empty", () => {
    expect(normalizeZip5("28146-1234")).toBe("28146");
    expect(normalizeZip5("28146")).toBe("28146");
    expect(normalizeZip5(" 28146 ")).toBe("28146");
    expect(normalizeZip5("n/a")).toBe("");
    expect(normalizeZip5(null)).toBe("");
  });
});

describe("splitDisplayAddress (card decomposition — presentational only)", () => {
  it("splits house number, street, and unit", () => {
    expect(splitDisplayAddress("485 Brown Acres Rd")).toEqual({ houseNumber: "485", street: "Brown Acres Rd", unit: "" });
    expect(splitDisplayAddress("123 Main St Apt 4")).toEqual({ houseNumber: "123", street: "Main St", unit: "Apt 4" });
    expect(splitDisplayAddress("123 Main St #4")).toEqual({ houseNumber: "123", street: "Main St", unit: "#4" });
    expect(splitDisplayAddress("12B Oak Cir")).toEqual({ houseNumber: "12B", street: "Oak Cir", unit: "" });
  });
  it("degrades without a house number", () => {
    expect(splitDisplayAddress("Old Mill Road")).toEqual({ houseNumber: "", street: "Old Mill Road", unit: "" });
    expect(splitDisplayAddress("")).toEqual({ houseNumber: "", street: "", unit: "" });
  });
});

describe("premiseBaseKey (building-level cluster identity)", () => {
  it("unit records share the building base key", () => {
    const a = premiseBaseKey("123 Main St Apt 4", "Concord", "NC");
    const b = premiseBaseKey("123 Main St Unit 9", "Concord", "NC");
    const c = premiseBaseKey("123 Main St", "Concord", "NC");
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
});

describe("addressIdentityIssues (ADDRESS_REVIEW validation)", () => {
  const good = { address: "485 Brown Acres Rd", city: "Salisbury", state: "NC", lat: 35.62, lng: -80.42 };
  it("a complete verified address has no issues", () => {
    expect(addressIdentityIssues(good)).toEqual([]);
  });
  it("flags missing house number", () => {
    expect(addressIdentityIssues({ ...good, address: "Brown Acres Rd" })).toContain("missing house number");
  });
  it("flags blank street / city / state", () => {
    expect(addressIdentityIssues({ ...good, address: " " })).toContain("missing street address");
    expect(addressIdentityIssues({ ...good, city: "" })).toContain("missing city");
    expect(addressIdentityIssues({ ...good, state: null })).toContain("missing state");
  });
  it("flags missing and invalid coordinates (incl. null island)", () => {
    expect(addressIdentityIssues({ ...good, lat: null, lng: null })).toContain("missing coordinates");
    expect(addressIdentityIssues({ ...good, lat: 135.5, lng: -80.4 })).toContain("invalid coordinates");
    expect(addressIdentityIssues({ ...good, lat: 0, lng: 0 })).toContain("invalid coordinates");
  });
});
