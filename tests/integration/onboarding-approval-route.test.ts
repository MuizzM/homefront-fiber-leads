import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let intake: typeof import("../../server/onboardingApplicationService");
let adminSession: string;
let managerSession: string;
let otherTenantAdminSession: string;
const realFetch = globalThis.fetch.bind(globalThis);

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-onboarding-api-"));
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
  intake = await import("../../server/onboardingApplicationService");
  const { registerRoutes } = await import("../../server/routes");

  rawDb.prepare("INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (2, 'other-tenant', 'Other Tenant', 'Other Owner', 'other-owner@example.com', 'Other Tenant')").run();
  const admin = storage.createUser({ name: "Tenant Admin", email: "onboarding-admin@example.com", role: "admin", active: true, tenantId: 1 } as any);
  const manager = storage.createUser({ name: "Tenant Manager", email: "onboarding-manager@example.com", role: "manager", active: true, tenantId: 1 } as any);
  const otherAdmin = storage.createUser({ name: "Other Admin", email: "other-onboarding-admin@example.com", role: "admin", active: true, tenantId: 2 } as any);
  adminSession = storage.createSession(admin.id).id;
  managerSession = storage.createSession(manager.id).id;
  otherTenantAdminSession = storage.createSession(otherAdmin.id).id;

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  rawDb.prepare("DELETE FROM onboarding_signature_events").run();
  rawDb.prepare("DELETE FROM onboarding_signing_documents").run();
  rawDb.prepare("DELETE FROM onboarding_recruiting_invites").run();
  rawDb.prepare("DELETE FROM rep_applications").run();
  rawDb.prepare("DELETE FROM otp_codes").run();
  rawDb.prepare("DELETE FROM users WHERE email LIKE '%@approval-flow.example.com'").run();
  rawDb.prepare("DELETE FROM team_members WHERE email LIKE '%@approval-flow.example.com'").run();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ id: `resend-${crypto.randomUUID()}` }),
  }));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function createCareersApplication(email: string) {
  return intake.submitPublicApplication({
    fullName: "Approval Flow Candidate",
    email,
    phone: "3365550142",
    city: "Greensboro",
    state: "NC",
    zip: "27401",
    hasSalesExperience: true,
    salesExperienceDetails: "Three years of direct field sales.",
    preferredCarriers: "Kinetic Fiber",
    desiredRole: "Field Sales Representative",
    requestedSource: "careers",
    actorIp: "127.0.0.1",
  });
}

async function review(applicationId: number, sessionId: string, body: Record<string, unknown>) {
  return realFetch(`${baseUrl}/api/onboarding/applications/${applicationId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify(body),
  });
}

describe("onboarding approval route", () => {
  it("claims a pre-membership account and rep profile instead of reporting that they are outside the organization", async () => {
    const email = "unassigned-candidate@approval-flow.example.com";
    const profile = storage.createTeamMember({
      name: "Unassigned Candidate",
      email,
      phone: "3365550123",
      role: "rep",
      active: false,
      tenantId: null,
    } as any);
    const account = storage.createUser({
      name: "Unassigned Candidate",
      email,
      role: "rep",
      active: false,
      tenantId: null,
      teamMemberId: profile.id,
    } as any);
    const application = createCareersApplication(email);

    const response = await review(application.id, adminSession, { status: "approved" });
    const body = await response.json() as any;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("approved");
    expect(storage.getUserByEmail(email)).toMatchObject({ id: account.id, tenantId: 1, teamMemberId: profile.id });
    expect(storage.getTeamMemberById(profile.id)).toMatchObject({ tenantId: 1, active: false });
    expect(rawDb.prepare("SELECT COUNT(*) count FROM users WHERE email = ?").get(email)).toMatchObject({ count: 1 });
    expect(rawDb.prepare("SELECT COUNT(*) count FROM team_members WHERE email = ?").get(email)).toMatchObject({ count: 1 });
  });

  it("approval sends a code-free welcome and mints NO login code", async () => {
    // Spec: a login code is only born when the rep enters their email and taps
    // "Send code" — never on approval. Approval must create zero otp_codes rows
    // for the applicant and still succeed (account + welcome notice).
    const email = "no-code-on-approval@approval-flow.example.com";
    const application = createCareersApplication(email);
    rawDb.prepare("DELETE FROM otp_codes WHERE email = ?").run(email);

    const response = await review(application.id, adminSession, { status: "approved" });
    const body = await response.json() as any;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("approved");

    const otpCount = rawDb.prepare("SELECT COUNT(*) c FROM otp_codes WHERE email = ?").get(email) as any;
    expect(otpCount.c).toBe(0);                              // approval minted no code
    // The applicant CAN still get one the correct way — by requesting it.
    const requested = await realFetch(`${baseUrl}/api/auth/otp/request`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(requested.status).toBe(200);
    const afterRequest = rawDb.prepare("SELECT COUNT(*) c FROM otp_codes WHERE email = ?").get(email) as any;
    expect(afterRequest.c).toBe(1);                          // born from the rep's own request
  });

  it("refuses to approve an application whose email is reserved for platform ownership", async () => {
    // The confirmed apex-escalation hole: the reserved-email guard used to live
    // inside the claim-existing branch only, so a NEW-user careers application
    // for a SUPER_ADMIN_EMAILS address slipped through the else branch and
    // minted an account the boot-time stamp would later promote to platform
    // owner. The guard now runs before both branches AND before any state
    // change. Default SUPER_ADMIN_EMAILS is muizzm21@gmail.com (no override set).
    const email = "muizzm21@gmail.com";
    const application = createCareersApplication(email);
    const before = rawDb.prepare("SELECT status FROM rep_applications WHERE id = ?").get(application.id) as any;

    const response = await review(application.id, adminSession, { status: "approved" });
    const body = await response.json() as any;
    expect(response.status, JSON.stringify(body)).toBe(400);
    expect(body.code).toBe("RESERVED_EMAIL");

    // No account was minted for the reserved address…
    expect(rawDb.prepare("SELECT COUNT(*) count FROM users WHERE email = ?").get(email)).toMatchObject({ count: 0 });
    // …and the 400 did not leave the application half-approved.
    const after = rawDb.prepare("SELECT status FROM rep_applications WHERE id = ?").get(application.id) as any;
    expect(after.status).toBe(before.status);
    expect(after.status).not.toBe("approved");
  });

  it("repairs a login linked to another tenant without moving that tenant's rep history", async () => {
    const email = "stale-cross-tenant-link@approval-flow.example.com";
    const foreignProfile = storage.createTeamMember({
      name: "Legacy Foreign Profile",
      email,
      phone: "3365550199",
      role: "rep",
      active: true,
      tenantId: 2,
    } as any);
    const account = storage.createUser({
      name: "Approval Flow Candidate",
      email,
      role: "rep",
      active: false,
      tenantId: 1,
      teamMemberId: foreignProfile.id,
    } as any);
    const application = createCareersApplication(email);

    const response = await review(application.id, adminSession, { status: "approved" });
    const body = await response.json() as any;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("approved");

    const repairedAccount = storage.getUserByEmail(email)!;
    expect(repairedAccount).toMatchObject({ id: account.id, tenantId: 1, active: true });
    expect(repairedAccount.teamMemberId).not.toBe(foreignProfile.id);
    expect(storage.getTeamMemberById(repairedAccount.teamMemberId!)).toMatchObject({
      email,
      tenantId: 1,
      active: false,
    });
    expect(storage.getTeamMemberById(foreignProfile.id)).toMatchObject({
      tenantId: 2,
      active: true,
    });

    const repair = rawDb.prepare(
      "SELECT action, tenant_id tenantId, details FROM activity_log WHERE action = 'onboarding.rep_profile_link_repaired' ORDER BY id DESC LIMIT 1",
    ).get() as any;
    expect(repair).toMatchObject({ action: "onboarding.rep_profile_link_repaired", tenantId: 1 });
    expect(JSON.parse(repair.details)).toMatchObject({
      applicationId: application.id,
      detachedRepId: foreignProfile.id,
      linkedRepId: repairedAccount.teamMemberId,
      reason: "foreign_tenant_profile",
    });
  });

  it("does not let an unowned login be claimed when its linked profile proves another tenant owns it", async () => {
    const email = "foreign-owned-account@approval-flow.example.com";
    const foreignProfile = storage.createTeamMember({
      name: "Foreign Owned Account",
      email,
      role: "rep",
      active: true,
      tenantId: 2,
    } as any);
    const account = storage.createUser({
      name: "Foreign Owned Account",
      email,
      role: "rep",
      active: true,
      tenantId: null,
      teamMemberId: foreignProfile.id,
    } as any);
    // Model a legacy/corrupted row. Normal createUser correctly inherits tenant
    // 2 from the linked profile, so only an old direct DB write can produce this.
    rawDb.prepare("UPDATE users SET tenant_id = NULL WHERE id = ?").run(account.id);
    const application = createCareersApplication(email);

    const response = await review(application.id, adminSession, { status: "approved" });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "That email is linked to a rep profile in another organization.",
    });
    expect(storage.getUserByEmail(email)).toMatchObject({
      id: account.id,
      tenantId: null,
      teamMemberId: foreignProfile.id,
    });
    expect(storage.getRepApplicationById(application.id)).toMatchObject({ status: "pending" });
  });

  it("allows only the owning admin and creates one account, login email, rep profile, and agreement pack across retries", async () => {
    const email = "approved-candidate@approval-flow.example.com";
    const application = createCareersApplication(email);

    expect((await review(application.id, managerSession, { status: "approved" })).status).toBe(403);
    expect((await review(application.id, otherTenantAdminSession, { status: "approved" })).status).toBe(404);

    const first = await review(application.id, adminSession, { status: "approved" });
    const approved = await first.json() as any;
    expect(first.status, JSON.stringify(approved)).toBe(200);
    expect(approved).toMatchObject({ status: "approved", welcomeWarning: null, onboardingWarning: null });
    expect(approved.welcomeEmailId).toMatch(/^resend-/);
    expect(approved.onboardingDocuments.createdCount).toBe(4);

    const account = storage.getUserByEmail(email)!;
    expect(account).toMatchObject({ tenantId: 1, role: "rep", active: true });
    expect(account.teamMemberId).not.toBeNull();
    expect(storage.getTeamMemberById(account.teamMemberId!)!).toMatchObject({ tenantId: 1, role: "rep", active: false });
    expect(rawDb.prepare("SELECT COUNT(*) count FROM users WHERE email = ?").get(email)).toMatchObject({ count: 1 });
    expect(rawDb.prepare("SELECT COUNT(*) count FROM team_members WHERE email = ?").get(email)).toMatchObject({ count: 1 });
    expect(rawDb.prepare("SELECT COUNT(*) count FROM onboarding_signing_documents WHERE rep_id = ?").get(account.teamMemberId)).toMatchObject({ count: 4 });
    expect(storage.getRepApplicationById(application.id)).toMatchObject({
      userId: account.id,
      status: "approved",
      loginEmailId: approved.welcomeEmailId,
    });
    expect(fetch).toHaveBeenCalledTimes(2);

    const retry = await review(application.id, adminSession, { status: "approved" });
    const retried = await retry.json() as any;
    expect(retry.status, JSON.stringify(retried)).toBe(200);
    expect(retried.onboardingDocuments.createdCount).toBe(0);
    expect(retried.onboardingDocuments.results.every((result: any) => result.skipped)).toBe(true);
    expect(rawDb.prepare("SELECT COUNT(*) count FROM users WHERE email = ?").get(email)).toMatchObject({ count: 1 });
    expect(rawDb.prepare("SELECT COUNT(*) count FROM team_members WHERE email = ?").get(email)).toMatchObject({ count: 1 });
    expect(rawDb.prepare("SELECT COUNT(*) count FROM onboarding_signing_documents WHERE rep_id = ?").get(account.teamMemberId)).toMatchObject({ count: 4 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("requires and stores a rejection reason without creating an account", async () => {
    const email = "rejected-candidate@approval-flow.example.com";
    const application = createCareersApplication(email);
    expect((await review(application.id, adminSession, { status: "rejected" })).status).toBe(400);

    const response = await review(application.id, adminSession, {
      status: "rejected",
      reviewNotes: "Territory staffing requirements changed.",
    });
    const rejected = await response.json() as any;
    expect(response.status, JSON.stringify(rejected)).toBe(200);
    expect(rejected).toMatchObject({
      status: "rejected",
      reviewNotes: "Territory staffing requirements changed.",
    });
    expect(storage.getUserByEmail(email)).toBeUndefined();
  });
});
