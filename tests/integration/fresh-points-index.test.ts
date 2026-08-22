// ── freshPoints() index ──────────────────────────────────────────────────────
//
// freshPoints() in server/stateMonitorStore.ts serves /api/scan/first-seen-live,
// /api/scan/changes, /api/monitor/summary|fresh|clusters and the alert
// scheduler. Its WHERE is tenant + last_fiber_available=1 + a first-seen window,
// ordered by first_seen_live_at. The planner's only tenant-keyed option was
// idx_scan_targets_street, which walks every row of the tenant: measured on the
// 919k-row production-shaped copy, 5.5 to 10.3 s per call, synchronous on the
// HTTP worker (the production report had the route at p50 1.5 s, p95 5.2 s).
// With the partial index the same query returns identical rows in 5 to 46 ms.
//
// The index is declared in the migration array AND in the scan_targets
// table-rebuild path (which drops every index with the old table); both are
// asserted, because the rebuild silently undoing it is the known failure mode.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let rawDb: import("better-sqlite3").Database;
let freshPoints: typeof import("../../server/stateMonitorStore").freshPoints;

const LIVE_FRESH_INDEX = "idx_scan_targets_live_fresh";

/** The query freshPoints() runs, reduced to the predicate the planner sees. */
const REPRESENTATIVE = `
  SELECT s.id FROM scan_targets s
   WHERE s.state IN ('FL','GA','IA','KY','NC','SC')
     AND s.last_fiber_available=1
     AND COALESCE(s.first_seen_fiber_at,s.first_seen_live_at) >= datetime('now', '-30 days')
     AND s.lat IS NOT NULL AND s.lng IS NOT NULL AND s.tenant_id=1
   ORDER BY s.first_seen_live_at DESC`;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-fresh-points-idx-"));
  process.env.NODE_ENV = "test";
  const storageMod = await import("../../server/storage");
  storageMod.runMigrations();
  ({ rawDb } = await import("../../server/db"));
  ({ freshPoints } = await import("../../server/stateMonitorStore"));
});

describe("the freshPoints index exists and is the plan's choice", () => {
  it("a fresh install creates the partial index on the live rows only", () => {
    const row = rawDb.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name = ?`).get(LIVE_FRESH_INDEX) as any;
    expect(row?.sql).toBeTruthy();
    expect(row.sql).toMatch(/\(tenant_id,\s*first_seen_live_at DESC\)/);
    expect(row.sql).toMatch(/WHERE last_fiber_available\s*=\s*1/);
  });

  it("the table-rebuild path recreates it too", async () => {
    const src = await import("node:fs").then(fs => fs.readFileSync(join(process.cwd(), "server/storage.ts"), "utf8"));
    const declarations = src.split(LIVE_FRESH_INDEX).length - 1;
    // Migration array + recreateIndexes(): the comment on idx_scan_targets_market_sync
    // explains why the rebuild must repeat every index.
    expect(declarations).toBeGreaterThanOrEqual(2);
  });

  it("the planner picks it for freshPoints' predicate, not the per-tenant street walk", () => {
    const plan = (rawDb.prepare(`EXPLAIN QUERY PLAN ${REPRESENTATIVE}`).all() as any[]).map(r => String(r.detail)).join("\n");
    expect(plan).toContain(LIVE_FRESH_INDEX);
    expect(plan).not.toContain("idx_scan_targets_street");
  });

  it("freshPoints returns the live rows in the window, newest first, and nothing regressed", () => {
    const ins = rawDb.prepare(`
      INSERT INTO scan_targets (tenant_id, address, city, state, zip, lat, lng, last_fiber_available, first_seen_live_at, last_scanned_at)
      VALUES (1, ?, 'Salisbury', 'NC', '28146', 35.67, -80.47, ?, ?, datetime('now'))`);
    ins.run("1 Live Now Ln", 1, new Date(Date.now() - 3_600_000).toISOString());
    ins.run("2 Live Older Ln", 1, new Date(Date.now() - 5 * 86_400_000).toISOString());
    ins.run("3 Regressed Ln", 0, new Date(Date.now() - 3_600_000).toISOString());
    ins.run("4 Too Old Ln", 1, new Date(Date.now() - 60 * 86_400_000).toISOString());
    const points = freshPoints(1, 30);
    expect(points.map(p => p.address)).toEqual(["1 Live Now Ln", "2 Live Older Ln"]);
    expect(freshPoints(1, 2).map(p => p.address)).toEqual(["1 Live Now Ln"]);
  });
});
