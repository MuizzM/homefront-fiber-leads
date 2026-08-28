// A manager may not reach into a PEER manager's branch.
//
// Authority used to be a pure RANK comparison: a manager outranks every rep and
// team lead anywhere in the tenant, and repInVisibilityScope waves managers
// through org-wide because it was written for LEAD visibility, not org-chart
// authority. So manager A could re-home, offboard, hard-delete, or re-price
// manager B's reps — the "stealing reps without admin approval" case.
//
// The rule added here is deliberately NOT "must be in my subtree". That version
// was designed, mapped against the code, and thrown away: top-level members
// belong to no subtree, so it would have stranded every new hire, every orphan
// left by an offboard, and every member pushed top-level by a promotion. This
// asks the narrower question — does this member already belong to a DIFFERENT
// active manager — which leaves unowned people adoptable and only refuses
// poaching. These tests pin both halves: what it blocks AND what it must keep
// allowing.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;

const TENANT = 1;
type Person = { userId: number; memberId: number; session: string };

let seq = 0;
function person(name: string, role: string, reportsToId: number | null = null, loginRole?: string): Person {
  seq += 1;
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}.${seq}@branch.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, reportsToId, tenantId: TENANT } as any);
  const user = storage.createUser({
    name, email, role: loginRole ?? role, active: true, tenantId: TENANT, teamMemberId: member.id,
  } as any);
  rawDb.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run((user as any).id);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

const req = (path: string, session: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...init.headers },
  });

const patchMember = (id: number, session: string, body: unknown) =>
  req(`/api/team/${id}`, session, { method: "PATCH", body: JSON.stringify(body) });
const offboard = (id: number, session: string) =>
  req(`/api/team/${id}/offboard`, session, { method: "POST", body: "{}" });
const del = (id: number, session: string) => req(`/api/team/${id}`, session, { method: "DELETE" });
const setRates = (id: number, session: string, body: unknown) =>
  req(`/api/commission/reps/${id}/override-rates`, session, { method: "PATCH", body: JSON.stringify(body) });

const reportsToOf = (id: number): number | null =>
  (rawDb.prepare("SELECT reports_to_id AS r FROM team_members WHERE id = ?").get(id) as any)?.r ?? null;

let admin: Person, mgrA: Person, mgrB: Person, leadA: Person, repA: Person, repB: Person;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-branch-authority-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  admin = person("Branch Admin", "admin");
  mgrA = person("Manager Alpha", "manager");
  mgrB = person("Manager Beta", "manager");
  leadA = person("Lead Alpha", "team_lead", mgrA.memberId);
  repA = person("Rep Alpha", "rep", leadA.memberId);
  repB = person("Rep Beta", "rep", mgrB.memberId);

  const { registerRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
});

describe("what the branch rule BLOCKS", () => {
  it("THE REQUIREMENT: manager A cannot re-home manager B's rep under themselves", async () => {
    const res = await patchMember(repB.memberId, mgrA.session, { reportsToId: mgrA.memberId });
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("OUT_OF_BRANCH");
    expect(reportsToOf(repB.memberId)).toBe(mgrB.memberId);   // did not move
  });

  it("nor rename, offboard, or hard-delete another branch's rep", async () => {
    expect((await patchMember(repB.memberId, mgrA.session, { name: "Renamed By A" })).status).toBe(403);
    expect((await offboard(repB.memberId, mgrA.session)).status).toBe(403);
    const removed = await del(repB.memberId, mgrA.session);
    expect(removed.status).toBe(403);
    expect((await removed.json() as any).code).toBe("OUT_OF_BRANCH");
    // Still there, still active, still under B.
    const row = rawDb.prepare("SELECT name, active, reports_to_id AS r FROM team_members WHERE id = ?").get(repB.memberId) as any;
    expect(row).toMatchObject({ name: "Rep Beta", active: 1, r: mgrB.memberId });
  });

  it("nor push their OWN rep into a peer's branch", async () => {
    const res = await patchMember(repA.memberId, mgrA.session, { reportsToId: mgrB.memberId });
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("OUT_OF_BRANCH");
  });

  it("THE SIDE DOOR: nor re-price another branch's member's overrides", async () => {
    // Managers hold commission.read.all, so readScope hands them every rep —
    // without this the same authority walks in through the money endpoint.
    const res = await setRates(repB.memberId, mgrA.session, { overrideTeamLeadCents: 9999 });
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("OUT_OF_BRANCH");
    const row = rawDb.prepare("SELECT override_team_lead_cents AS c FROM team_members WHERE id = ?").get(repB.memberId) as any;
    expect(row.c).toBeNull();
  });
});

describe("what it must keep ALLOWING", () => {
  it("a manager still runs their own branch - rename, re-home, re-price", async () => {
    expect((await patchMember(repA.memberId, mgrA.session, { name: "Rep Alpha Renamed" })).status).toBe(200);
    // Move their own rep from under their team lead to directly under themselves.
    expect((await patchMember(repA.memberId, mgrA.session, { reportsToId: mgrA.memberId })).status).toBe(200);
    expect(reportsToOf(repA.memberId)).toBe(mgrA.memberId);
    expect((await setRates(repA.memberId, mgrA.session, { overrideTeamLeadCents: 2500 })).status).toBe(200);
    // put it back for later tests
    await patchMember(repA.memberId, mgrA.session, { reportsToId: leadA.memberId });
  });

  it("an UNOWNED member is adoptable - the case the subtree rule would have stranded", async () => {
    // Nobody's branch: no manager anywhere above them.
    const orphan = person("Orphan Rep", "rep", null);
    const res = await patchMember(orphan.memberId, mgrA.session, { reportsToId: mgrA.memberId });
    expect(res.status).toBe(200);
    expect(reportsToOf(orphan.memberId)).toBe(mgrA.memberId);
  });

  it("a member orphaned BY an offboard stays reachable", async () => {
    // mgrC's rep is re-homed to mgrC's own supervisor (null) when mgrC leaves,
    // which drops them out of every branch. They must not become admin-only.
    const mgrC = person("Manager Gamma", "manager");
    const strandedRep = person("Stranded Rep", "rep", mgrC.memberId);
    expect((await offboard(mgrC.memberId, admin.session)).status).toBe(200);
    expect(reportsToOf(strandedRep.memberId)).toBeNull();

    expect((await patchMember(strandedRep.memberId, mgrA.session, { reportsToId: mgrA.memberId })).status).toBe(200);
  });

  it("a TEAM LEAD keeps acting on their own reps - their branch owner is the manager ABOVE them", async () => {
    // The naive branch rule refused this: branchOwnerOf(rep) is mgrA, which is
    // not the team lead, so a team lead could not offboard their own rep.
    const leadRep = person("Lead Owned Rep", "rep", leadA.memberId);
    expect((await patchMember(leadRep.memberId, leadA.session, { name: "Coached Rep" })).status).toBe(200);
    expect((await offboard(leadRep.memberId, leadA.session)).status).toBe(200);
  });

  it("an ADMIN arbitrates across branches - that is the transfer path", async () => {
    const res = await patchMember(repB.memberId, admin.session, { reportsToId: mgrA.memberId });
    expect(res.status).toBe(200);
    expect(reportsToOf(repB.memberId)).toBe(mgrA.memberId);
    await patchMember(repB.memberId, admin.session, { reportsToId: mgrB.memberId });   // restore
  });

  it("peer-manager refusals still report HIERARCHY_FORBIDDEN, not the branch code", async () => {
    // Rank is the real reason there, and the client's copy keys off the code.
    const res = await offboard(mgrB.memberId, mgrA.session);
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("HIERARCHY_FORBIDDEN");
  });

  it("a promoted member pushed to top level stays reachable by the manager who promoted them", async () => {
    // The interaction that killed the subtree design: promoting clears the
    // supervisor, so the member leaves the subtree in the same request.
    const climber = person("Climbing Rep", "rep", leadA.memberId);
    expect((await patchMember(climber.memberId, admin.session, { role: "team_lead" })).status).toBe(200);
    expect(reportsToOf(climber.memberId)).toBeNull();          // cleared: a lead can't report to a lead
    // Now unowned — mgrA can still pick them up rather than being locked out.
    expect((await patchMember(climber.memberId, mgrA.session, { reportsToId: mgrA.memberId })).status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P0: the same branch rule on the COMMISSION MONEY WRITES.
//
// The roster routes above have enforced this from the start, and
// PATCH /reps/:repId/override-rates closed "the side door". But the commission
// write surface had a wider one: readScope returns `repIds: null` for anyone
// holding commission.read.all — which managers do — so denyOutOfScope's read
// test was a no-op for exactly the role that also holds sales.write,
// adjustments.write and statements.write. Manager A could book a sale, file an
// adjustment, and recalculate a statement against manager B's rep. The
// self-deal guard never caught it: it blocks writing your OWN commission, not
// a peer's rep.
// ─────────────────────────────────────────────────────────────────────────────
describe("the branch rule on commission money writes", () => {
  const bookSale = (session: string, repId: number, externalId: string) =>
    req("/api/commission/sales", session, {
      method: "POST",
      body: JSON.stringify({ repId, externalId, status: "PENDING", soldAt: new Date().toISOString() }),
    });
  const recalc = (session: string, repId: number) =>
    req("/api/commission/statements/recalculate", session, {
      method: "POST",
      body: JSON.stringify({ repId, week: new Date().toISOString() }),
    });

  it("THE REQUIREMENT: manager A cannot book a sale against manager B's rep", async () => {
    const res = await bookSale(mgrA.session, repB.memberId, "cross-branch-sale-1");
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("OUT_OF_BRANCH");
    // …and nothing was written to the ledger.
    expect(rawDb.prepare("SELECT id FROM commission_sales WHERE external_id = ?").get("cross-branch-sale-1")).toBeFalsy();
  });

  it("nor recalculate another branch's statement", async () => {
    const res = await recalc(mgrA.session, repB.memberId);
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("OUT_OF_BRANCH");
  });

  it("nor assign a commission plan to another branch's rep", async () => {
    const res = await req("/api/commission/assignments", mgrA.session, {
      method: "POST",
      body: JSON.stringify({ repId: repB.memberId, commissionPlanVersionId: 1, effectiveFrom: "2026-01-01" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("OUT_OF_BRANCH");
  });

  it("REVIEW FIX: nor RE-POINT another branch's existing sale into their own", async () => {
    // The route originally guarded only the INCOMING repId, while the upsert's
    // ON CONFLICT rewrites rep_id — so the direct-write direction was closed but
    // the transfer direction stayed open. Manager A books nothing new; they
    // re-post manager B's rep's existing externalId with their own repId.
    const admin201 = await bookSale(admin.session, repB.memberId, "transfer-target-1");
    expect(admin201.status).toBe(201);

    const res = await req("/api/commission/sales", mgrA.session, {
      method: "POST",
      body: JSON.stringify({ repId: repA.memberId, externalId: "transfer-target-1", status: "PENDING", soldAt: new Date().toISOString() }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("OUT_OF_BRANCH");
    // The sale still belongs to manager B's rep.
    expect(rawDb.prepare("SELECT rep_id AS r FROM commission_sales WHERE external_id = ?").get("transfer-target-1"))
      .toMatchObject({ r: repB.memberId });
  });

  it("a manager still books freely inside their OWN branch", async () => {
    const res = await bookSale(mgrA.session, repA.memberId, "own-branch-sale-1");
    expect(res.status).toBe(201);
    expect(rawDb.prepare("SELECT rep_id AS r FROM commission_sales WHERE external_id = ?").get("own-branch-sale-1"))
      .toMatchObject({ r: repA.memberId });
  });

  it("an ADMIN still writes across branches - that is the arbitration path", async () => {
    const res = await bookSale(admin.session, repB.memberId, "admin-cross-sale-1");
    expect(res.status).toBe(201);
  });

  it("an UNOWNED rep stays writable - branchOwnerOf fails open by design", async () => {
    const orphan = person("Money Orphan", "rep", null);
    const res = await bookSale(mgrA.session, orphan.memberId, "orphan-sale-1");
    expect(res.status).toBe(201);
  });

  it("a manager still cannot write their OWN commission (self-deal guard intact)", async () => {
    const res = await bookSale(mgrA.session, mgrA.memberId, "self-deal-sale-1");
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("COMMISSION_SELF_DEAL");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hiring was the last side door around the branch rule. A manager could not MOVE
// a member into a peer's branch, but could freely CREATE one there — the same
// edge in the same tree, reached by a different verb.
// ─────────────────────────────────────────────────────────────────────────────
describe("the branch rule on hiring", () => {
  const hire = (session: string, body: Record<string, unknown>) =>
    req("/api/team", session, { method: "POST", body: JSON.stringify(body) });

  it("manager A cannot create a member reporting into manager B's branch", async () => {
    const res = await hire(mgrA.session, { name: "Poached Hire", role: "rep", reportsToId: mgrB.memberId });
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("OUT_OF_BRANCH");
  });

  it("nor under a team lead inside another manager's branch", async () => {
    const leadB = person("Lead Beta", "team_lead", mgrB.memberId);
    const res = await hire(mgrA.session, { name: "Deeper Poach", role: "rep", reportsToId: leadB.memberId });
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("OUT_OF_BRANCH");
  });

  it("a manager still hires freely into their OWN branch", async () => {
    const res = await hire(mgrA.session, { name: "Own Branch Hire", role: "rep", reportsToId: leadA.memberId });
    expect(res.status).toBe(201);
  });

  it("a top-level hire (no supervisor) is unaffected - nobody's branch to poach", async () => {
    const res = await hire(mgrA.session, { name: "Top Level Hire", role: "rep" });
    expect(res.status).toBe(201);
  });

  it("an ADMIN places hires anywhere - that is the arbitration path", async () => {
    const res = await hire(admin.session, { name: "Admin Placed", role: "rep", reportsToId: mgrB.memberId });
    expect(res.status).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The audit trail. Hierarchy changes are org-authority changes, and the ones
// that were silent were the ones most worth reading back: a plain supervisor
// re-home wrote NOTHING, member creation wrote nothing, and offboard/delete
// recorded only a COUNT of re-homed reports — never which ones, or where to.
// ─────────────────────────────────────────────────────────────────────────────
describe("hierarchy audit trail", () => {
  const eventsFor = (memberId: number, action: string) =>
    rawDb.prepare(
      `SELECT * FROM activity_log WHERE entity_type='team_member' AND entity_id=? AND action=? ORDER BY id DESC`,
    ).all(memberId, action) as any[];

  it("records a plain supervisor re-home, with where the member came from and went", async () => {
    const mover = person("Audit Mover", "rep", leadA.memberId);
    const res = await patchMember(mover.memberId, admin.session, { reportsToId: mgrA.memberId });
    expect(res.status).toBe(200);
    const [event] = eventsFor(mover.memberId, "team.member.supervisor_changed");
    expect(event).toBeTruthy();
    const meta = JSON.parse(event.details);
    expect(meta.from).toBe(leadA.memberId);
    expect(meta.to).toBe(mgrA.memberId);
    expect(meta.reason).toBe("reassigned");
  });

  it("records member creation, which previously logged nothing at all", async () => {
    const res = await req("/api/team", admin.session, {
      method: "POST",
      body: JSON.stringify({ name: "Audit Created", role: "rep", reportsToId: leadA.memberId }),
    });
    expect(res.status).toBe(201);
    const created = await res.json() as any;
    const [event] = eventsFor(created.id, "team.member.created");
    expect(event).toBeTruthy();
    const meta = JSON.parse(event.details);
    expect(meta).toMatchObject({ role: "rep", reportsToId: leadA.memberId });
  });

  it("names WHICH reports an offboard moved and where they landed, not just how many", async () => {
    const doomedLead = person("Audit Doomed Lead", "team_lead", mgrA.memberId);
    const orphanA = person("Audit Orphan A", "rep", doomedLead.memberId);
    const orphanB = person("Audit Orphan B", "rep", doomedLead.memberId);

    const res = await offboard(doomedLead.memberId, admin.session);
    expect(res.status).toBe(200);

    const [event] = eventsFor(doomedLead.memberId, "team.member.offboarded");
    const meta = JSON.parse(event.details);
    expect(meta.reassignedReports).toBe(2);
    expect(meta.movedReportIds.sort()).toEqual([orphanA.memberId, orphanB.memberId].sort());
    // They were re-homed to the offboarded lead's own supervisor.
    expect(meta.movedTo).toBe(mgrA.memberId);
  });

  it("does the same on a hard delete, where the original edge is gone for good", async () => {
    const doomed = person("Audit Deleted Lead", "team_lead", mgrA.memberId);
    const child = person("Audit Delete Orphan", "rep", doomed.memberId);
    const res = await del(doomed.memberId, admin.session);
    expect(res.status).toBe(200);
    const [event] = eventsFor(doomed.memberId, "team.member.removed");
    const meta = JSON.parse(event.details);
    expect(meta.movedReportIds).toEqual([child.memberId]);
    expect(meta.movedTo).toBe(mgrA.memberId);
  });

  it("records the IMPLICIT move too - a promotion that outgrew its own supervisor", async () => {
    const climber = person("Audit Climber", "rep", leadA.memberId);
    const res = await patchMember(climber.memberId, admin.session, { role: "manager" });
    expect(res.status).toBe(200);
    const [event] = eventsFor(climber.memberId, "team.member.supervisor_changed");
    expect(event).toBeTruthy();
    const meta = JSON.parse(event.details);
    expect(meta.from).toBe(leadA.memberId);
    expect(meta.to).toBeNull();               // promoted to top level
    expect(meta.reason).toBe("outgrew_supervisor");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ONE DOOR FOR ROLE CHANGES.
//
// A person in the field org carries two role fields — users.role (login power)
// and team_members.role (org-chart position) — reconciled by taking the higher.
// PATCH /api/team/:id is the door that keeps them in step: rank check, branch
// check, cycle revalidation, re-homing, a transaction, an audit row, and a
// mirror onto the login.
//
// PATCH /api/users/:id did none of that and still wrote users.role, so it could
// drive the pair into exactly the disagreement effectiveMemberRole exists to
// paper over — silently. A history table is only as trustworthy as the number of
// doors that can change what it records.
// ─────────────────────────────────────────────────────────────────────────────
describe("one door for role changes", () => {
  const patchUser = (userId: number, session: string, body: unknown) =>
    req(`/api/users/${userId}`, session, { method: "PATCH", body: JSON.stringify(body) });

  it("refuses a role change on a login that belongs to someone in the org chart", async () => {
    const member = person("Door Rep", "rep", leadA.memberId);
    const res = await patchUser(member.userId, admin.session, { role: "manager" });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.code).toBe("ROLE_CHANGE_WRONG_DOOR");
    expect(body.use).toContain(`/api/team/${member.memberId}`);

    // Neither field moved — the pair cannot be desynced through this route.
    const login = rawDb.prepare("SELECT role FROM users WHERE id=?").get(member.userId) as any;
    const roster = rawDb.prepare("SELECT role FROM team_members WHERE id=?").get(member.memberId) as any;
    expect(login.role).toBe("rep");
    expect(roster.role).toBe("rep");
  });

  it("still allows non-role edits on that same login", async () => {
    const member = person("Door Renamer", "rep", leadA.memberId);
    const res = await patchUser(member.userId, admin.session, { name: "Renamed Login" });
    expect(res.status).toBe(200);
    expect((await res.json() as any).name).toBe("Renamed Login");
  });

  it("accepts a no-op role (same value) rather than failing a harmless write", async () => {
    const member = person("Door NoOp", "rep", leadA.memberId);
    const res = await patchUser(member.userId, admin.session, { role: "rep", name: "Door NoOp Two" });
    expect(res.status).toBe(200);
  });

  it("still allows role changes on logins with NO roster row - they have no org-chart position to keep in step", async () => {
    const compliance = storage.createUser({
      name: "Compliance Only", email: "compliance.only@branch.example.test",
      role: "auditor", active: true, tenantId: TENANT,
    } as any);
    const res = await patchUser(compliance.id, admin.session, { role: "compliance_admin" });
    expect(res.status).toBe(200);
    expect((await res.json() as any).role).toBe("compliance_admin");
  });

  it("THE SANCTIONED PATH still works and keeps both fields in step", async () => {
    const member = person("Door Promoted", "rep", leadA.memberId);
    const res = await patchMember(member.memberId, admin.session, { role: "team_lead" });
    expect(res.status).toBe(200);
    const login = rawDb.prepare("SELECT role FROM users WHERE id=?").get(member.userId) as any;
    const roster = rawDb.prepare("SELECT role FROM team_members WHERE id=?").get(member.memberId) as any;
    expect(roster.role).toBe("team_lead");
    expect(login.role).toBe("team_lead");     // mirrored, not left behind
  });
});
