// Door drops — a surprise bonus that can land on any verified door.
//
// This pays real money off a random roll, with no human in the loop, so the
// properties worth pinning are the ones that make it trustworthy rather than
// exploitable:
//
//   1. The roll is DETERMINISTIC per knock. A retry cannot buy a second spin.
//   2. The dry spell is BOUNDED. Nobody knocks 300 doors and concludes it's fake.
//   3. Caps hold, and a capped rep does not silently burn a winning door.
//   4. The odds are honest — the long-run rate matches what the config says.
import { describe, expect, it } from "vitest";
import {
  calibratedBaseChance, DEFAULT_DOOR_DROP_CONFIG, drawAmountCents, dropChance,
  dropStatusLine, evaluateDoorDrop, expectedDailyCostCents, leanestOddsFor,
  minimumPityFor, rolls, seedHash, usd,
  validateDoorDropConfig, type DoorDropConfig, type DoorDropSignals,
} from "../../shared/doorDrop";

const cfg = (over: Partial<DoorDropConfig> = {}): DoorDropConfig => ({ ...DEFAULT_DOOR_DROP_CONFIG, ...over });

const signals = (over: Partial<DoorDropSignals> = {}): DoorDropSignals => ({
  repId: 7, knockId: 1000,
  doorsSinceLastDrop: 10,
  dropsToday: 0,
  awardedToRepTodayCents: 0,
  awardedOrgTodayCents: 0,
  ...over,
});

describe("the roll cannot be re-rolled", () => {
  it("the same knock always decides the same way", () => {
    // A retry, an offline replay, a double-tapped submit — all re-evaluate the
    // identical knock id and must reach the identical verdict.
    const s = signals({ knockId: 4242 });
    const first = evaluateDoorDrop(s);
    for (let i = 0; i < 25; i += 1) {
      expect(JSON.stringify(evaluateDoorDrop(s))).toBe(JSON.stringify(first));
    }
  });

  it("different knocks decide independently", () => {
    // If they did not, a rep would learn that door N always pays.
    const verdicts = Array.from({ length: 400 }, (_, i) =>
      "drop" in evaluateDoorDrop(signals({ knockId: 9000 + i })));
    expect(new Set(verdicts).size).toBe(2); // both outcomes occur
  });

  it("the amount is not correlated with the hit roll", () => {
    // Drawn from a separate hash. If they shared one, big awards would cluster
    // with near-certain hits and the pattern would be learnable.
    const a = rolls("door:1:1");
    expect(a.hit).not.toBe(a.amount);
    expect(seedHash("x")).not.toBe(seedHash("y"));
  });

  it("never reads a clock or a random source", async () => {
    // The engine is pure — assert it textually, because a stray Math.random()
    // would silently make every retry a fresh spin. Comments are stripped first:
    // the file's own header says "no Math.random", and a test that its
    // documentation can satisfy is not a test.
    const src = (await import("node:fs")).readFileSync("shared/doorDrop.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/Math\.random|Date\.now|new Date\(/);
  });
});

describe("the dry spell is bounded", () => {
  it("odds climb with doors since the last drop", () => {
    const c = cfg();
    expect(dropChance(30, c)).toBeLessThan(dropChance(90, c));
    expect(dropChance(90, c)).toBeLessThan(dropChance(110, c));
  });

  it("a normal day is FLAT — no cold trough after a drop, no warm run to feel", () => {
    // The point of the mechanic. If the odds ramped from door 0, calibrating to
    // 1-in-45 would force the base down to ~1-in-366, making the doors right
    // after a payout nearly worthless — the exact trough random reinforcement
    // exists to remove. The first ~72 doors of the default window are identical.
    const c = cfg();
    for (const since of [0, 1, 10, 30, 50, 70]) {
      expect(dropChance(since, c)).toBe(dropChance(0, c));
    }
    // ...and that flat rate is in the same neighbourhood as the stated odds,
    // rather than an order of magnitude below it.
    expect(dropChance(0, c)).toBeGreaterThan((1 / c.oddsOneIn) * 0.6);
  });

  it("becomes certain at the pity ceiling", () => {
    // The promise this makes: a rep can have a quiet run, never an endless one.
    expect(dropChance(DEFAULT_DOOR_DROP_CONFIG.pityAtDoors)).toBe(1);
    expect(dropChance(DEFAULT_DOOR_DROP_CONFIG.pityAtDoors + 500)).toBe(1);
  });

  it("a rep at the ceiling drops on the very next door, whatever the hash says", () => {
    const v = evaluateDoorDrop(signals({ doorsSinceLastDrop: DEFAULT_DOOR_DROP_CONFIG.pityAtDoors }));
    expect("drop" in v).toBe(true);
  });

  it("the rescue only bites deep into a dry run", () => {
    // A rep should feel lucky when it hits at door 10, not entitled.
    const c = cfg();
    const base = calibratedBaseChance(c);
    expect(dropChance(10, c)).toBe(base);
    expect(dropChance(105, c)).toBeGreaterThan(base * 3);
  });
});

describe("the long-run rate matches the config", () => {
  it("really does pay 1 in N doors, over a long walk", () => {
    // Simulated over 20k doors with the pity curve live. `oddsOneIn` is the
    // budget lever — the one number a manager sets to decide what this costs —
    // so the REALIZED rate has to match what they typed. An uncalibrated curve
    // passed a loose version of this test while running at 1-in-22.
    const uncapped = { maxPerRepPerDay: 0, maxCentsPerRepPerDay: 0, maxCentsPerOrgPerDay: 0 };
    for (const [oddsOneIn, pityAtDoors] of [[45, 120], [30, 90], [100, 250]]) {
      const c = cfg({ ...uncapped, oddsOneIn, pityAtDoors });
      let since = 0, hits = 0;
      for (let i = 0; i < 20_000; i += 1) {
        const v = evaluateDoorDrop(signals({ knockId: i, doorsSinceLastDrop: since }), c);
        if ("drop" in v) { hits += 1; since = 0; } else { since += 1; }
      }
      const oneIn = 20_000 / hits;
      // ±12% covers hash sampling noise at this sample size, and nothing else.
      expect(oneIn).toBeGreaterThan(oddsOneIn * 0.88);
      expect(oneIn).toBeLessThan(oddsOneIn * 1.12);
    }
  });

  it("the calibrated base is what makes that true, not the stated odds", () => {
    // Starting the curve at a flat 1/oddsOneIn is the intuitive thing and is
    // wrong: the pity climb stacks on top of it. The calibrated base sits well
    // below the stated rate precisely to leave room for that climb.
    for (const [oddsOneIn, pityAtDoors] of [[45, 120], [30, 90], [100, 250]]) {
      const c = cfg({ oddsOneIn, pityAtDoors });
      expect(calibratedBaseChance(c)).toBeLessThan(1 / oddsOneIn);
      expect(calibratedBaseChance(c)).toBeGreaterThan(0);
    }
  });

  it("a pity ceiling tighter than the odds cannot go negative", () => {
    // The ramp alone already pays more often than asked. Base bottoms out at 0
    // rather than trying to subtract drops it cannot subtract. Such a config is
    // refused on the way in, but a hand-edited settings row must still be
    // survivable rather than throwing inside a knock.
    const impossible = cfg({ oddsOneIn: 200, pityAtDoors: 200 });
    expect(validateDoorDropConfig(impossible)).toBeTruthy();
    expect(calibratedBaseChance(impossible)).toBe(0);
    expect(dropChance(5, impossible)).toBe(0);
  });

  it("awards land in the band, on the step", () => {
    const c = cfg();
    for (let i = 0; i < 500; i += 1) {
      const amt = drawAmountCents(i / 500, c);
      expect(amt).toBeGreaterThanOrEqual(c.minCents);
      expect(amt).toBeLessThanOrEqual(c.maxCents);
      expect(amt % c.stepCents).toBe(0);
    }
  });
});

describe("caps", () => {
  it("stops once the rep has had their daily count", () => {
    const v = evaluateDoorDrop(signals({ dropsToday: 3, doorsSinceLastDrop: 999 }), cfg({ maxPerRepPerDay: 3 }));
    expect("drop" in v).toBe(false);
    if ("drop" in v) return;
    expect(v.skip).toBe("rep_count_cap");
  });

  it("stops at the rep's daily money cap", () => {
    const v = evaluateDoorDrop(signals({ awardedToRepTodayCents: 6_000, doorsSinceLastDrop: 999 }),
      cfg({ maxCentsPerRepPerDay: 6_000 }));
    if ("drop" in v) throw new Error("should not drop");
    expect(v.skip).toBe("rep_money_cap");
  });

  it("stops at the ORG's daily cap, however lucky one rep is", () => {
    const v = evaluateDoorDrop(signals({ awardedOrgTodayCents: 40_000, doorsSinceLastDrop: 999 }),
      cfg({ maxCentsPerOrgPerDay: 40_000 }));
    if ("drop" in v) throw new Error("should not drop");
    expect(v.skip).toBe("org_money_cap");
  });

  it("trims to the room left rather than refusing", () => {
    const v = evaluateDoorDrop(signals({ awardedToRepTodayCents: 5_800, doorsSinceLastDrop: 999 }),
      cfg({ maxCentsPerRepPerDay: 6_000 }));
    if (!("drop" in v)) throw new Error("should drop");
    expect(v.drop.amountCents).toBe(200);
  });

  it("a capped rep does NOT burn the winning door — the counter keeps climbing", () => {
    // Caps are checked before the roll is spent. The pity counter is maintained
    // by the caller from ledger history, so a door refused at the cap still
    // counts toward tomorrow's drop rather than evaporating.
    const capped = cfg({ maxPerRepPerDay: 1 });
    const v = evaluateDoorDrop(signals({ dropsToday: 1, doorsSinceLastDrop: 200 }), capped);
    if ("drop" in v) throw new Error("should not drop");
    expect(v.skip).toBe("rep_count_cap"); // not "no_roll" — the roll was never spent
  });

  it("0 means uncapped", () => {
    const v = evaluateDoorDrop(
      signals({ dropsToday: 99, awardedToRepTodayCents: 99_000, awardedOrgTodayCents: 999_000, doorsSinceLastDrop: 999 }),
      cfg({ maxPerRepPerDay: 0, maxCentsPerRepPerDay: 0, maxCentsPerOrgPerDay: 0 }));
    expect("drop" in v).toBe(true);
  });

  it("a disabled programme never drops", () => {
    const v = evaluateDoorDrop(signals({ doorsSinceLastDrop: 999 }), cfg({ enabled: false }));
    if ("drop" in v) throw new Error("should not drop");
    expect(v.skip).toBe("disabled");
  });
});

describe("what the rep reads", () => {
  it("never shows a percentage or a countdown", () => {
    // A field app is not a slot machine readout, and a countdown hands back the
    // deterministic counter this mechanic exists to avoid.
    for (const since of [0, 5, 30, 80, 200]) {
      const line = dropStatusLine(since);
      expect(line).not.toMatch(/%/);
      expect(line).not.toMatch(/\d+\s*(doors?|more)\s*(to go|left|until)/i);
    }
  });

  it("acknowledges a long dry run", () => {
    expect(dropStatusLine(0)).toMatch(/Any door/);
    expect(dropStatusLine(110)).toMatch(/due/);
  });

  it("formats money without a float", () => {
    expect(usd(1_500)).toBe("$15");
    expect(usd(1_250)).toBe("$12.50");
  });
});

describe("validation", () => {
  it("accepts the shipped default", () => {
    expect(validateDoorDropConfig(DEFAULT_DOOR_DROP_CONFIG)).toBeNull();
  });

  it("refuses a guarantee that arrives before the odds could fire", () => {
    // That would make it a countdown, which is the mechanic this deliberately
    // is not — and it would quietly pay several times what was budgeted.
    expect(validateDoorDropConfig(cfg({ oddsOneIn: 50, pityAtDoors: 10 })))
      .toMatch(/countdown/);
  });

  it("tells the manager what to type instead of only saying no", () => {
    // A validation message that refuses without a remedy just gets guessed at
    // until something sticks.
    const msg = validateDoorDropConfig(cfg({ oddsOneIn: 100, pityAtDoors: 110 }))!;
    const suggested = Number(msg.match(/about (\d+) doors/)![1]);
    expect(validateDoorDropConfig(cfg({ oddsOneIn: 100, pityAtDoors: suggested }))).toBeNull();
  });

  it("the suggested guarantee is the smallest one that works", () => {
    for (const odds of [20, 45, 100, 250]) {
      const p = minimumPityFor(odds);
      expect(leanestOddsFor(p)).toBeGreaterThanOrEqual(odds);
      expect(validateDoorDropConfig(cfg({ oddsOneIn: odds, pityAtDoors: p }))).toBeNull();
    }
  });

  it("refuses a max below the min", () => {
    expect(validateDoorDropConfig(cfg({ minCents: 2_000, maxCents: 500 }))).toMatch(/cannot be below/);
  });

  it("refuses a four-figure drop", () => {
    expect(validateDoorDropConfig(cfg({ minCents: 1, maxCents: 200_000 }))).toMatch(/between 1 and 100000|\$1,000/);
  });
});

describe("what it costs", () => {
  it("estimates the daily bill from door volume and headcount", () => {
    // 70 doors × 10 reps at 1-in-45, $5–$25 → roughly 15 drops at ~$15.
    const c = cfg();
    const cost = expectedDailyCostCents(70, 10, c);
    expect(cost).toBeGreaterThan(10_000);
    expect(cost).toBeLessThanOrEqual(c.maxCentsPerOrgPerDay);
  });

  it("is bounded by the org cap however many reps there are", () => {
    const c = cfg();
    expect(expectedDailyCostCents(200, 500, c)).toBeLessThanOrEqual(c.maxCentsPerOrgPerDay);
  });
});
