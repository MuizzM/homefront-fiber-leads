import { describe, expect, it } from "vitest";
import {
  canonicalAddressPart, normalizeKineticAddressKey, kineticLeadKeyOrNull,
  normalizeZip5, splitDisplayAddress, premiseBaseKey, addressIdentityIssues,
  addressIdentityOf, streetKeyOf, NORMALIZATION_VERSION,
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

describe("splitDisplayAddress (card decomposition - presentational only)", () => {
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

describe("address-key algorithmic fixes (audit)", () => {
  it("every unit spelling keys identically - 'Apt #4' no longer double-folds to UNIT UNIT", () => {
    const forms = ["123 Main St #4", "123 Main St Apt 4", "123 Main St Apt #4", "123 Main St Unit #4", "123 Main St Unit 4"];
    const keys = forms.map(a => kineticLeadKeyOrNull(a, "Charlotte", "NC", "28202"));
    expect(new Set(keys).size).toBe(1);                    // all one canonical key
    expect(keys[0]).not.toContain("UNIT UNIT");
  });

  it("street-less placeholders get NO key (no dedup) - distinct leads can't merge away", () => {
    // "#", "Apt 5", "Unit 12" have no street identity → null → dedup disabled.
    expect(kineticLeadKeyOrNull("#", "Charlotte", "NC", "28202")).toBeNull();
    expect(kineticLeadKeyOrNull("Apt 5", "Charlotte", "NC", "28202")).toBeNull();
    expect(kineticLeadKeyOrNull("Unit 12", "Charlotte", "NC", "28202")).toBeNull();
    // A real street still keys.
    expect(kineticLeadKeyOrNull("123 Main St", "Charlotte", "NC", "28202")).not.toBeNull();
  });
});

// ── addressIdentityOf: which DOOR, not just which street ─────────────────────
// streetKeyOf answers "which street" and CUTS the unit clause off. Two scan-
// target twin guards were written as if it retained the unit and merged real
// doors together for it (server/storage.ts, server/scanTargetCanonicalMerge.ts).
// These are the properties those guards now depend on.
describe("addressIdentityOf (house / street / unit)", () => {
  it("splits the three parts a twin guard has to compare", () => {
    expect(addressIdentityOf("2715 Statesville Blvd Unit 101"))
      .toEqual({ house: "2715", street: "STATESVILLE BLVD", unit: "UNIT 101" });
    expect(addressIdentityOf("123-A Bell Ridge Court"))
      .toEqual({ house: "123 A", street: "BELL RIDGE CT", unit: "" });
    expect(addressIdentityOf("314 322 Malcolm Way"))
      .toEqual({ house: "314 322", street: "MALCOLM WAY", unit: "" });
    expect(addressIdentityOf("Nard Ln"))
      .toEqual({ house: "", street: "NARD LN", unit: "" });
  });

  it("the three parts reassemble into the canonical address, token for token", () => {
    // This is what lets a guard compare canonicalAddressPart(a) to
    // canonicalAddressPart(b) and know it has compared house, street AND unit.
    for (const a of [
      "2715 Statesville Blvd Unit 101", "123-A Bell Ridge Court", "101 N Main St",
      "300 Main St # 12", "123 1/2 Main St", "77 Lake Vista Dr Lot 16", "Nard Ln", "123",
    ]) {
      const id = addressIdentityOf(a);
      expect([id.house, id.street, id.unit].filter(Boolean).join(" "))
        .toBe(canonicalAddressPart(a));
    }
  });

  it("distinct doors of one building share a street but never a unit", () => {
    const units = ["Unit 101", "Apt 102", "Ste 103", "#104", "Lot 105"]
      .map((u) => addressIdentityOf(`2715 Statesville Blvd ${u}`));
    expect(new Set(units.map((u) => u.street)).size).toBe(1);   // one street
    expect(new Set(units.map((u) => u.house)).size).toBe(1);    // one house number
    expect(new Set(units.map((u) => u.unit)).size).toBe(5);     // five doors
  });

  it("the unit-less building row is not any unit", () => {
    expect(addressIdentityOf("2715 Statesville Blvd").unit).toBe("");
    expect(addressIdentityOf("2715 Statesville Blvd Unit 101").unit).toBe("UNIT 101");
  });

  it("every designator spelling of one door yields ONE identity", () => {
    const spellings = ["123 Main St Apt 4", "123 Main Street Unit 4",
                       "123 MAIN ST STE 4", "123 Main St #4", "123 Main St # 4"];
    expect(new Set(spellings.map((a) => JSON.stringify(addressIdentityOf(a)))).size).toBe(1);
  });

  it("streetKeyOf is exactly the street part (the two can never drift)", () => {
    for (const a of ["17 Fiber St", "100 Oak Ridge Ct Apt 4", "123-A Bell Ridge Court",
                     "Nard Ln", "123", "", null]) {
      expect(streetKeyOf(a)).toBe(addressIdentityOf(a).street);
    }
  });
});
