import { describe, it, expect } from "vitest";
import {
  calcCommission, pickActiveStructure, describeStructure,
  type CommissionStructure,
} from "../../shared/commission";

/**
 * CONTRACT (shared/commission.ts): commission is deterministic and governed.
 * The structure IN EFFECT for a rep AT SALE TIME scores the sale; flat/
 * percentage/tiered each compute exactly; rep plans beat role plans; a later
 * republish (higher version, newer effectiveFrom) wins same-day overlaps.
 */

const base: CommissionStructure = {
  id: 1, name: "Std", calcType: "flat", flatAmount: 100, percentage: 0, tiers: [],
  role: "rep", repId: null, effectiveFrom: "2026-01-01", effectiveTo: null, version: 1, isActive: true,
};
const S = (o: Partial<CommissionStructure>): CommissionStructure => ({ ...base, ...o });

describe("calcCommission — per type", () => {
  it("flat pays the fixed amount regardless of sale value", () => {
    expect(calcCommission(S({ calcType: "flat", flatAmount: 120 }), 999)).toEqual(
      { amount: 120, calcType: "flat", tierMinBasis: null });
  });

  it("percentage pays a share of the sale value, rounded to cents", () => {
    expect(calcCommission(S({ calcType: "percentage", percentage: 15 }), 89.99)).toEqual(
      { amount: 13.5, calcType: "percentage", tierMinBasis: null });
  });

  it("tiered pays the highest qualifying band; below the lowest band pays 0", () => {
    const tiers = [{ minBasis: 50, amount: 75 }, { minBasis: 100, amount: 180 }, { minBasis: 150, amount: 300 }];
    const plan = S({ calcType: "tiered", tiers });
    expect(calcCommission(plan, 120)).toEqual({ amount: 180, calcType: "tiered", tierMinBasis: 100 });
    expect(calcCommission(plan, 150)).toEqual({ amount: 300, calcType: "tiered", tierMinBasis: 150 });
    expect(calcCommission(plan, 40)).toEqual({ amount: 0, calcType: "tiered", tierMinBasis: null });
  });

  it("guards non-finite / negative sale amounts to a 0 basis", () => {
    expect(calcCommission(S({ calcType: "percentage", percentage: 10 }), Number.NaN).amount).toBe(0);
    expect(calcCommission(S({ calcType: "percentage", percentage: 10 }), -50).amount).toBe(0);
  });
});

describe("pickActiveStructure — governance at sale time", () => {
  it("chooses a plan whose window covers the sale date", () => {
    const plans = [
      S({ id: 1, effectiveFrom: "2026-01-01", effectiveTo: "2026-03-31" }),
      S({ id: 2, effectiveFrom: "2026-04-01", effectiveTo: null }),
    ];
    expect(pickActiveStructure(plans, 9, "rep", "2026-02-15")?.id).toBe(1);
    expect(pickActiveStructure(plans, 9, "rep", "2026-07-09")?.id).toBe(2);
  });

  it("a rep-specific plan beats the role plan on the same date", () => {
    const plans = [
      S({ id: 1, role: "rep", repId: null }),
      S({ id: 2, role: null, repId: 9 }),
    ];
    expect(pickActiveStructure(plans, 9, "rep", "2026-05-01")?.id).toBe(2);
    // ...but only for THAT rep — rep 8 still gets the role plan.
    expect(pickActiveStructure(plans, 8, "rep", "2026-05-01")?.id).toBe(1);
  });

  it("a republish (later effectiveFrom / higher version) wins a same-day overlap", () => {
    const plans = [
      S({ id: 1, effectiveFrom: "2026-01-01", version: 1 }),
      S({ id: 2, effectiveFrom: "2026-06-01", version: 2 }),
    ];
    expect(pickActiveStructure(plans, 9, "rep", "2026-07-01")?.id).toBe(2);
  });

  it("ignores inactive plans and another rep's / role's plans", () => {
    const plans = [
      S({ id: 1, isActive: false }),
      S({ id: 2, role: null, repId: 999 }), // another rep
      S({ id: 3, role: "manager", repId: null }), // another role
    ];
    expect(pickActiveStructure(plans, 9, "rep", "2026-05-01")).toBeNull();
  });

  it("returns null when nothing covers the date — never guesses a payout", () => {
    const plans = [S({ effectiveFrom: "2026-08-01" })];
    expect(pickActiveStructure(plans, 9, "rep", "2026-07-01")).toBeNull();
  });
});

describe("describeStructure", () => {
  it("summarizes each type for the editor + audit line", () => {
    expect(describeStructure({ calcType: "flat", flatAmount: 120, percentage: 0, tiers: [] })).toBe("$120 flat per sale");
    expect(describeStructure({ calcType: "percentage", flatAmount: 0, percentage: 15, tiers: [] })).toBe("15% of sale value");
    expect(describeStructure({ calcType: "tiered", flatAmount: 0, percentage: 0, tiers: [{ minBasis: 100, amount: 180 }] }))
      .toContain("1-tier");
  });
});
