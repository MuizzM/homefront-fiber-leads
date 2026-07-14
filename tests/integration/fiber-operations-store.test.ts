import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let rawDb: import("better-sqlite3").Database;
let ops: typeof import("../../server/fiberOperationsStore");

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-fiber-ops-"));
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  ops = await import("../../server/fiberOperationsStore");
  rawDb.prepare(`INSERT OR IGNORE INTO users (id,name,email,role,active,tenant_id) VALUES (1,'Owner','owner@example.com','admin',1,1)`).run();
  rawDb.prepare(`INSERT INTO tenants (id,slug,company_name,owner_name,owner_email,brand_name) VALUES (2,'other-org','Other','Owner','other@example.com','Other')`).run();
  rawDb.prepare(`INSERT INTO scan_runs (id,tenant_id,kind,label,budget,status) VALUES ('tenant-one',1,'market','One',1,'running'),('tenant-two',2,'market','Two',1,'running')`).run();
});

describe("fiber operations persistence", () => {
  it("replays events after a durable sequence cursor and isolates organizations", () => {
    const first = ops.appendFiberEvent({ tenantId: 1, runId: "tenant-one", eventType: "job.started" });
    const second = ops.appendFiberEvent({ tenantId: 1, runId: "tenant-one", eventType: "job.progress", payload: { completedTargets: 1 } });
    ops.appendFiberEvent({ tenantId: 2, runId: "tenant-two", eventType: "job.started" });

    expect(ops.listFiberEvents(1, "tenant-one", first)).toEqual([
      expect.objectContaining({ sequence: second, eventType: "job.progress", payload: { completedTargets: 1 } }),
    ]);
    expect(ops.listFiberEvents(1, "tenant-two", 0)).toEqual([]);
  });

  it("records a terminal failure as a dead letter and requeues it transactionally", () => {
    const targetId = Number(rawDb.prepare(`INSERT INTO scan_targets (address,city,state,zip,tenant_id) VALUES ('1 Retry Rd','Retryville','NC','28000',1)`).run().lastInsertRowid);
    rawDb.prepare(`INSERT INTO scan_run_targets (run_id,target_id,seq,state,attempt_count) VALUES ('tenant-one',?,0,'failed',3)`).run(targetId);
    ops.recordFiberFailure({ tenantId: 1, runId: "tenant-one", targetId, category: "timeout", message: "provider timeout", attempt: 3, retryable: true });
    const dead = ops.listDeadLetters(1, 10) as any[];
    expect(dead).toHaveLength(1);
    expect(ops.listDeadLetters(2, 10)).toEqual([]);

    expect(ops.retryDeadLetter(1, dead[0].id, 1)).toEqual({ runId: "tenant-one", targetId });
    const target: any = rawDb.prepare(`SELECT state,result FROM scan_run_targets WHERE run_id='tenant-one' AND target_id=?`).get(targetId);
    expect(target).toEqual({ state: "queued", result: null });
    expect((rawDb.prepare(`SELECT budget FROM scan_runs WHERE id='tenant-one'`).get() as any).budget).toBe(2);
    expect(ops.listDeadLetters(1, 10)).toEqual([]);
  });
});
