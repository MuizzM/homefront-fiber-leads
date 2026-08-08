// ── State-monitor index + heartbeat identity ─────────────────────────────────
//
// Two measured defects, both of which cost the production box continuously:
//
//   1. `syncMarketState()` runs 9 correlated subqueries keyed on
//      `lower(s.city)=lower(m.city) AND s.state=m.state`, once per market row.
//      Measured on a 476k-row copy of live data: 170,829 ms with no matching
//      index, 153 ms with `(lower(city), state)`, 41 ms once the four read
//      columns make the plan COVERING. The monitor ticks every ~15 minutes and,
//      with SCAN_WORKERS unset, ticks INSIDE the HTTP process — so this is
//      minutes of synchronous better-sqlite3 work blocking request serving.
//
//      The index is declared in the migration array AND in the table-rebuild
//      path (which drops every index with the old table). Both are asserted
//      here, because the rebuild silently undoing it is the failure mode the
//      existing comment warns about.
//
//   2. `fiber_worker_heartbeats` is keyed `worker_id PRIMARY KEY` and written
//      with `ON CONFLICT(worker_id) DO UPDATE` — but the caller passed
//      `scan:${runId}`, a value that can never collide. Measured on the same
//      copy: 270,907 rows / 270,907 distinct worker_ids, exactly 1:1. Not one
//      row was ever reused.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let rawDb: import("better-sqlite3").Database;
let storageMod: typeof import("../../server/storage");
let ops: typeof import("../../server/fiberOperationsStore");

const MARKET_SYNC_INDEX = "idx_scan_targets_market_sync";
const CITY_STATE_INDEX = "idx_scan_targets_city_state";

const indexNames = (): string[] =>
  (rawDb.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='scan_targets'`).all() as any[])
    .map(r => r.name);

/** The predicate shape syncMarketState()'s subqueries use, verbatim. */
const REPRESENTATIVE = `
  SELECT (SELECT MAX(s.last_scanned_at) FROM scan_targets s
            WHERE lower(s.city)=lower(m.city) AND s.state=m.state) AS a,
         EXISTS (SELECT 1 FROM scan_targets s
                   WHERE lower(s.city)=lower(m.city) AND s.state=m.state AND s.last_is_new_fiber=1) AS b,
         EXISTS (SELECT 1 FROM scan_targets s
                   WHERE lower(s.city)=lower(m.city) AND s.state=m.state
                     AND COALESCE(s.first_seen_fiber_at,s.first_seen_live_at) >= datetime('now','-30 days')) AS c
    FROM state_fiber_markets m`;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-state-monitor-idx-"));
  process.env.NODE_ENV = "test";
  storageMod = await import("../../server/storage");
  storageMod.runMigrations();
  ({ rawDb } = await import("../../server/db"));
  ops = await import("../../server/fiberOperationsStore");
  // heartbeat rows carry `run_id REFERENCES scan_runs(id)`, so the runs the
  // fixtures name must actually exist.
  const mkRun = rawDb.prepare(
    `INSERT OR IGNORE INTO scan_runs (id, tenant_id, kind, label, budget) VALUES (?,1,'market',?,0)`,
  );
  for (let i = 0; i < 10; i++) mkRun.run(`run-${i}`, `fixture run ${i}`);
  mkRun.run("r", "fixture run r");
});

describe("the state-monitor index exists and is actually used", () => {
  it("a fresh install creates both the narrow and the covering index", () => {
    const names = indexNames();
    expect(names).toContain(CITY_STATE_INDEX);
    expect(names).toContain(MARKET_SYNC_INDEX);
  });

  it("the covering index matches syncMarketState's predicates EXACTLY", () => {
    const sql = (rawDb.prepare(
      `SELECT sql FROM sqlite_master WHERE type='index' AND name = ?`,
    ).get(MARKET_SYNC_INDEX) as any).sql as string;
    // Leading columns must be the join predicate, in that order…
    expect(sql).toMatch(/lower\(city\)\s*,\s*state/i);
    // …followed by every column the subqueries READ, or the plan is not covering.
    for (const col of ["last_scanned_at", "last_is_new_fiber", "first_seen_fiber_at", "first_seen_live_at"]) {
      expect(sql).toContain(col);
    }
  });

  it("QUERY-PLAN REGRESSION: every correlated subquery uses a COVERING index seek", () => {
    const plan = (rawDb.prepare(`EXPLAIN QUERY PLAN ${REPRESENTATIVE}`).all() as any[]).map(r => r.detail);
    const subqueryPlans = plan.filter(d => /scan_targets|\bs\b/.test(d) && /SEARCH|SCAN/.test(d));
    expect(subqueryPlans.length).toBeGreaterThan(0);
    for (const step of subqueryPlans) {
      // The regression this guards: a full SCAN here is the 170-second plan.
      expect(step).not.toMatch(/^SCAN s\b/);
      expect(step).toContain("USING COVERING INDEX");
      expect(step).toContain(MARKET_SYNC_INDEX);
    }
  });

  it("re-running migrations is idempotent and keeps both indexes", () => {
    storageMod.runMigrations();
    storageMod.runMigrations();
    const names = indexNames();
    expect(names.filter(n => n === MARKET_SYNC_INDEX)).toHaveLength(1);
    expect(names).toContain(CITY_STATE_INDEX);
  });

  it("SURVIVES A TABLE REBUILD — the failure mode the rebuild path warns about", () => {
    // Reproduce what the rebuild does: every index goes with the old table.
    rawDb.exec(`DROP INDEX IF EXISTS ${MARKET_SYNC_INDEX}`);
    rawDb.exec(`DROP INDEX IF EXISTS ${CITY_STATE_INDEX}`);
    expect(indexNames()).not.toContain(MARKET_SYNC_INDEX);

    storageMod.runMigrations();

    const names = indexNames();
    expect(names).toContain(MARKET_SYNC_INDEX);
    expect(names).toContain(CITY_STATE_INDEX);
    // …and the plan is restored, not merely the index row.
    const plan = (rawDb.prepare(`EXPLAIN QUERY PLAN ${REPRESENTATIVE}`).all() as any[]).map(r => r.detail).join(" | ");
    expect(plan).toContain("USING COVERING INDEX");
  });
});

describe("heartbeat identity is stable across runs", () => {
  it("THE DEFECT: repeated runs UPDATE one row instead of inserting a new one each time", () => {
    const before = (rawDb.prepare(`SELECT COUNT(*) c FROM fiber_worker_heartbeats`).get() as any).c;

    // Ten "runs" from one worker. Under the old `scan:${runId}` identity this
    // produced ten permanent rows; the table grew forever, one row per run.
    const workerId = "scan:test-host:4242";
    for (let i = 0; i < 10; i++) {
      ops.heartbeatWorker({
        workerId, tenantId: 1, runId: `run-${i}`, status: "running", concurrency: 1,
      });
    }

    const after = (rawDb.prepare(`SELECT COUNT(*) c FROM fiber_worker_heartbeats`).get() as any).c;
    expect(after - before).toBe(1);
  });

  it("the row still reports the CURRENT run — identity is stable, state is not", () => {
    const row = rawDb.prepare(
      `SELECT run_id, status, concurrency FROM fiber_worker_heartbeats WHERE worker_id = ?`,
    ).get("scan:test-host:4242") as any;
    expect(row.run_id).toBe("run-9");     // the latest run, not the first
    expect(row.status).toBe("running");
  });

  it("distinct workers still get distinct rows — the fix does not collapse real workers", () => {
    const before = (rawDb.prepare(`SELECT COUNT(*) c FROM fiber_worker_heartbeats`).get() as any).c;
    ops.heartbeatWorker({ workerId: "scan:host-a:1", tenantId: 1, runId: "r", status: "running", concurrency: 1 });
    ops.heartbeatWorker({ workerId: "scan:host-b:1", tenantId: 1, runId: "r", status: "running", concurrency: 1 });
    ops.heartbeatWorker({ workerId: "scan:host-a:2", tenantId: 1, runId: "r", status: "running", concurrency: 1 });
    const after = (rawDb.prepare(`SELECT COUNT(*) c FROM fiber_worker_heartbeats`).get() as any).c;
    expect(after - before).toBe(3);
  });

  it("the engine's worker id is process-scoped, not run-scoped", async () => {
    // Read the source rather than invoking the engine: the identity is the
    // contract under test, and running a real scan would spend proxy budget.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("server/scanEngine.ts", "utf8");
    expect(src).not.toMatch(/const workerId = `scan:\$\{runId\}`/);
    expect(src).toMatch(/stableWorkerId\(\)/);
    // The stable id must not embed the run.
    const fn = src.slice(src.indexOf("function stableWorkerId"), src.indexOf("function stableWorkerId") + 400);
    expect(fn).not.toContain("runId");
  });
});
