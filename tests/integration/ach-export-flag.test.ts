// @vitest-environment node
// ── The ACH export is inert until someone turns it on deliberately ───────────
// GET /api/pay/nacha originates real money movement, and four blockers are
// still open (no payment ledger, a pay-period-derived effective date, service
// class 200 on a credits-only batch, and pay ciphertext with no key version —
// see the comment block in server/payRoutes.ts). Until they are closed the
// route must refuse, and it must refuse in a way an operator can act on: a 503
// with the machine-readable code ACH_EXPORT_DISABLED.
//
// The NACHA code itself is NOT deleted or broken — this suite proves both
// halves of the switch, so the day the blockers are fixed, flipping the flag is
// all that is required.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let managerSession: string;
let adminSession: string;

const realFetch = globalThis.fetch.bind(globalThis);

function request(path: string, sessionId: string | null, init: RequestInit = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as any ?? {}) };
  if (sessionId) { headers["x-session-id"] = sessionId; headers["x-csrf-token"] = sessionId; }
  return realFetch(`${baseUrl}${path}`, { ...init, headers });
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-ach-flag-"));
  process.env.NODE_ENV = "test";
  process.env.PAY_CRYPTO_KEY = "b".repeat(64);
  delete process.env.ACH_EXPORT_ENABLED;

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  const { storage } = storageModule;
  const { rawDb } = await import("../../server/db");
  const { registerRoutes } = await import("../../server/routes");

  rawDb.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (1, 'tenant-ach', 'Tenant ACH', 'Owner', 'owner-ach@example.com', 'Tenant ACH')",
  ).run();

  const manager = storage.createUser({ name: "ACH Manager", email: "manager-ach@example.com", role: "manager", active: true, tenantId: 1 } as any);
  const admin = storage.createUser({ name: "ACH Admin", email: "admin-ach@example.com", role: "admin", active: true, tenantId: 1 } as any);
  managerSession = storage.createSession(manager.id).id;
  adminSession = storage.createSession(admin.id).id;

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  // The ODFI profile the generator needs once the flag is on.
  const configured = await request("/api/company-profile", adminSession, {
    method: "PUT",
    body: JSON.stringify({
      legalName: "Tenant ACH LLC", ein: "123456789",
      dfiAccount: "1234567890", dfiRouting: "021000021", companyId: "1123456789",
    }),
  });
  expect(configured.status).toBe(200);
});

afterEach(() => { delete process.env.ACH_EXPORT_ENABLED; });

afterAll(async () => {
  delete process.env.ACH_EXPORT_ENABLED;
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
});

describe("GET /api/pay/nacha capability (SEC-A fix 3: money movement = payouts.pay, never a read band)", () => {
  it("a commission.read.all manager (read band) is refused BEFORE the kill switch", async () => {
    const res = await request("/api/pay/nacha?weekStart=2026-07-27", managerSession);
    expect(res.status).toBe(403);
  });

  it("the read band stays refused even with the flag explicitly enabled", async () => {
    process.env.ACH_EXPORT_ENABLED = "true";
    const res = await request("/api/pay/nacha?weekStart=2026-07-27", managerSession);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/pay/nacha is OFF by default", () => {
  it("503s with ACH_EXPORT_DISABLED when the flag is unset", async () => {
    const res = await request("/api/pay/nacha?weekStart=2026-07-27", adminSession);
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.code).toBe("ACH_EXPORT_DISABLED");
    // The message has to tell an operator what is missing, not just "disabled".
    expect(body.error).toMatch(/ledger/i);
    expect(body.error).toMatch(/ACH_EXPORT_ENABLED/);
  });

  it("stays off for any value other than the exact string \"true\"", async () => {
    for (const value of ["1", "yes", "TRUE", "", "false"]) {
      process.env.ACH_EXPORT_ENABLED = value;
      const res = await request("/api/pay/nacha?weekStart=2026-07-27", adminSession);
      expect(res.status, `ACH_EXPORT_ENABLED=${JSON.stringify(value)} must not enable the export`).toBe(503);
      expect((await res.json() as any).code).toBe("ACH_EXPORT_DISABLED");
    }
  });

  it("never emits a NACHA file body while disabled", async () => {
    const res = await request("/api/pay/nacha?weekStart=2026-07-27", adminSession);
    const text = await res.text();
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(text).not.toMatch(/^101/m);   // NACHA file header record
    expect(res.headers.get("x-nacha-entry-count")).toBeNull();
  });

  it("still refuses an unauthorized caller before it refuses the export", async () => {
    // Authorization is evaluated first — the kill switch must not become a way
    // to probe the route without a capability.
    expect((await realFetch(`${baseUrl}/api/pay/nacha?weekStart=2026-07-27`)).status).toBe(401);
  });
});

describe("GET /api/pay/nacha with the flag explicitly enabled", () => {
  it('generates the file again when ACH_EXPORT_ENABLED === "true" (payouts.pay holder)', async () => {
    process.env.ACH_EXPORT_ENABLED = "true";
    const res = await request("/api/pay/nacha?weekStart=2026-07-27", adminSession);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text.split("\n")[0].startsWith("101")).toBe(true);
  });

  it("the flag does not bypass the capability check", async () => {
    process.env.ACH_EXPORT_ENABLED = "true";
    expect((await realFetch(`${baseUrl}/api/pay/nacha?weekStart=2026-07-27`)).status).toBe(401);
  });
});

describe("the 1099 summary is untouched - it is read-only reporting", () => {
  it("keeps working while the ACH export is disabled", async () => {
    const res = await request("/api/pay/1099-summary", managerSession);
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json() as any).reps)).toBe(true);
  });
});
