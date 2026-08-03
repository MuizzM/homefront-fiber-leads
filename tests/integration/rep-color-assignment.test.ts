// Fixture accounts are marked TRAINED. New accounts now owe training before the
// field opens (server/trainingGateStore.ts); these suites are about territory,
// RBAC, spiffs, and offboarding, so their people start on the far side of that
// gate rather than every assertion here re-testing it.
// Rep colour is assigned AT CREATION and persisted on team_members.color.
//
// The old behaviour hashed repId % 24 at render time, so two reps a palette
// apart wore identical hues and nobody could fix it. Now storage.createTeamMember
// allocates the first palette hue no ACTIVE member of the tenant is wearing,
// stores it, and every reader resolves through repColorOf (persisted ?? hash).
// This file proves the allocation end to end: distinct colours for created
// members, tenant-scoped reuse, exhaustion falling back to NULL + hash, the
// legacy NULL column, and the colour riding the /api/team payload for every role.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REP_PALETTE, colorForRep, repColorOf } from "../../shared/repColors";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];

type Person = { userId: number; memberId: number; session: string };

function person(name: string, role: string, tenantId = 1): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@rep-color.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  __gateDb?.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run((user as any).id);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...(init.headers ?? {}) },
  });
}

const fx: Record<string, Person> = {};

let __gateDb: any;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-rep-color-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb: __gateDb } = await import("../../server/db"));

  fx.manager = person("Mona Manager", "manager");

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

describe("storage-level allocation", () => {
  it("persists a colour on every created member, distinct among the tenant's actives", () => {
    const created = [1, 2, 3, 4].map((i) =>
      storage.createTeamMember({ name: `Walk Rep ${i}`, role: "rep", active: true, tenantId: 1 } as any));
    for (const m of created) {
      expect(m.color, `${m.name} has a persisted colour`).toBeTruthy();
      expect(REP_PALETTE).toContain(m.color);
    }
    const actives = storage.getTeamMembers(1).filter((m) => m.active);
    const colors = actives.map((m) => repColorOf(m));
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("scopes allocation per tenant — a second org starts from the top of the palette", () => {
    const other = storage.createTeamMember({ name: "Tia Tenant Two", role: "rep", active: true, tenantId: 2 } as any);
    expect(other.color).toBe(REP_PALETTE[0]);
  });

  it("does not reserve a hue for INACTIVE members", () => {
    // Tenant 3: an inactive member takes palette[0] at creation, but the next
    // ACTIVE hire may wear it too — only active members block a hue.
    const ghost = storage.createTeamMember({ name: "Gone Ghost", role: "rep", active: false, tenantId: 3 } as any);
    const live = storage.createTeamMember({ name: "Liv Live", role: "rep", active: true, tenantId: 3 } as any);
    expect(ghost.color).toBe(REP_PALETTE[0]);
    expect(live.color).toBe(REP_PALETTE[0]);
  });

  it("stores NULL when the palette is exhausted and repColorOf falls back to the hash", () => {
    // Tenant 4: burn all 24 hues, then hire one more.
    for (let i = 0; i < REP_PALETTE.length; i++) {
      storage.createTeamMember({ name: `Full Rep ${i}`, role: "rep", active: true, tenantId: 4 } as any);
    }
    const overflow = storage.createTeamMember({ name: "Ova Flow", role: "rep", active: true, tenantId: 4 } as any);
    expect(overflow.color).toBeNull();
    expect(repColorOf(overflow)).toBe(colorForRep(overflow.id)); // the pre-column behaviour
  });

  it("legacy rows (NULL colour) keep their old hash hue through the resolver", () => {
    const legacy = storage.createTeamMember({ name: "Les Legacy", role: "rep", active: true, tenantId: 5 } as any);
    // Simulate a pre-migration row: the column exists but was never populated.
    storage.updateTeamMember(legacy.id, { color: null } as any, 5);
    const row = storage.getTeamMemberById(legacy.id, 5)!;
    expect(row.color).toBeNull();
    expect(repColorOf(row)).toBe(colorForRep(row.id));
  });
});

describe("route-level allocation and read-back", () => {
  it("POST /api/team members get distinct persisted colours", async () => {
    const bodies: any[] = [];
    for (const name of ["Route Rep A", "Route Rep B", "Route Rep C"]) {
      const res = await req("/api/team", fx.manager.session, {
        method: "POST",
        body: JSON.stringify({ name, role: "rep", active: true, email: `${name.toLowerCase().replace(/\s+/g, ".")}@rep-color.example.test` }),
      });
      expect(res.status).toBe(201);
      bodies.push(await res.json());
    }
    for (const b of bodies) expect(REP_PALETTE).toContain(b.color);
    expect(new Set(bodies.map((b) => b.color)).size).toBe(bodies.length);
  });

  it("GET /api/team exposes the colour to managers AND to the reps' trimmed view", async () => {
    const rep = person("Vera Viewer", "rep");
    const asManager = await (await req("/api/team", fx.manager.session)).json() as any[];
    const asRep = await (await req("/api/team", rep.session)).json() as any[];

    const mineFull = asManager.find((m) => m.id === rep.memberId);
    const mineTrim = asRep.find((m) => m.id === rep.memberId);
    expect(mineFull?.color).toBeTruthy();
    expect(mineTrim?.color).toBe(mineFull?.color);
    // The rep view stays trimmed of PII — colour is presentation, not contact data.
    expect(mineTrim).not.toHaveProperty("email");
    expect(mineTrim).not.toHaveProperty("phone");
  });
});
