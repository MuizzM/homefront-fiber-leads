// Spiff engine — the pure award logic. Everything here is deterministic: no
// clock, no RNG. We drive the "random" branch with an explicit roll and prove
// every deterministic trigger, the daily cap, config-driven amounts, and heat
// monotonicity.
import { describe, expect, it } from "vitest";
import {
  decideSpiff,
  heatScore,
  DEFAULT_SPIFF_CONFIG,
  type PerfSnapshot,
  type SpiffConfig,
  type SaleContext,
} from "../../shared/spiffEngine";

const snap = (o: Partial<PerfSnapshot> = {}): PerfSnapshot => ({
  totalSales: 5,
  recentSalesCount: 1,
  windowDays: 7,
  salesVelocityPerDay: 1 / 7,
  trailingAvgPerDay: 0,
  currentStreakDays: 1,
  recentTrend: 0,
  spiffsGrantedToday: 0,
  ...o,
});

const sale = (o: Partial<SaleContext> = {}): SaleContext => ({ saleRef: "knock:1", lifetimeSaleNumber: 7, ...o });

const cfg = (o: Partial<SpiffConfig> = {}): SpiffConfig => ({ ...DEFAULT_SPIFF_CONFIG, ...o });

describe("decideSpiff — random branch boundary", () => {
  // A neutral snapshot: no deterministic trigger can fire, so only the roll matters.
  const neutral = snap({ currentStreakDays: 1, trailingAvgPerDay: 0, recentSalesCount: 1 });
  const c = cfg({ randomChancePct: 20, streakThresholdDays: 3, milestoneEvery: 10, improvementPct: 50 });

  it("awards when roll is strictly below the chance", () => {
    const d = decideSpiff(sale(), neutral, 0.19, c);
    expect(d).toEqual({ awarded: true, amountCents: 5000, reason: "random" });
  });

  it("does NOT award at the exact boundary (roll === pct/100)", () => {
    expect(decideSpiff(sale(), neutral, 0.20, c).awarded).toBe(false);
  });

  it("does NOT award above the boundary", () => {
    expect(decideSpiff(sale(), neutral, 0.9999, c).awarded).toBe(false);
  });

  it("roll 0 always awards a positive chance", () => {
    expect(decideSpiff(sale(), neutral, 0, c).reason).toBe("random");
  });

  it("randomChancePct 0 never awards randomly", () => {
    expect(decideSpiff(sale(), neutral, 0, cfg({ randomChancePct: 0 })).awarded).toBe(false);
  });
});

describe("decideSpiff — deterministic triggers", () => {
  const c = cfg({ randomChancePct: 0, streakThresholdDays: 3, milestoneEvery: 10, improvementPct: 50 });

  it("streak: awards at the threshold", () => {
    const d = decideSpiff(sale({ lifetimeSaleNumber: 7 }), snap({ currentStreakDays: 3 }), 0.99, c);
    expect(d.reason).toBe("streak");
    expect(d.awarded).toBe(true);
  });

  it("streak: awards again at a further multiple of the threshold", () => {
    expect(decideSpiff(sale({ lifetimeSaleNumber: 7 }), snap({ currentStreakDays: 6 }), 0.99, c).reason).toBe("streak");
  });

  it("streak: a non-multiple day between multiples does not re-award", () => {
    expect(decideSpiff(sale({ lifetimeSaleNumber: 7 }), snap({ currentStreakDays: 4 }), 0.99, c).awarded).toBe(false);
  });

  it("improvement: pace beating the trailing average by the bar awards", () => {
    const d = decideSpiff(
      sale({ lifetimeSaleNumber: 7 }),
      snap({ currentStreakDays: 1, trailingAvgPerDay: 0.2, salesVelocityPerDay: 0.5, recentSalesCount: 3 }),
      0.99, c,
    );
    expect(d.reason).toBe("improvement");
  });

  it("improvement: pace at or below the bar does not award", () => {
    // trailingAvg 0.2 × 1.5 = 0.3 threshold; velocity 0.25 is under it.
    const d = decideSpiff(
      sale({ lifetimeSaleNumber: 7 }),
      snap({ currentStreakDays: 1, trailingAvgPerDay: 0.2, salesVelocityPerDay: 0.25, recentSalesCount: 3 }),
      0.99, c,
    );
    expect(d.awarded).toBe(false);
  });

  it("improvement: needs a real baseline (no baseline → no improvement award)", () => {
    const d = decideSpiff(
      sale({ lifetimeSaleNumber: 7 }),
      snap({ currentStreakDays: 1, trailingAvgPerDay: 0, salesVelocityPerDay: 2, recentSalesCount: 5 }),
      0.99, c,
    );
    expect(d.reason).not.toBe("improvement");
  });

  it("milestone: every Nth lifetime sale awards", () => {
    expect(decideSpiff(sale({ lifetimeSaleNumber: 10 }), snap(), 0.99, c).reason).toBe("milestone");
    expect(decideSpiff(sale({ lifetimeSaleNumber: 20 }), snap(), 0.99, c).reason).toBe("milestone");
    expect(decideSpiff(sale({ lifetimeSaleNumber: 11 }), snap(), 0.99, c).awarded).toBe(false);
  });

  it("milestone outranks a simultaneously-qualifying streak", () => {
    const d = decideSpiff(sale({ lifetimeSaleNumber: 10 }), snap({ currentStreakDays: 3 }), 0.99, c);
    expect(d.reason).toBe("milestone");
  });
});

describe("decideSpiff — daily cap (anti-farming)", () => {
  const c = cfg({ randomChancePct: 100, streakThresholdDays: 3, milestoneEvery: 10, dailyCapPerRep: 2 });

  it("suppresses ALL awards once the cap is reached, even a milestone", () => {
    const d = decideSpiff(sale({ lifetimeSaleNumber: 10 }), snap({ spiffsGrantedToday: 2, currentStreakDays: 3 }), 0, c);
    expect(d).toEqual({ awarded: false, amountCents: 0, reason: null });
  });

  it("still awards below the cap", () => {
    expect(decideSpiff(sale({ lifetimeSaleNumber: 10 }), snap({ spiffsGrantedToday: 1 }), 0.99, c).awarded).toBe(true);
  });

  it("a cap of 0 disables spiffs entirely", () => {
    expect(decideSpiff(sale({ lifetimeSaleNumber: 10 }), snap({ spiffsGrantedToday: 0 }), 0, cfg({ dailyCapPerRep: 0 })).awarded).toBe(false);
  });
});

describe("decideSpiff — config-driven amount", () => {
  it("returns the configured amount in cents", () => {
    const d = decideSpiff(sale({ lifetimeSaleNumber: 10 }), snap(), 0.99, cfg({ amountCents: 7500 }));
    expect(d).toMatchObject({ awarded: true, amountCents: 7500, reason: "milestone" });
  });
});

describe("heatScore", () => {
  it("is 0 for a cold rep and within [0,100]", () => {
    const cold = heatScore(snap({ currentStreakDays: 0, salesVelocityPerDay: 0, recentSalesCount: 0, trailingAvgPerDay: 0 }));
    expect(cold).toBe(0);
    const hot = heatScore(snap({ currentStreakDays: 10, salesVelocityPerDay: 5, recentSalesCount: 30, trailingAvgPerDay: 0.1 }));
    expect(hot).toBeLessThanOrEqual(100);
    expect(hot).toBeGreaterThanOrEqual(0);
  });

  it("is monotonic in the streak (others fixed)", () => {
    const lo = heatScore(snap({ currentStreakDays: 2, salesVelocityPerDay: 0.5, recentSalesCount: 4, trailingAvgPerDay: 0.3 }));
    const hi = heatScore(snap({ currentStreakDays: 5, salesVelocityPerDay: 0.5, recentSalesCount: 4, trailingAvgPerDay: 0.3 }));
    expect(hi).toBeGreaterThanOrEqual(lo);
    expect(hi).toBeGreaterThan(lo);
  });

  it("is monotonic in velocity (others fixed)", () => {
    const lo = heatScore(snap({ currentStreakDays: 3, salesVelocityPerDay: 0.5, recentSalesCount: 4, trailingAvgPerDay: 0.3 }));
    const hi = heatScore(snap({ currentStreakDays: 3, salesVelocityPerDay: 1.5, recentSalesCount: 4, trailingAvgPerDay: 0.3 }));
    expect(hi).toBeGreaterThan(lo);
  });

  it("is monotonic in recent sales count (others fixed)", () => {
    const lo = heatScore(snap({ currentStreakDays: 3, salesVelocityPerDay: 0.5, recentSalesCount: 2, trailingAvgPerDay: 0.3 }));
    const hi = heatScore(snap({ currentStreakDays: 3, salesVelocityPerDay: 0.5, recentSalesCount: 12, trailingAvgPerDay: 0.3 }));
    expect(hi).toBeGreaterThan(lo);
  });
});
