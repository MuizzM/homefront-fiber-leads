// "The reps are done — pull the area."
//
// POST /api/territories/:id/reclaim is the owner's everyday pull-back. The
// field report said it "doesn't work when the reps are done", which is exactly
// the moment an area's status is no longer "active": Start-pass/Complete flows
// stamp it "completed" (and sharing stamps "shared"). These tests pin the
// server half of that report per status, end to end against the real routes:
//
//   active    + return_to_pool → 200, holders emptied, status unassigned, leads released
//   completed + return_to_pool → 200, same — completed is a LIVE status, not the pool
//   shared    + return_to_pool → 200, both holders removed
//   archived                  → 409 — a record, not a live assignment (same rule
//                               as reclaim-all and /unassign)
//
// Plus the authz edges: team_lead may pull their OWN team's area (200) but a
// rival team's is a 404, cross-tenant is a 404, reassign without a target is a
// 400, and reassign onto a rep at the active-area cap is a 409.
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
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@field-pull.example.test`;
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

const reclaim = (id: number, session: string, body: any = { mode: "return_to_pool" }) =>
  req(`/api/territories/${id}/reclaim`, session, { method: "POST", body: JSON.stringify(body) });

// Each seeded area gets its own patch of ground so lead linkage stays honest.
let patchCursor = 0;
function nextPatch(): [number, number] {
  return [-82.41 + 0.1 * patchCursor++, 33.49];
}
function square(west: number, south: number): number[][] {
  const e = west + 0.02, n = south + 0.02;
  return [[west, south], [e, south], [e, n], [west, n], [west, south]];
}

function seedArea(name: string, repIds: number[], opts: { tenantId?: number; status?: string; patch?: [number, number] } = {}) {
  const patch = opts.patch ?? nextPatch();
  const id = storage.createTerritory({
    tenantId: opts.tenantId ?? 1, name, repId: repIds[0] ?? null,
    polygon: JSON.stringify(square(patch[0], patch[1])),
    color: "#3EA394", status: opts.status ?? (repIds.length > 1 ? "shared" : "active"),
    assigneeIds: JSON.stringify(repIds),
  } as any).id;
  return { id, patch };
}

// A WORKED door: assigned to the rep, already dispositioned. Reclaim must
// release these — the field case is an area that has been knocked through.
function seedWorkedLead(territoryId: number, repId: number, patch: [number, number], n: number, tenantId = 1) {
  return storage.createLead({
    address: `${n} FieldPull St`, city: "Testburg", state: "NC", zip: "28100",
    lat: patch[1] + 0.01, lng: patch[0] + 0.01, tenantId,
    assignedTerritoryId: territoryId, assignedRepId: repId, leadStatus: "not_home",
  } as any).id;
}

const areaById = (id: number) => rawDb.prepare("SELECT * FROM territories WHERE id = ?").get(id) as any;
const holders = (id: number) => JSON.parse(areaById(id).assignee_ids ?? "[]") as number[];
const leadById = (id: number) => rawDb.prepare("SELECT * FROM leads WHERE id = ?").get(id) as any;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-field-pull-"));
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
  // A second team the lead must not be able to touch.
  fx.rivalLead = person("Riva Lead", "team_lead", 1, { reportsToId: fx.manager.memberId });
  fx.rivalRep = person("Rhea Rival", "rep", 1, { reportsToId: fx.rivalLead.memberId });

  storage.createTenant({ slug: "other-pull", companyName: "Other", ownerName: "O", ownerEmail: "o@other-pull.test", brandName: "Other", brandColor: "#111", plan: "trial", status: "active" } as any);
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

describe("admin pulls an ACTIVE area with an assigned rep and worked doors", () => {
  it("return_to_pool → 200, holders emptied, status unassigned, leads released", async () => {
    const { id, patch } = seedArea("Ann live patch", [fx.repA.memberId]);
    const doors = [1, 2, 3].map((n) => seedWorkedLead(id, fx.repA.memberId, patch, n));

    const r = await reclaim(id, fx.admin.session);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, mode: "return_to_pool", status: "unassigned" });
    expect(body.leadsAffected).toBe(3);

    expect(holders(id)).toEqual([]);
    expect(areaById(id).status).toBe("unassigned");
    for (const d of doors) {
      expect(leadById(d).assigned_rep_id).toBeNull();
      expect(leadById(d).assigned_territory_id).toBeNull();
    }
    // The rep's own view of the area is gone — that's what "pulled" means.
    const mine = await (await req("/api/territories", fx.repA.session)).json() as any[];
    expect(mine.map((t) => t.id)).not.toContain(id);
  });
});

describe("the exact field case: the reps are DONE - the area is 'completed'", () => {
  it("an area completed through POST /complete can still be reclaimed to the pool", async () => {
    const { id, patch } = seedArea("Finished patch", [fx.repA.memberId]);
    const doors = [1, 2].map((n) => seedWorkedLead(id, fx.repA.memberId, patch, 10 + n));

    // The real completion flow, not a hand-stamped status.
    const done = await req(`/api/territories/${id}/complete`, fx.admin.session, { method: "POST", body: JSON.stringify({ notes: "walked out" }) });
    expect(done.status).toBe(200);
    expect(areaById(id).status).toBe("completed");

    const r = await reclaim(id, fx.admin.session);
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe("unassigned");
    expect(holders(id)).toEqual([]);
    expect(areaById(id).status).toBe("unassigned");
    for (const d of doors) expect(leadById(d).assigned_rep_id).toBeNull();
  });

  it("a row already sitting at status 'completed' (any older flow) reclaims the same way", async () => {
    const { id, patch } = seedArea("Legacy completed patch", [fx.repB.memberId], { status: "completed" });
    const door = seedWorkedLead(id, fx.repB.memberId, patch, 21);

    const r = await reclaim(id, fx.admin.session);
    expect(r.status).toBe(200);
    expect(holders(id)).toEqual([]);
    expect(areaById(id).status).toBe("unassigned");
    expect(leadById(door).assigned_rep_id).toBeNull();
  });

  it("keep_leads on a completed area empties it but leaves the rep their pipeline", async () => {
    const { id, patch } = seedArea("Completed keep patch", [fx.repB.memberId], { status: "completed" });
    const door = seedWorkedLead(id, fx.repB.memberId, patch, 31);

    const r = await reclaim(id, fx.admin.session, { mode: "keep_leads" });
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe("reclaimed");
    expect(holders(id)).toEqual([]);
    expect(leadById(door).assigned_rep_id).toBe(fx.repB.memberId);
  });
});

describe("shared areas empty completely", () => {
  it("return_to_pool removes BOTH holders, not just the primary", async () => {
    const { id } = seedArea("Shared patch", [fx.repA.memberId, fx.repB.memberId]);
    const r = await reclaim(id, fx.admin.session);
    expect(r.status).toBe(200);
    expect(holders(id)).toEqual([]);
    expect(areaById(id).status).toBe("unassigned");
  });
});

describe("team lead scope", () => {
  it("a team lead pulls back their OWN team's area", async () => {
    const { id, patch } = seedArea("Lee team patch", [fx.repA.memberId]);
    const door = seedWorkedLead(id, fx.repA.memberId, patch, 41);
    const r = await reclaim(id, fx.lead.session);
    expect(r.status).toBe(200);
    expect(holders(id)).toEqual([]);
    expect(leadById(door).assigned_rep_id).toBeNull();
  });

  it("…including one their team has already completed", async () => {
    const { id } = seedArea("Lee completed patch", [fx.repB.memberId], { status: "completed" });
    const r = await reclaim(id, fx.lead.session);
    expect(r.status).toBe(200);
    expect(areaById(id).status).toBe("unassigned");
  });

  it("a rival team's area is a 404, and nothing moves", async () => {
    const { id } = seedArea("Rival patch", [fx.rivalRep.memberId]);
    const r = await reclaim(id, fx.lead.session);
    expect(r.status).toBe(404);
    expect(holders(id)).toEqual([fx.rivalRep.memberId]);
    expect(areaById(id).status).toBe("active");
  });
});

describe("the refusals", () => {
  it("cross-tenant reclaim is a 404, not a write", async () => {
    const { id } = seedArea("Foreign patch", [fx.foreignRep.memberId], { tenantId: 2 });
    const r = await reclaim(id, fx.admin.session);
    expect(r.status).toBe(404);
    expect(holders(id)).toEqual([fx.foreignRep.memberId]);
  });

  it("an unknown area id is a 404", async () => {
    expect((await reclaim(999999, fx.admin.session)).status).toBe(404);
  });

  it("a rep may not reclaim anything - 403 by capability", async () => {
    const { id } = seedArea("Rep denied patch", [fx.repA.memberId]);
    expect((await reclaim(id, fx.repA.session)).status).toBe(403);
  });

  it("an ARCHIVED area refuses with 409 - it is a record, not a live assignment", async () => {
    const { id } = seedArea("Archived patch", [fx.repA.memberId], { status: "archived" });
    const r = await reclaim(id, fx.admin.session);
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("ARCHIVED");
    // Untouched: still archived, holder record preserved.
    expect(areaById(id).status).toBe("archived");
    expect(holders(id)).toEqual([fx.repA.memberId]);
  });

  it("reassign without a target rep is a 400", async () => {
    const { id } = seedArea("No target patch", [fx.repA.memberId]);
    expect((await reclaim(id, fx.admin.session, { mode: "reassign" })).status).toBe(400);
  });

  it("reassign onto a rep already at the active-area cap is a 409", async () => {
    // Load Bo to the cap with bare active areas…
    for (let i = 0; i < 5; i++) seedArea(`Bo cap ${i}`, [fx.repB.memberId]);
    const { id } = seedArea("Handoff patch", [fx.repA.memberId]);
    const r = await reclaim(id, fx.admin.session, { mode: "reassign", newRepId: fx.repB.memberId });
    expect(r.status).toBe(409);
    // Refused BEFORE anything moved.
    expect(holders(id)).toEqual([fx.repA.memberId]);
  });
});
