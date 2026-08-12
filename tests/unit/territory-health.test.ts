// Territory health and reclaim recommendations.
//
// The load-bearing tests here are the ones that stop the board punishing the
// people who did the work: an area that has been worked through must never be
// labelled underworked, and a reclaim recommendation must require EVERY
// condition rather than a weighted score that can be dragged over the line by
// one of them.

import { describe, expect, it } from "vitest";
import {
  assessTerritory,
  DEFAULT_TERRITORY_THRESHOLDS,
  reclaimRiskScore,
  TERRITORY_STATUS_LABEL,
  TERRITORY_STATUS_TONE,
  TERRITORY_STATUSES,
  type TerritoryFacts,
} from "../../shared/territoryHealth";

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);
const hoursAgo = (h: number) => NOW - h * 3_600_000;
const daysAgo = (d: number) => NOW - d * 86_400_000;

function territory(over: Partial<TerritoryFacts> = {}): TerritoryFacts {
  return {
    territoryId: 1,
    territoryName: "Rock Hill North",
    eligibleDoors: 200,
    assignedDoors: 200,
    unassignedDoors: 0,
    doorsAttempted: 100,
    verifiedVisits: 90,
    everWorkedDoors: 100,
    contacts: 30,
    submittedOrders: 5,
    installedOrders: 4,
    paidOrders: 3,
    freshAssigned: 40,
    freshAttempted: 30,
    activeRepCount: 1,
    lastActivityAtMs: hoursAgo(2),
    assignedAtMs: daysAgo(3),
    callbacksDue: 2,
    openRecoveryCases: 0,
    estimatedCommissionCents: 50000,
    paidCommissionCents: 30000,
    ...over,
  };
}

describe("status labels", () => {
  it("has a label and a tone for every status", () => {
    for (const s of TERRITORY_STATUSES) {
      expect(TERRITORY_STATUS_LABEL[s]).toBeTruthy();
      expect(TERRITORY_STATUS_TONE[s]).toBeTruthy();
    }
  });
});

describe("the finished-area trap", () => {
  it("labels a worked-through area fully worked, never underworked", () => {
    const h = assessTerritory(
      territory({ everWorkedDoors: 195, doorsAttempted: 240, lastActivityAtMs: hoursAgo(60) }),
      NOW,
    );
    expect(h.status).toBe("fully_worked");
    expect(h.reclaimRecommended).toBe(false);
  });

  it("does not recommend reclaim on a finished area that has gone quiet", () => {
    // Quiet for three days because there is nothing left to knock.
    const h = assessTerritory(
      territory({
        everWorkedDoors: 200, doorsAttempted: 260,
        lastActivityAtMs: hoursAgo(72), assignedAtMs: daysAgo(10),
      }),
      NOW,
    );
    expect(h.reclaimRecommended).toBe(false);
    expect(h.status).toBe("fully_worked");
  });
});

describe("small areas", () => {
  it("declines to judge an area below the minimum door count", () => {
    const h = assessTerritory(
      territory({
        eligibleDoors: 9, assignedDoors: 9, everWorkedDoors: 0, doorsAttempted: 0,
        lastActivityAtMs: null, assignedAtMs: daysAgo(30),
      }),
      NOW,
    );
    // A 9-door area at 0% is not a finding.
    expect(h.status).toBe("healthy");
    expect(h.reclaimRecommended).toBe(false);
    expect(h.reasons[0]).toContain("too few");
  });
});

describe("reclaim recommendations", () => {
  const stale = {
    eligibleDoors: 300,
    everWorkedDoors: 24,          // 8%
    doorsAttempted: 26,
    assignedAtMs: daysAgo(4),
    lastActivityAtMs: hoursAgo(36),
    freshAssigned: 60, freshAttempted: 13,
  };

  it("recommends review when every condition holds, with the full case attached", () => {
    const h = assessTerritory(territory(stale), NOW);
    expect(h.status).toBe("reclaim_candidate");
    expect(h.reclaimRecommended).toBe(true);
    expect(h.reclaimRationale).toBeTruthy();
    // The case a manager can put to a person: age, utilization, silence, fresh.
    expect(h.reclaimRationale).toContain("4 days");
    expect(h.reclaimRationale).toContain("8%");
    expect(h.reclaimRationale).toContain("36 hours");
    expect(h.reclaimRationale).toContain("47 newly lit");
    // And it says out loud that nothing moves automatically.
    expect(h.reclaimRationale!.toLowerCase()).toContain("recommendation only");
  });

  it("does NOT recommend when the assignment is too young", () => {
    const h = assessTerritory(territory({ ...stale, assignedAtMs: daysAgo(1) }), NOW);
    expect(h.reclaimRecommended).toBe(false);
  });

  it("does NOT recommend when the rep is still active there", () => {
    const h = assessTerritory(territory({ ...stale, lastActivityAtMs: hoursAgo(2) }), NOW);
    expect(h.reclaimRecommended).toBe(false);
  });

  it("does NOT recommend when utilization is above the floor", () => {
    const h = assessTerritory(territory({ ...stale, everWorkedDoors: 150 }), NOW);
    expect(h.reclaimRecommended).toBe(false);
  });

  it("does NOT recommend for an unassigned area - there is nobody to reclaim from", () => {
    const h = assessTerritory(
      territory({ ...stale, assignedAtMs: null, assignedDoors: 0, unassignedDoors: 300 }),
      NOW,
    );
    expect(h.reclaimRecommended).toBe(false);
  });

  it("recommends when an assigned area has never seen any activity at all", () => {
    const h = assessTerritory(
      territory({ ...stale, lastActivityAtMs: null, everWorkedDoors: 0, doorsAttempted: 0 }),
      NOW,
    );
    expect(h.reclaimRecommended).toBe(true);
    // Says plainly that there is no activity to point at, rather than reporting
    // "0 hours since activity" - which would read as somebody working right now.
    expect(h.reclaimRationale).toContain("No activity has ever been recorded");
  });
});

describe("degraded states", () => {
  it("marks an area stale after the documented silence window", () => {
    const h = assessTerritory(
      territory({
        everWorkedDoors: 100, eligibleDoors: 300,
        lastActivityAtMs: hoursAgo(DEFAULT_TERRITORY_THRESHOLDS.staleHours + 1),
        assignedAtMs: daysAgo(2),
      }),
      NOW,
    );
    expect(h.status).toBe("stale");
  });

  it("marks a high-converting area as such and says it is worth finishing", () => {
    const h = assessTerritory(
      territory({ doorsAttempted: 100, submittedOrders: 20, everWorkedDoors: 100, eligibleDoors: 400 }),
      NOW,
    );
    expect(h.status).toBe("high_conversion");
    expect(h.reasons.join(" ")).toContain("worth finishing");
  });

  it("surfaces a large unassigned pool as an opportunity, not a failure", () => {
    const h = assessTerritory(
      territory({
        eligibleDoors: 500, everWorkedDoors: 200, doorsAttempted: 220,
        unassignedDoors: 250, assignedAtMs: null, lastActivityAtMs: hoursAgo(3),
      }),
      NOW,
    );
    expect(h.status).toBe("high_opportunity");
    expect(h.reclaimRecommended).toBe(false);
  });
});

describe("risk score", () => {
  it("stays inside 0..1 for every input including missing data", () => {
    const cases = [
      { utilizationRate: null, hoursSinceActivity: null, assignmentAgeHours: null, untouchedDoors: 0 },
      { utilizationRate: 0, hoursSinceActivity: 10_000, assignmentAgeHours: 10_000, untouchedDoors: 100_000 },
      { utilizationRate: 1, hoursSinceActivity: 0, assignmentAgeHours: 0, untouchedDoors: 0 },
    ];
    for (const c of cases) {
      const s = reclaimRiskScore(c);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
      expect(Number.isFinite(s)).toBe(true);
    }
  });

  it("ranks a long-idle, unworked area above a busy one", () => {
    const idle = reclaimRiskScore({
      utilizationRate: 0.05, hoursSinceActivity: 120, assignmentAgeHours: 240, untouchedDoors: 300,
    });
    const busy = reclaimRiskScore({
      utilizationRate: 0.8, hoursSinceActivity: 1, assignmentAgeHours: 24, untouchedDoors: 10,
    });
    expect(idle).toBeGreaterThan(busy);
  });
});

describe("safe arithmetic", () => {
  it("returns null rates rather than NaN for an area with no doors", () => {
    const h = assessTerritory(
      territory({ eligibleDoors: 0, doorsAttempted: 0, everWorkedDoors: 0, freshAssigned: 0 }),
      NOW,
    );
    expect(h.utilizationRate).toBeNull();
    expect(h.conversionRate).toBeNull();
    expect(h.freshUtilizationRate).toBeNull();
    expect(h.untouchedDoors).toBe(0);
  });
});
