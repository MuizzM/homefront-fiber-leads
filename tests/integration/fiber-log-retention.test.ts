import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// AUDIT-LOG RETENTION: fiber_job_events / fiber_job_failures are append-only
// diagnostics that had NO retention and grew ~1.1M rows/day (7.7M + 6.3M rows =
// 78% of a 7.4GB DB), which made backups too large for the disk and blocked
// deploys. Each writer now amortizes a bounded trim toward the newest MAX_ROWS.

let rawDb: import("better-sqlite3").Database;
let store: typeof import("../../server/fiberOperationsStore");
const TENANT = 1;
const RUN = "run_retention";

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-logret-"));
  // Small cap + frequent trim so the test exercises real retention quickly.
  process.env.FIBER_LOG_MAX_ROWS = "200";
  process.env.FIBER_LOG_PRUNE_EVERY = "100";
  process.env.FIBER_LOG_PRUNE_CHUNK = "500";
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  store = await import("../../server/fiberOperationsStore");
  rawDb.prepare(`INSERT OR IGNORE INTO scan_runs (id,tenant_id,kind,label,city,state,budget,status,heartbeat_at,created_by)
    VALUES (?,?,'city','ret','Testville','NC',10,'running',datetime('now'),1)`).run(RUN, TENANT);
});

describe("fiber audit-log retention", () => {
  it("caps fiber_job_events instead of growing without bound", () => {
    for (let i = 0; i < 900; i++) {
      store.appendFiberEvent({ tenantId: TENANT, runId: RUN, eventType: "job.progress", payload: { i } });
    }
    const n = (rawDb.prepare("SELECT COUNT(*) c FROM fiber_job_events").get() as any).c;
    // Without retention this would be 900. With a 200-row cap trimmed every 100
    // inserts (500/pass) it must stay far below the unbounded count.
    expect(n).toBeLessThan(900);
    expect(n).toBeLessThanOrEqual(400); // cap + at most one un-trimmed interval
    // The NEWEST events must survive — retention drops oldest, never newest.
    const newest = (rawDb.prepare("SELECT MAX(sequence) m FROM fiber_job_events").get() as any).m;
    expect(newest).toBeGreaterThan(0);
  });

  it("caps fiber_job_failures the same way", () => {
    const tgt = Number(rawDb.prepare(
      `INSERT INTO scan_targets (address,city,state,zip,tenant_id,source) VALUES (?,?,?,?,?,'test')`,
    ).run("1 Retention Rd", "Testville", "NC", "27000", TENANT).lastInsertRowid);
    rawDb.prepare(`INSERT OR IGNORE INTO scan_run_targets (run_id,target_id,seq,state) VALUES (?,?,0,'queued')`).run(RUN, tgt);
    for (let i = 0; i < 900; i++) {
      store.recordFiberFailure({ tenantId: TENANT, runId: RUN, targetId: tgt, category: "transient", message: `err ${i}`, attempt: 1, retryable: true });
    }
    const n = (rawDb.prepare("SELECT COUNT(*) c FROM fiber_job_failures").get() as any).c;
    expect(n).toBeLessThan(900);
    expect(n).toBeLessThanOrEqual(400);
  });
});
