import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let payoutStore: typeof import("../../server/payoutStore");
let rawDb: import("better-sqlite3").Database;
let tenantAAdminId: number;
let tenantAPrivilegedId: number;
let tenantAOrdinaryUserId: number;
let tenantARepId: number;
let tenantBRepId: number;
let adminSession: string;
let managerSession: string;
let corruptedRepSession: string;
const realFetch = globalThis.fetch.bind(globalThis);

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-tenant-identity-payout-"));
  process.env.NODE_ENV = "test";
  // Mark Connect configured. The cross-tenant guard must reject before any
  // outbound Stripe request is attempted.
  process.env.STRIPE_SECRET_KEY = "sk_test_tenant_isolation_only";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  payoutStore = await import("../../server/payoutStore");
  const { registerRoutes } = await import("../../server/routes");

  rawDb.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (2, 'tenant-b-security', 'Tenant B', 'Owner B', 'owner-b-security@example.com', 'Tenant B')",
  ).run();

  const tenantARep = storage.createTeamMember({
    name: "Tenant A Rep",
    email: "rep-a-security@example.com",
    role: "rep",
    active: true,
    tenantId: 1,
  } as any);
  const tenantBRep = storage.createTeamMember({
    name: "Tenant B Rep",
    email: "rep-b-security@example.com",
    role: "rep",
    active: true,
    tenantId: 2,
  } as any);
  const tenantAOtherRep = storage.createTeamMember({
    name: "Tenant A Other Rep",
    email: "other-rep-a-security@example.com",
    role: "rep",
    active: true,
    tenantId: 1,
  } as any);
  tenantARepId = tenantARep.id;
  tenantBRepId = tenantBRep.id;

  const admin = storage.createUser({
    name: "Tenant A Admin",
    email: "admin-a-security@example.com",
    role: "admin",
    active: true,
    tenantId: 1,
  } as any);
  const manager = storage.createUser({
    name: "Tenant A Manager",
    email: "manager-a-security@example.com",
    role: "manager",
    active: true,
    tenantId: 1,
  } as any);
  const privileged = storage.createUser({
    name: "Tenant A Compliance Admin",
    email: "compliance-a-security@example.com",
    role: "compliance_admin",
    active: true,
    tenantId: 1,
  } as any);
  const ordinary = storage.createUser({
    name: "Tenant A Ordinary Rep",
    email: "ordinary-a-security@example.com",
    role: "rep",
    active: true,
    tenantId: 1,
    teamMemberId: tenantARep.id,
  } as any);
  storage.createUser({
    name: "Tenant A Other Rep",
    email: "other-rep-a-security@example.com",
    role: "rep",
    active: true,
    tenantId: 1,
    teamMemberId: tenantAOtherRep.id,
  } as any);
  // Simulate a legacy corrupt link that predates the route validation. Payout
  // routes must still reject it before returning/creating a Stripe account link.
  const corruptRep = storage.createUser({
    name: "Corrupt Tenant A Rep Login",
    email: "corrupt-a-security@example.com",
    role: "rep",
    active: true,
    tenantId: 1,
    teamMemberId: tenantBRep.id,
  } as any);
  storage.createUser({
    name: "Tenant B Legitimate Rep Login",
    email: "foreign-team-login-security@example.com",
    role: "rep",
    active: true,
    tenantId: 2,
    teamMemberId: tenantBRep.id,
  } as any);

  tenantAAdminId = admin.id;
  tenantAPrivilegedId = privileged.id;
  tenantAOrdinaryUserId = ordinary.id;
  adminSession = storage.createSession(admin.id).id;
  managerSession = storage.createSession(manager.id).id;
  corruptedRepSession = storage.createSession(corruptRep.id).id;

  payoutStore.ensurePayoutAccount(tenantBRep.id, 2);
  payoutStore.setStripeAccountId(2, tenantBRep.id, "acct_tenant_b_existing");

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.STRIPE_SECRET_KEY;
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

function request(path: string, sessionId: string, init: RequestInit = {}) {
  return realFetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-session-id": sessionId,
      ...(init.headers ?? {}),
    },
  });
}

describe("tenant-scoped login account links", () => {
  it("rejects create and patch attempts that link a tenant A login to tenant B's member", async () => {
    const createResponse = await request("/api/users", adminSession, {
      method: "POST",
      body: JSON.stringify({
        name: "Foreign Link Attempt",
        email: "foreign-link-attempt@example.com",
        role: "rep",
        teamMemberId: tenantBRepId,
      }),
    });
    expect(createResponse.status).toBe(409);
    expect(await createResponse.json()).toMatchObject({ code: "TEAM_MEMBER_TENANT_MISMATCH" });
    expect(storage.getUserByEmail("foreign-link-attempt@example.com")).toBeUndefined();

    const patchResponse = await request(`/api/users/${tenantAOrdinaryUserId}`, adminSession, {
      method: "PATCH",
      body: JSON.stringify({ teamMemberId: tenantBRepId }),
    });
    expect(patchResponse.status).toBe(409);
    expect(await patchResponse.json()).toMatchObject({ code: "TEAM_MEMBER_TENANT_MISMATCH" });
    expect(storage.getUserById(tenantAOrdinaryUserId)?.teamMemberId).not.toBe(tenantBRepId);
  });
});

describe("tenant-scoped team login synchronization", () => {
  it("rejects foreign and already-linked emails before creating a team member", async () => {
    const before = storage.getTeamMembers(1).length;
    const foreignResponse = await request("/api/team", adminSession, {
      method: "POST",
      body: JSON.stringify({
        name: "Foreign Email Team Attempt",
        email: "foreign-team-login-security@example.com",
        role: "rep",
        active: true,
      }),
    });
    expect(foreignResponse.status).toBe(409);
    expect(await foreignResponse.json()).toMatchObject({ code: "LOGIN_EMAIL_OTHER_ORGANIZATION" });
    expect(storage.getTeamMembers(1)).toHaveLength(before);

    const linkedResponse = await request("/api/team", adminSession, {
      method: "POST",
      body: JSON.stringify({
        name: "Linked Email Team Attempt",
        email: "ordinary-a-security@example.com",
        role: "rep",
        active: true,
      }),
    });
    expect(linkedResponse.status).toBe(409);
    expect(await linkedResponse.json()).toMatchObject({ code: "LOGIN_EMAIL_ALREADY_LINKED" });
    expect(storage.getTeamMembers(1)).toHaveLength(before);

    const privilegedResponse = await request("/api/team", adminSession, {
      method: "POST",
      body: JSON.stringify({
        name: "Admin Email Relink Attempt",
        email: "admin-a-security@example.com",
        role: "rep",
        active: true,
      }),
    });
    expect(privilegedResponse.status).toBe(409);
    expect(await privilegedResponse.json()).toMatchObject({ code: "LOGIN_EMAIL_ROLE_CONFLICT" });
    expect(storage.getTeamMembers(1)).toHaveLength(before);
  });

  it("rejects a foreign email before patching the member or either login", async () => {
    const memberBefore = storage.getTeamMemberById(tenantARepId)!;
    const foreignBefore = storage.getUserByEmail("foreign-team-login-security@example.com")!;
    const response = await request(`/api/team/${tenantARepId}`, adminSession, {
      method: "PATCH",
      body: JSON.stringify({
        name: "Must Not Persist",
        email: "foreign-team-login-security@example.com",
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "LOGIN_EMAIL_OTHER_ORGANIZATION" });
    expect(storage.getTeamMemberById(tenantARepId)).toMatchObject({
      name: memberBefore.name,
      email: memberBefore.email,
      tenantId: 1,
    });
    expect(storage.getUserByEmail("foreign-team-login-security@example.com")).toMatchObject({
      id: foreignBefore.id,
      tenantId: 2,
      teamMemberId: tenantBRepId,
    });

    const linkedResponse = await request(`/api/team/${tenantARepId}`, adminSession, {
      method: "PATCH",
      body: JSON.stringify({
        name: "Also Must Not Persist",
        email: "other-rep-a-security@example.com",
      }),
    });
    expect(linkedResponse.status).toBe(409);
    expect(await linkedResponse.json()).toMatchObject({ code: "LOGIN_EMAIL_ALREADY_LINKED" });
    expect(storage.getTeamMemberById(tenantARepId)).toMatchObject({
      name: memberBefore.name,
      email: memberBefore.email,
      tenantId: 1,
    });
  });

  it("creates and updates a new login without ever changing its tenant", async () => {
    const createResponse = await request("/api/team", adminSession, {
      method: "POST",
      body: JSON.stringify({
        name: "Scoped Sync Rep",
        email: "Scoped.Sync.Rep@Example.com",
        role: "rep",
        active: true,
      }),
    });
    const created = await createResponse.json() as any;
    expect(createResponse.status, JSON.stringify(created)).toBe(201);
    expect(created).toMatchObject({ email: "scoped.sync.rep@example.com", tenantId: 1 });
    expect(storage.getUserByEmail("scoped.sync.rep@example.com")).toMatchObject({
      tenantId: 1,
      teamMemberId: created.id,
      role: "rep",
    });

    const patchResponse = await request(`/api/team/${created.id}`, adminSession, {
      method: "PATCH",
      body: JSON.stringify({ name: "Scoped Sync Rep Updated" }),
    });
    expect(patchResponse.status).toBe(200);
    expect(storage.getUserByEmail("scoped.sync.rep@example.com")).toMatchObject({
      name: "Scoped Sync Rep Updated",
      tenantId: 1,
      teamMemberId: created.id,
    });
  });
});

describe("tenant-scoped Stripe Connect access", () => {
  it("rejects a legacy cross-tenant rep link without reading or mutating the foreign account", async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    const accountResponse = await request("/api/payouts/account", corruptedRepSession);
    expect(accountResponse.status).toBe(403);

    const connectResponse = await request("/api/payouts/connect", corruptedRepSession, { method: "POST" });
    expect(connectResponse.status).toBe(403);
    // The security invariant is that no STRIPE API call happens for the foreign
    // account — not "no fetch at all": background workers (the Kinetic token
    // pool warmer) legitimately call fetch on unrelated URLs during this test,
    // and asserting zero total calls races with them.
    const stripeCalls = providerFetch.mock.calls.filter((c) => String(c[0]).includes("stripe"));
    expect(stripeCalls).toHaveLength(0);
    expect(payoutStore.getPayoutAccount(2, tenantBRepId)).toMatchObject({
      tenantId: 2,
      stripeAccountId: "acct_tenant_b_existing",
    });
    vi.unstubAllGlobals();
  });
});

describe("destructive login administration", () => {
  it("does not let a manager delete privileged users", async () => {
    const response = await request(`/api/users/${tenantAPrivilegedId}`, managerSession, { method: "DELETE" });
    expect(response.status).toBe(403);
    expect(storage.getUserById(tenantAPrivilegedId)).toBeTruthy();
  });

  it("does not let an admin delete their own login", async () => {
    const response = await request(`/api/users/${tenantAAdminId}`, adminSession, { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CANNOT_DELETE_SELF" });
    expect(storage.getUserById(tenantAAdminId)).toBeTruthy();
  });
});
