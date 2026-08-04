// ── Deleting an area cleans up everything the area was holding together ──────
//
// THE BUG: draw a polygon, assign it to Talal, delete the polygon. The area
// disappeared from the Area tab — and every door inside it stayed assigned to
// Talal, still on his dialing list, still counting toward his stats, still
// behaving as if the area existed. The old delete cleared assigned_territory_id
// and deliberately KEPT the rep, so the grant outlived the thing that granted it.
//
// These tests are written against what a rep and a manager can SEE, not just
// against a column, because "the column changed" is what the old code could also
// have claimed. Deleting an area must leave no residue in:
//
//   · the door's own row (area link AND the rep the area granted)
//   · the REP'S VIEW — /api/leads, /api/leads/map, the knock sheet read
//   · the assignment ledger (territory_assignments, append-only, was left open)
//   · the Area's dialing list / skip-trace run
//
// The keep/clear choice is explicit and both branches are pinned here, because a
// default nobody tests is a default that quietly becomes the other one.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { areaGrantedRepIds, planAreaDeleteLeads } from "../../shared/territory";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

type Person = { userId: number; memberId: number; session: string };
const fx: Record<string, Person> = {};

function person(name: string, role: string, tenantId = 1, opts: { reportsToId?: number | null } = {}): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@areadelete.example.test`;
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

function seedArea(repIds: number[], tenantId = 1, over: Record<string, unknown> = {}) {
  return storage.createTerritory({
    tenantId, name: "Maple Ridge", repId: repIds[0] ?? null, polygon: JSON.stringify(SQUARE),
    color: "#3EA394", status: repIds.length > 1 ? "shared" : "active",
    assigneeIds: JSON.stringify(repIds), ...over,
  } as any).id;
}

/** A door linked to the area the way every area path links one. */
function seedLead(repId: number | null, territoryId: number | null, over: Record<string, unknown> = {}) {
  return storage.createLead({
    address: `${Math.floor(Math.random() * 9_000_000) + 100} Ridge St`, city: "Testburg", state: "NC", zip: "28100",
    lat: 35.50, lng: -80.40, tenantId: 1,
    assignedRepId: repId, assignedTerritoryId: territoryId,
    assignmentSource: repId != null ? "territory-sync" : null,
    assignedBy: repId != null ? "Mona Manager" : null,
    assignedAt: repId != null ? new Date().toISOString() : null,
    leadStatus: "prospect",
  } as any).id;
}

/** GET /api/leads is a page envelope; the map is `{ pins }`. Both are "what
 *  this rep can see", which is what these tests are actually about. */
async function leadsVisibleTo(session: string): Promise<number[]> {
  const body = await (await req("/api/leads", session)).json() as { leads: Array<{ id: number }> };
  return body.leads.map(l => l.id);
}
async function pinsVisibleTo(session: string): Promise<number[]> {
  const body = await (await req("/api/leads/map", session)).json() as { pins: Array<{ id: number }> };
  return body.pins.map(p => p.id);
}

const leadRow = (id: number) => rawDb.prepare(
  `SELECT assigned_rep_id AS repId, assigned_territory_id AS areaId, assignment_source AS source,
          assigned_by AS assignedBy, assigned_at AS assignedAt, unassigned_at AS unassignedAt
     FROM leads WHERE id = ?`).get(id) as any;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-area-delete-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));

  fx.admin = person("Ada Admin", "admin");
  fx.manager = person("Mona Manager", "manager");
  fx.talal = person("Talal Rep", "rep", 1, { reportsToId: fx.manager.memberId });
  fx.bo = person("Bo Rivera", "rep", 1, { reportsToId: fx.manager.memberId });

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

describe("DELETE /api/territories/:id — the reported bug", () => {
  it("THE REQUIREMENT: after deleting Talal's area, his doors are not his and not the area's", async () => {
    const areaId = seedArea([fx.talal.memberId]);
    const doors = [seedLead(fx.talal.memberId, areaId), seedLead(fx.talal.memberId, areaId)];

    // Up front, Talal sees both doors — in his list and on his map.
    expect((await leadsVisibleTo(fx.talal.session)).filter(id => doors.includes(id))).toHaveLength(2);
    expect((await pinsVisibleTo(fx.talal.session)).filter(id => doors.includes(id))).toHaveLength(2);

    const res = await req(`/api/territories/${areaId}`, fx.admin.session, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true, detached: 2, repAssignments: "clear", repCleared: 2,
      clearedRepNames: ["Talal Rep"],
    });

    for (const id of doors) {
      const row = leadRow(id);
      expect(row.areaId).toBeNull();   // not the area's…
      expect(row.repId).toBeNull();    // …and not Talal's
      // The paperwork that described the assignment goes with it, or the Leads
      // table prints "Territory sync" under an empty owner.
      expect(row.source).toBeNull();
      expect(row.assignedBy).toBeNull();
      expect(row.assignedAt).toBeNull();
      expect(row.unassignedAt).not.toBeNull();
    }

    // And the consequence a rep actually experiences: they are gone from his app.
    expect((await leadsVisibleTo(fx.talal.session)).filter(id => doors.includes(id))).toHaveLength(0);
    expect((await pinsVisibleTo(fx.talal.session)).filter(id => doors.includes(id))).toHaveLength(0);
    // The knock sheet reads one lead at a time; a door he cannot work must not
    // open for him either.
    expect((await req(`/api/leads/${doors[0]}`, fx.talal.session)).status).toBe(404);
  });

  it("the area is gone from the Area tab, and its console 404s", async () => {
    const areaId = seedArea([fx.talal.memberId]);
    seedLead(fx.talal.memberId, areaId);
    await req(`/api/territories/${areaId}`, fx.admin.session, { method: "DELETE" });

    const list = await (await req("/api/territories", fx.manager.session)).json() as any[];
    expect(list.some(t => t.id === areaId)).toBe(false);
    const progress = await (await req("/api/territories/progress", fx.manager.session)).json() as any[];
    expect(progress.some(r => r.id === areaId)).toBe(false);
    expect(storage.getTerritoryById(areaId)).toBeUndefined();
  });

  it("a door handed DIRECTLY to a rep who never held this area ALSO loses its rep", async () => {
    // One rule, no exceptions: deleting an area unassigns everything on that
    // ground. Whether the rep came via the area or straight from a manager is a
    // distinction the person deleting it cannot see.
    const areaId = seedArea([fx.talal.memberId]);
    const areaDoor = seedLead(fx.talal.memberId, areaId);
    const directDoor = seedLead(fx.bo.memberId, areaId, {});
    rawDb.prepare("UPDATE leads SET assignment_source='manual' WHERE id=?").run(directDoor);

    const body = await (await req(`/api/territories/${areaId}`, fx.admin.session, { method: "DELETE" })).json() as any;
    expect(body.repCleared).toBe(2);
    expect([...body.clearedRepNames].sort()).toEqual(["Bo Rivera", "Talal Rep"]);

    expect(leadRow(areaDoor).repId).toBeNull();
    expect(leadRow(directDoor).repId).toBeNull();
    expect(leadRow(directDoor).areaId).toBeNull();
    expect(leadRow(directDoor).source).toBeNull();
  });

  it("clears a PAST holder's doors — a keep_leads reclaim empties the list while the doors still name the rep", async () => {
    const areaId = seedArea([], 1, {
      repId: fx.talal.memberId, assigneeIds: "[]",
      pastAssigneeIds: JSON.stringify([fx.talal.memberId]), status: "reclaimed",
    });
    const door = seedLead(fx.talal.memberId, areaId);

    const body = await (await req(`/api/territories/${areaId}`, fx.admin.session, { method: "DELETE" })).json() as any;
    expect(body.repCleared).toBe(1);
    expect(leadRow(door).repId).toBeNull();
  });

  it("?repAssignments=keep is the documented escape hatch and really does keep them", async () => {
    const areaId = seedArea([fx.talal.memberId]);
    const door = seedLead(fx.talal.memberId, areaId);

    const res = await req(`/api/territories/${areaId}?repAssignments=keep`, fx.admin.session, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ detached: 1, repAssignments: "keep", repCleared: 0, clearedRepNames: [] });

    const row = leadRow(door);
    expect(row.areaId).toBeNull();                    // the area link ALWAYS goes
    expect(row.repId).toBe(fx.talal.memberId);        // the rep, only on request
    expect(row.source).toBe("territory-sync");
    // He can still see it — that is what he asked for.
    expect(await leadsVisibleTo(fx.talal.session)).toContain(door);
  });

  it("an unrecognised policy is a 400 and changes NOTHING — a typo must not mass-unassign", async () => {
    const areaId = seedArea([fx.talal.memberId]);
    const door = seedLead(fx.talal.memberId, areaId);

    const res = await req(`/api/territories/${areaId}?repAssignments=keeep`, fx.admin.session, { method: "DELETE" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("BAD_REP_POLICY");
    expect(leadRow(door)).toMatchObject({ repId: fx.talal.memberId, areaId });
    expect(storage.getTerritoryById(areaId)).toBeTruthy();
  });

  it("clears every holder of a SHARED area, and names them all", async () => {
    const areaId = seedArea([fx.talal.memberId, fx.bo.memberId]);
    const t = seedLead(fx.talal.memberId, areaId);
    const b = seedLead(fx.bo.memberId, areaId);

    const body = await (await req(`/api/territories/${areaId}`, fx.admin.session, { method: "DELETE" })).json() as any;
    expect(body.repCleared).toBe(2);
    expect([...body.clearedRepNames].sort()).toEqual(["Bo Rivera", "Talal Rep"]);
    expect(leadRow(t).repId).toBeNull();
    expect(leadRow(b).repId).toBeNull();
  });

  it("an empty area deletes cleanly and reports zeroes", async () => {
    const areaId = seedArea([fx.talal.memberId]);
    const body = await (await req(`/api/territories/${areaId}`, fx.admin.session, { method: "DELETE" })).json() as any;
    expect(body).toMatchObject({ success: true, detached: 0, repCleared: 0, clearedRepNames: [] });
  });
});

describe("no orphaned area references survive the delete", () => {
  it("closes every OPEN row in the append-only assignment ledger", async () => {
    // territory_assignments is a second store of "who holds this area" and rows
    // are never deleted. Deleting the territory used to leave the assignment
    // open forever: the record said a rep still held ground that did not exist.
    const areaId = seedArea([fx.talal.memberId]);
    seedLead(fx.talal.memberId, areaId);
    const openBefore = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM territory_assignments WHERE territory_id=? AND unassigned_at IS NULL`).get(areaId) as any;
    expect(openBefore.n).toBeGreaterThan(0);

    await req(`/api/territories/${areaId}`, fx.admin.session, { method: "DELETE" });

    const openAfter = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM territory_assignments WHERE territory_id=? AND unassigned_at IS NULL`).get(areaId) as any;
    expect(openAfter.n).toBe(0);
    // Closed, not erased — the record of who worked this ground outlives it.
    const closed = rawDb.prepare(
      `SELECT reason FROM territory_assignments WHERE territory_id=? AND rep_id=?`).get(areaId, fx.talal.memberId) as any;
    expect(closed?.reason).toBe("area deleted");
  });

  it("closes an in-flight skip-trace run instead of leaving it 'running' forever", async () => {
    const areaId = seedArea([fx.talal.memberId]);
    seedLead(fx.talal.memberId, areaId);
    rawDb.prepare(`INSERT INTO area_skip_trace_runs (id,tenant_id,territory_id,status,requested_by,eligible_leads)
                   VALUES (?,?,?,'running',?,1)`).run("11111111-1111-4111-8111-111111111111", 1, areaId, fx.admin.userId);

    await req(`/api/territories/${areaId}`, fx.admin.session, { method: "DELETE" });

    const run = rawDb.prepare(`SELECT status, error_code AS code, finished_at AS finishedAt
                                 FROM area_skip_trace_runs WHERE territory_id=?`).get(areaId) as any;
    expect(run.status).toBe("failed");
    expect(run.code).toBe("AREA_DELETED");
    expect(run.finishedAt).not.toBeNull();
  });

  it("the Area's dialing list and skip-trace console 404 rather than serving a ghost", async () => {
    const areaId = seedArea([fx.talal.memberId]);
    seedLead(fx.talal.memberId, areaId);
    await req(`/api/territories/${areaId}`, fx.admin.session, { method: "DELETE" });

    expect((await req(`/api/areas/${areaId}/dialing-list`, fx.admin.session)).status).toBe(404);
    expect((await req(`/api/areas/${areaId}/tracerfy-run`, fx.admin.session)).status).toBe(404);
  });

  it("leaves NO lead anywhere pointing at the deleted area", async () => {
    const areaId = seedArea([fx.talal.memberId]);
    seedLead(fx.talal.memberId, areaId);
    seedLead(fx.bo.memberId, areaId);
    seedLead(null, areaId);
    await req(`/api/territories/${areaId}`, fx.admin.session, { method: "DELETE" });

    const orphans = rawDb.prepare(`SELECT COUNT(*) AS n FROM leads WHERE assigned_territory_id = ?`).get(areaId) as any;
    expect(orphans.n).toBe(0);
    // …and the global invariant the migration exists to enforce still holds.
    const anyGhost = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM leads
        WHERE assigned_territory_id IS NOT NULL
          AND assigned_territory_id NOT IN (SELECT id FROM territories)`).get() as any;
    expect(anyGhost.n).toBe(0);
  });

  it("writes an audit row a manager can read afterwards", async () => {
    const areaId = seedArea([fx.talal.memberId]);
    seedLead(fx.talal.memberId, areaId);
    await req(`/api/territories/${areaId}`, fx.admin.session, { method: "DELETE" });

    const row = rawDb.prepare(
      `SELECT before_json, after_json, outcome, target_label FROM admin_audit
        WHERE action='territory.deleted' AND target_id=? ORDER BY id DESC LIMIT 1`).get(String(areaId)) as any;
    expect(row).toBeTruthy();
    expect(row.outcome).toBe("success");
    expect(row.target_label).toBe("Maple Ridge");
    const after = JSON.parse(row.after_json);
    expect(after).toMatchObject({ repAssignments: "clear", detached: 1, repCleared: 1 });
    expect(after.repIdsCleared).toEqual([fx.talal.memberId]);
    expect(after.assignmentsClosed).toEqual([fx.talal.memberId]);
  });
});

describe("the SQL and the pure rule agree", () => {
  // shared/territory states the rule in TypeScript; scanIntelStore states it in
  // SQL. Two encodings that can drift are worse than one that is incomplete, so
  // this runs both over the same fixture and compares.
  it("planAreaDeleteLeads predicts exactly what the endpoint writes", async () => {
    const areaId = seedArea([fx.talal.memberId, fx.bo.memberId]);
    const doors = [
      { id: seedLead(fx.talal.memberId, areaId), rep: fx.talal.memberId },
      { id: seedLead(fx.bo.memberId, areaId), rep: fx.bo.memberId },
      { id: seedLead(null, areaId), rep: null },
      // An outsider who never held this area, assigned directly.
      { id: seedLead(fx.manager.memberId, areaId), rep: fx.manager.memberId },
    ];

    const predicted = planAreaDeleteLeads(doors.map(d => ({ id: d.id, assignedRepId: d.rep })));
    // The area's own holder list is NOT an input to the rule — it only feeds the
    // audit row — so a holder set and the outcome are independent.
    expect(areaGrantedRepIds(storage.getTerritoryById(areaId) as any))
      .toEqual([fx.talal.memberId, fx.bo.memberId]);

    await req(`/api/territories/${areaId}`, fx.admin.session, { method: "DELETE" });

    for (const p of predicted.leads) {
      expect(leadRow(p.id).repId).toBe(p.assignedRepId);
    }
    expect(predicted.repCleared).toBe(3);
    expect(predicted.leads.every(l => l.assignedRepId === null)).toBe(true);
  });
});

// ── Multi-rep areas: create with a crew, remove one from the Area tab ────────
describe("an area is created with a CREW, not one rep", () => {
  const SQUARE_BODY = [[-80.41, 35.49], [-80.39, 35.49], [-80.39, 35.51], [-80.41, 35.51]];

  async function drawArea(session: string, body: Record<string, unknown>) {
    const res = await req("/api/territories/assign-area", session, {
      method: "POST", body: JSON.stringify({ polygon: SQUARE_BODY, ...body }),
    });
    return { status: res.status, body: await res.json() as any };
  }

  it("THE REQUIREMENT: repIds puts the whole crew on the area at creation", async () => {
    seedLead(null, null);   // a door inside the square, unassigned
    const { status, body } = await drawArea(fx.manager.session, {
      repIds: [fx.talal.memberId, fx.bo.memberId], name: "Two-hander",
    });
    expect(status).toBe(201);
    expect(body.repIds).toEqual([fx.talal.memberId, fx.bo.memberId]);
    expect(body.repNames).toEqual(["Talal Rep", "Bo Rivera"]);

    const t = storage.getTerritoryById(body.territory.id) as any;
    expect(JSON.parse(t.assigneeIds)).toEqual([fx.talal.memberId, fx.bo.memberId]);
    expect(t.repId).toBe(fx.talal.memberId);   // first pick is the primary
    expect(t.status).toBe("shared");

    // BOTH reps can see the area — that is what being on the crew means.
    for (const p of [fx.talal, fx.bo]) {
      const list = await (await req("/api/territories", p.session)).json() as any[];
      expect(list.some(x => x.id === body.territory.id)).toBe(true);
    }
  });

  it("auto-names a crew area after the primary +n, and a solo area after the rep", async () => {
    const crew = await drawArea(fx.manager.session, { repIds: [fx.talal.memberId, fx.bo.memberId] });
    expect(crew.body.territory.name).toBe("Talal Rep +1");
    const solo = await drawArea(fx.manager.session, { repIds: [fx.bo.memberId] });
    expect(solo.body.territory.name).toBe("Bo Rivera's area");
  });

  it("still accepts the old single repId", async () => {
    const { status, body } = await drawArea(fx.manager.session, { repId: fx.bo.memberId });
    expect(status).toBe(201);
    expect(JSON.parse((storage.getTerritoryById(body.territory.id) as any).assigneeIds)).toEqual([fx.bo.memberId]);
    expect(body.territory.status).toBe("active");
  });

  it("validates EVERY rep before writing anything — a bad third leaves no area behind", async () => {
    const areasBefore = storage.getTerritories(1).length;
    const { status } = await drawArea(fx.manager.session, {
      repIds: [fx.talal.memberId, fx.bo.memberId, 999_999],
    });
    expect(status).toBe(404);
    expect(storage.getTerritories(1).length).toBe(areasBefore);
  });

  it("rejects an empty crew and junk ids rather than guessing", async () => {
    expect((await drawArea(fx.manager.session, { repIds: [] })).status).toBe(400);
    expect((await drawArea(fx.manager.session, { repIds: ["7"] })).status).toBe(400);
    expect((await drawArea(fx.manager.session, {})).status).toBe(400);
  });

  it("dedupes a repeated pick instead of writing the same rep twice", async () => {
    const { body } = await drawArea(fx.manager.session, {
      repIds: [fx.talal.memberId, fx.talal.memberId, fx.bo.memberId],
    });
    expect(body.repIds).toEqual([fx.talal.memberId, fx.bo.memberId]);
  });
});

describe("removing ONE rep from a crew area", () => {
  it("THE REQUIREMENT: they lose the area and their doors in it, the crew keeps both", async () => {
    const areaId = seedArea([fx.talal.memberId, fx.bo.memberId]);
    const talalDoor = seedLead(fx.talal.memberId, areaId);
    const boDoor = seedLead(fx.bo.memberId, areaId);

    const res = await req(`/api/territories/${areaId}/unassign`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repId: fx.talal.memberId }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, leadsReleased: 1, assigneeIds: [fx.bo.memberId] });

    // Off the area…
    const talalSees = await (await req("/api/territories", fx.talal.session)).json() as any[];
    expect(talalSees.some(t => t.id === areaId)).toBe(false);
    // …and his door is nobody's.
    expect(leadRow(talalDoor).repId).toBeNull();
    expect(leadRow(talalDoor).source).toBeNull();
    expect(leadRow(talalDoor).assignedBy).toBeNull();

    // The co-assignee keeps the area AND his own door, untouched.
    const boSees = await (await req("/api/territories", fx.bo.session)).json() as any[];
    expect(boSees.some(t => t.id === areaId)).toBe(true);
    expect(leadRow(boDoor).repId).toBe(fx.bo.memberId);
  });

  it("the released doors STAY IN THE AREA, so the remaining crew still works them", async () => {
    // Nulling the area link too would make them open field — no rep, no
    // territory — which is invisible to every co-assignee still on the ground.
    const areaId = seedArea([fx.talal.memberId, fx.bo.memberId]);
    const talalDoor = seedLead(fx.talal.memberId, areaId);

    await req(`/api/territories/${areaId}/unassign`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repId: fx.talal.memberId }),
    });

    expect(leadRow(talalDoor).areaId).toBe(areaId);
    // Bo holds the area, so the door is still his to work — rule 2 of
    // shared/leadVisibility ("it sits in a territory they hold"). Asserted on
    // the MAP feed, which is the surface that implements that rule; the
    // /api/leads page query scopes on assigned_rep_id alone.
    expect(await pinsVisibleTo(fx.bo.session)).toContain(talalDoor);
    // Talal, who is off the area, sees it on neither.
    expect(await pinsVisibleTo(fx.talal.session)).not.toContain(talalDoor);
    expect(await leadsVisibleTo(fx.talal.session)).not.toContain(talalDoor);
    // And the door is still linked, so the area has not silently emptied.
    expect(storage.getLeadsByTerritory(areaId).map((l: any) => l.id)).toContain(talalDoor);
  });

  it("the progress row names the WHOLE crew, which is what the Area tab removes from", async () => {
    const areaId = seedArea([fx.talal.memberId, fx.bo.memberId]);
    seedLead(fx.talal.memberId, areaId);

    const before = await (await req(`/api/territories/${areaId}/progress`, fx.manager.session)).json() as any;
    expect(before.repIds).toEqual([fx.talal.memberId, fx.bo.memberId]);
    expect(before.repNames).toEqual(["Talal Rep", "Bo Rivera"]);

    await req(`/api/territories/${areaId}/unassign`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repId: fx.talal.memberId }),
    });
    const after = await (await req(`/api/territories/${areaId}/progress`, fx.manager.session)).json() as any;
    expect(after.repIds).toEqual([fx.bo.memberId]);
    expect(after.repNames).toEqual(["Bo Rivera"]);
  });

  it("removing the LAST rep empties the area but keeps its doors linked to it", async () => {
    const areaId = seedArea([fx.talal.memberId]);
    const door = seedLead(fx.talal.memberId, areaId);

    const body = await (await req(`/api/territories/${areaId}/unassign`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repId: fx.talal.memberId }),
    })).json() as any;
    expect(body.status).toBe("unassigned");

    expect(leadRow(door).repId).toBeNull();
    expect(leadRow(door).areaId).toBe(areaId);   // the area still exists
    expect(storage.getLeadsByTerritory(areaId).map((l: any) => l.id)).toEqual([door]);
    const progress = await (await req(`/api/territories/${areaId}/progress`, fx.manager.session)).json() as any;
    expect(progress.repIds).toEqual([]);
    expect(progress.repNames).toEqual([]);
  });

  it("then DELETING that area unassigns everything left in it", async () => {
    // The two operations compose: remove reps one at a time, or delete and take
    // the whole patch out at once.
    const areaId = seedArea([fx.talal.memberId, fx.bo.memberId]);
    const doors = [seedLead(fx.talal.memberId, areaId), seedLead(fx.bo.memberId, areaId)];
    await req(`/api/territories/${areaId}/unassign`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repId: fx.talal.memberId }),
    });
    const body = await (await req(`/api/territories/${areaId}`, fx.admin.session, { method: "DELETE" })).json() as any;

    expect(body.detached).toBe(2);
    expect(body.repCleared).toBe(1);              // Talal's was already released
    expect(body.clearedRepNames).toEqual(["Bo Rivera"]);
    for (const d of doors) {
      expect(leadRow(d)).toMatchObject({ repId: null, areaId: null });
    }
  });
});
