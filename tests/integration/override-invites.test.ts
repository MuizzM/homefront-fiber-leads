// ── Invite-time role/upline + the immutable recruiting sponsor edge ──────────
//
// An invitation now carries WHO the candidate will be (invited_role) and WHERE
// they sit (invited_supervisor_id), and approval writes both onto the login +
// roster row — plus a set-once recruited_by_* sponsor edge for recruiting
// metrics. These tests pin the authority rules end to end:
//
//   · inviting is hiring: canHireRole gates the invite AND the approval;
//   · the public resolve endpoint shows a role LABEL and never the supervisor
//     (org structure must not leak behind an unauthenticated token);
//   · a stale invite supervisor degrades to top-level WITH a warning, while an
//     explicit reviewer override fails loud;
//   · the sponsor edge is written once, survives approval retries untouched,
//     and the DATABASE refuses any re-point;
//   · commission.read.downline widens a team lead's read scope to the full
//     reports-to subtree, not just direct reports.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSigningTables } from "../helpers/signingTables";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let recruitingStore: typeof import("../../server/onboardingRecruitingStore");
let intake: typeof import("../../server/onboardingApplicationService");
let commissionRoutes: typeof import("../../server/commissionRoutes");
let adminSession: string;
let managerSession: string;
let teamLeadSession: string;
let managerUser: any;
let managerMember: any;      // active manager roster row (the default upline)
let inactiveMember: any;     // offboarded manager — an invalid supervisor
let foreignMember: any;      // active manager in ANOTHER tenant
let tlMember: any;           // team lead roster row (the downline root)
let tl2Member: any;          // team lead one level under tlMember
let deepRepMember: any;      // rep two levels under tlMember (rep → tl2 → tl)
let strangerMember: any;     // rep outside tlMember's subtree
const realFetch = globalThis.fetch.bind(globalThis);

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-override-invites-"));
  process.env.NODE_ENV = "test";
  process.env.APP_ORIGIN = "https://portal.example.com";
  process.env.CAREERS_TENANT_SLUG = "home-front-solutions";
  process.env.ONBOARDING_INVITE_SECRET = "test-onboarding-invite-secret-with-more-than-32-characters";
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.RESEND_FROM = "Home Front Test <test@example.com>";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  recruitingStore = await import("../../server/onboardingRecruitingStore");
  intake = await import("../../server/onboardingApplicationService");
  commissionRoutes = await import("../../server/commissionRoutes");
  const { registerRoutes } = await import("../../server/routes");

  rawDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
     VALUES (2, 'other-override-tenant', 'Other Tenant', 'Other Owner', 'other-override@example.com', 'Other Tenant')`,
  ).run();

  const admin = storage.createUser({ name: "Override Admin", email: "admin@override-org.example.com", role: "admin", active: true, tenantId: 1 } as any);
  adminSession = storage.createSession(admin.id).id;

  // The inviter: a manager with a linked, active roster row — the row an
  // upline-less invite defaults to.
  managerMember = storage.createTeamMember({ name: "Upline Manager Margaret", email: "manager@override-org.example.com", role: "manager", active: true, tenantId: 1 } as any);
  managerUser = storage.createUser({ name: "Upline Manager Margaret", email: "manager@override-org.example.com", role: "manager", active: true, tenantId: 1, teamMemberId: managerMember.id } as any);
  managerSession = storage.createSession(managerUser.id).id;

  inactiveMember = storage.createTeamMember({ name: "Retired Rhonda", role: "manager", active: false, tenantId: 1 } as any);
  foreignMember = storage.createTeamMember({ name: "Foreign Fiona", role: "manager", active: true, tenantId: 2 } as any);

  // The downline chain for the read-scope test: deepRep → tl2 → tlMember.
  tlMember = storage.createTeamMember({ name: "Team Lead Root", email: "teamlead@override-org.example.com", role: "team_lead", active: true, tenantId: 1 } as any);
  tl2Member = storage.createTeamMember({ name: "Team Lead Mid", role: "team_lead", active: true, tenantId: 1, reportsToId: tlMember.id } as any);
  deepRepMember = storage.createTeamMember({ name: "Deep Rep", role: "rep", active: true, tenantId: 1, reportsToId: tl2Member.id } as any);
  strangerMember = storage.createTeamMember({ name: "Stranger Rep", role: "rep", active: true, tenantId: 1 } as any);
  const teamLeadUser = storage.createUser({ name: "Team Lead Root", email: "teamlead@override-org.example.com", role: "team_lead", active: true, tenantId: 1, teamMemberId: tlMember.id } as any);
  teamLeadSession = storage.createSession(teamLeadUser.id).id;

  const app = express();
  app.use(express.json());
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  resetSigningTables(rawDb);
  rawDb.prepare("DELETE FROM onboarding_recruiting_invites").run();
  rawDb.prepare("DELETE FROM rep_applications").run();
  rawDb.prepare("DELETE FROM users WHERE email LIKE '%@override.example.com'").run();
  rawDb.prepare("DELETE FROM team_members WHERE email LIKE '%@override.example.com'").run();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true, status: 200, statusText: "OK",
    json: async () => ({ id: `resend-${crypto.randomUUID()}` }),
  }));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function postInvite(session: string, body: Record<string, unknown>) {
  const response = await realFetch(`${baseUrl}/api/onboarding/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": session },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

/** Invite (as the manager) → apply on the invite token → attached application. */
function invitedApplication(email: string, opts: { invitedRole?: any; invitedSupervisorId?: number | null } = {}) {
  const invite = recruitingStore.createRecruitingInvite({
    tenantId: 1, candidateName: "Override Candidate", candidateEmail: email, invitedBy: managerUser.id,
    invitedRole: opts.invitedRole ?? null,
    invitedSupervisorId: opts.invitedSupervisorId ?? null,
  });
  recruitingStore.markRecruitingInviteSent(invite.id, "resend-invite");
  const token = recruitingStore.secureTokenForInvite(invite.id);
  const application = intake.submitPublicApplication({
    fullName: "Override Candidate", email, phone: "3365550177",
    city: "Greensboro", state: "NC", zip: "27401",
    hasSalesExperience: true, preferredCarriers: "Kinetic Fiber",
    inviteToken: token, actorIp: "127.0.0.1",
  });
  return { invite, application };
}

async function approve(applicationId: number, extra: Record<string, unknown> = {}) {
  const response = await realFetch(`${baseUrl}/api/onboarding/applications/${applicationId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-session-id": adminSession },
    body: JSON.stringify({ status: "approved", ...extra }),
  });
  return { status: response.status, body: await response.json() as any };
}

const memberByEmail = (email: string): any =>
  rawDb.prepare("SELECT * FROM team_members WHERE email = ? AND tenant_id = 1").get(email);

describe("POST /api/onboarding/invitations — role + upline at invite time", () => {
  it("defaults the role to rep and the upline to the inviter's own roster row", async () => {
    const { status, body } = await postInvite(managerSession, {
      name: "Default Candidate", email: "default@override.example.com",
    });
    expect(status).toBe(201);
    expect(body.invitation.invitedRole).toBe("rep");
    expect(body.invitation.invitedSupervisorId).toBe(managerMember.id);
  });

  it("refuses a role the inviter could not hire directly — a manager cannot invite a manager", async () => {
    const { status } = await postInvite(managerSession, {
      name: "Peer Manager", email: "peer@override.example.com", invitedRole: "manager",
    });
    expect(status).toBe(403);
    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM onboarding_recruiting_invites").get()).toEqual({ n: 0 });
  });

  it("400s INVALID_SUPERVISOR for a nonexistent, inactive, or cross-tenant supervisor", async () => {
    for (const supervisorId of [999_999, inactiveMember.id, foreignMember.id]) {
      const { status, body } = await postInvite(managerSession, {
        name: "Bad Upline", email: "badupline@override.example.com", invitedSupervisorId: supervisorId,
      });
      expect(status).toBe(400);
      expect(body.code).toBe("INVALID_SUPERVISOR");
    }
  });

  it("an explicit null supervisor means top-level, and rides the invite", async () => {
    const { status, body } = await postInvite(managerSession, {
      name: "Top Level", email: "toplevel@override.example.com", invitedSupervisorId: null,
    });
    expect(status).toBe(201);
    expect(body.invitation.invitedSupervisorId).toBeNull();
  });
});

describe("GET /api/onboarding/invitations/resolve — the public token view", () => {
  it("exposes a role label but NEVER the supervisor id or name", async () => {
    const invite = recruitingStore.createRecruitingInvite({
      tenantId: 1, candidateName: "Resolve Candidate", candidateEmail: "resolve@override.example.com",
      invitedBy: managerUser.id, invitedRole: "team_lead", invitedSupervisorId: managerMember.id,
    });
    const token = recruitingStore.secureTokenForInvite(invite.id);
    const response = await realFetch(`${baseUrl}/api/onboarding/invitations/resolve?token=${encodeURIComponent(token)}`);
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw);
    expect(body.roleLabel).toBe("Team Lead");
    // Exact-key leak regression: org structure must not appear behind an
    // unauthenticated token — not the id, not the role key, not the name.
    expect(raw).not.toContain("invitedSupervisorId");
    expect(raw).not.toContain("invitedRole");
    expect(raw).not.toContain("Upline Manager Margaret");
  });
});

describe("approval writes the invited hierarchy", () => {
  it("a team_lead invite lands as users.role + team_members.role + reportsToId", async () => {
    const email = "newlead@override.example.com";
    const { application } = invitedApplication(email, { invitedRole: "team_lead", invitedSupervisorId: managerMember.id });
    const { status, body } = await approve(application.id);
    expect(status).toBe(200);
    expect(body.hierarchyWarning ?? null).toBeNull();

    const member = memberByEmail(email);
    expect(member.role).toBe("team_lead");
    expect(member.reports_to_id).toBe(managerMember.id);
    // The syncLoginAccount invariant: users.role mirrors team_members.role.
    const login: any = rawDb.prepare("SELECT * FROM users WHERE email = ?").get(email);
    expect(login.role).toBe("team_lead");
  });

  it("a supervisor offboarded between invite and approval degrades to top-level WITH a warning", async () => {
    const email = "stale-upline@override.example.com";
    const supervisor = storage.createTeamMember({ name: "Soon Gone", email: "soongone@override.example.com", role: "manager", active: true, tenantId: 1 } as any);
    const { application } = invitedApplication(email, { invitedRole: "rep", invitedSupervisorId: supervisor.id });
    rawDb.prepare("UPDATE team_members SET active = 0 WHERE id = ?").run(supervisor.id);

    const { status, body } = await approve(application.id);
    expect(status).toBe(200);
    expect(body.hierarchyWarning).toMatch(/no longer available/i);
    expect(memberByEmail(email).reports_to_id).toBeNull();
  });

  it("an explicit reviewer hierarchy override outranks the invite", async () => {
    const email = "overridden@override.example.com";
    const { application } = invitedApplication(email, { invitedRole: "team_lead", invitedSupervisorId: managerMember.id });
    const { status } = await approve(application.id, { hierarchy: { role: "rep", reportsToId: tlMember.id } });
    expect(status).toBe(200);
    const member = memberByEmail(email);
    expect(member.role).toBe("rep");
    expect(member.reports_to_id).toBe(tlMember.id);
    expect((rawDb.prepare("SELECT role FROM users WHERE email = ?").get(email) as any).role).toBe("rep");
  });

  it("an INVALID explicit override fails loud — 400, and nothing was approved", async () => {
    const email = "loud-fail@override.example.com";
    const { invite, application } = invitedApplication(email, { invitedRole: "rep" });
    const { status, body } = await approve(application.id, { hierarchy: { reportsToId: 999_999 } });
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_SUPERVISOR");
    // The 4xx ran before any state change: application pending, invite unapproved.
    expect((rawDb.prepare("SELECT status FROM rep_applications WHERE id = ?").get(application.id) as any).status).toBe("pending");
    expect(recruitingStore.getRecruitingInvite(invite.id)!.approvedAt).toBeNull();
    expect(memberByEmail(email)).toBeUndefined();
  });
});

describe("the recruiting sponsor edge", () => {
  it("is written once from the invite, and an approval retry does not rewrite it", async () => {
    const email = "sponsored@override.example.com";
    const { application } = invitedApplication(email);
    expect((await approve(application.id)).status).toBe(200);

    const first = memberByEmail(email);
    expect(first.recruited_by_user_id).toBe(managerUser.id);
    expect(first.recruited_by_member_id).toBe(managerMember.id);
    expect(first.recruited_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    // Retry the approval (idempotent path) — the WHERE guard matches zero rows.
    expect((await approve(application.id)).status).toBe(200);
    const second = memberByEmail(email);
    expect(second.recruited_at).toBe(first.recruited_at);
    expect(second.recruited_by_user_id).toBe(first.recruited_by_user_id);
  });

  it("the DATABASE refuses to re-point a set sponsor edge", async () => {
    const email = "immutable@override.example.com";
    const { application } = invitedApplication(email);
    await approve(application.id);
    const member = memberByEmail(email);

    expect(() => rawDb.prepare("UPDATE team_members SET recruited_by_member_id = ? WHERE id = ?")
      .run(tlMember.id, member.id)).toThrow(/immutable/);
    expect(() => rawDb.prepare("UPDATE team_members SET recruited_by_user_id = ? WHERE id = ?")
      .run(999, member.id)).toThrow(/immutable/);
    // Writing the SAME value is a no-op, not a violation (IS NOT semantics).
    expect(() => rawDb.prepare("UPDATE team_members SET recruited_by_member_id = ? WHERE id = ?")
      .run(member.recruited_by_member_id, member.id)).not.toThrow();
  });

  it("POST /api/team cannot forge a sponsor through mass assignment", async () => {
    const response = await realFetch(`${baseUrl}/api/team`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": adminSession },
      body: JSON.stringify({ name: "Forged Sponsor Attempt", role: "rep", recruitedByMemberId: managerMember.id, recruitedByUserId: managerUser.id }),
    });
    expect(response.status).toBe(201);
    const created = await response.json() as any;
    const row: any = rawDb.prepare("SELECT recruited_by_member_id, recruited_by_user_id FROM team_members WHERE id = ?").get(created.id);
    expect(row.recruited_by_member_id).toBeNull();
    expect(row.recruited_by_user_id).toBeNull();
    rawDb.prepare("DELETE FROM team_members WHERE id = ?").run(created.id);
  });

  it("a public application with no invite gets no sponsor edge", async () => {
    const email = "unsponsored@override.example.com";
    const application = intake.submitPublicApplication({
      fullName: "Walk In", email, phone: "3365550166",
      city: "Greensboro", state: "NC", zip: "27401",
      hasSalesExperience: true, preferredCarriers: "Kinetic Fiber", actorIp: "127.0.0.1",
    });
    await approve(application.id);
    const member = memberByEmail(email);
    expect(member.recruited_by_user_id).toBeNull();
    expect(member.recruited_by_member_id).toBeNull();
  });
});

describe("commission.read.downline widens a team lead's read scope", () => {
  it("readScope includes a rep two levels down, not just direct reports", () => {
    const user = { role: "team_lead", tenantId: 1, teamMemberId: tlMember.id };
    const { repIds } = commissionRoutes.readScope(user);
    expect(repIds).toContain(tlMember.id);
    expect(repIds).toContain(tl2Member.id);
    expect(repIds).toContain(deepRepMember.id);   // two levels — the widened part
    expect(repIds).not.toContain(strangerMember.id);
  });

  it("GET /api/commission/statements honors the widened scope over HTTP", async () => {
    const deep = await realFetch(`${baseUrl}/api/commission/statements?repId=${deepRepMember.id}`, {
      headers: { "x-session-id": teamLeadSession },
    });
    expect(deep.status).toBe(200);
    const stranger = await realFetch(`${baseUrl}/api/commission/statements?repId=${strangerMember.id}`, {
      headers: { "x-session-id": teamLeadSession },
    });
    expect(stranger.status).toBe(403);
  });
});
