// DELETE /api/leads/:id — guarded delete. A lead with field history
// (knock_log / commissions / lead_photos rows) used to die on SQLITE_CONSTRAINT
// and surface a raw 500. Now the probe runs in the same IMMEDIATE transaction
// as the delete and the route answers 409 with the blocking counts; a residual
// FK error takes the same 409 path, never a 500. Clean leads still delete
// (200), cross-tenant stays 404, and requireManager is unchanged.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

type Person = { userId: number; memberId: number; session: string };
const fx: Record<string, Person> = {};

function person(name: string, role: string, tenantId = 1): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@del409.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...(init.headers ?? {}) },
  });
}

const del = (id: number, session: string) => req(`/api/leads/${id}`, session, { method: "DELETE" });

let addrSeq = 700;
function seedLead(over: Record<string, unknown> = {}, tenantId = 1): number {
  return storage.createLead({
    address: `${addrSeq++} Guard Ln`, city: "Testburg", state: "NC", zip: "28100",
    lat: 35.5, lng: -80.4, tenantId, leadStatus: "prospect",
    ...over,
  } as any).id;
}

const leadById = (id: number) => rawDb.prepare("SELECT * FROM leads WHERE id = ?").get(id) as any;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-del409-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));

  fx.manager = person("Mia Manager", "manager");
  fx.rep = person("Rex Rep", "rep");

  storage.createTenant({ slug: "other", companyName: "Other", ownerName: "O", ownerEmail: "o@other.test", brandName: "Other", brandColor: "#111", plan: "trial", status: "active" } as any);
  fx.foreignManager = person("Zoe Manager", "manager", 2);

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

afterAll(async () => {
  if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

describe("clean lead", () => {
  it("deletes with 200 and the row is gone", async () => {
    const id = seedLead();
    const res = await del(id, fx.manager.session);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(leadById(id)).toBeUndefined();
  });
});

describe("history-bearing lead", () => {
  it("knocks → 409 with the knock count in the message, and the lead survives", async () => {
    const id = seedLead();
    for (let i = 0; i < 13; i++) {
      storage.createKnock({ leadId: id, repId: fx.rep.memberId, wasHome: false, outcome: "not_home" } as any);
    }
    const res = await del(id, fx.manager.session);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("LEAD_HAS_HISTORY");
    expect(body.error).toContain("13 knocks");
    expect(body.error).toContain("can't be deleted");
    expect(body.error).toContain("not-interested / suppressed");
    expect(leadById(id)).toBeTruthy();
  });

  it("a commission → 409 naming the commission (singular), and the lead survives", async () => {
    const id = seedLead();
    storage.createCommission({ repId: fx.rep.memberId, tenantId: 1, leadId: id, amount: 100, saleDate: new Date().toISOString(), status: "pending" } as any);
    const res = await del(id, fx.manager.session);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("1 commission)");
    expect(body.error).not.toContain("1 commissions");
    expect(leadById(id)).toBeTruthy();
  });

  it("knocks + a commission together → one 409 message with both counts", async () => {
    const id = seedLead();
    for (let i = 0; i < 2; i++) {
      storage.createKnock({ leadId: id, repId: fx.rep.memberId, wasHome: false, outcome: "not_home" } as any);
    }
    storage.createCommission({ repId: fx.rep.memberId, tenantId: 1, leadId: id, amount: 50, saleDate: new Date().toISOString(), status: "pending" } as any);
    const res = await del(id, fx.manager.session);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("This lead has field history (2 knocks, 1 commission) and can't be deleted. Ask a manager to mark it not-interested / suppressed instead.");
    expect(leadById(id)).toBeTruthy();
  });

  it("a photo → 409 with the photo count, and the lead survives", async () => {
    const id = seedLead();
    rawDb.prepare("INSERT INTO lead_photos (tenant_id, lead_id, path) VALUES (1, ?, 'lead-photos/guard.jpg')").run(id);
    const res = await del(id, fx.manager.session);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("1 photo");
    expect(leadById(id)).toBeTruthy();
  });
});

describe("unchanged semantics", () => {
  it("a rep is refused (requireManager unchanged) - never a 500", async () => {
    const id = seedLead();
    const res = await del(id, fx.rep.session);
    expect([401, 403]).toContain(res.status);
    expect(leadById(id)).toBeTruthy();
  });

  it("cross-tenant delete is 404 and the foreign lead survives", async () => {
    const id = seedLead();
    const res = await del(id, fx.foreignManager.session);
    expect(res.status).toBe(404);
    expect(leadById(id)).toBeTruthy();
  });

  it("a nonexistent lead is 404, and no path in this suite returns 500", async () => {
    const res = await del(99999999, fx.manager.session);
    expect(res.status).toBe(404);
  });
});
