import type Database from "better-sqlite3";
import { reliabilityEnabled } from "./reliabilityFeatures";
import { withoutSqliteBusyWait } from "./interactiveDb";
import { structuredLog } from "./structuredLog";

export function ensureScanCountIntegritySchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scanner_count_checks (
    run_id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL CHECK(tenant_id>0), checked_at INTEGER NOT NULL,
    verified INTEGER NOT NULL, actual_verified INTEGER NOT NULL, failed INTEGER NOT NULL, actual_failed INTEGER NOT NULL)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scanner_count_checks_tenant ON scanner_count_checks(tenant_id,checked_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scanner_count_checks_retention ON scanner_count_checks(checked_at)`);
}

/** COUNT_ATOMIC_UPDATES enables completion-time validation of the existing
 * atomic counters. Correctness and guarded SQL increments are never disabled.
 * One snapshot prevents concurrent finalization from manufacturing drift. */
export function checkScanRunCounts(db: Database.Database, tenantId: number, runId: string) {
  if (!reliabilityEnabled("COUNT_ATOMIC_UPDATES", tenantId)) return null;
  const row = db.prepare(`SELECT r.verified,r.failed,
    (SELECT COUNT(*) FROM scan_run_targets t WHERE t.run_id=r.id AND t.state='verified') AS actual_verified,
    (SELECT COUNT(*) FROM scan_run_targets t WHERE t.run_id=r.id AND t.state='failed') AS actual_failed
    FROM scan_runs r WHERE r.id=? AND r.tenant_id=?`).get(runId, tenantId) as
      { verified: number; failed: number; actual_verified: number; actual_failed: number } | undefined;
  if (!row) return null;
  const drift = row.verified !== row.actual_verified || row.failed !== row.actual_failed;
  // Persistence is diagnostic only; a contended writer must not delay recovery.
  withoutSqliteBusyWait(db, () => db.prepare(`INSERT INTO scanner_count_checks
    (run_id,tenant_id,checked_at,verified,actual_verified,failed,actual_failed) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET checked_at=excluded.checked_at,verified=excluded.verified,
      actual_verified=excluded.actual_verified,failed=excluded.failed,actual_failed=excluded.actual_failed
    WHERE scanner_count_checks.tenant_id=excluded.tenant_id`)
    .run(runId, tenantId, Date.now(), row.verified, row.actual_verified, row.failed, row.actual_failed));
  structuredLog(drift ? "counters.drift_detected" : "counters.atomic_verified", { tenantId, runId, ...row }, drift ? "error" : "info");
  return { ...row, drift };
}
