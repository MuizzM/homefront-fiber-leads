// Phantom-duplicate fix, end to end: POST /api/leads must tell the caller WHY an
// already-existing lead may not be on their map, instead of the old blind
// {existed:true} that let the client "select a pin" that never rendered → owner
// report "it says it already exists but there is no pin".
//
// The `visibility` object is ADDITIVE — it never changes what counts as a
// duplicate (tenant-scoped canonical key) — and its `reason` is computed in
// priority order: ungeocoded > hidden_status > out_of_scope > visible, using the
// SAME scope predicate every single-lead read uses (repCanAccessLead). This file
// drives the REAL Express server with the EXACT client-built POST body and pins
// each reason, plus the rep-name leak rule and tenant isolation.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];

const TENANT_A = 1;
const TENANT_B = 2;

type Person = { userId: number; memberId: number; session: string };

let personSeq = 0;
function person(name: string, role: string, tenantId = TENANT_A, opts: { reportsToId?: number | null } = {}): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}.${personSeq++}@existed-visibility.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId, reportsToId: opts.reportsToId ?? null } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

// EXACT shape the one-tap add / AddLeadSheet submit POST — coords always sent
// (the client has them), so the server's forward-geocode branch never fires.
function addLead(session: string, addr: { address: string; city: string; state: string; zip: string }, lat = 35.4, lng = -80.5) {
  return fetch(`${baseUrl}/api/leads`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session },
    body: JSON.stringify({ ...addr, leadStatus: "prospect", lat, lng }),
  });
}

// Seed an EXISTING lead in whatever state a test needs (ungeocoded, held-back
// status, assigned to a given rep) so the POST above hits the existed branch.
function seedLead(over: Record<string, unknown>) {
  return storage.createLead({
    city: "Concord", state: "NC", zip: "28025",
    fiberStatus: "unknown", leadStatus: "prospect",
    tenantId: TENANT_A, lat: 35.41, lng: -80.58,
    ...over,
  } as any);
}

const fx: Record<string, Person> = {};

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-existed-visibility-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;

  const { rawDb } = await import("../../server/db");
  rawDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
     VALUES (?, 'existed-visibility-b', 'Existed Visibility B', 'Owner B', 'ev-owner-b@example.com', 'Existed Visibility B')`,
  ).run(TENANT_B);

  // Team A and Team B under one manager. A rep can't POST /api/leads
  // (requireTeamLead), so the scoped "out of scope" caller is team_lead B.
  fx.manager = person("Mona Manager", "manager");
  fx.leadA = person("Lena LeadA", "team_lead", TENANT_A, { reportsToId: fx.manager.memberId });
  fx.repA = person("Randy RepA", "rep", TENANT_A, { reportsToId: fx.leadA.memberId });
  fx.leadB = person("Levi LeadB", "team_lead", TENANT_A, { reportsToId: fx.manager.memberId });

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

describe("POST /api/leads existed branch - visibility.reason", () => {
  it("visible: geocoded, in scope, normal status → reason 'visible' and the assigned rep is named", async () => {
    const addr = { address: "700 Visible Road", city: "Concord", state: "NC", zip: "28025" };
    seedLead({ ...addr, assignedRepId: fx.repA.memberId, leadStatus: "prospect", lat: 35.41, lng: -80.58 });

    const res = await addLead(fx.leadA.session, addr);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.existed).toBe(true);
    expect(body.visibility).toMatchObject({
      geocoded: true, hiddenStatus: null, inYourScope: true, reason: "visible",
      assignedRepName: "Randy RepA",
    });
  });

  it("ungeocoded: existing row has null lat/lng → reason 'ungeocoded' (highest priority)", async () => {
    const addr = { address: "701 Ungeocoded Road", city: "Concord", state: "NC", zip: "28025" };
    seedLead({ ...addr, assignedRepId: fx.repA.memberId, lat: null, lng: null });

    const res = await addLead(fx.leadA.session, addr);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.existed).toBe(true);
    expect(body.visibility.reason).toBe("ungeocoded");
    expect(body.visibility.geocoded).toBe(false);
    expect(body.visibility.inYourScope).toBe(true);
    // Caller may access it → the rep name is allowed.
    expect(body.visibility.assignedRepName).toBe("Randy RepA");
  });

  it("hidden_status: suppressing lead_status (address_review) → reason 'hidden_status'", async () => {
    const addr = { address: "702 Held Back Road", city: "Concord", state: "NC", zip: "28025" };
    seedLead({ ...addr, assignedRepId: fx.repA.memberId, leadStatus: "address_review", lat: 35.41, lng: -80.58 });

    const res = await addLead(fx.leadA.session, addr);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.visibility.reason).toBe("hidden_status");
    expect(body.visibility.hiddenStatus).toBe("address_review");
    expect(body.visibility.geocoded).toBe(true);
  });

  it("out_of_scope: assigned to another team → reason 'out_of_scope' and NO rep-name leak to the scoped caller", async () => {
    const addr = { address: "703 Other Team Road", city: "Concord", state: "NC", zip: "28025" };
    seedLead({ ...addr, assignedRepId: fx.repA.memberId, leadStatus: "prospect", lat: 35.41, lng: -80.58 });

    // team_lead B is scoped to team B; the lead belongs to team A's rep.
    const res = await addLead(fx.leadB.session, addr);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.visibility.reason).toBe("out_of_scope");
    expect(body.visibility.inYourScope).toBe(false);
    // The out-of-scope caller must NEVER learn another team's rep name.
    expect(body.visibility.assignedRepName).toBeNull();
  });

  it("a manager (org-wide scope) posting the SAME out-of-scope address DOES learn the rep name", async () => {
    // Same address the previous case seeded (one lead, tenant-scoped canonical
    // key) — the manager's scope is org-wide, so it is 'visible' to them and the
    // rep name is permitted.
    const addr = { address: "703 Other Team Road", city: "Concord", state: "NC", zip: "28025" };
    const res = await addLead(fx.manager.session, addr);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.existed).toBe(true);
    expect(body.visibility.inYourScope).toBe(true);
    expect(body.visibility.reason).toBe("visible");
    expect(body.visibility.assignedRepName).toBe("Randy RepA");
  });

  it("tenant isolation: an address that exists only in ANOTHER tenant is NOT a duplicate → creates new (201)", async () => {
    const addr = { address: "704 Cross Tenant Road", city: "Concord", state: "NC", zip: "28025" };
    // Seed the address under tenant B only.
    storage.createLead({
      ...addr, fiberStatus: "unknown", leadStatus: "prospect",
      tenantId: TENANT_B, lat: 35.42, lng: -80.59,
    } as any);

    // A tenant-A caller posts the same address — must NOT see tenant B's lead.
    const res = await addLead(fx.leadA.session, addr);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.existed).not.toBe(true);
    expect(body.visibility).toBeUndefined();
    // Two independent rows now exist for the same address, one per tenant.
    const { rawDb } = await import("../../server/db");
    const rows = rawDb.prepare("SELECT tenant_id FROM leads WHERE address = ? ORDER BY tenant_id")
      .all("704 Cross Tenant Road") as Array<{ tenant_id: number }>;
    expect(rows.map((r) => r.tenant_id)).toEqual([TENANT_A, TENANT_B]);
  });
});
