// @vitest-environment node
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DAILY_REFRESH_COUNTS_SQL, ensureDailyRefreshIndexes, readDailyRefreshCounts } from "../../server/dailyRefreshMetrics";

const databases: Database.Database[] = [];
function fixture() {
  const db = new Database(":memory:"); databases.push(db);
  db.exec(`CREATE TABLE scan_targets (id INTEGER PRIMARY KEY, tenant_id INTEGER, last_scanned_at TEXT, first_seen_fiber_at TEXT);
    CREATE TABLE leads (tenant_id INTEGER, lead_tag TEXT, created_at TEXT);
    CREATE TABLE kinetic_addresses (tenant_id INTEGER, is_coming_soon INTEGER);`);
  ensureDailyRefreshIndexes(db);
  return db;
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe("daily refresh count snapshot", () => {
  it("counts equivalent ISO/SQLite/offset dates, preserves milliseconds and excludes another tenant", () => {
    const db = fixture();
    const insert = db.prepare("INSERT INTO scan_targets (tenant_id,last_scanned_at,first_seen_fiber_at) VALUES (?,?,?)");
    for (const value of ["2026-09-08 12:00:00.500", "2026-09-08T12:00:00.500Z", "2026-09-08T08:00:00.500-04:00", "2026-09-08 12:00:01", "2026-09-08T12:00:00.499Z", "invalid", null]) {
      insert.run(1, value, value); insert.run(2, value, value);
    }
    db.exec(`INSERT INTO leads VALUES (1,'fresh_fiber_confirmed','2026-09-08 12:00:00.500'),
      (1,'fresh_fiber_confirmed','2026-09-08T12:00:00.499Z'), (2,'fresh_fiber_confirmed','2026-09-08 13:00:00');
      INSERT INTO kinetic_addresses VALUES (1,1),(1,0),(2,1);`);
    expect(readDailyRefreshCounts(db, 1, "2026-09-08T12:00:00.500Z"))
      .toEqual({ checked: 4, newlyLit: 4, pending: 1, newLeads: 1, comingSoon: 1 });
  });
  it("uses index ranges for checked, newly lit and pending, including repeat initialization", () => {
    const db = fixture(); ensureDailyRefreshIndexes(db);
    const plans = db.prepare(`EXPLAIN QUERY PLAN ${DAILY_REFRESH_COUNTS_SQL}`)
      .all({ tenantId: 1, since: "2026-09-08T12:00:00Z" }) as Array<{ detail: string }>;
    expect(plans.filter(p => p.detail.includes("scan_targets")).map(p => p.detail)).toEqual([
      expect.stringMatching(/SEARCH scan_targets USING COVERING INDEX idx_scan_targets_tenant_checked_jd .*<expr>>/),
      expect.stringMatching(/SEARCH scan_targets USING COVERING INDEX idx_scan_targets_tenant_lit_jd .*<expr>>/),
      expect.stringMatching(/SEARCH scan_targets USING COVERING INDEX idx_scan_targets_tenant_checked_jd .*<expr>=/),
    ]);
  });
  it("rejects unscoped and invalid snapshots without default-tenant fallback", () => {
    const db = fixture();
    for (const id of [0, -1, NaN, 1.5]) expect(() => readDailyRefreshCounts(db, id, new Date().toISOString())).toThrow("Tenant required");
    expect(() => readDailyRefreshCounts(db, 1, "invalid")).toThrow("Valid refresh start required");
  });
});
