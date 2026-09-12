// @vitest-environment node
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as store from "../../server/assignmentOperationStore";

let db: Database.Database, dir: string, file: string;
const owner = { tenantId: 1, userId: 1 };
const authorize = () => ({ actorName: "Fixture manager", repName: "Fixture rep" });
const ids = Array.from({ length: 1201 }, (_, i) => i + 1);
async function admit(clientId = "fixture", selection = ids, tenantId = 1) {
  return store.admitAssignmentOperation(db, { ...owner, tenantId }, { kind: "selection", clientId, requestHash: `hash-${clientId}`, repId: 2, ids: selection, metadata: {} });
}
function child(mode: string, id: string) {
  return new Promise<{ code: number | null; signal: string | null; error: string }>((resolveChild, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", resolve("tests/fixtures/reliability-worker.ts"), file, mode, id], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; proc.stderr.on("data", chunk => { error += chunk; }); proc.on("error", reject);
    proc.on("exit", (code, signal) => resolveChild({ code, signal, error }));
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hf-reliability-test-")); file = join(dir, "fixture.sqlite");
  db = new Database(file); db.pragma("journal_mode=WAL");
  db.exec(`CREATE TABLE leads(id INTEGER PRIMARY KEY,tenant_id INTEGER,assigned_rep_id INTEGER,assigned_by TEXT,assigned_at TEXT,unassigned_at TEXT,updated_at TEXT);
    CREATE TABLE team_members(id INTEGER PRIMARY KEY,tenant_id INTEGER,name TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,tenant_id INTEGER,active INTEGER,role TEXT);
    INSERT INTO users VALUES (1,1,1,'admin');
    CREATE TABLE lead_events(id INTEGER PRIMARY KEY,lead_id INTEGER,type TEXT,actor TEXT,detail TEXT,at TEXT);
    CREATE TABLE activity_log(id INTEGER PRIMARY KEY,tenant_id INTEGER,user_id INTEGER,action TEXT,entity_type TEXT,details TEXT,at TEXT);
    INSERT INTO team_members VALUES (2,1,'Fixture rep'),(3,1,'Original rep');`);
  const insert = db.prepare("INSERT INTO leads(id,tenant_id,assigned_rep_id,assigned_at) VALUES (?,1,3,'2026-01-01T00:00:00Z')");
  db.transaction(() => ids.forEach(id => insert.run(id)))();
  store.ensureAssignmentOperationSchema(db);
});
afterEach(() => { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("durable assignment recovery", () => {
  it("never lets an older undo overwrite a same-millisecond assignment or legacy ownership write", async () => {
    const now = Date.now();
    const input = { kind: "bulk" as const, requestHash: "same-body", repId: 2, ids: [1], metadata: {} };
    const first = await store.admitAssignmentOperation(db, owner, { ...input, clientId: "first" }, now);
    const second = await store.admitAssignmentOperation(db, owner, { ...input, clientId: "second" }, now);
    const a = await store.continueAssignmentOperation(db, owner, first.id, authorize);
    const b = await store.continueAssignmentOperation(db, owner, second.id, authorize);
    expect(a.applied_at).toBe(b.applied_at);
    expect(await store.undoAssignmentOperation(db, owner, a.undo_token!, authorize)).toEqual({ restored: 0, skipped: 1 });
    expect(db.prepare("SELECT assigned_rep_id FROM leads WHERE id=1").get()).toEqual({ assigned_rep_id: 2 });
    // Even a writer unaware of durable operations replaces ownership.
    db.prepare("UPDATE leads SET assigned_rep_id=assigned_rep_id,assigned_at=assigned_at WHERE id=1").run();
    expect(await store.undoAssignmentOperation(db, owner, b.undo_token!, authorize)).toEqual({ restored: 0, skipped: 1 });
  });
  it("projects current undo eligibility without mutating the original replay receipt", async () => {
    let first!: store.AssignmentOperation;
    for (let i = 0; i < 9; i++) {
      const op = await admit(`eviction-${i}`, [i + 1]);
      const completed = await store.continueAssignmentOperation(db, owner, op.id, authorize);
      if (!i) first = completed;
    }
    const latest = store.getAssignmentOperation(db, owner, first.id)!;
    expect(latest.result).toBe(first.result);
    expect(store.assignmentOperationSummary(latest).canUndo).toBe(false);
  });
  it("survives SIGKILL after a committed batch and resumes the original selection and inverse", async () => {
    const op = await admit();
    const killed = await child("crash-assignment", op.id); expect(killed, killed.error).toMatchObject({ signal: "SIGKILL" });
    expect(store.getAssignmentOperation(db, owner, op.id)).toMatchObject({ next_chunk: 1, updated: 500, state: "running" });
    // A new matching door never joins the frozen operation.
    db.prepare("INSERT INTO leads(id,tenant_id,assigned_rep_id) VALUES (9999,1,3)").run();
    const resumed = await child("assignment", op.id); expect(resumed, resumed.error).toMatchObject({ code: 0 });
    const done = store.getAssignmentOperation(db, owner, op.id)!;
    expect(done).toMatchObject({ state: "completed", total: 1201, updated: 1201 });
    expect(db.prepare("SELECT COUNT(*) n FROM lead_events").get()).toEqual({ n: 1201 });
    expect(db.prepare("SELECT assigned_rep_id r FROM leads WHERE id=9999").get()).toEqual({ r: 3 });
    const undone = await store.undoAssignmentOperation(db, owner, done.undo_token!, authorize);
    expect(undone).toEqual({ restored: 1201, skipped: 0 });
    expect(JSON.parse((db.prepare("SELECT detail FROM lead_events ORDER BY id DESC LIMIT 1").get() as any).detail).assignedTo).toBe("Original rep");
  });
  it("two independent processes commit one set of effects and one final audit", async () => {
    const op = await admit();
    const results = await Promise.all([child("assignment", op.id), child("assignment", op.id)]);
    for (const result of results) expect(result, result.error).toMatchObject({ code: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM lead_events").get()).toEqual({ n: 1201 });
    expect(db.prepare("SELECT COUNT(*) n FROM activity_log").get()).toEqual({ n: 1 });
    expect(store.getAssignmentOperation(db, owner, op.id)).toMatchObject({ updated: 1201, next_chunk: 3 });
  });
  it("rolls back effects and inverse together when the progress receipt fails", async () => {
    const op = await admit();
    db.exec(`CREATE TRIGGER fail_receipt BEFORE UPDATE OF next_chunk ON assignment_operations BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;`);
    await expect(store.continueAssignmentOperation(db, owner, op.id, authorize)).rejects.toThrow("injected receipt failure");
    expect(db.prepare("SELECT COUNT(*) n FROM lead_events").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM assignment_operation_chunks WHERE prior_json IS NOT NULL").get()).toEqual({ n: 0 });
    expect(store.getAssignmentOperation(db, owner, op.id)).toMatchObject({ updated: 0, next_chunk: 0 });
    db.exec("DROP TRIGGER fail_receipt"); await store.continueAssignmentOperation(db, owner, op.id, authorize);
    expect(store.getAssignmentOperation(db, owner, op.id)?.updated).toBe(1201);
  });
  it("replays the final receipt after a lost response without rechecking target eligibility", async () => {
    const op = await admit(); const first = await store.continueAssignmentOperation(db, owner, op.id, authorize);
    const replay = await store.continueAssignmentOperation(db, owner, op.id, (target, onlyActor) => {
      expect(target).toBeNull(); expect(onlyActor).toBe(true); return authorize();
    });
    expect(replay.result).toBe(first.result); expect(db.prepare("SELECT COUNT(*) n FROM activity_log").get()).toEqual({ n: 1 });
  });
  it("resumes an interrupted undo without restoring a chunk twice and skips changed ownership", async () => {
    const op = await admit(); const done = await store.continueAssignmentOperation(db, owner, op.id, authorize);
    let chunks = 0;
    await expect(store.undoAssignmentOperation(db, owner, done.undo_token!, authorize, () => { if (++chunks === 1) throw new Error("crash"); })).rejects.toThrow("crash");
    db.prepare("UPDATE leads SET assigned_rep_id=3,assigned_at='later' WHERE id=1201").run();
    db.close(); db = new Database(file); store.ensureAssignmentOperationSchema(db);
    const result = await store.undoAssignmentOperation(db, owner, done.undo_token!, authorize);
    expect(result).toEqual({ restored: 1200, skipped: 1 });
    expect(await store.undoAssignmentOperation(db, owner, done.undo_token!, authorize)).toEqual(result);
    expect(db.prepare("SELECT COUNT(*) n FROM lead_events").get()).toEqual({ n: 2401 });
  });
  it("does not let redeemed receipts exhaust the eight-live-token quota", async () => {
    for (let i = 0; i < 9; i++) {
      const op = await admit(`cycle-${i}`, [1]); const done = await store.continueAssignmentOperation(db, owner, op.id, authorize);
      expect(done.undo_token).toBeTruthy(); await store.undoAssignmentOperation(db, owner, done.undo_token!, authorize);
    }
  });
  it("refuses recycled identity, foreign tenant/actor and missing organization", async () => {
    const op = await admit();
    expect(store.getAssignmentOperation(db, { tenantId: 2, userId: 1 }, op.id)).toBeUndefined();
    expect(store.getAssignmentOperation(db, { tenantId: 1, userId: 2 }, op.id)).toBeUndefined();
    expect(() => store.listAssignmentOperations(db, { tenantId: 0, userId: 1 })).toThrow("organization");
    await expect(store.admitAssignmentOperation(db, owner, { kind: "selection", clientId: "fixture", requestHash: "different", repId: 2, ids, metadata: {} })).rejects.toMatchObject({ code: "OP_REUSED" });
  });
  it("keeps older pending work discoverable and terminal stop releases its quota without losing committed counts", async () => {
    const first = await admit("pending", [1]);
    for (let i = 0; i < 22; i++) { const op = await admit(`newer-${i}`, []); await store.continueAssignmentOperation(db, owner, op.id, authorize); }
    expect(store.listAssignmentOperations(db, owner)[0].id).toBe(first.id);
    await store.stopAssignmentOperation(db, owner, first.id, "Operator stopped remaining work");
    const stopped = await store.continueAssignmentOperation(db, owner, first.id, authorize);
    expect(stopped.state).toBe("cancelled"); expect(stopped.updated).toBe(0);
  });
  it("shortens expired inverse retention while keeping original replay receipts for thirty days", async () => {
    const op = await admit("retention", [1]); const done = await store.continueAssignmentOperation(db, owner, op.id, authorize);
    store.purgeAssignmentReceipts(db, (done.undo_expires_at ?? 0) + 1);
    expect(db.prepare("SELECT COUNT(*) n FROM assignment_operation_chunks").get()).toEqual({ n: 0 });
    expect(store.getAssignmentOperation(db, owner, op.id)?.result).toBe(done.result);
  });
});
