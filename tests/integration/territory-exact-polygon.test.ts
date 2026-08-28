// Fixture accounts are marked TRAINED. New accounts now owe training before the
// field opens (server/trainingGateStore.ts); these suites are about territory,
// RBAC, spiffs, and offboarding, so their people start on the far side of that
// gate rather than every assertion here re-testing it.
// The shape the manager cut is the shape the rep walks.
//
// A convex hull is the specific way this goes wrong, because it looks close
// enough to pass review. A hull CANNOT be concave, so every inlet a manager
// deliberately cut around — a park, a block belonging to another team, the far
// side of a main road — gets swallowed back in. The rep opens their map to a
// boundary nobody drew, containing doors nobody assigned them.
//
// These specs assert vertex-for-vertex identity through the whole round trip,
// and they use a deliberately CONCAVE ring, because a convex fixture would pass
// against a hull and prove nothing.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { polygonCovers } from "../../shared/geo";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];

type Person = { userId: number; memberId: number; session: string };
const fx: Record<string, Person> = {};

function person(name: string, role: string, tenantId = 1, opts: { reportsToId?: number | null } = {}): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@exact-poly.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId, reportsToId: opts.reportsToId ?? null } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  __gateDb?.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run((user as any).id);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...init.headers },
  });
}

// A C-shape. Its mouth is a genuine concavity: the notch is OUTSIDE the area,
// and a convex hull would swallow it. Coordinates are [lng, lat].
function cShape(west: number, south: number): [number, number][] {
  const s = 0.02;
  return [
    [west,           south],
    [west + s * 3,   south],
    [west + s * 3,   south + s],
    [west + s,       south + s],          // ── into the mouth
    [west + s,       south + s * 2],
    [west + s * 3,   south + s * 2],
    [west + s * 3,   south + s * 3],
    [west,           south + s * 3],
  ];
}

/** A point inside the mouth of the C — outside the real ring, inside its hull. */
function inTheMouth(west: number, south: number): { lat: number; lng: number } {
  const s = 0.02;
  return { lat: south + s * 1.5, lng: west + s * 2 };
}

let patch = 0;
const nextWest = () => -80.9 + patch++ * 0.15;

let __gateDb: any;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-exact-poly-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb: __gateDb } = await import("../../server/db"));

  fx.manager = person("Mia Manager", "manager");
  fx.rep = person("Rae Rep", "rep", 1, { reportsToId: fx.manager.memberId });
  fx.other = person("Ola Other", "rep", 1, { reportsToId: fx.manager.memberId });

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

describe("the drawn ring survives the save", () => {
  it("stores a concave freehand ring vertex-for-vertex", async () => {
    const ring = cShape(nextWest(), 35.2);
    const response = await req("/api/territories/assign-area", fx.manager.session, {
      method: "POST",
      body: JSON.stringify({ polygon: ring, repId: fx.rep.memberId, color: "#14C985", name: "C shape" }),
    });
    expect(response.status).toBe(201);
    const { territory } = await response.json() as any;

    expect(JSON.parse(territory.polygon)).toEqual(ring);
  });

  it("keeps the concavity - the mouth of the C stays OUTSIDE the area", async () => {
    // The assertion a hull cannot pass. If the saved shape were a convex hull,
    // this point would fall inside it.
    const west = nextWest();
    const ring = cShape(west, 35.2);
    const response = await req("/api/territories/assign-area", fx.manager.session, {
      method: "POST",
      body: JSON.stringify({ polygon: ring, repId: fx.other.memberId, color: "#F97316" }),
    });
    const { territory } = await response.json() as any;
    const saved = JSON.parse(territory.polygon) as [number, number][];

    const mouth = inTheMouth(west, 35.2);
    expect(polygonCovers(mouth.lat, mouth.lng, saved)).toBe(false);
  });

  it("does not close, reorder, or round the ring", async () => {
    // Each of those is a small "harmless" normalisation that changes what the
    // rep sees. The stored value is the bytes that arrived.
    const ring = cShape(nextWest(), 35.2);
    const response = await req("/api/territories/assign-area", fx.manager.session, {
      method: "POST",
      body: JSON.stringify({ polygon: ring, repId: person("Tmp One", "rep", 1, { reportsToId: fx.manager.memberId }).memberId }),
    });
    const saved = JSON.parse((await response.json() as any).territory.polygon) as [number, number][];

    expect(saved).toHaveLength(ring.length);          // no closing point appended
    expect(saved[0]).toEqual(ring[0]);                // no reordering
    expect(saved[saved.length - 1]).toEqual(ring[ring.length - 1]);
    expect(saved.flat().every((n) => typeof n === "number")).toBe(true);
  });
});

describe("the rep reads back the same shape", () => {
  it("serves the assigned rep the identical ring the manager drew", async () => {
    // Acceptance: the rep sees the exact same shape, not a bounding box or an
    // approximation. Compared against the ORIGINAL input, not against what the
    // manager's own view happens to return.
    const west = nextWest();
    const ring = cShape(west, 35.2);
    const walker = person("Wes Walker", "rep", 1, { reportsToId: fx.manager.memberId });

    const created = await req("/api/territories/assign-area", fx.manager.session, {
      method: "POST",
      body: JSON.stringify({ polygon: ring, repId: walker.memberId, color: "#8B5CF6", name: "Walker's C" }),
    });
    const id = (await created.json() as any).territory.id;

    const rows = await (await req("/api/territories", walker.session)).json() as any[];
    const seenByRep = rows.find((t) => t.id === id);

    expect(seenByRep).toBeDefined();
    expect(JSON.parse(seenByRep.polygon)).toEqual(ring);

    // And the concavity survived the trip to the rep, not just to the database.
    const mouth = inTheMouth(west, 35.2);
    expect(polygonCovers(mouth.lat, mouth.lng, JSON.parse(seenByRep.polygon))).toBe(false);
  });

  it("gives every assigned rep the same geometry, byte for byte", async () => {
    // One canonical territory, shared — not a copy per rep that could drift.
    const ring = cShape(nextWest(), 35.2);
    const a = person("Ann Share", "rep", 1, { reportsToId: fx.manager.memberId });
    const b = person("Bo Share", "rep", 1, { reportsToId: fx.manager.memberId });

    const created = await req("/api/territories/assign-area", fx.manager.session, {
      method: "POST",
      body: JSON.stringify({ polygon: ring, repId: a.memberId, color: "#06B6D4" }),
    });
    const id = (await created.json() as any).territory.id;

    const shared = await req(`/api/territories/${id}/share`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repIds: [a.memberId, b.memberId] }),
    });
    expect(shared.status).toBe(200);

    const seenByA = ((await (await req("/api/territories", a.session)).json()) as any[]).find((t) => t.id === id);
    const seenByB = ((await (await req("/api/territories", b.session)).json()) as any[]).find((t) => t.id === id);

    expect(JSON.parse(seenByA.polygon)).toEqual(ring);
    expect(seenByB.polygon).toBe(seenByA.polygon);   // identical string, one canonical shape
  });

  it("still holds the exact ring after the area changes hands", async () => {
    // Reassignment rewrites repId, colour and status. It must not touch geometry.
    const ring = cShape(nextWest(), 35.2);
    const a = person("Ann Hand", "rep", 1, { reportsToId: fx.manager.memberId });
    const b = person("Bo Hand", "rep", 1, { reportsToId: fx.manager.memberId });

    const created = await req("/api/territories/assign-area", fx.manager.session, {
      method: "POST", body: JSON.stringify({ polygon: ring, repId: a.memberId, color: "#EAB308" }),
    });
    const id = (await created.json() as any).territory.id;

    await req(`/api/territories/${id}/share`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repIds: [b.memberId] }),
    });

    const seenByB = ((await (await req("/api/territories", b.session)).json()) as any[]).find((t) => t.id === id);
    expect(JSON.parse(seenByB.polygon)).toEqual(ring);
  });
});

// ── An area drawn over ground with no mapped doors ───────────────────────────
// Carving fresh territory is the case where the loop catches NOTHING: you draw
// around a subdivision before any of it has been scanned in. The client used to
// make this unreachable — the action panel opened on `lassoSelected.length`, the
// count of LEADS inside the loop, so an empty loop left the "Drag a loop around
// the area" hint up and never rendered the Area tab or its Save button. The
// polygon sat in component state with no control on screen that could send it.
//
// The server was always willing. These specs pin that, so a future guard like
// "reject an area with no leads" has to fail a test rather than quietly restore
// a dead end.
describe("an area with no doors inside it", () => {
  it("is created, and comes back carrying the exact ring", async () => {
    const ring = cShape(nextWest(), 35.2);
    const greenfield = person("Gil Green", "rep", 1, { reportsToId: fx.manager.memberId });

    const response = await req("/api/territories/assign-area", fx.manager.session, {
      method: "POST",
      body: JSON.stringify({ polygon: ring, repId: greenfield.memberId, color: "#22D3EE", name: "Phase 2" }),
    });

    expect(response.status).toBe(201);
    const body = await response.json() as any;
    expect(body.assigned).toBe(0);        // nothing to move — that is the point
    expect(body.total).toBe(0);
    expect(body.territory.name).toBe("Phase 2");
    expect(JSON.parse(body.territory.polygon)).toEqual(ring);
  });

  it("shows up on the assigned rep's map like any other area", async () => {
    // The user-visible claim: draw around empty ground, the rep opens the app
    // and the boundary is there.
    const ring = cShape(nextWest(), 35.2);
    const greenfield = person("Ida Green", "rep", 1, { reportsToId: fx.manager.memberId });

    const created = await req("/api/territories/assign-area", fx.manager.session, {
      method: "POST",
      body: JSON.stringify({ polygon: ring, repId: greenfield.memberId, color: "#A855F7" }),
    });
    const id = (await created.json() as any).territory.id;

    const seenByRep = ((await (await req("/api/territories", greenfield.session)).json()) as any[])
      .find((t) => t.id === id);

    expect(seenByRep).toBeDefined();
    expect(seenByRep.status).toBe("active");
    expect(seenByRep.color).toBe("#A855F7");
    expect(JSON.parse(seenByRep.polygon)).toEqual(ring);
  });

  it("claims doors added inside it afterwards", async () => {
    // Membership is geometric at read time (polygonCovers), not a snapshot taken
    // at save time — which is what makes drawing ahead of the scan worth doing.
    const west = nextWest();
    const ring = cShape(west, 35.2);
    const greenfield = person("Ned Green", "rep", 1, { reportsToId: fx.manager.memberId });

    const created = await req("/api/territories/assign-area", fx.manager.session, {
      method: "POST",
      body: JSON.stringify({ polygon: ring, repId: greenfield.memberId, color: "#F43F5E" }),
    });
    const territory = (await created.json() as any).territory;
    const saved = JSON.parse(territory.polygon) as [number, number][];

    // A door in the body of the C — inside the real ring, added after the save.
    const s = 0.02;
    const inside = { lat: 35.2 + s * 0.5, lng: west + s * 1.5 };
    expect(polygonCovers(inside.lat, inside.lng, saved)).toBe(true);

    // And still nothing in the mouth, so "claims what is inside" is not "claims
    // everything near it".
    const mouth = inTheMouth(west, 35.2);
    expect(polygonCovers(mouth.lat, mouth.lng, saved)).toBe(false);
  });
});
