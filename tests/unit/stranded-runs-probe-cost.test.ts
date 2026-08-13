// The 60-second reaper probe must not scale with the terminal-run table.
//
// getStrandedDoneRuns runs from startScanReaper() every 60s, on every worker
// that also serves HTTP, through synchronous better-sqlite3 - so its cost lands
// straight on the event loop. scan_runs holds ~555k terminal rows in production
// and nothing prunes them (pruneTerminalScanRuns exists and is deliberately
// unwired), so this one query's shape decides whether the loop stalls.
//
// It used to be a CORRELATED EXISTS, which made the cost O(terminal runs):
// SQLite walked the status index and ran the subquery once per run before LIMIT
// could apply. It is now `id IN (...)`, which makes the cost O(claimable queued
// targets) - the driving set is the handful of genuinely queued rows.
//
// This test builds the production distribution and asserts the PLAN, not a
// wall-clock number: timings are machine-dependent and would make this flaky,
// but "does the queued set drive the query" is a stable, meaningful invariant.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

// The exact production index set for these two tables, copied from
// server/storage.ts. Nothing added - the point is that the fix needs no new index.
const SCHEMA = `
CREATE TABLE scan_runs (id INTEGER PRIMARY KEY, tenant_id INT, status TEXT, completed_at TEXT, started_at TEXT);
CREATE TABLE scan_run_targets (id INTEGER PRIMARY KEY, run_id INT, target_id INT, seq INT, state TEXT, next_attempt_at TEXT);
CREATE INDEX idx_scan_runs_tenant ON scan_runs(tenant_id, started_at DESC);
CREATE INDEX idx_scan_runs_status ON scan_runs(status);
CREATE INDEX idx_srt_run_state ON scan_run_targets(run_id, state, seq);
CREATE INDEX idx_srt_target_state ON scan_run_targets(target_id, state);
CREATE INDEX idx_srt_pending ON scan_run_targets(state) WHERE state IN ('queued','inflight');
`;

const QUEUED_PREDICATE =
  "t.state='queued' AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= datetime('now'))";

const CURRENT = `SELECT r.id FROM scan_runs r
  WHERE r.status IN ('done','error') AND r.id IN (
    SELECT t.run_id FROM scan_run_targets t WHERE ${QUEUED_PREDICATE})
  ORDER BY r.completed_at ASC LIMIT 10`;

const OLD_CORRELATED = `SELECT r.id FROM scan_runs r
  WHERE r.status IN ('done','error') AND EXISTS (
    SELECT 1 FROM scan_run_targets t WHERE t.run_id=r.id AND ${QUEUED_PREDICATE})
  ORDER BY r.completed_at ASC LIMIT 10`;

// Smaller than production (which is ~555k) so the suite stays fast; the plan
// shape this asserts does not depend on the row count.
const RUNS = 40_000;
const STRANDED_FROM = RUNS - 46; // 47 stranded, at the far end of completed_at

let db: InstanceType<typeof Database>;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
  const run = db.prepare("INSERT INTO scan_runs(id,tenant_id,status,completed_at,started_at) VALUES (?,1,?,?,?)");
  const tgt = db.prepare("INSERT INTO scan_run_targets(run_id,target_id,seq,state,next_attempt_at) VALUES (?,?,?,?,NULL)");
  db.transaction(() => {
    for (let i = 1; i <= RUNS; i++) {
      const ts = `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(6, "0")}Z`;
      run.run(i, i <= 2 ? "error" : "done", ts, ts);
      tgt.run(i, i, 1, "done");
      if (i >= STRANDED_FROM) tgt.run(i, i, 2, "queued");
    }
  })();
  db.exec("ANALYZE");
});

afterAll(() => db?.close());

const plan = (sql: string) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map(r => r.detail).join("\n");

describe("the stranded-run probe is driven by the queued set", () => {
  it("returns the same rows the correlated form returned", () => {
    // The whole change is a rewrite, so equivalence is the first thing to pin.
    const now = db.prepare(CURRENT).all();
    const before = db.prepare(OLD_CORRELATED).all();
    expect(now).toEqual(before);
    expect(now.length).toBe(10);
  });

  it("does not run a correlated subquery once per terminal run", () => {
    // This is the defect: CORRELATED SCALAR SUBQUERY means one probe per row of
    // the outer scan, and the outer scan is every terminal run in the table.
    expect(plan(CURRENT)).not.toContain("CORRELATED SCALAR SUBQUERY");
    // Proof the old spelling really did, so this test cannot silently pass on a
    // planner that stopped caring.
    expect(plan(OLD_CORRELATED)).toContain("CORRELATED SCALAR SUBQUERY");
  });

  it("drives from scan_run_targets and looks runs up by rowid", () => {
    const p = plan(CURRENT);
    expect(p).toContain("LIST SUBQUERY");
    // The run lookup must be a rowid seek driven BY that list. Which access
    // path SQLite picks for it varies with table size - at this fixture's scale
    // it takes the integer primary key directly, at production scale it seeks
    // idx_scan_runs_status with a rowid constraint. Both are the same win:
    // runs are fetched for the queued ids, not probed one-by-one for every run.
    expect(p).toMatch(/SEARCH r USING (INTEGER PRIMARY KEY \(rowid=\?\)|INDEX idx_scan_runs_status .*rowid)/);
  });

  it("needs no index that does not already exist in production", () => {
    // If someone adds an index to make this faster, that is a schema change on
    // scan_run_targets - the largest table in the database, on a host with
    // ~7.6 GB free. This test exists to make that a deliberate decision.
    const idx = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('scan_runs','scan_run_targets') AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>).map(r => r.name).sort();
    expect(idx).toEqual([
      "idx_scan_runs_status",
      "idx_scan_runs_tenant",
      "idx_srt_pending",
      "idx_srt_run_state",
      "idx_srt_target_state",
    ]);
  });
});

describe("the shipped query keeps that shape", () => {
  it("server/scanIntelStore.ts uses the id IN form, not EXISTS", () => {
    const src = readFileSync(join(ROOT, "server/scanIntelStore.ts"), "utf8");
    const fn = src.slice(src.indexOf("export function getStrandedDoneRuns"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("r.id IN (");
    expect(body).not.toMatch(/AND EXISTS \(/);
  });
});
