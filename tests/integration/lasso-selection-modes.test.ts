// ── Lasso intelligence: modes, net changes, and reasoned exclusions ──────────
// The contract this pins: a second loop is a refinement, never an "overlap"
// error (add unions with dedupe, subtract carves, both with honest deltas);
// the apply writes only NET changes (re-assigning a rep's own doors is a
// no-op that must not rewrite assigned_at or mint events); and every excluded
// door lands in a named bucket. Preview and apply ride one resolver, so each
// assertion here holds for both.
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

function person(name: string, role: string, tenantId = 1): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@lassomode.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
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

// Two adjacent boxes that OVERLAP in the middle band, plus a small carve box.
// WEST covers lng -80.30..-80.24, EAST covers -80.26..-80.20 (overlap
// -80.26..-80.24); CARVE covers the middle sliver -80.255..-80.245.
const box = (w: number, e: number, s = 35.80, n = 35.90): [number, number][] =>
  [[w, s], [e, s], [e, n], [w, n]];
const WEST = box(-80.30, -80.24);
const EAST = box(-80.26, -80.20);
const CARVE = box(-80.255, -80.245);

let addrSeq = 1;
function seedLead(lng: number, over: Record<string, unknown> = {}): number {
  const lead = storage.createLead({
    address: `${addrSeq++} Mode Way`, city: "Lexington", state: "NC", zip: "27292",
    lat: 35.85, lng, tenantId: 1, leadStatus: "prospect",
  } as any);
  const keys = Object.keys(over);
  if (keys.length) {
    rawDb.prepare(`UPDATE leads SET ${keys.map(k => `${k} = ?`).join(", ")} WHERE id = ?`)
      .run(...keys.map(k => (over as any)[k]), lead.id);
  }
  return lead.id;
}

async function preview(session: string, body: unknown) {
  const res = await post("/api/leads/assign-selection/preview", session, body);
  expect(res.status).toBe(200);
  return res.json();
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-lassomode-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  rawDb = (await import("../../server/db")).rawDb;

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${a.port}`;

  fx.manager = person("Mara Manager", "manager");
  fx.dana = person("Dana Doors", "rep");
  fx.omar = person("Omar Other", "rep");
});

afterAll(async () => {
  if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(() => {
  rawDb.prepare("DELETE FROM leads").run();
  rawDb.prepare("DELETE FROM lead_events").run();
});

describe("composed selections (add / subtract)", () => {
  it("two overlapping add-loops count each door ONCE, and the delta names what the second loop added vs already had", async () => {
    const westOnly = seedLead(-80.28);
    const overlapDoor = seedLead(-80.25);
    const eastOnly = seedLead(-80.22);

    const one = await preview(fx.manager.session, { polygons: [{ ring: WEST, op: "add" }] });
    expect(one.total).toBe(2); // westOnly + overlapDoor
    expect(one.lastRing).toBeNull();

    const both = await preview(fx.manager.session, {
      polygons: [{ ring: WEST, op: "add" }, { ring: EAST, op: "add" }],
    });
    expect(both.total).toBe(3); // deduplicated union, never 4
    expect(both.ringCount).toBe(2);
    expect(both.lastRing).toEqual({ op: "add", added: 1, alreadySelected: 1, removed: 0, notInSelection: 0 });
    void westOnly; void overlapDoor; void eastOnly;
  });

  it("a subtract-loop carves doors out and reports what it removed vs never had", async () => {
    seedLead(-80.28);            // stays
    const carved = seedLead(-80.25); // inside CARVE - removed
    const neverIn = seedLead(-80.22); // in CARVE's lng? -80.22 outside carve AND outside WEST

    const res = await preview(fx.manager.session, {
      polygons: [{ ring: WEST, op: "add" }, { ring: CARVE, op: "subtract" }],
    });
    expect(res.total).toBe(1);
    expect(res.lastRing.op).toBe("subtract");
    expect(res.lastRing.removed).toBe(1);
    expect(res.lastRing.notInSelection).toBe(0);
    void carved; void neverIn;
  });

  it("bounds: too many loops and subtract-only selections are refused with named codes", async () => {
    const many = Array.from({ length: 9 }, () => ({ ring: WEST, op: "add" }));
    const a = await post("/api/leads/assign-selection/preview", fx.manager.session, { polygons: many });
    expect(a.status).toBe(400);
    expect((await a.json()).code).toBe("TOO_MANY_RINGS");

    const b = await post("/api/leads/assign-selection/preview", fx.manager.session, {
      polygons: [{ ring: CARVE, op: "subtract" }],
    });
    expect(b.status).toBe(400);
    expect((await b.json()).code).toBe("NO_ADD_RING");
  });
});

describe("target-aware breakdown", () => {
  it("splits matching into net changes, already-with-target, from other reps, and from the pool", async () => {
    seedLead(-80.28, { assigned_rep_id: fx.dana.memberId });   // already Dana's
    seedLead(-80.28, { assigned_rep_id: fx.dana.memberId });
    seedLead(-80.27, { assigned_rep_id: fx.omar.memberId });   // moves from Omar
    seedLead(-80.27);                                          // pool
    seedLead(-80.27);                                          // pool

    const res = await preview(fx.manager.session, {
      polygons: [{ ring: WEST, op: "add" }],
      targetRepId: fx.dana.memberId,
    });
    expect(res.total).toBe(5);
    expect(res.matching).toBe(5);
    expect(res.actionable).toBe(5);
    expect(res.alreadyAssignedToTarget).toBe(2);
    expect(res.netChanges).toBe(3);
    expect(res.fromOtherReps).toBe(1);
    expect(res.fromPool).toBe(2);
  });

  it("state-chip refinement lands in excluded.filteredOut, never silently dropped", async () => {
    seedLead(-80.28); // fresh door - display state "unworked"
    seedLead(-80.28, { lead_status: "interested", last_outcome: "interested" });

    const res = await preview(fx.manager.session, {
      polygons: [{ ring: WEST, op: "add" }],
      includeStates: ["unworked"],
    });
    expect(res.total).toBe(1);
    expect(res.excluded.filteredOut).toBe(1);
  });
});

describe("net-change apply", () => {
  it("never rewrites doors the target already holds: assigned_at untouched, no event minted, undo covers only real moves", async () => {
    const danaOld = "2026-08-01T09:00:00.000Z";
    const owned = seedLead(-80.28, { assigned_rep_id: fx.dana.memberId, assigned_at: danaOld });
    const pool1 = seedLead(-80.27);
    const pool2 = seedLead(-80.27);

    const res = await post("/api/leads/assign-selection", fx.manager.session, {
      polygons: [{ ring: WEST, op: "add" }],
      repId: fx.dana.memberId,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(2);
    expect(body.alreadyAssignedToTarget).toBe(1);
    expect(body.matchedInSelection).toBe(3);
    expect(typeof body.undoToken).toBe("string");

    // Dana's own door: byte-identical assignment state, zero event noise.
    const row = rawDb.prepare("SELECT assigned_at a FROM leads WHERE id = ?").get(owned) as any;
    expect(row.a).toBe(danaOld);
    const evts = (rawDb.prepare("SELECT COUNT(*) c FROM lead_events WHERE lead_id = ? AND type = 'assignment'").get(owned) as any).c;
    expect(evts).toBe(0);

    // Undo restores exactly the two real moves and leaves the held door alone.
    const undo = await post("/api/leads/assign-selection/undo", fx.manager.session, { token: body.undoToken });
    expect((await undo.json()).restored).toBe(2);
    expect((rawDb.prepare("SELECT assigned_rep_id r FROM leads WHERE id = ?").get(pool1) as any).r).toBeNull();
    expect((rawDb.prepare("SELECT assigned_rep_id r FROM leads WHERE id = ?").get(pool2) as any).r).toBeNull();
    expect((rawDb.prepare("SELECT assigned_rep_id r FROM leads WHERE id = ?").get(owned) as any).r).toBe(fx.dana.memberId);
  });

  it("all-already-target answers 'no changes needed' - not an error, no undo, nothing written", async () => {
    seedLead(-80.28, { assigned_rep_id: fx.dana.memberId, assigned_at: "2026-08-01T09:00:00.000Z" });
    seedLead(-80.28, { assigned_rep_id: fx.dana.memberId, assigned_at: "2026-08-01T09:00:00.000Z" });

    const res = await post("/api/leads/assign-selection", fx.manager.session, {
      polygons: [{ ring: WEST, op: "add" }],
      repId: fx.dana.memberId,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(0);
    expect(body.alreadyAssignedToTarget).toBe(2);
    expect(body.noChangesNeeded).toBe(true);
    expect(body.undoToken).toBeUndefined();
    expect((rawDb.prepare("SELECT COUNT(*) c FROM lead_events WHERE type='assignment'").get() as any).c).toBe(0);
  });

  it("a recycled opId with different loops is refused, composed geometry included in the op identity", async () => {
    seedLead(-80.28);
    const opId = "mode-op-1";
    const first = await post("/api/leads/assign-selection", fx.manager.session, {
      polygons: [{ ring: WEST, op: "add" }], repId: fx.dana.memberId, opId,
    });
    expect(first.status).toBe(200);
    const second = await post("/api/leads/assign-selection", fx.manager.session, {
      polygons: [{ ring: WEST, op: "add" }, { ring: CARVE, op: "subtract" }], repId: fx.dana.memberId, opId,
    });
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe("OP_REUSED");
  });
});
