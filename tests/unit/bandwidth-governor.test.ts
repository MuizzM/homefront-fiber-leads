import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolate the DB; tiny plan so pacing math is easy to reason about.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hf-bw-"));
process.env.DECODO_BUDGET_GB = "1";      // 1GB plan, 10% reserve → 0.9GB usable
vi.mock("../../server/scanService", () => ({ startTargetRun: vi.fn(() => ({ runId: "run_test", queued: 0, budget: 0 })) }));

let rawDb: any, gov: any;

beforeAll(async () => {
  ({ rawDb } = await import("../../server/db"));
  gov = await import("../../server/bandwidthGovernor");
});

beforeEach(() => {
  gov._resetGovernorForTests();
  rawDb.exec("DROP TABLE IF EXISTS bandwidth_ledger");
  // force table re-creation on next access
  (gov as any).__proto__; // no-op, ensureTable re-runs via fresh CREATE IF NOT EXISTS
});

describe("bandwidth governor", () => {
  it("ledgers proxied bytes (batched) and reports stats", () => {
    gov.recordProxyResponse(10_000);
    gov.recordProxyResponse(0);            // unknown size → default estimate
    gov.recordProxyResponse(20_000);
    gov.flushBandwidthLedger();
    const rows = rawDb.prepare("SELECT bytes, requests FROM bandwidth_ledger").all();
    const totalB = rows.reduce((a: number, r: any) => a + r.bytes, 0);
    const totalR = rows.reduce((a: number, r: any) => a + r.requests, 0);
    expect(totalR).toBe(3);
    expect(totalB).toBe(10_000 + 24_000 + 20_000);
    const stats = gov.governorStats();
    expect(stats.budgetGb).toBe(1);
    expect(stats.requests24h).toBe(3);
    expect(stats.circuitOpen).toBe(false);
  });

  it("scale is neutral (1) with no burn, and collapses when the pool is torched", () => {
    expect(gov.bandwidthBudgetScale()).toBe(1);
    // Burn 2× the usable pool (1.8GB) inside this billing cycle.
    rawDb.exec("CREATE TABLE IF NOT EXISTS bandwidth_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, bytes INTEGER NOT NULL, requests INTEGER NOT NULL)");
    rawDb.prepare("INSERT INTO bandwidth_ledger (ts, bytes, requests) VALUES (?,?,?)")
      .run(Date.now(), 1.8e9, 10_000);
    const scale = gov.bandwidthBudgetScale();
    expect(scale).toBeLessThan(0.5);       // way over pace → deep throttle
    expect(scale).toBeGreaterThanOrEqual(0.1);
  });

  it("circuit breaker opens after repeated auth denials and freezes the budget", () => {
    expect(gov.isProxyCircuitOpen()).toBe(false);
    for (let i = 0; i < 8; i++) gov.noteProxyAuthFailure();
    expect(gov.isProxyCircuitOpen()).toBe(true);
    expect(gov.bandwidthBudgetScale()).toBe(0);   // frozen while circuit open
  });

  it("successful responses reset the failure counter", () => {
    for (let i = 0; i < 7; i++) gov.noteProxyAuthFailure();
    gov.noteProxySuccess();
    for (let i = 0; i < 7; i++) gov.noteProxyAuthFailure();
    expect(gov.isProxyCircuitOpen()).toBe(false); // never hit 8 consecutive-in-window
  });

  it("harvest cycle freezes when the circuit is open", async () => {
    for (let i = 0; i < 8; i++) gov.noteProxyAuthFailure();
    const { runHarvestCycle } = await import("../../server/freshHarvest");
    const counts = runHarvestCycle(1, 100);
    expect(counts).toMatchObject({ a: 0, b: 0, b2: 0, c0: 0, c: 0, d1: 0, d: 0 });
  });
});
