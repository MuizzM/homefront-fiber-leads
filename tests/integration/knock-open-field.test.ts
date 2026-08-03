// OPEN-FIELD KNOCKS (owner report: ~62k imported town leads carry
// assigned_rep_id=NULL AND assigned_territory_id=NULL — reps in the field got
// a 404 on every knock and the offline queue parked/retried the failure
// forever). A lead owned by NOBODY is unworked ground in the tenant pool: any
// scoped rep in the same tenant may knock it (self-serve), WITHOUT the knock
// assigning anything. Owned leads (another rep, another team's area) and
// other-tenant leads stay denied exactly as before.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TENANT_A = 1;
const TENANT_B = 2;

let server: Server;
let baseUrl: string;
let storage: any;
let rawDb: any;

type Fixture = { userId: number; memberId: number; session: string };

function person(name: string, loginRole: string, tenantId: number, memberRole = "rep"): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}.${tenantId}@openfield.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, reportsToId: null, tenantId });
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id });
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

let leadSeq = 0;
function makeLead(tenantId: number, over: { assignedRepId?: number | null; assignedTerritoryId?: number | null } = {}) {
  leadSeq += 1;
  const lead = storage.createLead({
    address: `${9000 + leadSeq} Open Field Rd`, city: "Durham", state: "NC", zip: "27701",
    lat: 35.99, lng: -78.9, tenantId, leadStatus: "prospect",
  });
  if (over.assignedRepId != null) storage.updateLead(lead.id, { assignedRepId: over.assignedRepId });
  if (over.assignedTerritoryId != null) storage.updateLead(lead.id, { assignedTerritoryId: over.assignedTerritoryId });
  return storage.getLeadById(lead.id);
}

function request(path: string, sessionId: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, ...(init.headers ?? {}) },
  });
}

let knockSeq = 0;
async function knock(leadId: number, session: string, outcome = "not_home", extra: Record<string, unknown> = {}) {
  knockSeq += 1;
  const res = await request(`/api/leads/${leadId}/knock`, session, {
    method: "POST",
    body: JSON.stringify({ outcome, knockedAt: new Date().toISOString(), clientId: `of-${knockSeq}`, ...extra }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const knockCountFor = (leadId: number) =>
  (rawDb.prepare("SELECT COUNT(*) AS n FROM knock_log WHERE lead_id = ?").get(leadId) as any).n as number;

let mgr: Fixture, repA: Fixture, repB: Fixture, foreignRep: Fixture;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-open-field-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  rawDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
     VALUES (?, 'beacon-of', 'Beacon Fiber', 'Owner B', 'owner-b@openfield.example.test', 'Beacon')`,
  ).run(TENANT_B);

  mgr = person("Of Manager", "manager", TENANT_A, "manager");
  repA = person("Of Rep A", "rep", TENANT_A);
  repB = person("Of Rep B", "rep", TENANT_A);
  foreignRep = person("Of Foreign", "rep", TENANT_B);

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

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

// Open field is OPT-IN and OFF by default (an org that imported a market's whole
// FCC footprint must not hand every rep every unowned door). This suite proves
// the feature still works for a tenant that WANTS it, so it switches it on.
beforeAll(() => { rawDb.prepare(`UPDATE tenants SET open_field_enabled = 1`).run(); });

describe("open field — a lead owned by nobody is workable by any rep in the tenant", () => {
  it("a rep knocks an unassigned lead (no rep, no territory) → 201, knock logged, NOTHING assigned", async () => {
    const lead = makeLead(TENANT_A); // assignedRepId NULL, assignedTerritoryId NULL
    const r = await knock(lead.id, repA.session, "interested");
    expect(r.status).toBe(201);
    expect(r.body.leadId).toBe(lead.id);
    expect(r.body.repId).toBe(repA.memberId); // the KNOCK credits the knocker…
    expect(knockCountFor(lead.id)).toBe(1);
    const after = storage.getLeadById(lead.id);
    expect(after.leadStatus).toBe("interested"); // …the outcome applies…
    expect(after.assignedRepId).toBeNull();      // …but access is not ownership:
    expect(after.assignedTerritoryId).toBeNull(); // no auto-assign side effect.
  });

  it("a SECOND rep can work the same open-field door — it belongs to no one", async () => {
    const lead = makeLead(TENANT_A);
    expect((await knock(lead.id, repA.session, "not_home")).status).toBe(201);
    expect((await knock(lead.id, repB.session, "not_home")).status).toBe(201);
    expect(knockCountFor(lead.id)).toBe(2);
  });

  it("the queue's idempotent RETRY of an open-field knock succeeds (deduped, one row)", async () => {
    // FIX 3: knocks that failed pre-fix with a scope 404 re-attempt with the
    // SAME clientId once the server opens — the retry path must deliver them.
    const lead = makeLead(TENANT_A);
    const clientId = `of-retry-${lead.id}`;
    const first = await knock(lead.id, repA.session, "interested", { clientId });
    expect(first.status).toBe(201);
    const replay = await knock(lead.id, repA.session, "interested", { clientId });
    expect(replay.status).toBe(200);
    expect(replay.body.deduped).toBe(true);
    expect(knockCountFor(lead.id)).toBe(1);
  });

  it("a rep can READ an open-field lead and its history (the card works end-to-end)", async () => {
    const lead = makeLead(TENANT_A);
    expect((await request(`/api/leads/${lead.id}`, repA.session)).status).toBe(200);
    expect((await knock(lead.id, repA.session)).status).toBe(201);
    expect((await request(`/api/leads/${lead.id}/knocks`, repB.session)).status).toBe(200);
    expect((await request(`/api/leads/${lead.id}/history`, repB.session)).status).toBe(200);
  });
});

describe("the walls that must NOT move", () => {
  it("a rep still cannot knock another rep's assigned lead → 404", async () => {
    const lead = makeLead(TENANT_A, { assignedRepId: repA.memberId });
    const r = await knock(lead.id, repB.session, "interested");
    expect(r.status).toBe(404);
    expect(knockCountFor(lead.id)).toBe(0);
    expect(storage.getLeadById(lead.id).leadStatus).toBe("prospect");
  });

  it("a cross-tenant unassigned lead is still a 404 — open field stops at the tenant wall", async () => {
    const lead = makeLead(TENANT_B); // nobody owns it, but it is not OUR nobody
    const r = await knock(lead.id, repA.session, "interested");
    expect(r.status).toBe(404);
    expect(knockCountFor(lead.id)).toBe(0);
    // And the foreign tenant's own rep CAN work it (open field, their tenant).
    expect((await knock(lead.id, foreignRep.session, "interested")).status).toBe(201);
  });

  it("an unassigned-rep lead sitting in ANOTHER rep's territory stays denied", async () => {
    const territory = storage.createTerritory({
      tenantId: TENANT_A, name: "Rep A area", repId: repA.memberId,
      polygon: JSON.stringify([[-78.9, 35.9], [-78.8, 35.9], [-78.8, 36.0], [-78.9, 36.0]]),
      color: "#123456", status: "active", assigneeIds: JSON.stringify([repA.memberId]),
    } as any);
    const lead = makeLead(TENANT_A, { assignedTerritoryId: territory.id }); // rep NULL, area owned
    expect((await knock(lead.id, repB.session, "interested")).status).toBe(404);
    expect((await knock(lead.id, repA.session, "interested")).status).toBe(201); // area holder works it
  });

  it("managers are unaffected — an unassigned lead knocks exactly as before", async () => {
    const lead = makeLead(TENANT_A);
    const r = await knock(lead.id, mgr.session, "not_home", { repId: mgr.memberId });
    expect(r.status).toBe(201);
    expect(storage.getLeadById(lead.id).assignedRepId).toBeNull();
  });

  it("reassignment rules are NOT widened: a team lead still cannot hand an open-field lead to another team", async () => {
    const leadA = person("Of Lead A", "team_lead", TENANT_A, "team_lead");
    const leadB = person("Of Lead B", "team_lead", TENANT_A, "team_lead");
    const repUnderB = storage.createTeamMember({
      name: "Of Rep Under B", email: "of.rep.under.b.1@openfield.example.test",
      role: "rep", active: true, reportsToId: leadB.memberId, tenantId: TENANT_A,
    });
    const lead = makeLead(TENANT_A);
    const res = await request(`/api/leads/${lead.id}/assign`, leadA.session, {
      method: "POST", body: JSON.stringify({ repId: repUnderB.id }),
    });
    expect(res.status).toBe(403);
    expect(storage.getLeadById(lead.id).assignedRepId).toBeNull();
  });
});
