// FCC adopt-on-tap (#61), end to end: a one-tap add onto an UNWORKED fcc-imported
// "ghost" lead must NOT dead-end on "already exists / no pin". POST /api/leads
// ADOPTS that ghost — retags it off fcc, drops it at the tapped rooftop, assigns
// it to the tapping rep, and returns {existed:true, adopted:true} — so the map
// draws the rep's own live pin instead of flashing a phantom. A worked/sold or
// non-fcc row keeps today's honest {existed:true} response, unchanged.
//
// This drives the REAL Express server with the EXACT one-tap-add POST body (coords
// always sent, leadStatus:"prospect"), and — per the MAP-PIPELINE RULE — asserts
// the adopted pin actually appears in a subsequent viewport (bbox) map query, not
// just that the row mutated. The adoptable guard is the SAME "removable" predicate
// the FCC purge deletes with (fcc-family tag + zero history), so this file pins:
//   (a) unworked fcc → adopted, retagged, geocoded, assigned, IN the viewport
//   (b) worked fcc (a knock) → honest-exists, NOT adopted, row untouched
//   (c) non-fcc existing → honest-exists preserved (NOT adopted)
//   (d) brand-new address → normal create (201, existed not set)
// plus money-equivalence (adoption writes NO commission/statement rows), tenant
// isolation (never adopt another tenant's fcc ghost), RBAC (only a lead+ may
// create/adopt; the lead becomes theirs), and idempotency (second tap → honest
// duplicate, no error, no second mutation).
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
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

type Person = { userId: number; memberId: number; session: string };

let personSeq = 0;
function person(name: string, role: string, tenantId = TENANT_A, opts: { reportsToId?: number | null } = {}): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}.${personSeq++}@fcc-adopt.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId, reportsToId: opts.reportsToId ?? null } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

// EXACT shape the one-tap add POST — coords always sent (the client reverse-
// geocodes the rooftop before POSTing), so the server's forward-geocode branch
// never fires; leadStatus:"prospect" like the client sends.
function addLead(session: string, addr: { address: string; city: string; state: string; zip: string }, lat = 35.51, lng = -80.52) {
  return fetch(`${baseUrl}/api/leads`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session },
    body: JSON.stringify({ ...addr, leadStatus: "prospect", lat, lng }),
  });
}

// Seed an EXISTING fcc "ghost" (or any duplicate) so the POST above hits the
// existed branch. Defaults mirror a raw FCC import: fcc-tagged, prospect, at a
// coarse import coordinate a real rooftop tap will refine.
function seedLead(over: Record<string, unknown>, tenantId = TENANT_A) {
  return storage.createLead({
    city: "Kannapolis", state: "NC", zip: "28081",
    fiberStatus: "unknown", leadStatus: "prospect", leadTag: "fcc_fresh_block",
    tenantId, lat: 35.49, lng: -80.61,
    ...over,
  } as any);
}

const leadById = (id: number) => rawDb.prepare("SELECT * FROM leads WHERE id = ?").get(id) as any;
const countMoney = () => ({
  commissions: (rawDb.prepare("SELECT COUNT(*) c FROM commissions").get() as any).c,
  sales: (rawDb.prepare("SELECT COUNT(*) c FROM commission_sales").get() as any).c,
});

// A viewport that contains the tapped rooftop (35.51,-80.52) but NOT the coarse
// import coordinate (35.49,-80.61) — so a pin only lands here once it is adopted
// AND moved to the tap. bbox is minLng,minLat,maxLng,maxLat.
const BBOX = "-80.56,35.50,-80.48,35.53";
async function mapPinIds(session: string): Promise<Set<number>> {
  const r = await fetch(`${baseUrl}/api/leads/map?bbox=${encodeURIComponent(BBOX)}`, {
    headers: { "x-session-id": session, "x-csrf-token": session },
  });
  const body = await r.json();
  return new Set((body.pins ?? []).map((p: any) => p.id));
}

const fx: Record<string, Person> = {};

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-fcc-adopt-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));

  rawDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
     VALUES (?, 'fcc-adopt-b', 'FCC Adopt B', 'Owner B', 'fcc-adopt-b@example.com', 'FCC Adopt B')`,
  ).run(TENANT_B);

  fx.manager = person("Mona Manager", "manager");
  // team_lead is the smallest role that may create a lead (requireTeamLead), so
  // it is the "tapping rep" here: adoption assigns the ghost to their member id.
  fx.leadA = person("Lena LeadA", "team_lead", TENANT_A, { reportsToId: fx.manager.memberId });
  fx.leadB = person("Levi LeadB", "team_lead", TENANT_A, { reportsToId: fx.manager.memberId });
  fx.repA = person("Randy RepA", "rep", TENANT_A, { reportsToId: fx.leadA.memberId });
  fx.leadForeign = person("Fran Foreign", "team_lead", TENANT_B);

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

describe("POST /api/leads - FCC adopt-on-tap", () => {
  it("(a) unworked fcc ghost → adopted: retagged off fcc, moved to the tap, assigned to the rep, and IN the viewport", async () => {
    const addr = { address: "100 Adopt Ln", city: "Kannapolis", state: "NC", zip: "28081" };
    const ghost = seedLead({ ...addr });
    // Precondition: fcc-tagged, unassigned, at the coarse import coordinate — so
    // it is NOT yet in the tap viewport.
    expect(leadById(ghost.id).lead_tag).toBe("fcc_fresh_block");
    expect(await mapPinIds(fx.leadA.session)).not.toContain(ghost.id);

    const money0 = countMoney();
    const res = await addLead(fx.leadA.session, addr, 35.51, -80.52);
    expect(res.status).toBe(200);
    const body = await res.json();

    // Response shape the client keys on to take the success (reconcile) path.
    expect(body.existed).toBe(true);
    expect(body.adopted).toBe(true);
    expect(body.id).toBe(ghost.id);
    expect(body.visibility).toEqual({
      geocoded: true, hiddenStatus: null, inYourScope: true,
      assignedRepName: "Lena LeadA", reason: "visible",
    });

    // The row itself: same id, retagged OFF fcc, dropped at the tapped rooftop,
    // now the tapping rep's own lead.
    const row = leadById(ghost.id);
    expect(row.lead_tag).toBeNull();
    expect(row.lat).toBeCloseTo(35.51, 5);
    expect(row.lng).toBeCloseTo(-80.52, 5);
    expect(row.assigned_rep_id).toBe(fx.leadA.memberId);

    // MAP-PIPELINE RULE: the pin must now appear in the viewport map query.
    expect(await mapPinIds(fx.leadA.session)).toContain(ghost.id);

    // Money-equivalence: adoption is not a sale — no commission/statement row.
    expect(countMoney()).toEqual(money0);

    // One audit row records the adoption.
    const audits = rawDb.prepare("SELECT * FROM admin_audit WHERE action = 'lead.fcc_adopted' AND target_id = ?").all(String(ghost.id)) as any[];
    expect(audits).toHaveLength(1);
    expect(audits[0].tenant_id).toBe(TENANT_A);
  });

  it("(a-idempotent) a second tap on the now-adopted door → honest duplicate (existed, NOT adopted), no error, no second mutation", async () => {
    const addr = { address: "100 Adopt Ln", city: "Kannapolis", state: "NC", zip: "28081" };
    const before = leadById((await (await addLead(fx.leadA.session, addr)).json()).id);
    // The lead is no longer fcc-tagged, so the adoptable guard matches nothing.
    const res = await addLead(fx.leadA.session, addr, 35.515, -80.525);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.existed).toBe(true);
    expect(body.adopted).toBeUndefined();
    // No second mutation: coords/tag/assignment unchanged by the re-tap.
    const after = leadById(before.id);
    expect(after.lead_tag).toBeNull();
    expect(after.lat).toBeCloseTo(before.lat, 5);
    expect(after.assigned_rep_id).toBe(before.assigned_rep_id);
    // No second audit row.
    const audits = rawDb.prepare("SELECT COUNT(*) c FROM admin_audit WHERE action = 'lead.fcc_adopted' AND target_id = ?").get(String(before.id)) as any;
    expect(audits.c).toBe(1);
  });

  it("(b) worked fcc door (has a knock) → honest-exists, NOT adopted, row untouched", async () => {
    const addr = { address: "200 Worked Ln", city: "Kannapolis", state: "NC", zip: "28081" };
    const ghost = seedLead({ ...addr });
    storage.createKnock({ leadId: ghost.id, repId: fx.repA.memberId, wasHome: false, outcome: "not_home" } as any);
    const before = leadById(ghost.id);

    const res = await addLead(fx.leadA.session, addr, 35.51, -80.52);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.existed).toBe(true);
    expect(body.adopted).toBeUndefined();
    // Worked → left exactly as it was: still fcc-tagged, unassigned, unmoved.
    const after = leadById(ghost.id);
    expect(after.lead_tag).toBe("fcc_fresh_block");
    expect(after.assigned_rep_id).toBe(before.assigned_rep_id ?? null);
    expect(after.lat).toBeCloseTo(before.lat, 5);
    expect(rawDb.prepare("SELECT COUNT(*) c FROM admin_audit WHERE action='lead.fcc_adopted' AND target_id=?").get(String(ghost.id)) as any).toEqual({ c: 0 });
  });

  it("(c) non-fcc existing lead → honest-exists preserved, NOT adopted", async () => {
    const addr = { address: "300 Organic Ln", city: "Kannapolis", state: "NC", zip: "28081" };
    // A plain (non-fcc) door assigned to another team → honest 'out_of_scope'.
    const existing = seedLead({ ...addr, leadTag: null, assignedRepId: fx.repA.memberId, lat: 35.51, lng: -80.52 });
    const before = leadById(existing.id);

    // team_lead B is scoped to team B; the door belongs to team A's rep.
    const res = await addLead(fx.leadB.session, addr, 35.51, -80.52);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.existed).toBe(true);
    expect(body.adopted).toBeUndefined();
    expect(body.visibility.reason).toBe("out_of_scope");
    // Untouched — not fcc, so never adoptable regardless of scope.
    const after = leadById(existing.id);
    expect(after.assigned_rep_id).toBe(before.assigned_rep_id);
    expect(after.lead_tag).toBeNull();
  });

  it("(d) brand-new address → normal create (201, existed not set)", async () => {
    const addr = { address: "400 Fresh Ln", city: "Kannapolis", state: "NC", zip: "28081" };
    const res = await addLead(fx.leadA.session, addr, 35.51, -80.52);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.existed).toBeUndefined();
    expect(body.adopted).toBeUndefined();
    expect(body.id).toBeGreaterThan(0);
  });

  it("tenant isolation: a tenant-A tap never adopts tenant-B's identical fcc ghost - it creates a new tenant-A lead (201)", async () => {
    const addr = { address: "500 Cross Tenant Ln", city: "Kannapolis", state: "NC", zip: "28081" };
    const foreign = seedLead({ ...addr }, TENANT_B); // fcc ghost under tenant B only
    const foreignBefore = leadById(foreign.id);

    const res = await addLead(fx.leadA.session, addr, 35.51, -80.52);
    // Not a duplicate in tenant A → a fresh tenant-A row, never a cross-tenant adopt.
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.adopted).toBeUndefined();
    // Tenant B's ghost never moved: same tag, coords, assignment.
    const foreignAfter = leadById(foreign.id);
    expect(foreignAfter.lead_tag).toBe("fcc_fresh_block");
    expect(foreignAfter.assigned_rep_id).toBe(foreignBefore.assigned_rep_id ?? null);
    expect(foreignAfter.lat).toBeCloseTo(foreignBefore.lat, 5);
    expect(foreignAfter.tenant_id).toBe(TENANT_B);
  });

  it("RBAC: a plain rep may not create/adopt (403); a team_lead may, and the adopted lead becomes theirs", async () => {
    const addr = { address: "600 Rbac Ln", city: "Kannapolis", state: "NC", zip: "28081" };
    const ghost = seedLead({ ...addr });

    // A rep can't even reach the create/adopt path.
    const denied = await addLead(fx.repA.session, addr, 35.51, -80.52);
    expect(denied.status).toBe(403);
    // The ghost is untouched by the denied call.
    expect(leadById(ghost.id).lead_tag).toBe("fcc_fresh_block");
    expect(leadById(ghost.id).assigned_rep_id).toBeNull();

    // A team_lead adopts; the lead becomes assigned to them (in their scope).
    const ok = await addLead(fx.leadA.session, addr, 35.51, -80.52);
    const body = await ok.json();
    expect(body.adopted).toBe(true);
    expect(leadById(ghost.id).assigned_rep_id).toBe(fx.leadA.memberId);
  });
});
