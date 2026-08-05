// A rep reading their OWN area's numbers, by id.
//
// GET /api/territories/:id/progress is the addressable form of the progress
// card: one area's penetration/completion stats, computed by the same code as
// the list route. The access rule is the one every territory read surface uses
// (territoryHeldByAny over assignee_ids, repId only as legacy fallback):
//
//   • rep        → 200 for an area they hold, 404 for everything else
//   • team_lead  → 200 for their team's areas, 404 for a rival team's
//   • manager+   → any area in their tenant, never another tenant's
//
// Denials are 404, never 403, so the response cannot confirm that an area id
// exists in someone else's book.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];

type Person = { userId: number; memberId: number; session: string };
const fx: Record<string, Person> = {};

function person(name: string, role: string, tenantId = 1, opts: { reportsToId?: number | null } = {}): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@per-area-progress.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId, reportsToId: opts.reportsToId ?? null } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...(init.headers ?? {}) },
  });
}

// Disjoint patches — progress is point-in-polygon, so each area needs its own
// ground or the counts bleed into each other (see territory-progress-scope).
function square(west: number, south: number): number[][] {
  const e = west + 0.02, n = south + 0.02;
  return [[west, south], [e, south], [e, n], [west, n], [west, south]];
}
const PATCH = {
  mine: [-81.41, 34.49] as const,
  other: [-81.31, 34.59] as const,
  rival: [-81.21, 34.69] as const,
  foreign: [-81.11, 34.79] as const,
};

function seedArea(name: string, repIds: number[], patch: readonly [number, number], tenantId = 1) {
  return storage.createTerritory({
    tenantId, name, repId: repIds[0] ?? null, polygon: JSON.stringify(square(patch[0], patch[1])),
    color: "#3EA394", status: repIds.length > 1 ? "shared" : "active",
    assigneeIds: JSON.stringify(repIds),
  } as any).id;
}

function seedLead(territoryId: number, n: number, patch: readonly [number, number], tenantId = 1, repId: number | null = null) {
  return storage.createLead({
    address: `${n} PerArea St`, city: "Testburg", state: "NC", zip: "28100",
    lat: patch[1] + 0.01, lng: patch[0] + 0.01, tenantId,
    assignedTerritoryId: territoryId, assignedRepId: repId, leadStatus: "prospect",
  } as any).id;
}

let mineArea = 0;      // held by repA
let otherArea = 0;     // held by repB (same team) — repA must NOT read it
let rivalArea = 0;     // held by a rep on another team — the lead must NOT read it
let foreignArea = 0;   // tenant 2 — nobody in tenant 1 may read it

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-per-area-progress-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;

  fx.manager = person("Mona Manager", "manager");
  fx.lead = person("Lee Lead", "team_lead", 1, { reportsToId: fx.manager.memberId });
  fx.repA = person("Rep Ann", "rep", 1, { reportsToId: fx.lead.memberId });
  fx.repB = person("Rep Bo", "rep", 1, { reportsToId: fx.lead.memberId });
  // A rep on a DIFFERENT team (reports straight to the manager, not to Lee).
  fx.rival = person("Rhea Rival", "rep", 1, { reportsToId: fx.manager.memberId });

  storage.createTenant({ slug: "other-progress", companyName: "Other", ownerName: "O", ownerEmail: "o@other-progress.test", brandName: "Other", brandColor: "#111", plan: "trial", status: "active" } as any);
  fx.foreignRep = person("Rep Zed", "rep", 2);

  mineArea = seedArea("Ann's patch", [fx.repA.memberId], PATCH.mine);
  otherArea = seedArea("Bo's patch", [fx.repB.memberId], PATCH.other);
  rivalArea = seedArea("Rival patch", [fx.rival.memberId], PATCH.rival);
  foreignArea = seedArea("Foreign patch", [fx.foreignRep.memberId], PATCH.foreign, 2);

  for (let i = 0; i < 4; i++) seedLead(mineArea, 100 + i, PATCH.mine, 1, fx.repA.memberId);
  for (let i = 0; i < 2; i++) seedLead(otherArea, 200 + i, PATCH.other, 1, fx.repB.memberId);
  seedLead(foreignArea, 300, PATCH.foreign, 2, fx.foreignRep.memberId);

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

describe("GET /api/territories/:id/progress — rep reads their own area", () => {
  it("returns 200 with the penetration/completion stats for an area the rep holds", async () => {
    const r = await req(`/api/territories/${mineArea}/progress`, fx.repA.session);
    expect(r.status).toBe(200);
    const row = await r.json() as any;
    expect(row.id).toBe(mineArea);
    expect(row.total).toBe(4);
    // The operational rates the card exists to show. Presence AND type — a
    // route that dropped the metrics block would still have returned an id.
    expect(typeof row.penetrationRate).toBe("number");
    expect(typeof row.knockCompletionRate).toBe("number");
    expect(typeof row.contactRate).toBe("number");
    expect(typeof row.availableBase).toBe("number");
    expect(typeof row.areaWorkedPct).toBe("number");
    expect(typeof row.knocked).toBe("number");
  });

  it("matches the list route's numbers for the same area, field for field", async () => {
    // Same computation is the contract — the single-area card and the overview
    // must never disagree about the same ground. The single-area read carries
    // console-only EXTRAS on top (polygon, briefing, lifecycle stamps) that the
    // list deliberately omits for payload, so the assertion is "every field the
    // list has, the single read has with the same value" — a superset, never a
    // divergence.
    const one = await (await req(`/api/territories/${mineArea}/progress`, fx.repA.session)).json() as any;
    const list = await (await req("/api/territories/progress", fx.repA.session)).json() as any[];
    expect(one).toMatchObject(list.find((r) => r.id === mineArea));
    // And the console extras are genuinely present on the single read.
    expect(Array.isArray(one.polygon)).toBe(true);
  });
});

describe("GET /api/territories/:id/progress — everything else is a 404", () => {
  it("404s a rep asking about a teammate's area", async () => {
    const r = await req(`/api/territories/${otherArea}/progress`, fx.repA.session);
    expect(r.status).toBe(404);
  });

  it("404s a rep asking about another tenant's area — existence not confirmed", async () => {
    const r = await req(`/api/territories/${foreignArea}/progress`, fx.repA.session);
    expect(r.status).toBe(404);
    // Identical shape to the not-held denial: nothing distinguishes "not
    // yours" from "not real", so ids cannot be probed across tenants.
    expect(await r.json()).toEqual({ error: "Not found" });
  });

  it("404s an id that does not exist at all", async () => {
    const r = await req(`/api/territories/999999/progress`, fx.repA.session);
    expect(r.status).toBe(404);
  });

  it("404s a team lead on a rival team's area, but 200s their own team's", async () => {
    expect((await req(`/api/territories/${rivalArea}/progress`, fx.lead.session)).status).toBe(404);
    expect((await req(`/api/territories/${otherArea}/progress`, fx.lead.session)).status).toBe(200);
  });
});

describe("manager behavior is unchanged", () => {
  it("a manager reads any area in their tenant by id", async () => {
    for (const id of [mineArea, otherArea, rivalArea]) {
      const r = await req(`/api/territories/${id}/progress`, fx.manager.session);
      expect(r.status).toBe(200);
      expect(((await r.json()) as any).id).toBe(id);
    }
  });

  it("a manager cannot read another tenant's area", async () => {
    expect((await req(`/api/territories/${foreignArea}/progress`, fx.manager.session)).status).toBe(404);
  });

  it("the list route still serves the manager the whole org", async () => {
    const rows = await (await req("/api/territories/progress", fx.manager.session)).json() as any[];
    const ids = rows.map((r) => r.id);
    for (const id of [mineArea, otherArea, rivalArea]) expect(ids).toContain(id);
    expect(ids).not.toContain(foreignArea);
  });
});
