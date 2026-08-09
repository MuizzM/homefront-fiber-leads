// Fixture accounts are marked TRAINED. New accounts now owe training before the
// field opens (server/trainingGateStore.ts); these suites are about territory,
// RBAC, spiffs, and offboarding, so their people start on the far side of that
// gate rather than every assertion here re-testing it.
// Hierarchy lifecycle — who may kick whom out, and what a kick actually does.
//
// The authority rule is strictly-above: team leads offboard their reps,
// managers offboard team leads (and reps), admins offboard managers (and
// below). Peers can never remove each other, nobody removes upward or
// themselves, and an offboard is a REAL offboard: login disabled, live
// sessions revoked immediately, direct reports re-homed, action audited.
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

type Fixture = { userId: number; memberId: number; session: string };
const fx: Record<string, Fixture> = {};

function makePerson(name: string, role: string, opts: { reportsToId?: number | null; loginRole?: string; active?: boolean } = {}): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@offboard.example.test`;
  const member = storage.createTeamMember({
    name, email, role, active: opts.active ?? true,
    reportsToId: opts.reportsToId ?? null, tenantId: 1,
  } as any);
  const user = storage.createUser({
    name, email, role: opts.loginRole ?? role, active: true,
    tenantId: 1, teamMemberId: member.id,
  } as any);
  rawDb?.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run((user as any).id);
  const session = storage.createSession(user.id).id;
  return { userId: user.id, memberId: member.id, session };
}

function request(path: string, sessionId: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, ...(init.headers ?? {}) },
  });
}

const offboard = (id: number, session: string) =>
  request(`/api/team/${id}/offboard`, session, { method: "POST", body: "{}" });
const reactivate = (id: number, session: string) =>
  request(`/api/team/${id}/reactivate`, session, { method: "POST", body: "{}" });

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-team-offboard-"));
  process.env.NODE_ENV = "test";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  // Org chart under tenant 1:
  //   admin (login admin, member manager-row not needed → give member role manager)
  //   managerA, managerB           — peers
  //   teamLead → managerA          — leadRepA, leadRepB report to teamLead
  //   strayRep → managerB          — outside teamLead's scope
  fx.admin = makePerson("Org Admin", "manager", { loginRole: "admin" });
  fx.managerA = makePerson("Manager Alpha", "manager");
  fx.managerB = makePerson("Manager Beta", "manager");
  fx.teamLead = makePerson("Lead Lena", "team_lead", { reportsToId: fx.managerA.memberId });
  fx.leadRepA = makePerson("Rep Anna", "rep", { reportsToId: fx.teamLead.memberId });
  fx.leadRepB = makePerson("Rep Ben", "rep", { reportsToId: fx.teamLead.memberId });
  fx.strayRep = makePerson("Rep Cora", "rep", { reportsToId: fx.managerB.memberId });

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

describe("offboard authority matrix (strictly above)", () => {
  it("a team lead offboards their own rep - login disabled, sessions dead NOW", async () => {
    // The rep is logged in and working.
    const before = await request("/api/team", fx.leadRepA.session);
    expect(before.status).toBe(200);

    const res = await offboard(fx.leadRepA.memberId, fx.teamLead.session);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ success: true, loginDisabled: true });
    expect(body.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(body.member.active).toBe(false);

    // The kicked rep's very next request fails — not just their next login.
    const after = await request("/api/team", fx.leadRepA.session);
    expect(after.status).toBe(401);

    // Login row is disabled, and the action is audited.
    const login = storage.getAllUsers(1).find((u) => u.teamMemberId === fx.leadRepA.memberId)!;
    expect(login.active).toBe(false);
    const audit = rawDb.prepare(
      "SELECT * FROM activity_log WHERE action = 'team.member.offboarded' AND entity_id = ?",
    ).get(String(fx.leadRepA.memberId));
    expect(audit).toBeTruthy();
  });

  it("a team lead cannot offboard a rep outside their team (scope wall)", async () => {
    const res = await offboard(fx.strayRep.memberId, fx.teamLead.session);
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("OUT_OF_SCOPE");
  });

  it("a team lead cannot offboard a peer team lead, even inside their scope", async () => {
    // Legacy-shaped edge: a team_lead reporting to a team_lead (created via
    // storage, below route validation) — in scope, but rank refuses.
    const peerLead = makePerson("Lead Peer", "team_lead", { reportsToId: fx.teamLead.memberId });
    const res = await offboard(peerLead.memberId, fx.teamLead.session);
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("HIERARCHY_FORBIDDEN");
  });

  it("a manager offboards a team lead and the lead's reps are re-homed to the manager above", async () => {
    const res = await offboard(fx.teamLead.memberId, fx.managerA.session);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // leadRepB (still active) plus the peer lead from the previous test both
    // reported to teamLead; every dangling report is re-homed regardless.
    expect(body.reassignedReports).toBeGreaterThanOrEqual(1);

    // Re-homed to the offboarded lead's own supervisor: managerA.
    const repB = storage.getTeamMembers(1).find((m) => m.id === fx.leadRepB.memberId)! as any;
    expect(repB.reportsToId).toBe(fx.managerA.memberId);

    // The kicked lead's session is dead.
    const after = await request("/api/team", fx.teamLead.session);
    expect(after.status).toBe(401);
  });

  it("a manager cannot offboard a fellow manager (peers, org-wide scope or not)", async () => {
    const res = await offboard(fx.managerB.memberId, fx.managerA.session);
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("HIERARCHY_FORBIDDEN");
  });

  it("an admin offboards a manager", async () => {
    const res = await offboard(fx.managerB.memberId, fx.admin.session);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).member.active).toBe(false);
  });

  it("nobody offboards themselves", async () => {
    const res = await offboard(fx.managerA.memberId, fx.managerA.session);
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe("CANNOT_OFFBOARD_SELF");
  });

  it("offboarding an already-inactive member is a conflict, not a no-op", async () => {
    const res = await offboard(fx.leadRepA.memberId, fx.managerA.session);
    expect(res.status).toBe(409);
    expect((await res.json() as any).code).toBe("ALREADY_INACTIVE");
  });

  it("a rep cannot call offboard at all", async () => {
    const res = await offboard(fx.leadRepB.memberId, fx.leadRepB.session);
    // leadRepB offboarding themselves would be caught later anyway, but the
    // role gate refuses reps outright.
    expect(res.status).toBe(403);
  });
});

describe("reactivation follows the same authority", () => {
  it("a manager brings back an offboarded rep - member and login both active again", async () => {
    const res = await reactivate(fx.leadRepA.memberId, fx.managerA.session);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).member.active).toBe(true);
    const login = storage.getAllUsers(1).find((u) => u.teamMemberId === fx.leadRepA.memberId)!;
    expect(login.active).toBe(true);
    const audit = rawDb.prepare(
      "SELECT * FROM activity_log WHERE action = 'team.member.reactivated' AND entity_id = ?",
    ).get(String(fx.leadRepA.memberId));
    expect(audit).toBeTruthy();
  });

  it("reactivating an active member is a conflict", async () => {
    const res = await reactivate(fx.leadRepA.memberId, fx.managerA.session);
    expect(res.status).toBe(409);
    expect((await res.json() as any).code).toBe("ALREADY_ACTIVE");
  });
});

describe("editing obeys the hierarchy too", () => {
  it("a manager cannot edit a fellow manager's row", async () => {
    const res = await request(`/api/team/${fx.managerB.memberId}`, fx.managerA.session, {
      method: "PATCH", body: JSON.stringify({ name: "Hijacked Name" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("HIERARCHY_FORBIDDEN");
  });

  it("self-edit allows profile fields but never role/status/supervisor/email", async () => {
    const ok = await request(`/api/team/${fx.managerA.memberId}`, fx.managerA.session, {
      method: "PATCH", body: JSON.stringify({ name: "Manager Alpha Prime", phone: "(704) 555-0000" }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).name).toBe("Manager Alpha Prime");

    // role / supervisor / login-email self-edits are refused with a self-lifecycle
    // code; status (active) is refused even earlier as a non-PATCH field.
    for (const body of [{ role: "rep" }, { email: "attacker@evil.example" }, { reportsToId: null }]) {
      const res = await request(`/api/team/${fx.managerA.memberId}`, fx.managerA.session, {
        method: "PATCH", body: JSON.stringify(body),
      });
      expect(res.status, `self-edit of ${Object.keys(body)[0]} must be refused`).toBe(403);
      expect((await res.json() as any).code).toBe("SELF_LIFECYCLE_FORBIDDEN");
    }
    const activeRes = await request(`/api/team/${fx.managerA.memberId}`, fx.managerA.session, {
      method: "PATCH", body: JSON.stringify({ active: false }),
    });
    expect(activeRes.status).toBe(400);
    expect((await activeRes.json() as any).code).toBe("USE_LIFECYCLE_ENDPOINT");
  });

  it("a supervisor edge must point at an active, higher-ranked, same-tenant member", async () => {
    // rep → rep is not a valid supervisor edge.
    const res = await request(`/api/team/${fx.leadRepB.memberId}`, fx.managerA.session, {
      method: "PATCH", body: JSON.stringify({ reportsToId: fx.leadRepA.memberId }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe("INVALID_SUPERVISOR");

    // A member id from another tenant does not resolve inside this tenant.
    const foreign = rawDb.prepare(
      "INSERT INTO team_members (name, role, active, tenant_id, created_at) VALUES ('Foreign Sup', 'manager', 1, 999, datetime('now')) RETURNING id",
    ).get() as any;
    const cross = await request(`/api/team/${fx.leadRepB.memberId}`, fx.managerA.session, {
      method: "PATCH", body: JSON.stringify({ reportsToId: foreign.id }),
    });
    expect(cross.status).toBe(400);
    expect((await cross.json() as any).code).toBe("INVALID_SUPERVISOR");
  });

  it("creating a member validates the supervisor the same way", async () => {
    const res = await request("/api/team", fx.managerA.session, {
      method: "POST",
      body: JSON.stringify({ name: "New Rep", role: "rep", reportsToId: fx.leadRepB.memberId }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe("INVALID_SUPERVISOR");
  });
});

describe("hard delete obeys the hierarchy and cleans up", () => {
  it("a manager cannot delete a fellow manager", async () => {
    const res = await request(`/api/team/${fx.managerB.memberId}`, fx.managerA.session, { method: "DELETE" });
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("HIERARCHY_FORBIDDEN");
  });

  it("an admin deletes a manager; that manager's reports are re-homed first", async () => {
    const doomed = makePerson("Doomed Manager", "manager");
    const orphanRep = makePerson("Orphan Rep", "rep", { reportsToId: doomed.memberId });
    const res = await request(`/api/team/${doomed.memberId}`, fx.admin.session, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.reassignedReports).toBe(1);
    const orphan = storage.getTeamMembers(1).find((m) => m.id === orphanRep.memberId)! as any;
    expect(orphan.reportsToId).toBeNull(); // doomed manager was top-level
    // Login of the deleted member is disabled and its sessions are gone.
    const after = await request("/api/team", doomed.session);
    expect(after.status).toBe(401);
  });
});

describe("effective-role authority (login role outranks a low field role)", () => {
  it("a manager cannot offboard a member whose LINKED LOGIN is an admin, even with a low field role", async () => {
    // A second admin exists (fx.admin), so the last-admin guard is NOT what
    // stops this — the effective-role check is. The member's field role is
    // 'rep' but its login is 'admin'; a manager must be refused outright.
    const shadowAdmin = makePerson("Shadow Admin", "rep", { loginRole: "admin" });
    const res = await offboard(shadowAdmin.memberId, fx.managerA.session);
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe("HIERARCHY_FORBIDDEN");

    // And the same low-field-role/high-login member cannot be edited by a manager.
    const patch = await request(`/api/team/${shadowAdmin.memberId}`, fx.managerA.session, {
      method: "PATCH", body: JSON.stringify({ email: "attacker@evil.example" }),
    });
    expect(patch.status).toBe(403);
    expect((await patch.json() as any).code).toBe("HIERARCHY_FORBIDDEN");
  });
});

describe("status changes are never a PATCH field (LAST_ADMIN bypass closed)", () => {
  it("PATCH {active:false} is refused and routes the caller to the lifecycle endpoints", async () => {
    // The sole-admin lockout is impossible because active is not editable via
    // PATCH: a manager PATCHing the admin-linked member inactive is refused,
    // and the admin login stays active.
    rawDb.prepare("UPDATE users SET active = 0 WHERE role = 'admin' AND tenant_id = 1").run();
    const soleAdmin = makePerson("Sole Admin", "rep", { loginRole: "admin" });
    const res = await request(`/api/team/${soleAdmin.memberId}`, fx.managerA.session, {
      method: "PATCH", body: JSON.stringify({ active: false }),
    });
    // Manager is blocked by rank first (effective role admin) — but even a
    // permitted actor cannot flip active via PATCH.
    expect([400, 403]).toContain(res.status);
    const admins = storage.getAllUsers(1).filter((u) => u.role === "admin" && u.active);
    expect(admins.length).toBe(1); // still one active admin — no lockout

    // A permitted actor (admin acts on a rep) also cannot flip active via PATCH.
    rawDb.prepare("UPDATE users SET active = 1 WHERE id = ?").run(fx.admin.userId);
    const plainRep = makePerson("Plain Rep PATCH", "rep");
    const res2 = await request(`/api/team/${plainRep.memberId}`, fx.admin.session, {
      method: "PATCH", body: JSON.stringify({ active: false, name: "Renamed" }),
    });
    expect(res2.status).toBe(400);
    expect((await res2.json() as any).code).toBe("USE_LIFECYCLE_ENDPOINT");
    expect(storage.getTeamMembers(1).find((m) => m.id === plainRep.memberId)!.active).toBe(true);
  });
});

// A kick must survive SLIDING SESSIONS. Renewal keeps an actively-working rep
// signed in indefinitely, so "the session eventually lapses" is no longer a
// backstop: every path that deactivates a login has to revoke on the spot, and
// /api/auth/status — the client's authority on whether a session is still real
// — has to agree, or a kicked rep sits in an app where nothing works but
// nothing sends them to Login either.
describe("a kick beats session renewal", () => {
  it("status reports accessRevoked (not a plain expiry) so the rep is told the truth", async () => {
    const rep = makePerson("Rep Revoked Status", "rep", { reportsToId: fx.managerB.memberId });
    // Deactivate the LOGIN while leaving the session row intact — the exact
    // state that used to report the kicked rep as happily signed in.
    rawDb.prepare("UPDATE users SET active = 0 WHERE id = ?").run(rep.userId);

    const res = await request("/api/auth/status", rep.session);
    const body = await res.json() as any;
    expect(body.currentUser).toBeNull();     // never reported as signed in
    expect(body.accessRevoked).toBe(true);   // and distinguishable from a timeout

    // Self-healing: contacting status drops the dead session rows.
    const left = rawDb.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id = ?").get(rep.userId) as any;
    expect(left.c).toBe(0);
  });

  it("a plain expiry is NOT reported as a revocation", async () => {
    const rep = makePerson("Rep Timed Out", "rep", { reportsToId: fx.managerB.memberId });
    rawDb.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), rep.session);

    const body = await (await request("/api/auth/status", rep.session)).json() as any;
    expect(body.currentUser).toBeNull();
    expect(body.accessRevoked).toBe(false); // timed out, not kicked
  });

  it("an offboarded rep cannot renew their way back in", async () => {
    // Fresh lead: the fixture teamLead has been offboarded by earlier tests.
    const lead = makePerson("Lead For Renewal Test", "team_lead", { reportsToId: fx.managerB.memberId });
    const rep = makePerson("Rep No Renewal", "rep", { reportsToId: lead.memberId });
    expect((await request("/api/team", rep.session)).status).toBe(200);

    expect((await offboard(rep.memberId, lead.session)).status).toBe(200);

    // Not merely rejected — the session is GONE, so renewal has nothing to
    // extend and no amount of continued tapping resurrects access.
    expect((await request("/api/team", rep.session)).status).toBe(401);
    const rows = rawDb.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id = ?").get(rep.userId) as any;
    expect(rows.c).toBe(0);
    const status = await (await request("/api/auth/status", rep.session)).json() as any;
    expect(status.currentUser).toBeNull();
  });

  it("deactivating a login directly (admin PATCH /api/users/:id) also kills sessions", async () => {
    const rep = makePerson("Rep Admin Deactivated", "rep", { reportsToId: fx.managerB.memberId });
    expect((await request("/api/team", rep.session)).status).toBe(200);

    const res = await request(`/api/users/${rep.userId}`, fx.admin.session, {
      method: "PATCH", body: JSON.stringify({ active: false }),
    });
    expect(res.status).toBe(200);

    expect((await request("/api/team", rep.session)).status).toBe(401);
    const rows = rawDb.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id = ?").get(rep.userId) as any;
    expect(rows.c).toBe(0);
  });

  it("deleting a login revokes its sessions rather than orphaning them", async () => {
    const rep = makePerson("Rep Deleted", "rep", { reportsToId: fx.managerB.memberId });
    const res = await request(`/api/users/${rep.userId}`, fx.admin.session, { method: "DELETE" });
    expect(res.status).toBe(200);
    const rows = rawDb.prepare("SELECT COUNT(*) c FROM sessions WHERE user_id = ?").get(rep.userId) as any;
    expect(rows.c).toBe(0);
    expect((await request("/api/team", rep.session)).status).toBe(401);
  });

  it("a still-employed rep keeps working - renewal only ever helps the active", async () => {
    const rep = makePerson("Rep Still Working", "rep", { reportsToId: fx.teamLead.memberId });
    // Nearly-expired session, mid-shift: renewal must carry them through.
    rawDb.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), rep.session);

    expect((await request("/api/team", rep.session)).status).toBe(200);
    const row = rawDb.prepare("SELECT expires_at AS e FROM sessions WHERE id = ?").get(rep.session) as any;
    expect(Date.parse(row.e) - Date.now()).toBeGreaterThan(24 * 60 * 60 * 1000);
  });
});
