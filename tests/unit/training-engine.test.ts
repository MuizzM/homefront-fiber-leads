// Unit tests for the pure helpers in client/src/lib/useTrainingEngine.ts —
// streak math, ladder coverage derivation, and the local-day rule.
import { describe, it, expect } from "vitest";
import {
  computeStreakDays,
  ladderCoverageFromRungs,
  localDayISO,
} from "@/lib/useTrainingEngine";

describe("computeStreakDays", () => {
  it("counts consecutive days ending today", () => {
    expect(computeStreakDays(["2025-03-01", "2025-03-02", "2025-03-03"], "2025-03-03")).toBe(3);
  });

  it("graces today: a streak through yesterday still holds this morning", () => {
    expect(computeStreakDays(["2025-03-01", "2025-03-02"], "2025-03-03")).toBe(2);
  });

  it("a missed day resets quietly", () => {
    expect(computeStreakDays(["2025-03-01"], "2025-03-03")).toBe(0);
  });

  it("breaks on the first gap, counting back from today/yesterday only", () => {
    expect(computeStreakDays(["2025-02-27", "2025-03-01", "2025-03-02", "2025-03-03"], "2025-03-03")).toBe(3);
  });

  it("is 0 with no reviews", () => {
    expect(computeStreakDays([], "2025-03-03")).toBe(0);
  });
});

describe("ladderCoverageFromRungs", () => {
  it("buckets every card by rung and clamps out-of-range values", () => {
    const coverage = ladderCoverageFromRungs({ a: 0, b: 1, c: 4, d: 99, e: -3 });
    expect(coverage).toEqual({ "0": 2, "1": 1, "2": 0, "3": 0, "4": 2 });
  });

  it("returns zeroed rungs for an empty map", () => {
    expect(ladderCoverageFromRungs({})).toEqual({ "0": 0, "1": 0, "2": 0, "3": 0, "4": 0 });
  });
});

describe("localDayISO", () => {
  it("formats the LOCAL calendar day (not UTC)", () => {
    expect(localDayISO(new Date(2025, 2, 3, 23, 59))).toBe("2025-03-03");
  });
});
