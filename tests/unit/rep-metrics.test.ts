// The metric engine's contract. Every test here pins a decision that, if it
// silently reversed, would put a wrong number in front of a manager deciding
// whether somebody is working hard enough.

import { describe, expect, it } from "vitest";
import {
  aggregateFacts,
  buildFunnel,
  computeDailyFacts,
  computeDistance,
  computePace,
  computeShiftTime,
  deriveMetrics,
  emptyFacts,
  formatDuration,
  formatRate,
  INTER_DOOR_GAP_CAP_MS,
  isAppointment,
  median,
  perHour,
  rate,
  splitTerritoryTime,
  type DoorEventInput,
  type RepDailyFacts,
} from "../../shared/repMetrics";

const DAY = Date.UTC(2026, 7, 11);
const at = (h: number, m: number) => DAY + h * 3_600_000 + m * 60_000;

function door(h: number, m: number, over: Partial<DoorEventInput> = {}): DoorEventInput {
  return {
    leadId: over.leadId ?? Math.round(at(h, m) / 60_000),
    atMs: at(h, m),
    outcome: "not_home",
    wasHome: false,
    verification: "verified",
    superseded: false,
    callbackDate: null,
    territoryId: 1,
    distanceFromLeadM: 10,
    dwellSeconds: null,
    ...over,
  };
}

// ── Rule 1: an absent rate is null, never zero ───────────────────────────────

describe("safe denominators", () => {
  it("returns null rather than zero when the denominator is zero", () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(5, 0)).toBeNull();
    expect(perHour(10, 0)).toBeNull();
    expect(median([])).toBeNull();
  });

  it("renders an absent rate as a dash, not 0%", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(0)).toBe("0%");
  });

  it("gives a rep with no doors an undefined contact rate, not a bad one", () => {
    const m = deriveMetrics(emptyFacts());
    expect(m.contactRate).toBeNull();
    expect(m.closeRate).toBeNull();
    expect(m.installRate).toBeNull();
    expect(m.doorsPerActiveHour).toBeNull();
  });

  it("never returns NaN or Infinity from any derived metric", () => {
    const f = { ...emptyFacts(), doorsAttempted: 3, contacts: 1 };
    for (const [key, value] of Object.entries(deriveMetrics(f))) {
      if (typeof value === "number") {
        expect(Number.isFinite(value), `${key} was ${value}`).toBe(true);
      }
    }
  });
});

// ── Rule 3: pace excludes breaks ─────────────────────────────────────────────

describe("time between doors", () => {
  const shift = [{ startMs: at(8, 0), endMs: at(18, 0) }];

  it("measures gaps between consecutive doors in the same shift", () => {
    const pace = computePace([door(9, 0), door(9, 4), door(9, 10)], shift);
    expect(pace.gapsSeconds).toEqual([240, 360]);
    expect(pace.medianSecondsBetweenDoors).toBe(300);
    expect(pace.averageSecondsBetweenDoors).toBe(300);
  });

  it("excludes a lunch break from pace and counts it as inactivity instead", () => {
    // 9:00, 9:05, then an hour off, then 10:10 and 10:15.
    const pace = computePace(
      [door(9, 0), door(9, 5), door(10, 10), door(10, 15)],
      shift,
    );
    // Only the two 5-minute gaps count as door-to-door movement.
    expect(pace.gapsSeconds).toEqual([300, 300]);
    expect(pace.medianSecondsBetweenDoors).toBe(300);
    // The 65-minute break is inactivity, not a slow walk.
    expect(pace.inactivePeriodCount).toBe(1);
    expect(pace.longestInactiveSeconds).toBe(65 * 60);
  });

  it("does not treat an overnight gap as time between doors", () => {
    const twoShifts = [
      { startMs: at(8, 0), endMs: at(17, 0) },
      { startMs: at(32, 0), endMs: at(41, 0) },  // next day
    ];
    const pace = computePace([door(16, 0), door(33, 0)], twoShifts);
    // One door in each shift, so there is no in-shift pair at all.
    expect(pace.gapsSeconds).toEqual([]);
    expect(pace.medianSecondsBetweenDoors).toBeNull();
    expect(pace.inactivePeriodCount).toBe(0);
  });

  it("still measures pace when no shift was recorded", () => {
    // A rep whose clock-in failed still walked the street.
    const pace = computePace([door(9, 0), door(9, 6)], []);
    expect(pace.gapsSeconds).toEqual([360]);
  });

  it("sorts events defensively so an out-of-order offline flush is not a negative gap", () => {
    const pace = computePace([door(9, 10), door(9, 0), door(9, 4)], shift);
    expect(pace.gapsSeconds).toEqual([240, 360]);
  });

  it("puts the cap between door-to-door movement and a break where documented", () => {
    const justUnder = computePace(
      [door(9, 0), { ...door(9, 0), atMs: at(9, 0) + INTER_DOOR_GAP_CAP_MS - 1000, leadId: 99 }],
      shift,
    );
    expect(justUnder.gapsSeconds).toHaveLength(1);
    const justOver = computePace(
      [door(9, 0), { ...door(9, 0), atMs: at(9, 0) + INTER_DOOR_GAP_CAP_MS + 1000, leadId: 99 }],
      shift,
    );
    expect(justOver.gapsSeconds).toHaveLength(0);
    expect(justOver.inactivePeriodCount).toBe(1);
  });
});

// ── Rule 4: median leads ─────────────────────────────────────────────────────

describe("median versus average", () => {
  it("keeps the median stable when one long leg moves the mean", () => {
    const shift = [{ startMs: at(8, 0), endMs: at(18, 0) }];
    const events = [door(9, 0), door(9, 4), door(9, 8), door(9, 12), door(9, 52)];
    const pace = computePace(events, shift);
    // Gaps: 4, 4, 4, 40 minutes. The 40 is still under the 45-minute cap, so it
    // is counted - and this is exactly the case the median exists for.
    expect(pace.medianSecondsBetweenDoors).toBe(240);
    expect(pace.averageSecondsBetweenDoors).toBeGreaterThan(700);
  });
});

// ── Shift time ───────────────────────────────────────────────────────────────

describe("active shift time", () => {
  it("merges overlapping shifts so a missed clock-out cannot double the day", () => {
    const r = computeShiftTime(
      [{ startMs: at(8, 0), endMs: at(16, 0) }, { startMs: at(12, 0), endMs: at(18, 0) }],
      at(20, 0),
    );
    expect(r.activeSeconds).toBe(10 * 3600); // 08:00-18:00, not 14 hours
  });

  it("caps an open shift at now rather than running it forever", () => {
    const r = computeShiftTime([{ startMs: at(8, 0), endMs: null }], at(11, 30));
    expect(r.activeSeconds).toBe(3.5 * 3600);
  });

  it("reports zero, not negative, for a shift that ends before it starts", () => {
    const r = computeShiftTime([{ startMs: at(10, 0), endMs: at(9, 0) }], at(12, 0));
    expect(r.activeSeconds).toBe(0);
  });
});

// ── Distance ─────────────────────────────────────────────────────────────────

describe("distance", () => {
  const p = (mins: number, lat: number, lng: number) => ({
    atMs: at(9, mins), lat, lng, accuracyM: 10, insideTerritory: true,
  });

  it("sums the path over accepted fixes", () => {
    // Roughly 111 m per 0.001 degree of latitude.
    const d = computeDistance([p(0, 35.0, -81.0), p(5, 35.001, -81.0)]);
    expect(d.totalMeters).toBeGreaterThan(100);
    expect(d.totalMeters).toBeLessThan(120);
    expect(d.rejectedPoints).toBe(0);
  });

  it("drops a leg implying an impossible speed instead of adding a teleport", () => {
    const d = computeDistance([
      p(0, 35.0, -81.0),
      p(1, 36.0, -81.0),   // ~111 km in 60 seconds
      p(2, 36.001, -81.0),
    ]);
    expect(d.rejectedPoints).toBe(1);
    expect(d.totalMeters).toBeLessThan(200);
  });

  it("rejects coordinates outside the world rather than clamping them", () => {
    const d = computeDistance([
      { atMs: at(9, 0), lat: 999, lng: -81, accuracyM: 10, insideTerritory: null },
      p(1, 35.0, -81.0),
    ]);
    expect(d.totalMeters).toBe(0);
  });
});

// ── Territory time ───────────────────────────────────────────────────────────

describe("territory time split", () => {
  it("attributes a segment to the verdict at its start", () => {
    const pts = [
      { atMs: at(9, 0), lat: 35, lng: -81, accuracyM: 10, insideTerritory: true },
      { atMs: at(9, 10), lat: 35, lng: -81, accuracyM: 10, insideTerritory: false },
      { atMs: at(9, 20), lat: 35, lng: -81, accuracyM: 10, insideTerritory: false },
    ];
    const r = splitTerritoryTime(pts, 3600);
    expect(r.insideSeconds).toBe(600);
    expect(r.outsideSeconds).toBe(600);
    expect(r.unknownSeconds).toBe(3600 - 1200);
  });

  it("puts unknown verdicts in neither bucket", () => {
    const pts = [
      { atMs: at(9, 0), lat: 35, lng: -81, accuracyM: 10, insideTerritory: null },
      { atMs: at(9, 10), lat: 35, lng: -81, accuracyM: 10, insideTerritory: null },
    ];
    const r = splitTerritoryTime(pts, 3600);
    expect(r.insideSeconds).toBe(0);
    expect(r.outsideSeconds).toBe(0);
    expect(r.unknownSeconds).toBe(3600);
  });

  it("never reports more territory time than the rep was clocked in for", () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({
      atMs: at(9, i * 10), lat: 35, lng: -81, accuracyM: 10, insideTerritory: true,
    }));
    const r = splitTerritoryTime(pts, 600); // only 10 minutes clocked in
    expect(r.insideSeconds + r.outsideSeconds).toBeLessThanOrEqual(600);
  });
});

// ── Daily facts ──────────────────────────────────────────────────────────────

const ASSIGNMENT = {
  assignedDoors: 100, eligibleDoors: 95, doNotKnockDoors: 5,
  freshAssigned: 20, freshAttempted: 4, everWorkedDoors: 40,
  oldestAssignedAtMs: at(-24, 0), firstActivityAtMs: at(9, 0),
};
const ORDERS = {
  submittedOrders: 2, acceptedOrders: 1, installedOrders: 1, paidOrders: 1,
  canceledOrders: 0, chargebacks: 0, followUpsCreated: 3, followUpsCompleted: 1,
  ordersFromFollowUp: 1, estimatedCommissionCents: 15000, paidCommissionCents: 10000,
};

describe("daily facts", () => {
  it("separates attempts from distinct doors visited", () => {
    const f = computeDailyFacts({
      events: [door(9, 0, { leadId: 1 }), door(9, 5, { leadId: 1 }), door(9, 10, { leadId: 2 })],
      shifts: [{ startMs: at(8, 0), endMs: at(17, 0) }],
      points: [], assignment: ASSIGNMENT, orders: ORDERS, nowMs: at(18, 0),
    });
    expect(f.doorsAttempted).toBe(3);
    expect(f.doorsVisited).toBe(2);
    // Going back to lead 1 is a revisit.
    expect(f.revisits).toBe(1);
  });

  it("counts a superseded knock as an attempt but not as an outcome", () => {
    const f = computeDailyFacts({
      events: [
        door(9, 0, { leadId: 1, outcome: "sold", wasHome: true }),
        door(9, 5, { leadId: 2, outcome: "sold", wasHome: true, superseded: true }),
      ],
      shifts: [], points: [], assignment: ASSIGNMENT, orders: ORDERS, nowMs: at(18, 0),
    });
    expect(f.doorsAttempted).toBe(2);
    // Only the non-superseded knock produced a contact.
    expect(f.contacts).toBe(1);
  });

  it("counts a booked callback as an appointment and a mood as not one", () => {
    expect(isAppointment({ outcome: "follow_up", callbackDate: "2026-08-14" })).toBe(true);
    expect(isAppointment({ outcome: "callback", callbackDate: "2026-08-14" })).toBe(true);
    // `interested` with no booked date is not an appointment - the decision
    // shared/territoryMetrics already made, and this module does not reopen.
    expect(isAppointment({ outcome: "interested", callbackDate: null })).toBe(false);
    expect(isAppointment({ outcome: "follow_up", callbackDate: null })).toBe(false);
  });

  it("only counts a door as verified when the fix placed the rep there", () => {
    const f = computeDailyFacts({
      events: [
        door(9, 0, { leadId: 1, verification: "verified" }),
        door(9, 5, { leadId: 2, verification: "unavailable" }),
        door(9, 9, { leadId: 3, verification: "outside_radius" }),
      ],
      shifts: [], points: [], assignment: ASSIGNMENT, orders: ORDERS, nowMs: at(18, 0),
    });
    expect(f.verifiedDoors).toBe(1);
    // ...but every one of them still counts as an attempt. A weak GPS fix is
    // never treated as a door the rep did not knock.
    expect(f.doorsAttempted).toBe(3);
  });

  it("takes do-not-knock doors out of the utilization denominator", () => {
    const f = computeDailyFacts({
      events: [], shifts: [], points: [], assignment: ASSIGNMENT, orders: ORDERS, nowMs: at(18, 0),
    });
    expect(f.eligibleDoors).toBe(95);
    expect(f.doNotKnockRecords).toBe(5);
    const m = deriveMetrics(f);
    expect(m.utilizationRate).toBeCloseTo(40 / 95, 5);
  });
});

// ── Rule 2: rates are never averaged ─────────────────────────────────────────

describe("aggregation across days", () => {
  const day = (over: Partial<RepDailyFacts>): RepDailyFacts => ({ ...emptyFacts(), ...over });

  it("recomputes a period rate from summed counts, not from a mean of daily rates", () => {
    const days = [
      day({ doorsAttempted: 1, contacts: 1 }),      // 100% on a sample of one
      day({ doorsAttempted: 99, contacts: 9 }),     // ~9% on a real sample
    ];
    const folded = aggregateFacts(days);
    expect(folded.doorsAttempted).toBe(100);
    expect(folded.contacts).toBe(10);
    const m = deriveMetrics(folded);
    // The honest answer is 10%. A mean of the two daily rates would be ~55%.
    expect(m.contactRate).toBeCloseTo(0.1, 5);
  });

  it("takes the LATEST value for stock figures rather than summing them", () => {
    const folded = aggregateFacts([
      day({ assignedDoors: 80, eligibleDoors: 75, everWorkedDoors: 10 }),
      day({ assignedDoors: 80, eligibleDoors: 75, everWorkedDoors: 30 }),
    ]);
    // A rep with 80 assigned doors for two days holds 80, not 160.
    expect(folded.assignedDoors).toBe(80);
    expect(folded.eligibleDoors).toBe(75);
    expect(folded.everWorkedDoors).toBe(30);
  });

  it("keeps the longest inactive period as a maximum, not a sum", () => {
    const folded = aggregateFacts([
      day({ longestInactiveSeconds: 1800 }),
      day({ longestInactiveSeconds: 3600 }),
    ]);
    expect(folded.longestInactiveSeconds).toBe(3600);
  });

  it("returns an empty fact row for an empty period rather than throwing", () => {
    expect(aggregateFacts([])).toEqual(emptyFacts());
  });

  it("computes a weighted average gap from the stored sum and sample count", () => {
    const folded = aggregateFacts([
      day({ interDoorGapSecondsTotal: 600, interDoorGapSamples: 2 }),   // 300s avg
      day({ interDoorGapSecondsTotal: 6000, interDoorGapSamples: 10 }), // 600s avg
    ]);
    const m = deriveMetrics(folded);
    // 6600 / 12 = 550, the true weighted average. A mean of the daily averages
    // would give 450.
    expect(m.averageSecondsBetweenDoors).toBe(550);
  });
});

// ── Direction and chargeback basis ───────────────────────────────────────────

describe("derived metrics", () => {
  it("uses paid orders as the chargeback denominator by default and honours the override", () => {
    const f = { ...emptyFacts(), submittedOrders: 10, paidOrders: 4, chargebacks: 1 };
    expect(deriveMetrics(f).chargebackRate).toBeCloseTo(0.25, 5);
    expect(deriveMetrics(f, { chargebackBasis: "submitted" }).chargebackRate).toBeCloseTo(0.1, 5);
  });

  it("keeps utilization a stock, so finishing an area yesterday still counts today", () => {
    // No doors attempted TODAY, but 90 of 100 eligible worked historically.
    const f = { ...emptyFacts(), eligibleDoors: 100, everWorkedDoors: 90, doorsAttempted: 0 };
    const m = deriveMetrics(f);
    expect(m.utilizationRate).toBeCloseTo(0.9, 5);
    expect(m.untouchedAssignedDoors).toBe(10);
  });

  it("bounds the active work ratio to 0..1", () => {
    const f = { ...emptyFacts(), activeSeconds: 3600, longestInactiveSeconds: 7200 };
    expect(deriveMetrics(f).activeWorkRatio).toBe(0);
  });
});

// ── Funnel ───────────────────────────────────────────────────────────────────

describe("funnel", () => {
  it("computes each stage's conversion from the one above it", () => {
    const stages = buildFunnel({
      ...emptyFacts(),
      eligibleDoors: 100, doorsAttempted: 50, contacts: 20, interestedLeads: 10,
      appointments: 5, submittedOrders: 4, installedOrders: 3, paidOrders: 2,
    });
    expect(stages.map((s) => s.value)).toEqual([100, 50, 20, 10, 5, 4, 3, 2]);
    expect(stages[0].fromPrevious).toBeNull();
    expect(stages[1].fromPrevious).toBeCloseTo(0.5, 5);
    expect(stages[2].fromPrevious).toBeCloseTo(0.4, 5);
  });

  it("returns a null conversion rather than a divide-by-zero when a stage is empty", () => {
    const stages = buildFunnel(emptyFacts());
    for (const s of stages.slice(1)) expect(s.fromPrevious).toBeNull();
  });
});

// ── Formatting ───────────────────────────────────────────────────────────────

describe("formatting", () => {
  it("changes unit with magnitude", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(300)).toBe("5m 00s");
    expect(formatDuration(3900)).toBe("1h 05m");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
  });
});
