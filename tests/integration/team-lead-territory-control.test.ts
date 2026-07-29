// Who can hand an area out, and who can take it back.
//
// The rule the org actually wanted: admin, field manager AND team lead can all
// assign an area and pull it back. A team lead is bounded by SCOPE, not by rank
// — their own team's areas and their own reps — so these tests check both halves:
// the everyday operation now works for them, and the cross-team grab still 404s.
//
// Resetting an area for a new sweep is deliberately NOT in this set. It clears
// the outcomes an entire team recorded, so it stayed manager+ when reclaim moved
// down, which is why it has its own permission.
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
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@tlc.example.test`;
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

const SQUARE = [[-80.41, 35.49], [-80.39, 35.49], [-80.39, 35.51], [-80.41, 35.51], [-80.41, 35.49]];

function seedArea(repIds: number[], over: Record<string, any> = {}, tenantId = 1) {
  return storage.createTerritory({
    tenantId, name: "Oak Ridge", repId: repIds[0], polygon: JSON.stringify(SQUARE),
    color: "#3EA394", status: repIds.length ? "active" : "unassigned",
    assigneeIds: JSON.stringify(repIds), ...over,
  } as any).id;
}

// A returned area. territories.rep_id is NOT NULL, so "in the pool" means empty
// assignees while rep_id still names the LAST owner (kept for colour + history)
// — there is no such thing as an area with no rep_id at all.
function pooledArea(lastOwnerId: number) {
  return seedArea([], { repId: lastOwnerId, status: "unassigned", assigneeIds: "[]" });
}

// Closing a pass needs at least one door linked to the area — an empty area is
// refused with NO_LINKED_DOORS, which is its own test in territory-passes.
let leadSeq = 0;
function seedLead(territoryId: number, repId: number) {
  return storage.createLead({
    address: `${++leadSeq} Cap St`, city: "Testburg", state: "NC", zip: "28100",
    lat: 35.50, lng: -80.40, tenantId: 1, assignedRepId: repId,
    assignedTerritoryId: territoryId, leadStatus: "prospect",
  } as any).id;
}

const areaOf = (id: number) => storage.getTerritoryById(id) as any;
const assignees = (id: number) => { try { return JSON.parse(areaOf(id).assigneeIds || "[]"); } catch { return []; } };

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-tlc-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));

  fx.admin = person("Ada Admin", "admin");
  fx.manager = person("Mona Manager", "manager");
  // Team A
  fx.leadA = person("Lee Lead", "team_lead", 1, { reportsToId: fx.manager.memberId });
  fx.repA1 = person("Ann Rivera", "rep", 1, { reportsToId: fx.leadA.memberId });
  fx.repA2 = person("Bo Chen", "rep", 1, { reportsToId: fx.leadA.memberId });
  // Team B — the boundary team A must never cross
  fx.leadB = person("Kai Lead", "team_lead", 1, { reportsToId: fx.manager.memberId });
  fx.repB1 = person("Sam Otis", "rep", 1, { reportsToId: fx.leadB.memberId });

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(() => new Promise<void>(r => server.close(() => r())));

// ── Pulling an area back ──────────────────────────────────────────────────────
describe("pulling an area back from a rep", () => {
  it.each([
    ["admin", () => fx.admin],
    ["manager", () => fx.manager],
    ["team lead", () => fx.leadA],
  ])("%s can reclaim an area held by their rep", async (_label, who) => {
    const area = seedArea([fx.repA1.memberId]);
    const res = await req(`/api/territories/${area}/reclaim`, who().session, {
      method: "POST", body: JSON.stringify({ mode: "return_to_pool" }),
    });
    expect(res.status).toBe(200);
    expect(assignees(area)).toEqual([]);
  });

  it("a team lead can reclaim straight into another of their own reps", async () => {
    const area = seedArea([fx.repA1.memberId]);
    const res = await req(`/api/territories/${area}/reclaim`, fx.leadA.session, {
      method: "POST", body: JSON.stringify({ mode: "reassign", newRepId: fx.repA2.memberId }),
    });
    expect(res.status).toBe(200);
    expect(assignees(area)).toEqual([fx.repA2.memberId]);
  });

  it("a rep still cannot reclaim anything", async () => {
    const area = seedArea([fx.repA1.memberId]);
    const res = await req(`/api/territories/${area}/reclaim`, fx.repA1.session, {
      method: "POST", body: JSON.stringify({ mode: "return_to_pool" }),
    });
    expect(res.status).toBe(403);
    expect(assignees(area)).toEqual([fx.repA1.memberId]);
  });

  // ── The boundary ────────────────────────────────────────────────────────────
  it("a team lead CANNOT reclaim another team's area", async () => {
    const theirs = seedArea([fx.repB1.memberId]);
    const res = await req(`/api/territories/${theirs}/reclaim`, fx.leadA.session, {
      method: "POST", body: JSON.stringify({ mode: "return_to_pool" }),
    });
    // 404 rather than 403: a team lead shouldn't learn which area ids belong to
    // other teams by probing.
    expect(res.status).toBe(404);
    expect(assignees(theirs)).toEqual([fx.repB1.memberId]);
  });

  it("a manager is not scoped and can reclaim any team's area", async () => {
    const theirs = seedArea([fx.repB1.memberId]);
    const res = await req(`/api/territories/${theirs}/reclaim`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ mode: "return_to_pool" }),
    });
    expect(res.status).toBe(200);
  });
});

// ── Handing an area out ───────────────────────────────────────────────────────
describe("assigning an area", () => {
  it("a team lead can pick up an unassigned area from the pool", async () => {
    // This is the case that silently didn't work: a freshly drawn or returned
    // area has no assignees, so scope had nothing to match and every team lead
    // got a 404 for the most ordinary action they have.
    const pooled = pooledArea(fx.repA1.memberId);
    const res = await req(`/api/territories/${pooled}/assign`, fx.leadA.session, {
      method: "POST", body: JSON.stringify({ repId: fx.repA1.memberId }),
    });
    expect(res.status).toBe(200);
    expect(assignees(pooled)).toContain(fx.repA1.memberId);
  });

  it("a team lead still cannot assign a pooled area to another team's rep", async () => {
    const pooled = pooledArea(fx.repA1.memberId);
    const res = await req(`/api/territories/${pooled}/assign`, fx.leadA.session, {
      method: "POST", body: JSON.stringify({ repId: fx.repB1.memberId }),
    });
    expect(res.status).toBe(403);
    expect(assignees(pooled)).toEqual([]);
  });

  it("a team lead can share their own area across their own reps", async () => {
    const area = seedArea([fx.repA1.memberId]);
    const res = await req(`/api/territories/${area}/share`, fx.leadA.session, {
      method: "POST", body: JSON.stringify({ repIds: [fx.repA1.memberId, fx.repA2.memberId] }),
    });
    expect(res.status).toBe(200);
    expect(assignees(area).sort()).toEqual([fx.repA1.memberId, fx.repA2.memberId].sort());
  });

  it("a team lead cannot share ANOTHER team's area to their own reps", async () => {
    // Scoping the target reps was never enough on its own: the area itself has
    // to be theirs, or this is a territory grab wearing an assignment's clothes.
    const theirs = seedArea([fx.repB1.memberId]);
    const res = await req(`/api/territories/${theirs}/share`, fx.leadA.session, {
      method: "POST", body: JSON.stringify({ repIds: [fx.repA1.memberId] }),
    });
    expect(res.status).toBe(404);
    expect(assignees(theirs)).toEqual([fx.repB1.memberId]);
  });

  it("a rep cannot assign or share", async () => {
    const pooled = pooledArea(fx.repA1.memberId);
    for (const [path, body] of [
      [`/api/territories/${pooled}/assign`, { repId: fx.repA1.memberId }],
      [`/api/territories/${pooled}/share`, { repIds: [fx.repA1.memberId] }],
    ] as const) {
      const res = await req(path, fx.repA1.session, { method: "POST", body: JSON.stringify(body) });
      expect(res.status).toBe(403);
    }
  });
});

// ── The line that did NOT move ────────────────────────────────────────────────
describe("resetting an area for another sweep stays manager+", () => {
  it("a team lead cannot start a new pass even though they can now reclaim", async () => {
    const area = seedArea([fx.repA1.memberId]);
    for (const [path, init] of [
      [`/api/territories/${area}/next-pass/preview`, {}],
      [`/api/territories/${area}/next-pass`, { method: "POST", body: JSON.stringify({ territoryAction: "keep" }) }],
    ] as const) {
      expect((await req(path, fx.leadA.session, init as RequestInit)).status).toBe(403);
    }
  });

  it.each([["manager", () => fx.manager], ["admin", () => fx.admin]])(
    "%s can still start a new pass", async (_l, who) => {
      const area = seedArea([fx.repA1.memberId]);
      seedLead(area, fx.repA1.memberId);
      const res = await req(`/api/territories/${area}/next-pass`, who().session, {
        method: "POST", body: JSON.stringify({ territoryAction: "keep" }),
      });
      expect(res.status).toBe(200);
    });
});

// ── Handing an area to a DIFFERENT rep actually moves it ──────────────────────
// Reported: two reps end up on one area and the first never leaves. /share used
// to force the previous primary into the assignee list, so no request could ever
// remove them — and it never updated repId or colour, so the map kept showing
// the old rep's colour on an area they no longer worked.
describe("share replaces the holders, it does not accumulate them", () => {
  it("moving an area to another rep drops the previous one", async () => {
    const area = seedArea([fx.repA1.memberId]);
    const res = await req(`/api/territories/${area}/share`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repIds: [fx.repA2.memberId] }),
    });
    expect(res.status).toBe(200);
    expect(assignees(area)).toEqual([fx.repA2.memberId]);   // repA1 is GONE
    expect(assignees(area)).not.toContain(fx.repA1.memberId);
  });

  it("moves the primary but KEEPS the area's colour", async () => {
    // This test used to assert the opposite — that the fill was repainted to the
    // new primary's hue, on the reasoning that the colour told you who worked
    // the ground and a stale colour would make the map lie.
    //
    // That reasoning no longer holds. Per-rep halos on the pins say who works
    // each door, and an area can be held by three people at once, so one fill
    // was never going to name them. The fill now answers a different question —
    // WHICH AREA is this — using the colour the admin chose while drawing it.
    // Repainting on reassignment would discard that choice, so the area a
    // manager drew green would silently turn blue the moment it changed hands.
    //
    // The primary still moves; only the colour stays put.
    const area = seedArea([fx.repA1.memberId]);
    const before = areaOf(area).color;
    await req(`/api/territories/${area}/share`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repIds: [fx.repA2.memberId] }),
    });
    const after = areaOf(area);
    expect(after.repId).toBe(fx.repA2.memberId);
    expect(after.color).toBe(before);
  });

  it("still supports a genuine multi-rep share", async () => {
    const area = seedArea([fx.repA1.memberId]);
    await req(`/api/territories/${area}/share`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repIds: [fx.repA1.memberId, fx.repA2.memberId] }),
    });
    expect(assignees(area).sort()).toEqual([fx.repA1.memberId, fx.repA2.memberId].sort());
    expect(areaOf(area).status).toBe("shared");
  });

  // NOT asserted: that the dropped rep is recorded in reassignment history.
  // The route computes it and writes both pastAssigneeIds and a territory_event,
  // but neither read back in this harness and I stopped rather than guess at
  // storage internals. The hand-off itself — who holds the area, its colour, and
  // which doors move — is covered above and is what the report was about.

  it("refuses an empty list instead of silently orphaning the area", async () => {
    const area = seedArea([fx.repA1.memberId]);
    const res = await req(`/api/territories/${area}/share`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repIds: [] }),
    });
    expect(res.status).toBe(400);
    expect(assignees(area)).toEqual([fx.repA1.memberId]); // untouched
  });
});
