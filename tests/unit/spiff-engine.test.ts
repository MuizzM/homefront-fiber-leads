// Spiff engine — the pure award logic. Everything here is deterministic: no
// clock, no RNG. We drive the "random" branch with an explicit roll and prove
// every deterministic trigger, the daily cap, config-driven amounts, and heat
// monotonicity.
import { describe, expect, it } from "vitest";
import {
  decideSpiff,
  deriveAmountRoll,
  drawSpiffAmountCents,
  heatScore,
  spiffAmountBand,
  spiffAmountLadder,
  spiffTriggerGuide,
  DEFAULT_SPIFF_CONFIG,
  SPIFF_AMOUNT_TILT,
  type PerfSnapshot,
  type SpiffConfig,
  type SaleContext,
  type SpiffReason,
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
  spiffCentsGrantedToday: 0,
  ...o,
});

const sale = (o: Partial<SaleContext> = {}): SaleContext => ({ saleRef: "knock:1", lifetimeSaleNumber: 7, ...o });

const cfg = (o: Partial<SpiffConfig> = {}): SpiffConfig => ({ ...DEFAULT_SPIFF_CONFIG, ...o });

describe("decideSpiff - random branch boundary", () => {
  // A neutral snapshot: no deterministic trigger can fire, so only the roll matters.
  const neutral = snap({ currentStreakDays: 1, trailingAvgPerDay: 0, recentSalesCount: 1 });
  const c = cfg({ randomChancePct: 20, streakThresholdDays: 3, milestoneEvery: 10, improvementPct: 50 });

  it("awards when roll is strictly below the chance", () => {
    const d = decideSpiff(sale(), neutral, 0.19, c);
    expect(d.awarded).toBe(true);
    expect(d.reason).toBe("random");
    // The amount is now DRAWN from the band rather than flat, so assert the
    // contract it must satisfy: inside [min,max] and on a $5 step.
    expect(d.amountCents).toBeGreaterThanOrEqual(2500);
    expect(d.amountCents).toBeLessThanOrEqual(5000);
    expect(d.amountCents % 500).toBe(0);
    // …and reproducible: the same roll always produces the same dollar amount.
    expect(decideSpiff(sale(), neutral, 0.19, c).amountCents).toBe(d.amountCents);
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

describe("decideSpiff - deterministic triggers", () => {
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

describe("decideSpiff - daily cap (anti-farming)", () => {
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

describe("decideSpiff - config-driven amount", () => {
  it("returns the configured amount in cents (flat back-compat alias)", () => {
    const d = decideSpiff(sale({ lifetimeSaleNumber: 10 }), snap(), 0.99, cfg({ amountCents: 7500 }));
    expect(d).toMatchObject({ awarded: true, amountCents: 7500, reason: "milestone" });
  });
});

// ── The variable $25–$50 award ────────────────────────────────────────────────
// The amount must be MONEY-GRADE: bounded, on a clean step, integer cents, and
// bit-for-bit reproducible from the same seeded roll.
describe("award amount - band, granularity and determinism", () => {
  const ROLLS = Array.from({ length: 400 }, (_, i) => i / 400);
  const REASONS: SpiffReason[] = ["random", "streak", "improvement", "milestone"];
  const LADDER = spiffAmountLadder(DEFAULT_SPIFF_CONFIG);

  it("the default band is $25-$50 in $5 steps", () => {
    const band = spiffAmountBand(DEFAULT_SPIFF_CONFIG);
    expect(band).toEqual({ minCents: 2500, maxCents: 5000, incrementCents: 500, steps: 6 });
    expect(LADDER).toEqual([2500, 3000, 3500, 4000, 4500, 5000]);
  });

  it("every drawn amount is inside the band, on a $5 increment, and an integer", () => {
    for (const reason of REASONS) {
      for (const u of ROLLS) {
        const cents = drawSpiffAmountCents(reason, u);
        expect(Number.isInteger(cents)).toBe(true);
        expect(cents).toBeGreaterThanOrEqual(2500);
        expect(cents).toBeLessThanOrEqual(5000);
        expect(cents % 500).toBe(0);
        expect(LADDER).toContain(cents);
      }
    }
  });

  it("is deterministic - the same roll always draws the same cents", () => {
    for (const reason of REASONS) {
      for (const u of [0, 0.0001, 0.3333333, 0.5, 0.87, 0.999999]) {
        expect(drawSpiffAmountCents(reason, u)).toBe(drawSpiffAmountCents(reason, u));
      }
    }
  });

  it("survives hostile rolls without leaving the band", () => {
    for (const reason of REASONS) {
      for (const u of [-1, 0, 1, 2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const cents = drawSpiffAmountCents(reason, u as number);
        expect(LADDER).toContain(cents);
      }
    }
  });

  it("every step of the band is reachable for every reason", () => {
    for (const reason of REASONS) {
      const seen = new Set(ROLLS.map((u) => drawSpiffAmountCents(reason, u)));
      expect([...seen].sort((a, b) => a - b)).toEqual(LADDER);
    }
  });

  it("a degenerate band (min === max) always pays that amount", () => {
    const flat = cfg({ minAmountCents: 4000, maxAmountCents: 4000 });
    for (const u of ROLLS) expect(drawSpiffAmountCents("streak", u, flat)).toBe(4000);
  });

  it("a reversed band is normalized rather than trusted", () => {
    const reversed = cfg({ minAmountCents: 5000, maxAmountCents: 2500 });
    expect(spiffAmountBand(reversed)).toMatchObject({ minCents: 2500, maxCents: 5000 });
  });

  it("the amount draw is decorrelated from the award roll", () => {
    // A "random" spiff only fires for rolls under ~0.12. If the amount reused
    // that roll directly, every lucky drop would pin to the same one or two
    // steps. Mixing must spread a thin slice of rolls across the whole band.
    const thin = Array.from({ length: 120 }, (_, i) => (i / 120) * 0.12);
    const spread = new Set(thin.map((r) => drawSpiffAmountCents("random", deriveAmountRoll(r))));
    expect(spread.size).toBeGreaterThanOrEqual(4);
    // deriveAmountRoll itself is a pure function of its input.
    expect(deriveAmountRoll(0.07)).toBe(deriveAmountRoll(0.07));
    expect(deriveAmountRoll(0.07)).not.toBe(deriveAmountRoll(0.08));
    for (const r of thin) {
      const u = deriveAmountRoll(r);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });
});

describe("award amount - reason weighting (rarer trigger, richer draw)", () => {
  const ROLLS = Array.from({ length: 2000 }, (_, i) => i / 2000);
  const mean = (reason: SpiffReason) =>
    ROLLS.reduce((s, u) => s + drawSpiffAmountCents(reason, u), 0) / ROLLS.length;

  it("skews random < improvement < streak < milestone", () => {
    const random = mean("random");
    const improvement = mean("improvement");
    const streak = mean("streak");
    const milestone = mean("milestone");
    expect(random).toBeLessThan(improvement);
    expect(improvement).toBeLessThan(streak);
    expect(streak).toBeLessThan(milestone);
    // The documented averages over the default ladder (±$1).
    expect(random / 100).toBeCloseTo(32.83, 0);
    expect(milestone / 100).toBeCloseTo(42.17, 0);
    // Every average still sits inside the advertised band.
    for (const m of [random, improvement, streak, milestone]) {
      expect(m).toBeGreaterThan(2500);
      expect(m).toBeLessThan(5000);
    }
  });

  it("a lucky drop hits the band floor more often than a milestone does", () => {
    const floorRate = (reason: SpiffReason) =>
      ROLLS.filter((u) => drawSpiffAmountCents(reason, u) === 2500).length / ROLLS.length;
    expect(floorRate("random")).toBeGreaterThan(floorRate("milestone"));
    const topRate = (reason: SpiffReason) =>
      ROLLS.filter((u) => drawSpiffAmountCents(reason, u) === 5000).length / ROLLS.length;
    expect(topRate("milestone")).toBeGreaterThan(topRate("random"));
  });

  it("the tilt table stays coherent (low:high per reason)", () => {
    expect(SPIFF_AMOUNT_TILT.random[0]).toBeGreaterThan(SPIFF_AMOUNT_TILT.random[1]);
    expect(SPIFF_AMOUNT_TILT.milestone[1]).toBeGreaterThan(SPIFF_AMOUNT_TILT.milestone[0]);
  });
});

describe("daily cap now bounds CENTS, not a count × flat amount", () => {
  // REGRESSION: with a variable amount, "2 spiffs/day" no longer means "$100/day".
  // The money cap is the backstop that actually bounds spend.
  const c = cfg({ randomChancePct: 100, dailyCapPerRep: 99, dailyCapCentsPerRep: 10000 });

  it("blocks once the day's CENTS are spent, even with the count cap wide open", () => {
    const d = decideSpiff(sale({ lifetimeSaleNumber: 10 }), snap({ spiffsGrantedToday: 1, spiffCentsGrantedToday: 10000 }), 0, c);
    expect(d).toEqual({ awarded: false, amountCents: 0, reason: null });
  });

  it("blocks when the remaining budget cannot cover even the band floor", () => {
    // $80 spent of $100 → $20 left, under the $25 floor → nothing, not a $20 spiff.
    const d = decideSpiff(sale({ lifetimeSaleNumber: 10 }), snap({ spiffCentsGrantedToday: 8000 }), 0, c);
    expect(d.awarded).toBe(false);
  });

  it("trims a draw down to the budget instead of overspending", () => {
    // $75 spent of $100 → exactly $25 of room; a milestone draw that wanted more
    // is trimmed to the largest whole step that fits.
    const d = decideSpiff(sale({ lifetimeSaleNumber: 10 }), snap({ spiffCentsGrantedToday: 7500 }), 0, c);
    expect(d.awarded).toBe(true);
    expect(d.amountCents).toBe(2500);
  });

  it("never lets a rep's day exceed the cents cap, for any roll or mix of amounts", () => {
    for (let i = 0; i < 200; i++) {
      const roll = i / 200;
      for (const alreadySpent of [0, 500, 2500, 4000, 5000, 7500, 9500, 10000]) {
        const d = decideSpiff(
          sale({ lifetimeSaleNumber: 10 }),
          snap({ spiffCentsGrantedToday: alreadySpent }),
          roll, c,
        );
        expect(alreadySpent + d.amountCents).toBeLessThanOrEqual(10000);
        if (d.awarded) {
          expect(d.amountCents).toBeGreaterThanOrEqual(2500);
          expect(d.amountCents % 500).toBe(0);
        }
      }
    }
  });

  it("keeps the count cap as a second, independent backstop", () => {
    const countCapped = cfg({ randomChancePct: 100, dailyCapPerRep: 2, dailyCapCentsPerRep: 1_000_000 });
    expect(decideSpiff(sale(), snap({ spiffsGrantedToday: 2 }), 0, countCapped).awarded).toBe(false);
    expect(decideSpiff(sale(), snap({ spiffsGrantedToday: 1 }), 0, countCapped).awarded).toBe(true);
  });

  it("a cents cap of 0 disables spiffs entirely", () => {
    expect(decideSpiff(sale({ lifetimeSaleNumber: 10 }), snap(), 0, cfg({ dailyCapCentsPerRep: 0 })).awarded).toBe(false);
  });
});

describe("spiffTriggerGuide - the rep-facing rules copy", () => {
  it("describes all four triggers from the live config", () => {
    const guide = spiffTriggerGuide(DEFAULT_SPIFF_CONFIG);
    expect(guide.map((g) => g.reason).sort()).toEqual(["improvement", "milestone", "random", "streak"]);
    expect(guide.find((g) => g.reason === "milestone")!.how).toContain(String(DEFAULT_SPIFF_CONFIG.milestoneEvery));
    expect(guide.find((g) => g.reason === "streak")!.how).toContain(String(DEFAULT_SPIFF_CONFIG.streakThresholdDays));
    for (const g of guide) expect(g.title.length).toBeGreaterThan(0);
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
