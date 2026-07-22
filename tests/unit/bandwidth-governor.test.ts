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
    // Unknown size → adaptive estimate: the 24KB seed has already moved toward
    // the observed 10KB sample (24000 + 0.05·(10000−24000) = 23300).
    gov.recordProxyResponse(0);
    gov.recordProxyResponse(20_000);
    gov.flushBandwidthLedger();
    const rows = rawDb.prepare("SELECT bytes, requests FROM bandwidth_ledger").all();
    const totalB = rows.reduce((a: number, r: any) => a + r.bytes, 0);
    const totalR = rows.reduce((a: number, r: any) => a + r.requests, 0);
    expect(totalR).toBe(3);
    expect(totalB).toBe(10_000 + 23_300 + 20_000);
    const stats = gov.governorStats();
    expect(stats.budgetGb).toBe(1);
    expect(stats.requests24h).toBe(3);
    expect(stats.mb24h).toBeGreaterThan(0);   // rolling-24h window sees the flushed bytes
    expect(stats.circuitOpen).toBe(false);
  });

  it("per-request estimate converges toward observed sizes and stays clamped", () => {
    expect(gov.governorStats().estReqBytes).toBe(24_000);   // seed
    for (let i = 0; i < 200; i++) gov.recordProxyResponse(6_000);
    const est = gov.governorStats().estReqBytes;
    expect(est).toBeGreaterThanOrEqual(6_000);
    expect(est).toBeLessThan(7_000);                        // converged near 6KB
    // A pathological giant response can't blow up the estimate…
    for (let i = 0; i < 500; i++) gov.recordProxyResponse(50_000_000);
    expect(gov.governorStats().estReqBytes).toBeLessThanOrEqual(256_000);
    // …and a flood of tiny ones can't drive it below the floor.
    gov._resetGovernorForTests();
    for (let i = 0; i < 500; i++) gov.recordProxyResponse(1);
    expect(gov.governorStats().estReqBytes).toBeGreaterThanOrEqual(2_000);
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

  it("harvest cycle freezes during the circuit cooldown", async () => {
    for (let i = 0; i < 8; i++) gov.noteProxyAuthFailure();
    const { runHarvestCycle } = await import("../../server/freshHarvest");
    const counts = runHarvestCycle(1, 100);
    expect(counts).toMatchObject({ b: 0, b2: 0, c0: 0, c: 0, d1: 0, d: 0 });
  });
});

describe("graduated circuit breaker — probe-recover, never a 30-minute blackout", () => {
  beforeEach(() => gov._resetGovernorForTests());

  it("a trip is a BRIEF cooldown, then a probe trickle — not a hard freeze", () => {
    for (let i = 0; i < 8; i++) gov.noteProxyAuthFailure();
    // Cooldown: fully paused, but for seconds (bounded by CIRCUIT_COOLDOWN_MS),
    // not the old 30 minutes.
    expect(gov.isProxyCircuitOpen()).toBe(true);
    expect(gov.proxyThrottleScale()).toBe(0);
    // Past the cooldown window the circuit is RECOVERING: a trickle flows, and
    // scanning is no longer suspended (isProxyCircuitOpen === false).
    const past = Date.now() + 25_000;
    expect(gov.proxyThrottleScale(past)).toBeGreaterThan(0);
    expect(gov.proxyThrottleScale(past)).toBeLessThan(1); // floor, not full
  });

  it("consecutive successful probes ramp the trickle back to full, then close", () => {
    for (let i = 0; i < 8; i++) gov.noteProxyAuthFailure();
    const past = Date.now() + 25_000;
    const floor = gov.proxyThrottleScale(past);
    // 3 successes per step, 4 steps (floor→0.2→0.5→1) → 12 successes to close.
    for (let i = 0; i < 3; i++) gov.noteProxySuccess();
    const step2 = gov.proxyThrottleScale(past);
    expect(step2).toBeGreaterThan(floor);
    for (let i = 0; i < 9; i++) gov.noteProxySuccess();
    expect(gov.proxyThrottleScale(past)).toBe(1); // fully recovered / closed
    expect(gov.isProxyCircuitOpen()).toBe(false);
  });

  it("a failure while recovering drops back to the floor + re-arms cooldown, never blacks out", () => {
    for (let i = 0; i < 8; i++) gov.noteProxyAuthFailure();
    const past = Date.now() + 25_000;
    for (let i = 0; i < 6; i++) gov.noteProxySuccess(); // climbed a couple steps
    expect(gov.proxyThrottleScale(past)).toBeGreaterThan(0.05);
    gov.noteProxyAuthFailure(); // Decodo still flaky
    // Re-armed cooldown (brief) — NOT a 30-min open — then back to the floor.
    expect(gov.isProxyCircuitOpen()).toBe(true);
    expect(gov.proxyThrottleScale(Date.now() + 25_000)).toBeCloseTo(0.05, 5);
  });

  it("budget scale carries the trickle: below the 0.1 pacing floor while recovering", () => {
    for (let i = 0; i < 8; i++) gov.noteProxyAuthFailure();
    // During cooldown → 0. (No ledger rows → pace neutral 1 otherwise.)
    expect(gov.bandwidthBudgetScale()).toBe(0);
  });
});
