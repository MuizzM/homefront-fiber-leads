import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type RestrictedRole = "calling_rep" | "calling_manager" | "compliance_admin" | "auditor";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

let fieldRepSession: string;
let fieldRepId: number;
let otherRepId: number;
let ownKnockId: number;
let otherKnockId: number;
let ownTerritoryId: number;
let otherTerritoryId: number;
const restrictedSessions = new Map<RestrictedRole, string>();
const realFetch = globalThis.fetch.bind(globalThis);

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-field-rbac-"));
  process.env.NODE_ENV = "test";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  const fieldRep = storage.createTeamMember({
    name: "Scoped Field Rep",
    email: "scoped-field-rep@example.test",
    role: "rep",
    active: true,
    tenantId: 1,
  } as any);
  const otherRep = storage.createTeamMember({
    name: "Other Field Rep",
    email: "other-field-rep@example.test",
    role: "rep",
    active: true,
    tenantId: 1,
  } as any);
  fieldRepId = fieldRep.id;
  otherRepId = otherRep.id;

  const fieldUser = storage.createUser({
    name: fieldRep.name,
    email: fieldRep.email!,
    role: "rep",
    active: true,
    tenantId: 1,
    teamMemberId: fieldRep.id,
  } as any);
  fieldRepSession = storage.createSession(fieldUser.id).id;

  for (const role of ["calling_rep", "calling_manager", "compliance_admin", "auditor"] as const) {
    const user = storage.createUser({
      name: `Restricted ${role}`,
      email: `${role.replace("_", "-")}@field-boundary.example.test`,
      role,
      active: true,
      tenantId: 1,
    } as any);
    restrictedSessions.set(role, storage.createSession(user.id).id);
  }

  const ownLead = storage.createLead({
    address: "100 Own Scope St",
    city: "Lexington",
    state: "NC",
    zip: "27292",
    lat: 35.82,
    lng: -80.25,
    assignedRepId: fieldRep.id,
    leadStatus: "prospect",
    tenantId: 1,
  } as any);
  const otherLead = storage.createLead({
    address: "200 Other Scope St",
    city: "Lexington",
    state: "NC",
    zip: "27292",
    lat: 35.83,
    lng: -80.26,
    assignedRepId: otherRep.id,
    leadStatus: "prospect",
    tenantId: 1,
  } as any);

  ownKnockId = storage.createKnock({
    leadId: ownLead.id,
    repId: fieldRep.id,
    wasHome: false,
    outcome: "not_home",
    notes: "original own note",
  } as any).id;
  otherKnockId = storage.createKnock({
    leadId: otherLead.id,
    repId: otherRep.id,
    wasHome: false,
    outcome: "not_home",
    notes: "original other note",
  } as any).id;

  ownTerritoryId = storage.createTerritory({
    tenantId: 1,
    name: "Own Territory",
    repId: fieldRep.id,
    assigneeIds: JSON.stringify([fieldRep.id]),
    polygon: JSON.stringify([
      [-80.27, 35.81], [-80.24, 35.81], [-80.24, 35.84], [-80.27, 35.84], [-80.27, 35.81],
    ]),
    color: "#2563eb",
  } as any).id;
  otherTerritoryId = storage.createTerritory({
    tenantId: 1,
    name: "Other Territory",
    repId: otherRep.id,
    assigneeIds: JSON.stringify([otherRep.id]),
    polygon: JSON.stringify([
      [-80.27, 35.81], [-80.24, 35.81], [-80.24, 35.84], [-80.27, 35.84], [-80.27, 35.81],
    ]),
    color: "#9333ea",
  } as any).id;

  storage.createCommission({
    repId: fieldRep.id,
    leadId: ownLead.id,
    amount: 125,
    saleDate: "2026-07-14",
    status: "pending",
  } as any);
  storage.createCommission({
    repId: otherRep.id,
    leadId: otherLead.id,
    amount: 250,
    saleDate: "2026-07-14",
    status: "pending",
  } as any);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function request(path: string, sessionId: string, init: RequestInit = {}) {
  return realFetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-session-id": sessionId,
      ...(init.headers ?? {}),
    },
  });
}

function restrictedRequests() {
  return [
    { name: "team roster", path: "/api/team" },
    {
      name: "knock-note write",
      path: `/api/knocks/${ownKnockId}`,
      init: { method: "PATCH", body: JSON.stringify({ notes: "unauthorized mutation" }) },
    },
    {
      name: "location ping",
      path: "/api/location-pings",
      init: { method: "POST", body: JSON.stringify({ repId: fieldRepId, lat: 35.82, lng: -80.25, accuracy: 5 }) },
    },
    { name: "clock sessions", path: "/api/clock/sessions" },
    { name: "commissions", path: "/api/commissions" },
    { name: "territory activity", path: `/api/territories/${ownTerritoryId}/activity` },
  ] satisfies Array<{ name: string; path: string; init?: RequestInit }>;
}

describe.each(["calling_rep", "calling_manager", "compliance_admin", "auditor"] as const)(
  "%s field-application boundary",
  (role) => {
    it.each(restrictedRequests())("returns 403 for $name", async ({ path, init }) => {
      const response = await request(path, restrictedSessions.get(role)!, init);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "Forbidden" });
    });
  },
);

describe("field rep scope", () => {
  it("can read the safe roster projection, without roster PII", async () => {
    const response = await request("/api/team", fieldRepSession);
    expect(response.status).toBe(200);
    const body = await response.json() as Array<Record<string, unknown>>;
    expect(body.some((member) => member.id === fieldRepId)).toBe(true);
    expect(body.every((member) => !("email" in member) && !("phone" in member) && !("reportsToId" in member))).toBe(true);
  });

  it("can update only its own knock note", async () => {
    const ownResponse = await request(`/api/knocks/${ownKnockId}`, fieldRepSession, {
      method: "PATCH",
      body: JSON.stringify({ notes: "updated by owner" }),
    });
    expect(ownResponse.status).toBe(200);
    expect(await ownResponse.json()).toMatchObject({ id: ownKnockId, notes: "updated by owner" });

    const otherResponse = await request(`/api/knocks/${otherKnockId}`, fieldRepSession, {
      method: "PATCH",
      body: JSON.stringify({ notes: "cross-rep mutation" }),
    });
    expect(otherResponse.status).toBe(404);
    expect(storage.getKnockById(otherKnockId)?.notes).toBe("original other note");
  });

  it("writes and reads only its own location history", async () => {
    const createResponse = await request("/api/location-pings", fieldRepSession, {
      method: "POST",
      body: JSON.stringify({ repId: otherRepId, lat: 35.821, lng: -80.251, accuracy: 6 }),
    });
    expect(createResponse.status).toBe(200);
    expect(await createResponse.json()).toMatchObject({ repId: fieldRepId });

    const ownResponse = await request(`/api/location-pings/${fieldRepId}`, fieldRepSession);
    expect(ownResponse.status).toBe(200);
    expect((await ownResponse.json() as any[]).every((ping) => ping.repId === fieldRepId)).toBe(true);

    const otherResponse = await request(`/api/location-pings/${otherRepId}`, fieldRepSession);
    expect(otherResponse.status).toBe(403);
  });

  it("clocks and lists only its own sessions", async () => {
    const clockInResponse = await request("/api/clock/in", fieldRepSession, {
      method: "POST",
      body: JSON.stringify({ repId: otherRepId, notes: "field shift" }),
    });
    expect(clockInResponse.status).toBe(200);
    expect(await clockInResponse.json()).toMatchObject({ repId: fieldRepId });

    const sessionsResponse = await request("/api/clock/sessions", fieldRepSession);
    expect(sessionsResponse.status).toBe(200);
    const sessions = await sessionsResponse.json() as any[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ repId: fieldRepId });

    const clockOutResponse = await request("/api/clock/out", fieldRepSession, {
      method: "POST",
      body: JSON.stringify({ repId: otherRepId }),
    });
    expect(clockOutResponse.status).toBe(200);
    expect(await clockOutResponse.json()).toMatchObject({ repId: fieldRepId });
  });

  it("receives only its own commissions", async () => {
    const response = await request("/api/commissions", fieldRepSession);
    expect(response.status).toBe(200);
    const body = await response.json() as any[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ repId: fieldRepId, amount: 125 });
  });

  it("can read only activity for its assigned territory", async () => {
    const ownResponse = await request(`/api/territories/${ownTerritoryId}/activity`, fieldRepSession);
    expect(ownResponse.status).toBe(200);
    expect(await ownResponse.json()).toMatchObject({ territoryId: ownTerritoryId, name: "Own Territory" });

    const otherResponse = await request(`/api/territories/${otherTerritoryId}/activity`, fieldRepSession);
    expect(otherResponse.status).toBe(404);
  });
});

describe("denied field mutations stay side-effect free", () => {
  it("does not change the protected business records", () => {
    expect(storage.getKnockById(ownKnockId)?.notes).toBe("updated by owner");
    expect((rawDb.prepare("SELECT COUNT(*) AS count FROM location_pings WHERE rep_id <> ?").get(fieldRepId) as any).count).toBe(0);
    expect((rawDb.prepare("SELECT COUNT(*) AS count FROM clock_sessions WHERE rep_id <> ?").get(fieldRepId) as any).count).toBe(0);
    expect((rawDb.prepare("SELECT COUNT(*) AS count FROM commissions").get() as any).count).toBe(2);
  });
});
