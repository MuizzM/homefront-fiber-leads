// Neighborhood sweep API: who may read the neighborhood ranking, who may nudge
// a cycle, and that a tenant never sees another tenant's neighborhoods.
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

type Person = { userId: number; session: string };
const fx: Record<string, Person> = {};

function person(name: string, role: string, tenantId = 1): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@nsweep.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, session: storage.createSession(user.id).id };
}
const get = (path: string, session: string) => fetch(`${baseUrl}${path}`, { headers: { "x-session-id": session } });
const post = (path: string, session: string) => fetch(`${baseUrl}${path}`, {
  method: "POST", headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session }, body: "{}",
});

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-nsweep-routes-"));
  process.env.NODE_ENV = "test";
  delete process.env.NEIGHBORHOOD_SWEEP;
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));
  // Tenant 2 must exist for its users; the default tenant is created by migrations.
  rawDb.prepare("INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (2, 'other-co-nsweep', 'Other Co', 'Owner', 'owner-nsweep@example.com', 'Other Co')").run();

  fx.admin = person("Ada Admin", "admin");
  fx.manager = person("Mara Manager", "manager");
  fx.rep = person("Saad Rep", "rep");
  fx.otherManager = person("Otto Other", "manager", 2);

  const { ensureSweepSchema } = await import("../../server/neighborhoodSweep");
  ensureSweepSchema();
  const now = new Date().toISOString();
  const ins = rawDb.prepare(`INSERT INTO sweep_cells (tenant_id, state, cell_lat, cell_lng, city, phase, score, expected_rate, reasons, scanned, hits, live, unscanned, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run(1, "NC", 35.21, -82.23, "tryon", "flood", 0.5, 0.4, '["hit_in_cell"]', 20, 9, 10, 80, now);
  ins.run(1, "NC", 35.30, -80.60, "concord", "probe", 0.1, 0.08, '["cold"]', 0, 0, 0, 300, now);
  ins.run(2, "NC", 34.00, -80.00, "elsewhere", "flood", 0.9, 0.9, '["hit_in_cell"]', 5, 5, 5, 50, now);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${a.port}`;
});

afterAll(() => { server?.close(); });

describe("neighborhood sweep routes", () => {
  it("reps cannot read the ranking or the state", async () => {
    expect((await get("/api/sweep/neighborhoods", fx.rep.session)).status).toBe(403);
    expect((await get("/api/sweep/state", fx.rep.session)).status).toBe(403);
  });

  it("managers read their own tenant's neighborhoods, hot cells first", async () => {
    const res = await get("/api/sweep/neighborhoods?limit=10", fx.manager.session);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.neighborhoods.map((n: any) => n.city)).toEqual(["tryon", "concord"]);
    expect(body.neighborhoods[0]).toMatchObject({ phase: "flood", hits: 9, unscanned: 80, leads: 0, unworkedLeads: 0, sampleLeadId: null });
    expect(body.neighborhoods[0].bbox.minLat).toBeCloseTo(35.205, 5);
  });

  it("a manager in another tenant sees only their own, on both endpoints", async () => {
    const body = await (await get("/api/sweep/neighborhoods", fx.otherManager.session)).json();
    expect(body.neighborhoods.map((n: any) => n.city)).toEqual(["elsewhere"]);
    const state = await (await get("/api/sweep/state", fx.otherManager.session)).json();
    expect(state.cells).toEqual({ flood: 1 });
  });

  it("phase and state filters narrow the ranking; junk values are ignored", async () => {
    const probe = await (await get("/api/sweep/neighborhoods?phase=probe", fx.manager.session)).json();
    expect(probe.neighborhoods.map((n: any) => n.city)).toEqual(["concord"]);
    const sc = await (await get("/api/sweep/neighborhoods?state=sc", fx.manager.session)).json();
    expect(sc.neighborhoods).toEqual([]);
    const junk = await (await get("/api/sweep/neighborhoods?phase=drop%20table&state=xyz&limit=abc", fx.manager.session)).json();
    expect(junk.neighborhoods).toHaveLength(2);
  });

  it("the state endpoint reports the switch and the phase counts", async () => {
    const body = await (await get("/api/sweep/state", fx.manager.session)).json();
    expect(body.enabled).toBe(false);
    expect(body.state).toBe("NC");
    expect(body.cells).toEqual({ flood: 1, probe: 1 });
    expect(body.lastCycle).toBeNull();
  });

  it("the cycle nudge is admin-only and refuses while the switch is off", async () => {
    expect((await post("/api/sweep/cycle", fx.manager.session)).status).toBe(403);
    const res = await post("/api/sweep/cycle", fx.admin.session);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/NEIGHBORHOOD_SWEEP is off/);
  });

  it("an admin nudge runs a cycle in a single-process rig when the switch is on", async () => {
    process.env.NEIGHBORHOOD_SWEEP = "on";
    process.env.NEIGHBORHOOD_SWEEP_E911 = "off";
    try {
      const res = await post("/api/sweep/cycle", fx.admin.session);
      expect(res.status).toBe(200);
      const body = await res.json();
      // No scan_targets exist in this DB, so the cycle enqueues nothing but records itself.
      expect(body.flood).toBe(0);
      expect(body.probe).toBe(0);
      expect(body.runIds).toEqual([]);
      const state = await (await get("/api/sweep/state", fx.admin.session)).json();
      expect(state.enabled).toBe(true);
      expect(state.lastCycle).not.toBeNull();
    } finally {
      delete process.env.NEIGHBORHOOD_SWEEP;
    }
  });
});
