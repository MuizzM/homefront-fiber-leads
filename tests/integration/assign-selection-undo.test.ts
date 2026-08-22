// Undo for a lasso assignment: the doors the write changed go back to their
// previous owners, once, for the same user in the same tenant, inside the
// window, and never over a door somebody else moved in the meantime.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server; let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
type Person = { userId: number; memberId: number; session: string };
const fx: Record<string, Person> = {};
function person(name: string, role: string, tenantId = 1): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@undo.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}
function post(path: string, session: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session },
    body: JSON.stringify(body),
  });
}
// A small box; every seeded door sits inside it.
const RING: [number, number][] = [[-80.30, 35.80], [-80.20, 35.80], [-80.20, 35.90], [-80.30, 35.90]];
let addrSeq = 5000;
function seedLead(over: Record<string, unknown> = {}): number {
  return storage.createLead({
    address: `${addrSeq++} Undo Way`, city: "Lexington", state: "NC", zip: "27292",
    lat: 35.85, lng: -80.25, tenantId: 1, leadStatus: "prospect", ...over,
  } as any).id;
}
const owner = (id: number) => (rawDb.prepare("SELECT assigned_rep_id r, assigned_by b FROM leads WHERE id = ?").get(id) as any);

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-assignundo-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations(); storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));
  fx.manager = person("Mara Manager", "manager");
  fx.manager2 = person("Milo Manager", "manager");
  fx.saad = person("Saad Rep", "rep");
  fx.otto = person("Otto Rep", "rep");
  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express(); app.use(express.json({ limit: "64kb" }));
  server = createServer(app); registerRoutes(server, app); registerSaasRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => { if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))); });

describe("POST /api/leads/assign-selection/undo", () => {
  it("restores each door to its OWN previous owner, and the token works once", async () => {
    const pool = seedLead();
    const ottos = seedLead({ assignedRepId: fx.otto.memberId, assignedBy: "Seed", assignedAt: "2026-08-01T00:00:00.000Z" });
    const res = await post("/api/leads/assign-selection", fx.manager.session, { polygon: RING, repId: fx.saad.memberId });
    const json = await res.json();
    expect(json.updated).toBe(2);
    expect(typeof json.undoToken).toBe("string");
    expect(owner(pool).r).toBe(fx.saad.memberId);
    expect(owner(ottos).r).toBe(fx.saad.memberId);

    const undo = await post("/api/leads/assign-selection/undo", fx.manager.session, { token: json.undoToken });
    expect(undo.status).toBe(200);
    expect(await undo.json()).toEqual({ restored: 2, skipped: 0 });
    expect(owner(pool).r).toBeNull();
    expect(owner(ottos)).toEqual({ r: fx.otto.memberId, b: "Seed" });
    // History records the put-back as an assignment event.
    const ev = rawDb.prepare("SELECT detail FROM lead_events WHERE lead_id = ? AND type = 'assignment' ORDER BY id DESC LIMIT 1").get(ottos) as any;
    expect(JSON.parse(ev.detail)).toMatchObject({ assignedTo: "Otto Rep", undo: true });

    const again = await post("/api/leads/assign-selection/undo", fx.manager.session, { token: json.undoToken });
    expect(again.status).toBe(410);
  });

  it("leaves a door alone when someone else moved it after the assignment", async () => {
    const a = seedLead(), b = seedLead();
    const json = await (await post("/api/leads/assign-selection", fx.manager.session, { polygon: RING, repId: fx.saad.memberId })).json();
    // A second manager hands door b to Otto before the undo lands.
    rawDb.prepare("UPDATE leads SET assigned_rep_id = ? WHERE id = ?").run(fx.otto.memberId, b);
    const undo = await (await post("/api/leads/assign-selection/undo", fx.manager.session, { token: json.undoToken })).json();
    expect(undo.restored).toBeGreaterThanOrEqual(1);
    expect(undo.skipped).toBeGreaterThanOrEqual(1);
    expect(owner(a).r).toBeNull();
    expect(owner(b).r).toBe(fx.otto.memberId);
  });

  it("only the person who assigned can undo, and a bad token is gone, not found", async () => {
    seedLead();
    const json = await (await post("/api/leads/assign-selection", fx.manager.session, { polygon: RING, repId: fx.saad.memberId })).json();
    const other = await post("/api/leads/assign-selection/undo", fx.manager2.session, { token: json.undoToken });
    expect(other.status).toBe(403);
    const bogus = await post("/api/leads/assign-selection/undo", fx.manager.session, { token: "nope" });
    expect(bogus.status).toBe(410);
    // The rightful owner can still redeem it afterwards.
    expect((await post("/api/leads/assign-selection/undo", fx.manager.session, { token: json.undoToken })).status).toBe(200);
  });

  it("a rep has no undo route, like no assignment route", async () => {
    const res = await post("/api/leads/assign-selection/undo", fx.saad.session, { token: "x" });
    expect(res.status).toBe(403);
  });
});
