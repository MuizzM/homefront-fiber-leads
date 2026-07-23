import { describe, it, expect } from "vitest";
import { canonicalAddressPart, normalizeKineticAddressKey, kineticLeadKeyOrNull, NORMALIZATION_VERSION } from "../../server/addressKey";

// The canonical key is the dedup identity. Two spellings of the same address
// MUST normalize equal; two different addresses must not.
describe("address normalization (expanded suffix/directional/unit folding)", () => {
  it("folds the full suffix table, not just the original eight", () => {
    const same = (a: string, b: string) => expect(canonicalAddressPart(a)).toBe(canonicalAddressPart(b));
    same("123 Oak Circle", "123 Oak Cir");         // the reported gap
    same("50 Sunset Place", "50 Sunset Pl");
    same("9 Ridge Terrace", "9 Ridge Ter");
    same("7 Lake Parkway", "7 Lake Pkwy");
    same("4 Fox Trail", "4 Fox Trl");
    same("2 Mill Crossing", "2 Mill Xing");
    // and the originals still hold
    same("742 Evergreen Road", "742 Evergreen RD");
    same("1 Main Street", "1 Main St");
  });

  it("does NOT fold name-position words that only happen to be USPS types", () => {
    // "Ridge" here is part of the NAME, not the suffix — folding it (→ RDG) would
    // mangle the address and risk false merges. Deliberately excluded.
    expect(canonicalAddressPart("100 Oak Ridge Ct")).toBe("100 OAK RIDGE CT");
    expect(canonicalAddressPart("5 Mill Creek Dr")).toBe("5 MILL CREEK DR");
  });

  it("folds directionals including the diagonals", () => {
    expect(canonicalAddressPart("101 North Main St")).toBe(canonicalAddressPart("101 N Main St"));
    expect(canonicalAddressPart("5 Northeast Blvd")).toBe(canonicalAddressPart("5 NE Blvd"));
    expect(canonicalAddressPart("5 Southwest Ave")).toBe(canonicalAddressPart("5 SW Ave"));
  });

  it("folds unit designators (apartment ≡ apt, suite ≡ ste)", () => {
    expect(canonicalAddressPart("12 Main St Apartment 3")).toBe(canonicalAddressPart("12 Main St Apt 3"));
    expect(canonicalAddressPart("12 Main St Suite 3")).toBe(canonicalAddressPart("12 Main St Ste 3"));
  });

  it("keeps genuinely different addresses distinct (MDU units stay separate)", () => {
    // Distinct houses
    expect(canonicalAddressPart("123 Oak Cir")).not.toBe(canonicalAddressPart("125 Oak Cir"));
    // Distinct units at one building — one lead per door for D2D (kept distinct)
    expect(canonicalAddressPart("123 Main St Apt 2")).not.toBe(canonicalAddressPart("123 Main St Apt 4"));
  });

  it("normalizeKineticAddressKey collapses whole-record variants and IGNORES zip (v3)", () => {
    // Same house, different/blank zip → SAME key. Zip used to split one house
    // into two identities (blank OSM row vs zip-full Kinetic row → dup pins).
    expect(normalizeKineticAddressKey("123 Oak Circle", "Terrace", "NC", "28110-1234"))
      .toBe(normalizeKineticAddressKey("123 Oak Cir", "Terrace", "NC", ""));
    // Key ends at state — no trailing zip component.
    expect(normalizeKineticAddressKey("1 A St", "X", "NC", "28110").endsWith("|NC")).toBe(true);
    // "Tr" now folds to TRL (was a confirmed duplicate-green-arrow vector).
    expect(normalizeKineticAddressKey("106 Poplar Tr", "Rockwell", "NC", "28138"))
      .toBe(normalizeKineticAddressKey("106 Poplar Trl", "Rockwell", "NC", ""));
  });

  it("exports a normalization version so the re-key migration can gate on it", () => {
    expect(Number.isInteger(NORMALIZATION_VERSION)).toBe(true);
    expect(NORMALIZATION_VERSION).toBeGreaterThanOrEqual(2);
  });

  // The LEAD dedup key must never false-merge two DIFFERENT keyless addresses.
  describe("kineticLeadKeyOrNull — no false-merge for blank/garbage addresses", () => {
    it("returns NULL when there is no usable street address (so the UNIQUE index doesn't apply)", () => {
      expect(kineticLeadKeyOrNull("", "Charlotte", "NC", "28202")).toBeNull();
      expect(kineticLeadKeyOrNull("   ", "Charlotte", "NC", "28202")).toBeNull();
      expect(kineticLeadKeyOrNull("!!!", "Charlotte", "NC", "28202")).toBeNull(); // punctuation-only → empty part
    });

    it("two DIFFERENT blank-address leads in the same city both key to NULL — never merge onto one", () => {
      // Before the fix both were "|CHARLOTTE|NC|28202" → the leads UNIQUE index
      // merged them and LOST a real distinct lead.
      const a = kineticLeadKeyOrNull("", "Charlotte", "NC", "28202");
      const b = kineticLeadKeyOrNull("", "Charlotte", "NC", "28202");
      expect(a).toBeNull();
      expect(b).toBeNull(); // NULL != NULL under a partial `WHERE canonical_key IS NOT NULL` index → no dedup
    });

    it("a REAL address still gets its dedup key, identical to the plain normalizer", () => {
      const key = kineticLeadKeyOrNull("123 Oak Cir", "Charlotte", "NC", "28202");
      expect(key).not.toBeNull();
      expect(key).toBe(normalizeKineticAddressKey("123 Oak Cir", "Charlotte", "NC", "28202"));
      // and two spellings of the same real address still collapse (dedup preserved)
      expect(kineticLeadKeyOrNull("123 Oak Circle", "Charlotte", "NC", "28202"))
        .toBe(kineticLeadKeyOrNull("123 Oak Cir", "Charlotte", "NC", "28202"));
    });
  });
});
