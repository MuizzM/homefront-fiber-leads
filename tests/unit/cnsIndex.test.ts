import { describe, it, expect } from "vitest";
import {
  parseDfAddressId, buildCityCoverage, planCityProbe, dfIdFor,
  type CoverageRow,
} from "../../shared/cnsIndex";

// The city↔CNS index is the moat for zero-Mapbox targeting: it must parse Kinetic
// df ids robustly, cluster a city's control numbers into bands, and propose probes
// ONLY adjacent to where the city demonstrably lives (frontier first, then gaps),
// never re-probing known numbers, never past the assigned ceiling.

describe("parseDfAddressId", () => {
  it("splits ENV prefix + control number, uppercasing the env", () => {
    expect(parseDfAddressId("MS3062552")).toEqual({ env: "MS", cns: 3062552 });
    expect(parseDfAddressId("MS0000123")).toEqual({ env: "MS", cns: 123 });
    expect(parseDfAddressId("mo123")).toEqual({ env: "MO", cns: 123 });
    expect(parseDfAddressId("  PA0573208 ")).toEqual({ env: "PA", cns: 573208 });
  });
  it("returns null for anything that isn't <letters><digits>", () => {
    expect(parseDfAddressId(null)).toBeNull();
    expect(parseDfAddressId("")).toBeNull();
    expect(parseDfAddressId("123")).toBeNull();       // no env
    expect(parseDfAddressId("MS")).toBeNull();        // no number
    expect(parseDfAddressId("MS-123")).toBeNull();    // separator
    expect(parseDfAddressId("MS12A34")).toBeNull();   // interior letter
  });
  it("dfIdFor matches the scanner's ENV + zero-padded form", () => {
    expect(dfIdFor("MS", 123)).toBe("MS0000123");
    expect(dfIdFor("MS", 3062552)).toBe("MS3062552");
  });
});

const row = (df: string | null, city: string, nf = false, state = "NC"): CoverageRow => ({ dfAddressId: df, city, state, isNewFiber: nf });

describe("buildCityCoverage", () => {
  it("groups by (env, city, state) and splits control numbers into bands on gaps", () => {
    const rows: CoverageRow[] = [
      row("MS0001000", "Charlotte"), row("MS0001001", "Charlotte"), row("MS0001002", "Charlotte"),
      row("MS0009000", "Charlotte", true), row("MS0009001", "Charlotte"),           // second band (big gap)
      row("MS0002000", "Gastonia"),
      row(null, "NoDf"), row("BAD", "Bad"),                                          // ignored (unparseable)
      row("MS0001005", ""),                                                          // ignored (no city)
    ];
    const cov = buildCityCoverage(rows, { bandGap: 400 });
    const charlotte = cov.find(c => c.city === "charlotte")!;
    expect(charlotte.env).toBe("MS");
    expect(charlotte.knownCount).toBe(5);
    expect(charlotte.newFiberCount).toBe(1);
    expect(charlotte.bands).toHaveLength(2);
    expect(charlotte.bands[0]).toEqual({ minCns: 1000, maxCns: 1002, count: 3 });
    expect(charlotte.bands[1]).toEqual({ minCns: 9000, maxCns: 9001, count: 2 });
    expect(charlotte.minCns).toBe(1000);
    expect(charlotte.maxCns).toBe(9001);
    // Gastonia is a separate city group.
    expect(cov.find(c => c.city === "gastonia")!.knownCount).toBe(1);
    // Unparseable / city-less rows never appear.
    expect(cov.find(c => c.city === "nodf")).toBeUndefined();
    expect(cov.find(c => c.city === "bad")).toBeUndefined();
  });

  it("dedupes identical control numbers before banding", () => {
    const cov = buildCityCoverage([row("MS0001000", "X"), row("MS0001000", "X"), row("MS0001001", "X")]);
    expect(cov[0].knownCount).toBe(2);
    expect(cov[0].bands[0]).toEqual({ minCns: 1000, maxCns: 1001, count: 2 });
  });
});

describe("planCityProbe", () => {
  const cov = buildCityCoverage([
    row("MS0001000", "X"), row("MS0001001", "X"), row("MS0001002", "X"),
  ])[0];

  it("proposes the FRONTIER just past the band max, skipping known numbers", () => {
    const known = new Set([1000, 1001, 1002]);
    const plan = planCityProbe(cov, known, { budget: 3, frontierSpan: 5, envMaxCns: 1002 });
    expect(plan.frontier).toEqual([1003, 1004, 1005, 1006, 1007]); // full span of candidates
    expect(plan.probes).toEqual([1003, 1004, 1005]);               // probes capped to budget
    expect(plan.probes.every(c => !known.has(c))).toBe(true);
  });

  it("fills GAPS inside a band for unprobed city addresses", () => {
    const known = new Set([1000, 1002]); // 1001 is an unprobed gap inside [1000,1002]
    const plan = planCityProbe(cov, known, { budget: 10, frontierSpan: 2, gapCapPerBand: 10, envMaxCns: 1002 });
    expect(plan.gaps).toContain(1001);
    expect(plan.frontier).toEqual([1003, 1004]);
    // Frontier comes first, then gaps.
    expect(plan.probes[0]).toBe(1003);
    expect(plan.probes).toContain(1001);
  });

  it("respects the budget cap and the assigned-number ceiling", () => {
    const plan = planCityProbe(cov, new Set(), { budget: 2, frontierSpan: 100, envMaxCns: 1002, overshoot: 0 });
    // budget 2 → only 2 probes; ceiling = 1002 + overshoot 0, so nothing past 1002...
    // but frontier starts at 1003 > ceiling → no frontier; gaps fill [1000..1002] minus known(none)
    expect(plan.probes).toHaveLength(2);
    expect(Math.max(...plan.probes)).toBeLessThanOrEqual(1002);
  });

  it("never proposes a probe beyond envMax + overshoot", () => {
    const plan = planCityProbe(cov, new Set([1000, 1001, 1002]), { budget: 50, frontierSpan: 10000, envMaxCns: 1002, overshoot: 3 });
    expect(Math.max(...plan.probes, 0)).toBeLessThanOrEqual(1005); // 1002 + 3
  });
});
