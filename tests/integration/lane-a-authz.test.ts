// LANE-A authorization & money-capability regression tests — verified defect board:
//  A1  Money lifecycle was gated on a READ capability: POST /api/commission/
//      week/transition, statements/:id/transition, adjustments/:id/decide all sat
//      behind commission.read.all (manager). Now payouts.pay (admin only).
//      statements/recalculate moved from commission.read.team to
//      commission.statements.write (manager+).
//  A2  team_lead money fabrication: commission.structure.manage (rates) used to
//      guard POST /api/commission/sales + /adjustments. Split into
//      commission.sales.write / commission.adjustments.write (manager+ only).
//  A3  Manager login-retarget hijack: PATCH /api/team/:id may not change the
//      email of a member whose linked login ranks at/above the caller, and every
//      retarget is audited (team.login_email_retargeted, old+new+actor).
//  A4  super_admin was excluded from requireAdmin/requireManager/requireTeamLead
//      even though can() grants it the full ADMIN set.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: any;

type Fixture = { userId: number; memberId: number; session: string };

function makePerson(name: string, loginRole: string, tenantId: number, memberRole = "rep", reportsToId: number | null = null): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@lane-a.example.test`;
  const member = storage.createTeamMember({
    name, email, role: memberRole, active: true, reportsToId, tenantId,
  } as any);
  const user = storage.createUser({
    name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id,
  } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function request(path: string, sessionId: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, ...init.headers },
  });
}
const post = (path: string, session: string, body: unknown) =>
  request(path, session, { method: "POST", body: JSON.stringify(body) });
const patch = (path: string, session: string, body: unknown) =>
  request(path, session, { method: "PATCH", body: JSON.stringify(body) });

let TENANT_B = 0;
let admin1: Fixture, mgr1: Fixture, victim: Fixture, lowShell: Fixture;
let tl1: Fixture, rep1: Fixture, super1: Fixture;
let adminB: Fixture, mgrB: Fixture;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-lane-a-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations(); // creates + adopts the default tenant (id 1)
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  TENANT_B = storage.createTenant({
    slug: "lane-a-b", companyName: "Org B", ownerName: "B Owner",
    ownerEmail: "owner-b@lane-a.example.test", brandName: "Org B",
  } as any).id;

  admin1 = makePerson("Lane Admin One", "admin", 1, "manager");
  mgr1 = makePerson("Lane Mgr One", "manager", 1, "manager");
  victim = makePerson("Lane Mgr Victim", "manager", 1, "manager");
  // Low field role shielding a manager login — the hijack vector A3 closes.
  lowShell = makePerson("Lane Lowshell", "manager", 1, "rep");
  tl1 = makePerson("Lane Lead One", "team_lead", 1, "team_lead");
  rep1 = makePerson("Lane Rep One", "rep", 1, "rep", tl1.memberId);
  super1 = makePerson("Lane Super One", "super_admin", 1, "manager");
  adminB = makePerson("Lane Admin Bee", "admin", TENANT_B, "manager");
  mgrB = makePerson("Lane Mgr Bee", "manager", TENANT_B, "manager");

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

// Shared commission fixture: a FLAT structure on rep1, one QUALIFIED sale, and a
// calculated OPEN statement — built through the API as the roles under test.
let statementId = 0;
let adjustmentId = 0;

describe("A2 - team_lead money fabrication closed; manager books money", () => {
  it("team_lead POST /api/commission/sales → 403 even for an OWN-team rep; manager → 201", async () => {
    // Rate config stays team_lead-capable (structure.manage unchanged)…
    const assign = await post("/api/commission/assign-structure", admin1.session, {
      repId: rep1.memberId, structure: "FLAT", flatRateCents: 5000,
    });
    expect(assign.status).toBe(201);

    const sale = { repId: rep1.memberId, externalId: "lane-a-sale-1", soldAt: new Date().toISOString(), status: "QUALIFIED", qualifiedAt: new Date().toISOString() };
    const asLead = await post("/api/commission/sales", tl1.session, sale);
    expect(asLead.status).toBe(403); // cap gate fires before any scope logic

    const asMgr = await post("/api/commission/sales", mgr1.session, sale);
    expect(asMgr.status).toBe(201);
  });

  it("team_lead POST /api/commission/adjustments → 403; manager → 201", async () => {
    // Build the statement via the recalculate surface (tested for authz below).
    const recalc = await post("/api/commission/statements/recalculate", mgr1.session, {
      repId: rep1.memberId, week: new Date().toISOString(),
    });
    expect(recalc.status).toBe(200);
    statementId = (await recalc.json() as any).statement.id;
    expect(statementId).toBeGreaterThan(0);

    const body = { statementId, amountCents: -500, reason: "Lane A clawback" };
    const asLead = await post("/api/commission/adjustments", tl1.session, body);
    expect(asLead.status).toBe(403);

    const asMgr = await post("/api/commission/adjustments", mgr1.session, body);
    expect(asMgr.status).toBe(201);
    adjustmentId = (await asMgr.json() as any).id;
    expect(adjustmentId).toBeGreaterThan(0);
  });
});

describe("A1 - money lifecycle is payouts.pay (admin), never a manager read cap", () => {
  it("statements/recalculate is a WRITE cap: team_lead → 403, manager → 200", async () => {
    const asLead = await post("/api/commission/statements/recalculate", tl1.session, {
      repId: rep1.memberId, week: new Date().toISOString(),
    });
    expect(asLead.status).toBe(403);
    const asMgr = await post("/api/commission/statements/recalculate", mgr1.session, {
      repId: rep1.memberId, week: new Date().toISOString(),
    });
    expect(asMgr.status).toBe(200);
  });

  it("adjustments/:id/decide: manager (own + cross-tenant) → 403; cross-tenant admin → 404; own admin → 200", async () => {
    expect((await post(`/api/commission/adjustments/${adjustmentId}/decide`, mgr1.session, { decision: "APPROVE" })).status).toBe(403);
    expect((await post(`/api/commission/adjustments/${adjustmentId}/decide`, mgrB.session, { decision: "APPROVE" })).status).toBe(403);
    // The capability gate passes for an admin; the tenant wall then 404s.
    expect((await post(`/api/commission/adjustments/${adjustmentId}/decide`, adminB.session, { decision: "APPROVE" })).status).toBe(404);
    const own = await post(`/api/commission/adjustments/${adjustmentId}/decide`, admin1.session, { decision: "APPROVE" });
    expect(own.status).toBe(200);
    expect((await own.json() as any).adjustment.status).toBe("APPROVED");
  });

  it("statements/:id/transition: manager MARK_PAID → 403; admin FINALIZE + MARK_PAID → 200", async () => {
    expect((await post(`/api/commission/statements/${statementId}/transition`, mgr1.session, { action: "MARK_PAID" })).status).toBe(403);
    expect((await post(`/api/commission/statements/${statementId}/transition`, admin1.session, { action: "FINALIZE" })).status).toBe(200);
    const paid = await post(`/api/commission/statements/${statementId}/transition`, admin1.session, { action: "MARK_PAID" });
    expect(paid.status).toBe(200);
    expect((await paid.json() as any).status).toBe("PAID");
  });

  it("week/transition: manager MARK_PAID → 403; admin → 200 (both tenants)", async () => {
    expect((await post("/api/commission/week/transition", mgr1.session, { action: "MARK_PAID", week: new Date().toISOString() })).status).toBe(403);
    expect((await post("/api/commission/week/transition", admin1.session, { action: "MARK_PAID", week: new Date().toISOString() })).status).toBe(200);
    expect((await post("/api/commission/week/transition", mgrB.session, { action: "MARK_PAID", week: new Date().toISOString() })).status).toBe(403);
    expect((await post("/api/commission/week/transition", adminB.session, { action: "FINALIZE", week: new Date().toISOString() })).status).toBe(200);
  });
});

describe("A3 - login-email retarget hijack closed + audited", () => {
  it("manager cannot retarget a peer manager's member email; admin can, with an audit row", async () => {
    const hijack = await patch(`/api/team/${victim.memberId}`, mgr1.session, { email: "hijacked@lane-a.example.test" });
    expect(hijack.status).toBe(403);

    const ok = await patch(`/api/team/${victim.memberId}`, admin1.session, { email: "victim.new@lane-a.example.test" });
    expect(ok.status).toBe(200);
    // The linked LOGIN email moved too (that is the surface being guarded).
    const linked = rawDb.prepare("SELECT * FROM users WHERE team_member_id = ?").get(victim.memberId) as any;
    expect(linked.email).toBe("victim.new@lane-a.example.test");

    const audit = rawDb.prepare(
      "SELECT * FROM activity_log WHERE action = 'team.login_email_retargeted' AND entity_id = ? ORDER BY id DESC",
    ).get(victim.memberId) as any;
    expect(audit).toBeTruthy();
    expect(audit.user_id).toBe(admin1.userId);
    const details = JSON.parse(audit.details);
    expect(details.oldEmail).toBe("lane.mgr.victim@lane-a.example.test");
    expect(details.newEmail).toBe("victim.new@lane-a.example.test");
    expect(details.actorRole).toBe("admin");
  });

  it("a low field role cannot shield a higher login: manager retarget of a rep-row/manager-login member → 403", async () => {
    const res = await patch(`/api/team/${lowShell.memberId}`, mgr1.session, { email: "shell.pwned@lane-a.example.test" });
    expect(res.status).toBe(403);
    const linked = rawDb.prepare("SELECT * FROM users WHERE team_member_id = ?").get(lowShell.memberId) as any;
    expect(linked.email).toBe("lane.lowshell@lane-a.example.test"); // untouched
  });
});

describe("A4 - super_admin passes the role guards it was excluded from", () => {
  it("requireAdmin probe: GET /api/config/app", async () => {
    expect((await request("/api/config/app", super1.session)).status).toBe(200);
    expect((await request("/api/config/app", mgr1.session)).status).toBe(403); // unchanged for others
  });
  it("requireManager probe: GET /api/coverage/providers", async () => {
    expect((await request("/api/coverage/providers", super1.session)).status).toBe(200);
    expect((await request("/api/coverage/providers", tl1.session)).status).toBe(403); // team_lead still excluded
  });
  it("requireTeamLead probe: PATCH /api/team/:id (self profile field)", async () => {
    const res = await patch(`/api/team/${super1.memberId}`, super1.session, { name: "Lane Super One" });
    expect(res.status).toBe(200);
    expect((await request("/api/coverage/providers", rep1.session)).status).toBe(403); // rep still excluded
  });
});
