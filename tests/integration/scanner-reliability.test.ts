// @vitest-environment node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { scannerPhase, scannerStalled, startScannerProgress, purgeTerminalScannerProgress } from "../../server/scannerReliability";
import { checkScanRunCounts } from "../../server/scanCountIntegrity";
let db: Database.Database, store: typeof import("../../server/scanIntelStore"), engine: typeof import("../../server/scanEngine");
let file: string, sequence = 0;
function target(extra: Record<string, unknown> = {}) {
  const row = { tenant_id: 1, address: `${++sequence} Fixture Street`, city: "Fixture", state: "NC", zip: "27000", carrier: "kinetic", source: "test", ...extra };
  return Number(db.prepare(`INSERT INTO scan_targets(${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row)).lastInsertRowid);
}
function run(ids: number[], kind = "city", budget = ids.length) {
  const id = `reliability-${++sequence}`;
  store.createScanRun({ id, tenantId: 1, kind, label: "Fixture", city: "Fixture", state: "NC", budget });
  store.enqueueRunTargets(id, ids.map((id, seq) => ({ id, seq })));
  return id;
}
beforeAll(async () => {
  vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "hf-reliability-test-"))); vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("RELIABILITY_ROLLOUT_PERCENT", "100");
  // Disable every implicit probe as well as provider transports before import.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Fixture forbids network")));
  (await import("../../server/storage")).runMigrations(); db = (await import("../../server/db")).rawDb;
  file = join(process.env.DATA_DIR!, "data.db"); store = await import("../../server/scanIntelStore"); engine = await import("../../server/scanEngine");
});
afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("bounds skip writes to 500 and signals continuation to a later eligible target", () => {
  const parked = Array.from({ length: 501 }, () => target({ source: "new_build_fixture", inconclusive_attempts: 3, last_inconclusive_at: "2099-01-01 00:00:00" }));
  const eligible = target(), id = run([...parked, eligible], "city", 1);
  expect(store.claimRunTargetCycle(id, 2, 1, 0, "city")).toEqual({ targets: [], inspected: 0, skipped: 0 });
  expect(store.claimRunTargetCycle(id, 1, 1, 0, "city")).toEqual({ targets: [], inspected: 500, skipped: 500 });
  expect(store.countQueued(id)).toBe(2);
  expect(store.claimRunTargetCycle(id, 1, 1, 0, "city")).toMatchObject({ targets: [{ targetId: eligible }], inspected: 2, skipped: 1 });
  expect(db.prepare("SELECT MAX(attempt_count) n FROM scan_run_targets WHERE run_id=? AND state='skipped'").get(id)).toEqual({ n: 0 });
  expect(db.prepare("SELECT attempt_count n FROM scan_run_targets WHERE run_id=? AND target_id=?").get(id, eligible)).toEqual({ n: 1 });
});
it("continues the engine past a skipped-only page without buying parked targets", async () => {
  const parked = Array.from({ length: 501 }, () => target({ source: "new_build_fixture", inconclusive_attempts: 3, last_inconclusive_at: "2099-01-01 00:00:00" }));
  const eligible = target(), id = run([...parked, eligible], "city", 1);
  const checker = vi.fn(async () => ({ result: { address: "Fixture", city: "Fixture", state: "NC", zip: "27000", success: true, fiberAvailable: false, isNewFiber: false, billingStatus: "N", fiberStatus: "no_fiber" }, bytes: 100, checkFailed: false } as any));
  await engine.runScanWorker(id, 1, checker);
  expect(checker).toHaveBeenCalledTimes(1);
  expect(store.getRun(id, 1)).toMatchObject({ status: "done", verified: 1 });
  expect(db.prepare("SELECT COUNT(*) n FROM scan_run_targets WHERE run_id=? AND state='skipped'").get(id)).toEqual({ n: 501 });
  expect(checkScanRunCounts(db, 1, id)).toMatchObject({ drift: false, verified: 1, actual_verified: 1 });
});
it.each(["city", "manual", "coming_soon_watch", "recheck"])("preserves once-only and explicit exemption for %s", kind => {
  const answered = target({ last_scanned_at: "2026-01-01 00:00:00", last_fiber_available: 0, last_is_new_fiber: 0 });
  const id = run([answered], kind);
  const claimed = store.claimRunTargetCycle(id, 1, 1, 0, kind);
  expect(claimed.targets.length).toBe(kind === "city" || kind === "recheck" ? 0 : 1);
});
it("does not inspect future retries or claim stopped work", () => {
  const id = run([target()]); db.prepare("UPDATE scan_run_targets SET next_attempt_at='2099-01-01 00:00:00' WHERE run_id=?").run(id);
  expect(store.claimRunTargetCycle(id, 1, 10, 0, "city")).toEqual({ targets: [], inspected: 0, skipped: 0 });
  db.prepare("UPDATE scan_run_targets SET next_attempt_at=NULL WHERE run_id=?").run(id);
  for (const state of ["paused", "cancelled", "done"]) {
    store.setRunStatus(id, state); expect(store.claimRunTargetCycle(id, 1, 10, 0, "city")).toEqual({ targets: [], inspected: 0, skipped: 0 });
  }
});
it.each(["start", "running", "idle"])("cleans up and permits redispatch after %s diagnostic write fails", async stage => {
  const id = run([], "city", 0), checker = vi.fn();
  const table = stage === "start" ? "fiber_job_events" : "fiber_worker_heartbeats";
  const predicate = stage === "start" ? "NEW.event_type IN ('job.started','job.resumed')" : `NEW.status='${stage}'`;
  db.exec(`CREATE TEMP TRIGGER scanner_diagnostic_fault BEFORE INSERT ON ${table} WHEN NEW.run_id='${id}' AND ${predicate} BEGIN SELECT RAISE(ABORT,'fixture diagnostic fault'); END`);
  try {
    await engine.runScanWorker(id, 1, checker);
    expect(engine.isRunActive(id)).toBe(false);
    expect(store.getRun(id, 1)?.status).toBe(stage === "idle" ? "done" : "error");
    expect(db.prepare("SELECT COUNT(*) n FROM scanner_run_progress WHERE run_id=?").get(id)).toEqual({ n: 0 });
  } finally { db.exec("DROP TRIGGER scanner_diagnostic_fault"); }
  store.setRunStatus(id, "running"); await engine.runScanWorker(id, 1, checker);
  expect(store.getRun(id, 1)?.status).toBe("done"); expect(checker).not.toHaveBeenCalled();
});
it("distinguishes cooldown from stalls and honors configured admission wait", () => {
  vi.stubEnv("PROVIDER_ADMISSION_MAX_WAIT_MS", "240000");
  const state = { runId: "phase", tenantId: 1, phase: "initializing" as const, progressAt: 0, deadlineAt: 0, inflight: 0 };
  scannerPhase(state, "cooldown", 0, 100); expect(scannerStalled(state, 1e9)).toBe(false);
  scannerPhase(state, "checking", 1, 100); expect(scannerStalled(state, 400_000)).toBe(false); expect(scannerStalled(state, 500_000)).toBe(true);
});
it("uses the real token wait budget during cold initialization", () => {
  vi.stubEnv("PROVIDER_TASK_MAX_MS", "360000");
  const progress = startScannerProgress(db, 1, run([]));
  try {
    expect(progress.state.deadlineAt! - progress.state.progressAt).toBe(360_000);
    expect(scannerStalled(progress.state, progress.state.progressAt + 180_000)).toBe(false);
    expect(scannerStalled(progress.state, progress.state.progressAt + 360_001)).toBe(true);
  } finally { progress.stop(); vi.stubEnv("PROVIDER_TASK_MAX_MS", "180000"); }
});
it("bounds stale progress cleanup while retaining active rows", async () => {
  const active = run([]), insert = db.prepare("INSERT INTO scanner_run_progress VALUES (?,1,'saving',0,0,0,0,0)");
  db.transaction(() => { for (let i = 0; i < 601; i++) insert.run(`orphan-${i}`); insert.run(active); })();
  expect(await purgeTerminalScannerProgress(db)).toBe(500); expect(await purgeTerminalScannerProgress(db)).toBe(101);
  expect(db.prepare("SELECT COUNT(*) n FROM scanner_run_progress WHERE run_id=?").get(active)).toEqual({ n: 1 });
});
it("two processes finalize identical targets without counter drift and detects injected drift", async () => {
  const ids = Array.from({ length: 80 }, () => target()), id = run(ids, "manual");
  const child = () => new Promise<{ code: number | null; error: string }>((done, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", resolve("tests/fixtures/reliability-worker.ts"), file, "scanner-finalize", id], { stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; proc.stderr.on("data", chunk => { error += chunk; }); proc.on("error", reject); proc.on("exit", code => done({ code, error }));
  });
  for (const result of await Promise.all([child(), child()])) expect(result, result.error).toMatchObject({ code: 0 });
  expect(checkScanRunCounts(db, 1, id)).toMatchObject({ drift: false, verified: 80, actual_verified: 80 });
  db.prepare("UPDATE scan_runs SET verified=verified+1 WHERE id=?").run(id);
  expect(checkScanRunCounts(db, 1, id)).toMatchObject({ drift: true, verified: 81, actual_verified: 80 });
  expect(checkScanRunCounts(db, 2, id)).toBeNull();
});
