// Contract tests for the drill-card review ladder (lane CE-3). Pins the exact
// ladder math the coaching engine relies on: again→0, hard→same, good→+1,
// easy→+2 (clamped), and due = +10 minutes at rung 0 else +LADDER_DAYS days.
import { describe, expect, it } from "vitest";
import {
  LADDER_DAYS,
  GRADES,
  MAX_RUNG,
  AGAIN_DELAY_MS,
  nextRung,
  nextDueAt,
  type Grade,
} from "../../shared/trainingSchedule";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("review ladder", () => {
  it("has the exact frozen ladder", () => {
    expect([...LADDER_DAYS]).toEqual([0, 1, 3, 7, 16]);
    expect(MAX_RUNG).toBe(4);
    expect(GRADES).toEqual(["again", "hard", "good", "easy"]);
    expect(AGAIN_DELAY_MS).toBe(10 * 60 * 1000);
  });

  it("again always returns to rung 0", () => {
    for (let rung = 0; rung <= MAX_RUNG; rung++) {
      expect(nextRung(rung, "again"), `rung ${rung}`).toBe(0);
    }
  });

  it("hard keeps the same rung", () => {
    for (let rung = 0; rung <= MAX_RUNG; rung++) {
      expect(nextRung(rung, "hard"), `rung ${rung}`).toBe(rung);
    }
  });

  it("good climbs exactly one rung, clamped at the top", () => {
    expect(nextRung(0, "good")).toBe(1);
    expect(nextRung(1, "good")).toBe(2);
    expect(nextRung(2, "good")).toBe(3);
    expect(nextRung(3, "good")).toBe(4);
    expect(nextRung(4, "good")).toBe(4);
  });

  it("easy climbs exactly two rungs, clamped at the top", () => {
    expect(nextRung(0, "easy")).toBe(2);
    expect(nextRung(1, "easy")).toBe(3);
    expect(nextRung(2, "easy")).toBe(4);
    expect(nextRung(3, "easy")).toBe(4);
    expect(nextRung(4, "easy")).toBe(4);
  });

  it("clamps out-of-range input rungs before applying the grade", () => {
    expect(nextRung(-3, "hard")).toBe(0);
    expect(nextRung(-3, "good")).toBe(1);
    expect(nextRung(99, "hard")).toBe(MAX_RUNG);
    expect(nextRung(99, "again")).toBe(0);
  });

  it("grades from every rung stay inside the ladder", () => {
    for (let rung = 0; rung <= MAX_RUNG; rung++) {
      for (const grade of GRADES) {
        const next = nextRung(rung, grade as Grade);
        expect(next).toBeGreaterThanOrEqual(0);
        expect(next).toBeLessThanOrEqual(MAX_RUNG);
      }
    }
  });

  it("due is +10 minutes whenever the NEW rung is 0", () => {
    const from = new Date("2026-03-01T12:00:00.000Z");
    // again from anywhere lands on rung 0 → +10 min.
    for (let rung = 0; rung <= MAX_RUNG; rung++) {
      expect(nextDueAt(rung, "again", from).getTime()).toBe(from.getTime() + AGAIN_DELAY_MS);
    }
    // hard at rung 0 stays at rung 0 → +10 min, not +0 ms.
    expect(nextDueAt(0, "hard", from).getTime()).toBe(from.getTime() + AGAIN_DELAY_MS);
  });

  it("due is +LADDER_DAYS[new rung] whole days for every non-zero rung", () => {
    const from = new Date("2026-03-01T12:00:00.000Z");
    // (rung, grade) → new rung → days.
    const cases: [number, Grade, number][] = [
      [0, "good", 1], // rung 1 → 1 day
      [1, "good", 2], // rung 2 → 3 days
      [2, "good", 3], // rung 3 → 7 days
      [3, "good", 4], // rung 4 → 16 days
      [4, "good", 4], // clamped → 16 days
      [0, "easy", 2], // rung 2 → 3 days
      [2, "easy", 4], // rung 4 → 16 days
      [3, "easy", 4], // clamped → 16 days
      [1, "hard", 1], // rung 1 → 1 day
      [3, "hard", 3], // rung 3 → 7 days
      [4, "hard", 4], // rung 4 → 16 days
    ];
    for (const [rung, grade, newRung] of cases) {
      const expected = from.getTime() + LADDER_DAYS[newRung] * DAY_MS;
      expect(nextDueAt(rung, grade, from).getTime(), `${rung}/${grade}`).toBe(expected);
    }
  });

  it("accepts epoch-ms input and never mutates its Date input", () => {
    const from = new Date("2026-03-01T12:00:00.000Z");
    const snapshot = from.getTime();
    const viaDate = nextDueAt(1, "good", from);
    const viaMs = nextDueAt(1, "good", from.getTime());
    expect(viaDate.getTime()).toBe(viaMs.getTime());
    expect(from.getTime()).toBe(snapshot);
  });
});
