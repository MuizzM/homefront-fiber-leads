// Genuine-door day bonus — the pure anti-gaming counter. Everything here is
// deterministic: no clock, no RNG. The cases below are the actual attacks the
// module exists to defeat, each written as the shape of a fabricated day, plus
// the honest days that must keep paying.
import { describe, expect, it } from "vitest";
import {
  countGenuineDoors,
  evaluateDoorDay,
  doorDayProgress,
  validateDoorDayConfig,
  formatSpan,
  usd,
  DEFAULT_DOOR_DAY_CONFIG,
  type DoorDayConfig,
  type DoorEvent,
} from "../../shared/genuineDoors";

const cfg = (o: Partial<DoorDayConfig> = {}): DoorDayConfig => ({ ...DEFAULT_DOOR_DAY_CONFIG, ...o });

const T0 = Date.UTC(2026, 7, 6, 14, 0, 0); // a fixed instant; nothing reads a clock

/** `n` doors, `everySeconds` apart, at distinct addresses. */
function walk(n: number, everySeconds: number, startMs = T0, firstLead = 1): DoorEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    leadId: firstLead + i,
    atMs: startMs + i * everySeconds * 1000,
  }));
}

/** An honest shift: 60 doors over five hours, one every five minutes. */
const HONEST_DAY = walk(60, 300);

describe("countGenuineDoors - one house, one door", () => {
  it("counts the same address exactly once, however many times it is tapped", () => {
    const events: DoorEvent[] = [
      { leadId: 1, atMs: T0 },
      { leadId: 1, atMs: T0 + 60_000 },
      { leadId: 1, atMs: T0 + 120_000 },
      { leadId: 2, atMs: T0 + 180_000 },
    ];
    const c = countGenuineDoors(events, cfg());
    expect(c.counted).toBe(2);
    expect(c.rejected.same_address).toBe(2);
  });

  it("reports what it dropped, so the counter never looks broken", () => {
    const c = countGenuineDoors([...HONEST_DAY, { leadId: 1, atMs: T0 + 10_000_000 }], cfg());
    expect(c.submitted).toBe(61);
    expect(c.counted).toBe(60);
    expect(c.rejected.same_address).toBe(1);
  });
});

describe("countGenuineDoors - the walk that did not happen", () => {
  it("drops a door logged inside the minimum gap", () => {
    // Sixty distinct addresses, four seconds apart: the drive-by list attack.
    // The four-minute burst survives only as one door per 20-second gap — 12 of
    // the 60 — and the day it belongs to is nowhere near payable.
    const c = countGenuineDoors(walk(60, 4), cfg());
    expect(c.counted).toBe(12);
    expect(c.rejected.too_fast).toBe(48);
    expect(evaluateDoorDay(walk(60, 4), 0, cfg()).qualifies).toBe(false);
  });

  it("measures the gap from the last COUNTED door, not the last submitted one", () => {
    // Padding a burst with junk taps must not space out the doors that count.
    const events: DoorEvent[] = [
      { leadId: 1, atMs: T0 },
      { leadId: 2, atMs: T0 + 5_000 },   // dropped: 5s after door 1
      { leadId: 3, atMs: T0 + 10_000 },  // dropped: 10s after door 1, not 5s after door 2
      { leadId: 4, atMs: T0 + 15_000 },  // dropped
      { leadId: 5, atMs: T0 + 25_000 },  // counted: 25s after door 1
    ];
    const c = countGenuineDoors(events, cfg({ minGapSeconds: 20 }));
    expect(c.counted).toBe(2);
    expect(c.rejected.too_fast).toBe(3);
  });

  it("keeps an honest pace intact", () => {
    expect(countGenuineDoors(HONEST_DAY, cfg()).rejected.too_fast).toBe(0);
  });
});

describe("countGenuineDoors - the rolling-hour ceiling", () => {
  it("stops counting past the cap inside any 60 minutes", () => {
    // 40 doors 30s apart = 20 minutes. The cap is 25.
    const c = countGenuineDoors(walk(40, 30), cfg({ minGapSeconds: 20, maxPerRollingHour: 25 }));
    expect(c.counted).toBe(25);
    expect(c.rejected.hour_cap).toBe(15);
  });

  it("rolls: doors resume counting once the window has moved on", () => {
    // 25 doors in the first ten minutes, then one an hour and a half later.
    const burst = walk(25, 25, T0);
    const later: DoorEvent[] = [{ leadId: 500, atMs: T0 + 90 * 60_000 }];
    const c = countGenuineDoors([...burst, ...later], cfg({ minGapSeconds: 20, maxPerRollingHour: 25 }));
    expect(c.counted).toBe(26);
    expect(c.rejected.hour_cap).toBe(0);
  });

  it("is a ROLLING window, not a clock hour", () => {
    // 25 doors ending at T0, then more immediately after: still inside 60 min.
    const first = walk(25, 60, T0);                       // T0 .. T0+24m
    const second = walk(10, 60, T0 + 25 * 60_000, 100);   // T0+25m .. T0+34m
    const c = countGenuineDoors([...first, ...second], cfg({ maxPerRollingHour: 25 }));
    expect(c.counted).toBe(25);
    expect(c.rejected.hour_cap).toBe(10);
  });
});

describe("evaluateDoorDay - the day has to have taken a day", () => {
  it("pays an honest 60-door shift", () => {
    const d = evaluateDoorDay(HONEST_DAY, 0, cfg());
    expect(d.qualifies).toBe(true);
    expect(d.awardCents).toBe(5_000);
    expect(d.count.counted).toBe(60);
    expect(d.reason).toBe("60 genuine doors in a day");
  });

  it("refuses a day that reached the target too fast, and says so", () => {
    // 60 doors, 25 seconds apart, with the hour cap lifted: 25 minutes flat.
    const d = evaluateDoorDay(walk(60, 25), 0, cfg({ maxPerRollingHour: 0 }));
    expect(d.count.counted).toBe(60);
    expect(d.qualifies).toBe(false);
    expect(d.blockedBy).toBe("span");
    expect(d.headline).toContain("full 3 hours");
  });

  it("measures the span to the TARGET door, so a late door cannot rescue a burst", () => {
    // 60 doors inside 25 minutes, then one door eight hours later. The day's
    // first-to-last span is 8h; the span that earned the 60th door is 25m.
    const burst = walk(60, 25, T0);
    const evening: DoorEvent[] = [{ leadId: 900, atMs: T0 + 8 * 3_600_000 }];
    const d = evaluateDoorDay([...burst, ...evening], 0, cfg({ maxPerRollingHour: 0 }));
    expect(d.qualifies).toBe(false);
    expect(d.blockedBy).toBe("span");
    expect(d.count.spanMinutes).toBeLessThan(30);
  });

  it("does not pay a day that is short of the target", () => {
    const d = evaluateDoorDay(walk(59, 300), 0, cfg());
    expect(d.qualifies).toBe(false);
    expect(d.blockedBy).toBe("doors");
    expect(d.headline).toContain("1 more genuine door");
  });

  it("counts the honest offline-heavy shift the same as any other", () => {
    // Nothing in the counter knows or cares which clock timed the doors; the
    // store picks that (see genuineDoorBonusStore.timeDoors).
    const d = evaluateDoorDay(walk(60, 240), 0, cfg());
    expect(d.qualifies).toBe(true);
  });
});

describe("evaluateDoorDay - tamper voids the day, not just the bad knocks", () => {
  it("withholds a qualifying day that carries hard tamper evidence", () => {
    const d = evaluateDoorDay(HONEST_DAY, 1, cfg());
    expect(d.qualifies).toBe(false);
    expect(d.blockedBy).toBe("tamper");
    expect(d.needsReview).toBe(true);
    expect(d.awardCents).toBe(0);
  });

  it("tamper outranks every other verdict", () => {
    // Not enough doors AND tamper: the rep needs an admin, not more doors.
    const d = evaluateDoorDay(walk(3, 300), 2, cfg());
    expect(d.blockedBy).toBe("tamper");
  });

  it("pays normally when the org has turned voiding off", () => {
    const d = evaluateDoorDay(HONEST_DAY, 5, cfg({ voidOnTamper: false }));
    expect(d.qualifies).toBe(true);
  });
});

describe("evaluateDoorDay - edges", () => {
  it("pays nothing when disabled", () => {
    const d = evaluateDoorDay(HONEST_DAY, 0, cfg({ enabled: false }));
    expect(d.qualifies).toBe(false);
    expect(d.blockedBy).toBe("disabled");
  });

  it("pays nothing on a zero reward", () => {
    expect(evaluateDoorDay(HONEST_DAY, 0, cfg({ rewardCents: 0 })).qualifies).toBe(false);
  });

  it("survives an empty day, junk timestamps, and out-of-order events", () => {
    expect(evaluateDoorDay([], 0, cfg()).count.counted).toBe(0);
    const junk = [{ leadId: 1, atMs: NaN }, { leadId: 2, atMs: T0 }] as DoorEvent[];
    expect(countGenuineDoors(junk, cfg()).counted).toBe(1);
    const shuffled = [...HONEST_DAY].reverse();
    expect(evaluateDoorDay(shuffled, 0, cfg()).qualifies).toBe(true);
  });

  it("is deterministic - the same day always counts to the same number", () => {
    const a = evaluateDoorDay(HONEST_DAY, 0, cfg());
    const b = evaluateDoorDay([...HONEST_DAY].reverse(), 0, cfg());
    expect(a.count.counted).toBe(b.count.counted);
    expect(a.count.spanMinutes).toBe(b.count.spanMinutes);
    expect(a.awardCents).toBe(b.awardCents);
  });

  it("breaks simultaneous-timestamp ties deterministically", () => {
    const tied: DoorEvent[] = [
      { leadId: 9, atMs: T0 }, { leadId: 3, atMs: T0 }, { leadId: 7, atMs: T0 },
    ];
    expect(countGenuineDoors(tied, cfg()).counted).toBe(1);
    expect(countGenuineDoors([...tied].reverse(), cfg()).counted).toBe(1);
  });
});

describe("doorDayProgress - what the rep is shown", () => {
  it("tracks the climb toward the target", () => {
    const p = doorDayProgress(evaluateDoorDay(walk(30, 300), 0, cfg()), cfg());
    expect(p.counted).toBe(30);
    expect(p.remaining).toBe(30);
    expect(p.pct).toBe(50);
    expect(p.earned).toBe(false);
  });

  it("flags the too-fast day so the rep is not left guessing", () => {
    const p = doorDayProgress(evaluateDoorDay(walk(60, 25), 0, cfg({ maxPerRollingHour: 0 })), cfg({ maxPerRollingHour: 0 }));
    expect(p.spanShort).toBe(true);
    expect(p.pct).toBe(100);
    expect(p.earned).toBe(false);
  });

  it("renders nothing for a disabled org", () => {
    expect(doorDayProgress(evaluateDoorDay([], 0, cfg({ enabled: false })), cfg({ enabled: false })).enabled).toBe(false);
  });
});

describe("validateDoorDayConfig", () => {
  it("accepts the defaults", () => {
    expect(validateDoorDayConfig(DEFAULT_DOOR_DAY_CONFIG)).toBeNull();
  });

  it("rejects money that is not a whole positive number of cents", () => {
    expect(validateDoorDayConfig(cfg({ rewardCents: 0 }))).toContain("above zero");
    expect(validateDoorDayConfig(cfg({ rewardCents: 12.5 as any }))).toContain("above zero");
    expect(validateDoorDayConfig(cfg({ rewardCents: 200_000 }))).toContain("$1,000");
  });

  it("rejects an out-of-range target, span, cap, or gap", () => {
    expect(validateDoorDayConfig(cfg({ doors: 0 }))).toContain("1 and 500");
    expect(validateDoorDayConfig(cfg({ minSpanMinutes: 2_000 }))).toContain("24 hours");
    expect(validateDoorDayConfig(cfg({ maxPerRollingHour: -1 }))).toContain("0 and 500");
    expect(validateDoorDayConfig(cfg({ minGapSeconds: 5_000 }))).toContain("an hour");
  });

  it("rejects a rule that cannot physically be satisfied in one day", () => {
    // 500 doors at 1/hour is 499 hours of knocking.
    expect(validateDoorDayConfig(cfg({ doors: 500, maxPerRollingHour: 1 }))).toContain("cannot fit in a day");
    // 500 doors 3600s apart is the same problem from the other direction.
    expect(validateDoorDayConfig(cfg({ doors: 500, maxPerRollingHour: 0, minGapSeconds: 3_600 }))).toContain("cannot fit in a day");
  });
});

describe("copy helpers", () => {
  it("never renders a float digit", () => {
    expect(usd(5_000)).toBe("$50");
    expect(usd(4_750)).toBe("$47.50");
    expect(usd(0)).toBe("$0");
  });

  it("says the span the way a rep would", () => {
    expect(formatSpan(45)).toBe("45 minutes");
    expect(formatSpan(180)).toBe("3 hours");
    expect(formatSpan(210)).toBe("3.5 hours");
  });
});
