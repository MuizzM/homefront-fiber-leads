// Ramp bonus — the pure new-hire decision. No clock, no database: the caller
// hands over the day's counters and the verdict is a function of them.
import { describe, expect, it } from "vitest";
import {
  evaluateRampDay,
  evaluateTrainingCompletion,
  isRampRep,
  rampCeilingCentsPerHire,
  validateRampConfig,
  DEFAULT_RAMP_BONUS_CONFIG,
  type RampBonusConfig,
  type RampDayInput,
} from "../../shared/rampBonus";

const cfg = (o: Partial<RampBonusConfig> = {}): RampBonusConfig => ({ ...DEFAULT_RAMP_BONUS_CONFIG, ...o });

/** A day that clears every bar. */
const goodDay = (o: Partial<RampDayInput> = {}): RampDayInput => ({
  tenureDay: 3,
  distinctCardsToday: 12,
  lessonsCompletedToday: 0,
  dueRemaining: 0,
  spanMinutes: 20,
  ...o,
});

describe("isRampRep — the two-week window", () => {
  it("covers day 1 through the last day, inclusive", () => {
    expect(isRampRep(1)).toBe(true);
    expect(isRampRep(14)).toBe(true);
  });

  it("excludes day 15 and anything before day 1", () => {
    expect(isRampRep(15)).toBe(false);
    expect(isRampRep(0)).toBe(false);   // hire date unknown or in the future
    expect(isRampRep(-3)).toBe(false);
  });

  it("follows the configured window", () => {
    expect(isRampRep(20, cfg({ windowDays: 30 }))).toBe(true);
    expect(isRampRep(3, cfg({ enabled: false }))).toBe(false);
  });
});

describe("evaluateRampDay — a day's training work", () => {
  it("pays a new hire who cleared their cards", () => {
    const d = evaluateRampDay(goodDay(), cfg());
    expect(d.qualifies).toBe(true);
    expect(d.awardCents).toBe(5_000);
    expect(d.daysLeft).toBe(12);
    expect(d.reason).toBe("Training day 3 of 14");
  });

  it("pays day one off lessons alone, when the deck is still empty", () => {
    // The drill deck seeds from COMPLETED lessons, so a brand-new rep has no
    // cards to clear. Requiring cards would make day one unearnable.
    const d = evaluateRampDay(goodDay({ tenureDay: 1, distinctCardsToday: 0, lessonsCompletedToday: 2 }), cfg());
    expect(d.qualifies).toBe(true);
  });

  it("does not pay a veteran", () => {
    const d = evaluateRampDay(goodDay({ tenureDay: 15 }), cfg());
    expect(d.qualifies).toBe(false);
    expect(d.blockedBy).toBe("not_a_new_hire");
    expect(d.inWindow).toBe(false);
    // Nothing is dangled at someone who cannot earn it.
    expect(d.headline).toBe("");
  });

  it("does not pay for doing nothing", () => {
    const d = evaluateRampDay(goodDay({ distinctCardsToday: 0, lessonsCompletedToday: 0 }), cfg());
    expect(d.qualifies).toBe(false);
    expect(d.blockedBy).toBe("no_work");
  });

  it("does not pay for a token few cards", () => {
    const d = evaluateRampDay(goodDay({ distinctCardsToday: 3 }), cfg());
    expect(d.qualifies).toBe(false);
    expect(d.blockedBy).toBe("too_few_cards");
    expect(d.headline).toContain("7 more cards");
  });

  it("does not pay while cards are still due", () => {
    const d = evaluateRampDay(goodDay({ dueRemaining: 4 }), cfg());
    expect(d.qualifies).toBe(false);
    expect(d.blockedBy).toBe("queue_open");
    expect(d.headline).toContain("4 cards still due");
  });

  it("does not pay for a deck tapped through in seconds", () => {
    const d = evaluateRampDay(goodDay({ spanMinutes: 0 }), cfg());
    expect(d.qualifies).toBe(false);
    expect(d.blockedBy).toBe("too_fast");
  });

  it("does not fail a lesson-only day for having no drill span", () => {
    // Lessons carry no review timestamps to span; failing them on it would
    // block exactly the day-one case the lesson path exists for.
    const d = evaluateRampDay(goodDay({ distinctCardsToday: 0, lessonsCompletedToday: 1, spanMinutes: 0 }), cfg());
    expect(d.qualifies).toBe(true);
  });

  it("pays nothing when disabled or set to zero", () => {
    expect(evaluateRampDay(goodDay(), cfg({ enabled: false })).qualifies).toBe(false);
    expect(evaluateRampDay(goodDay(), cfg({ rewardCents: 0 })).qualifies).toBe(false);
  });

  it("survives junk counters without paying on them", () => {
    const d = evaluateRampDay({
      tenureDay: NaN, distinctCardsToday: NaN, lessonsCompletedToday: -5,
      dueRemaining: NaN, spanMinutes: NaN,
    } as any, cfg());
    expect(d.qualifies).toBe(false);
  });
});

describe("evaluateTrainingCompletion — finishing the curriculum", () => {
  it("pays base plus the kicker when finished inside the window", () => {
    const d = evaluateTrainingCompletion({ lessonsCompleted: 40, lessonsTotal: 40, tenureDay: 9 }, cfg());
    expect(d.qualifies).toBe(true);
    expect(d.baseCents).toBe(5_000);
    expect(d.kickerCents).toBe(5_000);
    expect(d.awardCents).toBe(10_000);
    expect(d.reason).toBe("Finished training inside the ramp window");
  });

  it("still pays the base to a rep who finished late", () => {
    const d = evaluateTrainingCompletion({ lessonsCompleted: 40, lessonsTotal: 40, tenureDay: 90 }, cfg());
    expect(d.qualifies).toBe(true);
    expect(d.awardCents).toBe(5_000);
    expect(d.kickerCents).toBe(0);
    expect(d.reason).toBe("Finished training");
  });

  it("does not pay a curriculum that is not finished", () => {
    const d = evaluateTrainingCompletion({ lessonsCompleted: 39, lessonsTotal: 40, tenureDay: 5 }, cfg());
    expect(d.qualifies).toBe(false);
    expect(d.lessonsRemaining).toBe(1);
    expect(d.headline).toContain("1 lesson left");
  });

  it("does not pay on an empty curriculum", () => {
    // Zero lessons is content that failed to load, not a course somebody
    // finished — paying on it would hand every rep the award at once.
    expect(evaluateTrainingCompletion({ lessonsCompleted: 0, lessonsTotal: 0, tenureDay: 2 }, cfg()).qualifies).toBe(false);
  });

  it("pays nothing when the completion award is switched off", () => {
    const off = cfg({ completionEnabled: false });
    expect(evaluateTrainingCompletion({ lessonsCompleted: 40, lessonsTotal: 40, tenureDay: 2 }, off).qualifies).toBe(false);
  });
});

describe("exposure and validation", () => {
  it("states the worst case per hire: every day plus finishing inside the window", () => {
    // 14 × $50 + $50 + $50 = $800
    expect(rampCeilingCentsPerHire(DEFAULT_RAMP_BONUS_CONFIG)).toBe(80_000);
  });

  it("accepts the defaults", () => {
    expect(validateRampConfig(DEFAULT_RAMP_BONUS_CONFIG)).toBeNull();
  });

  it("rejects an absurd window, reward, or bar", () => {
    expect(validateRampConfig(cfg({ windowDays: 0 }))).toContain("1 and 180");
    expect(validateRampConfig(cfg({ rewardCents: 500_000 }))).toContain("$1,000");
    expect(validateRampConfig(cfg({ minCardsPerDay: 0 }))).toContain("1 and 200");
    expect(validateRampConfig(cfg({ completionRewardCents: -1 }))).toContain("zero or above");
  });

  it("rejects a completion bonus that is switched on but pays nothing", () => {
    expect(validateRampConfig(cfg({ completionRewardCents: 0, completionInWindowBonusCents: 0 })))
      .toContain("Set a completion award");
  });
});
