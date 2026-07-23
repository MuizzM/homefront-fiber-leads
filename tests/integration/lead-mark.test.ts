// "Mark leads before assignment": a manager/team-lead flags leads (usually
// still in the unassigned pool) with a priority/hold triage mark. Verifies the
// bulk-mark route + PATCH allowlist: capability gate, scope wall, validation,
// bounding, clearing, and that the mark is independent of assignment.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];

type Fixture = { userId: number; memberId: number; session: string };
function makePerson(name: string, role: string): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@mark.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId: 1 } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId: 1, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}
function makeUnassignedLead(addr: string): number {
  return storage.createLead({
    address: addr, city: "Lexington", state: "NC", zip: "27292",
    lat: 35.82, lng: -80.25, leadStatus: "prospect", tenantId: 1, assignedRepId: null,
  } as any).id;
}
function request(path: string, sessionId: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, ...(init.headers ?? {}) },
  });
}

let manager: Fixture;
let rep: Fixture;
let leadA: number;
let leadB: number;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-lead-mark-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;

  manager = makePerson("Mark Manager", "manager");
  rep = makePerson("Mark Rep", "rep");
  leadA = makeUnassignedLead("100 Mark St");
  leadB = makeUnassignedLead("200 Mark St");

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("POST /api/leads/bulk-mark", () => {
  it("a manager marks unassigned pool leads priority", async () => {
    const res = await request("/api/leads/bulk-mark", manager.session, {
      method: "POST", body: JSON.stringify({ leadIds: [leadA, leadB], mark: "priority" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ updated: 2, mark: "priority" });
    expect(storage.getLeadById(leadA)!.assignMark).toBe("priority");
    // The mark is independent of assignment — the lead is still unassigned.
    expect(storage.getLeadById(leadA)!.assignedRepId).toBeNull();
  });

  it("a rep cannot mark leads (lead.assign is team_lead+)", async () => {
    const res = await request("/api/leads/bulk-mark", rep.session, {
      method: "POST", body: JSON.stringify({ leadIds: [leadA], mark: "hold" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid mark value", async () => {
    const res = await request("/api/leads/bulk-mark", manager.session, {
      method: "POST", body: JSON.stringify({ leadIds: [leadA], mark: "explode" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe("INVALID_LEAD_MARK");
  });

  it("clears a mark with null", async () => {
    const res = await request("/api/leads/bulk-mark", manager.session, {
      method: "POST", body: JSON.stringify({ leadIds: [leadA], mark: null }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).mark).toBeNull();
    expect(storage.getLeadById(leadA)!.assignMark ?? null).toBeNull();
  });

  it("bounds the batch size", async () => {
    const res = await request("/api/leads/bulk-mark", manager.session, {
      method: "POST", body: JSON.stringify({ leadIds: Array.from({ length: 501 }, (_, i) => i + 1), mark: "priority" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe("BULK_TOO_LARGE");
  });
});

describe("PATCH /api/leads/:id assignMark", () => {
  it("a manager sets a single lead's mark and it survives a later assignment", async () => {
    const patch = await request(`/api/leads/${leadB}`, manager.session, {
      method: "PATCH", body: JSON.stringify({ assignMark: "hold" }),
    });
    expect(patch.status).toBe(200);
    expect(storage.getLeadById(leadB)!.assignMark).toBe("hold");

    // Assigning the lead does not disturb the mark (marking is orthogonal).
    const assign = await request(`/api/leads/${leadB}/assign`, manager.session, {
      method: "POST", body: JSON.stringify({ repId: rep.memberId }),
    });
    expect(assign.status).toBe(200);
    const after = storage.getLeadById(leadB)!;
    expect(after.assignedRepId).toBe(rep.memberId);
    expect(after.assignMark).toBe("hold");
  });

  it("rejects an invalid assignMark via PATCH", async () => {
    const res = await request(`/api/leads/${leadB}`, manager.session, {
      method: "PATCH", body: JSON.stringify({ assignMark: "nope" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe("INVALID_LEAD_MARK");
  });
});

describe("tenant-aware getLeadById (E1 hardening)", () => {
  it("returns the row only when the tenant matches", async () => {
    expect(storage.getLeadById(leadA, 1)).toBeTruthy();     // correct tenant
    expect(storage.getLeadById(leadA, 999)).toBeUndefined(); // wrong tenant → walled
    expect(storage.getLeadById(leadA)).toBeTruthy();         // omitted → unscoped (back-compat)
  });
});
