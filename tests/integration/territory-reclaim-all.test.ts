// The org-wide sweep: every held area back to the house in one audited action.
//
// POST /api/territories/reclaim-all is admin-only by design — per-area reclaim
// is everyday team-lead work, but emptying the whole org is a reorganization.
// These tests pin the blast radius: only the caller's tenant, only active held
// areas, leads released or kept per mode, one audit row, and idempotence (a
// second sweep finds nothing to take).
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

function person(name: string, role: string, tenantId = 1, opts: { reportsToId?: number | null } = {}): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@reclaimall.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId, reportsToId: opts.reportsToId ?? null } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...init.headers },
  });
}

const SQUARE = [[-80.41, 35.49], [-80.39, 35.49], [-80.39, 35.51], [-80.41, 35.51], [-80.41, 35.49]];

function seedArea(repIds: number[], tenantId = 1, status?: string) {
  const t = storage.createTerritory({
    tenantId, name: "Sweep patch", repId: repIds[0] ?? 0, polygon: JSON.stringify(SQUARE),
    color: "#3EA394", status: status ?? (repIds.length > 1 ? "shared" : "active"),
    assigneeIds: JSON.stringify(repIds),
  } as any);
  return t.id;
}

function seedLead(repId: number | null, territoryId: number, tenantId = 1) {
  return storage.createLead({
    address: `${Math.floor(Math.random() * 9000) + 100} Sweep St`, city: "Testburg", state: "NC", zip: "28100",
    lat: 35.50, lng: -80.40, tenantId, assignedRepId: repId, assignedTerritoryId: territoryId,
    leadStatus: "new_fiber",
  } as any).id;
}

const areaById = (id: number) => rawDb.prepare("SELECT * FROM territories WHERE id = ?").get(id) as any;
const holders = (id: number) => JSON.parse(areaById(id).assignee_ids ?? "[]") as number[];
const leadById = (id: number) => rawDb.prepare("SELECT * FROM leads WHERE id = ?").get(id) as any;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-reclaimall-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));

  fx.admin = person("Ada Admin", "admin");
  fx.manager = person("Mona Manager", "manager");
  fx.lead = person("Lee Lead", "team_lead", 1, { reportsToId: fx.manager.memberId });
  fx.repA = person("Rep Ann", "rep", 1, { reportsToId: fx.lead.memberId });
  fx.repB = person("Rep Bo", "rep", 1, { reportsToId: fx.lead.memberId });

  // A second org that the sweep must never touch.
  storage.createTenant({ slug: "other", companyName: "Other", ownerName: "O", ownerEmail: "o@other.test", brandName: "Other", brandColor: "#111", plan: "trial", status: "active" } as any);
  fx.foreignAdmin = person("Zed Admin", "admin", 2);
  fx.foreignRep = person("Rep Zed", "rep", 2);

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

describe("who may sweep", () => {
  it("a rep, a team lead, and a manager are all refused", async () => {
    for (const who of [fx.repA, fx.lead, fx.manager]) {
      const r = await req("/api/territories/reclaim-all", who.session, { method: "POST", body: JSON.stringify({ mode: "return_to_pool" }) });
      expect(r.status).toBe(403);
    }
  });

  it("an unknown mode is rejected before anything moves", async () => {
    const r = await req("/api/territories/reclaim-all", fx.admin.session, { method: "POST", body: JSON.stringify({ mode: "reassign" }) });
    expect(r.status).toBe(400);
  });
});

describe("the sweep itself", () => {
  it("empties every held area, releases the leads, skips archived, leaves the other tenant alone - then finds nothing on a second pass", async () => {
    // Tenant 1: two held areas (one shared), one already-empty, one archived.
    const a1 = seedArea([fx.repA.memberId]);
    const a2 = seedArea([fx.repA.memberId, fx.repB.memberId]);
    const empty = seedArea([]);
    const archived = seedArea([fx.repB.memberId], 1, "archived");
    // Tenant 2: a held area that must not move.
    const foreign = seedArea([fx.foreignRep.memberId], 2);

    const l1 = seedLead(fx.repA.memberId, a1);
    const l2 = seedLead(fx.repB.memberId, a2);
    const lForeign = seedLead(fx.foreignRep.memberId, foreign, 2);

    const r = await req("/api/territories/reclaim-all", fx.admin.session, { method: "POST", body: JSON.stringify({ mode: "return_to_pool" }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.reclaimed).toBe(2);              // a1 + a2 — not empty, not archived, not foreign
    expect(body.repsAffected).toBe(2);           // Ann + Bo
    expect(body.leadsAffected).toBeGreaterThanOrEqual(2);

    // Areas emptied and returned to the pool.
    expect(holders(a1)).toEqual([]);
    expect(holders(a2)).toEqual([]);
    expect(areaById(a1).status).toBe("unassigned");
    // Archived area untouched; foreign tenant untouched.
    expect(holders(archived)).toEqual([fx.repB.memberId]);
    expect(holders(foreign)).toEqual([fx.foreignRep.memberId]);
    expect(areaById(archived).status).toBe("archived");

    // Leads released in tenant 1, untouched in tenant 2.
    expect(leadById(l1).assigned_rep_id).toBeNull();
    expect(leadById(l2).assigned_rep_id).toBeNull();
    expect(leadById(lForeign).assigned_rep_id).toBe(fx.foreignRep.memberId);

    // The reps' own views go empty — visibility is the product requirement.
    const mine = await (await req("/api/territories", fx.repA.session)).json();
    expect((mine as any[]).filter(t => [a1, a2].includes(t.id))).toHaveLength(0);

    // ONE audit row records the whole sweep.
    const audits = rawDb.prepare("SELECT * FROM admin_audit WHERE action = 'territory.bulk_reclaimed'").all() as any[];
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].after_json).reclaimedTerritoryIds).toEqual(expect.arrayContaining([a1, a2]));

    // Idempotent: a second sweep has nothing to take.
    const again = await (await req("/api/territories/reclaim-all", fx.admin.session, { method: "POST", body: JSON.stringify({ mode: "return_to_pool" }) })).json();
    expect(again.reclaimed).toBe(0);
    expect(again.leadsAffected).toBe(0);
  });

  it("keep_leads mode takes the areas back but leaves the reps their leads", async () => {
    const a = seedArea([fx.repB.memberId]);
    const l = seedLead(fx.repB.memberId, a);

    const r = await req("/api/territories/reclaim-all", fx.admin.session, { method: "POST", body: JSON.stringify({ mode: "keep_leads" }) });
    expect(r.status).toBe(200);

    expect(holders(a)).toEqual([]);                                  // area back
    expect(leadById(l).assigned_rep_id).toBe(fx.repB.memberId);      // lead kept
  });
});
