import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  nextWakeDelay, budgetShapeFactor, easternHour,
  wakeHarvest, startHarvestScheduler, _resetHarvestSchedulerForTests,
} from "../../server/harvestScheduler";

describe("nextWakeDelay", () => {
  it("waits out the min-interval cooldown after a recent run", () => {
    // Ran 10s ago, 60s min interval → wait ~50s.
    expect(nextWakeDelay(10_000, 0, 60_000, 3_000)).toBe(50_000);
  });
  it("fires after just the debounce window once the cooldown has passed", () => {
    // Ran 5 min ago, cooldown long gone → only the debounce delay.
    expect(nextWakeDelay(300_000, 0, 60_000, 3_000)).toBe(3_000);
  });
});

describe("budgetShapeFactor (Eastern time)", () => {
  // July → EDT (UTC−4).
  it("boosts overnight Eastern hours", () => {
    expect(budgetShapeFactor(new Date("2026-07-21T06:00:00Z"))).toBe(1.5); // 02:00 EDT
    expect(easternHour(new Date("2026-07-21T06:00:00Z"))).toBe(2);
  });
  it("is neutral during Eastern knock hours (no daytime cut - budget is not the constraint)", () => {
    expect(budgetShapeFactor(new Date("2026-07-21T14:00:00Z"))).toBe(1.0); // 10:00 EDT
    expect(easternHour(new Date("2026-07-21T14:00:00Z"))).toBe(10);
  });
  it("is neutral in the shoulder evening", () => {
    expect(budgetShapeFactor(new Date("2026-07-22T00:00:00Z"))).toBe(1); // 20:00 EDT
  });
});

describe("wakeHarvest scheduling", () => {
  beforeEach(() => { vi.useFakeTimers(); _resetHarvestSchedulerForTests(); });
  afterEach(() => { _resetHarvestSchedulerForTests(); vi.useRealTimers(); });

  it("coalesces a burst of wakes into a single off-cycle run", async () => {
    const tick = vi.fn(() => Promise.resolve());
    startHarvestScheduler(tick, { intervalMs: 15 * 60_000, firstDelayMs: 999 * 60_000 });
    // A whole street lighting: many wakes in the same tick.
    for (let i = 0; i < 20; i++) wakeHarvest("fresh_drop");
    await vi.advanceTimersByTimeAsync(4_000); // past the 3s debounce
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("does not stack a wake on top of a running or just-run cycle (min interval)", async () => {
    const tick = vi.fn(() => Promise.resolve());
    startHarvestScheduler(tick, { intervalMs: 15 * 60_000, firstDelayMs: 999 * 60_000 });
    wakeHarvest("a");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(tick).toHaveBeenCalledTimes(1);      // first wake ran
    wakeHarvest("b");                            // immediately after → inside cooldown
    await vi.advanceTimersByTimeAsync(4_000);
    expect(tick).toHaveBeenCalledTimes(1);       // still just one — cooldown holds
    await vi.advanceTimersByTimeAsync(60_000);   // let the cooldown elapse
    expect(tick).toHaveBeenCalledTimes(2);       // the queued wake then fires
  });

  it("is a no-op before a scheduler is started", () => {
    _resetHarvestSchedulerForTests();
    expect(() => wakeHarvest("noop")).not.toThrow();
  });
});
