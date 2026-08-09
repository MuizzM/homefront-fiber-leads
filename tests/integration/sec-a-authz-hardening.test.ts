// SEC-A authz/money hardening regression tests — aggregated red-team board:
//  1  Super-admin protection: PATCH /api/users/:id apex immutability (role /
//     email / deactivation), POST /api/users apex-email claim block, and the
//     boot stamp staying authoritative once the re-email path is closed.
//  2  Legacy commission self-deal: a manager may not book money for themselves
//     (create) nor approve/pay their OWN commission rows (COMMISSION_SELF_DEAL).
//  5  NULL-tenant write walls: knock / central-disposition / ready-to-call /
//     territory family — adopted (NULL-tenant) rows are writable only by
//     default-tenant admins, invisible+unwritable to every other tenant, and
//     knock money NEVER falls back into the caller's tenant.
//  6  PATCH /api/knocks/:id team_lead scope + dangling leadId tenant wall.
//  7  GET /api/leads/ranked applies leadVisibilityScope like other lists.
//  8  Assignment tenant validation on /api/leads/:id/assign, bulk-assign, and
//     the lead PATCH assignedRepId allowlist field.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let storageModule: typeof import("../../server/storage");
let rawDb: any;
let resolveKnockSaleTenant: (typeof import("../../server/routes"))["resolveKnockSaleTenant"];

type Fixture = { userId: number; memberId: number; session: string };

function makePerson(name: string, loginRole: string, tenantId: number, memberRole = "rep", reportsToId: number | null = null): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}.${tenantId}@sec-a.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, reportsToId, tenantId } as any);
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function request(path: string, sessionId: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, ...(init.headers ?? {}) },
  });
}
const post = (path: string, session: string, body: unknown) =>
  request(path, session, { method: "POST", body: JSON.stringify(body) });
const patch = (path: string, session: string, body: unknown) =>
  request(path, session, { method: "PATCH", body: JSON.stringify(body) });
const get = (path: string, session: string) => request(path, session);

let TENANT_B = 0;
let admin1: Fixture, mgr1: Fixture, mgrOther: Fixture, tl1: Fixture, rep1: Fixture, repOther: Fixture;
let adminB: Fixture, mgrB: Fixture, repB: Fixture;
let apexA: Fixture, apexB: Fixture;

let leadSeq = 0;
function makeLead(tenantId: number | null, over: { assignedRepId?: number | null } = {}) {
  leadSeq += 1;
  const lead = storage.createLead({
    address: `${7000 + leadSeq} Sec A Ln`, city: "Durham", state: "NC", zip: "27701",
    lat: 35.99, lng: -78.9, tenantId: tenantId ?? undefined, leadStatus: "prospect",
  } as any);
  if (tenantId == null) rawDb.prepare("UPDATE leads SET tenant_id = NULL WHERE id = ?").run(lead.id);
  if (over.assignedRepId != null) storage.updateLead(lead.id, { assignedRepId: over.assignedRepId } as any);
  return storage.getLeadById(lead.id) as any;
}

let knockSeq = 0;
async function knock(leadId: number, session: string, outcome = "not_home", extra: Record<string, unknown> = {}) {
  knockSeq += 1;
  const res = await post(`/api/leads/${leadId}/knock`, session, {
    outcome, knockedAt: new Date().toISOString(), clientId: `seca-${knockSeq}`, ...extra,
  });
  return { status: res.status, body: (await res.json()) as any };
}

const savedApexEnv = process.env.SUPER_ADMIN_EMAILS;
function setApexEnv(...emails: string[]) {
  process.env.SUPER_ADMIN_EMAILS = emails.join(",");
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-sec-a-"));
  process.env.NODE_ENV = "test";
  storageModule = await import("../../server/storage");
  storageModule.runMigrations(); // creates + adopts the default tenant (id 1)
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  TENANT_B = storage.createTenant({
    slug: "sec-a-b", companyName: "Org B", ownerName: "B Owner",
    ownerEmail: "owner-b@sec-a.example.test", brandName: "Org B",
  } as any).id;

  // This suite pins pre-hold authz hardening on the legacy lifecycle; the
  // install hold is default-ON (tenant_pay_policy), so opt both fixture
  // tenants OUT — the hold has dedicated coverage in
  // tests/integration/commission-hold.test.ts.
  for (const tid of [1, TENANT_B]) {
    rawDb.prepare(
      "INSERT OR REPLACE INTO tenant_pay_policy (tenant_id, require_install_confirm, hold_days, updated_at) VALUES (?, 0, 90, datetime('now'))",
    ).run(tid);
  }

  admin1 = makePerson("Seca Admin One", "admin", 1, "manager");
  mgr1 = makePerson("Seca Mgr One", "manager", 1, "manager");
  mgrOther = makePerson("Seca Mgr Two", "manager", 1, "manager");
  tl1 = makePerson("Seca Lead One", "team_lead", 1, "team_lead");
  rep1 = makePerson("Seca Rep One", "rep", 1, "rep", tl1.memberId);
  repOther = makePerson("Seca Rep Other", "rep", 1, "rep"); // no team
  adminB = makePerson("Seca Admin Bee", "admin", TENANT_B, "manager");
  mgrB = makePerson("Seca Mgr Bee", "manager", TENANT_B, "manager");
  repB = makePerson("Seca Rep Bee", "rep", TENANT_B, "rep");

  // Platform apex identities: role admin + the immutable is_super_admin stamp
  // (stamped at boot from SUPER_ADMIN_EMAILS; set directly for the fixture).
  apexA = makePerson("Apex Alpha", "admin", 1, "manager");
  apexB = makePerson("Apex Beta", "admin", 1, "manager");
  rawDb.prepare("UPDATE users SET is_super_admin = 1 WHERE id IN (?, ?)").run(apexA.userId, apexB.userId);
  const apexEmails = rawDb.prepare("SELECT id, email FROM users WHERE id IN (?, ?)").all(apexA.userId, apexB.userId) as any[];
  setApexEnv(...apexEmails.map((u) => u.email));

  const routes = await import("../../server/routes");
  resolveKnockSaleTenant = routes.resolveKnockSaleTenant;
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  routes.registerRoutes(server, app);
  routes.registerSaasRoutes(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (savedApexEnv === undefined) delete process.env.SUPER_ADMIN_EMAILS;
  else process.env.SUPER_ADMIN_EMAILS = savedApexEnv;
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

const apexEmailOf = (fx: Fixture) =>
  (rawDb.prepare("SELECT email FROM users WHERE id = ?").get(fx.userId) as any).email as string;

// ── Fix 1c first: the boot stamp re-run adopts NULL rows, so it must run BEFORE
// any NULL-tenant fixture below is created.
describe("Fix 1c - boot stamp stays authoritative (re-email path closed by 1a)", () => {
  it("re-stamps on env-list change: an email leaving the list loses the flag at boot", async () => {
    const stamped = makePerson("Boot Apex", "admin", 1, "manager");
    const email = apexEmailOf(stamped);
    setApexEnv(email);
    storageModule.runMigrations();
    expect((rawDb.prepare("SELECT is_super_admin AS f FROM users WHERE id = ?").get(stamped.userId) as any).f).toBe(1);

    // The email leaves the list (ops change) → next boot clears ownership.
    // The ONLY other way off the list — re-emailing the row — is blocked by 1a.
    setApexEnv("someone-else@sec-a.example.test");
    storageModule.runMigrations();
    expect((rawDb.prepare("SELECT is_super_admin AS f FROM users WHERE id = ?").get(stamped.userId) as any).f).toBe(0);

    // Restore the fixture apex pair for the remaining tests.
    setApexEnv(apexEmailOf(apexA), apexEmailOf(apexB));
    storageModule.runMigrations();
    expect((rawDb.prepare("SELECT is_super_admin AS f FROM users WHERE id = ?").get(apexA.userId) as any).f).toBe(1);
  });
});

describe("Fix 1a - PATCH /api/users/:id super-admin immutability", () => {
  it("blocks a role change on a super admin (409 APEX_IMMUTABLE)", async () => {
    const res = await patch(`/api/users/${apexA.userId}`, admin1.session, { role: "manager" });
    expect(res.status).toBe(409);
    expect((await res.json() as any).code).toBe("APEX_IMMUTABLE");
  });

  it("blocks an email change on a super admin (409 APEX_IMMUTABLE) - the re-email-to-escape path", async () => {
    const res = await patch(`/api/users/${apexA.userId}`, admin1.session, { email: "escaped@sec-a.example.test" });
    expect(res.status).toBe(409);
    expect((await res.json() as any).code).toBe("APEX_IMMUTABLE");
    // And a no-op email (same value) is not a "change" — an apex admin may
    // still touch the row for ordinary fields.
    const same = await patch(`/api/users/${apexA.userId}`, apexB.session, { email: apexEmailOf(apexA) });
    expect(same.status).toBe(200);
  });

  it("blocks deactivation in the single-apex case - always", async () => {
    setApexEnv(apexEmailOf(apexA)); // one apex only
    try {
      const byAdmin = await patch(`/api/users/${apexA.userId}`, admin1.session, { active: false });
      expect(byAdmin.status).toBe(409);
      expect((await byAdmin.json() as any).code).toBe("APEX_IMMUTABLE");
      const bySelf = await patch(`/api/users/${apexA.userId}`, apexA.session, { active: false });
      expect(bySelf.status).toBe(409);
    } finally {
      setApexEnv(apexEmailOf(apexA), apexEmailOf(apexB));
    }
  });

  it("blocks deactivation by a non-apex admin even in a multi-apex deployment", async () => {
    const res = await patch(`/api/users/${apexA.userId}`, admin1.session, { active: false });
    expect(res.status).toBe(409);
    expect((await res.json() as any).code).toBe("APEX_IMMUTABLE");
  });

  it("permits deactivation only from a DIFFERENT super admin (multi-apex)", async () => {
    const res = await patch(`/api/users/${apexA.userId}`, apexB.session, { active: false });
    expect(res.status).toBe(200);
    // Restore: reactivation is not a deactivation, so the guard does not fire.
    const back = await patch(`/api/users/${apexA.userId}`, apexB.session, { active: true });
    expect(back.status).toBe(200);
    // Deactivation revoked apexA's sessions — mint a fresh one for later tests.
    apexA.session = storage.createSession(apexA.userId).id;
  });
});

describe("Fix 1b - POST /api/users apex-email claim block", () => {
  it("a tenant admin cannot CREATE a login on an apex email (403 LOGIN_EMAIL_RESERVED)", async () => {
    const res = await post("/api/users", admin1.session, {
      name: "Fake Apex", email: apexEmailOf(apexA), role: "rep",
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("LOGIN_EMAIL_RESERVED");
  });

  it("an existing apex admin MAY provision an apex-listed email", async () => {
    setApexEnv(apexEmailOf(apexA), apexEmailOf(apexB), "apex-gamma@sec-a.example.test");
    try {
      const res = await post("/api/users", apexA.session, {
        name: "Apex Gamma", email: "apex-gamma@sec-a.example.test", role: "admin",
      });
      expect(res.status).toBe(201);
    } finally {
      setApexEnv(apexEmailOf(apexA), apexEmailOf(apexB));
    }
  });

  it("PATCH still refuses to move an ordinary login onto an apex email (403 LOGIN_EMAIL_RESERVED)", async () => {
    const res = await patch(`/api/users/${rep1.userId}`, admin1.session, { email: apexEmailOf(apexA) });
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("LOGIN_EMAIL_RESERVED");
  });
});

describe("Fix 2 - legacy commission self-deal", () => {
  it("manager POST /api/commissions for THEMSELVES → 403 COMMISSION_SELF_DEAL; for another rep → 200", async () => {
    const self = await post("/api/commissions", mgr1.session, {
      repId: mgr1.memberId, amount: 5000, saleDate: "2026-01-05",
    });
    expect(self.status).toBe(403);
    expect((await self.json() as any).code).toBe("COMMISSION_SELF_DEAL");

    const other = await post("/api/commissions", mgr1.session, {
      repId: rep1.memberId, amount: 5000, saleDate: "2026-01-05",
    });
    expect(other.status).toBe(200);
  });

  it("manager cannot APPROVE their own commission row; another manager can", async () => {
    const comm = storage.createCommission({
      repId: mgr1.memberId, amount: 7000, saleDate: "2026-01-06",
      status: "pending", approvedBy: null, paidDate: null,
    } as any);
    const self = await patch(`/api/commissions/${comm.id}`, mgr1.session, {
      expectedRevision: comm.revision, expectedStatus: "pending", status: "approved",
    });
    expect(self.status).toBe(403);
    expect((await self.json() as any).code).toBe("COMMISSION_SELF_DEAL");

    const other = await patch(`/api/commissions/${comm.id}`, mgrOther.session, {
      expectedRevision: comm.revision, expectedStatus: "pending", status: "approved",
    });
    expect(other.status).toBe(200);
    expect((await other.json() as any).status).toBe("approved");
  });

  it("manager cannot mark their own commission PAID; the payouts.pay admin can", async () => {
    const seeded = storage.createCommission({
      repId: mgr1.memberId, amount: 9000, saleDate: "2026-01-07",
      status: "approved", approvedBy: mgrOther.userId, paidDate: null,
    } as any);
    const self = await patch(`/api/commissions/${seeded.id}`, mgr1.session, {
      expectedRevision: seeded.revision, expectedStatus: "approved", status: "paid", paidDate: "2026-01-10",
    });
    expect(self.status).toBe(403);
    expect((await self.json() as any).code).toBe("COMMISSION_SELF_DEAL");

    // admin1 holds payouts.pay AND is a different person than the rep.
    const adminPays = await patch(`/api/commissions/${seeded.id}`, admin1.session, {
      expectedRevision: seeded.revision, expectedStatus: "approved", status: "paid", paidDate: "2026-01-10",
    });
    expect(adminPays.status).toBe(200);
    expect((await adminPays.json() as any).status).toBe("paid");
  });

  it("an admin holding payouts.pay may still book a commission for themselves", async () => {
    const res = await post("/api/commissions", admin1.session, {
      repId: admin1.memberId, amount: 1000, saleDate: "2026-01-08",
    });
    expect(res.status).toBe(200);
  });
});

describe("Fix 5 - NULL-tenant write walls", () => {
  it("knock POST: foreign-tenant users get 404 on a NULL-tenant lead; only a default-tenant admin may write", async () => {
    const lead = makeLead(null);
    expect((await knock(lead.id, repB.session)).status).toBe(404);
    expect((await knock(lead.id, mgrB.session)).status).toBe(404);
    expect((await knock(lead.id, adminB.session)).status).toBe(404);
    // Non-admin roles of the DEFAULT tenant are excluded too (adopted rows are
    // default-org-admin writes).
    expect((await knock(lead.id, rep1.session)).status).toBe(404);
    expect((await knock(lead.id, mgr1.session)).status).toBe(404);
    const ok = await knock(lead.id, admin1.session, "not_home", { repId: admin1.memberId });
    expect(ok.status).toBe(201);
  });

  it("knock money never cross-books: no commission/knock lands in the caller's tenant for a NULL-tenant lead", async () => {
    const lead = makeLead(null);
    const sold = await knock(lead.id, mgrB.session, "sold", { repId: mgrB.memberId });
    expect(sold.status).toBe(404);
    const knocks = rawDb.prepare("SELECT COUNT(*) AS n FROM knock_log WHERE lead_id = ?").get(lead.id) as any;
    const comms = rawDb.prepare("SELECT COUNT(*) AS n FROM commissions WHERE lead_id = ?").get(lead.id) as any;
    expect(knocks.n).toBe(0);
    expect(comms.n).toBe(0);
  });

  it("resolveKnockSaleTenant: the caller's session tenant is never a fallback", () => {
    expect(resolveKnockSaleTenant(5, 1)).toBe(5);      // knock row wins
    expect(resolveKnockSaleTenant(null, 1)).toBe(1);    // adopted-row default only
    expect(resolveKnockSaleTenant(null, null)).toBe(null); // unresolvable → 409
    expect(resolveKnockSaleTenant(undefined, null)).toBe(null);
  });

  it("central-disposition: foreign manager → 404 on a NULL-tenant lead; default admin → 200", async () => {
    const lead = makeLead(null);
    const foreign = await post(`/api/leads/${lead.id}/central-disposition`, mgrB.session, { outcome: "not_interested" });
    expect(foreign.status).toBe(404);
    const ok = await post(`/api/leads/${lead.id}/central-disposition`, admin1.session, { outcome: "not_interested" });
    expect(ok.status).toBe(200);
  });

  it("ready-to-call claim/outcome: foreign-tenant users → 404 on a NULL-tenant lead", async () => {
    const lead = makeLead(null);
    expect((await post(`/api/ready-to-call/${lead.id}/claim`, repB.session, {})).status).toBe(404);
    expect((await post(`/api/ready-to-call/${lead.id}/outcome`, mgrB.session, { outcome: "not_interested" })).status).toBe(404);
    expect((await post(`/api/ready-to-call/${lead.id}/claim`, admin1.session, {})).status).toBe(200);
  });

  it("territory family: NULL-tenant area is invisible to other tenants and writable only by a default-tenant admin", async () => {
    const t = storage.createTerritory({
      tenantId: 1, name: "SecA Null Area", repId: rep1.memberId,
      polygon: JSON.stringify([[0, 0], [0, 1], [1, 0]]), color: "#14C985",
      status: "active", assigneeIds: JSON.stringify([rep1.memberId]), updatedAt: new Date().toISOString(),
    } as any);
    rawDb.prepare("UPDATE territories SET tenant_id = NULL WHERE id = ?").run(t.id);

    // Reads: foreign org → 404; default tenant → visible.
    expect((await get(`/api/territories/${t.id}/history`, mgrB.session)).status).toBe(404);
    expect((await get(`/api/territories/${t.id}/history`, admin1.session)).status).toBe(200);
    // Writes: foreign admin AND default-tenant non-admin → 404; default admin → 200.
    expect((await post(`/api/territories/${t.id}/complete`, adminB.session, {})).status).toBe(404);
    expect((await post(`/api/territories/${t.id}/complete`, mgr1.session, {})).status).toBe(404);
    expect((await post(`/api/territories/${t.id}/complete`, admin1.session, {})).status).toBe(200);
  });
});

describe("Fix 6 - PATCH /api/knocks/:id scope + dangling leadId", () => {
  it("team_lead may annotate their OWN team's knocks only", async () => {
    const teamLeadLead = makeLead(1, { assignedRepId: rep1.memberId });
    const k1 = await knock(teamLeadLead.id, rep1.session);
    expect(k1.status).toBe(201);

    const otherLead = makeLead(1, { assignedRepId: repOther.memberId });
    const k2 = await knock(otherLead.id, repOther.session);
    expect(k2.status).toBe(201);

    // Own team's rep → 200; another team's rep → 404 (no existence leak).
    expect((await patch(`/api/knocks/${k1.body.id}`, tl1.session, { notes: "team note" })).status).toBe(200);
    expect((await patch(`/api/knocks/${k2.body.id}`, tl1.session, { notes: "poach" })).status).toBe(404);
    // Reps still only annotate their own knocks.
    expect((await patch(`/api/knocks/${k2.body.id}`, rep1.session, { notes: "not mine" })).status).toBe(404);
  });

  it("a dangling leadId never skips the tenant wall (falls back to the knock row's tenant)", async () => {
    const lead = makeLead(1, { assignedRepId: rep1.memberId });
    const k = await knock(lead.id, rep1.session);
    expect(k.status).toBe(201);
    // Orphan the knock: the lead row goes away (raw delete — the guarded path
    // refuses history-bearing leads, which is exactly why this can only happen
    // via data repair).
    rawDb.prepare("DELETE FROM leads WHERE id = ?").run(lead.id);
    // Cross-tenant manager: previously the wall was SKIPPED on a dangling lead.
    expect((await patch(`/api/knocks/${k.body.id}`, mgrB.session, { notes: "cross-tenant" })).status).toBe(404);
    // Same-tenant manager still works (wall resolves via the knock row).
    expect((await patch(`/api/knocks/${k.body.id}`, mgr1.session, { notes: "orphan note" })).status).toBe(200);
  });
});

describe("Fix 7 - GET /api/leads/ranked visibility scope", () => {
  it("a rep ranks only their own book; a manager ranks the whole tenant", async () => {
    const now = new Date().toISOString();
    const insert = rawDb.prepare(
      `INSERT INTO leads (address, city, state, zip, tenant_id, lead_status, fresh_confirmed_at, assigned_rep_id, created_at, updated_at)
       VALUES (?, 'Ranktown', 'NC', '27707', 1, 'prospect', ?, ?, ?, ?)`,
    );
    insert.run("1 Ranked Scope Ln", now, rep1.memberId, now, now);
    insert.run("2 Ranked Scope Ln", now, repOther.memberId, now, now);
    insert.run("3 Ranked Scope Ln", now, null, now, now);

    const repRes = await get("/api/leads/ranked?limit=500", rep1.session);
    expect(repRes.status).toBe(200);
    const repLeads = ((await repRes.json()) as any).leads as any[];
    const repMarked = repLeads.filter((l) => l.address.endsWith("Ranked Scope Ln"));
    expect(repMarked.length).toBe(1);
    expect(repMarked[0].assignedRepId).toBe(rep1.memberId);

    const mgrRes = await get("/api/leads/ranked?limit=500", mgr1.session);
    expect(mgrRes.status).toBe(200);
    const mgrMarked = (((await mgrRes.json()) as any).leads as any[]).filter((l) => l.address.endsWith("Ranked Scope Ln"));
    expect(mgrMarked.length).toBe(3);
  });
});

describe("Fix 8 - assignment tenant validation", () => {
  it("POST /api/leads/:id/assign rejects a foreign member id (404), accepts an own-tenant rep", async () => {
    const lead = makeLead(1);
    const foreign = await post(`/api/leads/${lead.id}/assign`, admin1.session, { repId: mgrB.memberId });
    expect(foreign.status).toBe(404);
    const ok = await post(`/api/leads/${lead.id}/assign`, admin1.session, { repId: rep1.memberId });
    expect(ok.status).toBe(200);
  });

  it("POST /api/leads/bulk-assign rejects a foreign member id (404)", async () => {
    const lead = makeLead(1);
    const foreign = await post("/api/leads/bulk-assign", admin1.session, { leadIds: [lead.id], repId: mgrB.memberId });
    expect(foreign.status).toBe(404);
    const ok = await post("/api/leads/bulk-assign", admin1.session, { leadIds: [lead.id], repId: rep1.memberId });
    expect(ok.status).toBe(200);
  });

  it("PATCH /api/leads/:id assignedRepId rejects a foreign member id (404)", async () => {
    const lead = makeLead(1);
    const foreign = await patch(`/api/leads/${lead.id}`, mgr1.session, { assignedRepId: mgrB.memberId });
    expect(foreign.status).toBe(404);
    const ok = await patch(`/api/leads/${lead.id}`, mgr1.session, { assignedRepId: repOther.memberId });
    expect(ok.status).toBe(200);
    // Unassign (null) stays legal.
    const clear = await patch(`/api/leads/${lead.id}`, mgr1.session, { assignedRepId: null });
    expect(clear.status).toBe(200);
  });
});
