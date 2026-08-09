// Sales achievements — the pure, reachable ladder. Deterministic by design:
// unlike the recognition spiff there is no roll here at all, because a bonus a
// rep is supposed to aim at cannot be a dice throw.
import { describe, expect, it } from "vitest";
import {
  achievementCeilingCents,
  achievementProgress,
  achievementsCleared,
  normalizeRungs,
  validateAchievementConfig,
  DEFAULT_SALES_ACHIEVEMENT_CONFIG,
  type AchievementCounts,
  type SalesAchievementConfig,
} from "../../shared/salesAchievements";

const cfg = (o: Partial<SalesAchievementConfig> = {}): SalesAchievementConfig =>
  ({ ...DEFAULT_SALES_ACHIEVEMENT_CONFIG, ...o });

const counts = (o: Partial<AchievementCounts> = {}): AchievementCounts => ({
  dailySales: 0, careerSales: 0, centsAlreadyToday: 0, isRampRep: false, ...o,
});

describe("achievementsCleared - the daily rungs", () => {
  it("pays nothing on the first sale of the day", () => {
    expect(achievementsCleared(counts({ dailySales: 1 }), cfg())).toEqual([]);
  });

  it("pays $25 on the second", () => {
    const a = achievementsCleared(counts({ dailySales: 2 }), cfg());
    expect(a).toHaveLength(1);
    expect(a[0].amountCents).toBe(2_500);
    expect(a[0].reason).toBe("2 sales in a day");
    expect(a[0].key).toBe("day:2");
  });

  it("stacks rungs instead of replacing them", () => {
    // Four sales clears BOTH the 2 and the 4 — a rep who watches an earned $25
    // get 'upgraded' into a $50 total reads it as the system taking something.
    const a = achievementsCleared(counts({ dailySales: 4 }), cfg());
    expect(a.map(x => x.amountCents)).toEqual([2_500, 5_000]);
  });

  it("re-proposes rungs already cleared, because the ledger key stops the repeat", () => {
    // Called after every sale; sale five re-offers both daily rungs and the
    // unique index ignores them. That is what makes the caller safe.
    expect(achievementsCleared(counts({ dailySales: 5 }), cfg())).toHaveLength(2);
  });
});

describe("achievementsCleared - the career rungs", () => {
  it("fires each career milestone as it is passed", () => {
    const a = achievementsCleared(counts({ careerSales: 50 }), cfg({ maxCentsPerRepPerDay: 0 }));
    expect(a.map(x => x.key)).toEqual(["career:10", "career:25", "career:50"]);
    expect(a.every(x => x.scope === "career")).toBe(true);
  });

  it("names the milestone the way a pay statement should", () => {
    const a = achievementsCleared(counts({ careerSales: 100 }), cfg({ maxCentsPerRepPerDay: 0 }));
    expect(a.at(-1)!.reason).toBe("100 career sales");
  });
});

describe("achievementsCleared - who is on this ladder", () => {
  it("skips a rep still inside their ramp window", () => {
    expect(achievementsCleared(counts({ dailySales: 4, isRampRep: true }), cfg())).toEqual([]);
  });

  it("pays a ramp rep when the org turns the handover off", () => {
    const a = achievementsCleared(counts({ dailySales: 2, isRampRep: true }), cfg({ excludeRampReps: false }));
    expect(a).toHaveLength(1);
  });

  it("pays nothing when disabled", () => {
    expect(achievementsCleared(counts({ dailySales: 9, careerSales: 200 }), cfg({ enabled: false }))).toEqual([]);
  });
});

describe("achievementsCleared - the daily cents cap", () => {
  it("drops rungs that no longer fit in the day's budget", () => {
    // $100 cap, $75 already banked: the $25 rung fits, the $50 does not.
    const a = achievementsCleared(counts({ dailySales: 4, centsAlreadyToday: 7_500 }), cfg());
    expect(a.map(x => x.amountCents)).toEqual([2_500]);
  });

  it("drops a rung whole - part of a bonus is not a bonus", () => {
    const a = achievementsCleared(counts({ dailySales: 4, centsAlreadyToday: 9_000 }), cfg());
    expect(a).toEqual([]);
  });

  it("counts what was already banked, so the cap holds across calls", () => {
    const a = achievementsCleared(counts({ dailySales: 2, careerSales: 100, centsAlreadyToday: 10_000 }), cfg());
    expect(a).toEqual([]);
  });

  it("honours an uncapped ladder", () => {
    const a = achievementsCleared(counts({ dailySales: 4, careerSales: 100 }), cfg({ maxCentsPerRepPerDay: 0 }));
    expect(a).toHaveLength(6);
  });
});

describe("achievementProgress - what the rep is chasing", () => {
  it("names the next daily rung in sales, not percentages", () => {
    const p = achievementProgress(counts({ dailySales: 1 }), cfg());
    expect(p.headline).toBe("1 more sale today for $25");
    expect(p.nextDaily?.sales).toBe(2);
  });

  it("falls through to the career rung once the day is topped out", () => {
    const p = achievementProgress(counts({ dailySales: 6, careerSales: 47 }), cfg());
    expect(p.nextDaily).toBeNull();
    expect(p.headline).toBe("3 more career sales for $50");
  });

  it("says so when there is nothing left to clear", () => {
    const p = achievementProgress(counts({ dailySales: 9, careerSales: 500 }), cfg());
    expect(p.headline).toBe("Every achievement bonus earned");
  });

  it("shows a ramp rep nothing - they are on the other bonus", () => {
    const p = achievementProgress(counts({ dailySales: 2, isRampRep: true }), cfg());
    expect(p.enabled).toBe(false);
    expect(p.headline).toBeNull();
  });
});

describe("config hygiene", () => {
  it("sorts, de-duplicates, and drops junk rungs", () => {
    const r = normalizeRungs([
      { sales: 4, rewardCents: 5_000 },
      { sales: 2, rewardCents: 2_500 },
      { sales: 2, rewardCents: 9_900 },   // duplicate — first wins
      { sales: 0, rewardCents: 2_500 },   // junk
      { sales: 3, rewardCents: 0 },       // pays nothing
    ]);
    expect(r).toEqual([{ sales: 2, rewardCents: 2_500 }, { sales: 4, rewardCents: 5_000 }]);
  });

  it("states the per-rep daily ceiling, capped", () => {
    expect(achievementCeilingCents(DEFAULT_SALES_ACHIEVEMENT_CONFIG)).toBe(10_000);
    expect(achievementCeilingCents(cfg({ maxCentsPerRepPerDay: 0 }))).toBe(22_500);
  });

  it("accepts the defaults", () => {
    expect(validateAchievementConfig(DEFAULT_SALES_ACHIEVEMENT_CONFIG)).toBeNull();
  });

  it("rejects out-of-range rungs and money", () => {
    expect(validateAchievementConfig(cfg({ daily: [{ sales: 0, rewardCents: 2_500 }] }))).toContain("1 and 50");
    expect(validateAchievementConfig(cfg({ daily: [{ sales: 2, rewardCents: 200_000 }] }))).toContain("$1,000");
    expect(validateAchievementConfig(cfg({ career: [{ sales: 5, rewardCents: 0 }] }))).toContain("above zero");
  });

  it("rejects a ladder that is on but empty", () => {
    expect(validateAchievementConfig(cfg({ daily: [], career: [] }))).toContain("at least one rung");
  });

  it("rejects a cap that would silently pay nothing", () => {
    // The worst failure mode: the ladder still renders and never fires.
    expect(validateAchievementConfig(cfg({ maxCentsPerRepPerDay: 1_000 }))).toContain("below the smallest rung");
  });
});
