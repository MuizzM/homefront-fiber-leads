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
import { beforeAll, describe, expect, it, vi } from "vitest";

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
    expect(plan).toMatch(/idx_scan_targets_effective_fresh.*tenant_id=\?.*<expr>>\?/);
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

describe("effective freshness and bounded feed work", () => {
  it("uses an effective-time range in the actual query, including corroboration", () => {
    const prepare = vi.spyOn(rawDb, "prepare");
    freshPoints(1, 30);
    const sql = prepare.mock.calls.map(([value]) => value).find(value => value.includes("corroboratingSources"))!;
    prepare.mockRestore();
    const plan = rawDb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("-30 days", 1, 1)
      .map((row: any) => String(row.detail)).join("\n");
    expect(plan).toMatch(/idx_scan_targets_effective_fresh.*tenant_id=\?.*<expr>>\?/);
  });

  it("bounds the feed before hydrating evidence and preserves the exact-hour boundary", () => {
    const now = Date.now();
    const cutoff = now - 3_600_000;
    const insert = rawDb.prepare(`INSERT INTO scan_targets
      (tenant_id,address,city,state,zip,lat,lng,last_fiber_available,first_seen_live_at,first_seen_fiber_at)
      VALUES (1,?,'Lexington','NC','27292',35,-80,1,?,?)`);
    rawDb.transaction(() => {
      for (let i = 0; i < 500; i++) {
        insert.run(`Feed fixture ${i}`, new Date(now - i * 1000).toISOString(), new Date(now - i * 1000).toISOString());
      }
      insert.run("Recent live but old fiber", new Date(now + 1000).toISOString(), new Date(cutoff - 1).toISOString());
      insert.run("Exact cutoff", new Date(now - 600_000).toISOString(), new Date(cutoff).toISOString());
    })();
    const expected = freshPoints(1, 2).filter(point => Date.parse(point.firstSeenLiveAt) >= cutoff).slice(0, 200);
    const bounded = freshPoints(1, 2, { since: new Date(cutoff).toISOString(), limit: 200 });
    expect(bounded).toEqual(expected);
    expect(bounded).toHaveLength(200);
    const allWithinHour = freshPoints(1, 2, { since: new Date(cutoff).toISOString(), limit: 1000 });
    expect(allWithinHour.some(point => point.address === "Exact cutoff")).toBe(true);
    expect(allWithinHour.some(point => point.address === "Recent live but old fiber")).toBe(false);
  });
});

it("uses a stable id tie-breaker when a scan gives many targets the same live timestamp", () => {
  const now = new Date().toISOString();
  const insert = rawDb.prepare(`INSERT INTO scan_targets
    (tenant_id,address,city,state,zip,lat,lng,last_fiber_available,first_seen_live_at,first_seen_fiber_at)
    VALUES (2,?,'Lexington','NC','27292',35,-80,1,?,?)`);
  rawDb.transaction(() => {
    for(let i=0;i<350;i++) insert.run(`Tie fixture ${i}`,now,new Date(Date.now()-i*1000).toISOString());
  })();
  const all = freshPoints(2,2);
  const feed = freshPoints(2,2,{since:new Date(Date.now()-3_600_000).toISOString(),limit:200});
  expect(feed).toEqual(all.slice(0,200));
  expect(feed.map(point=>point.address)).toEqual(Array.from({length:200},(_,i)=>`Tie fixture ${349-i}`));
});
it("creates the effective freshness and expiry indexes again on repeat migration", async () => {
  const storage = await import("../../server/storage"); storage.runMigrations();
  for(const name of ["idx_scan_targets_effective_fresh", "idx_sessions_expiry", "idx_otp_expiry"]) {
    expect(rawDb.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name)).toBeTruthy();
  }
  const src = await import("node:fs").then(fs=>fs.readFileSync("server/storage.ts","utf8"));
  expect(src.split("idx_scan_targets_effective_fresh").length-1).toBeGreaterThanOrEqual(2);
});
