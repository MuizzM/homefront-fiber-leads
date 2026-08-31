// Removing ONE rep from an area — the everyday operation reclaim couldn't do.
//
// The product requirement is specifically about VISIBILITY: after a manager
// removes a rep, that rep must stop seeing the area AND the doors inside it.
// So these tests assert the rep's own view goes empty, not merely that a column
// changed.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unassignRep, type TerritoryState } from "../../shared/territory";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

type Person = { userId: number; memberId: number; session: string };
const fx: Record<string, Person> = {};
let areaId = 0;

function person(name: string, role: string, tenantId = 1, opts: { reportsToId?: number | null } = {}): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@unassign.example.test`;
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

function seedArea(repIds: number[], tenantId = 1) {
  const t = storage.createTerritory({
    tenantId, name: "Shared patch", repId: repIds[0], polygon: JSON.stringify(SQUARE),
    color: "#3EA394", status: repIds.length > 1 ? "shared" : "active",
    assigneeIds: JSON.stringify(repIds),
  } as any);
  return t.id;
}

// Leads belong to an area via assignedTerritoryId (see getLeadsByTerritory).
function seedLead(repId: number | null, territoryId: number, tenantId = 1) {
  return storage.createLead({
    address: `${Math.floor(Math.random() * 9000) + 100} Patch St`, city: "Testburg", state: "NC", zip: "28100",
    lat: 35.50, lng: -80.40, tenantId, assignedRepId: repId, assignedTerritoryId: territoryId,
    leadStatus: "new_fiber",
  } as any).id;
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-unassign-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));

  fx.manager = person("Mona Manager", "manager");
  fx.lead = person("Lee Lead", "team_lead", 1, { reportsToId: fx.manager.memberId });
  fx.repA = person("Rep Ann", "rep", 1, { reportsToId: fx.lead.memberId });
  fx.repB = person("Rep Bo", "rep", 1, { reportsToId: fx.lead.memberId });

  // A second org whose reps must never be reachable from tenant 1.
  storage.createTenant({ slug: "other", companyName: "Other", ownerName: "O", ownerEmail: "o@other.test", brandName: "Other", brandColor: "#111", plan: "trial", status: "active" } as any);
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

describe("unassignRep (pure rule)", () => {
  const base: TerritoryState = { id: 1, status: "shared", repIds: [7, 8], color: "#fff", leads: [], history: [] };

  it("removes only the named rep and keeps co-assignees", () => {
    const next = unassignRep({ ...base }, 7, { actorId: 1, at: "2026-01-01T00:00:00Z" });
    expect(next.repIds).toEqual([8]);
    expect(next.status).toBe("active"); // one owner left → a live single-rep area
  });

  it("releases ONLY the removed rep's leads", () => {
    const state = { ...base, leads: [{ id: 1, assignedRepId: 7 }, { id: 2, assignedRepId: 8 }, { id: 3, assignedRepId: null }] };
    const next = unassignRep(state, 7, { actorId: 1, at: "2026-01-01T00:00:00Z" });
    expect(next.leads).toEqual([{ id: 1, assignedRepId: null }, { id: 2, assignedRepId: 8 }, { id: 3, assignedRepId: null }]);
  });

  it("removing the last rep puts the area in the pool", () => {
    const next = unassignRep({ ...base, repIds: [7] }, 7, { actorId: 1, at: "2026-01-01T00:00:00Z" });
    expect(next.repIds).toEqual([]);
    expect(next.status).toBe("unassigned");
  });

  it("is a no-op for a rep who is not assigned (no phantom history)", () => {
    const next = unassignRep({ ...base }, 99, { actorId: 1, at: "2026-01-01T00:00:00Z" });
    expect(next).toEqual(base);
    expect(next.history).toHaveLength(0);
  });

  it("does not mutate the input", () => {
    const state: TerritoryState = { ...base, leads: [{ id: 1, assignedRepId: 7 }] };
    unassignRep(state, 7, { actorId: 1, at: "2026-01-01T00:00:00Z" });
    expect(state.repIds).toEqual([7, 8]);
    expect(state.leads[0].assignedRepId).toBe(7);
  });

  it("releaseLeads:false leaves doors where they are", () => {
    const state = { ...base, leads: [{ id: 1, assignedRepId: 7 }] };
    const next = unassignRep(state, 7, { actorId: 1, at: "2026-01-01T00:00:00Z", releaseLeads: false });
    expect(next.leads[0].assignedRepId).toBe(7);
  });
});

describe("POST /api/territories/:id/unassign", () => {
  it("THE REQUIREMENT: the removed rep can no longer see the area or its doors", async () => {
    areaId = seedArea([fx.repA.memberId, fx.repB.memberId]);
    const leadA = seedLead(fx.repA.memberId, areaId);
    const leadB = seedLead(fx.repB.memberId, areaId);

    // Both reps see it up front.
    expect(((await (await req("/api/territories", fx.repA.session)).json()) as any[]).some(t => t.id === areaId)).toBe(true);

    const res = await req(`/api/territories/${areaId}/unassign`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repId: fx.repA.memberId }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, repId: fx.repA.memberId, leadsReleased: 1 });

    // Gone from the removed rep's view…
    const aSees = (await (await req("/api/territories", fx.repA.session)).json()) as any[];
    expect(aSees.some(t => t.id === areaId)).toBe(false);
    // …and their door went back to the pool, so it isn't visible that way either.
    expect((storage.getLeadById(leadA) as any).assignedRepId).toBeNull();

    // The co-assignee is untouched — this removes one rep, not the area.
    const bSees = (await (await req("/api/territories", fx.repB.session)).json()) as any[];
    expect(bSees.some(t => t.id === areaId)).toBe(true);
    expect((storage.getLeadById(leadB) as any).assignedRepId).toBe(fx.repB.memberId);
  });

  it("removing the last rep returns the area to the pool", async () => {
    const id = seedArea([fx.repB.memberId]);
    const res = await req(`/api/territories/${id}/unassign`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repId: fx.repB.memberId }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).status).toBe("unassigned");
    expect(((await (await req("/api/territories", fx.repB.session)).json()) as any[]).some(t => t.id === id)).toBe(false);
  });

  it("writes an append-only audit row with before/after assignees", async () => {
    const id = seedArea([fx.repA.memberId, fx.repB.memberId]);
    await req(`/api/territories/${id}/unassign`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repId: fx.repA.memberId }),
    });
    const row = rawDb.prepare(
      `SELECT action, before_json, after_json, outcome FROM admin_audit
        WHERE action='territory.rep_unassigned' AND target_id=? ORDER BY id DESC LIMIT 1`,
    ).get(String(id)) as any;
    expect(row).toBeTruthy();
    expect(row.outcome).toBe("success");
    expect(JSON.parse(row.before_json).repIds).toContain(fx.repA.memberId);
    expect(JSON.parse(row.after_json).repIds).not.toContain(fx.repA.memberId);
  });

  it("a TEAM LEAD can unassign their own rep - the route gate the UI must match", async () => {
    // assign_territory is team_lead+; the route is requireTeamLead + ownership.
    // This pins the server half of that contract so the UI gate can be checked
    // against a real number rather than an assumption.
    const id = seedArea([fx.repA.memberId, fx.repB.memberId]);
    const res = await req(`/api/territories/${id}/unassign`, fx.lead.session, {
      method: "POST", body: JSON.stringify({ repId: fx.repA.memberId }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse((storage.getTerritoryById(id) as any).assigneeIds)).toEqual([fx.repB.memberId]);
  });

  it("a rep cannot unassign anyone (not even themselves)", async () => {
    const id = seedArea([fx.repA.memberId, fx.repB.memberId]);
    for (const s of [fx.repA.session, fx.repB.session]) {
      expect((await req(`/api/territories/${id}/unassign`, s, {
        method: "POST", body: JSON.stringify({ repId: fx.repB.memberId }),
      })).status).toBe(403);
    }
  });

  it("refuses a rep from another organization without confirming they exist", async () => {
    const id = seedArea([fx.repA.memberId]);
    const res = await req(`/api/territories/${id}/unassign`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repId: fx.foreignRep.memberId }),
    });
    expect(res.status).toBe(404); // 404, not 403 — no existence oracle
  });

  it("404s on another organization's area", async () => {
    const foreignArea = seedArea([fx.foreignRep.memberId], 2);
    const res = await req(`/api/territories/${foreignArea}/unassign`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repId: fx.foreignRep.memberId }),
    });
    expect(res.status).toBe(404);
    // untouched
    expect(JSON.parse((storage.getTerritoryById(foreignArea) as any).assigneeIds)).toContain(fx.foreignRep.memberId);
  });

  it("409s when the rep is not on the area, and rejects a missing repId", async () => {
    const id = seedArea([fx.repA.memberId]);
    expect((await req(`/api/territories/${id}/unassign`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repId: fx.repB.memberId }),
    })).status).toBe(409);
    expect((await req(`/api/territories/${id}/unassign`, fx.manager.session, {
      method: "POST", body: JSON.stringify({}),
    })).status).toBe(400);
  });

  it("is idempotent under a double-tap: the second call 409s and changes nothing", async () => {
    const id = seedArea([fx.repA.memberId, fx.repB.memberId]);
    const body = JSON.stringify({ repId: fx.repA.memberId });
    const first = await req(`/api/territories/${id}/unassign`, fx.manager.session, { method: "POST", body });
    const second = await req(`/api/territories/${id}/unassign`, fx.manager.session, { method: "POST", body });
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(JSON.parse((storage.getTerritoryById(id) as any).assigneeIds)).toEqual([fx.repB.memberId]);
  });
});
