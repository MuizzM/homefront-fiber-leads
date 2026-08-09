// The momentum engine, pinned.
//
// This decides real money from live field signals with no human in the loop, so
// the properties worth a test are the ones that would either break the mechanic
// or let someone farm it:
//
//   1. CONVERSATIONS OUTWEIGH SPEED. A rep who knocks fast and talks to nobody
//      must never arm an offer, or the system pays people to skip pitches.
//   2. FLOORS BEAT SANDBAGGING. A low personal baseline cannot manufacture an
//      offer out of a slow hour.
//   3. THE PROGRESS STORY IS HONEST. The score the rep watches climb is the same
//      one that unlocks the tier.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOMENTUM_CONFIG, evaluateMomentum, momentumScore, offerCountdown,
  streakHeadline, tierFor, usd, validateMomentumConfig,
  type MomentumConfig, type MomentumSignals,
} from "../../shared/momentumSpiff";

const NOW = Date.UTC(2026, 7, 3, 15, 0, 0);

/** A rep genuinely running hot: doors, real conversations, live interest, dry. */
function hot(over: Partial<MomentumSignals> = {}): MomentumSignals {
  return {
    repId: 1,
    doorsInWindow: 24,
    conversationsInWindow: 9,
    interestSignalsInWindow: 3,
    baselineDoorsPerHour: 12,
    minutesSinceLastSale: 300,
    offersArmedToday: 0,
    awardedToRepTodayCents: 0,
    awardedOrgTodayCents: 0,
    ...over,
  };
}

const cfg = (over: Partial<MomentumConfig> = {}): MomentumConfig => ({ ...DEFAULT_MOMENTUM_CONFIG, ...over });

describe("what counts as hot", () => {
  it("arms for a rep with doors, conversations, and unconverted interest", () => {
    const v = evaluateMomentum(hot(), NOW);
    expect("offer" in v).toBe(true);
    if (!("offer" in v)) return;
    expect(v.offer.amountCents).toBeGreaterThan(0);
    expect(v.offer.expiresAtMs).toBe(NOW + DEFAULT_MOMENTUM_CONFIG.offerMinutes * 60_000);
  });

  it("does NOT arm for a speed-walker who talks to nobody", () => {
    // 40 doors in the window — more than the hot rep — but every one was
    // not_home. Paying this rep to go faster would teach the whole floor to
    // skip conversations, which is the opposite of the point.
    const v = evaluateMomentum(hot({ doorsInWindow: 40, conversationsInWindow: 0, interestSignalsInWindow: 0 }), NOW);
    expect("offer" in v).toBe(false);
    if ("offer" in v) return;
    expect(v.block).toBe("too_few_conversations");
  });

  it("does not arm on conversations that all went nowhere", () => {
    // Doors opened, people talked, nobody was interested. Real activity, but
    // there is no warm thread to convert.
    const v = evaluateMomentum(hot({ interestSignalsInWindow: 0 }), NOW);
    expect("offer" in v).toBe(false);
    if ("offer" in v) return;
    expect(v.block).toBe("no_interest");
  });

  it("does not arm right after a sale - there is nothing to convert", () => {
    const v = evaluateMomentum(hot({ minutesSinceLastSale: 10 }), NOW);
    expect("offer" in v).toBe(false);
    if ("offer" in v) return;
    expect(v.block).toBe("just_sold");
  });

  it("does not arm when the config is off", () => {
    const v = evaluateMomentum(hot(), NOW, cfg({ enabled: false }));
    expect("offer" in v).toBe(false);
    if ("offer" in v) return;
    expect(v.block).toBe("disabled");
  });
});

describe("sandbagging cannot manufacture an offer", () => {
  it("a rep who coasted for two weeks still needs the absolute door floor", () => {
    // Baseline of 1 door/hour means ANY activity clears the 1.15× pace ratio.
    // The absolute floor is the only thing standing here — and it holds.
    const v = evaluateMomentum(hot({ doorsInWindow: 6, conversationsInWindow: 4, baselineDoorsPerHour: 1 }), NOW);
    expect("offer" in v).toBe(false);
    if ("offer" in v) return;
    expect(v.block).toBe("too_few_doors");
  });

  it("the floors are checked BEFORE the ratio, so the block names the real reason", () => {
    // If the ratio were checked first, this would report "off_pace" and an
    // admin reading the logs would tune the wrong knob.
    const v = evaluateMomentum(hot({ doorsInWindow: 3, baselineDoorsPerHour: 100 }), NOW);
    if ("offer" in v) throw new Error("should not arm");
    expect(v.block).toBe("too_few_doors");
  });

  it("a rep working below their own established pace does not arm", () => {
    // 24 doors in 90 min = 16/hr. A 20/hr baseline needs 23/hr to clear 1.15×.
    const v = evaluateMomentum(hot({ baselineDoorsPerHour: 20 }), NOW);
    expect("offer" in v).toBe(false);
    if ("offer" in v) return;
    expect(v.block).toBe("off_pace");
  });

  it("a brand-new rep with no history is not held to a ratio they cannot have", () => {
    const v = evaluateMomentum(hot({ baselineDoorsPerHour: 0 }), NOW);
    expect("offer" in v).toBe(true);
  });
});

describe("the score rewards conversation over volume", () => {
  it("a talker outscores a speed-walker who knocked more doors", () => {
    const talker = momentumScore(hot({ doorsInWindow: 20, conversationsInWindow: 10, interestSignalsInWindow: 4 }));
    const sprinter = momentumScore(hot({ doorsInWindow: 40, conversationsInWindow: 1, interestSignalsInWindow: 0 }));
    expect(talker).toBeGreaterThan(sprinter);
  });

  it("pure volume with no conversation cannot reach the arming threshold", () => {
    // The ceiling for a rep who talks to nobody: volume 25 + pace 30 = 55 at
    // absolute maximum, and realistically far less. It must not clear the bar
    // on volume alone.
    const s = momentumScore(hot({ doorsInWindow: 30, conversationsInWindow: 0, interestSignalsInWindow: 0, baselineDoorsPerHour: 12 }));
    expect(s).toBeLessThan(DEFAULT_MOMENTUM_CONFIG.armAtScore);
  });

  it("is bounded to 0–100 for absurd inputs", () => {
    const huge = momentumScore(hot({ doorsInWindow: 5_000, conversationsInWindow: 5_000, interestSignalsInWindow: 900, baselineDoorsPerHour: 0.01 }));
    expect(huge).toBeLessThanOrEqual(100);
    expect(momentumScore(hot({ doorsInWindow: 0, conversationsInWindow: 0, interestSignalsInWindow: 0 }))).toBeGreaterThanOrEqual(0);
  });
});

describe("tiers", () => {
  it("pays the highest tier the score clears", () => {
    expect(tierFor(54)).toBe(0);
    expect(tierFor(55)).toBe(2_500);
    expect(tierFor(69)).toBe(2_500);
    expect(tierFor(70)).toBe(4_000);
    expect(tierFor(100)).toBe(6_000);
  });

  it("is order-independent - a config listing tiers backwards still pays correctly", () => {
    const backwards = cfg({ tiers: [
      { atScore: 85, amountCents: 6_000 },
      { atScore: 55, amountCents: 2_500 },
      { atScore: 70, amountCents: 4_000 },
    ] });
    expect(tierFor(72, backwards)).toBe(4_000);
  });
});

describe("caps trim rather than reject", () => {
  it("a rep near their daily cap gets what is left, not nothing", () => {
    const v = evaluateMomentum(hot({ awardedToRepTodayCents: 9_000 }), NOW, cfg({ maxCentsPerRepPerDay: 10_000 }));
    if (!("offer" in v)) throw new Error("should arm");
    expect(v.offer.amountCents).toBe(1_000);
  });

  it("stops entirely once the rep's cap is spent", () => {
    const v = evaluateMomentum(hot({ awardedToRepTodayCents: 10_000 }), NOW, cfg({ maxCentsPerRepPerDay: 10_000 }));
    if ("offer" in v) throw new Error("should not arm");
    expect(v.block).toBe("rep_money_cap");
  });

  it("stops once the ORG's day is spent, however hot one rep is", () => {
    const v = evaluateMomentum(hot({ awardedOrgTodayCents: 50_000 }), NOW, cfg({ maxCentsPerOrgPerDay: 50_000 }));
    if ("offer" in v) throw new Error("should not arm");
    expect(v.block).toBe("org_money_cap");
  });

  it("refuses a third offer once the per-rep daily count is used up", () => {
    const v = evaluateMomentum(hot({ offersArmedToday: 2 }), NOW, cfg({ maxOffersPerRepPerDay: 2 }));
    if ("offer" in v) throw new Error("should not arm");
    expect(v.block).toBe("rep_offer_cap");
  });

  it("0 means uncapped, not 'nothing allowed'", () => {
    const v = evaluateMomentum(hot({ offersArmedToday: 99, awardedToRepTodayCents: 99_000, awardedOrgTodayCents: 990_000 }),
      NOW, cfg({ maxOffersPerRepPerDay: 0, maxCentsPerRepPerDay: 0, maxCentsPerOrgPerDay: 0 }));
    expect("offer" in v).toBe(true);
  });
});

describe("what the rep reads", () => {
  it("names the interest, not a slogan", () => {
    expect(streakHeadline(hot({ interestSignalsInWindow: 3 }))).toBe("3 doors interested and none closed yet");
  });

  it("falls back to conversations, then to doors", () => {
    expect(streakHeadline(hot({ interestSignalsInWindow: 1, conversationsInWindow: 5 })))
      .toBe("5 real conversations in the last hour");
    expect(streakHeadline(hot({ interestSignalsInWindow: 1, conversationsInWindow: 2, doorsInWindow: 14 })))
      .toBe("14 doors and people are talking");
  });

  it("the call to action states the deadline and the money", () => {
    const v = evaluateMomentum(hot(), NOW);
    if (!("offer" in v)) throw new Error("should arm");
    expect(v.offer.callToAction).toBe("Close one in the next 45 minutes for $25.");
  });

  it("counts down in minutes and never shows a negative", () => {
    expect(offerCountdown(NOW + 12 * 60_000, NOW)).toBe("12m left");
    expect(offerCountdown(NOW + 30_000, NOW)).toBe("Under a minute");
    expect(offerCountdown(NOW - 1, NOW)).toBe("Expired");
  });

  it("formats money without ever showing a float", () => {
    expect(usd(2_500)).toBe("$25");
    expect(usd(4_050)).toBe("$40.50");
    expect(usd(0)).toBe("$0");
  });
});

describe("validation the server and the form share", () => {
  it("accepts the shipped default", () => {
    expect(validateMomentumConfig(DEFAULT_MOMENTUM_CONFIG)).toBeNull();
  });

  it("refuses a four-figure offer", () => {
    expect(validateMomentumConfig(cfg({ tiers: [{ atScore: 50, amountCents: 500_000 }] }))).toMatch(/\$1,000/);
  });

  it("refuses a config whose lowest tier can never be reached", () => {
    // armAtScore 55 but the cheapest tier needs 80 — it would look live on the
    // admin screen and silently never fire, which is worse than being off.
    expect(validateMomentumConfig(cfg({ armAtScore: 55, tiers: [{ atScore: 80, amountCents: 2_500 }] })))
      .toMatch(/no offer can ever fire/);
  });

  it("allows that same unreachable ladder when it is switched OFF", () => {
    expect(validateMomentumConfig(cfg({ enabled: false, armAtScore: 55, tiers: [{ atScore: 80, amountCents: 2_500 }] })))
      .toBeNull();
  });

  it("refuses an offer window too short to walk to another door", () => {
    expect(validateMomentumConfig(cfg({ offerMinutes: 2 }))).toMatch(/Offer length/);
  });

  it("refuses a pace multiple below 1 - that would arm for going slower", () => {
    expect(validateMomentumConfig(cfg({ paceRatio: 0.5 }))).toMatch(/Pace multiple/);
  });

  it("refuses a ladder with no tiers at all", () => {
    expect(validateMomentumConfig(cfg({ tiers: [] }))).toMatch(/at least one/);
  });
});

describe("progress and payout agree", () => {
  // The meter the rep watches climb must unlock exactly what the evaluator pays.
  // If these drift, a rep sees a bar hit the line and no offer appears.
  it("an armed offer always matches the tier its own score unlocks", () => {
    for (const doors of [12, 18, 24, 30, 40]) {
      for (const convs of [3, 6, 10, 16]) {
        const s = hot({ doorsInWindow: doors, conversationsInWindow: Math.min(convs, doors), interestSignalsInWindow: 3 });
        const v = evaluateMomentum(s, NOW);
        if (!("offer" in v)) continue;
        expect(v.offer.score).toBe(momentumScore(s));
        expect(v.offer.amountCents).toBe(tierFor(momentumScore(s)));
      }
    }
  });

  it("anything that scores below the arm threshold never produces an offer", () => {
    for (const doors of [12, 20, 30]) {
      const s = hot({ doorsInWindow: doors, conversationsInWindow: 3, interestSignalsInWindow: 1, baselineDoorsPerHour: 0 });
      const v = evaluateMomentum(s, NOW);
      const score = momentumScore(s);
      expect("offer" in v).toBe(score >= DEFAULT_MOMENTUM_CONFIG.armAtScore && tierFor(score) > 0);
    }
  });
});
