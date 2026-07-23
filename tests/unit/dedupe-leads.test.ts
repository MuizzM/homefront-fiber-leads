import { describe, it, expect } from "vitest";
import { dedupeLeads, houseKey, leadKey } from "../../client/src/lib/dedupeLeads";

const lead = (over: Partial<Parameters<typeof dedupeLeads>[0][number]> & { id: number | string }) => ({
  address: "1 Main St", city: "Concord", state: "NC", lat: 35.4, lng: -80.5, ...over,
});

describe("houseKey", () => {
  // ADDRESS-FIRST identity (v2 contract): the address is the house. The old
  // coord-primary key claimed neighbours never collide at 5 decimals — the
  // real DB proved 29 lead-cells (58 leads) did, hiding real houses.
  it("is address-first: geocoder jitter on the same address never splits the house", () => {
    expect(houseKey(lead({ id: 1, lat: 35.400001, lng: -80.500002 })))
      .toBe(houseKey(lead({ id: 2, lat: 35.40030, lng: -80.50021 }))); // 30m of jitter — same house
  });
  it("folds spelling variants with the server's canonical alias table (Tr ≡ Trl ≡ Trail)", () => {
    expect(houseKey(lead({ id: 1, address: "106 Poplar Tr" })))
      .toBe(houseKey(lead({ id: 2, address: "106 Poplar Trl" })));
    expect(houseKey(lead({ id: 1, address: "12 Oak Circle" })))
      .toBe(houseKey(lead({ id: 2, address: "12 OAK CIR" })));
  });
  it("keeps real neighbours distinct even at identical coordinates (the false-merge regression)", () => {
    expect(houseKey(lead({ id: 1, address: "1 Main St", lat: 35.4, lng: -80.5 })))
      .not.toBe(houseKey(lead({ id: 2, address: "3 Main St", lat: 35.4, lng: -80.5 })));
  });
  it("keys by rounded coordinate only when there is no usable address", () => {
    expect(houseKey(lead({ id: 1, address: "", lat: 35.400001, lng: -80.500002 })))
      .toBe(houseKey(lead({ id: 2, address: "", lat: 35.400003, lng: -80.500001 })));
    expect(houseKey(lead({ id: 1, address: "", lat: 35.40010, lng: -80.5 })))
      .not.toBe(houseKey(lead({ id: 2, address: "", lat: 35.40025, lng: -80.5 })));
  });
  it("normalizes whitespace/case via the canonical part when coordinates are missing", () => {
    expect(houseKey(lead({ id: 1, lat: null, lng: null, address: "123  N Main  St" })))
      .toBe(houseKey(lead({ id: 2, lat: undefined, lng: undefined, address: "123 n main st" })));
  });
  it("returns null when neither coordinate nor address is usable", () => {
    expect(houseKey({ id: 1, lat: null, lng: null, address: "" })).toBeNull();
  });
});

describe("leadKey", () => {
  it("is stable, composite, and string-normalized (never the array index)", () => {
    expect(leadKey(lead({ id: 7, lat: 35.4, lng: -80.5 }))).toBe("7-35.4--80.5");
    // string vs number id normalize to the same key
    expect(leadKey(lead({ id: "7", lat: 35.4, lng: -80.5 }))).toBe(leadKey(lead({ id: 7, lat: 35.4, lng: -80.5 })));
  });
  it("stays distinct for two records that collide on id but sit at different coords", () => {
    expect(leadKey(lead({ id: 5, lat: 35.4, lng: -80.5 })))
      .not.toBe(leadKey(lead({ id: 5, lat: 36.0, lng: -81.0 })));
  });
});

describe("dedupeLeads", () => {
  it("collapses two records on the same rooftop to one pin", () => {
    const out = dedupeLeads([
      lead({ id: 1, lat: 35.400000, lng: -80.500000 }),
      lead({ id: 2, lat: 35.400002, lng: -80.500001 }), // ~0.2 m away — same house
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].mergedCount).toBe(2);
    expect(out[0].mergedLeadIds).toEqual(expect.arrayContaining(["1", "2"]));
  });

  it("keeps the higher-priority survivor (fresh-fiber > score > recency), survivor id first", () => {
    const out = dedupeLeads([
      lead({ id: 1, leadScore: 40 }),
      lead({ id: 2, leadTag: "fresh_fiber_confirmed", leadScore: 10 }), // fresh wins despite lower score
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(2);
    expect(out[0].mergedLeadIds?.[0]).toBe("2"); // survivor listed first
    expect(out[0].mergedLeadIds).toContain("1");
  });

  it("does NOT merge two genuinely different neighbouring houses", () => {
    const out = dedupeLeads([
      lead({ id: 1, address: "1 Main St", lat: 35.40010, lng: -80.5 }),
      lead({ id: 2, address: "3 Main St", lat: 35.40030, lng: -80.5 }), // next door — a different house
    ]);
    expect(out).toHaveLength(2);
  });

  it("does NOT merge townhouse neighbours that share a rounded coordinate (the 29-cell regression)", () => {
    const out = dedupeLeads([
      lead({ id: 1, address: "101 Row House Ln", lat: 35.4, lng: -80.5 }),
      lead({ id: 2, address: "103 Row House Ln", lat: 35.4, lng: -80.5 }), // same rooftop rounding, real neighbour
    ]);
    expect(out).toHaveLength(2);
  });

  it("merges the same rooftop filed under two postal cities (boundary-house twin)", () => {
    const out = dedupeLeads([
      lead({ id: 1, address: "104 Oak St", city: "Broadway", lat: 35.40001, lng: -80.50001 }),
      lead({ id: 2, address: "104 Oak St", city: "Sanford", lat: 35.40002, lng: -80.50002, leadTag: "fresh_fiber_confirmed" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(2); // fresh-fiber survivor wins
    expect(out[0].mergedCount).toBe(2);
  });

  it("passes through records with no usable house key instead of dropping them", () => {
    const out = dedupeLeads([
      lead({ id: 1, lat: null, lng: null, address: "" }),
      lead({ id: 2, lat: null, lng: null, address: "" }),
    ]);
    expect(out).toHaveLength(2); // neither mergeable, both kept
  });

  it("returns a new array and never mutates the source or its objects", () => {
    const a = lead({ id: 1 });
    const b = lead({ id: 2, lat: 35.400002 }); // same house as a
    const src = [a, b];
    const out = dedupeLeads(src);
    expect(src).toHaveLength(2);           // source array untouched
    expect(a).not.toHaveProperty("mergedLeadIds"); // originals untouched
    expect(b).not.toHaveProperty("mergedLeadIds");
    expect(out).not.toBe(src);
  });

  it("singletons keep their original object reference (no needless allocation)", () => {
    const a = lead({ id: 1, lat: 35.4, lng: -80.5 });
    const out = dedupeLeads([a]);
    expect(out[0]).toBe(a);
  });

  it("every rendered key is unique after dedup (the React-warning guarantee)", () => {
    const out = dedupeLeads([
      lead({ id: 1, lat: 35.4, lng: -80.5 }),
      lead({ id: 1, lat: 35.400001, lng: -80.5 }), // dup id + same house → merges away
      lead({ id: 2, lat: 36.0, lng: -81.0 }),
      lead({ id: 3, lat: 34.0, lng: -79.0, address: "9 Oak Cir" }),
    ]);
    const keys = out.map(leadKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("handles empty / non-array input", () => {
    expect(dedupeLeads([])).toEqual([]);
    expect(dedupeLeads(undefined as any)).toEqual([]);
  });
});
