// The lasso panel's parity contract, end to end: the selection the server
// resolves must be the selection the manager SAW (docs/architecture/
// BULK_ASSIGNMENT.md). The panel draws under lenses the original endpoint
// could not express - the rep filter, the pin-level source lenses, the team
// lead's own-territory clip - so "Assign 12" could move 34 doors, including
// other reps' queues. This file pins every lens, the preview endpoint the
// panel now confirms against, the retry idempotency key, and the undo CAS
// that refuses to revert a later deliberate re-assignment (ABA).
//
// Also closes audit gaps this endpoint shipped with: no cross-tenant test, no
// test for the runaway refusal codes, none for the inactive-target refusal.
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
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@assignlens.example.test`;
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

// A ring around (35.80..35.90, -80.30..-80.20) - a plain box so the inside and
// outside fixtures below are obvious by inspection.
const RING: [number, number][] = [
  [-80.30, 35.80], [-80.20, 35.80], [-80.20, 35.90], [-80.30, 35.90],
];

let addrSeq = 1000;
function seedLead(over: Record<string, unknown> = {}, tenantId = 1): number {
  return storage.createLead({
    address: `${addrSeq++} Lens Way`, city: "Lexington", state: "NC", zip: "27292",
    lat: 35.85, lng: -80.25, tenantId, leadStatus: "prospect",
    ...over,
  } as any).id;
}

const leadById = (id: number) => rawDb.prepare("SELECT * FROM leads WHERE id = ?").get(id) as any;
const assignEvents = (id: number) =>
  (rawDb.prepare("SELECT COUNT(*) c FROM lead_events WHERE lead_id = ? AND type = 'assignment'").get(id) as any).c;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-assignlens-"));
  process.env.NODE_ENV = "test";
  // Pull the runaway guards down to their hard floors (Math.max keeps 1,000 /
  // 10,000) so SELECTION_TOO_LARGE and AREA_TOO_LARGE are reachable with a
  // thousand-door seed instead of a quarter-million. Set BEFORE routes import -
  // both consts are read at module load.
  process.env.MAX_ASSIGN_SELECTION = "1";
  process.env.MAX_ASSIGN_BBOX_CANDIDATES = "1";
  // Small chunks so the in-flight-join test gets multiple event-loop yields
  // inside applyAssignment without exceeding the floored 1,000-door cap.
  process.env.ASSIGN_CHUNK = "100";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));

  fx.manager = person("Mara Manager", "manager");
  fx.ann = person("Ann Rep", "rep");
  fx.bo = person("Bo Rep", "rep");
  fx.lead = person("Lena Lead", "team_lead");
  fx.owned = person("Owen Owned", "rep", 1, fx.lead.memberId);
  fx.mgr2 = person("Nadia Neighbor", "manager", 2);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json({ limit: "64kb" })); // the SAME ceiling production applies
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  // CI-only ECONNRESET fix: the big seeding transactions below can block the
  // event loop longer than Node's default 5s keepAliveTimeout on a slow
  // runner, so the server closes the idle keep-alive socket mid-seed and the
  // NEXT post rides a dead connection (undici never retries a POST). Locally
  // the seed finishes in well under a second, so the race is invisible.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000; // must exceed keepAliveTimeout
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${a.port}`;
});

// Every test seeds its own doors; none depends on another's residue. Events
// and members persist (append-only history is not under test here).
beforeEach(() => {
  rawDb.prepare("DELETE FROM leads").run();
});

afterAll(async () => {
  if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

describe("lens fidelity: the server assigns exactly what the panel showed", () => {
  it("repFilter 'unassigned' never strips another rep's queue", async () => {
    const pool = seedLead({ lat: 35.81, lng: -80.21 });
    const annsDoor = seedLead({ lat: 35.81, lng: -80.211, assignedRepId: fx.ann.memberId });

    const res = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: RING, repId: fx.bo.memberId, repFilter: "unassigned",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).total).toBe(1);
    expect(leadById(pool).assigned_rep_id).toBe(fx.bo.memberId);
    // The door the manager filtered OUT of view stays exactly where it was.
    expect(leadById(annsDoor).assigned_rep_id).toBe(fx.ann.memberId);
  });

  it("repFilter by rep id moves only that rep's doors", async () => {
    const anns = seedLead({ lat: 35.815, lng: -80.215, assignedRepId: fx.ann.memberId });
    const pool = seedLead({ lat: 35.815, lng: -80.216 });

    const res = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: RING, repId: fx.bo.memberId, repFilter: fx.ann.memberId,
    });
    expect(res.status).toBe(200);
    expect(leadById(anns).assigned_rep_id).toBe(fx.bo.memberId);
    expect(leadById(pool).assigned_rep_id).toBeNull();
  });

  it("the pin-level source lenses (fcc_fresh, field_verified) bound the ring", async () => {
    const fresh = seedLead({ lat: 35.82, lng: -80.22, leadTag: "fcc_fresh_block" });
    const untagged = seedLead({ lat: 35.82, lng: -80.221 });
    const verified = seedLead({ lat: 35.82, lng: -80.222, freshConfirmedAt: "2026-08-01T00:00:00.000Z" });

    let res = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: RING, repId: fx.ann.memberId, source: "fcc_fresh",
    });
    expect(res.status).toBe(200);
    expect(leadById(fresh).assigned_rep_id).toBe(fx.ann.memberId);
    expect(leadById(untagged).assigned_rep_id).toBeNull();
    expect(leadById(verified).assigned_rep_id).toBeNull();

    res = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: RING, repId: fx.bo.memberId, source: "field_verified",
    });
    expect(res.status).toBe(200);
    expect(leadById(verified).assigned_rep_id).toBe(fx.bo.memberId);
    expect(leadById(untagged).assigned_rep_id).toBeNull();

    const bad = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: RING, repId: fx.ann.memberId, source: "nonsense",
    });
    expect(bad.status).toBe(400);
  });

  it("the SQL view lens still composes (view=latest hides the footprint import)", async () => {
    const footprint = seedLead({ lat: 35.825, lng: -80.225, leadTag: "fcc_fiber_d25" });
    const organic = seedLead({ lat: 35.825, lng: -80.226 });

    const res = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: RING, repId: fx.ann.memberId, view: "latest",
    });
    expect(res.status).toBe(200);
    expect(leadById(organic).assigned_rep_id).toBe(fx.ann.memberId);
    expect(leadById(footprint).assigned_rep_id).toBeNull();
  });

  it("a team_lead who holds areas can only move ground inside them - same clip their map draws", async () => {
    // Lena holds ONE small area in the ring's southwest corner. Her map clips
    // every pin to that area (MapView myTerritoryRings), so her lasso must too.
    const held: [number, number][] = [
      [-80.30, 35.80], [-80.26, 35.80], [-80.26, 35.84], [-80.30, 35.84],
    ];
    const tId = storage.createTerritory({
      tenantId: 1, name: "Lena's Corner", repId: fx.lead.memberId,
      polygon: JSON.stringify(held), color: "#3EA394", status: "active",
      assigneeIds: JSON.stringify([fx.lead.memberId]),
    } as any).id;
    try {
      const insideHeld = seedLead({ lat: 35.82, lng: -80.28, assignedRepId: fx.owned.memberId });
      const outsideHeld = seedLead({ lat: 35.88, lng: -80.22, assignedRepId: fx.owned.memberId });

      const res = await post("/api/leads/assign-selection", fx.lead.session, {
        polygon: RING, repId: fx.lead.memberId,
      });
      expect(res.status).toBe(200);
      expect(leadById(insideHeld).assigned_rep_id).toBe(fx.lead.memberId);
      // Owen's door OUTSIDE Lena's held area was never on her map - untouched.
      expect(leadById(outsideHeld).assigned_rep_id).toBe(fx.owned.memberId);

      // A manager's map has no clip; both doors are theirs to move.
      const preview = await post("/api/leads/assign-selection/preview", fx.manager.session, {
        polygon: RING,
      });
      expect((await preview.json()).total).toBe(2);
    } finally {
      storage.deleteTerritory(tId, 1);
    }
  });
});

describe("the clip mirrors the MAP's rule, not a role list", () => {
  it("a MANAGER with a linked member row who holds areas is clipped like their map is", async () => {
    // MapView clips for every role that is neither admin nor rep with a
    // teamMemberId - managers included. The server resolver was team_lead-only
    // at first, so this manager's panel counted a clipped map while Assign
    // moved the unclipped set.
    const held: [number, number][] = [
      [-80.30, 35.80], [-80.26, 35.80], [-80.26, 35.84], [-80.30, 35.84],
    ];
    const tId = storage.createTerritory({
      tenantId: 1, name: "Mara's Corner", repId: fx.manager.memberId,
      polygon: JSON.stringify(held), color: "#3EA394", status: "active",
      assigneeIds: JSON.stringify([fx.manager.memberId]),
    } as any).id;
    try {
      const insideHeld = seedLead({ lat: 35.82, lng: -80.28 });
      const outsideHeld = seedLead({ lat: 35.88, lng: -80.22 });

      const preview = await post("/api/leads/assign-selection/preview", fx.manager.session, { polygon: RING });
      expect((await preview.json()).total).toBe(1);

      const res = await post("/api/leads/assign-selection", fx.manager.session, {
        polygon: RING, repId: fx.ann.memberId,
      });
      expect(res.status).toBe(200);
      expect(leadById(insideHeld).assigned_rep_id).toBe(fx.ann.memberId);
      expect(leadById(outsideHeld).assigned_rep_id).toBeNull();
    } finally {
      storage.deleteTerritory(tId, 1);
    }
  });
});

describe("preview: what WOULD move, before anything does", () => {
  it("reports total, per-state and per-owner honestly, and writes nothing", async () => {
    const pool1 = seedLead({ lat: 35.83, lng: -80.23 });
    const pool2 = seedLead({ lat: 35.83, lng: -80.231 });
    const anns = seedLead({ lat: 35.83, lng: -80.232, assignedRepId: fx.ann.memberId });
    const sold = seedLead({
      lat: 35.83, lng: -80.233, leadStatus: "sold",
      lastOutcome: "sold", lastOutcomeAt: new Date().toISOString(),
    });

    const res = await post("/api/leads/assign-selection/preview", fx.manager.session, { polygon: RING });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(4);
    expect(json.byState.unworked).toBe(3);
    expect(json.byState.sold).toBe(1);
    expect(json.byOwner["0"]).toBe(3); // pool doors
    expect(json.byOwner[String(fx.ann.memberId)]).toBe(1);
    expect(json.notMovable).toBe(0);
    expect(json.resolveMs).toBeGreaterThanOrEqual(0);

    // The same lenses narrow the preview exactly like the apply.
    const refined = await post("/api/leads/assign-selection/preview", fx.manager.session, {
      polygon: RING, includeStates: ["unworked"], repFilter: "unassigned",
    });
    expect((await refined.json()).total).toBe(2);

    // Preview writes nothing.
    expect(leadById(pool1).assigned_rep_id).toBeNull();
    expect(leadById(pool2).assigned_rep_id).toBeNull();
    expect(leadById(anns).assigned_rep_id).toBe(fx.ann.memberId);
    expect(assignEvents(sold)).toBe(0);
  });

  it("counts doors the caller can see but not move as notMovable", async () => {
    // A door in an area Lena holds, but assigned to Bo (another team): her map
    // shows it (territory access), canReassignLead refuses it - the preview
    // must say "1 door here isn't yours to move" instead of counting low.
    const held: [number, number][] = [
      [-80.30, 35.80], [-80.26, 35.80], [-80.26, 35.84], [-80.30, 35.84],
    ];
    const tId = storage.createTerritory({
      tenantId: 1, name: "Lena's Shared Corner", repId: fx.lead.memberId,
      polygon: JSON.stringify(held), color: "#3EA394", status: "active",
      assigneeIds: JSON.stringify([fx.lead.memberId]),
    } as any).id;
    try {
      const bosDoor = seedLead({ lat: 35.82, lng: -80.28, assignedRepId: fx.bo.memberId, assignedTerritoryId: tId });
      const owens = seedLead({ lat: 35.82, lng: -80.281, assignedRepId: fx.owned.memberId, assignedTerritoryId: tId });

      const res = await post("/api/leads/assign-selection/preview", fx.lead.session, { polygon: RING });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.total).toBe(1); // Owen's door
      expect(json.notMovable).toBe(1); // Bo's door - visible, not hers to take
      expect(leadById(bosDoor).assigned_rep_id).toBe(fx.bo.memberId);
      expect(leadById(owens).assigned_rep_id).toBe(fx.owned.memberId);
    } finally {
      storage.deleteTerritory(tId, 1);
    }
  });

  it("a rep has no preview capability", async () => {
    const res = await post("/api/leads/assign-selection/preview", fx.ann.session, { polygon: RING });
    expect(res.status).toBe(403);
  });
});

describe("the tenant wall", () => {
  it("a neighboring org's ring resolves zero of this org's doors - preview and apply", async () => {
    const ours = seedLead({ lat: 35.84, lng: -80.24 });

    const preview = await post("/api/leads/assign-selection/preview", fx.mgr2.session, { polygon: RING });
    expect(preview.status).toBe(200);
    expect((await preview.json()).total).toBe(0);

    // The apply cannot even name a target: our reps 404 for them...
    const apply = await post("/api/leads/assign-selection", fx.mgr2.session, {
      polygon: RING, repId: fx.ann.memberId,
    });
    expect(apply.status).toBe(404);
    // ...and a pool-return sweep still touches nothing across the wall.
    const sweep = await post("/api/leads/assign-selection", fx.mgr2.session, {
      polygon: RING, repId: null,
    });
    expect(sweep.status).toBe(200);
    expect((await sweep.json()).total).toBe(0);
    expect(leadById(ours).assigned_rep_id).toBeNull();
    expect(assignEvents(ours)).toBe(0);
  });
});

describe("runaway refusals", () => {
  it("RING_TOO_COMPLEX refuses a 10,001-point ring", async () => {
    // Compact [0,0] points keep 10,001 of them inside the 64 KB body limit.
    const ring = Array.from({ length: 10_001 }, () => [0, 0]);
    const res = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: ring, repId: fx.ann.memberId,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("RING_TOO_COMPLEX");
  });

  it("SELECTION_TOO_LARGE refuses instead of truncating (and the preview says so too)", async () => {
    // 1,001 movable doors against the floored 1,000 cap.
    const tx = rawDb.transaction(() => {
      for (let i = 0; i < 1_001; i++) {
        seedLead({ lat: 35.8501 + (i % 40) * 0.0004, lng: -80.2899 + Math.floor(i / 40) * 0.0004 });
      }
    });
    tx();

    const apply = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: RING, repId: fx.ann.memberId,
    });
    expect(apply.status).toBe(400);
    expect((await apply.json()).code).toBe("SELECTION_TOO_LARGE");

    const preview = await post("/api/leads/assign-selection/preview", fx.manager.session, { polygon: RING });
    expect(preview.status).toBe(400);
    expect((await preview.json()).code).toBe("SELECTION_TOO_LARGE");
  }, 30_000);

  it("AREA_TOO_LARGE refuses when the bbox holds more candidates than the cap", async () => {
    // Past the floored 10,000-candidate cap.
    const tx = rawDb.transaction(() => {
      for (let i = 0; i < 10_100; i++) {
        seedLead({ lat: 35.8005 + (i % 100) * 0.0009, lng: -80.2995 + Math.floor(i / 100) * 0.0009 });
      }
    });
    tx();
    const res = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: RING, repId: fx.ann.memberId,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("AREA_TOO_LARGE");
  }, 60_000);
});

describe("retry safety and undo integrity", () => {
  it("the same opId replays the first response instead of re-executing", async () => {
    const door = seedLead({ lat: 35.86, lng: -80.26 });
    const body = { polygon: RING, repId: fx.ann.memberId, opId: "op-retry-1" };

    const first = await post("/api/leads/assign-selection", fx.manager.session, body);
    expect(first.status).toBe(200);
    const a = await first.json();
    expect(a.updated).toBe(1);
    expect(a.undoToken).toBeTruthy();

    // The retry after a lost response: same counts, the SAME working token,
    // and no second audit event on the door.
    const second = await post("/api/leads/assign-selection", fx.manager.session, body);
    expect(second.status).toBe(200);
    const b = await second.json();
    expect(b.updated).toBe(1);
    expect(b.undoToken).toBe(a.undoToken);
    expect(assignEvents(door)).toBe(1);

    // And that token still restores the true prior owner (the pool).
    const undo = await post("/api/leads/assign-selection/undo", fx.manager.session, { token: a.undoToken });
    expect(undo.status).toBe(200);
    expect((await undo.json()).restored).toBe(1);
    expect(leadById(door).assigned_rep_id).toBeNull();
  });

  it("the same opId with a DIFFERENT selection is refused, never answered from cache", async () => {
    seedLead({ lat: 35.865, lng: -80.265 });
    const first = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: RING, repId: fx.ann.memberId, opId: "op-shape-1",
    });
    expect(first.status).toBe(200);
    // Same id, different ring: replaying the cached response would claim work
    // that never ran against THIS selection.
    const different = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: [[-80.31, 35.79], [-80.19, 35.79], [-80.19, 35.91], [-80.31, 35.91]],
      repId: fx.ann.memberId, opId: "op-shape-1",
    });
    expect(different.status).toBe(409);
    expect((await different.json()).code).toBe("OP_REUSED");
  });

  it("a concurrent same-op retry JOINS the running attempt instead of executing twice", async () => {
    // 900 doors at ASSIGN_CHUNK=100 = nine chunks with an event-loop yield
    // between each - exactly the window where a network-dropped client's
    // retry used to land, re-execute, and receive an undo built from rows the
    // first attempt had already assigned.
    const inside: number[] = [];
    const tx = rawDb.transaction(() => {
      for (let i = 0; i < 900; i++) {
        inside.push(seedLead({ lat: 35.801 + (i % 50) * 0.0004, lng: -80.299 + Math.floor(i / 50) * 0.0004 }));
      }
    });
    tx();
    const body = { polygon: RING, repId: fx.ann.memberId, opId: "op-inflight-1" };
    const [a, b] = await Promise.all([
      post("/api/leads/assign-selection", fx.manager.session, body).then((r) => r.json()),
      post("/api/leads/assign-selection", fx.manager.session, body).then((r) => r.json()),
    ]);
    // One execution, two identical answers - same counts, same working token.
    expect(a.updated).toBe(900);
    expect(b.updated).toBe(900);
    expect(a.undoToken).toBeTruthy();
    expect(b.undoToken).toBe(a.undoToken);
    expect(assignEvents(inside[0])).toBe(1);
    expect(assignEvents(inside[899])).toBe(1);
    // And the shared token restores the true prior owners (the pool).
    const undo = await post("/api/leads/assign-selection/undo", fx.manager.session, { token: a.undoToken });
    expect((await undo.json()).restored).toBe(900);
    expect(leadById(inside[0]).assigned_rep_id).toBeNull();
  }, 30_000);

  it("undo skips a door that was deliberately re-assigned to the same rep since (ABA)", async () => {
    const reverted = seedLead({ lat: 35.87, lng: -80.27 });
    const kept = seedLead({ lat: 35.87, lng: -80.271 });

    const res = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: RING, repId: fx.ann.memberId,
    });
    const { undoToken } = await res.json();
    expect(undoToken).toBeTruthy();

    // A different millisecond for the manual re-assign's stamp - a floor, not
    // a race window (load can only widen it).
    await new Promise((r) => setTimeout(r, 10));

    // A manager moves `kept` away and then hands it BACK to Ann - a fresh,
    // deliberate decision with its own assigned_at stamp.
    await post(`/api/leads/${kept}/assign`, fx.manager.session, { repId: fx.bo.memberId });
    await new Promise((r) => setTimeout(r, 10));
    await post(`/api/leads/${kept}/assign`, fx.manager.session, { repId: fx.ann.memberId });

    const undo = await post("/api/leads/assign-selection/undo", fx.manager.session, { token: undoToken });
    expect(undo.status).toBe(200);
    const json = await undo.json();
    // The untouched door reverts; the re-decided one is left with Ann.
    expect(json.restored).toBe(1);
    expect(json.skipped).toBe(1);
    expect(leadById(reverted).assigned_rep_id).toBeNull();
    expect(leadById(kept).assigned_rep_id).toBe(fx.ann.memberId);
  });
});

describe("undo eviction is tenant-fair", () => {
  it("one org churning lassoes cannot purge another org's live token", async () => {
    // Tenant 2 makes ONE undoable move...
    const rita = person("Rita Rep", "rep", 2);
    const theirs = seedLead({ lat: 35.83, lng: -80.23, assignedRepId: rita.memberId }, 2);
    const t2 = await post("/api/leads/assign-selection", fx.mgr2.session, {
      polygon: RING, repId: null,
    });
    const { undoToken: t2Token } = await t2.json();
    expect(t2Token).toBeTruthy();

    // ...then tenant 1 churns ten of them (past the per-tenant share of 8).
    const door = seedLead({ lat: 35.86, lng: -80.26 });
    const t1Tokens: string[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await post("/api/leads/assign-selection", fx.manager.session, {
        polygon: RING, repId: i % 2 ? fx.ann.memberId : fx.bo.memberId,
      });
      const json = await res.json();
      expect(json.undoToken).toBeTruthy();
      t1Tokens.push(json.undoToken);
    }

    // Tenant 1's own oldest token was evicted by its own churn...
    const first = await post("/api/leads/assign-selection/undo", fx.manager.session, { token: t1Tokens[0] });
    expect(first.status).toBe(410);
    // ...its newest still works...
    const latest = await post("/api/leads/assign-selection/undo", fx.manager.session, { token: t1Tokens[9] });
    expect(latest.status).toBe(200);
    // ...and tenant 2's token SURVIVED the neighbor's churn (the global FIFO
    // used to evict it) and still restores their door.
    const undo2 = await post("/api/leads/assign-selection/undo", fx.mgr2.session, { token: t2Token });
    expect(undo2.status).toBe(200);
    expect((await undo2.json()).restored).toBe(1);
    expect(leadById(theirs).assigned_rep_id).toBe(rita.memberId);
    expect(leadById(door).assigned_rep_id).not.toBeNull();
  });
});

describe("target validity", () => {
  it("refuses a deactivated rep on all three assignment routes", async () => {
    const gone = person("Gina Gone", "rep");
    storage.updateTeamMember(gone.memberId, { active: false } as any, 1);
    const door = seedLead({ lat: 35.88, lng: -80.28 });

    const sel = await post("/api/leads/assign-selection", fx.manager.session, {
      polygon: RING, repId: gone.memberId,
    });
    expect(sel.status).toBe(400);
    expect((await sel.json()).code).toBe("REP_INACTIVE");

    const single = await post(`/api/leads/${door}/assign`, fx.manager.session, { repId: gone.memberId });
    expect(single.status).toBe(400);
    expect((await single.json()).code).toBe("REP_INACTIVE");

    const bulk = await post("/api/leads/bulk-assign", fx.manager.session, {
      leadIds: [door], repId: gone.memberId,
    });
    expect(bulk.status).toBe(400);
    expect((await bulk.json()).code).toBe("REP_INACTIVE");

    expect(leadById(door).assigned_rep_id).toBeNull();
  });

  it("repId 0 is refused, and a single-lead unassign stamps unassigned_at", async () => {
    const door = seedLead({ lat: 35.885, lng: -80.285 });

    const zero = await post(`/api/leads/${door}/assign`, fx.manager.session, { repId: 0 });
    expect(zero.status).toBe(400);

    await post(`/api/leads/${door}/assign`, fx.manager.session, { repId: fx.ann.memberId });
    expect(leadById(door).unassigned_at).toBeNull();
    await post(`/api/leads/${door}/assign`, fx.manager.session, { repId: null });
    const row = leadById(door);
    expect(row.assigned_rep_id).toBeNull();
    // The stamp bulk unassign always wrote and this route used to skip.
    expect(row.unassigned_at).not.toBeNull();
  });
});
