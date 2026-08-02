// Spiff routes — the security + money-safety contract:
//   * a rep sees ONLY their own feed; the team heat (algorithm data) is
//     manager+; approve / mark-paid are admin-only and audited,
//   * tenant walls hold (tenant 2 spiffs never appear in tenant 1 reads and
//     can't be approved by a tenant 1 admin),
//   * status transitions are enforced (earned → approved → paid; anything else 409),
//   * evaluating a sale for a spiff inserts into the spiffs ledger ONLY and never
//     touches the commission tables (proof the recognition path is money-safe),
//   * evaluation is idempotent on the sale ref.
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
let spiffStore: typeof import("../../server/spiffStore");

let repSession: string;
let managerSession: string;
let adminSession: string;
let foreignAdminSession: string;
let repTmId: number;
let foreignTmId: number;

const realFetch = globalThis.fetch.bind(globalThis);

function countRows(sql: string, ...params: any[]): number {
  try { return (rawDb.prepare(sql).get(...params) as any)?.n ?? 0; } catch { return 0; }
}
function insertSpiff(tenantId: number, repId: number, saleRef: string, status = "earned", reason = "random"): number {
  const info = rawDb.prepare(
    `INSERT INTO spiffs (tenant_id, rep_id, sale_ref, amount_cents, reason, status, created_at) VALUES (?,?,?,?,?,?,datetime('now'))`,
  ).run(tenantId, repId, saleRef, 5000, reason, status);
  return Number(info.lastInsertRowid);
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-spiff-routes-"));
  process.env.NODE_ENV = "test";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  spiffStore = await import("../../server/spiffStore");
  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");

  rawDb.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (1, 'tenant-a-spiff', 'Tenant A', 'Owner A', 'owner-a-spiff@example.com', 'Tenant A')",
  ).run();
  rawDb.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (2, 'tenant-b-spiff', 'Tenant B', 'Owner B', 'owner-b-spiff@example.com', 'Tenant B')",
  ).run();

  const repTm = storage.createTeamMember({ name: "Spiff Rep", role: "rep", active: true, tenantId: 1 } as any);
  const foreignTm = storage.createTeamMember({ name: "Foreign Rep", role: "rep", active: true, tenantId: 2 } as any);
  repTmId = repTm.id;
  foreignTmId = foreignTm.id;

  const rep = storage.createUser({ name: "Spiff Rep", email: "rep-spiff@example.com", role: "rep", active: true, tenantId: 1, teamMemberId: repTm.id } as any);
  const manager = storage.createUser({ name: "Spiff Manager", email: "manager-spiff@example.com", role: "manager", active: true, tenantId: 1 } as any);
  const admin = storage.createUser({ name: "Spiff Admin", email: "admin-spiff@example.com", role: "admin", active: true, tenantId: 1 } as any);
  const foreignAdmin = storage.createUser({ name: "Foreign Admin", email: "admin-b-spiff@example.com", role: "admin", active: true, tenantId: 2 } as any);

  repSession = storage.createSession(rep.id).id;
  managerSession = storage.createSession(manager.id).id;
  adminSession = storage.createSession(admin.id).id;
  foreignAdminSession = storage.createSession(foreignAdmin.id).id;

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app); // the spiff routes live here (the SaaS route block)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
});

function request(path: string, sessionId: string | null, init: RequestInit = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as any ?? {}) };
  if (sessionId) { headers["x-session-id"] = sessionId; headers["x-csrf-token"] = sessionId; }
  return realFetch(`${baseUrl}${path}`, { ...init, headers });
}

describe("GET /api/spiffs/mine", () => {
  it("requires auth", async () => {
    expect((await realFetch(`${baseUrl}/api/spiffs/mine`)).status).toBe(401);
  });

  it("returns the rep's own spiffs + heat, never another rep's", async () => {
    insertSpiff(1, repTmId, "seed:mine-1", "earned");
    insertSpiff(1, foreignTmId, "seed:other-1", "earned"); // different rep + tenant
    const res = await request("/api/spiffs/mine", repSession);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.spiffs.every((s: any) => s.repId === repTmId)).toBe(true);
    expect(body.spiffs.some((s: any) => s.saleRef === "seed:mine-1")).toBe(true);
    expect(typeof body.heat).toBe("number");
    expect(body.totals.count).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/spiffs/team (algorithm data — manager+)", () => {
  it("a rep is forbidden", async () => {
    expect((await request("/api/spiffs/team", repSession)).status).toBe(403);
  });

  it("a manager sees per-rep heat, walled to their own tenant", async () => {
    const res = await request("/api/spiffs/team", managerSession);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.reps)).toBe(true);
    // The foreign tenant's rep never appears.
    expect(body.reps.some((r: any) => r.repId === foreignTmId)).toBe(false);
    expect(body.reps.some((r: any) => r.repId === repTmId)).toBe(true);
    // pending queue is tenant-scoped too — nothing from tenant 2 leaks in.
    expect((body.pending as any[]).every((p) => p.tenantId === 1)).toBe(true);
  });
});

describe("POST /api/spiffs/:id/approve and /paid (admin-only, audited)", () => {
  it("a rep cannot approve", async () => {
    const id = insertSpiff(1, repTmId, "seed:approve-rep", "earned");
    expect((await request(`/api/spiffs/${id}/approve`, repSession, { method: "POST" })).status).toBe(403);
  });

  it("a manager cannot approve (approve/paid are admin-only)", async () => {
    const id = insertSpiff(1, repTmId, "seed:approve-mgr", "earned");
    expect((await request(`/api/spiffs/${id}/approve`, managerSession, { method: "POST" })).status).toBe(403);
  });

  it("an admin drives earned → approved → paid, and it is audited", async () => {
    const id = insertSpiff(1, repTmId, "seed:transition", "earned");
    const approve = await request(`/api/spiffs/${id}/approve`, adminSession, { method: "POST" });
    expect(approve.status).toBe(200);
    expect((await approve.json() as any).status).toBe("approved");

    const paid = await request(`/api/spiffs/${id}/paid`, adminSession, { method: "POST" });
    expect(paid.status).toBe(200);
    const paidBody = await paid.json() as any;
    expect(paidBody.status).toBe("paid");
    expect(paidBody.paidAt).toBeTruthy();

    const audit = countRows("SELECT COUNT(*) AS n FROM activity_log WHERE action IN ('spiff.approved','spiff.paid') AND entity_id = ?", id);
    expect(audit).toBe(2);
  });

  it("rejects an out-of-order transition (paid before approved) with 409", async () => {
    const id = insertSpiff(1, repTmId, "seed:bad-transition", "earned");
    expect((await request(`/api/spiffs/${id}/paid`, adminSession, { method: "POST" })).status).toBe(409);
  });

  it("tenant-walls approval: a tenant-1 admin cannot approve a tenant-2 spiff (404)", async () => {
    const id = insertSpiff(2, foreignTmId, "seed:cross-tenant", "earned");
    expect((await request(`/api/spiffs/${id}/approve`, adminSession, { method: "POST" })).status).toBe(404);
    // And the foreign admin CAN.
    expect((await request(`/api/spiffs/${id}/approve`, foreignAdminSession, { method: "POST" })).status).toBe(200);
  });
});

describe("evaluateSpiffForSale is money-safe + idempotent", () => {
  it("awards a spiff row WITHOUT touching commission tables", async () => {
    // A dedicated rep with a clean slate, so seeded spiffs from earlier tests
    // don't consume the daily cap.
    const rep = storage.createTeamMember({ name: "Money Rep", role: "rep", active: true, tenantId: 1 } as any).id;
    // A committed sold knock the snapshot can read.
    rawDb.prepare(
      `INSERT INTO knock_log (lead_id, rep_id, knocked_at, was_home, outcome, superseded, tenant_id) VALUES (?,?,?,?,?,0,?)`,
    ).run(9001, rep, new Date().toISOString(), 1, "sold", 1);

    const commBefore = countRows("SELECT COUNT(*) AS n FROM commissions");
    const salesBefore = countRows("SELECT COUNT(*) AS n FROM commission_sales");
    const spiffBefore = countRows("SELECT COUNT(*) AS n FROM spiffs WHERE tenant_id = 1 AND rep_id = ?", rep);

    // Force an award (100% random chance) — the exact call the route hook makes.
    const result = spiffStore.evaluateSpiffForSale({
      tenantId: 1, repId: rep, saleRef: "knock:9001", nowMs: Date.now(),
      seed: "test-seed", actorId: null,
      config: { amountCents: 5000, randomChancePct: 100, streakThresholdDays: 3, improvementPct: 50, milestoneEvery: 10, dailyCapPerRep: 5 },
    });
    expect(result.spiff?.amountCents).toBe(5000);

    const commAfter = countRows("SELECT COUNT(*) AS n FROM commissions");
    const salesAfter = countRows("SELECT COUNT(*) AS n FROM commission_sales");
    const spiffAfter = countRows("SELECT COUNT(*) AS n FROM spiffs WHERE tenant_id = 1 AND rep_id = ?", rep);

    // Commission math is untouched; the spiff ledger grew by exactly one.
    expect(commAfter).toBe(commBefore);
    expect(salesAfter).toBe(salesBefore);
    expect(spiffAfter).toBe(spiffBefore + 1);
  });

  it("is idempotent on the sale ref (a replay awards no second row)", async () => {
    const before = countRows("SELECT COUNT(*) AS n FROM spiffs WHERE sale_ref = 'knock:9001'");
    const replay = spiffStore.evaluateSpiffForSale({
      tenantId: 1, repId: repTmId, saleRef: "knock:9001", nowMs: Date.now(),
      seed: "test-seed", actorId: null,
      config: { amountCents: 5000, randomChancePct: 100, streakThresholdDays: 3, improvementPct: 50, milestoneEvery: 10, dailyCapPerRep: 5 },
    });
    expect(replay.duplicate).toBe(true);
    const after = countRows("SELECT COUNT(*) AS n FROM spiffs WHERE sale_ref = 'knock:9001'");
    expect(after).toBe(before);
  });
});
