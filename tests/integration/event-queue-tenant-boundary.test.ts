// @vitest-environment node
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, type Capability } from "../../shared/capabilities";

let db: import("better-sqlite3").Database;
let Q: typeof import("../../server/eventQueueOps");
let E: typeof import("../../server/domainEventStore");
let server: Server;
let origin: string;
let sequence = 1;
const subscriber = "incentives";
const at = "2026-09-08T12:00:00.000Z";

function event(tenantId: number, cachedTenantId: number | null = tenantId) {
  const row = E.emit({ tenantId, type: "SALE_APPROVED", subjectType: "sale", subjectId: sequence++, occurredAt: at }, at);
  db.prepare(`INSERT INTO event_processing_state
    (subscriber,event_id,tenant_id,event_type,status,attempts,last_error,created_at,updated_at)
    VALUES (?, ?, ?, 'SALE_APPROVED', 'blocked', 5, ?, ?, ?)`)
    .run(subscriber, row.id, cachedTenantId, `private-tenant-${tenantId}`, at, at);
  return row.id;
}

async function request(path: string, tenant: string, body?: object, role = "admin") {
  return fetch(`${origin}/api/commission/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-fixture-tenant": tenant, "x-fixture-role": role },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-event-tenant-"));
  const { runMigrations } = await import("../../server/storage");
  runMigrations();
  ({ rawDb: db } = await import("../../server/db"));
  E = await import("../../server/domainEventStore");
  Q = await import("../../server/eventQueueOps");
  const { registerCommissionRoutes } = await import("../../server/commissionRoutes");
  const app = express();
  app.use(express.json());
  // Auth is a fixture boundary; the real route capability and storage checks run.
  app.use((req, _res, next) => {
    (req as any).user = { id: null, tenantId: req.header("x-fixture-tenant") === "none" ? null : Number(req.header("x-fixture-tenant")), role: req.header("x-fixture-role") };
    next();
  });
  registerCommissionRoutes(app, {
    requireAuth: (_req, _res, next) => next(),
    requireCapability: (cap: Capability) => (req, res, next) => {
      if (!can((req as any).user.role, cap)) { res.status(403).json({ error: "forbidden" }); return; }
      next();
    },
  });
  server = createServer(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => { if (server) await new Promise<void>((r, j) => server.close(e => e ? j(e) : r())); });

describe("event ownership is enforced below HTTP", () => {
  it("does not infer ownership from an orphaned queue record", async () => {
    const id = 999999999;
    db.prepare(`INSERT INTO event_processing_state(subscriber,event_id,tenant_id,status,created_at,updated_at)
      VALUES (?,?,1,'blocked',?,?)`).run(subscriber, id, at, at);
    await expect(Q.operatorAction({ subscriber, eventId: id, tenantId: 1, action: "RETRY", actorUserId: null, reason: "reviewed issue" })).rejects.toThrow(/queue state/i);
    expect(Q.queueHealth(subscriber, 1).halted.some(row => row.eventId === id)).toBe(false);
    expect(Q.recoveryReport(subscriber, 1).stillHolding).not.toContain(id);
    expect(Q.getState(subscriber, id).status).toBe("blocked");
  });

  it.each(["RETRY", "DEAD_LETTER", "RESOLVE"] as const)("denies foreign %s even when cached state claims the acting tenant", async action => {
    const id = event(2, 1);
    const before = Q.getState(subscriber, id);
    const audit = db.prepare("SELECT COUNT(*) n FROM activity_log").get();
    const cursor = E.cursorFor(subscriber);
    await expect(Q.operatorAction({ subscriber, eventId: id, action, tenantId: 1, actorUserId: null, reason: "reviewed issue" })).rejects.toThrow(/queue state/i);
    expect(Q.getState(subscriber, id)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) n FROM activity_log").get()).toEqual(audit);
    expect(E.cursorFor(subscriber)).toBe(cursor);
  });

  it.each([undefined, null, 0, -1, NaN, Infinity, 1.5])("rejects invalid tenant context %s", async tenantId => {
    const id = event(1);
    await expect(Q.operatorAction({ subscriber, eventId: id, action: "RETRY", tenantId: tenantId as number, actorUserId: null, reason: "reviewed issue" })).rejects.toThrow(/organization/i);
    expect(Q.getState(subscriber, id).status).toBe("blocked");
  });

  it.each(["RETRY", "DEAD_LETTER", "RESOLVE"] as const)("allows own %s with a tenant-stamped audit", async action => {
    const id = event(1, null);
    await Q.operatorAction({ subscriber, eventId: id, action, tenantId: 1, actorUserId: null, reason: "reviewed issue" });
    expect(Q.getState(subscriber, id).status).toBe({ RETRY: "pending", DEAD_LETTER: "dead_lettered", RESOLVE: "resolved" }[action]);
    expect(db.prepare("SELECT tenant_id FROM activity_log WHERE entity_type='domain_event' AND entity_id=?").get(id)).toEqual({ tenant_id: 1 });
  });

  it("rolls back the action if its audit cannot commit", async () => {
    const id = event(1);
    const before = Q.getState(subscriber, id);
    db.exec("CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON activity_log BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END");
    try {
      await expect(Q.operatorAction({ subscriber, eventId: id, action: "RESOLVE", tenantId: 1, actorUserId: null, reason: "reviewed issue" })).rejects.toThrow(/fixture audit failure/);
      expect(Q.getState(subscriber, id)).toEqual(before);
    } finally { db.exec("DROP TRIGGER fixture_audit_failure"); }
  });
});

describe("organization queue routes", () => {
  it("returns the same 404 for a missing or foreign event", async () => {
    const id = event(2);
    const body = { action: "RETRY", reason: "reviewed issue", tenantId: 2 };
    const foreign = await request(`queue/events/${id}/action?tenantId=2`, "1", body);
    const missing = await request("queue/events/900000000/action", "1", body);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(Q.getState(subscriber, id).status).toBe("blocked");
  });

  it("scopes health, recovery and reconciliation to immutable event ownership", async () => {
    const mine = event(1, null);
    const foreign = event(2, 1);
    const health = await (await request("queue/health", "1")).json();
    expect(health.halted.some((row: any) => row.eventId === mine)).toBe(true);
    expect(health.halted.every((row: any) => row.tenantId === 1)).toBe(true);
    expect(JSON.stringify(health)).not.toContain("private-tenant-2");
    const recovery = await (await request("queue/recovery", "1")).json();
    expect(recovery.stillHolding).toContain(mine);
    expect(recovery.stillHolding).not.toContain(foreign);
    const { reconcile } = await import("../../server/commissionReconciliation");
    const findings = reconcile({ tenantId: 1, nowIso: at, runId: "tenant-fixture" }).findings.filter(f => f.kind === "BLOCKED_QUEUE_EVENT");
    expect(findings.some(f => f.observed.eventId === mine)).toBe(true);
    expect(findings.every(f => f.tenantId === 1)).toBe(true);
  });

  it("returns an empty tenant view without disclosing the global cursor/backlog", async () => {
    const foreign = event(2);
    E.advanceCursor(subscriber, foreign, at);
    const health = await (await request("queue/health", "3")).json();
    expect(health).toMatchObject({ cursor: 0, backlog: 0, halted: [], alerts: [] });
    const recovery = await (await request("queue/recovery", "3")).json();
    expect(recovery).toMatchObject({ cursor: 0, highestCompleted: 0, stillHolding: [], operatorCleared: [], duplicateAwards: [] });
    expect(E.cursorFor(subscriber)).toBe(foreign);
  });

  it.each(["queue/health", "queue/recovery", "reconciliation", "reconciliation.csv"])("requires organization context for %s, including a role-only super admin", async path => {
    const result = await request(path, "none", undefined, "super_admin");
    expect(result.status).toBe(400);
  });

  it("preserves capability denials", async () => {
    expect((await request("queue/health", "1", undefined, "rep")).status).toBe(403);
    expect((await request("queue/events/1/action", "1", { action: "RETRY", reason: "reviewed" }, "rep")).status).toBe(403);
  });

  it("bounds large tenant reports and discloses truncation without changing worker progress", async () => {
    const ids: number[] = [];
    db.transaction(() => { for (let i = 0; i < 205; i++) ids.push(event(4)); })();
    const foreign = event(5);
    db.prepare("UPDATE event_processing_state SET first_failed_at=? WHERE event_id=?").run("2000-01-01T00:00:00.000Z", foreign);
    db.prepare("UPDATE event_processing_state SET first_failed_at=? WHERE event_id=?").run(at, ids[204]);
    const cursor = E.cursorFor(subscriber);
    const health = Q.queueHealth(subscriber, 4, Date.parse(at) + 1000);
    expect(health.halted.map(row => row.eventId)).toEqual(ids.slice(0, 200));
    expect(health).toMatchObject({ truncated: true, backlog: 205, oldestFailureAgeMs: 1000 });
    const recovery = Q.recoveryReport(subscriber, 4);
    expect(recovery.stillHolding).toEqual(ids.slice(0, 200));
    expect(recovery.truncated).toBe(true);
    db.prepare("UPDATE event_processing_state SET status='resolved' WHERE event_id IN (SELECT id FROM domain_events WHERE tenant_id=4)").run();
    expect(Q.recoveryReport(subscriber, 4).operatorCleared).toEqual(ids.slice(0, 200));
    expect(E.cursorFor(subscriber)).toBe(cursor);
  });

  it("only reports duplicate awards owned by both the tenant and the source event", async () => {
    await import("../../server/incentiveSubscriber");
    const own = event(6);
    const foreign = event(7);
    const insert = db.prepare("INSERT INTO spiffs(tenant_id,rep_id,source_event_id,amount_cents,reason) VALUES (?,77,?,100,'synthetic duplicate')");
    for (let i = 0; i < 2; i++) { insert.run(6, own); insert.run(7, foreign); insert.run(6, foreign); }
    expect(Q.recoveryReport(subscriber, 6).duplicateAwards).toEqual([{ sourceEventId: own, repId: 77, n: 2 }]);
  });

  it("waits asynchronously for a temporary writer and commits the action/audit once", async () => {
    const id = event(1);
    const peer = new Database(db.name);
    const previous = db.pragma("busy_timeout", { simple: true });
    db.pragma("busy_timeout = 2500");
    peer.exec("BEGIN IMMEDIATE");
    const release = setTimeout(() => peer.exec("ROLLBACK"), 50);
    try {
      const result = await request(`queue/events/${id}/action`, "1", { action: "RETRY", reason: "writer released" });
      expect(result.status).toBe(200);
      expect(Q.getState(subscriber, id).status).toBe("pending");
      expect(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE entity_type='domain_event' AND entity_id=?").get(id)).toEqual({ n: 1 });
      expect(db.pragma("busy_timeout", { simple: true })).toBe(2500);
    } finally {
      clearTimeout(release);
      if (peer.inTransaction) peer.exec("ROLLBACK");
      peer.close(); db.pragma(`busy_timeout = ${previous}`);
    }
  });

  it("returns retryable 503 when the write budget expires, without changing state or audit", async () => {
    const id = event(1);
    const before = Q.getState(subscriber, id);
    const peer = new Database(db.name);
    peer.exec("BEGIN IMMEDIATE");
    try {
      const result = await request(`queue/events/${id}/action`, "1", { action: "RESOLVE", reason: "reviewed issue" });
      expect(result.status).toBe(503);
      expect(result.headers.get("retry-after")).toBe("1");
      expect(await result.json()).toMatchObject({ code: "QUEUE_BUSY" });
      expect(Q.getState(subscriber, id)).toEqual(before);
      expect(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE entity_type='domain_event' AND entity_id=?").get(id)).toEqual({ n: 0 });
    } finally { peer.exec("ROLLBACK"); peer.close(); }
  });

  it("upgrades and repeats the tenant-cursor index without modifying immutable events", () => {
    const before = db.prepare("SELECT * FROM domain_events ORDER BY id").all();
    db.exec("DROP INDEX IF EXISTS idx_domain_events_tenant_cursor");
    E.ensureDomainEventSchema(); E.ensureDomainEventSchema();
    expect(db.prepare("SELECT * FROM domain_events ORDER BY id").all()).toEqual(before);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) n FROM domain_events WHERE tenant_id=? AND id>?").all(1, 0) as any[];
    expect(plan.map(r => r.detail).join(" ")).toContain("idx_domain_events_tenant_cursor");
  });
});
