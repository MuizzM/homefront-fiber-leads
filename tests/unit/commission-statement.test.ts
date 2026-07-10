import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RETRO_TIERS, type CommissionTier } from "../../shared/commissionTiers";

/**
 * PURE tests of the statement financial core (server/commissionService.ts):
 *  - computeStatement: FLAT + retroactive-TIERED dollar matrix, integer cents,
 *    and the invariant final = gross + adjustment.
 *  - resolveAssignmentForWeek / assignmentsOverlap: effective-dated selection.
 * Importing the service opens a SQLite handle, so we point DATA_DIR at a throwaway
 * dir first (these functions never touch the DB, but the module does at import).
 */

let svc: typeof import("../../server/commissionService");

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-commission-pure-"));
  svc = await import("../../server/commissionService");
});

describe("computeStatement — retroactive tiered dollar matrix", () => {
  const cases: Array<[number, number]> = [
    [0, 0], [1, 15000], [7, 105000], [8, 160000], [12, 240000],
    [13, 325000], [16, 400000], [17, 510000], [30, 900000],
  ];
  it.each(cases)("%i qualified sales → %i cents gross", (count, expected) => {
    const c = svc.computeStatement({
      planType: "TIERED", tierMode: "RETROACTIVE_WEEKLY", flatRateCents: null,
      tiers: DEFAULT_RETRO_TIERS, qualifiedSaleCount: count, approvedAdjustmentCents: 0,
    });
    expect(c.grossCommissionCents).toBe(expected);
    expect(c.finalCommissionCents).toBe(expected); // no adjustment
  });

  it("crossing 7→8 pays ALL 8 at $200 (retroactive), not progressive", () => {
    const c = svc.computeStatement({ planType: "TIERED", tierMode: "RETROACTIVE_WEEKLY", flatRateCents: null, tiers: DEFAULT_RETRO_TIERS, qualifiedSaleCount: 8, approvedAdjustmentCents: 0 });
    expect(c.grossCommissionCents).toBe(160000);
    expect(c.rateCents).toBe(20000);
    expect(c.grossCommissionCents).not.toBe(7 * 15000 + 1 * 20000);
  });
});

describe("computeStatement — the statement invariant final = gross + adjustment", () => {
  it("adds a positive approved adjustment", () => {
    const c = svc.computeStatement({ planType: "TIERED", tierMode: "RETROACTIVE_WEEKLY", flatRateCents: null, tiers: DEFAULT_RETRO_TIERS, qualifiedSaleCount: 8, approvedAdjustmentCents: 5000 });
    expect(c.grossCommissionCents).toBe(160000);
    expect(c.adjustmentCents).toBe(5000);
    expect(c.finalCommissionCents).toBe(165000);
  });
  it("applies a negative clawback and never uses floats", () => {
    const c = svc.computeStatement({ planType: "TIERED", tierMode: "RETROACTIVE_WEEKLY", flatRateCents: null, tiers: DEFAULT_RETRO_TIERS, qualifiedSaleCount: 13, approvedAdjustmentCents: -32500 });
    expect(c.finalCommissionCents).toBe(325000 - 32500);
    expect(Number.isInteger(c.finalCommissionCents)).toBe(true);
  });
});

describe("computeStatement — flat plans", () => {
  it("flat: 8 × $150 = $1,200, no tier", () => {
    const c = svc.computeStatement({ planType: "FLAT", tierMode: "RETROACTIVE_WEEKLY", flatRateCents: 15000, tiers: [], qualifiedSaleCount: 8, approvedAdjustmentCents: 0 });
    expect(c.grossCommissionCents).toBe(120000);
    expect(c.tierId).toBeNull();
    expect(c.rateCents).toBe(15000);
  });
});

describe("computeStatement — guards", () => {
  it("rejects an unsupported tier mode", () => {
    expect(() => svc.computeStatement({ planType: "TIERED", tierMode: "PROGRESSIVE", flatRateCents: null, tiers: DEFAULT_RETRO_TIERS, qualifiedSaleCount: 5, approvedAdjustmentCents: 0 }))
      .toThrowError(/UNSUPPORTED_TIER_MODE|not supported/);
  });
  it("rejects an invalid tier configuration (gap)", () => {
    const bad: CommissionTier[] = [
      { position: 0, minimumSales: 1, maximumSales: 7, rateCents: 15000, label: "a" },
      { position: 1, minimumSales: 9, maximumSales: null, rateCents: 20000, label: "b" },
    ];
    expect(() => svc.computeStatement({ planType: "TIERED", tierMode: "RETROACTIVE_WEEKLY", flatRateCents: null, tiers: bad, qualifiedSaleCount: 5, approvedAdjustmentCents: 0 }))
      .toThrowError(/INVALID_TIER_CONFIGURATION|continuous/);
  });
});

describe("resolveAssignmentForWeek — effective-dated selection", () => {
  const A = { id: 1, commissionPlanVersionId: 10, effectiveFrom: "2026-01-01", effectiveTo: "2026-06-01" };
  const B = { id: 2, commissionPlanVersionId: 20, effectiveFrom: "2026-06-01", effectiveTo: null };
  it("picks the window that contains the week start", () => {
    expect(svc.resolveAssignmentForWeek([A, B], "2026-03-02T05:00:00.000Z")?.id).toBe(1);
    expect(svc.resolveAssignmentForWeek([A, B], "2026-07-06T04:00:00.000Z")?.id).toBe(2);
  });
  it("half-open: effectiveTo is exclusive", () => {
    // 2026-06-01 belongs to B, not A (A ends exclusive at 2026-06-01)
    expect(svc.resolveAssignmentForWeek([A, B], "2026-06-01T04:00:00.000Z")?.id).toBe(2);
  });
  it("returns null when no window covers the week", () => {
    expect(svc.resolveAssignmentForWeek([A], "2025-12-01T00:00:00.000Z")).toBeNull();
  });

  it("NEW-HIRE: an assignment starting mid-week governs the partial hire week", () => {
    // Hired Wed Jul 8 2026; week = Mon Jul 6 → Mon Jul 13. No plan covered the
    // week start, but the mid-week assignment applies when bounds are passed.
    const hire = { id: 9, commissionPlanVersionId: 30, effectiveFrom: "2026-07-08", effectiveTo: null };
    expect(svc.resolveAssignmentForWeek([hire], "2026-07-06T04:00:00.000Z")).toBeNull(); // without bounds: strict
    expect(svc.resolveAssignmentForWeek([hire], "2026-07-06T04:00:00.000Z", "2026-07-13T04:00:00.000Z")?.id).toBe(9);
    // …but a plan covering the week start still wins over a mid-week change.
    const covering = { id: 10, commissionPlanVersionId: 40, effectiveFrom: "2026-01-01", effectiveTo: "2026-07-08" };
    expect(svc.resolveAssignmentForWeek([covering, hire], "2026-07-06T04:00:00.000Z", "2026-07-13T04:00:00.000Z")?.id).toBe(10);
    // an assignment starting AFTER the week never applies to it.
    expect(svc.resolveAssignmentForWeek([hire], "2026-06-29T04:00:00.000Z", "2026-07-06T04:00:00.000Z")).toBeNull();
  });
});

describe("assignmentsOverlap — prevents double-assignment", () => {
  it("detects an overlap with an open-ended existing period", () => {
    const existing = [{ effectiveFrom: "2026-01-01", effectiveTo: null }];
    expect(svc.assignmentsOverlap(existing, { effectiveFrom: "2026-05-01", effectiveTo: null })).toBe(true);
  });
  it("allows a strictly-after, non-overlapping period", () => {
    const existing = [{ effectiveFrom: "2026-01-01", effectiveTo: "2026-06-01" }];
    expect(svc.assignmentsOverlap(existing, { effectiveFrom: "2026-06-01", effectiveTo: null })).toBe(false);
  });
});
