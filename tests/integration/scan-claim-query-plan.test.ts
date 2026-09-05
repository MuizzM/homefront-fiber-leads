import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let skipQueries: string[];
const fixture = new Database(":memory:");

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-claim-plan-"));
  const { runMigrations } = await import("../../server/storage");
  runMigrations();
  const { rawDb } = await import("../../server/db");
  const prepare = vi.spyOn(rawDb, "prepare");
  try {
    await import("../../server/scanIntelStore");
    // Exercise the actual prepared statements, including their shared policy
    // predicates; no duplicate query implementation in this regression.
    skipQueries = prepare.mock.calls.map(([sql]) => sql).filter(sql =>
      sql.includes("UPDATE scan_run_targets") && sql.includes("AND EXISTS (SELECT 1 FROM scan_targets"));
  } finally {
    prepare.mockRestore();
  }

  fixture.exec(`
    CREATE TABLE scan_targets (
      id INTEGER PRIMARY KEY, last_scanned_at TEXT,
      inconclusive_attempts INTEGER DEFAULT 0, last_inconclusive_at TEXT
    );
    CREATE TABLE scan_run_targets (
      run_id TEXT NOT NULL, target_id INTEGER NOT NULL, seq INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued', result TEXT, next_attempt_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(run_id, target_id)
    );
    CREATE INDEX idx_srt_run_state ON scan_run_targets(run_id, state, seq);
    CREATE INDEX idx_srt_target_state ON scan_run_targets(target_id, state);
    CREATE INDEX idx_srt_pending ON scan_run_targets(state) WHERE state IN ('queued','inflight');
  `);
  const target = fixture.prepare("INSERT INTO scan_targets(id) VALUES (?)");
  const queued = fixture.prepare("INSERT INTO scan_run_targets(run_id,target_id,seq,state) VALUES (?,?,?,?)");
  fixture.transaction(() => {
    for (let id = 1; id <= 50_000; id++) {
      target.run(id);
      const historical = id <= 20_000;
      queued.run(historical ? `history-${Math.floor((id - 1) / 100)}` : "large-run", id, id, historical ? "verified" : "queued");
    }
  })();
  // Natural stale statistics: a formerly huge queue drains, while its history
  // remains. The unpinned UPDATE chooses a full ledger scan on this fixture.
  fixture.exec("ANALYZE");
  fixture.prepare("UPDATE scan_run_targets SET state='verified' WHERE run_id='large-run' AND seq>20003").run();
});

afterAll(() => fixture.close());

describe("scan claim preparation with stale queue statistics", () => {
  it("seeks the requested run's queued rows for every skip policy", () => {
    expect(skipQueries).toHaveLength(3);
    for (const sql of skipQueries) {
      const parameters = sql.includes("datetime('now', ?)")
        ? ["skip", "large-run", "-3600 seconds"] : ["skip", "large-run"];
      const plan = fixture.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as Array<{ detail: string }>;
      expect(plan.map(row => row.detail).join("\n"))
        .toContain("SEARCH scan_run_targets USING INDEX idx_srt_run_state (run_id=? AND state=?)");
    }
  });
});
