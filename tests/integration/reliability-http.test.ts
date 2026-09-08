// @vitest-environment node
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../server/resendMail", async importOriginal => ({
  ...await importOriginal<typeof import("../../server/resendMail")>(), sendResendEmail: vi.fn(() => { throw new Error("No external mail in fixture"); }),
}));
vi.mock("../../server/mail", async importOriginal => ({
  ...await importOriginal<typeof import("../../server/mail")>(), sendMailResilient: vi.fn(() => { throw new Error("No external mail in fixture"); }),
}));
let db: Database.Database, server: Server, origin: string, file: string;
let storage: typeof import("../../server/storage")["storage"];
let sequence = 0;
const secret = "private-fixture-payload-never-project";
const request = (path: string, token?: string, body?: object) => fetch(`${origin}${path}`, {
  method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { "x-session-id": token, "x-csrf-token": token } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
function actor(role = "admin", tenantId: number | null = 1, marker = false) {
  const user = storage.createUser({ name: "Fixture actor", email: `actor-${++sequence}@example.invalid`, role, active: true, tenantId, isSuperAdmin: marker ? 1 : 0 } as any);
  // Explicit fixture-only marker; normal role mutation must not grant it.
  db.prepare("UPDATE users SET is_super_admin=? WHERE id=?").run(marker ? 1 : 0, user.id);
  return { user, token: storage.createSession(user.id).id };
}
function notification(tenantId = 1) {
  return Number(db.prepare(`INSERT INTO notification_outbox(tenant_id,dedupe_key,kind,payload,status,attempts,last_error)
    VALUES (?,?,'fresh_fiber',?,'failed',5,?)`).run(tenantId, `fixture-${++sequence}`, JSON.stringify({ body: secret }), secret).lastInsertRowid);
}
async function financial(tenantId = 1) {
  const E = await import("../../server/domainEventStore");
  const event = E.emit({ tenantId, type: "SALE_APPROVED", subjectType: "sale", subjectId: ++sequence, occurredAt: new Date().toISOString() }, new Date().toISOString());
  db.prepare(`INSERT INTO event_processing_state(subscriber,event_id,tenant_id,event_type,status,attempts,last_error,created_at,updated_at)
    VALUES ('incentives',?,?,'SALE_APPROVED','blocked',5,?,datetime('now'),datetime('now'))`).run(event.id, tenantId, secret);
  return event.id;
}
beforeAll(async () => {
  vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "hf-reliability-http-")));
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("SQLITE_BUSY_TIMEOUT_MS", "1");
  file = join(process.env.DATA_DIR!, "data.db");
  const mod = await import("../../server/storage"); mod.runMigrations(); storage = mod.storage;
  db = (await import("../../server/db")).rawDb;
  const { registerRoutes } = await import("../../server/routes");
  const app = express(); app.use(express.json()); server = createServer(app); registerRoutes(server, app);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(() => {
  vi.stubEnv("RELIABILITY_ROLLOUT_PERCENT", "100"); vi.stubEnv("OTP_ENCRYPTION_KEY", "7".repeat(64));
  vi.stubEnv("IDEMPOTENT_EMAIL", "true"); vi.stubEnv("OUTBOX_PATTERN", "true");
  db.exec("DELETE FROM otp_rate_buckets");
});
afterEach(() => { vi.restoreAllMocks(); vi.stubEnv("NODE_ENV", "test"); });
afterAll(async () => { await new Promise<void>(done => server.close(() => done())); vi.unstubAllEnvs(); });

it("queues login atomically with identical production acceptance for known, unknown and inactive addresses", async () => {
  const active = actor(), inactive = actor(); db.prepare("UPDATE users SET active=0 WHERE id=?").run(inactive.user.id);
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("RESEND_API_KEY", "fixture-key"); vi.stubEnv("RESEND_FROM", "Fixture <sender@example.invalid>");
  for (const email of [active.user.email, `unknown-${++sequence}@example.invalid`, inactive.user.email]) {
    const response = await request("/api/auth/otp/request", undefined, { email });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ sent: true });
  }
  expect(db.prepare("SELECT COUNT(*) n FROM auth_delivery_outbox WHERE user_id=?").get(active.user.id)).toEqual({ n: 1 });
  expect(db.prepare("SELECT code FROM otp_codes WHERE email=?").get(active.user.email)).toEqual({ code: expect.stringMatching(/^otp1\./) });
  expect((await import("../../server/resendMail")).sendResendEmail).not.toHaveBeenCalled();
});
it("fails configuration before account lookup and rolls back code/budget when enqueue fails", async () => {
  const known = actor(); vi.stubEnv("OTP_ENCRYPTION_KEY", ""); vi.stubEnv("CALLING_DATA_ENCRYPTION_KEY", "");
  const lookup = vi.spyOn(storage, "getUserByEmail");
  for (const email of [known.user.email, "missing@example.invalid"]) expect((await request("/api/auth/otp/request", undefined, { email })).status).toBe(503);
  expect(lookup).not.toHaveBeenCalled(); lookup.mockRestore(); vi.stubEnv("OTP_ENCRYPTION_KEY", "7".repeat(64));
  db.exec(`CREATE TEMP TRIGGER reject_auth_enqueue BEFORE INSERT ON auth_delivery_outbox BEGIN SELECT RAISE(ABORT,'fixture enqueue fault'); END`);
  try {
    expect((await request("/api/auth/otp/request", undefined, { email: known.user.email })).status).toBe(503);
    expect(db.prepare("SELECT COUNT(*) n FROM otp_codes WHERE email=?").get(known.user.email)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM otp_rate_buckets").get()).toEqual({ n: 0 });
  } finally { db.exec("DROP TRIGGER reject_auth_enqueue"); }
});
it("scopes audit to immutable platform authority, including NULL-tenant attempts", async () => {
  for (const tid of [1, 2, null]) storage.logLoginAttempt(`audit-${tid}@example.invalid`, "request", false, "fixture", null, null, tid);
  for (const identity of [actor(), actor("super_admin"), actor("admin", null, true)]) {
    for (const suffix of ["", "?summary=1"]) {
      const response = await request(`/api/auth/login-attempts${suffix}`, identity.token);
      expect(response.status).toBe(200); const text = JSON.stringify(await response.json());
      expect(text).toContain("audit-1@");
      if (identity.user.tenantId === null) { expect(text).toContain("audit-2@"); expect(text).toContain("audit-null@"); }
      else { expect(text).not.toContain("audit-2@"); expect(text).not.toContain("audit-null@"); }
    }
  }
});
it("keeps failed work visible after flag rollback, without private contents or foreign work", async () => {
  const admin = actor(), own = notification(), foreign = notification(2); vi.stubEnv("RELIABILITY_ROLLOUT_PERCENT", "0");
  const response = await request("/api/reliability/recovery?tenantId=2", admin.token);
  expect(response.status).toBe(200); const body = await response.json(); expect(body.enabled).toBe(true);
  expect(body.items).toContainEqual(expect.objectContaining({ category: "notification", id: String(own) }));
  expect(body.items).not.toContainEqual(expect.objectContaining({ category: "notification", id: String(foreign) }));
  expect(JSON.stringify(body)).not.toContain(secret);
  expect((await request(`/api/reliability/recovery/notification/${foreign}/discard`, admin.token, { reason: "Foreign attempt", tenantId: 2 })).status).toBe(404);
  expect((await request(`/api/reliability/recovery/notification/${own}/discard`, admin.token, { reason: "" })).status).toBe(400);
  expect((await request(`/api/reliability/recovery/notification/${own}/discard`, actor("manager").token, { reason: "Reviewed work" })).status).toBe(403);
  expect((await request(`/api/reliability/recovery/notification/${own}/discard`, admin.token, { reason: "Reviewed work" })).status).toBe(200);
  expect(db.prepare("SELECT status,payload FROM notification_outbox WHERE id=?").get(own)).toEqual({ status: "discarded", payload: "{}" });
});
it.each(["session", "absolute", "deactivate", "demote", "transfer"])("rechecks %s revocation after acquiring a held SQLite writer", async change => {
  const admin = actor(), id = notification(); const holder = new Database(file); holder.exec("BEGIN IMMEDIATE");
  let authenticated!: () => void;
  const read = new Promise<void>(resolve => { authenticated = resolve; });
  const original = storage.touchSession.bind(storage);
  vi.spyOn(storage, "touchSession").mockImplementation(session => { const result = original(session); if (session.userId === admin.user.id) authenticated(); return result; });
  try {
    const pending = request(`/api/reliability/recovery/notification/${id}/discard`, admin.token, { reason: "Reviewed work" });
    await Promise.race([read, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Authenticated request checkpoint missing")), 2000); timer.unref(); })]);
    if (change === "session") holder.prepare("DELETE FROM sessions WHERE id=?").run(admin.token);
    else if (change === "absolute") holder.prepare("UPDATE sessions SET created_at=? WHERE id=?").run(new Date(0).toISOString(), admin.token);
    else holder.prepare(`UPDATE users SET ${change === "deactivate" ? "active=0" : change === "demote" ? "role='manager'" : "tenant_id=2"} WHERE id=?`).run(admin.user.id);
    holder.exec("COMMIT");
    expect((await pending).status).toBe(403);
    expect(db.prepare("SELECT status FROM notification_outbox WHERE id=?").get(id)).toEqual({ status: "failed" });
    expect(db.prepare("SELECT COUNT(*) n FROM activity_log WHERE user_id=? AND action='delivery.discard'").get(admin.user.id)).toEqual({ n: 0 });
  } finally { if (holder.inTransaction) holder.exec("ROLLBACK"); holder.close(); }
});
it("audits financial set-aside and rejects cursor-passed replay and stale actions", async () => {
  const admin = actor(), id = await financial();
  const path = `/api/commission/queue/events/${id}/action`;
  let response = await request(path, admin.token, { action: "DEAD_LETTER", reason: "Reviewed effect" });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ eventId: id, status: "dead_lettered", attempts: 5 });
  db.prepare("INSERT INTO event_subscriptions(name,last_event_id,updated_at) VALUES ('incentives',?,datetime('now')) ON CONFLICT(name) DO UPDATE SET last_event_id=excluded.last_event_id").run(id);
  response = await request(path, admin.token, { action: "RETRY", reason: "Reviewed effect" });
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "QUEUE_CURSOR_PASSED" });
  const recovery = await (await request("/api/reliability/recovery", admin.token)).json();
  expect(recovery.items).toContainEqual(expect.objectContaining({ id: String(id), category: "financial", eventType: "SALE_APPROVED", replayable: false }));
  for (const state of ["completed", "processing", "resolved", "pending"]) {
    db.prepare("UPDATE event_processing_state SET status=? WHERE event_id=?").run(state, id);
    expect((await request(path, admin.token, { action: "DEAD_LETTER", reason: "Reviewed effect" })).status).toBe(409);
  }
});
it("does not let historical set-aside events hide a current financial blocker", async () => {
  const admin = actor();
  for (let i = 0; i < 55; i++) {
    const id = await financial(); db.prepare("UPDATE event_processing_state SET status='dead_lettered' WHERE event_id=?").run(id);
  }
  const blocked = await financial();
  const body = await (await request("/api/reliability/recovery", admin.token)).json();
  expect(body.items).toContainEqual(expect.objectContaining({ id: String(blocked), category: "financial", status: "blocked" }));
});
it("runs canary assignment, replays after flag rollback, and recovers the completed undo receipt", async () => {
  const admin = actor();
  const rep = storage.createTeamMember({ name: "Fixture rep", email: `rep-${++sequence}@example.invalid`, active: true, role: "rep", tenantId: 1 } as any);
  const lead = Number(db.prepare("INSERT INTO leads(tenant_id,address,city,state,zip,created_at,updated_at) VALUES (1,?,'Fixture','NC','27000',datetime('now'),datetime('now'))").run(`${++sequence} Fixture Street`).lastInsertRowid);
  const body = { leadIds: [lead], repId: rep.id, opId: `http-assignment-${++sequence}` };
  let response = await request("/api/leads/bulk-assign", admin.token, body);
  expect(response.status).toBe(200); const original = await response.json(); expect(original.updated).toBe(1); expect(original.undoToken).toMatch(/^durable-/);
  vi.stubEnv("RELIABILITY_ROLLOUT_PERCENT", "0");
  response = await request("/api/leads/bulk-assign", admin.token, body); expect(await response.json()).toEqual(original);
  expect(db.prepare("SELECT COUNT(*) n FROM lead_events WHERE lead_id=?").get(lead)).toEqual({ n: 1 });
  response = await request("/api/leads/assign-selection/undo", admin.token, { token: original.undoToken });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ restored: 1, skipped: 0 });
  // A stale browser can still say Continue put back after that reply was lost.
  response = await request(`/api/leads/assignment-operations/${original.operationId}/resume`, admin.token, {});
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ restored: 1, skipped: 0 });
  expect((await request(`/api/leads/assignment-operations/${original.operationId}/resume`, actor().token, {})).status).toBe(404);
  expect(db.prepare("SELECT COUNT(*) n FROM lead_events WHERE lead_id=?").get(lead)).toEqual({ n: 2 });
});
it("rejects assignment admission when its session is revoked during writer contention", async () => {
  const admin = actor(), rep = storage.createTeamMember({ name: "Fixture rep", email: `rep-${++sequence}@example.invalid`, active: true, role: "rep", tenantId: 1 } as any);
  const lead = Number(db.prepare("INSERT INTO leads(tenant_id,address,city,state,zip,created_at,updated_at) VALUES (1,?,'Fixture','NC','27000',datetime('now'),datetime('now'))").run(`${++sequence} Fixture Street`).lastInsertRowid);
  const holder = new Database(file); holder.exec("BEGIN IMMEDIATE");
  let readDone!: () => void; const read = new Promise<void>(resolve => { readDone = resolve; });
  const original = storage.touchSession.bind(storage);
  vi.spyOn(storage, "touchSession").mockImplementation(session => { const result = original(session); if (session.userId === admin.user.id) readDone(); return result; });
  try {
    const pending = request("/api/leads/bulk-assign", admin.token, { leadIds: [lead], repId: rep.id, opId: `revoked-${++sequence}` });
    await Promise.race([read, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Authenticated request checkpoint missing")), 2000); timer.unref(); })]); holder.prepare("DELETE FROM sessions WHERE id=?").run(admin.token); holder.exec("COMMIT");
    expect((await pending).status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) n FROM assignment_operations WHERE actor_user_id=?").get(admin.user.id)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM lead_events WHERE lead_id=?").get(lead)).toEqual({ n: 0 });
  } finally { if (holder.inTransaction) holder.exec("ROLLBACK"); holder.close(); }
});
it("rolls back recovery on audit failure and sanitizes financial failure responses", async () => {
  const admin = actor(), id = await financial(), notice = notification();
  db.exec(`CREATE TEMP TRIGGER reject_recovery_audit BEFORE INSERT ON activity_log BEGIN SELECT RAISE(ABORT,'${secret}'); END`);
  try {
    const response = await request(`/api/commission/queue/events/${id}/action`, admin.token, { action: "DEAD_LETTER", reason: "Reviewed effect" });
    expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain(secret);
    expect(db.prepare("SELECT status FROM event_processing_state WHERE event_id=?").get(id)).toEqual({ status: "blocked" });
    expect((await request(`/api/reliability/recovery/notification/${notice}/discard`, admin.token, { reason: "Reviewed work" })).status).toBe(503);
    expect(db.prepare("SELECT status FROM notification_outbox WHERE id=?").get(notice)).toEqual({ status: "failed" });
  } finally { db.exec("DROP TRIGGER reject_recovery_audit"); }
});

it("auth status authoritatively rejects absolute-expired sessions without a cleanup write", async () => {
  const admin = actor();
  db.prepare("UPDATE sessions SET created_at=? WHERE id=?").run(new Date(0).toISOString(), admin.token);
  const before = db.prepare("SELECT total_changes() n").get();
  const body = await (await request("/api/auth/status", admin.token)).json();
  expect(body.currentUser).toBeNull();
  expect(db.prepare("SELECT total_changes() n").get()).toEqual(before);
});

it("reuses joined organization status without loading the full tenant on authentication", async () => {
  const admin = actor();
  const lookup = vi.spyOn(storage, "getTenantById");
  try {
    const allowed = await request("/api/announcements", admin.token);
    expect(allowed.status).toBe(200); await allowed.json();
    db.exec("UPDATE tenants SET status='suspended' WHERE id=1");
    const denied = await request("/api/announcements", admin.token);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "ORGANIZATION_INACTIVE" });
    expect(lookup).not.toHaveBeenCalled();
  } finally { lookup.mockRestore(); db.exec("UPDATE tenants SET status='active' WHERE id=1"); }
});
