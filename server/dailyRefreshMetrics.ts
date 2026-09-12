import type Database from "better-sqlite3";

// julianday accepts both historical SQLite UTC strings and ISO timestamps,
// including offsets and milliseconds. Do not compare their text representations.
export function ensureDailyRefreshIndexes(db: Database.Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scan_targets_tenant_checked_jd
    ON scan_targets(tenant_id, julianday(last_scanned_at), last_scanned_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_scan_targets_tenant_lit_jd
    ON scan_targets(tenant_id, julianday(first_seen_fiber_at))`);
}

export const DAILY_REFRESH_COUNTS_SQL = `SELECT
  (SELECT COUNT(*) FROM scan_targets WHERE tenant_id=@tenantId
    AND julianday(last_scanned_at)>=julianday(@since)) AS checked,
  (SELECT COUNT(*) FROM leads WHERE tenant_id=@tenantId
    AND lead_tag='fresh_fiber_confirmed' AND julianday(created_at)>=julianday(@since)) AS newLeads,
  (SELECT COUNT(*) FROM kinetic_addresses WHERE tenant_id=@tenantId AND is_coming_soon=1) AS comingSoon,
  (SELECT COUNT(*) FROM scan_targets WHERE tenant_id=@tenantId
    AND julianday(first_seen_fiber_at)>=julianday(@since)) AS newlyLit,
  (SELECT COUNT(*) FROM scan_targets WHERE tenant_id=@tenantId
    AND julianday(last_scanned_at) IS NULL AND last_scanned_at IS NULL) AS pending`;

export interface DailyRefreshCounts {
  checked: number; newLeads: number; comingSoon: number; newlyLit: number; pending: number;
}

/** One read statement gives all counters the same SQLite snapshot; no writer lock. */
export function readDailyRefreshCounts(db: Database.Database, tenantId: number, since: string): DailyRefreshCounts {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) throw new Error("Tenant required");
  if (!Number.isFinite(Date.parse(since))) throw new Error("Valid refresh start required");
  return db.prepare(DAILY_REFRESH_COUNTS_SQL).get({ tenantId, since }) as DailyRefreshCounts;
}
