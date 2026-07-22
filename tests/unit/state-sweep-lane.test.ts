import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Proves the boot-wedge serialization gate: the statewide-sweep "single lane"
// (enqueueStateSweepLane) never runs two heavy city-loops at once, even when
// NC+SC+GA are all started concurrently on a deploy boot. Without the gate three
// runStateSweep drivers each drive a city loop simultaneously — the 3× OSM
// harvest + scan burst that starved /api and rolled the release back.
let sweep: typeof import("../../server/sweepService");

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-state-sweep-lane-"));
  const { rawDb } = await import("../../server/db");
  void rawDb;
  const storage = await import("../../server/storage");
  storage.runMigrations();
  sweep = await import("../../server/sweepService");
});

afterEach(() => sweep.__resetStateSweepLane());

const tick = () => new Promise((r) => setImmediate(r));

describe("enqueueStateSweepLane — one heavy sweep at a time", () => {
  it("runs enqueued tasks strictly one at a time, never overlapping", async () => {
    let active = 0;
    let maxConcurrent = 0;
    const order: number[] = [];

    // Each task: mark itself active, yield across several ticks (simulating a
    // long city loop), then finish. If the lane leaked, two would overlap and
    // maxConcurrent would exceed 1.
    const makeTask = (label: number) => async () => {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      order.push(label);
      for (let i = 0; i < 5; i++) await tick();
      active--;
    };

    // Fire all three "states" concurrently, exactly like the deploy boot loop.
    const all = Promise.all([
      sweep.enqueueStateSweepLane(makeTask(1)),
      sweep.enqueueStateSweepLane(makeTask(2)),
      sweep.enqueueStateSweepLane(makeTask(3)),
    ]);

    await all;
    expect(maxConcurrent).toBe(1);      // never two city loops at once
    expect(order).toEqual([1, 2, 3]);   // FIFO — NC fully before SC before GA
  });

  it("keeps the lane alive after a task rejects (one failure can't wedge the rest)", async () => {
    const ran: number[] = [];
    const failing = sweep.enqueueStateSweepLane(async () => { throw new Error("boom"); });
    const after = sweep.enqueueStateSweepLane(async () => { ran.push(2); });

    await expect(failing).rejects.toThrow("boom"); // the caller still sees the error
    await after;
    expect(ran).toEqual([2]);                      // ...and the next sweep still runs
  });

  it("returns each task's own resolved value to its caller", async () => {
    const a = sweep.enqueueStateSweepLane(async () => "nc");
    const b = sweep.enqueueStateSweepLane(async () => "sc");
    expect(await a).toBe("nc");
    expect(await b).toBe("sc");
  });
});
