// A central mark must appear in the lead's History.
//
// Reported: the card shows "No changes yet" after a manager marks a door
// centrally. The write sits in a try/catch that only console.warns, so a
// failure there is invisible — which is exactly this symptom. This test settles
// whether the row is never written, or written and lost on the way back.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server; let baseUrl: string; let storage: any; let rawDb: any;
const fx: Record<string, any> = {};

function person(name: string, role: string, tenantId = 1) {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@cm.test`;
  const m = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const u = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: m.id } as any);
  return { userId: u.id, memberId: m.id, session: storage.createSession(u.id).id };
}
function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: {
    "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...(init.headers ?? {}) } });
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-cm-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations(); storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));
  fx.manager = person("Mona Manager", "manager");
  fx.rep = person("Ann Rivera", "rep");
  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express(); app.use(express.json()); server = createServer(app);
  registerRoutes(server, app); registerSaasRoutes(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const seedLead = (over: any = {}) => storage.createLead({
  address: "605 Abbie Avenue", city: "High Point", state: "NC", zip: "27263",
  lat: 35.95, lng: -80.0, tenantId: 1, leadStatus: "prospect", ...over,
} as any).id;

describe("central mark lands in History", () => {
  // The server side was never the bug — this pins it so it stays that way. The
  // failure was client-side: the card fetched history when it opened and nothing
  // invalidated that query after a central mark, so it kept rendering the empty
  // result under a mark the manager had just made.
  it("writes a knock row the history endpoint returns", async () => {
    const lead = seedLead();
    const res = await req(`/api/leads/${lead}/central-disposition`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ outcome: "sold" }),
    });
    console.log("CENTRAL STATUS:", res.status, (await res.clone().text()).slice(0, 200));

    const rows = rawDb.prepare(`SELECT * FROM knock_log WHERE lead_id = ?`).all(lead);
    console.log("KNOCK ROWS:", rows.length, JSON.stringify(rows[0] ?? null).slice(0, 200));

    const hist = await (await req(`/api/leads/${lead}/history`, fx.manager.session)).json();
    console.log("HISTORY ROWS:", Array.isArray(hist) ? hist.length : JSON.stringify(hist).slice(0, 200));

    expect(res.status).toBe(200);
    expect(rows.length).toBe(1);
    // Flagged as central and credited to the acting manager, not a phantom visit.
    expect(rows[0].notes).toContain("[central]");
    expect(rows[0].was_home).toBe(0);
    expect(rows[0].outcome).toBe("sold");

    // And it comes back through the endpoint the CARD reads — the whole point.
    expect(Array.isArray(hist)).toBe(true);
    expect(hist).toHaveLength(1);
    expect(hist[0].type).toBe("status_change");
    expect(hist[0].status).toBe("sold");
  });

  it("works when the lead has no assigned rep — the fallback path", async () => {
    const lead = seedLead({ assignedRepId: null });
    await req(`/api/leads/${lead}/central-disposition`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ outcome: "not_interested" }),
    });
    const rows = rawDb.prepare(`SELECT * FROM knock_log WHERE lead_id = ?`).all(lead);
    console.log("NO-REP KNOCK ROWS:", rows.length);
    expect(rows.length).toBeGreaterThan(0);
  });
});
