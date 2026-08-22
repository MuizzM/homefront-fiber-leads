import { describe, expect, it } from "vitest";
import {
  BUYER_BASE, BUYER_CAPS, BUYER_MAX, BUYER_MIN, buyerTier, formatDelta, parseBuyerReasons, scoreBuyer,
  type BuyerScoreInput,
} from "../../shared/buyerScore";

const NOW = Date.parse("2026-08-22T12:00:00.000Z");

const open = (over: Partial<BuyerScoreInput> = {}): BuyerScoreInput => ({ leadStatus: "prospect", nowMs: NOW, ...over });

const sum = (r: ReturnType<typeof scoreBuyer>) => Math.round(r.reasons.reduce((s, x) => s + x.delta, 0) * 10) / 10;

describe("scoreBuyer: the sum with caps", () => {
  it("an unknown door is the base, Possible, with only the base line", () => {
    const r = scoreBuyer(open());
    expect(r.score).toBe(BUYER_BASE);
    expect(r.tier).toBe("possible");
    expect(r.reasons).toEqual([{ key: "base", label: "Every door starts here", delta: BUYER_BASE }]);
  });

  it("the canvas door: fresh fiber, homeowner 6 yrs, cable competitor, 2 neighbors, and the reasons add up", () => {
    const r = scoreBuyer(open({
      householdSegmentType: "NEW FIBER", billingStatus: "N",
      isHomeowner: true, yearsAtAddress: 6,
      competitorName: "Spectrum", competitorTech: "Cable",
      neighborSales: 2,
    }));
    // 5.0 + 1.6 + 1.2 + 0.8 + 1.0 = 9.6
    expect(r.score).toBe(9.6);
    expect(r.tier).toBe("likely");
    expect(sum(r)).toBe(r.score);
    expect(r.reasons.map((x) => x.key)).toEqual(["base", "fiber", "homeowner", "competitor", "neighbors"]);
    expect(r.reasons.find((x) => x.key === "competitor")?.label).toBe("On Spectrum cable today");
  });

  it("a recent field verification lifts the fiber signal to its cap and never past it", () => {
    const fresh = scoreBuyer(open({ householdSegmentType: "NEW FIBER", billingStatus: "N", freshConfirmedAt: new Date(NOW - 10 * 86_400_000).toISOString() }));
    expect(fresh.reasons.find((x) => x.key === "fiber")?.delta).toBe(BUYER_CAPS.FIBER_MAX);
    const stale = scoreBuyer(open({ householdSegmentType: "NEW FIBER", billingStatus: "N", freshConfirmedAt: new Date(NOW - 200 * 86_400_000).toISOString() }));
    expect(stale.reasons.find((x) => x.key === "fiber")?.delta).toBe(1.6);
    const future = scoreBuyer(open({ householdSegmentType: "NEW FIBER", billingStatus: "N", freshConfirmedAt: new Date(NOW + 86_400_000).toISOString() }));
    expect(future.reasons.find((x) => x.key === "fiber")?.delta).toBe(1.6);
  });

  it("copper with nothing to sell pulls the door under 5 and reads as Unlikely", () => {
    const r = scoreBuyer(open({ fiberStatus: "copper", techType: "DSL", maxDownloadMbps: 25 }));
    expect(r.score).toBe(3.5);
    expect(r.tier).toBe("unlikely");
    expect(r.reasons[1]).toEqual({ key: "fiber", label: "No fiber to sell here yet", delta: BUYER_CAPS.FIBER_NONE });
  });

  it("already on Kinetic fiber subtracts; a competitor on fiber subtracts; a renter subtracts", () => {
    const kinetic = scoreBuyer(open({ householdSegmentType: "TENURED", billingStatus: "Y" }));
    expect(kinetic.reasons.find((x) => x.key === "fiber")?.delta).toBe(-1.0);
    const compFiber = scoreBuyer(open({ competitorName: "AT&T", competitorTech: "Fiber" }));
    expect(compFiber.reasons.find((x) => x.key === "competitor")?.delta).toBe(BUYER_CAPS.COMPETITOR_FIBER);
    const renter = scoreBuyer(open({ isHomeowner: false, yearsAtAddress: 8 }));
    expect(renter.reasons.find((x) => x.key === "homeowner")).toEqual({ key: "homeowner", label: "Renter likely", delta: BUYER_CAPS.RENTER });
  });

  it("neighbor sales cap at NEIGHBOR_MAX no matter how hot the street is", () => {
    const r = scoreBuyer(open({ neighborSales: 9 }));
    expect(r.reasons.find((x) => x.key === "neighbors")?.delta).toBe(BUYER_CAPS.NEIGHBOR_MAX);
    expect(scoreBuyer(open({ neighborSales: 1 })).reasons.find((x) => x.key === "neighbors")?.label).toBe("A neighbor bought in the last 90 days");
  });

  it("knock history: interested outranks a callback, and not-home knocks floor at NOT_HOME_FLOOR", () => {
    const both = scoreBuyer(open({ leadStatus: "interested", knocks: { notHome: 5, interested: 1, followUp: 1, total: 7 } }));
    const keys = both.reasons.map((x) => x.key);
    expect(keys).toContain("interested");
    expect(keys).not.toContain("follow_up");
    expect(both.reasons.find((x) => x.key === "not_home")?.delta).toBe(BUYER_CAPS.NOT_HOME_FLOOR);
    expect(both.reasons.find((x) => x.key === "not_home")?.label).toBe("Knocked 5 times, nobody home");
    const cb = scoreBuyer(open({ leadStatus: "follow_up", lastOutcome: "callback" }));
    expect(cb.reasons.find((x) => x.key === "follow_up")?.delta).toBe(BUYER_CAPS.FOLLOW_UP);
  });

  it("clamps to the 1.0 to 10.0 scale and keeps one decimal", () => {
    const low = scoreBuyer(open({ fiberStatus: "no_service", isHomeowner: false, competitorName: "X", competitorTech: "fiber", knocks: { notHome: 9, interested: 0, followUp: 0, total: 9 } }));
    // Every negative signal at its floor: 5.0 - 1.5 - 0.8 - 0.4 - 0.9. The
    // caps keep the worst open door above BUYER_MIN, which is the point: the
    // scale has room for a fitted model to push lower without a contract change.
    expect(low.score).toBe(1.4);
    expect(low.score).toBeGreaterThanOrEqual(BUYER_MIN);
    const high = scoreBuyer(open({
      householdSegmentType: "NEW FIBER", billingStatus: "N", freshConfirmedAt: new Date(NOW - 86_400_000).toISOString(),
      isHomeowner: true, yearsAtAddress: 10, competitorTech: "cable", neighborSales: 4, leadStatus: "interested",
    }));
    expect(high.score).toBe(BUYER_MAX);
    expect(String(high.score).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("removes closed and blocked doors instead of ranking them low", () => {
    expect(scoreBuyer(open({ leadStatus: "sold" }))).toEqual({ score: null, tier: "none", reasons: [], excluded: "closed" });
    expect(scoreBuyer(open({ leadStatus: "not_interested", lastOutcome: "already_customer" })).excluded).toBe("closed");
    expect(scoreBuyer(open({ doNotKnock: 1, householdSegmentType: "NEW FIBER", billingStatus: "N" })).excluded).toBe("do_not_knock");
  });

  it("is deterministic and ignores junk numbers", () => {
    const a = scoreBuyer(open({ neighborSales: Number.NaN, yearsAtAddress: -3, maxDownloadMbps: Number.POSITIVE_INFINITY as unknown as number }));
    const b = scoreBuyer(open({ neighborSales: Number.NaN, yearsAtAddress: -3, maxDownloadMbps: Number.POSITIVE_INFINITY as unknown as number }));
    expect(a).toEqual(b);
    expect(a.score).toBe(BUYER_BASE);
  });
});

describe("tier, reasons parsing and delta formatting", () => {
  it("tiers follow the published bands", () => {
    expect(buyerTier(8)).toBe("likely");
    expect(buyerTier(7.9)).toBe("possible");
    expect(buyerTier(5)).toBe("possible");
    expect(buyerTier(4.9)).toBe("unlikely");
    expect(buyerTier(null)).toBe("none");
    expect(buyerTier(Number.NaN)).toBe("none");
  });

  it("parseBuyerReasons accepts only well-formed rows and never throws", () => {
    expect(parseBuyerReasons(null)).toEqual([]);
    expect(parseBuyerReasons("not json")).toEqual([]);
    expect(parseBuyerReasons(JSON.stringify([{ key: "base", label: "x", delta: 5 }, { key: 1 }, "junk"]))).toEqual([{ key: "base", label: "x", delta: 5 }]);
  });

  it("formatDelta uses an ASCII hyphen and a plus sign", () => {
    expect(formatDelta(1.6)).toBe("+1.6");
    expect(formatDelta(-0.5)).toBe("-0.5");
    expect(formatDelta(5, { signed: false })).toBe("5.0");
  });
});
