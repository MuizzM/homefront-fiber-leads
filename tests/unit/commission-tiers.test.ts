import { describe, it, expect } from "vitest";
import {
  validateTiers, suggestNextMinimum, findTierByBinarySearch,
  calculateRetroactiveCommission, calculateFlatCommission, tierProgressMessage,
  DEFAULT_RETRO_TIERS, type CommissionTier,
} from "../../shared/commissionTiers";

/**
 * CONTRACT (shared/commissionTiers.ts): RETROACTIVE weekly tiering. The TOTAL
 * weekly qualified-sale count picks ONE tier whose rate applies to EVERY sale.
 * Integer cents throughout — never progressive, never floating point.
 * Default plan: 1–7 $150, 8–12 $200, 13–16 $250, 17+ $300.
 */

const T = DEFAULT_RETRO_TIERS;

describe("retroactive calculation — the spec's exact dollar examples", () => {
  const cases: Array<[number, number]> = [
    [1, 15000],   // 1 × $150
    [7, 105000],  // 7 × $150 = $1,050
    [8, 160000],  // 8 × $200 = $1,600  (retroactive — all 8 at the new rate)
    [12, 240000], // 12 × $200 = $2,400
    [13, 325000], // 13 × $250 = $3,250
    [16, 400000], // 16 × $250 = $4,000
    [17, 510000], // 17 × $300 = $5,100
    [30, 900000], // deep in the open-ended top tier
  ];
  it.each(cases)("%i qualified sales → %i cents gross", (count, expected) => {
    expect(calculateRetroactiveCommission(count, T).grossCommissionCents).toBe(expected);
  });

  it("crossing 7→8 pays ALL 8 at $200 (retroactive), NOT 7×$150 + 1×$200", () => {
    const r = calculateRetroactiveCommission(8, T);
    expect(r.grossCommissionCents).toBe(160000);
    expect(r.grossCommissionCents).not.toBe(7 * 15000 + 1 * 20000); // 125000 = progressive (wrong)
    expect(r.rateCents).toBe(20000);
  });

  it("0 sales → $0, and points at the first tier as the next target", () => {
    const r = calculateRetroactiveCommission(0, T);
    expect(r.grossCommissionCents).toBe(0);
    expect(r.tierId).toBeNull();
    expect(r.nextTierRateCents).toBe(15000);
    expect(r.salesUntilNextTier).toBe(1);
  });

  it("next-tier projection at 6 sales: current $900, need 2 more, projected $1,600", () => {
    const r = calculateRetroactiveCommission(6, T);
    expect(r.grossCommissionCents).toBe(90000);        // 6 × $150
    expect(r.salesUntilNextTier).toBe(2);
    expect(r.nextTierMinimumSales).toBe(8);
    expect(r.nextTierProjectedCommissionCents).toBe(160000); // 8 × $200
  });

  it("top tier has no next tier", () => {
    const r = calculateRetroactiveCommission(20, T);
    expect(r.salesUntilNextTier).toBeNull();
    expect(r.nextTierRateCents).toBeNull();
    expect(r.grossCommissionCents).toBe(600000); // 20 × $300
  });
});

describe("tier lookup is O(log t) and correct at boundaries", () => {
  it.each([[1,15000],[7,15000],[8,20000],[12,20000],[13,25000],[16,25000],[17,30000],[999,30000]])(
    "count %i → rate %i", (count, rate) => {
      expect(findTierByBinarySearch(T, count)?.rateCents).toBe(rate);
    });
});

describe("tier validation", () => {
  it("accepts the canonical 1–7 / 8–12 / 13–16 / 17+ plan", () => {
    expect(validateTiers(T).ok).toBe(true);
  });
  it("rejects an overlap (1–7, 7–12)", () => {
    const bad: CommissionTier[] = [
      { position: 0, minimumSales: 1, maximumSales: 7, rateCents: 15000, label: "a" },
      { position: 1, minimumSales: 7, maximumSales: 12, rateCents: 20000, label: "b" },
    ];
    const v = validateTiers(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/continuous/i);
  });
  it("rejects a gap (1–7, 9–12+)", () => {
    const bad: CommissionTier[] = [
      { position: 0, minimumSales: 1, maximumSales: 7, rateCents: 15000, label: "a" },
      { position: 1, minimumSales: 9, maximumSales: null, rateCents: 20000, label: "b" },
    ];
    expect(validateTiers(bad).ok).toBe(false);
  });
  it("rejects a non-final open-ended tier (1–7, 8–12, 10+)", () => {
    const bad: CommissionTier[] = [
      { position: 0, minimumSales: 1, maximumSales: 7, rateCents: 15000, label: "a" },
      { position: 1, minimumSales: 8, maximumSales: 12, rateCents: 20000, label: "b" },
      { position: 2, minimumSales: 10, maximumSales: null, rateCents: 25000, label: "c" },
    ];
    expect(validateTiers(bad).ok).toBe(false);
  });
  it("rejects a first tier that doesn't start at 1", () => {
    expect(validateTiers([{ position: 0, minimumSales: 2, maximumSales: null, rateCents: 15000, label: "x" }]).ok).toBe(false);
  });
  it("rejects a zero/negative rate and max<min", () => {
    expect(validateTiers([{ position: 0, minimumSales: 1, maximumSales: null, rateCents: 0, label: "x" }]).ok).toBe(false);
    expect(validateTiers([
      { position: 0, minimumSales: 1, maximumSales: 3, rateCents: 100, label: "a" },
      { position: 1, minimumSales: 5, maximumSales: 4, rateCents: 200, label: "b" },
    ]).ok).toBe(false);
  });
  it("suggests the next contiguous minimum", () => {
    expect(suggestNextMinimum(7)).toBe(8);
    expect(suggestNextMinimum(null)).toBeNull();
  });
});

describe("flat plan + message", () => {
  it("flat: 8 sales × $150 = $1,200", () => {
    expect(calculateFlatCommission(8, 15000)).toBe(120000);
  });
  it("progress message matches the spec copy at 6 sales", () => {
    const msg = tierProgressMessage(calculateRetroactiveCommission(6, T));
    expect(msg).toContain("6 qualified sales");
    expect(msg).toContain("$150");
    expect(msg).toContain("Close 2 more");
    expect(msg).toContain("$200");
    expect(msg).toContain("$1,600");
  });
});
