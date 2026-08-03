// The standing door-bonus ladder, pinned.
//
// This engine decides real money against a door count, so the properties worth
// a test are the ones a rep would notice and dispute: that rungs stack rather
// than replace, that the bar measures the climb you are actually on, and that
// the copy on the card names the number you have to hit.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MILESTONE_LADDER, ladderCeilingCents, ladderValueAt, milestoneProgress,
  milestoneReason, nextRung, normalizeLadder, rungsCleared, usd, validateLadder,
  type MilestoneLadder,
} from "../../shared/knockMilestones";

const ladder = (over: Partial<MilestoneLadder> = {}): MilestoneLadder => ({
  enabled: true,
  period: "week",
  rungs: [
    { doors: 100, rewardCents: 2_500 },
    { doors: 250, rewardCents: 5_000 },
    { doors: 500, rewardCents: 10_000 },
  ],
  ...over,
});

describe("normalizing a hand-edited ladder", () => {
  it("sorts ascending so rungs cannot pay out of order", () => {
    const n = normalizeLadder(ladder({ rungs: [
      { doors: 500, rewardCents: 10_000 },
      { doors: 100, rewardCents: 2_500 },
    ] }));
    expect(n.rungs.map(r => r.doors)).toEqual([100, 500]);
  });

  it("drops duplicate door counts — two rungs at 100 would pay twice for one climb", () => {
    const n = normalizeLadder(ladder({ rungs: [
      { doors: 100, rewardCents: 2_500 },
      { doors: 100, rewardCents: 9_900 },
    ] }));
    expect(n.rungs).toHaveLength(1);
    expect(n.rungs[0].rewardCents).toBe(2_500);
  });

  it("drops zero and negative rungs rather than paying for nothing", () => {
    const n = normalizeLadder(ladder({ rungs: [
      { doors: 0, rewardCents: 2_500 },
      { doors: -5, rewardCents: 2_500 },
      { doors: 100, rewardCents: 0 },
      { doors: 200, rewardCents: 2_500 },
    ] }));
    expect(n.rungs).toEqual([{ doors: 200, rewardCents: 2_500 }]);
  });
});

describe("rungs stack, they do not replace", () => {
  it("crossing 250 keeps the 100 already banked", () => {
    expect(rungsCleared(ladder(), 250).map(r => r.doors)).toEqual([100, 250]);
    // $25 + $50 — NOT $50. A rep who watched a banked bonus get replaced would
    // read it as the system taking something back.
    expect(ladderValueAt(ladder(), 250)).toBe(7_500);
  });

  it("pays nothing below the first rung", () => {
    expect(rungsCleared(ladder(), 99)).toEqual([]);
    expect(ladderValueAt(ladder(), 99)).toBe(0);
  });

  it("pays the exact rung at the exact count — 100 doors clears a 100-door rung", () => {
    expect(ladderValueAt(ladder(), 100)).toBe(2_500);
  });

  it("tops out at the sum of every rung, however many doors are knocked", () => {
    expect(ladderValueAt(ladder(), 10_000)).toBe(17_500);
    expect(ladderCeilingCents(ladder())).toBe(17_500);
  });
});

describe("the next rung is the one being chased", () => {
  it("is the lowest rung not yet cleared", () => {
    expect(nextRung(ladder(), 0)?.doors).toBe(100);
    expect(nextRung(ladder(), 100)?.doors).toBe(250);
    expect(nextRung(ladder(), 249)?.doors).toBe(250);
  });

  it("is null once topped out", () => {
    expect(nextRung(ladder(), 500)).toBeNull();
  });
});

describe("progress the rep reads", () => {
  it("measures the bar from the rung just cleared, not from zero", () => {
    // 240 doors: 96% of the way to 250 counted from zero, but the rep is on the
    // 100→250 climb and is 140 of 150 through it. The second number is the one
    // that reflects what they can still do today.
    const p = milestoneProgress(ladder(), 240);
    expect(p.target).toBe(250);
    expect(p.remaining).toBe(10);
    expect(p.pct).toBe(Math.round((140 / 150) * 100));
  });

  it("names the number and the money in the headline", () => {
    const p = milestoneProgress(ladder(), 62);
    expect(p.headline).toBe("38 more verified doors this week for $25");
    expect(p.earnedCents).toBe(0);
  });

  it("says 'door' not 'doors' when exactly one is left", () => {
    expect(milestoneProgress(ladder(), 99).headline).toBe("1 more verified door this week for $25");
  });

  it("switches the period word for a daily ladder", () => {
    const p = milestoneProgress(ladder({ period: "day" }), 62);
    expect(p.headline).toBe("38 more verified doors today for $25");
  });

  it("reports what is banked as the rep climbs", () => {
    expect(milestoneProgress(ladder(), 260).earnedCents).toBe(7_500);
  });

  it("tops out cleanly instead of chasing a rung that does not exist", () => {
    const p = milestoneProgress(ladder(), 640);
    expect(p.toppedOut).toBe(true);
    expect(p.target).toBe(0);
    expect(p.remaining).toBe(0);
    expect(p.pct).toBe(100);
    expect(p.nextRewardCents).toBe(0);
    expect(p.earnedCents).toBe(17_500);
  });

  it("never renders a negative or fractional door count", () => {
    for (const bad of [-5, Number.NaN, 12.7]) {
      const p = milestoneProgress(ladder(), bad as number);
      expect(Number.isInteger(p.doors)).toBe(true);
      expect(p.doors).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("progress and payout can never disagree", () => {
  // The card says "earned"; the ladder says what it owes. If these two ever
  // drift, a rep sees a bonus they will not be paid — the exact failure this
  // whole design is built to prevent.
  it("earnedCents always equals what the ladder owes at that count", () => {
    for (const doors of [0, 1, 99, 100, 101, 249, 250, 499, 500, 501, 5_000]) {
      expect(milestoneProgress(ladder(), doors).earnedCents).toBe(ladderValueAt(ladder(), doors));
    }
  });

  it("toppedOut is true exactly when there is no next rung", () => {
    for (const doors of [0, 99, 100, 250, 499, 500, 900]) {
      expect(milestoneProgress(ladder(), doors).toppedOut).toBe(nextRung(ladder(), doors) === null);
    }
  });
});

describe("the ledger line", () => {
  it("says what the rep did, not which internal rung fired", () => {
    expect(milestoneReason({ doors: 100, rewardCents: 2_500 }, "week")).toBe("100 verified doors in a week");
    expect(milestoneReason({ doors: 40, rewardCents: 1_000 }, "day")).toBe("40 verified doors in a day");
  });
});

describe("money formatting never shows a float", () => {
  it("drops .00 on whole dollars and keeps real cents", () => {
    expect(usd(2_500)).toBe("$25");
    expect(usd(2_750)).toBe("$27.50");
    expect(usd(0)).toBe("$0");
    expect(usd(100_000)).toBe("$1,000");
    expect(usd(-2_500)).toBe("-$25");
  });
});

describe("validation the server and the form share", () => {
  it("accepts the shipped default", () => {
    expect(validateLadder(DEFAULT_MILESTONE_LADDER)).toBeNull();
  });

  it("refuses a four-figure milestone — that is a fat finger, not an incentive", () => {
    expect(validateLadder(ladder({ rungs: [{ doors: 100, rewardCents: 500_000 }] }))).toMatch(/\$1,000/);
  });

  it("refuses a door target nobody could hit", () => {
    expect(validateLadder(ladder({ rungs: [{ doors: 50_000, rewardCents: 2_500 }] }))).toMatch(/5,000 doors/);
  });

  it("refuses a rung that pays nothing", () => {
    expect(validateLadder(ladder({ rungs: [{ doors: 100, rewardCents: 0 }] }))).toMatch(/above zero/);
  });

  it("refuses turning on a ladder with no usable rungs — it would silently do nothing", () => {
    expect(validateLadder({ enabled: true, period: "week", rungs: [] })).toMatch(/at least one/);
  });

  it("allows an EMPTY ladder as long as it is switched off", () => {
    expect(validateLadder({ enabled: false, period: "week", rungs: [] })).toBeNull();
  });

  it("refuses a ladder nobody could recite", () => {
    const rungs = Array.from({ length: 9 }, (_, i) => ({ doors: (i + 1) * 50, rewardCents: 1_000 }));
    expect(validateLadder(ladder({ rungs }))).toMatch(/at most 8/);
  });

  it("refuses a nonsense period", () => {
    expect(validateLadder({ enabled: true, period: "fortnight" as any, rungs: [] })).toMatch(/week or a day/);
  });
});
