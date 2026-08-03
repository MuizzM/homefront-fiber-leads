// A campaign is a promise a manager makes to the floor: "$75 a sale until 6 PM,
// go". These tests pin the two things that make such a promise trustworthy —
// the progress a rep watches all afternoon agrees with the award logic, and the
// money is bounded so a hot Saturday cannot write an open cheque.
import { describe, expect, it } from "vitest";
import {
  campaignProgress, describeTrigger, evaluateCampaign, hour12, isCampaignLive,
  triggerMet, validateCampaignInput,
  type RepWindowCounters, type SpiffCampaign,
} from "@shared/spiffCampaign";

const NOON = Date.UTC(2026, 7, 4, 16, 0, 0);           // inside every window below
const START = Date.UTC(2026, 7, 4, 12, 0, 0);
const END = Date.UTC(2026, 7, 4, 22, 0, 0);

const campaign = (over: Partial<SpiffCampaign> = {}): SpiffCampaign => ({
  id: 1, name: "Power Hour", description: "",
  startsAtMs: START, endsAtMs: END,
  trigger: { kind: "per_sale" },
  rewardCents: 7500,
  eligibleRepIds: null,
  perRepCapCents: 0, campaignCapCents: 0,
  status: "live",
  ...over,
});

const counters = (over: Partial<RepWindowCounters> = {}): RepWindowCounters => ({
  repId: 7,
  knocksInWindow: 0, knocksBeforeCutoffToday: 0,
  salesInWindow: 0, salesToday: 0, firstSaleHourLocalToday: null,
  streakDaysMeetingBar: 0,
  awardedToRepCents: 0, awardedTotalCents: 0,
  ...over,
});

describe("triggerMet — what earns the bonus", () => {
  it("per_sale needs a sale in the window", () => {
    expect(triggerMet({ kind: "per_sale" }, counters())).toBe(false);
    expect(triggerMet({ kind: "per_sale" }, counters({ salesInWindow: 1 }))).toBe(true);
  });

  it("knocks_by_time counts knocks BEFORE the cutoff, not knocks in total", () => {
    // The effort trigger: winnable by anyone who walks, which is the point —
    // a rep having a cold day still has something in reach at 10 AM.
    const t = { kind: "knocks_by_time", knocks: 40, byHourLocal: 12 } as const;
    expect(triggerMet(t, counters({ knocksInWindow: 90, knocksBeforeCutoffToday: 39 }))).toBe(false);
    expect(triggerMet(t, counters({ knocksBeforeCutoffToday: 40 }))).toBe(true);
  });

  it("sale_by_time is strictly before the hour", () => {
    const t = { kind: "sale_by_time", byHourLocal: 15 } as const;
    expect(triggerMet(t, counters({ firstSaleHourLocalToday: 15 }))).toBe(false);
    expect(triggerMet(t, counters({ firstSaleHourLocalToday: 14 }))).toBe(true);
    expect(triggerMet(t, counters({ firstSaleHourLocalToday: null }))).toBe(false);
  });

  it("sales_in_day and knock_streak read their own counters", () => {
    expect(triggerMet({ kind: "sales_in_day", sales: 2 }, counters({ salesToday: 1 }))).toBe(false);
    expect(triggerMet({ kind: "sales_in_day", sales: 2 }, counters({ salesToday: 2 }))).toBe(true);
    const streak = { kind: "knock_streak", days: 3, knocksPerDay: 25 } as const;
    expect(triggerMet(streak, counters({ streakDaysMeetingBar: 2 }))).toBe(false);
    expect(triggerMet(streak, counters({ streakDaysMeetingBar: 3 }))).toBe(true);
  });
});

describe("progress and award never disagree", () => {
  // The property that matters: a rep watching the card must not be told they
  // qualified while the award logic refuses to pay, or the reverse.
  const triggers = [
    { kind: "per_sale" },
    { kind: "knocks_by_time", knocks: 40, byHourLocal: 12 },
    { kind: "sale_by_time", byHourLocal: 15 },
    { kind: "sales_in_day", sales: 2 },
    { kind: "knock_streak", days: 3, knocksPerDay: 25 },
  ] as const;

  const states = [
    counters(),
    counters({ salesInWindow: 1, salesToday: 1, firstSaleHourLocalToday: 14 }),
    counters({ knocksBeforeCutoffToday: 40 }),
    counters({ salesToday: 3, salesInWindow: 3, firstSaleHourLocalToday: 9 }),
    counters({ streakDaysMeetingBar: 5 }),
  ];

  for (const trigger of triggers) {
    for (const [i, state] of states.entries()) {
      it(`${trigger.kind} / state ${i}: the card and the award agree`, () => {
        const c = campaign({ trigger });
        const shown = campaignProgress(c, state, NOON).met;
        const paid = "award" in evaluateCampaign(c, state, NOON);
        expect(paid).toBe(shown);
      });
    }
  }
});

describe("campaignProgress — the card a rep stares at", () => {
  it("counts down in the trigger's own unit, with a concrete next step", () => {
    const c = campaign({ trigger: { kind: "knocks_by_time", knocks: 40, byHourLocal: 12 } });
    const p = campaignProgress(c, counters({ knocksBeforeCutoffToday: 18 }), NOON);
    expect(p.current).toBe(18);
    expect(p.target).toBe(40);
    expect(p.pct).toBe(45);
    expect(p.met).toBe(false);
    expect(p.headline).toBe("18 of 40 knocks before 12 PM");
    expect(p.nextStep).toBe("22 more knocks before 12 PM.");
  });

  it("says nothing further is needed once earned", () => {
    const c = campaign({ trigger: { kind: "sales_in_day", sales: 2 } });
    const p = campaignProgress(c, counters({ salesToday: 2 }), NOON);
    expect(p.met).toBe(true);
    expect(p.nextStep).toBe("");
    expect(p.headline).toContain("bonus earned");
  });

  it("reports the time left, and zero once the window shuts", () => {
    const c = campaign();
    expect(campaignProgress(c, counters(), NOON).msRemaining).toBe(END - NOON);
    expect(campaignProgress(c, counters(), END + 1).msRemaining).toBe(0);
  });

  it("singularises so the copy never reads like a machine wrote it", () => {
    const c = campaign({ trigger: { kind: "knocks_by_time", knocks: 40, byHourLocal: 12 } });
    expect(campaignProgress(c, counters({ knocksBeforeCutoffToday: 39 }), NOON).nextStep)
      .toBe("1 more knock before 12 PM.");
  });
});

describe("evaluateCampaign — the money", () => {
  it("pays a met trigger inside a live window", () => {
    const out = evaluateCampaign(campaign(), counters({ salesInWindow: 1 }), NOON);
    expect(out).toEqual({ award: { campaignId: 1, repId: 7, amountCents: 7500, reason: "Power Hour — sale bonus" } });
  });

  it("pays nothing outside the window, or when paused/cancelled", () => {
    const met = counters({ salesInWindow: 1 });
    expect(evaluateCampaign(campaign(), met, START - 1)).toEqual({ skip: "window_closed" });
    expect(evaluateCampaign(campaign(), met, END)).toEqual({ skip: "window_closed" });
    expect(evaluateCampaign(campaign({ status: "paused" }), met, NOON)).toEqual({ skip: "not_live" });
    expect(evaluateCampaign(campaign({ status: "cancelled" }), met, NOON)).toEqual({ skip: "window_closed" });
  });

  it("respects the eligibility list", () => {
    const c = campaign({ eligibleRepIds: [99] });
    expect(evaluateCampaign(c, counters({ salesInWindow: 1 }), NOON)).toEqual({ skip: "not_eligible" });
  });

  it("TRIMS to the per-rep cap rather than refusing the award", () => {
    // $20 from the cap on a $75 campaign pays $20. Refusing it outright is how
    // a rep learns the number on the card is not real.
    const c = campaign({ perRepCapCents: 10_000 });
    const out = evaluateCampaign(c, counters({ salesInWindow: 1, awardedToRepCents: 8_000 }), NOON);
    expect(out).toEqual({ award: expect.objectContaining({ amountCents: 2_000 }) });
  });

  it("stops at the per-rep cap once there is no room", () => {
    const c = campaign({ perRepCapCents: 10_000 });
    expect(evaluateCampaign(c, counters({ salesInWindow: 1, awardedToRepCents: 10_000 }), NOON))
      .toEqual({ skip: "rep_cap_reached" });
  });

  it("bounds the WHOLE campaign — the liability ceiling", () => {
    // "$75 a sale, all markets" on a hot Saturday must not be an open cheque.
    const c = campaign({ campaignCapCents: 50_000 });
    expect(evaluateCampaign(c, counters({ salesInWindow: 1, awardedTotalCents: 49_000 }), NOON))
      .toEqual({ award: expect.objectContaining({ amountCents: 1_000 }) });
    expect(evaluateCampaign(c, counters({ salesInWindow: 1, awardedTotalCents: 50_000 }), NOON))
      .toEqual({ skip: "campaign_cap_reached" });
  });

  it("never pays a negative or zero reward", () => {
    expect(evaluateCampaign(campaign({ rewardCents: 0 }), counters({ salesInWindow: 1 }), NOON))
      .toEqual({ skip: "trigger_unmet" });
    expect(evaluateCampaign(campaign({ rewardCents: -500 }), counters({ salesInWindow: 1 }), NOON))
      .toEqual({ skip: "trigger_unmet" });
  });
});

describe("isCampaignLive / hour12 / describeTrigger", () => {
  it("is live only inside the window and only when status says so", () => {
    expect(isCampaignLive(campaign(), NOON)).toBe(true);
    expect(isCampaignLive(campaign(), START - 1)).toBe(false);
    expect(isCampaignLive(campaign(), END)).toBe(false);        // half-open
    expect(isCampaignLive(campaign({ status: "paused" }), NOON)).toBe(false);
  });

  it("formats cutoffs the way a rep says them out loud", () => {
    expect(hour12(0)).toBe("12 AM");
    expect(hour12(9)).toBe("9 AM");
    expect(hour12(12)).toBe("12 PM");
    expect(hour12(18)).toBe("6 PM");
  });

  it("reads the rule back to the manager launching it", () => {
    expect(describeTrigger({ kind: "knocks_by_time", knocks: 40, byHourLocal: 12 }))
      .toBe("for 40 knocks before 12 PM");
    expect(describeTrigger({ kind: "knock_streak", days: 3, knocksPerDay: 25 }))
      .toBe("for 3 days straight at 25+ knocks");
  });
});

describe("validateCampaignInput — a manager cannot promise nonsense", () => {
  const ok = { name: "Power Hour", rewardCents: 7500, startsAtMs: START, endsAtMs: END, trigger: { kind: "per_sale" } as const };

  it("accepts a sane campaign", () => {
    expect(validateCampaignInput(ok)).toBeNull();
  });

  it("rejects a missing name, a bad reward, and an inverted window", () => {
    expect(validateCampaignInput({ ...ok, name: "x" })).toMatch(/name/i);
    expect(validateCampaignInput({ ...ok, rewardCents: 0 })).toMatch(/reward/i);
    expect(validateCampaignInput({ ...ok, rewardCents: 250_000 })).toMatch(/\$1,000/);
    expect(validateCampaignInput({ ...ok, endsAtMs: START })).toMatch(/end after/i);
  });

  it("refuses a month-long 'spiff' — that is a comp plan, not urgency", () => {
    expect(validateCampaignInput({ ...ok, endsAtMs: START + 40 * 86_400_000 })).toMatch(/31 days/);
  });

  it("bounds every trigger parameter", () => {
    expect(validateCampaignInput({ ...ok, trigger: { kind: "knocks_by_time", knocks: 0, byHourLocal: 12 } })).toMatch(/Knock target/);
    expect(validateCampaignInput({ ...ok, trigger: { kind: "knocks_by_time", knocks: 40, byHourLocal: 0 } })).toMatch(/Cutoff hour/);
    expect(validateCampaignInput({ ...ok, trigger: { kind: "knock_streak", days: 1, knocksPerDay: 25 } })).toMatch(/Streak length/);
    expect(validateCampaignInput({ ...ok, trigger: { kind: "sales_in_day", sales: 99 } })).toMatch(/Sales target/);
  });

  it("rejects a fractional or negative cap", () => {
    expect(validateCampaignInput({ ...ok, perRepCapCents: -1 })).toMatch(/Per-rep cap/);
    expect(validateCampaignInput({ ...ok, campaignCapCents: 10.5 })).toMatch(/Campaign cap/);
  });
});
