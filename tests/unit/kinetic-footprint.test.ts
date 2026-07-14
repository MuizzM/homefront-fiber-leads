import { describe, expect, it } from "vitest";
import {
  allocateEnvironmentBudget, isKineticFootprintState, KINETIC_ENVIRONMENTS,
  KINETIC_FOOTPRINT_STATES, planEnvironmentWindow,
} from "../../shared/kineticFootprint";

describe("national Kinetic footprint", () => {
  it("covers the official 18 states exactly once across active environments", () => {
    const states = KINETIC_ENVIRONMENTS.flatMap((env) => env.stateCodes).sort();
    expect(states).toEqual([...KINETIC_FOOTPRINT_STATES].sort());
    expect(new Set(states).size).toBe(18);
    expect(states).not.toContain("CA");
    expect(states).not.toContain("IN");
    expect(states).not.toContain("MI");
  });

  it("splits a daily budget fairly without losing checks", () => {
    const allocations = allocateEnvironmentBudget(50_003, 8);
    expect(allocations.reduce((sum, value) => sum + value, 0)).toBe(50_003);
    expect(Math.max(...allocations) - Math.min(...allocations)).toBeLessThanOrEqual(1);
  });

  it("advances unseen numbers while retaining a bounded overlap", () => {
    expect(planEnvironmentWindow({ cursor: 100_001, dailyBudget: 6_250, overlap: 1_000 })).toEqual({
      startCns: 99_001, endCns: 105_250, overlap: 1_000, newCandidates: 5_250,
    });
  });

  it("rejects states outside the official footprint", () => {
    expect(isKineticFootprintState("nc")).toBe(true);
    expect(isKineticFootprintState("CA")).toBe(false);
  });
});
