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
let managerSession: string;
let superAdminSession: string;
let managerUserId: number;
let tenantARepId: number;
let tenantBId: number;
let tenantBRepId: number;
let ownCommissionId: number;
let tenantBCommissionId: number;
let illegalCommissionId: number;
let paymentCommissionId: number;
let staleCommissionId: number;
let rollbackCommissionId: number;
let paidDateForbiddenCommissionId: number;

const realFetch = globalThis.fetch.bind(globalThis);

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-legacy-commission-tenant-"));
  process.env.NODE_ENV = "test";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));

  const tenantB = storage.createTenant({
    slug: "legacy-commission-tenant-b",
    companyName: "Commission Tenant B",
    ownerName: "Tenant B Owner",
    ownerEmail: "legacy-commission-owner-b@example.test",
    brandName: "Commission Tenant B",
  } as any);
  tenantBId = tenantB.id;

  const tenantARep = storage.createTeamMember({
    name: "Tenant A Commission Rep",
    email: "legacy-commission-rep-a@example.test",
    role: "rep",
    active: true,
    tenantId: 1,
  } as any);
  const tenantBRep = storage.createTeamMember({
    name: "Tenant B Commission Rep",
    email: "legacy-commission-rep-b@example.test",
    role: "rep",
    active: true,
    tenantId: tenantB.id,
  } as any);
  tenantARepId = tenantARep.id;
  tenantBRepId = tenantBRep.id;

  const manager = storage.createUser({
    name: "Tenant A Commission Manager",
    email: "legacy-commission-manager-a@example.test",
    role: "manager",
    active: true,
    tenantId: 1,
  } as any);
  managerUserId = manager.id;
  managerSession = storage.createSession(manager.id).id;

  const superAdmin = storage.createUser({
    name: "Tenantless Platform Admin",
    email: "tenantless-commission-admin@example.test",
    role: "admin",
    isSuperAdmin: 1,
    active: true,
    tenantId: null,
  } as any);
  superAdminSession = storage.createSession(superAdmin.id).id;

  ownCommissionId = createCommission(125, "pending", "tenant-a-private-note");
  tenantBCommissionId = storage.createCommission({
    repId: tenantBRep.id,
    amount: 9_999,
    status: "pending",
    saleDate: "2026-07-27",
    notes: "tenant-b-private-note",
  } as any).id;
  illegalCommissionId = createCommission(10, "pending");
  paymentCommissionId = createCommission(20, "approved", null, manager.id);
  staleCommissionId = createCommission(30, "pending");
  rollbackCommissionId = createCommission(40, "pending");
  paidDateForbiddenCommissionId = createCommission(50, "approved", null, manager.id);

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
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
});

function createCommission(
  amount: number,
  status: "pending" | "approved" | "paid" | "disputed",
  notes: string | null = null,
  approvedBy: number | null = null,
): number {
  return storage.createCommission({
    repId: tenantARepId,
    amount,
    status,
    saleDate: "2026-07-27",
    notes,
    approvedBy,
    paidDate: status === "paid" ? "2026-07-27" : null,
  } as any).id;
}

function request(path: string, init: RequestInit = {}, sessionId = managerSession) {
  return realFetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-session-id": sessionId,
      ...(init.headers ?? {}),
    },
  });
}

function patchCommission(
  id: number,
  body: Record<string, unknown>,
  sessionId = managerSession,
) {
  return request(`/api/commissions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  }, sessionId);
}

function commission(id: number, tenantId = 1) {
  return storage.getCommissionById(id, tenantId);
}

function revision(id: number, tenantId = 1): number {
  const value = commission(id, tenantId)?.revision;
  if (!value) throw new Error(`Missing commission ${id} revision`);
  return value;
}

function auditCount(id: number): number {
  return Number((rawDb.prepare(
    "SELECT COUNT(*) AS count FROM activity_log WHERE entity_type = 'commission' AND entity_id = ?",
  ).get(id) as { count: number }).count);
}

describe("legacy commission API tenant and lifecycle correctness", () => {
  it("lists only the caller tenant and does not disclose a foreign rep filter", async () => {
    const listResponse = await request("/api/commissions");
    expect(listResponse.status).toBe(200);
    const rows = await listResponse.json() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(6);
    expect(rows.every(row => row.tenantId === 1)).toBe(true);
    expect(rows.some(row => row.id === ownCommissionId)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("tenant-b-private-note");

    const foreignFilterResponse = await request(`/api/commissions?repId=${tenantBRepId}`);
    expect(foreignFilterResponse.status).toBe(404);
    expect(await foreignFilterResponse.json()).toEqual({ error: "Rep not found" });
  });

  it("fails closed for a tenantless super-admin", async () => {
    const patchResponse = await patchCommission(ownCommissionId, {
      expectedStatus: "pending",
      status: "approved",
    }, superAdminSession);
    expect(patchResponse.status).toBe(403);
    expect(await patchResponse.json()).toEqual({ error: "Organization required" });
    expect(commission(ownCommissionId)).toMatchObject({ status: "pending" });

    const summaryResponse = await request("/api/commissions/summary", {}, superAdminSession);
    expect(summaryResponse.status).toBe(403);
    expect(await summaryResponse.json()).toEqual({ error: "Organization required" });
  });

  it("returns a non-disclosing 404 and leaves a foreign commission unchanged", async () => {
    const response = await patchCommission(tenantBCommissionId, {
      expectedStatus: "pending",
      status: "approved",
      notes: "cross-tenant overwrite",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(commission(tenantBCommissionId, tenantBId)).toMatchObject({
      status: "pending",
      paidDate: null,
      notes: "tenant-b-private-note",
    });
    expect(auditCount(tenantBCommissionId)).toBe(0);
  });

  it("requires revision and status preconditions and rejects unknown status values", async () => {
    const missingRevision = await patchCommission(illegalCommissionId, {
      expectedStatus: "pending",
      status: "approved",
    });
    expect(missingRevision.status).toBe(400);
    expect(await missingRevision.json()).toMatchObject({ error: "Invalid commission update" });

    const missingExpectedStatus = await patchCommission(illegalCommissionId, {
      expectedRevision: revision(illegalCommissionId),
      status: "approved",
    });
    expect(missingExpectedStatus.status).toBe(400);
    expect(await missingExpectedStatus.json()).toMatchObject({ error: "Invalid commission update" });

    const unknown = await patchCommission(illegalCommissionId, {
      expectedRevision: revision(illegalCommissionId),
      expectedStatus: "pending",
      status: "wire_transfer_complete",
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: "Invalid commission update" });

    const forgedApprover = await patchCommission(illegalCommissionId, {
      expectedRevision: revision(illegalCommissionId),
      expectedStatus: "pending",
      status: "approved",
      approvedBy: 999_999,
    });
    expect(forgedApprover.status).toBe(400);
    expect(await forgedApprover.json()).toMatchObject({ error: "Invalid commission update" });
    expect(commission(illegalCommissionId)).toMatchObject({ status: "pending" });
    expect(auditCount(illegalCommissionId)).toBe(0);
  });

  it("applies a legal own-tenant transition with one redacted audit event", async () => {
    const response = await patchCommission(ownCommissionId, {
      expectedRevision: revision(ownCommissionId),
      expectedStatus: "pending",
      status: "approved",
      notes: "manager-reviewed",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: ownCommissionId,
      tenantId: 1,
      status: "approved",
      paidDate: null,
      notes: "manager-reviewed",
      approvedBy: managerUserId,
    });

    const audit = rawDb.prepare(
      "SELECT tenant_id AS tenantId, action, details FROM activity_log WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 1",
    ).get("commission", ownCommissionId) as { tenantId: number; action: string; details: string };
    expect(audit).toMatchObject({ tenantId: 1, action: "commission.approved" });
    expect(JSON.parse(audit.details)).toEqual({
      previousStatus: "pending",
      status: "approved",
      changedFields: ["status", "notes", "approvedBy"],
    });
    expect(audit.details).not.toContain("manager-reviewed");
    expect(auditCount(ownCommissionId)).toBe(1);
  });

  it("rejects an illegal lifecycle transition without a write or audit", async () => {
    const response = await patchCommission(illegalCommissionId, {
      expectedRevision: revision(illegalCommissionId),
      expectedStatus: "pending",
      status: "paid",
      paidDate: "2026-07-27",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "ILLEGAL_TRANSITION" });
    expect(commission(illegalCommissionId)).toMatchObject({
      status: "pending",
      paidDate: null,
      approvedBy: null,
    });
    expect(auditCount(illegalCommissionId)).toBe(0);
  });

  it("enforces paid-date coherence and terminal paid immutability", async () => {
    const missingDate = await patchCommission(paymentCommissionId, {
      expectedRevision: revision(paymentCommissionId),
      expectedStatus: "approved",
      status: "paid",
    });
    expect(missingDate.status).toBe(400);
    expect(await missingDate.json()).toMatchObject({ code: "PAID_DATE_REQUIRED" });

    const invalidDate = await patchCommission(paymentCommissionId, {
      expectedRevision: revision(paymentCommissionId),
      expectedStatus: "approved",
      status: "paid",
      paidDate: "2026-02-30",
    });
    expect(invalidDate.status).toBe(400);
    expect(await invalidDate.json()).toMatchObject({ code: "INVALID_PAID_DATE" });

    const forbiddenDate = await patchCommission(paidDateForbiddenCommissionId, {
      expectedRevision: revision(paidDateForbiddenCommissionId),
      expectedStatus: "approved",
      status: "approved",
      paidDate: "2026-07-27",
    });
    expect(forbiddenDate.status).toBe(400);
    expect(await forbiddenDate.json()).toMatchObject({ code: "PAID_DATE_FORBIDDEN" });

    const paid = await patchCommission(paymentCommissionId, {
      expectedRevision: revision(paymentCommissionId),
      expectedStatus: "approved",
      status: "paid",
      paidDate: "2026-07-27",
    });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({
      status: "paid",
      paidDate: "2026-07-27",
      approvedBy: managerUserId,
    });
    expect(auditCount(paymentCommissionId)).toBe(1);

    const exactRetry = await patchCommission(paymentCommissionId, {
      expectedRevision: revision(paymentCommissionId),
      expectedStatus: "paid",
      status: "paid",
      paidDate: "2026-07-27",
    });
    expect(exactRetry.status).toBe(200);
    expect(await exactRetry.json()).toMatchObject({ status: "paid", paidDate: "2026-07-27" });
    expect(auditCount(paymentCommissionId)).toBe(1);

    const terminalRewrite = await patchCommission(paymentCommissionId, {
      expectedRevision: revision(paymentCommissionId),
      expectedStatus: "paid",
      status: "paid",
      paidDate: "2026-07-27",
      notes: "rewrite after payout",
    });
    expect(terminalRewrite.status).toBe(409);
    expect(await terminalRewrite.json()).toMatchObject({ code: "PAID_TERMINAL" });
    expect(commission(paymentCommissionId)).toMatchObject({
      status: "paid",
      paidDate: "2026-07-27",
      notes: null,
    });
    expect(auditCount(paymentCommissionId)).toBe(1);
  });

  it("uses expectedStatus as a CAS token for concurrent and repeated commands", async () => {
    const staleRevision = revision(staleCommissionId);
    const [approve, dispute] = await Promise.all([
      patchCommission(staleCommissionId, {
        expectedRevision: staleRevision,
        expectedStatus: "pending",
        status: "approved",
      }),
      patchCommission(staleCommissionId, {
        expectedRevision: staleRevision,
        expectedStatus: "pending",
        status: "disputed",
      }),
    ]);
    expect([approve.status, dispute.status].sort()).toEqual([200, 409]);
    const staleResponse = approve.status === 409 ? approve : dispute;
    expect(await staleResponse.json()).toMatchObject({ code: "STALE_VERSION" });
    expect(["approved", "disputed"]).toContain(commission(staleCommissionId)?.status);
    expect(auditCount(staleCommissionId)).toBe(1);

    const repeatedOldCommand = await patchCommission(staleCommissionId, {
      expectedRevision: staleRevision,
      expectedStatus: "pending",
      status: "approved",
    });
    expect(repeatedOldCommand.status).toBe(409);
    expect(await repeatedOldCommand.json()).toMatchObject({ code: "STALE_VERSION" });
    expect(auditCount(staleCommissionId)).toBe(1);

    const current = commission(staleCommissionId)!;
    const [firstNote, secondNote] = await Promise.all([
      patchCommission(staleCommissionId, {
        expectedRevision: current.revision,
        expectedStatus: current.status,
        status: current.status,
        notes: "first concurrent note",
      }),
      patchCommission(staleCommissionId, {
        expectedRevision: current.revision,
        expectedStatus: current.status,
        status: current.status,
        notes: "second concurrent note",
      }),
    ]);
    expect([firstNote.status, secondNote.status].sort()).toEqual([200, 409]);
    const staleNote = firstNote.status === 409 ? firstNote : secondNote;
    expect(await staleNote.json()).toMatchObject({ code: "STALE_VERSION" });
    expect(["first concurrent note", "second concurrent note"])
      .toContain(commission(staleCommissionId)?.notes);
    expect(auditCount(staleCommissionId)).toBe(2);
  });

  it("rolls back the money mutation when the mandatory audit insert fails", async () => {
    rawDb.exec(`
      CREATE TRIGGER fail_legacy_commission_audit
      BEFORE INSERT ON activity_log
      WHEN NEW.entity_type = 'commission' AND NEW.entity_id = ${rollbackCommissionId}
      BEGIN
        SELECT RAISE(ABORT, 'forced commission audit failure');
      END
    `);
    try {
      const response = await patchCommission(rollbackCommissionId, {
        expectedRevision: revision(rollbackCommissionId),
        expectedStatus: "pending",
        status: "approved",
        notes: "must roll back",
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Commission update failed",
        code: "LEGACY_COMMISSION_TRANSACTION_FAILED",
      });
      expect(commission(rollbackCommissionId)).toMatchObject({
        status: "pending",
        notes: null,
        approvedBy: null,
      });
      expect(auditCount(rollbackCommissionId)).toBe(0);
    } finally {
      rawDb.exec("DROP TRIGGER IF EXISTS fail_legacy_commission_audit");
    }
  });

  it("summarizes only the caller tenant's reps and ledger rows", async () => {
    const response = await request("/api/commissions/summary");
    expect(response.status).toBe(200);
    const summary = await response.json() as Array<Record<string, unknown>>;
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      repId: tenantARepId,
      repName: "Tenant A Commission Rep",
      total: 275,
      paid: 20,
      sales: 6,
    });
    expect(JSON.stringify(summary)).not.toContain("Tenant B Commission Rep");
    expect(JSON.stringify(summary)).not.toContain("9999");
  });
});
