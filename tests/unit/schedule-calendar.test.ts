// Schedule calendar math (shared/schedule.ts): local-calendar weeks and the
// quick appointment slots. Everything is wall-clock local, never UTC, because a
// callback date is the day the rep picked on their phone.
import { describe, expect, it } from "vitest";
import { addDaysISO, quickSlots, toISODate, weekOf } from "../../shared/schedule";

describe("weekOf", () => {
  it("returns Monday through Sunday of the week containing the date", () => {
    // 2026-08-21 is a Friday.
    expect(weekOf("2026-08-21")).toEqual([
      "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23",
    ]);
  });
  it("treats Sunday as the END of the week, not the start", () => {
    expect(weekOf("2026-08-23")[0]).toBe("2026-08-17");
    expect(weekOf("2026-08-24")[0]).toBe("2026-08-24");
  });
  it("crosses month and year boundaries in local calendar space", () => {
    expect(weekOf("2026-01-01")).toEqual([
      "2025-12-29", "2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04",
    ]);
    expect(addDaysISO("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDaysISO("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("quickSlots", () => {
  const at = (iso: string, h: number, m: number) => { const d = new Date(iso + "T00:00:00"); d.setHours(h, m, 0, 0); return d; };

  it("offers today rounded up to the next half hour after a 30 minute buffer", () => {
    const slots = quickSlots(at("2026-08-21", 16, 52)); // Friday 4:52 PM
    expect(slots[0]).toEqual({ label: "Today 5:30 PM", date: "2026-08-21", time: "17:30" });
    expect(slots[1]).toEqual({ label: "Tomorrow 10 AM", date: "2026-08-22", time: "10:00" });
    // Tomorrow IS Saturday, so the weekend slot skips to the following Saturday.
    expect(slots[2]).toEqual({ label: "Sat 2 PM", date: "2026-08-29", time: "14:00" });
    expect(slots[3]).toEqual({ label: "Mon 9 AM", date: "2026-08-24", time: "09:00" });
  });

  it("drops the today slot once the working day is over", () => {
    const slots = quickSlots(at("2026-08-19", 18, 40)); // Wednesday 6:40 PM -> 7:30 PM is past close
    expect(slots[0].label).toBe("Tomorrow 10 AM");
    expect(slots.map(s => s.date)).toEqual(["2026-08-20", "2026-08-22", "2026-08-24"]);
  });

  it("never offers a today slot before opening time", () => {
    const slots = quickSlots(at("2026-08-19", 7, 5));
    expect(slots[0]).toEqual({ label: "Today 9 AM", date: "2026-08-19", time: "09:00" });
  });

  it("on a Sunday, Monday is tomorrow so the Monday slot moves a week out", () => {
    const slots = quickSlots(at("2026-08-23", 10, 0));
    expect(slots[1].date).toBe("2026-08-24");
    expect(slots[3]).toEqual({ label: "Mon 9 AM", date: "2026-08-31", time: "09:00" });
    expect(slots[2]).toEqual({ label: "Sat 2 PM", date: "2026-08-29", time: "14:00" });
  });

  it("every slot is on or after today", () => {
    const now = at("2026-08-21", 12, 0);
    for (const s of quickSlots(now)) expect(s.date >= toISODate(now)).toBe(true);
  });
});
