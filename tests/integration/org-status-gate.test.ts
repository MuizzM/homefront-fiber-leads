// ── Organization status gate ─────────────────────────────────────────────────
//
// P0: `tenants.status` was written by the super-admin console (DELETE
// /api/sa/tenants/:id sets "cancelled") and read by NOTHING at request time.
// Every user of a cancelled organization kept logging in and working
// indefinitely — the cancellation was a label, not a revocation.
//
// What is pinned here:
//   1. an existing session for a suspended/cancelled org is refused (the gate
//      rides requireAuth, so sessions minted BEFORE the flip die too)
//   2. a user of a dead org cannot mint a NEW session at OTP verify either
//   3. an ACTIVE org is completely unaffected
//   4. the platform owner (is_super_admin) is never locked out — they are the
//      only identity that can undo a suspension
//   5. the training-gate allowlist is honoured, so a blocked user can still
//      reach /api/auth to sign out rather than being trapped in a dead app
//   6. cancelling an org sweeps its sessions at the moment it is ordered
//   7. the gate fails OPEN if the tenant lookup itself breaks — a bug here must
//      never lock every live org out of the app at once
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

const LIVE = 1;      // stays active throughout
const DOOMED = 2;    // gets suspended / cancelled

let liveRepSession = "";
let doomedRepSession = "";
let doomedAdminSession = "";
let ownerSession = "";
let doomedRepUserId = 0;

function req(path: string, sessionId: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, ...(init.headers ?? {}) },
  });
}

const setStatus = (tenantId: number, status: string) =>
  rawDb.prepare(`UPDATE tenants SET status = ? WHERE id = ?`).run(status, tenantId);

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-org-status-gate-"));
  process.env.NODE_ENV = "test";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  rawDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
     VALUES (?, 'doomed-fiber', 'Doomed Fiber', 'Owner D', 'owner@doomed.example.test', 'Doomed')`,
  ).run(DOOMED);

  const liveRepMember = storage.createTeamMember({
    name: "Live Rep", email: "rep@live.example.test", role: "rep", active: true, tenantId: LIVE,
  } as any);
  const liveRepUser = storage.createUser({
    name: "Live Rep", email: "rep@live.example.test", role: "rep", active: true,
    tenantId: LIVE, teamMemberId: liveRepMember.id,
  } as any);
  liveRepSession = storage.createSession(liveRepUser.id).id;

  const doomedRepMember = storage.createTeamMember({
    name: "Doomed Rep", email: "rep@doomed.example.test", role: "rep", active: true, tenantId: DOOMED,
  } as any);
  const doomedRepUser = storage.createUser({
    name: "Doomed Rep", email: "rep@doomed.example.test", role: "rep", active: true,
    tenantId: DOOMED, teamMemberId: doomedRepMember.id,
  } as any);
  doomedRepUserId = doomedRepUser.id;
  doomedRepSession = storage.createSession(doomedRepUser.id).id;

  const doomedAdmin = storage.createUser({
    name: "Doomed Admin", email: "admin@doomed.example.test", role: "admin", active: true, tenantId: DOOMED,
  } as any);
  doomedAdminSession = storage.createSession(doomedAdmin.id).id;

  // Platform owner: tenant-less apex identity with the immutable flag set.
  const owner = storage.createUser({
    name: "Platform Owner", email: "owner@homefront.example.test", role: "admin", active: true, tenantId: null,
  } as any);
  rawDb.prepare(`UPDATE users SET is_super_admin = 1 WHERE id = ?`).run(owner.id);
  ownerSession = storage.createSession(owner.id).id;

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

describe("an ACTIVE organization is unaffected", () => {
  it("serves a normal request", async () => {
    const res = await req("/api/leads", liveRepSession);
    expect(res.status).toBe(200);
  });
});

describe("a SUSPENDED organization loses access", () => {
  beforeAll(() => setStatus(DOOMED, "suspended"));

  it("refuses a session that was minted BEFORE the suspension", async () => {
    const res = await req("/api/leads", doomedRepSession);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("ORGANIZATION_INACTIVE");
  });

  it("refuses the org's admin too - suspension is not a role question", async () => {
    const res = await req("/api/team", doomedAdminSession);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("ORGANIZATION_INACTIVE");
  });

  it("REVIEW FIX: does NOT leave the recruiting plane open - a dead org cannot keep hiring", async () => {
    // The gate originally reused the TRAINING allowlist, which answers a
    // different question ("what does an untrained rep need to become
    // employable") and therefore exempted /api/onboarding — the routes that
    // send invitations on the platform's own mail domain and mint user
    // accounts. A suspended organization must not keep hiring.
    const res = await req("/api/onboarding/applications", doomedAdminSession);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("ORGANIZATION_INACTIVE");
  });

  it("still lets the blocked user reach /api/auth so they can sign out", async () => {
    // logout-all sits behind requireAuth, so it genuinely runs the gate rather
    // than passing vacuously the way an unrouted path would.
    const res = await req("/api/auth/logout-all", doomedRepSession, { method: "POST" });
    expect(res.status).toBe(200);
    // …and that really did end the session, so the escape hatch works.
    expect(storage.getSession(doomedRepSession)).toBeFalsy();
    doomedRepSession = storage.createSession(doomedRepUserId).id; // restore for later tests
  });

  it("does NOT touch the live organization", async () => {
    const res = await req("/api/leads", liveRepSession);
    expect(res.status).toBe(200);
  });

  it("never locks out the platform owner", async () => {
    const res = await req("/api/sa/tenants", ownerSession);
    expect(res.status).toBe(200);
  });
});

describe("a CANCELLED organization loses access", () => {
  beforeAll(() => setStatus(DOOMED, "cancelled"));

  it("refuses the request", async () => {
    const res = await req("/api/leads", doomedRepSession);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("ORGANIZATION_INACTIVE");
  });

  it("refuses to mint a NEW session at OTP verify", async () => {
    // Drive the real verify path with a known-good code.
    storage.createOtp?.("rep@doomed.example.test", "123456");
    rawDb.prepare(
      `INSERT INTO otp_codes (email, code, expires_at, used, created_at)
       VALUES (?,?,?,0,?)`,
    ).run("rep@doomed.example.test", "654321",
      new Date(Date.now() + 10 * 60_000).toISOString(), new Date().toISOString());
    const res = await fetch(`${baseUrl}/api/auth/otp/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "rep@doomed.example.test", code: "654321" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("ORGANIZATION_INACTIVE");
  });
});

describe("cancelling an org through the console revokes its sessions immediately", () => {
  it("sweeps every session for the tenant", async () => {
    // A fresh org so this test owns its own lifecycle.
    rawDb.prepare(
      `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name, status)
       VALUES (3, 'sweep-fiber', 'Sweep Fiber', 'Owner S', 'owner@sweep.example.test', 'Sweep', 'active')`,
    ).run();
    const u = storage.createUser({
      name: "Sweep Rep", email: "rep@sweep.example.test", role: "rep", active: true, tenantId: 3,
    } as any);
    const session = storage.createSession(u.id).id;
    expect(storage.getSession(session)).toBeTruthy();

    const res = await req("/api/sa/tenants/3", ownerSession, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.json()).sessionsRevoked).toBeGreaterThan(0);
    // The token itself is gone, not merely refused.
    expect(storage.getSession(session)).toBeFalsy();
  });
});

describe("REVIEW FIX: suspending through PATCH revokes sessions too", () => {
  it("sweeps sessions when the status flips to a blocking one", async () => {
    rawDb.prepare(
      `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name, status)
       VALUES (4, 'patch-fiber', 'Patch Fiber', 'Owner P', 'owner@patch.example.test', 'Patch', 'active')`,
    ).run();
    const u = storage.createUser({
      name: "Patch Rep", email: "rep@patch.example.test", role: "rep", active: true, tenantId: 4,
    } as any);
    const session = storage.createSession(u.id).id;
    expect(storage.getSession(session)).toBeTruthy();

    // Only DELETE swept sessions before; PATCH could set the same status and
    // leave every device signed in — and requireAuth slides the expiry forward
    // on each request, so an allowlisted poll kept them alive indefinitely.
    const res = await req("/api/sa/tenants/4", ownerSession, {
      method: "PATCH", body: JSON.stringify({ status: "suspended" }),
    });
    expect(res.status).toBe(200);
    expect(storage.getSession(session)).toBeFalsy();
  });
});

describe("the gate fails OPEN when the lookup itself breaks", () => {
  it("serves the request rather than locking out the floor", async () => {
    setStatus(DOOMED, "active");
    const original = storage.getTenantById;
    (storage as any).getTenantById = () => { throw new Error("simulated tenant lookup failure"); };
    try {
      const res = await req("/api/leads", doomedRepSession);
      expect(res.status).toBe(200);
    } finally {
      (storage as any).getTenantById = original;
    }
  });
});
