import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Small daily cap so the ceiling is easy to hit; set BEFORE import (read at load).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hf-mbx-"));
process.env.MAPBOX_DAILY_REQUEST_CAP = "5";
process.env.MAPBOX_MONTHLY_REQUEST_CAP = "0"; // monthly unlimited for this test

let mbx: typeof import("../../server/mapboxBudget");
let rawDb: any;

beforeAll(async () => {
  ({ rawDb } = await import("../../server/db"));
  mbx = await import("../../server/mapboxBudget");
});
beforeEach(() => mbx._resetMapboxBudgetForTests());

describe("Mapbox spend governor — the ceiling that makes grid caps removable", () => {
  it("allows spend under the cap and refuses once exhausted", () => {
    expect(mbx.canSpendMapbox()).toBe(true);
    for (let i = 0; i < 5; i++) mbx.recordMapboxRequests(1);
    expect(mbx.canSpendMapbox()).toBe(false); // hit the daily cap of 5
    const st = mbx.mapboxBudgetState();
    expect(st.dayUsed).toBe(5);
    expect(st.dayRemaining).toBe(0);
    expect(st.exhausted).toBe(true);
  });

  it("mapboxFetch throws a typed, non-fatal error when exhausted (callers fall back to OSM)", async () => {
    for (let i = 0; i < 5; i++) mbx.recordMapboxRequests(1);
    await expect(mbx.mapboxFetch("https://api.mapbox.com/x")).rejects.toMatchObject({
      code: "MAPBOX_BUDGET_EXHAUSTED",
    });
    // The error is an instance of the exported class so callers can catch it precisely.
    await mbx.mapboxFetch("https://api.mapbox.com/x").catch((e) => {
      expect(e).toBeInstanceOf(mbx.MapboxBudgetExhaustedError);
    });
  });

  it("budget resets are per-UTC-day (used counts only today's ledger)", () => {
    mbx.recordMapboxRequests(3);
    mbx.flushMapboxLedger();
    expect(mbx.mapboxBudgetState().dayUsed).toBe(3);
    // A row stamped >1 day ago must not count against today.
    rawDb.prepare("INSERT INTO mapbox_ledger (ts, requests) VALUES (?, ?)").run(Date.now() - 36 * 3600_000, 1000);
    expect(mbx.mapboxBudgetState().dayUsed).toBe(3); // yesterday's 1000 excluded
  });
});
