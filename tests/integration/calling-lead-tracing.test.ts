import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tracing a door from the Cold Calling workspace.
 *
 * The generic multi-provider enrichment framework is gone; Tracerfy is the one
 * contact source. These pin the two shapes the calling tab added on top of the
 * territory-wide area trace - one door inline, and a chosen set as a background
 * run - plus the guards that stop either of them spending money it should not.
 */
let T: typeof import("../../server/calling/leadTracing");
let rawDb: import("better-sqlite3").Database;

const TENANT = 1;

function lead(id: number, address: string, tenantId: number | null = TENANT) {
  rawDb.prepare(
    `INSERT OR REPLACE INTO leads (id, tenant_id, address, city, state, zip, lead_status, created_at, updated_at)
     VALUES (?,?,?,'Rockwell','NC','28138','prospect',datetime('now'),datetime('now'))`,
  ).run(id, tenantId, address);
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-lead-trace-"));
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/calling/migrations")).runCallingMigrations();
  T = await import("../../server/calling/leadTracing");
});

beforeEach(() => {
  rawDb.prepare("DELETE FROM calling_trace_runs").run();
  rawDb.prepare("DELETE FROM lead_traced_phones").run();
  rawDb.prepare("DELETE FROM leads").run();
  T.ensureQueueTraceSchema();
  process.env.AREA_SKIP_TRACE_ENABLED = "true";
  process.env.TRACERFY_API_KEY = "test-key";
});

afterEach(() => { vi.restoreAllMocks(); });

describe("tracing availability", () => {
  it("refuses when skip tracing is switched off for the org", async () => {
    process.env.AREA_SKIP_TRACE_ENABLED = "false";
    lead(1, "1 Trace Way");
    await expect(T.traceLeadNow({ tenantId: TENANT, leadId: 1, actorUserId: 1 }))
      .rejects.toMatchObject({ code: "TRACING_DISABLED", status: 409 });
    expect(() => T.startQueueTrace({ tenantId: TENANT, leadIds: [1], actorUserId: 1 }))
      .toThrow(/not enabled/i);
  });

  it("refuses when Tracerfy has no key, rather than calling it and failing obscurely", async () => {
    delete process.env.TRACERFY_API_KEY;
    lead(1, "1 Trace Way");
    await expect(T.traceLeadNow({ tenantId: TENANT, leadId: 1, actorUserId: 1 }))
      .rejects.toMatchObject({ code: "TRACERFY_NOT_CONFIGURED" });
  });

  it("will not trace a door from another tenant, or one with no address", async () => {
    lead(5, "5 Other Tenant Rd", 999);
    await expect(T.traceLeadNow({ tenantId: TENANT, leadId: 5, actorUserId: 1 }))
      .rejects.toMatchObject({ code: "LEAD_NOT_FOUND", status: 404 });

    rawDb.prepare(
      `INSERT OR REPLACE INTO leads (id, tenant_id, address, city, state, zip, lead_status, created_at, updated_at)
       VALUES (6,?,'','Rockwell','NC','28138','prospect',datetime('now'),datetime('now'))`,
    ).run(TENANT);
    await expect(T.traceLeadNow({ tenantId: TENANT, leadId: 6, actorUserId: 1 }))
      .rejects.toMatchObject({ code: "LEAD_HAS_NO_ADDRESS" });
  });
});

describe("the bulk queue trace", () => {
  it("caps a run, so one selection cannot bill for an unbounded batch", () => {
    const over = Array.from({ length: T.queueTraceMaxLeads() + 1 }, (_, i) => i + 1);
    for (const id of over) lead(id, `${id} Cap Ave`);
    expect(() => T.startQueueTrace({ tenantId: TENANT, leadIds: over, actorUserId: 1 }))
      .toThrow(/at most/i);
  });

  it("rejects an empty selection", () => {
    expect(() => T.startQueueTrace({ tenantId: TENANT, leadIds: [], actorUserId: 1 }))
      .toThrow(/at least one/i);
  });

  it("allows only ONE live run per tenant - a second would double-bill the overlap", () => {
    lead(1, "1 Run Rd");
    lead(2, "2 Run Rd");
    // Park a live run directly: starting one for real would call the provider.
    rawDb.prepare(
      `INSERT INTO calling_trace_runs (id, tenant_id, status, requested_by, lead_ids, requested_leads)
       VALUES ('live-run',?, 'running', 1, '[1]', 1)`,
    ).run(TENANT);
    expect(() => T.startQueueTrace({ tenantId: TENANT, leadIds: [2], actorUserId: 1 }))
      .toThrow(/already in progress/i);
  });

  it("reaps a run stranded by a restart, so the tenant is not locked out forever", () => {
    rawDb.prepare(
      `INSERT INTO calling_trace_runs (id, tenant_id, status, requested_by, lead_ids, requested_leads, heartbeat_at)
       VALUES ('stranded',?, 'running', 1, '[1]', 1, datetime('now','-30 minutes'))`,
    ).run(TENANT);
    expect(T.reconcileStrandedQueueTraceRuns(TENANT)).toBe(1);
    const run = T.getQueueTraceRun(TENANT, "stranded")!;
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("STRANDED");

    // …and with the lock cleared, a new run may start.
    lead(2, "2 Run Rd");
    const started = T.startQueueTrace({ tenantId: TENANT, leadIds: [2], actorUserId: 1 });
    expect(["queued", "running"]).toContain(started.status);
    expect(started.requestedLeads).toBe(1);
  });

  it("de-duplicates the selection rather than tracing a door twice in one run", () => {
    lead(1, "1 Dupe Rd");
    const run = T.startQueueTrace({ tenantId: TENANT, leadIds: [1, 1, 1], actorUserId: 1 });
    expect(run.requestedLeads).toBe(1);
  });

  it("reports the latest run for the queue's progress bar", () => {
    lead(1, "1 Latest Rd");
    const started = T.startQueueTrace({ tenantId: TENANT, leadIds: [1], actorUserId: 1 });
    const latest = T.latestQueueTraceRun(TENANT)!;
    expect(latest.id).toBe(started.id);
    // Another tenant sees nothing of it.
    expect(T.latestQueueTraceRun(4242)).toBeNull();
  });
});
