// ── Tracing a door from the Cold Calling workspace ──────────────────────────
//
// Area skip trace (server/areaSkipTrace.ts) traces a whole TERRITORY on a
// background run. That is the right shape for prospecting a block, and the
// wrong shape for a caller staring at one untraced door: they need a number
// for THIS address now, not a run over four hundred neighbours.
//
// So this module adds the two shapes the calling queue actually needs, and
// nothing else:
//
//   traceLeadNow    one door, inline, awaited. A caller taps Trace and waits
//                   the few seconds the provider takes.
//   startQueueTrace many doors, background run with a status endpoint. A batch
//                   trace polls the provider's queue and can run for minutes,
//                   which is far past any sane HTTP timeout.
//
// BOTH go through the SAME writes area skip trace uses - storeTracedPhones
// then syncTracedPhoneQueue - so a number found here is indistinguishable from
// one found by an area run: same encryption, same association, same scrub
// verdict feeding the compliance gate. There is deliberately no shortcut here
// that area tracing does not also take.
//
// WHAT THIS DOES NOT DO: authorize a call. Storing a number and importing it
// into the queue is not permission to dial it. The stage that authorizes is
// still written only by evaluateLeadCompliance when a rep opens the lead, and
// the scrub verdict this records is an input to that gate, never a bypass.
import crypto from "crypto";
import { rawDb } from "../db";
import { storage } from "../storage";
import { structuredLog } from "../structuredLog";
import { skipTraceLead, skipTraceLeads } from "../tracerfyClient";
import { storeTracedPhones, tracedPhonesForLead } from "../areaSkipTrace";
import { syncTracedPhoneQueue, preferredTracedPhone } from "./tracedPhones";

export class LeadTraceError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "LEAD_TRACE_ERROR", readonly meta?: Record<string, unknown>) {
    super(message);
    this.name = "LeadTraceError";
  }
}

/** How many doors one queue-trace run may cover. A batch is billed per record,
 *  so the ceiling is a cost guard as much as a runtime one. */
export function queueTraceMaxLeads(): number {
  const raw = Number(process.env.CALLING_TRACE_MAX_LEADS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 100;
}

/** The same two gates area tracing takes, in the same order, so the calling
 *  tab can never trace in an org where area tracing is switched off. */
function assertTracingAvailable(): void {
  if (process.env.AREA_SKIP_TRACE_ENABLED !== "true") {
    throw new LeadTraceError("Skip tracing is not enabled for this organization", 409, "TRACING_DISABLED");
  }
  if (!process.env.TRACERFY_API_KEY) {
    throw new LeadTraceError("Tracerfy is not configured", 409, "TRACERFY_NOT_CONFIGURED");
  }
}

type TraceableLead = { id: number; address: string; city: string; state: string; zip: string | null; ownerName: string | null };

/** The address a trace is run against. Scoped by tenant like every other read
 *  here; a lead outside the caller's tenant is simply not found. */
function loadLead(tenantId: number, leadId: number): TraceableLead {
  const row = rawDb.prepare(
    `SELECT id, address, city, state, zip, owner_name AS ownerName
       FROM leads WHERE id = ? AND (tenant_id IS NULL OR tenant_id = ?)`,
  ).get(leadId, tenantId) as any;
  if (!row) throw new LeadTraceError("Lead not found", 404, "LEAD_NOT_FOUND");
  if (!String(row.address ?? "").trim()) {
    throw new LeadTraceError("This door has no address to trace", 409, "LEAD_HAS_NO_ADDRESS");
  }
  return {
    id: Number(row.id), address: String(row.address),
    city: String(row.city ?? ""), state: String(row.state ?? ""),
    zip: row.zip ? String(row.zip) : null,
    ownerName: row.ownerName ? String(row.ownerName) : null,
  };
}

export type LeadTraceOutcome = {
  leadId: number;
  phonesFound: number;
  /** True when at least one returned number survives the scrub. A door can be
   *  traced successfully and still be undialable - that is a real outcome, not
   *  a failure, and the caller is told which it was. */
  dialable: boolean;
  ownerName: string | null;
  queuedForCalling: boolean;
};

/** Trace ONE door and import what comes back. Awaited by the caller. */
export async function traceLeadNow(input: {
  tenantId: number; leadId: number; actorUserId: number | null;
}): Promise<LeadTraceOutcome> {
  assertTracingAvailable();
  const lead = loadLead(input.tenantId, input.leadId);

  const result = await skipTraceLead({
    address: lead.address, city: lead.city, state: lead.state,
    zip: lead.zip ?? undefined, ownerName: lead.ownerName,
  });

  storeTracedPhones({
    tenantId: input.tenantId, leadId: lead.id,
    ownerName: result.ownerName ?? null, phones: result.phones,
  });

  // Import into the calling queue through the shared bridge, so the number
  // lands with its association, validation record and scrub verdict rather
  // than sitting in lead_traced_phones unreachable from the workspace.
  let queuedForCalling = false;
  try {
    syncTracedPhoneQueue(input.tenantId);
    queuedForCalling = true;
  } catch (error) {
    // The trace itself succeeded and is stored; a queue-import fault must not
    // present as "tracing failed" and invite a second billed trace.
    structuredLog("calling.trace_queue_sync_failed", {
      leadId: lead.id, message: error instanceof Error ? error.message : "unknown error",
    }, "error");
  }

  const stored = tracedPhonesForLead(input.tenantId, lead.id);
  const preferred = preferredTracedPhone(stored, Date.now());
  storage.logActivity(input.actorUserId, "calling.lead_traced", "lead", lead.id,
    { phonesFound: result.phones.length, dialable: !!preferred }, undefined);

  return {
    leadId: lead.id,
    phonesFound: result.phones.length,
    dialable: !!preferred,
    ownerName: result.ownerName ?? null,
    queuedForCalling,
  };
}

// ── Bulk: a background run over a chosen set of doors ────────────────────────

export type QueueTraceStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type QueueTraceRun = {
  id: string;
  status: QueueTraceStatus;
  requestedLeads: number;
  processedLeads: number;
  failedLeads: number;
  totalPhones: number;
  dialablePhones: number;
  errorCode: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export function ensureQueueTraceSchema(): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS calling_trace_runs (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER,
      status TEXT NOT NULL,
      requested_by INTEGER,
      lead_ids TEXT NOT NULL,
      requested_leads INTEGER NOT NULL DEFAULT 0,
      processed_leads INTEGER NOT NULL DEFAULT 0,
      failed_leads INTEGER NOT NULL DEFAULT 0,
      total_phones INTEGER NOT NULL DEFAULT 0,
      dialable_phones INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    -- One live run per tenant. Two concurrent batches would bill twice for the
    -- doors they overlap on and race each other's queue import.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_calling_trace_one_active
      ON calling_trace_runs(tenant_id) WHERE status IN ('queued','running');
    CREATE INDEX IF NOT EXISTS idx_calling_trace_recent
      ON calling_trace_runs(tenant_id, started_at DESC);
  `);
}
ensureQueueTraceSchema();

function mapRun(row: any): QueueTraceRun | null {
  if (!row) return null;
  return {
    id: String(row.id),
    status: String(row.status) as QueueTraceStatus,
    requestedLeads: Number(row.requested_leads ?? 0),
    processedLeads: Number(row.processed_leads ?? 0),
    failedLeads: Number(row.failed_leads ?? 0),
    totalPhones: Number(row.total_phones ?? 0),
    dialablePhones: Number(row.dialable_phones ?? 0),
    errorCode: row.error_code ?? null,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ?? null,
  };
}

export function getQueueTraceRun(tenantId: number, runId: string): QueueTraceRun | null {
  return mapRun(rawDb.prepare(
    "SELECT * FROM calling_trace_runs WHERE tenant_id = ? AND id = ?",
  ).get(tenantId, runId));
}

export function latestQueueTraceRun(tenantId: number): QueueTraceRun | null {
  return mapRun(rawDb.prepare(
    "SELECT * FROM calling_trace_runs WHERE tenant_id = ? ORDER BY started_at DESC LIMIT 1",
  ).get(tenantId));
}

/** A run whose process died mid-flight leaves a row 'running' forever, and the
 *  one-active index then locks the tenant out of tracing. Reaped on boot and
 *  before every start, exactly as area runs are. */
export function reconcileStrandedQueueTraceRuns(tenantId?: number): number {
  const where = tenantId != null ? "AND tenant_id = ?" : "";
  const params = tenantId != null ? [tenantId] : [];
  const info = rawDb.prepare(
    `UPDATE calling_trace_runs SET status='failed', error_code='STRANDED', finished_at=datetime('now')
      WHERE status IN ('queued','running')
        AND heartbeat_at < datetime('now','-10 minutes') ${where}`,
  ).run(...params);
  return info.changes;
}

const TRACE_CHUNK = 100;

export function startQueueTrace(input: {
  tenantId: number; leadIds: number[]; actorUserId: number | null;
}): QueueTraceRun {
  assertTracingAvailable();

  const unique = [...new Set(input.leadIds.map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (unique.length === 0) throw new LeadTraceError("Select at least one door to trace", 400, "NO_LEADS");
  const cap = queueTraceMaxLeads();
  if (unique.length > cap) {
    throw new LeadTraceError(`Select at most ${cap} doors per run`, 409, "TOO_MANY_LEADS", { selected: unique.length, limit: cap });
  }

  reconcileStrandedQueueTraceRuns(input.tenantId);

  const runId = crypto.randomUUID();
  try {
    rawDb.prepare(
      `INSERT INTO calling_trace_runs (id, tenant_id, status, requested_by, lead_ids, requested_leads)
       VALUES (?,?,'queued',?,?,?)`,
    ).run(runId, input.tenantId, input.actorUserId ?? null, JSON.stringify(unique), unique.length);
  } catch (error) {
    if (String((error as any)?.message ?? "").includes("UNIQUE")) {
      throw new LeadTraceError("A trace run is already in progress", 409, "RUN_ALREADY_ACTIVE");
    }
    throw error;
  }

  void driveQueueTrace({ tenantId: input.tenantId, runId, leadIds: unique }).catch(error =>
    finishRun(input.tenantId, runId, "failed",
      (error instanceof Error ? error.message : "RUN_FAILED").slice(0, 120)));
  return getQueueTraceRun(input.tenantId, runId)!;
}

function finishRun(tenantId: number, runId: string, status: QueueTraceStatus, errorCode?: string | null): void {
  rawDb.prepare(
    "UPDATE calling_trace_runs SET status=?, error_code=?, finished_at=datetime('now') WHERE tenant_id=? AND id=?",
  ).run(status, errorCode ?? null, tenantId, runId);
}

async function driveQueueTrace(input: { tenantId: number; runId: string; leadIds: number[] }): Promise<void> {
  const { tenantId, runId } = input;
  rawDb.prepare("UPDATE calling_trace_runs SET status='running', heartbeat_at=datetime('now') WHERE tenant_id=? AND id=?")
    .run(tenantId, runId);

  let processed = 0, failed = 0, totalPhones = 0, dialablePhones = 0;

  const leads: TraceableLead[] = [];
  for (const leadId of input.leadIds) {
    try { leads.push(loadLead(tenantId, leadId)); }
    catch { failed += 1; }
  }

  try {
    // Chunked for the same reason area runs are: the provider takes the whole
    // list, but one enormous job is all-or-nothing, and a chunk keeps a
    // failure partial rather than total.
    for (let offset = 0; offset < leads.length; offset += TRACE_CHUNK) {
      const chunk = leads.slice(offset, offset + TRACE_CHUNK);
      try {
        const traced = await skipTraceLeads(chunk.map(lead => ({
          leadId: lead.id, address: lead.address, city: lead.city,
          state: lead.state, zip: lead.zip ?? undefined, ownerName: lead.ownerName,
        })));
        for (const lead of chunk) {
          const result = traced.byLeadId.get(lead.id);
          if (!result) { failed += 1; continue; }
          storeTracedPhones({
            tenantId, leadId: lead.id,
            ownerName: result.ownerName ?? null, phones: result.phones,
          });
          processed += 1;
          totalPhones += result.phones.length;
          if (preferredTracedPhone(tracedPhonesForLead(tenantId, lead.id), Date.now())) dialablePhones += 1;
        }
      } catch (error) {
        failed += chunk.length;
        structuredLog("calling.trace_chunk_failed", {
          runId, size: chunk.length, message: error instanceof Error ? error.message : "unknown error",
        }, "error");
      }
      rawDb.prepare(
        `UPDATE calling_trace_runs SET processed_leads=?, failed_leads=?, total_phones=?, dialable_phones=?,
                heartbeat_at=datetime('now') WHERE tenant_id=? AND id=?`,
      ).run(processed, failed, totalPhones, dialablePhones, tenantId, runId);
    }

    // One import at the end rather than per chunk: the bridge is a whole-queue
    // reconcile, so calling it per chunk repeats the same scan N times.
    try { syncTracedPhoneQueue(tenantId); }
    catch (error) {
      structuredLog("calling.trace_queue_sync_failed", {
        runId, message: error instanceof Error ? error.message : "unknown error",
      }, "error");
    }

    finishRun(tenantId, runId, "completed", null);
    structuredLog("calling.trace_run_completed", { runId, processed, failed, totalPhones, dialablePhones });
  } catch (error) {
    finishRun(tenantId, runId, "failed", (error instanceof Error ? error.message : "RUN_FAILED").slice(0, 120));
    throw error;
  }
}
