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
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...(init.headers ?? {}) },
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
  it("a manager still runs their own branch — rename, re-home, re-price", async () => {
    expect((await patchMember(repA.memberId, mgrA.session, { name: "Rep Alpha Renamed" })).status).toBe(200);
    // Move their own rep from under their team lead to directly under themselves.
    expect((await patchMember(repA.memberId, mgrA.session, { reportsToId: mgrA.memberId })).status).toBe(200);
    expect(reportsToOf(repA.memberId)).toBe(mgrA.memberId);
    expect((await setRates(repA.memberId, mgrA.session, { overrideTeamLeadCents: 2500 })).status).toBe(200);
    // put it back for later tests
    await patchMember(repA.memberId, mgrA.session, { reportsToId: leadA.memberId });
  });

  it("an UNOWNED member is adoptable — the case the subtree rule would have stranded", async () => {
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

  it("a TEAM LEAD keeps acting on their own reps — their branch owner is the manager ABOVE them", async () => {
    // The naive branch rule refused this: branchOwnerOf(rep) is mgrA, which is
    // not the team lead, so a team lead could not offboard their own rep.
    const leadRep = person("Lead Owned Rep", "rep", leadA.memberId);
    expect((await patchMember(leadRep.memberId, leadA.session, { name: "Coached Rep" })).status).toBe(200);
    expect((await offboard(leadRep.memberId, leadA.session)).status).toBe(200);
  });

  it("an ADMIN arbitrates across branches — that is the transfer path", async () => {
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
