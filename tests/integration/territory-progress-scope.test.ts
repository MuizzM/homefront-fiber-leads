// Who gets to see an area's numbers.
//
// GET /api/territories/progress is what feeds the area cards a rep reads before
// they start walking — how many doors are left, how much of the area is done.
// Areas became many-to-many when shared territories shipped (assignee_ids), and
// storage.getTerritoriesByRep already encodes the rule that came with them:
//
//   "A rep sees a territory if they're the primary repId OR in assignee_ids."
//
// The progress endpoint did not use that rule. It matched on territory.repId
// alone, which names only the PRIMARY holder — so the second and third rep on a
// shared area got an empty list and no numbers for an area they are actively
// working. These tests pin the rule at the endpoint, in both directions: the
// sharer must see it, and someone removed from it must not.
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
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@progress-scope.example.test`;
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

// Progress is computed by point-in-polygon, so every area needs its OWN patch of
// ground and every door must sit inside exactly one of them. Sharing a polygon
// between two areas makes each one count the other's doors, which silently
// inflates the totals — the first draft of this file did that and read 6 where
// it should have read 4.
function square(west: number, south: number): number[][] {
  const e = west + 0.02, n = south + 0.02;
  return [[west, south], [e, south], [e, n], [west, n], [west, south]];
}
function centreOf(west: number, south: number): { lat: number; lng: number } {
  return { lat: south + 0.01, lng: west + 0.01 };
}

// Disjoint patches, one per area, far enough apart that no door is ambiguous.
const PATCH = { shared: [-80.41, 35.49] as const, solo: [-80.31, 35.59] as const, handover: [-80.21, 35.69] as const, access: [-80.11, 35.79] as const };

function seedArea(name: string, repIds: number[], patch: readonly [number, number], tenantId = 1) {
  return storage.createTerritory({
    tenantId, name, repId: repIds[0] ?? null, polygon: JSON.stringify(square(patch[0], patch[1])),
    color: "#3EA394", status: repIds.length > 1 ? "shared" : "active",
    assigneeIds: JSON.stringify(repIds),
  } as any).id;
}

function seedLead(territoryId: number, n: number, patch: readonly [number, number], tenantId = 1) {
  const { lat, lng } = centreOf(patch[0], patch[1]);
  return storage.createLead({
    address: `${n} Progress St`, city: "Testburg", state: "NC", zip: "28100",
    lat, lng, tenantId, assignedTerritoryId: territoryId, leadStatus: "prospect",
  } as any).id;
}

let sharedArea = 0;
let soloArea = 0;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-progress-scope-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;

  fx.manager = person("Mona Manager", "manager");
  fx.lead = person("Lee Lead", "team_lead", 1, { reportsToId: fx.manager.memberId });
  fx.primary = person("Pat Primary", "rep", 1, { reportsToId: fx.lead.memberId });
  fx.sharer = person("Sam Sharer", "rep", 1, { reportsToId: fx.lead.memberId });
  fx.outsider = person("Otto Outside", "rep", 1, { reportsToId: fx.lead.memberId });

  // Pat is primary, Sam shares. Both are genuinely working this area.
  sharedArea = seedArea("Shared patch", [fx.primary.memberId, fx.sharer.memberId], PATCH.shared);
  // An area only Pat holds — proves the sharer's visibility is not just "sees everything".
  soloArea = seedArea("Pat only", [fx.primary.memberId], PATCH.solo);

  for (let i = 0; i < 4; i++) seedLead(sharedArea, 100 + i, PATCH.shared);
  for (let i = 0; i < 2; i++) seedLead(soloArea, 200 + i, PATCH.solo);

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

async function progressFor(session: string): Promise<any[]> {
  const response = await req("/api/territories/progress", session);
  expect(response.status).toBe(200);
  return (await response.json()) as any[];
}

describe("area progress is scoped by who actually works the area", () => {
  it("shows the PRIMARY holder both of their areas", () => {
    // Control: if this ever breaks, the sharer assertions below prove nothing.
    return progressFor(fx.primary.session).then((rows) => {
      expect(rows.map((r) => r.id).sort()).toEqual([sharedArea, soloArea].sort());
    });
  });

  it("shows a SHARED area to the rep who is not the primary holder", async () => {
    // The bug: repId names only Pat, so Sam saw nothing for an area they work.
    const rows = await progressFor(fx.sharer.session);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(sharedArea);
  });

  it("does not hand the sharer an area they were never on", async () => {
    // The other half — the fix must not degrade into "reps see everything".
    const rows = await progressFor(fx.sharer.session);
    expect(rows.map((r) => r.id)).not.toContain(soloArea);
  });

  it("counts the doors inside the shared area, not zero", async () => {
    // Visibility without numbers would still be a broken card.
    const rows = await progressFor(fx.sharer.session);
    const area = rows.find((r) => r.id === sharedArea);
    expect(area).toBeDefined();
    expect(area.total).toBe(4);
  });

  it("gives an unrelated rep nothing", async () => {
    const rows = await progressFor(fx.outsider.session);
    expect(rows).toEqual([]);
  });

  it("gives the team lead both areas their reports work", async () => {
    const rows = await progressFor(fx.lead.session);
    expect(rows.map((r) => r.id).sort()).toEqual([sharedArea, soloArea].sort());
  });

  it("gives the manager the whole org", async () => {
    const rows = await progressFor(fx.manager.session);
    expect(rows.map((r) => r.id).sort()).toEqual([sharedArea, soloArea].sort());
  });
});

describe("removal takes LEAD access away, not just the card", () => {
  it("404s a door inside an area the rep was removed from", async () => {
    // Same rule, the other endpoint. repCanAccessLead falls back to the caller's
    // territories, and that lookup checked repId BEFORE assignee_ids — so the
    // column that deliberately still names the last holder was granting access
    // to ground that had been taken away. Removing a rep has to remove the
    // doors, or "reclaim" is only a label.
    const area = seedArea("Access patch", [fx.outsider.memberId], PATCH.access);
    const doorId = seedLead(area, 400, PATCH.access);

    const before = await req(`/api/leads/${doorId}`, fx.outsider.session);
    expect(before.status).toBe(200); // control — they really did hold it

    storage.updateTerritory(area, { assigneeIds: JSON.stringify([]), status: "unassigned" } as any);

    const after = await req(`/api/leads/${doorId}`, fx.outsider.session);
    expect(after.status).toBe(404);
  });
});

describe("removal takes the numbers away too", () => {
  it("stops showing an area to a rep who has been taken off it", async () => {
    // repId deliberately still names the last holder after everyone is removed
    // (it drives colour and history), so an endpoint keying on repId keeps
    // showing a reclaimed area to the person it was taken from. assignee_ids is
    // what reclaim rewrites, and it is what visibility must follow.
    const area = seedArea("Handover patch", [fx.outsider.memberId], PATCH.handover);
    seedLead(area, 300, PATCH.handover);
    expect((await progressFor(fx.outsider.session)).map((r) => r.id)).toContain(area);

    // Take them off, the way reclaim does: empty the assignee list, leave repId.
    storage.updateTerritory(area, { assigneeIds: JSON.stringify([]), status: "unassigned" } as any);

    expect((await progressFor(fx.outsider.session)).map((r) => r.id)).not.toContain(area);
  });
});

describe("GET /api/territories is scoped like every other territory surface", () => {
  it("a team_lead sees only their team's areas, never a rival team's", async () => {
    // A rep who does NOT report to Lee Lead — a different team's ground.
    const rival = person("Rhea Rival", "rep", 1, { reportsToId: fx.manager.memberId });
    const rivalArea = seedArea("Rival team patch", [rival.memberId], [-80.01, 35.89]);
    const ownArea = seedArea("Lee's own patch", [fx.primary.memberId], [-79.91, 35.99]);

    const asManager = await (await req("/api/territories", fx.manager.session)).json() as any[];
    const asLead = await (await req("/api/territories", fx.lead.session)).json() as any[];

    // Manager (org-wide) sees the rival area…
    expect(asManager.map(t => t.id)).toContain(rivalArea);
    // …the team_lead does NOT (the leak this fix closes)…
    expect(asLead.map(t => t.id)).not.toContain(rivalArea);
    // …but still sees an area their own team holds.
    expect(asLead.map(t => t.id)).toContain(ownArea);
  });
});
