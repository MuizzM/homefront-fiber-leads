// Lead import (shared/leadImport.ts): header matching, mapping validation,
// and row evaluation. Phones are never a target.
import { describe, expect, it } from "vitest";
import {
  suggestLeadImportMapping, validateLeadImportMapping, evaluateLeadImportRows, normalizeRepName,
} from "../../shared/leadImport";
import { normalizeKineticAddressKey } from "../../shared/addressKey";

describe("suggestLeadImportMapping", () => {
  it("matches the usual headers and locks phone and e-mail columns to ignore", () => {
    const cols = ["Address", "City", "ST", "Zip", "Homeowner", "Assigned rep", "Phone", "Email", "Notes", "Lat"];
    expect(suggestLeadImportMapping(cols)).toEqual({
      "0": "address", "1": "city", "2": "state", "3": "zip", "4": "ownerName",
      "5": "assignedRep", "6": "ignore", "7": "ignore", "8": "notes", "9": "ignore",
    });
  });
  it("takes each target once, first column wins", () => {
    const m = suggestLeadImportMapping(["Street Address", "Address 1", "Town", "City"]);
    expect(m).toEqual({ "0": "address", "1": "ignore", "2": "city", "3": "ignore" });
  });
});

describe("validateLeadImportMapping", () => {
  const cols = ["Address", "City", "Phone", "Owner"];
  it("requires an address and a city", () => {
    const { ok, issues } = validateLeadImportMapping({ "0": "ignore", "1": "ignore" }, cols);
    expect(ok).toBe(false);
    expect(issues.map((i) => i.message)).toEqual([
      "Street address is required. Pick the column that holds it.",
      "City is required. Pick the column that holds it.",
    ]);
  });
  it("refuses a phone column mapped to anything, and a target used twice", () => {
    const r = validateLeadImportMapping({ "0": "address", "1": "city", "2": "notes", "3": "address" }, cols);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.message)).toEqual([
      '"Phone" looks like phone numbers. Phones come in through Calling only.',
      '"Owner" and "Address" both map to Street address',
    ]);
  });
  it("accepts a minimal good mapping", () => {
    expect(validateLeadImportMapping({ "0": "address", "1": "city", "2": "ignore", "3": "ownerName" }, cols).ok).toBe(true);
  });
});

describe("evaluateLeadImportRows", () => {
  const mapping = { "0": "address", "1": "city", "2": "state", "3": "zip", "4": "ownerName", "5": "assignedRep", "6": "notes" } as const;
  const roster = new Map([[normalizeRepName("Jordan Price"), 7], ["jordan@hf.test", 7]]);
  const existing = new Set([normalizeKineticAddressKey("1838 Oak Ridge Dr", "Salisbury", "NC", "28146")]);

  it("classifies every row and keeps the counts honest", () => {
    const rows = [
      ["1842 Oak Ridge Dr", "Salisbury", "NC", "28146", "Marcus Hill", "Jordan Price", "Asked about 1 Gig"],
      ["1842 Oak Ridge Drive", "Salisbury", "nc", "28146-1234", "", "", ""],   // same door, written differently
      ["1838 Oak Ridge Dr", "Salisbury", "", "", "", "Nobody Here", ""],          // already on the map, unknown rep
      ["", "Salisbury", "NC", "28146", "", "", ""],                               // no address
      ["9 Elm St", "", "NC", "", "", "", ""],                                      // no city
      ["", "", "", "", "", "", ""],                                               // blank line
    ];
    const { rows: out, summary } = evaluateLeadImportRows(rows, mapping, { existingKeys: existing, roster });
    expect(out.map((r) => r.status)).toEqual(["ready", "duplicate_in_file", "already_on_map", "missing_address", "missing_city"]);
    expect(out[0]).toMatchObject({ address: "1842 Oak Ridge Dr", city: "Salisbury", state: "NC", zip: "28146", ownerName: "Marcus Hill", repId: 7, notes: "Asked about 1 Gig" });
    expect(out[1].zip).toBe("28146");
    expect(out[2].state).toBe("NC"); // default when the cell is empty
    expect(summary).toEqual({
      rows: 5, ready: 1, missingAddress: 1, missingCity: 1, duplicatesInFile: 1, alreadyOnMap: 1,
      unknownReps: ["Nobody Here"], repMatched: 1,
    });
  });

  it("resolves reps case- and punctuation-insensitively", () => {
    const { rows: out } = evaluateLeadImportRows([["1 A St", "Town", "", "", "", "JORDAN  price", ""]], mapping, { existingKeys: new Set(), roster });
    expect(out[0].repId).toBe(7);
  });
});
