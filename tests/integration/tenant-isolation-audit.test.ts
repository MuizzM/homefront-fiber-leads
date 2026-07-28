// ── Cross-tenant isolation audit ─────────────────────────────────────────────
//
// Two organizations with DELIBERATELY similar-looking data and ADJACENT numeric
// ids (leads/members/territories are created alternating A,B,A,B so every
// `?id=n` guess lands on the neighbouring org). Every request below is made
// with a tenant-A session against a tenant-B row.
//
// ══ EXPECTED-RED (marked `it.fails`) — these are the confirmed vulnerabilities ══
//   1. "GET /api/territory-requests leaks every organization's requests"
//      server/routes.ts:5398 → storage.getTerritoryRequests() (storage.ts:3188)
//      takes no tenantId at all, and the enrichment reads getTeamMembers() /
//      getTerritories() unscoped, so rep names + area names cross the wall too.
//   2. "PATCH /api/territory-requests/:id mutates another org's request"
//      server/routes.ts:5418 → storage.updateTerritoryRequest(id, status) has no
//      tenant predicate.
//   3. "POST /api/territories/:id/share accepts a foreign rep id"
//      server/routes.ts:5097 — the ONLY territory route that validates neither
//      repInCallerTenant nor repInVisibilityScope on its rep input.
//   4. "a foreign rep can read the area they were illegally shared into"
//      consequence of (3) + storage.getTerritoriesByRep (storage.ts:3133), which
//      calls getTerritories() with no tenant filter.
//
// Everything else in this file is GREEN and locks in isolation that currently
// works, so a future refactor cannot silently regress it.
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

const TENANT_A = 1;
const TENANT_B = 2;

// Sessions
let aAdmin = "";
let aManager = "";
let bRepSession = "";

// Fixture ids
const ids = {
  aRep: 0, bRep: 0,
  aLead: 0, bLead: 0,
  aKnock: 0, bKnock: 0,
  aPhoto: 0, bPhoto: 0,
  aTerritory: 0, bTerritory: 0,
  aCommission: 0, bCommission: 0,
  aRequest: 0, bRequest: 0,
  shareVictimTerritory: 0,
  aUserId: 0,
};

function req(path: string, sessionId: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, ...(init.headers ?? {}) },
  });
}

const mkLead = (tenantId: number, address: string, repId: number | null) =>
  storage.createLead({
    address, city: "Salisbury", state: "NC", zip: "28146",
    lat: 35.67 + tenantId / 1000, lng: -80.47,
    fiberStatus: "available", leadStatus: "new",
    tenantId, assignedRepId: repId,
  } as any).id;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-tenant-isolation-audit-"));
  process.env.NODE_ENV = "test";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  rawDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
     VALUES (?, 'beacon-fiber', 'Beacon Fiber', 'Owner B', 'owner@beacon.example.test', 'Beacon')`,
  ).run(TENANT_B);

  // ── Roster: adjacent ids, near-identical names ────────────────────────────
  const aRep = storage.createTeamMember({
    name: "Dana Reyes", email: "dana.reyes@acme.example.test", role: "rep", active: true, tenantId: TENANT_A,
  } as any);
  const bRep = storage.createTeamMember({
    name: "Dana Reyes", email: "dana.reyes@beacon.example.test", role: "rep", active: true, tenantId: TENANT_B,
  } as any);
  ids.aRep = aRep.id;
  ids.bRep = bRep.id;

  const adminA = storage.createUser({
    name: "Acme Admin", email: "admin@acme.example.test", role: "admin", active: true, tenantId: TENANT_A,
  } as any);
  ids.aUserId = adminA.id;
  aAdmin = storage.createSession(adminA.id).id;

  const managerA = storage.createUser({
    name: "Acme Manager", email: "manager@acme.example.test", role: "manager", active: true, tenantId: TENANT_A,
  } as any);
  aManager = storage.createSession(managerA.id).id;

  const repUserB = storage.createUser({
    name: "Dana Reyes", email: "dana.reyes@beacon.example.test", role: "rep", active: true,
    tenantId: TENANT_B, teamMemberId: bRep.id,
  } as any);
  bRepSession = storage.createSession(repUserB.id).id;

  // ── Leads: alternating so ids are adjacent ────────────────────────────────
  ids.aLead = mkLead(TENANT_A, "412 Maple Ridge Dr", ids.aRep);
  ids.bLead = mkLead(TENANT_B, "412 Maple Ridge Dr", ids.bRep);

  // ── Knocks (tenant inherited from the lead) ───────────────────────────────
  ids.aKnock = storage.createKnock({
    leadId: ids.aLead, repId: ids.aRep, outcome: "sold", wasHome: true,
    knockedAt: new Date().toISOString(), notes: "Acme note",
  } as any).id;
  ids.bKnock = storage.createKnock({
    leadId: ids.bLead, repId: ids.bRep, outcome: "sold", wasHome: true,
    knockedAt: new Date().toISOString(), notes: "Beacon private note",
  } as any).id;

  // ── Photos on disk so the file route can actually stream ──────────────────
  const photoDir = join(process.env.DATA_DIR!, "uploads", "lead-photos");
  mkdirSync(photoDir, { recursive: true });
  for (const name of ["acme-door.png", "beacon-door.png"]) writeFileSync(join(photoDir, name), "png");
  ids.aPhoto = storage.createLeadPhoto({ leadId: ids.aLead, userId: adminA.id, repId: ids.aRep, path: "lead-photos/acme-door.png" }).id;
  ids.bPhoto = storage.createLeadPhoto({ leadId: ids.bLead, userId: repUserB.id, repId: ids.bRep, path: "lead-photos/beacon-door.png" }).id;

  // ── Territories ───────────────────────────────────────────────────────────
  const square = (dx: number) => JSON.stringify([
    [-80.5 + dx, 35.6], [-80.4 + dx, 35.6], [-80.4 + dx, 35.7], [-80.5 + dx, 35.7],
  ]);
  ids.aTerritory = storage.createTerritory({
    tenantId: TENANT_A, name: "Dana's area", repId: ids.aRep, polygon: square(0),
    color: "#111", status: "active", assigneeIds: JSON.stringify([ids.aRep]),
  } as any).id;
  ids.bTerritory = storage.createTerritory({
    tenantId: TENANT_B, name: "Dana's area", repId: ids.bRep, polygon: square(1),
    color: "#222", status: "active", assigneeIds: JSON.stringify([ids.bRep]),
  } as any).id;
  ids.shareVictimTerritory = storage.createTerritory({
    tenantId: TENANT_A, name: "Acme downtown", repId: ids.aRep, polygon: square(2),
    color: "#333", status: "active", assigneeIds: JSON.stringify([ids.aRep]),
  } as any).id;

  // ── Commissions ───────────────────────────────────────────────────────────
  ids.aCommission = storage.createCommission({
    repId: ids.aRep, leadId: ids.aLead, amount: 150, status: "pending", saleDate: "2026-07-01",
  } as any).id;
  ids.bCommission = storage.createCommission({
    repId: ids.bRep, leadId: ids.bLead, amount: 275, status: "pending", saleDate: "2026-07-01",
  } as any).id;

  // ── Territory requests ────────────────────────────────────────────────────
  ids.aRequest = storage.createTerritoryRequest(ids.aRep, adminA.id, "Acme rep needs a new area").id;
  ids.bRequest = storage.createTerritoryRequest(ids.bRep, repUserB.id, "BEACON-CONFIDENTIAL: finished Beacon Ridge").id;

  // ── Activity + GPS ────────────────────────────────────────────────────────
  storage.logActivity(adminA.id, "lead.created", "lead", ids.aLead, { org: "acme" }, "127.0.0.1", TENANT_A);
  storage.logActivity(repUserB.id, "lead.created", "lead", ids.bLead, { org: "beacon" }, "127.0.0.1", TENANT_B);
  storage.createLocationPing({ repId: ids.bRep, userId: repUserB.id, lat: 35.1, lng: -80.1, accuracy: 5 } as any);

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
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

// ═══════════════════════════════════════════════════════════════════════════
// EXPECTED-RED — confirmed cross-tenant defects. `it.fails` keeps CI green
// while the assertion documents exactly what must become true after the fix.
// ═══════════════════════════════════════════════════════════════════════════
describe("CONFIRMED VULNERABILITIES (expected red until fixed)", () => {
  it("VULN-1: GET /api/territory-requests must not return another org's requests", async () => {
    const res = await req("/api/territory-requests", aManager);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as any[];
    const foreign = rows.find((r) => r.id === ids.bRequest);
    // Today this row IS returned, carrying Beacon's rep name and free-text message.
    expect(foreign).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain("BEACON-CONFIDENTIAL");
  });

  it("VULN-2: PATCH /api/territory-requests/:id must 404 on another org's request", async () => {
    const res = await req(`/api/territory-requests/${ids.bRequest}`, aManager, {
      method: "PATCH",
      body: JSON.stringify({ status: "dismissed" }),
    });
    expect(res.status).toBe(404);
    const row = rawDb.prepare("SELECT status FROM territory_requests WHERE id = ?").get(ids.bRequest) as any;
    expect(row.status).toBe("pending"); // untouched
  });

  it("VULN-3: POST /api/territories/:id/share must reject a rep from another org", async () => {
    const res = await req(`/api/territories/${ids.aTerritory}/share`, aManager, {
      method: "POST",
      body: JSON.stringify({ repIds: [ids.bRep] }),
    });
    // Every sibling territory route rejects a foreign rep id (404 "rep not found").
    expect(res.status).toBeGreaterThanOrEqual(400);
    const row = rawDb.prepare("SELECT assignee_ids AS a FROM territories WHERE id = ?").get(ids.aTerritory) as any;
    expect(JSON.parse(row.a ?? "[]")).not.toContain(ids.bRep);
  });

  it("VULN-4: a rep in org B must never read org A's area they were shared into", async () => {
    // Drive the (currently unvalidated) share, then read as the foreign rep.
    await req(`/api/territories/${ids.shareVictimTerritory}/share`, aManager, {
      method: "POST",
      body: JSON.stringify({ repIds: [ids.bRep] }),
    });
    const res = await req("/api/territories", bRepSession);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as any[];
    // storage.getTerritoriesByRep() scans EVERY tenant's territories, so the
    // polygon + name of Acme's downtown area lands in Beacon's rep app.
    expect(rows.map((t) => t.id)).not.toContain(ids.shareVictimTerritory);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GREEN — isolation that currently holds. These must stay green forever.
// ═══════════════════════════════════════════════════════════════════════════
describe("single-lead reads are walled by tenant", () => {
  it("GET /api/leads/:id → 404 across the wall, 200 for own", async () => {
    expect((await req(`/api/leads/${ids.bLead}`, aManager)).status).toBe(404);
    expect((await req(`/api/leads/${ids.aLead}`, aManager)).status).toBe(200);
  });

  it("GET /api/leads/:id/knocks → 404 across the wall", async () => {
    expect((await req(`/api/leads/${ids.bLead}/knocks`, aManager)).status).toBe(404);
  });

  it("GET /api/leads/:id/history → 404 across the wall", async () => {
    expect((await req(`/api/leads/${ids.bLead}/history`, aManager)).status).toBe(404);
  });

  it("GET /api/leads/:id/photos and the photo file stream are both walled", async () => {
    expect((await req(`/api/leads/${ids.bLead}/photos`, aManager)).status).toBe(404);
    expect((await req(`/api/photos/${ids.bPhoto}/file`, aManager)).status).toBe(404);
    expect((await req(`/api/photos/${ids.aPhoto}/file`, aManager)).status).toBe(200);
  });

  it("the untenanted /uploads static path refuses lead photos outright", async () => {
    expect((await req("/uploads/lead-photos/beacon-door.png", aAdmin)).status).toBe(404);
  });
});

describe("single-lead writes are walled by tenant", () => {
  it("PATCH /api/leads/:id → 404, and the foreign row is unchanged", async () => {
    const res = await req(`/api/leads/${ids.bLead}`, aManager, {
      method: "PATCH", body: JSON.stringify({ leadStatus: "not_interested" }),
    });
    expect(res.status).toBe(404);
    expect(storage.getLeadById(ids.bLead)!.leadStatus).toBe("new");
  });

  it("PATCH /api/leads/:id/notes → 404, and no note is written", async () => {
    const res = await req(`/api/leads/${ids.bLead}/notes`, aManager, {
      method: "PATCH", body: JSON.stringify({ notes: "injected by acme" }),
    });
    expect(res.status).toBe(404);
    expect(storage.getLeadById(ids.bLead)!.notes ?? "").not.toContain("injected");
  });

  it("POST /api/leads/:id/central-disposition → 404 across the wall", async () => {
    const res = await req(`/api/leads/${ids.bLead}/central-disposition`, aManager, {
      method: "POST", body: JSON.stringify({ outcome: "not_interested" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/leads/:id → 404, and the foreign row survives", async () => {
    const res = await req(`/api/leads/${ids.bLead}`, aManager, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(storage.getLeadById(ids.bLead)).toBeDefined();
  });

  it("PATCH /api/knocks/:id → 404 across the wall", async () => {
    const res = await req(`/api/knocks/${ids.bKnock}`, aManager, {
      method: "PATCH", body: JSON.stringify({ notes: "rewritten by acme" }),
    });
    expect(res.status).toBe(404);
    expect(storage.getKnockById(ids.bKnock)!.notes).toBe("Beacon private note");
  });

  it("POST /api/knocks/:id/override and GET /overrides are walled", async () => {
    expect((await req(`/api/knocks/${ids.bKnock}/override`, aAdmin, {
      method: "POST", body: JSON.stringify({ status: "invalid", reason: "cross tenant probe" }),
    })).status).toBe(404);
    expect((await req(`/api/knocks/${ids.bKnock}/overrides`, aManager)).status).toBe(404);
  });
});

describe("bulk endpoints wall EVERY element, not just the first", () => {
  it("POST /api/leads/bulk-status skips the foreign lead and reports it", async () => {
    const res = await req("/api/leads/bulk-status", aManager, {
      method: "POST",
      body: JSON.stringify({ leadIds: [ids.aLead, ids.bLead], outcome: "not_interested" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);
    expect(body.skipped).toBe(1);
    expect(storage.getLeadById(ids.bLead)!.leadStatus).toBe("new");
  });

  it("POST /api/leads/bulk-mark skips the foreign lead", async () => {
    const res = await req("/api/leads/bulk-mark", aManager, {
      method: "POST",
      body: JSON.stringify({ leadIds: [ids.aLead, ids.bLead], mark: "priority" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);
    expect(body.skipped).toBe(1);
    expect((storage.getLeadById(ids.bLead) as any).assignMark ?? null).toBeNull();
  });

  it("POST /api/leads/bulk-assign carries the tenant predicate into SQL", async () => {
    const res = await req("/api/leads/bulk-assign", aManager, {
      method: "POST",
      body: JSON.stringify({ leadIds: [ids.aLead, ids.bLead], repId: ids.aRep }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);
    expect(body.skipped).toBe(1);
    expect(storage.getLeadById(ids.bLead)!.assignedRepId).toBe(ids.bRep);
  });
});

describe("list / search / aggregate reads never cross the wall", () => {
  it("GET /api/leads?search= returns only the caller's org", async () => {
    const res = await req("/api/leads?search=Maple%20Ridge", aManager);
    const body = await res.json();
    expect(body.leads.map((l: any) => l.id)).toEqual([ids.aLead]);
  });

  it("GET /api/leads/map returns only the caller's org", async () => {
    const res = await req("/api/leads/map", aManager);
    const body = await res.json();
    expect(body.pins.map((p: any) => p.id)).not.toContain(ids.bLead);
  });

  it("GET /api/stats counts only the caller's org", async () => {
    const res = await req("/api/stats", aManager);
    const body = await res.json();
    expect(body.total).toBe(1);
  });

  it("GET /api/leaderboard excludes the other org's reps", async () => {
    const res = await req("/api/leaderboard", aManager);
    const rows = (await res.json()) as any[];
    expect(rows.map((r) => r.rep.id)).not.toContain(ids.bRep);
  });

  it("GET /api/team excludes the other org's roster", async () => {
    const res = await req("/api/team", aManager);
    const rows = (await res.json()) as any[];
    expect(rows.map((m: any) => m.id)).not.toContain(ids.bRep);
  });

  it("GET /api/activity-log excludes the other org's audit trail", async () => {
    const res = await req("/api/activity-log", aManager);
    const rows = (await res.json()) as any[];
    expect(JSON.stringify(rows)).not.toContain('"org":"beacon"');
  });

  it("GET /api/location-pings/latest excludes the other org's rep GPS", async () => {
    const res = await req("/api/location-pings/latest", aManager);
    const rows = (await res.json()) as any[];
    expect(rows.map((p: any) => p.repId)).not.toContain(ids.bRep);
  });
});

describe("rep-targeted routes wall the :repId IDOR", () => {
  it("GET /api/team/:id/activity → 404 for a foreign rep", async () => {
    expect((await req(`/api/team/${ids.bRep}/activity`, aManager)).status).toBe(404);
  });

  it("GET /api/location-pings/:repId → 404 for a foreign rep", async () => {
    expect((await req(`/api/location-pings/${ids.bRep}`, aManager)).status).toBe(404);
  });

  it("POST /api/clock/in → 404 for a foreign rep", async () => {
    const res = await req("/api/clock/in", aManager, { method: "POST", body: JSON.stringify({ repId: ids.bRep }) });
    expect(res.status).toBe(404);
  });

  it("GET /api/onboarding/documents/reps/:repId → 404 for a foreign rep", async () => {
    expect((await req(`/api/onboarding/documents/reps/${ids.bRep}`, aAdmin)).status).toBe(404);
  });
});

describe("money surfaces are walled", () => {
  it("GET /api/commissions?repId= → 404 for a foreign rep", async () => {
    expect((await req(`/api/commissions?repId=${ids.bRep}`, aManager)).status).toBe(404);
  });

  it("GET /api/commissions never lists the other org's ledger", async () => {
    const res = await req("/api/commissions", aManager);
    const rows = (await res.json()) as any[];
    expect(rows.map((c) => c.id)).not.toContain(ids.bCommission);
  });

  it("PATCH /api/commissions/:id → 404, and the foreign row keeps its status", async () => {
    const res = await req(`/api/commissions/${ids.bCommission}`, aManager, {
      method: "PATCH", body: JSON.stringify({ status: "paid" }),
    });
    expect(res.status).toBe(404);
    expect(storage.getCommissionById(ids.bCommission)!.status).toBe("pending");
  });

  it("POST /api/commissions → 404 when the rep belongs to another org", async () => {
    const res = await req("/api/commissions", aManager, {
      method: "POST",
      body: JSON.stringify({ repId: ids.bRep, amount: 500, saleDate: "2026-07-02" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/commissions/summary aggregates only the caller's org", async () => {
    const res = await req("/api/commissions/summary", aManager);
    const rows = (await res.json()) as any[];
    expect(rows.map((r: any) => r.repId)).not.toContain(ids.bRep);
  });
});

describe("territory lifecycle routes are walled", () => {
  it("GET /api/territories/:id/history → 404 across the wall", async () => {
    expect((await req(`/api/territories/${ids.bTerritory}/history`, aManager)).status).toBe(404);
  });

  it("PATCH /api/territories/:id → 404, and the foreign area keeps its name", async () => {
    const res = await req(`/api/territories/${ids.bTerritory}`, aManager, {
      method: "PATCH", body: JSON.stringify({ name: "seized by acme" }),
    });
    expect(res.status).toBe(404);
    expect(storage.getTerritoryById(ids.bTerritory)!.name).toBe("Dana's area");
  });

  it("DELETE /api/territories/:id → 404, and the foreign area survives", async () => {
    expect((await req(`/api/territories/${ids.bTerritory}`, aManager, { method: "DELETE" })).status).toBe(404);
    expect(storage.getTerritoryById(ids.bTerritory)).toBeDefined();
  });

  it("POST /api/territories/:id/archive and /reclaim → 404 across the wall", async () => {
    expect((await req(`/api/territories/${ids.bTerritory}/archive`, aManager, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await req(`/api/territories/${ids.bTerritory}/reclaim`, aManager, {
      method: "POST", body: JSON.stringify({ mode: "return_to_pool" }),
    })).status).toBe(404);
    expect((storage.getTerritoryById(ids.bTerritory) as any).status).toBe("active");
  });

  it("POST /api/territories/assign-area → 404 when the rep is in another org", async () => {
    const res = await req("/api/territories/assign-area", aManager, {
      method: "POST",
      body: JSON.stringify({ repId: ids.bRep, polygon: [[-80.5, 35.6], [-80.4, 35.6], [-80.4, 35.7]] }),
    });
    expect(res.status).toBe(404);
  });
});

describe("scan job ids are not a cross-tenant handle", () => {
  it("GET/DELETE /api/scan/:jobId and the SSE stream 404 on an unknown job", async () => {
    expect((await req("/api/scan/rescan_9999999", aManager)).status).toBe(404);
    expect((await req("/api/scan/stream/rescan_9999999", aManager)).status).toBe(404);
    expect((await req("/api/scan/rescan_9999999", aManager, { method: "DELETE" })).status).toBe(404);
  });
});
