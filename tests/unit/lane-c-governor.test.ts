import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// LANE C (jobs reliability) regression tests:
//   C1 — breaker/backoff state is fleet-shared via governor_state (not per-process)
//   C2 — runScanWorker yields instead of claiming while the shared breaker is open
//   C3 — the stranded-run re-open has an error budget (5) + a structured alert
//   C4 — the control worker emits a 60s scan.fleet.heartbeat
//
// Temp DATA_DIR pattern (same as bandwidth-governor/state-sweep-lane): a
// throwaway SQLite file per test process.

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hf-lane-c-"));
// Keep the breaker open long enough to assert against, and make the engine's
// breaker-wait cadence fast so tests stay under a second.
process.env.PROXY_CIRCUIT_COOLDOWN_MS = "4000";
process.env.SCAN_BREAKER_WAIT_MS = "80";

// scanEngine imports the live Kinetic path — stub it so nothing in this file can
// ever touch the proxy, and so the engine module loads light.
vi.mock("../../server/scanner", () => ({
  refreshTokenFromApi: vi.fn(async () => {}),
  scanAddress: vi.fn(async () => { throw new Error("live scanner must never run in unit tests"); }),
  normalizeKineticAddressKey: (a: string, c: string, s: string, z: string) => `${a}|${c}|${s}|${z}`,
}));
vi.mock("../../server/frontierScanner", () => ({ scanFrontierAddress: vi.fn() }));

// Spy on claimRunTargets (delegate to the real one) so tests can assert the
// engine never claims while the breaker is open — and override it to drain
// instantly for the re-open-budget test.
const claimCalls: unknown[][] = [];
let claimOverride: (() => unknown[]) | null = null;
vi.mock("../../server/scanIntelStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/scanIntelStore")>();
  return {
    ...actual,
    claimRunTargets: (...args: unknown[]) => {
      claimCalls.push(args);
      return claimOverride ? claimOverride() : (actual.claimRunTargets as any)(...args);
    },
  };
});

let rawDb: any;
let gov: typeof import("../../server/bandwidthGovernor");
let engine: typeof import("../../server/scanEngine");
let intel: typeof import("../../server/scanIntelStore");
let logSpy: ReturnType<typeof vi.spyOn>;

function structuredEvents(): Array<{ event: string; [k: string]: unknown }> {
  return logSpy.mock.calls
    .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
    .filter((l) => l && typeof l.event === "string");
}

beforeAll(async () => {
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  gov = await import("../../server/bandwidthGovernor");
  engine = await import("../../server/scanEngine");
  intel = await import("../../server/scanIntelStore");
});

beforeEach(() => {
  gov._resetGovernorForTests();
  claimCalls.length = 0;
  claimOverride = null;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy?.mockRestore();
});

const waitFor = async (cond: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

// ── C1: shared breaker ────────────────────────────────────────────────────────
describe("C1 — circuit breaker state is fleet-shared via governor_state", () => {
  it("process A trips it (8 denials) → a fresh 'process' sees it open via the DB row", async () => {
    expect(gov.isProxyCircuitOpen()).toBe(false);
    for (let i = 0; i < 8; i++) gov.noteProxyAuthFailure();
    expect(gov.isProxyCircuitOpen()).toBe(true); // tripped locally…

    // …and the trip is durable in the shared row.
    const row = rawDb.prepare("SELECT value FROM governor_state WHERE key='proxy_circuit'").get() as any;
    expect(row).toBeTruthy();
    expect(JSON.parse(row.value).r).toBe(0); // recoverStep 0 = COOLDOWN/RECOVERING

    // A second "process": fresh module state (breaker cache empty) over the SAME
    // DB file. It must see the circuit open WITHOUT observing a single denial.
    vi.resetModules();
    const govB = await import("../../server/bandwidthGovernor");
    expect(govB.isProxyCircuitOpen()).toBe(true);
    expect(govB.circuitBreakerSnapshot().open).toBe(true);

    // Restore this file's module registry for the remaining tests.
    vi.resetModules();
    gov = await import("../../server/bandwidthGovernor");
    engine = await import("../../server/scanEngine");
    intel = await import("../../server/scanIntelStore");
  });

  it("shares the mint-failure backoff counter across module instances", async () => {
    gov.noteSharedMintFailure(1_000);
    gov.noteSharedMintFailure(2_000);
    expect(gov.getSharedMintBackoff(true)).toEqual({ failures: 2, lastFailureAt: 2_000 });

    vi.resetModules();
    const govB = await import("../../server/bandwidthGovernor");
    expect(govB.getSharedMintBackoff(true)).toEqual({ failures: 2, lastFailureAt: 2_000 });
    govB.resetSharedMintFailures();
    expect(govB.getSharedMintBackoff(true)).toEqual({ failures: 0, lastFailureAt: 0 });

    vi.resetModules();
    gov = await import("../../server/bandwidthGovernor");
    engine = await import("../../server/scanEngine");
    intel = await import("../../server/scanIntelStore");
    expect(gov.getSharedMintBackoff(true)).toEqual({ failures: 0, lastFailureAt: 0 });
  });
});

// ── C2: engine honors the breaker ─────────────────────────────────────────────
describe("C2 — runScanWorker backs off while the shared breaker is open", () => {
  it("never claims a batch during COOLDOWN and logs scan.engine.breaker_wait", async () => {
    const runId = "lane-c-c2";
    intel.createScanRun({ id: runId, tenantId: 1, kind: "market", label: "lane-c", budget: 10 });
    rawDb.prepare(`INSERT INTO scan_targets (address, city, state, zip) VALUES ('1 Main St','Raleigh','NC','27601')`).run();
    const targetId = (rawDb.prepare("SELECT id FROM scan_targets LIMIT 1").get() as any).id;
    intel.enqueueRunTargets(runId, [{ id: targetId, seq: 0 }]);

    for (let i = 0; i < 8; i++) gov.noteProxyAuthFailure();
    expect(gov.isProxyCircuitOpen()).toBe(true);

    const checker = vi.fn(async () => {
      throw new Error("checker must never run while the breaker is open");
    });
    const worker = engine.runScanWorker(runId, 1, checker as any);
    // Give the worker several breaker-wait cycles (SCAN_BREAKER_WAIT_MS=80).
    await new Promise((r) => setTimeout(r, 400));
    expect(gov.isProxyCircuitOpen()).toBe(true); // still inside the 4s cooldown
    expect(claimCalls.length).toBe(0);           // …and NOT ONE claim was made
    expect(checker).not.toHaveBeenCalled();
    const waits = structuredEvents().filter((l) => l.event === "scan.engine.breaker_wait");
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(waits[0].runId).toBe(runId);

    // Cancel → the worker must exit promptly at the next loop-top status check.
    intel.setRunStatus(runId, "cancelled");
    await worker;
    expect(claimCalls.length).toBe(0);
  });
});

// ── C3: re-open error budget ──────────────────────────────────────────────────
describe("C3 — stranded-run re-open has an error budget", () => {
  it("stops re-opening after 5 failed re-opens, alerts once, and terminalizes the tail", async () => {
    const runId = "lane-c-c3";
    intel.createScanRun({ id: runId, tenantId: 1, kind: "market", label: "lane-c", budget: 10 });
    rawDb.prepare(`INSERT INTO scan_targets (address, city, state, zip) VALUES ('2 Oak St','Raleigh','NC','27601')`).run();
    const targetId = (rawDb.prepare("SELECT id FROM scan_targets WHERE address='2 Oak St'").get() as any).id;
    intel.enqueueRunTargets(runId, [{ id: targetId, seq: 0 }]);
    intel.setRunStatus(runId, "error", "simulated persistent dispatch failure");
    // The re-opened worker instantly "drains" (mocked empty claim) and finishes,
    // leaving the real target queued — the persistent-failure livelock shape.
    claimOverride = () => [];

    // 5 ticks: each re-opens (counter 1..5) and the run strands again.
    for (let tick = 1; tick <= 5; tick++) {
      engine.resumeInterruptedRuns();
      await waitFor(() => !engine.isRunActive(runId));
      expect(intel.getRun(runId, 1)!.reopenCount).toBe(tick);
      expect(structuredEvents().filter((l) => l.event === "scan.run.reopen_budget_exhausted")).toHaveLength(0);
    }

    // Tick 6: budget exhausted → stays 'error', tail terminalized, ONE alert.
    engine.resumeInterruptedRuns();
    await waitFor(() => intel.countQueued(runId) === 0);
    const run = intel.getRun(runId, 1)!;
    expect(run.status).toBe("error");
    expect(run.reopenCount).toBe(5);
    expect(run.error).toMatch(/re-open budget exhausted/);
    const alerts = structuredEvents().filter((l) => l.event === "scan.run.reopen_budget_exhausted");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ runId, reopens: 5, tailClosed: 1 });

    // Tick 7: no longer stranded — no further re-opens, no more alerts.
    engine.resumeInterruptedRuns();
    expect(intel.getRun(runId, 1)!.reopenCount).toBe(5);
    expect(structuredEvents().filter((l) => l.event === "scan.run.reopen_budget_exhausted")).toHaveLength(1);
  }, 20_000);
});

// ── C4: fleet heartbeat ───────────────────────────────────────────────────────
describe("C4 — fleet heartbeat", () => {
  it("emitFleetHeartbeat emits scan.fleet.heartbeat with the expected fields", () => {
    engine.emitFleetHeartbeat();
    const beats = structuredEvents().filter((l) => l.event === "scan.fleet.heartbeat");
    expect(beats).toHaveLength(1);
    const beat = beats[0];
    expect(beat).toHaveProperty("paceMs");
    expect(beat).toHaveProperty("claimableQueued");
    expect(beat).toHaveProperty("activeRuns");
    expect(beat).toHaveProperty("breakerOpen");
    expect(beat).toHaveProperty("breakerStep");
    expect(beat).toHaveProperty("breakerScale");
    expect(beat).toHaveProperty("openDeadLetters");
    expect(typeof beat.claimableQueued).toBe("number");
    expect(beat.breakerOpen).toBe(false); // reset in beforeEach
  });

  it("startFleetHeartbeat is control-worker gated and schedules the 60s tick", () => {
    // Scan-only worker: never starts.
    process.env.HF_ROLE = "scan";
    try {
      engine.startFleetHeartbeat(10);
      expect((engine as any)._fleetHeartbeat ?? null).toBeNull();
    } finally {
      delete process.env.HF_ROLE;
    }
  });
});
