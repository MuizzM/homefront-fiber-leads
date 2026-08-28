// Fixture accounts are marked TRAINED. New accounts now owe training before the
// field opens (server/trainingGateStore.ts); these suites are about territory,
// RBAC, spiffs, and offboarding, so their people start on the far side of that
// gate rather than every assertion here re-testing it.
// The colour the admin picks has to come back out.
//
// "I draw a green area and the rep sees blue" had two independent causes, and
// this file covers the server half. POST /api/territories/assign-area accepted
// no colour at all — it stamped colorForRep(repId), the rep's palette hue — so
// the choice made while drawing never reached the database. The client half (the
// renderer preferring colorForRep over the stored column) is covered in
// tests/unit/territory-style.test.ts.
//
// The property that matters is byte-for-byte survival: what goes in is what
// comes out, for the assigning admin AND for the rep who has to walk it.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { colorForRep, repColorOf } from "../../shared/repColors";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];

type Person = { userId: number; memberId: number; session: string };
const fx: Record<string, Person> = {};

function person(name: string, role: string, tenantId = 1, opts: { reportsToId?: number | null } = {}): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@color-rt.example.test`;
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

// Each area gets its own patch so enclosed-lead counts never bleed together.
let patchIndex = 0;
function nextPolygon(): [number, number][] {
  const west = -80.9 + patchIndex * 0.05;
  const south = 35.1 + patchIndex * 0.05;
  patchIndex++;
  return [[west, south], [west + 0.02, south], [west + 0.02, south + 0.02], [west, south + 0.02]];
}

async function drawArea(body: Record<string, unknown>, session = fx.manager.session) {
  const response = await req("/api/territories/assign-area", session, {
    method: "POST",
    body: JSON.stringify({ polygon: nextPolygon(), repId: fx.rep.memberId, ...body }),
  });
  return { status: response.status, body: await response.json() as any };
}

// A rep may hold only MAX_ACTIVE_AREAS_PER_REP areas, and that guard is real —
// it 409s partway through this file if every draw lands on one person. Tests
// that only need "an area got saved" take a fresh rep so the cap never
// masquerades as a colour failure.
let freshRepSeq = 0;
function freshRep(): Person {
  return person(`Ray Rep${++freshRepSeq}`, "rep", 1, { reportsToId: fx.manager.memberId });
}

let __gateDb: any;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-color-rt-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb: __gateDb } = await import("../../server/db"));

  fx.manager = person("Mia Manager", "manager");
  fx.rep = person("Rae Rep", "rep", 1, { reportsToId: fx.manager.memberId });

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

describe("the drawn colour survives the save", () => {
  it("stores the exact colour that was sent", async () => {
    const { status, body } = await drawArea({ color: "#14C985", name: "Green patch" });
    expect(status).toBe(201);
    expect(body.territory.color).toBe("#14C985");
  });

  it("does NOT overwrite it with the rep's palette hue", async () => {
    // The bug, stated directly. Picking a colour that differs from the rep's
    // own hue is the only way this assertion means anything.
    const repHue = colorForRep(fx.rep.memberId);
    const chosen = repHue === "#14C985" ? "#F97316" : "#14C985";
    const { body } = await drawArea({ color: chosen });
    expect(body.territory.color).toBe(chosen);
    expect(body.territory.color).not.toBe(repHue);
  });

  it("expands shorthand to the form the renderer parses", async () => {
    const { body } = await drawArea({ color: "#0F0" });
    expect(body.territory.color).toBe("#00FF00");
  });

  it("still defaults to the rep's own hue when no colour is sent", async () => {
    // Older clients and direct API callers must keep working. The default is
    // now the rep's PERSISTED colour (assigned at creation, team_members.color)
    // resolved through repColorOf — which equals the legacy hash for rows
    // created before the column existed.
    const { status, body } = await drawArea({});
    expect(status).toBe(201);
    const member = storage.getTeamMemberById(fx.rep.memberId)!;
    expect(member.color).toBeTruthy(); // allocated when the fixture was hired
    expect(body.territory.color).toBe(repColorOf(member));
  });

  it("rejects a malformed colour instead of silently falling back", async () => {
    // Silently substituting would make "my green area is blue" unreportable —
    // the caller would believe it saved.
    for (const color of ["green", "#12345", "rgb(1,2,3)", "#GGGGGG", ""]) {
      const { status, body } = await drawArea({ color });
      expect(status).toBe(400);
      expect(body).toMatchObject({ code: "BAD_COLOR" });
    }
  });
});

describe("the rep reads back the same colour", () => {
  it("serves the assigning admin and the assigned rep identical hues", async () => {
    // Acceptance: an admin draws a green polygon and the rep sees the same green
    // one. Two roles, one colour, no per-viewer substitution anywhere in between.
    const walker = freshRep();
    const { body } = await drawArea({ color: "#8B5CF6", name: "Violet patch", repId: walker.memberId });
    const id = body.territory.id;

    const asManager = await (await req("/api/territories", fx.manager.session)).json() as any[];
    const asRep = await (await req("/api/territories", walker.session)).json() as any[];

    const seenByManager = asManager.find((t) => t.id === id);
    const seenByRep = asRep.find((t) => t.id === id);

    expect(seenByRep).toBeDefined();          // the rep can see it at all
    expect(seenByRep.color).toBe("#8B5CF6");
    expect(seenByRep.color).toBe(seenByManager.color);
  });

  it("keeps the drawn colour when the area is SHARED with more reps", async () => {
    // Every reassignment route used to stamp colorForRep(newPrimary) over the
    // stored value, on the old theory that the fill told you who worked the
    // ground. Per-rep halos say who now, and three people can hold one area, so
    // one fill cannot name them. Draw it green, share it, it stays green —
    // otherwise adding a second rep silently repaints the map.
    const a = freshRep(), b = freshRep();
    const { body } = await drawArea({ color: "#14C985", repId: a.memberId });
    const id = body.territory.id;

    const shared = await req(`/api/territories/${id}/share`, fx.manager.session, {
      method: "POST",
      body: JSON.stringify({ repIds: [b.memberId, a.memberId] }),
    });
    expect(shared.status).toBe(200);
    expect((await shared.json() as any).color).toBe("#14C985");

    // And it is the stored row that changed, not just the response body.
    const rows = await (await req("/api/territories", b.session)).json() as any[];
    expect(rows.find((t) => t.id === id)?.color).toBe("#14C985");
  });

  it("keeps the drawn colour when a rep is REMOVED from the area", async () => {
    // Acceptance: removing one rep must not modify what the others see.
    const a = freshRep(), b = freshRep();
    const { body } = await drawArea({ color: "#DB2777", repId: a.memberId });
    const id = body.territory.id;
    await req(`/api/territories/${id}/share`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repIds: [a.memberId, b.memberId] }),
    });

    const removed = await req(`/api/territories/${id}/unassign`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repId: b.memberId }),
    });
    expect(removed.status).toBe(200);

    const rows = await (await req("/api/territories", a.session)).json() as any[];
    expect(rows.find((t) => t.id === id)?.color).toBe("#DB2777");
  });

  it("reports how many doors came with the area", async () => {
    // "Area assigned with N leads" needs a real number, and 0 is a legitimate
    // answer that must still save.
    const { status, body } = await drawArea({ color: "#EAB308", repId: freshRep().memberId });
    expect(status).toBe(201);
    expect(body).toMatchObject({ assigned: 0, total: 0 });
    expect(body.territory.id).toBeGreaterThan(0);
  });
});
