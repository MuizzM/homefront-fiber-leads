// HTTP surface for the Ready-to-Call workspace: tenant/authz walls, the claim
// lock returning 409 to a second rep, and the idempotent outcome write.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let server: Server;
let baseUrl = "";

type Person = { userId: number; memberId: number; session: string };
function person(name: string, role: string, tenantId = 1): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@rtc-routes.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}
function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...init.headers } });
}
let seq = 900;
function seedLead(tenantId: number, over: Record<string, any> = {}): number {
  return Number(rawDb.prepare(
    `INSERT INTO leads (address, city, state, zip, tenant_id, contact_name, contact_phone, assigned_rep_id, lead_status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
  ).run(`${seq++} Route St`, "Greensboro", "NC", "27401", tenantId, over.contactName ?? "Pat", over.contactPhone ?? "3365550142", over.assignedRepId ?? null, "prospect").lastInsertRowid);
}

let admin: Person, admin2: Person, repA: Person, otherTenant: Person;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-rtc-routes-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));

  admin = person("Ada Admin", "admin", 1);
  admin2 = person("Bea Admin", "admin", 1);
  repA = person("Rae A", "rep", 1);
  otherTenant = person("Ozzy Other", "admin", 2);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${a.port}`;
});
afterAll(async () => { if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))); });

describe("GET /api/ready-to-call/queue", () => {
  it("returns this tenant's phone-bearing leads, never another tenant's", async () => {
    const mine = seedLead(1);
    const foreign = seedLead(2);
    const body = await (await req("/api/ready-to-call/queue", admin.session)).json();
    const ids = body.queue.map((l: any) => l.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(foreign);
  });
});

describe("claim lock", () => {
  it("second rep gets 409 and is told who holds it; wrong tenant gets 404", async () => {
    const lead = seedLead(1);
    const first = await req(`/api/ready-to-call/${lead}/claim`, admin.session, { method: "POST", body: "{}" });
    expect(first.status).toBe(200);
    const second = await req(`/api/ready-to-call/${lead}/claim`, admin2.session, { method: "POST", body: "{}" });
    expect(second.status).toBe(409);
    expect((await second.json()).holder.name).toBe("Ada Admin");
    // A different tenant cannot even see the lead.
    const cross = await req(`/api/ready-to-call/${lead}/claim`, otherTenant.session, { method: "POST", body: "{}" });
    expect(cross.status).toBe(404);
    // Release frees it.
    await req(`/api/ready-to-call/${lead}/release`, admin.session, { method: "POST", body: "{}" });
    expect((await req(`/api/ready-to-call/${lead}/claim`, admin2.session, { method: "POST", body: "{}" })).status).toBe(200);
  });
});

describe("POST outcome", () => {
  it("saves, advances status, and is idempotent on clientId", async () => {
    const lead = seedLead(1, { assignedRepId: repA.memberId });
    const body = { outcome: "interested", notes: "keen", clientId: "route-cid-1" };
    const r1 = await req(`/api/ready-to-call/${lead}/outcome`, repA.session, { method: "POST", body: JSON.stringify(body) });
    expect(r1.status).toBe(200);
    expect((await r1.json()).leadStatus).toBe("interested");
    const r2 = await req(`/api/ready-to-call/${lead}/outcome`, repA.session, { method: "POST", body: JSON.stringify(body) });
    expect((await r2.json()).duplicate).toBe(true);
    expect(rawDb.prepare("SELECT COUNT(*) c FROM call_log WHERE lead_id = ?").get(lead)).toMatchObject({ c: 1 });
  });

  it("rejects a callback with no time (400) and a foreign tenant (404)", async () => {
    const lead = seedLead(1, { assignedRepId: repA.memberId });
    expect((await req(`/api/ready-to-call/${lead}/outcome`, repA.session, { method: "POST", body: JSON.stringify({ outcome: "callback" }) })).status).toBe(400);
    expect((await req(`/api/ready-to-call/${lead}/outcome`, otherTenant.session, { method: "POST", body: JSON.stringify({ outcome: "answered" }) })).status).toBe(404);
  });
});
