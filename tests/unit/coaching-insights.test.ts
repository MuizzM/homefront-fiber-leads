// The coaching engine's contract.
//
// Most of these tests pin a NON-firing case. That is deliberate: the expensive
// failure for this feature is not a missed insight, it is a false one - a rep
// getting a "needs coaching" flag they did not earn, from a sample too small to
// mean anything or a team too small to compare against.

import { describe, expect, it } from "vitest";
import {
  buildTeamBaseline,
  generateInsights,
  MIN_DOORS_FOR_CONTACT_RULE,
  MIN_TEAM_FOR_BASELINE,
  type InsightContext,
  type TeamBaseline,
} from "../../shared/coachingInsights";
import { deriveMetrics, emptyFacts, type RepDailyFacts } from "../../shared/repMetrics";

function ctx(facts: Partial<RepDailyFacts>, baseline: TeamBaseline | null, over: Partial<InsightContext> = {}): InsightContext {
  const full = { ...emptyFacts(), ...facts };
  return {
    repId: 1, repName: "Test Rep",
    periodStart: "2026-08-05", periodEnd: "2026-08-11",
    facts: full,
    metrics: deriveMetrics(full),
    baseline,
    personal: null,
    nearbyUnworkedDoors: 0,
    overdueFollowUps: 0,
    hoursSinceLastActivity: 2,
    hasUnstartedTerritory: false,
    ...over,
  };
}

const BASELINE: TeamBaseline = {
  memberCount: 8,
  contactRate: 0.25,
  closeRate: 0.10,
  submissionRate: 0.03,
  installRate: 0.70,
  medianSecondsBetweenDoors: 240,
  doorsPerActiveHour: 12,
  utilizationRate: 0.5,
  callbackCompletionRate: 0.6,
};

const types = (ctxIn: InsightContext) => generateInsights(ctxIn).map((i) => i.insightType);

// ── Rule 1: no rule fires on a small sample ──────────────────────────────────

describe("sample floors", () => {
  it("does not flag a low contact rate on a handful of doors", () => {
    // 4 doors, 0 contacts - a Tuesday, not a coaching need.
    const fired = types(ctx({ doorsAttempted: 4, contacts: 0 }, BASELINE));
    expect(fired).not.toContain("high_activity_low_contact");
  });

  it("does flag it once the sample clears the documented floor", () => {
    const fired = types(ctx(
      { doorsAttempted: MIN_DOORS_FOR_CONTACT_RULE + 10, contacts: 3 },
      BASELINE,
    ));
    expect(fired).toContain("high_activity_low_contact");
  });

  it("does not flag a close-rate problem on very few conversations", () => {
    const fired = types(ctx({ doorsAttempted: 60, contacts: 3, submittedOrders: 0 }, BASELINE));
    expect(fired).not.toContain("high_contact_low_submission");
  });
});

// ── Rule 2: no comparison against a team of two ──────────────────────────────

describe("baseline privacy floor", () => {
  it("fires no comparative rule when there is no baseline", () => {
    const fired = types(ctx({ doorsAttempted: 200, contacts: 2, submittedOrders: 0 }, null));
    expect(fired).not.toContain("high_activity_low_contact");
    expect(fired).not.toContain("high_contact_low_submission");
    expect(fired).not.toContain("verified_activity_no_sales");
  });

  it("refuses to build a baseline from a team below the floor", () => {
    const rows = Array.from({ length: MIN_TEAM_FOR_BASELINE - 1 }, () => ({
      metrics: deriveMetrics({ ...emptyFacts(), doorsAttempted: 50, contacts: 10 }),
    }));
    expect(buildTeamBaseline(rows)).toBeNull();
  });

  it("builds one at the floor", () => {
    const rows = Array.from({ length: MIN_TEAM_FOR_BASELINE }, () => ({
      metrics: deriveMetrics({ ...emptyFacts(), doorsAttempted: 50, contacts: 10 }),
    }));
    const b = buildTeamBaseline(rows);
    expect(b).not.toBeNull();
    expect(b!.memberCount).toBe(MIN_TEAM_FOR_BASELINE);
    expect(b!.contactRate).toBeCloseTo(0.2, 5);
  });

  it("excludes reps with no measurable rate from the median rather than counting them as zero", () => {
    const rows = [
      { metrics: deriveMetrics({ ...emptyFacts(), doorsAttempted: 100, contacts: 30 }) }, // 30%
      { metrics: deriveMetrics({ ...emptyFacts(), doorsAttempted: 100, contacts: 30 }) },
      { metrics: deriveMetrics({ ...emptyFacts(), doorsAttempted: 100, contacts: 30 }) },
      { metrics: deriveMetrics(emptyFacts()) },                                            // no doors
    ];
    const b = buildTeamBaseline(rows)!;
    // The absent rate is skipped, so the median stays 30% rather than collapsing.
    expect(b.contactRate).toBeCloseTo(0.3, 5);
  });
});

// ── Rule 3: an absent rate is not a bad rate ─────────────────────────────────

describe("absent data", () => {
  it("produces nothing at all for a rep with no activity", () => {
    expect(generateInsights(ctx({}, BASELINE))).toHaveLength(0);
  });
});

// ── The diagnostic split the brief calls out by name ─────────────────────────

describe("activity versus conversion", () => {
  it("recommends pitch coaching, not less territory, for verified work with no sales", () => {
    const insights = generateInsights(ctx(
      { doorsAttempted: 150, verifiedDoors: 55, contacts: 45, submittedOrders: 0 },
      BASELINE,
    ));
    const found = insights.find((i) => i.insightType === "verified_activity_no_sales");
    expect(found).toBeDefined();
    expect(found!.severity).toBe("coaching_needed");
    // The explicit anti-reflex: do not take doors away from this rep.
    expect(found!.suggestedAction.toLowerCase()).toContain("objection");
    expect(`${found!.explanation} ${found!.suggestedAction}`.toLowerCase()).toContain("territory");
  });

  it("recommends MORE territory for a rep converting above the team on low volume", () => {
    const insights = generateInsights(ctx(
      {
        doorsAttempted: 40, contacts: 30, submittedOrders: 8,
        activeSeconds: 8 * 3600,   // 5 doors/hour vs a team median of 12
      },
      BASELINE,
    ));
    const found = insights.find((i) => i.insightType === "low_activity_high_conversion");
    expect(found).toBeDefined();
    // Framed as a positive, because it is one.
    expect(found!.severity).toBe("positive");
  });
});

// ── Rule 5: location alone never produces an adverse insight ────────────────

describe("pace", () => {
  const slowFacts = {
    doorsAttempted: 40, contacts: 10, interDoorGapSamples: 20,
    medianSecondsBetweenDoors: 480,   // 8 minutes vs a team median of 4
  };

  it("does not flag slow pace when there is nothing nearby left to knock", () => {
    const fired = types(ctx(slowFacts, BASELINE, { nearbyUnworkedDoors: 0 }));
    expect(fired).not.toContain("slow_pace_between_doors");
  });

  it("flags it as a routing problem when unworked doors were right there", () => {
    const insights = generateInsights(ctx(slowFacts, BASELINE, { nearbyUnworkedDoors: 23 }));
    const found = insights.find((i) => i.insightType === "slow_pace_between_doors");
    expect(found).toBeDefined();
    expect(found!.explanation).toContain("23");
    // Route planning, not discipline.
    expect(found!.suggestedAction.toLowerCase()).toMatch(/street|map|route/);
  });

  it("does not fire on too few measured gaps", () => {
    const fired = types(ctx({ ...slowFacts, interDoorGapSamples: 3 }, BASELINE, { nearbyUnworkedDoors: 50 }));
    expect(fired).not.toContain("slow_pace_between_doors");
  });

  it("treats a long inactive stretch as neutral context, never as a finding", () => {
    const insights = generateInsights(ctx(
      { doorsAttempted: 30, longestInactiveSeconds: 3 * 3600, inactivePeriodCount: 2, activeSeconds: 8 * 3600 },
      BASELINE,
    ));
    const found = insights.find((i) => i.insightType === "long_inactive_period");
    expect(found).toBeDefined();
    expect(found!.severity).toBe("neutral");
    // States plainly that the system cannot tell a break from an appointment.
    expect(found!.explanation.toLowerCase()).toContain("cannot tell");
  });
});

// ── Shape of every insight ───────────────────────────────────────────────────

describe("insight shape", () => {
  const everything = ctx(
    {
      doorsAttempted: 200, verifiedDoors: 120, contacts: 60, interestedLeads: 20,
      submittedOrders: 1, installedOrders: 1, canceledOrders: 0,
      followUps: 20, followUpsCompleted: 2, freshAssigned: 60, freshAttempted: 5,
      eligibleDoors: 300, everWorkedDoors: 100, activeSeconds: 30 * 3600,
      interDoorGapSamples: 40, medianSecondsBetweenDoors: 600,
      longestInactiveSeconds: 4 * 3600, inactivePeriodCount: 3,
    },
    BASELINE,
    { nearbyUnworkedDoors: 80, overdueFollowUps: 12, hasUnstartedTerritory: true },
  );

  it("always carries an action, supporting metrics, a period and a data link", () => {
    const insights = generateInsights(everything);
    expect(insights.length).toBeGreaterThan(0);
    for (const i of insights) {
      expect(i.suggestedAction.trim().length).toBeGreaterThan(10);
      expect(i.supportingMetrics.length).toBeGreaterThan(0);
      expect(i.periodStart).toBe("2026-08-05");
      expect(i.periodEnd).toBe("2026-08-11");
      expect(i.dataLink).toBeTruthy();
    }
  });

  it("caps the list and sorts the most severe first", () => {
    const insights = generateInsights(everything, 4);
    expect(insights.length).toBeLessThanOrEqual(4);
    const order = { urgent: 0, coaching_needed: 1, positive: 2, neutral: 3 } as const;
    for (let i = 1; i < insights.length; i++) {
      expect(order[insights[i].severity]).toBeGreaterThanOrEqual(order[insights[i - 1].severity]);
    }
  });

  it("uses no shaming language in any rule", () => {
    const banned = /lazy|poor performer|failing|unacceptable|excuse|slacking|must improve|warning/i;
    for (const i of generateInsights(everything, 20)) {
      expect(banned.test(i.title), `title: ${i.title}`).toBe(false);
      expect(banned.test(i.explanation), `explanation: ${i.explanation}`).toBe(false);
      expect(banned.test(i.suggestedAction), `action: ${i.suggestedAction}`).toBe(false);
    }
  });

  it("keeps a positive insight visible even when the list is full of problems", () => {
    // A rep with several real problems AND one genuine strength: their orders
    // stick (90% install rate against a team median of 70%).
    const mixed = ctx(
      {
        doorsAttempted: 300, contacts: 45,          // 15% contact rate, below the team
        submittedOrders: 10, installedOrders: 9,    // but the orders that land, land
        followUps: 20, followUpsCompleted: 2,
        freshAssigned: 60, freshAttempted: 5,
        eligibleDoors: 400, everWorkedDoors: 120,
        activeSeconds: 30 * 3600,
        interDoorGapSamples: 40, medianSecondsBetweenDoors: 600,
        longestInactiveSeconds: 4 * 3600, inactivePeriodCount: 3,
      },
      BASELINE,
      { nearbyUnworkedDoors: 80, overdueFollowUps: 12, hasUnstartedTerritory: true },
    );

    // Uncapped, both a problem and a strength are found.
    const all = generateInsights(mixed, 20);
    expect(all.some((i) => i.severity === "coaching_needed")).toBe(true);
    expect(all.some((i) => i.severity === "positive")).toBe(true);

    // Capped to three, severity ordering alone would drop the positive. The
    // engine reserves the last slot for it, so a board of pure red never trains
    // people to stop reading it.
    const capped = generateInsights(mixed, 3);
    expect(capped).toHaveLength(3);
    expect(capped.some((i) => i.severity === "positive")).toBe(true);
  });

  it("does not invent a positive when there genuinely is not one", () => {
    // `everything` is a rep with one sale in 200 doors: nothing here clears any
    // strength threshold, and the engine says so rather than manufacturing
    // encouragement it cannot support with a number.
    const insights = generateInsights(everything, 3);
    expect(insights.some((i) => i.severity === "positive")).toBe(false);
    expect(insights.length).toBe(3);
  });
});

// ── Follow-ups ───────────────────────────────────────────────────────────────

describe("overdue callbacks", () => {
  it("escalates to urgent past ten and needs no team baseline", () => {
    const insights = generateInsights(ctx({ followUps: 20, followUpsCompleted: 5 }, null, { overdueFollowUps: 12 }));
    const found = insights.find((i) => i.insightType === "overdue_follow_ups");
    expect(found).toBeDefined();
    expect(found!.severity).toBe("urgent");
  });

  it("stays quiet on one or two", () => {
    const fired = types(ctx({ followUps: 5 }, BASELINE, { overdueFollowUps: 2 }));
    expect(fired).not.toContain("overdue_follow_ups");
  });
});
