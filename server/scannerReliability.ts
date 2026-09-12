import { providerAdmissionWaitMs, providerTaskWaitMs } from "./providerDeadline";
import type Database from "better-sqlite3";
import { reliabilityEnabled } from "./reliabilityFeatures";
import { structuredLog } from "./structuredLog";
import { withoutSqliteBusyWait, retrySqliteOperation } from "./interactiveDb";

type Phase = "initializing" | "claiming" | "checking" | "cooldown" | "saving";
export interface ScannerProgress {
  runId: string; tenantId: number; phase: Phase; progressAt: number; deadlineAt: number | null; inflight: number;
}
export function ensureScannerReliabilitySchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scanner_run_progress (
    run_id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL CHECK(tenant_id>0),
    phase TEXT NOT NULL, progress_at INTEGER NOT NULL, deadline_at INTEGER, inflight INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL, stalled INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scanner_progress_tenant ON scanner_run_progress(tenant_id,heartbeat_at)`);
}
/** Liveness and progress are different: intentional cooldown has no deadline.
 * A checking phase includes the existing admission + actual transport timeout.
 * Diagnostics never reclaim a still-running promise or bypass the governor. */
export function scannerPhase(state: ScannerProgress, phase: Phase, inflight = 0, now = Date.now()): void {
  state.phase = phase; state.inflight = inflight; state.progressAt = now;
  state.deadlineAt = phase === "cooldown" ? null : now + (phase === "checking"
    ? providerAdmissionWaitMs() + providerTaskWaitMs() : phase === "initializing" ? providerTaskWaitMs() : 120_000);
}
/** Completion diagnostics are best effort; this bounded sweep retries rows
 * left behind by contention or a crashed worker. A quiet tick takes no writer. */
export async function purgeTerminalScannerProgress(db: Database.Database): Promise<number> {
  const ids = db.prepare(`SELECT p.run_id FROM scanner_run_progress p
    WHERE NOT EXISTS (SELECT 1 FROM scan_runs r WHERE r.id=p.run_id AND r.tenant_id=p.tenant_id AND r.status='running')
    LIMIT 500`).all() as Array<{ run_id: string }>;
  if (!ids.length) return 0;
  return retrySqliteOperation(db, () => db.prepare(`DELETE FROM scanner_run_progress
    WHERE run_id IN (${ids.map(() => "?").join(",")}) AND NOT EXISTS
      (SELECT 1 FROM scan_runs r WHERE r.id=scanner_run_progress.run_id AND r.tenant_id=scanner_run_progress.tenant_id AND r.status='running')`)
    .run(...ids.map(row => row.run_id)).changes);
}
export function scannerStalled(state: ScannerProgress, now = Date.now()): boolean {
  return state.deadlineAt != null && now > state.deadlineAt;
}
export function startScannerProgress(db: Database.Database, tenantId: number, runId: string) {
  const state: ScannerProgress = { tenantId, runId, phase: "initializing", progressAt: Date.now(), deadlineAt: null, inflight: 0 };
  scannerPhase(state, "initializing");
  let reportedStall = false;
  const enabled = reliabilityEnabled("SCANNER_HEARTBEAT", tenantId);
  const tick = () => {
    if (!enabled) return;
    const now = Date.now(), stalled = scannerStalled(state, now);
    try {
      withoutSqliteBusyWait(db, () => db.prepare(`INSERT INTO scanner_run_progress
        (run_id,tenant_id,phase,progress_at,deadline_at,inflight,heartbeat_at,stalled) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(run_id) DO UPDATE SET phase=excluded.phase,progress_at=excluded.progress_at,
          deadline_at=excluded.deadline_at,inflight=excluded.inflight,heartbeat_at=excluded.heartbeat_at,stalled=excluded.stalled
        WHERE scanner_run_progress.tenant_id=excluded.tenant_id`)
        .run(runId, tenantId, state.phase, state.progressAt, state.deadlineAt, state.inflight, now, stalled ? 1 : 0));
      structuredLog("scanner.heartbeat", { tenantId, runId, phase: state.phase, inflight: state.inflight,
        stallDurationMs: Math.max(0, now - state.progressAt), stalled });
      if (stalled && !reportedStall) structuredLog("scanner.stall_detected", { tenantId, runId, phase: state.phase }, "error");
      reportedStall = stalled;
    } catch { /* diagnostic writer contention must never strand the real worker */ }
  };
  const timer = enabled ? setInterval(tick, 30_000) : null;
  timer?.unref(); tick();
  return { state, stop: () => {
    if (timer) clearInterval(timer);
    if (enabled) try { withoutSqliteBusyWait(db, () => db.prepare(`DELETE FROM scanner_run_progress WHERE run_id=? AND tenant_id=?`).run(runId, tenantId)); } catch { /* terminal run join hides stale diagnostic row */ }
  } };
}
export function scannerReliabilitySnapshot(db: Database.Database, tenantId: number, now = Date.now()) {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) throw new Error("Tenant required");
  return db.prepare(`SELECT p.run_id AS runId,p.phase,p.progress_at AS progressAt,p.heartbeat_at AS heartbeatAt,
    p.inflight,CASE WHEN p.deadline_at IS NOT NULL AND p.deadline_at<? THEN 1 ELSE 0 END AS stalled,
    CASE WHEN p.heartbeat_at<? THEN 1 ELSE 0 END AS recovering
    FROM scanner_run_progress p JOIN scan_runs r ON r.id=p.run_id AND r.tenant_id=p.tenant_id
    WHERE p.tenant_id=? AND r.status='running' ORDER BY p.heartbeat_at LIMIT 50`).all(now, now - 120_000, tenantId);
}
