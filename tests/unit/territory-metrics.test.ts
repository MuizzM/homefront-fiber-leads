// What an area's numbers mean — decided in one place, with one denominator.
//
// The failure this file guards against is not a wrong sum. It is two screens
// disagreeing about the same area because each re-derived "sold" from a status
// check, or a rate quietly changing meaning when a status was added.
import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_UNSUPPORTED,
  computeTerritoryMetrics,
  isContactStatus,
  isDisqualified,
  knockSummary,
  safeRate,
  type LeadMetricInput,
} from "@shared/territoryMetrics";

const door = (over: Partial<LeadMetricInput> = {}): LeadMetricInput =>
  ({ status: "prospect", everKnocked: false, ...over });

describe("division by zero is a decision, not an accident", () => {
  it("returns 0% rather than NaN on an empty area", () => {
    // A freshly drawn area has no doors. "NaN%" on a card reads as a crash.
    const m = computeTerritoryMetrics([]);
    expect(m.penetrationRate).toBe(0);
    expect(m.knockCompletionRate).toBe(0);
    expect(m.contactRate).toBe(0);
    expect(Number.isNaN(m.penetrationRate)).toBe(false);
  });

  it("returns 0% rather than Infinity", () => {
    expect(safeRate(5, 0)).toBe(0);
    expect(Number.isFinite(safeRate(5, 0))).toBe(true);
  });

  it("survives junk input instead of poisoning a card", () => {
    expect(safeRate(NaN, 10)).toBe(0);
    expect(safeRate(10, NaN)).toBe(0);
    expect(safeRate(10, -1)).toBe(0);
  });

  it("reports contact rate as 0 when nothing has been knocked yet", () => {
    // contact_rate divides by doors knocked, which is legitimately 0 on day one.
    const m = computeTerritoryMetrics([door(), door()]);
    expect(m.contactRate).toBe(0);
  });
});

describe("unique doors knocked never falls", () => {
  it("counts a door once however many times a rep goes back", () => {
    const m = computeTerritoryMetrics([door({ everKnocked: true, attempts: 3 })]);
    expect(m.knockedCount).toBe(1);
    expect(m.attemptCount).toBe(3);
  });

  it("keeps a door knocked after its disposition moves on", () => {
    // not_home → sold. If knocked-ness were read off the status, the door would
    // leave the not_home bucket and unique-knocked would DROP, which cannot
    // happen: knocking is a thing that occurred, not a thing that is true now.
    const notHome = computeTerritoryMetrics([door({ everKnocked: true, status: "prospect" })]);
    const later = computeTerritoryMetrics([door({ everKnocked: true, status: "sold", everContacted: true })]);
    expect(notHome.knockedCount).toBe(1);
    expect(later.knockedCount).toBe(1);
    expect(later.soldCount).toBe(1);
    expect(later.notHomeCount).toBe(0);
  });

  it("reports attempts separately so repeat visits do not inflate coverage", () => {
    const m = computeTerritoryMetrics([
      door({ everKnocked: true, attempts: 4 }),
      door({ everKnocked: true, attempts: 1 }),
      door(),
    ]);
    expect(m.knockedCount).toBe(2);   // two doors
    expect(m.attemptCount).toBe(5);   // five knocks
  });
});

describe("one denominator", () => {
  it("removes unavailable and disqualified doors from the base", () => {
    // available_base = total − unavailable − disqualified
    const m = computeTerritoryMetrics([
      door(), door(),
      door({ doNotKnock: true }),
      door({ status: "not_interested", everKnocked: true, everContacted: true }),
    ]);
    expect(m.totalLeads).toBe(4);
    expect(m.unavailableCount).toBe(1);
    expect(m.disqualifiedCount).toBe(1);
    expect(m.availableBase).toBe(2);
  });

  it("does not remove one door twice when it is both", () => {
    // A do-not-knock door that is also a terminal no would otherwise be
    // subtracted twice, pushing the base below the truth and inflating rates.
    const m = computeTerritoryMetrics([
      door({ doNotKnock: true, status: "not_interested" }),
      door(),
    ]);
    expect(m.availableBase).toBe(1);
    expect(m.unavailableCount + m.disqualifiedCount).toBe(1);
  });

  it("computes penetration against the base, not the total", () => {
    // 1 sold out of 2 available (4 total) = 50%, not 25%. Mixing denominators
    // is the specific thing that makes two cards disagree.
    const m = computeTerritoryMetrics([
      door({ status: "sold", everKnocked: true, everContacted: true }),
      door({ everKnocked: true }),
      door({ doNotKnock: true }),
      door({ status: "not_interested", everKnocked: true, everContacted: true }),
    ]);
    expect(m.availableBase).toBe(2);
    expect(m.penetrationRate).toBe(50);
  });

  it("computes knock completion against the same base", () => {
    const m = computeTerritoryMetrics([
      door({ everKnocked: true }), door({ everKnocked: true }),
      door(), door(),
    ]);
    expect(m.knockCompletionRate).toBe(50);
  });

  it("computes contact rate against doors KNOCKED, not the base", () => {
    // Of 2 doors knocked, 1 answered → 50%. The unknocked door is not a failure
    // to make contact; it is simply not yet attempted.
    const m = computeTerritoryMetrics([
      door({ everKnocked: true, everContacted: true, status: "interested" }),
      door({ everKnocked: true, everContacted: false }),
      door(),
    ]);
    expect(m.knockedCount).toBe(2);
    expect(m.contactRate).toBe(50);
  });

  it("derives untouched from the base minus doors knocked", () => {
    const m = computeTerritoryMetrics([
      door({ everKnocked: true }), door(), door(),
      door({ doNotKnock: true }),
    ]);
    expect(m.availableBase).toBe(3);
    expect(m.untouchedCount).toBe(2);
  });

  it("never reports a negative untouched count", () => {
    // A knocked door that later becomes unavailable would push it below zero.
    const m = computeTerritoryMetrics([door({ everKnocked: true, doNotKnock: true })]);
    expect(m.availableBase).toBe(0);
    expect(m.untouchedCount).toBe(0);
  });
});

describe("which status means what", () => {
  it("treats a terminal no as disqualified, agreeing with leadQualify", () => {
    // Two definitions of "dead lead" would put two denominators on one card.
    expect(isDisqualified("not_interested")).toBe(true);
    for (const s of ["prospect", "sold", "interested", "follow_up", "contacted"]) {
      expect(isDisqualified(s)).toBe(false);
    }
  });

  it("counts someone answering as contact, and nobody home as not", () => {
    for (const s of ["sold", "interested", "follow_up", "contacted"]) expect(isContactStatus(s)).toBe(true);
    expect(isContactStatus("prospect")).toBe(false);      // knocked, nobody home
    expect(isContactStatus(null)).toBe(false);
  });

  it("puts a knocked door with nobody home in not_home, not untouched", () => {
    const m = computeTerritoryMetrics([door({ everKnocked: true, everContacted: false })]);
    expect(m.notHomeCount).toBe(1);
    expect(m.untouchedCount).toBe(0);
  });

  it("reports appointments as 0 and says why, rather than mis-mapping interested", () => {
    // There is no appointment disposition in this taxonomy. Folding `interested`
    // in would overstate the funnel AND corrupt contact_rate.
    expect(APPOINTMENT_UNSUPPORTED).toBe(true);
    const m = computeTerritoryMetrics([door({ status: "interested", everKnocked: true, everContacted: true })]);
    expect(m.appointmentCount).toBe(0);
    expect(m.contactedCount).toBe(1);
  });
});

describe("the line a rep reads before walking", () => {
  it("says how many of the workable doors are done", () => {
    expect(knockSummary({ knockedCount: 24, availableBase: 80 })).toBe("24 of 80 knocked");
  });

  it("counts against workable doors, not the raw total", () => {
    const m = computeTerritoryMetrics([
      ...Array.from({ length: 24 }, () => door({ everKnocked: true })),
      ...Array.from({ length: 56 }, () => door()),
      door({ doNotKnock: true }),
    ]);
    expect(knockSummary(m)).toBe("24 of 80 knocked");
    expect(m.untouchedCount).toBe(56);
  });
});
