// The territory assignment routes, brought up to the bar the lead-assign
// routes already meet. assign-area accepted ANY >=3-point array and persisted
// it verbatim, resolved unbounded candidates, and looped storage.updateLead
// per door - three statements PLUS a pin-cache bust and a synchronous SSE
// fan-out per row, inside the open write transaction (the documented prod
// stall class). It and /:id/assign now share assign-selection's ring bar and
// candidate cap and stamp doors set-based; /share and /:id/assign refuse
// archived areas like their siblings; every rep-taking route refuses a
// deactivated target; /unassign reaches NULL-tenant adopted areas the way
// every sibling lifecycle route always could.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

type Person = { userId: number; memberId: number; session: string };
const fx: Record<string, Person> = {};

function person(name: string, role: string, tenantId = 1, reportsToId?: number): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@terrharden.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId, reportsToId } as any);
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

const RING: [number, number][] = [
  [-80.30, 35.80], [-80.20, 35.80], [-80.20, 35.90], [-80.30, 35.90],
];

let addrSeq = 1000;
function seedLead(over: Record<string, unknown> = {}, tenantId = 1): number {
  return storage.createLead({
    address: `${addrSeq++} Harden Way`, city: "Lexington", state: "NC", zip: "27292",
    lat: 35.85, lng: -80.25, tenantId, leadStatus: "prospect",
    ...over,
  } as any).id;
}

function seedArea(over: Record<string, unknown> = {}): number {
  return storage.createTerritory({
    tenantId: 1, name: "Harden Area", repId: fx.ann.memberId,
    polygon: JSON.stringify(RING), color: "#3EA394", status: "active",
    assigneeIds: JSON.stringify([fx.ann.memberId]),
    ...over,
  } as any).id;
}

const leadById = (id: number) => rawDb.prepare("SELECT * FROM leads WHERE id = ?").get(id) as any;
const assignEvents = (id: number) =>
  (rawDb.prepare("SELECT COUNT(*) c FROM lead_events WHERE lead_id = ? AND type = 'assignment'").get(id) as any).c;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-terrharden-"));
  process.env.NODE_ENV = "test";
  // Floor the candidate cap (Math.max keeps 10,000) so AREA_TOO_LARGE is
  // reachable with a ten-thousand-door seed. Set BEFORE routes import.
  process.env.MAX_ASSIGN_BBOX_CANDIDATES = "1";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));

  fx.manager = person("Mara Manager", "manager");
  fx.ann = person("Ann Rep", "rep");
  fx.bo = person("Bo Rep", "rep");

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

beforeEach(() => {
  rawDb.prepare("DELETE FROM leads").run();
  rawDb.prepare("DELETE FROM territories").run();
});

afterAll(async () => {
  if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

describe("assign-area meets assign-selection's input bar", () => {
  it("refuses a 10,001-point ring and non-numeric points", async () => {
    const huge = Array.from({ length: 10_001 }, () => [0, 0]);
    const tooMany = await post("/api/territories/assign-area", fx.manager.session, {
      polygon: huge, repIds: [fx.ann.memberId],
    });
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json()).code).toBe("RING_TOO_COMPLEX");

    const strings = await post("/api/territories/assign-area", fx.manager.session, {
      polygon: [[-80.3, 35.8], ["x", 35.8], [-80.2, 35.9]], repIds: [fx.ann.memberId],
    });
    expect(strings.status).toBe(400);
    expect((await strings.json()).code).toBe("BAD_POLYGON");

    expect(rawDb.prepare("SELECT COUNT(*) c FROM territories").get()).toEqual({ c: 0 });
  });

  it("refuses a bbox past the candidate cap instead of walking it - both routes", async () => {
    const tx = rawDb.transaction(() => {
      for (let i = 0; i < 10_100; i++) {
        seedLead({ lat: 35.8005 + (i % 100) * 0.0009, lng: -80.2995 + Math.floor(i / 100) * 0.0009 });
      }
    });
    tx();

    const draw = await post("/api/territories/assign-area", fx.manager.session, {
      polygon: RING, repIds: [fx.ann.memberId],
    });
    expect(draw.status).toBe(400);
    expect((await draw.json()).code).toBe("AREA_TOO_LARGE");
    expect(rawDb.prepare("SELECT COUNT(*) c FROM territories").get()).toEqual({ c: 0 });

    // The pool-vacuum route over an existing area with the same ground.
    const tId = seedArea({ status: "unassigned", assigneeIds: "[]" });
    const vacuum = await post(`/api/territories/${tId}/assign`, fx.manager.session, { repId: fx.ann.memberId });
    expect(vacuum.status).toBe(400);
    expect((await vacuum.json()).code).toBe("AREA_TOO_LARGE");
  }, 60_000);

  it("still assigns the enclosed doors set-based, with one event per moved door", async () => {
    const pool = seedLead({ lat: 35.82, lng: -80.28 });
    const bos = seedLead({ lat: 35.82, lng: -80.281, assignedRepId: fx.bo.memberId });
    const outside = seedLead({ lat: 35.95, lng: -80.25 });

    const res = await post("/api/territories/assign-area", fx.manager.session, {
      polygon: RING, repIds: [fx.ann.memberId], name: "Set Based", color: "#14C985",
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.assigned).toBe(2); // pool + Bo's (manager may move both)
    expect(json.total).toBe(2);

    for (const id of [pool, bos]) {
      const row = leadById(id);
      expect(row.assigned_rep_id).toBe(fx.ann.memberId);
      expect(row.assigned_territory_id).toBe(json.territory.id);
      expect(row.assignment_source).toBe("territory-sync");
      expect(assignEvents(id)).toBe(1);
    }
    expect(leadById(outside).assigned_rep_id).toBeNull();
    expect(assignEvents(outside)).toBe(0);
  });
});

describe("closed records stay closed", () => {
  it("/:id/assign refuses an archived area instead of resurrecting it", async () => {
    const door = seedLead({ lat: 35.85, lng: -80.25 });
    const tId = seedArea({ status: "archived", assigneeIds: "[]" });
    const res = await post(`/api/territories/${tId}/assign`, fx.manager.session, { repId: fx.ann.memberId });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ARCHIVED");
    expect(leadById(door).assigned_rep_id).toBeNull();
    expect((rawDb.prepare("SELECT status FROM territories WHERE id = ?").get(tId) as any).status).toBe("archived");
  });

  it("/share refuses an archived area too", async () => {
    const tId = seedArea({ status: "archived" });
    const res = await post(`/api/territories/${tId}/share`, fx.manager.session, { repIds: [fx.bo.memberId] });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ARCHIVED");
  });
});

describe("deactivated reps take no ground", () => {
  it("assign-area, /:id/assign, /share (new member) and /reclaim reassign all refuse", async () => {
    const gone = person("Gina Gone", "rep");
    storage.updateTeamMember(gone.memberId, { active: false } as any, 1);

    const draw = await post("/api/territories/assign-area", fx.manager.session, {
      polygon: RING, repIds: [gone.memberId],
    });
    expect(draw.status).toBe(400);
    expect((await draw.json()).code).toBe("REP_INACTIVE");

    const pool = seedArea({ status: "unassigned", assigneeIds: "[]" });
    const vac = await post(`/api/territories/${pool}/assign`, fx.manager.session, { repId: gone.memberId });
    expect(vac.status).toBe(400);
    expect((await vac.json()).code).toBe("REP_INACTIVE");

    const held = seedArea();
    const share = await post(`/api/territories/${held}/share`, fx.manager.session, {
      repIds: [fx.ann.memberId, gone.memberId],
    });
    expect(share.status).toBe(400);
    expect((await share.json()).code).toBe("REP_INACTIVE");

    const reclaim = await post(`/api/territories/${held}/reclaim`, fx.manager.session, {
      mode: "reassign", newRepId: gone.memberId,
    });
    expect(reclaim.status).toBe(400);
    expect((await reclaim.json()).code).toBe("REP_INACTIVE");
  });

  it("a crew already containing a deactivated rep can still be edited down", async () => {
    const gone = person("Greg Gone", "rep");
    const tId = seedArea({
      status: "shared",
      assigneeIds: JSON.stringify([fx.ann.memberId, gone.memberId]),
    });
    storage.updateTeamMember(gone.memberId, { active: false } as any, 1);
    // Re-posting the same crew (no NEW member) must not 400 on the inactive
    // holdover - that would freeze the crew exactly when it needs editing.
    const res = await post(`/api/territories/${tId}/share`, fx.manager.session, {
      repIds: [fx.ann.memberId, gone.memberId],
    });
    expect(res.status).toBe(200);
  });
});

describe("adopted areas are fully manageable", () => {
  it("/unassign reaches a NULL-tenant area for the default-org ADMIN, like its siblings", async () => {
    // An adopted row: tenant_id IS NULL, held by a default-org rep. Writes to
    // adopted rows are default-org-ADMIN-only (sameTenantWrite).
    const admin = person("Ada Admin", "admin");
    const tId = seedArea({ status: "active" });
    rawDb.prepare("UPDATE territories SET tenant_id = NULL WHERE id = ?").run(tId);

    const res = await post(`/api/territories/${tId}/unassign`, admin.session, {
      repId: fx.ann.memberId,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.assigneeIds).toEqual([]);
    // The territory ROW actually changed - the strict-equality tenant
    // condition used to make this write a silent no-op on adopted rows.
    const row = rawDb.prepare("SELECT status, assignee_ids FROM territories WHERE id = ?").get(tId) as any;
    expect(row.assignee_ids).toBe("[]");
  });
});
