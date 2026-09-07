// ── Area skip trace: the run, the storage, and the worklist ────────────────
//
// One operator action ("Run Tracerfy + DNC" on an Area) becomes: trace every
// open door in ONE job, scrub the results straight off that job's queue, and
// store what came back so the doorstep card and the dialing worklist have
// something to render.
//
// This module owns orchestration and persistence ONLY. It decides nothing
// about dialability: server/tracerfyClient.ts talks to the provider, and
// shared/tracerfy.ts turns stored flags + scrub age into a verdict on every
// read. That split is why a scrub going stale silently re-blocks a number
// without anything writing to the database.

import crypto from "node:crypto";
import { rawDb } from "./db";
import {
  AREA_SKIP_TRACE_LEAD_FILTER_SQL,
  type AreaSkipTraceStatus,
  type AreaSkipTraceSummary,
  type DialingListEntry,
  type DialingListResponse,
  type StoredTracedLead,
} from "@shared/areaSkipTrace";
import {
  dialableNumbers,
  rankPhones,
  verdictForPhone,
  type DncFlags,
  type LineType,
  type TracedPhone,
} from "@shared/tracerfy";
import { applyScrub, scrubFromQueue, skipTraceLeads, type LeadPhone } from "./tracerfyClient";
import { structuredLog } from "./structuredLog";

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? Math.max(min, Math.min(max, Math.floor(raw))) : fallback;
}

/** Doors per run. Exceeding it refuses with a count rather than silently
 *  truncating, so an operator is never told "done" about a half-done area. */
export function areaSkipTraceMaxLeads(): number {
  return envInt("AREA_SKIP_TRACE_MAX_LEADS", 250, 1, 1000);
}

export function dialingListMaxPhones(): number {
  return envInt("DIALING_LIST_MAX_PHONES", 200, 1, 2000);
}

/** A run with no heartbeat for this long is presumed dead. The driver stamps
 *  one after every batch, so a slow run is never mistaken for an abandoned one. */
const RUN_STALE_MINUTES = 45;

export type AreaLeadRow = {
  id: number;
  address: string;
  city: string;
  state: string;
  zip: string;
  ownerName: string | null;
};

/**
 * The doors in an Area.
 *
 * Membership is the LINK COLUMN (leads.assigned_territory_id) — what reclaim,
 * share, unassign and pass-reset all mean by "this area's doors" — not polygon
 * containment. The two deliberately disagree: reclaim NULLs the column while
 * the ring still encloses the houses.
 */
export function selectAreaLeads(tenantId: number, territoryId: number, limit: number): AreaLeadRow[] {
  return rawDb.prepare(`SELECT l.id,l.address,l.city,l.state,l.zip,
      coalesce(nullif(trim(l.traced_owner_name),''),nullif(trim(l.owner_name),'')) AS ownerName
    FROM leads l
    WHERE l.assigned_territory_id=? AND (l.tenant_id IS NULL OR l.tenant_id=?)
      AND ${AREA_SKIP_TRACE_LEAD_FILTER_SQL}
    ORDER BY l.id LIMIT ?`).all(territoryId, tenantId, limit) as AreaLeadRow[];
}

export function countAreaLeads(tenantId: number, territoryId: number): number {
  const row = rawDb.prepare(`SELECT count(*) AS count FROM leads l
    WHERE l.assigned_territory_id=? AND (l.tenant_id IS NULL OR l.tenant_id=?)
      AND ${AREA_SKIP_TRACE_LEAD_FILTER_SQL}`).get(territoryId, tenantId) as any;
  return Number(row?.count ?? 0);
}

// ── Storage ─────────────────────────────────────────────────────────────────

function parseFlags(raw: string | null): DncFlags {
  if (!raw) return {};
  try { return JSON.parse(raw) as DncFlags; } catch { return {}; }
}

/** Persist a door's traced phones. Idempotent per (lead, number): a re-run
 *  refreshes flags and scrub time rather than duplicating rows. */
export function storeTracedPhones(input: {
  tenantId: number;
  leadId: number;
  ownerName: string | null;
  phones: LeadPhone[];
}): void {
  const tx = rawDb.transaction(() => {
    if ((input.ownerName ?? "").trim()) {
      // traced_owner_name, never leads.owner_name — the parcel/GIS enrichment
      // owns that column and a phone vendor must not overwrite property data.
      rawDb.prepare("UPDATE leads SET traced_owner_name=?,traced_at=datetime('now') WHERE id=? AND (tenant_id IS NULL OR tenant_id=?)")
        .run(input.ownerName!.trim(), input.leadId, input.tenantId);
    } else {
      rawDb.prepare("UPDATE leads SET traced_at=datetime('now') WHERE id=? AND (tenant_id IS NULL OR tenant_id=?)")
        .run(input.leadId, input.tenantId);
    }
    for (const phone of input.phones) {
      rawDb.prepare(`INSERT INTO lead_traced_phones
        (tenant_id,lead_id,number,line_type,confidence,dnc_flags,scrubbed_at_ms,dnc_source,updated_at)
        VALUES (?,?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(lead_id,number) DO UPDATE SET
          line_type=coalesce(excluded.line_type,lead_traced_phones.line_type),
          confidence=excluded.confidence,
          dnc_flags=coalesce(excluded.dnc_flags,lead_traced_phones.dnc_flags),
          -- Keep the NEWER scrub. A re-run whose scrub failed must not erase a
          -- good one and send a number back to "never scrubbed".
          scrubbed_at_ms=max(coalesce(excluded.scrubbed_at_ms,0),coalesce(lead_traced_phones.scrubbed_at_ms,0)),
          dnc_source=excluded.dnc_source,
          updated_at=datetime('now')`).run(
          input.tenantId, input.leadId, phone.number, phone.lineType ?? null,
          phone.confidence ?? 0,
          phone.dncFlags ? JSON.stringify(phone.dncFlags) : null,
          phone.scrubbedAtMs ?? null, phone.dncSource ?? null,
        );
    }
  });
  tx.immediate();
}

const TRACED_SELECT = `SELECT lead_id AS leadId,number,line_type AS lineType,confidence,
  dnc_flags AS dncFlags,scrubbed_at_ms AS scrubbedAtMs FROM lead_traced_phones`;

function toTracedPhone(row: any): TracedPhone {
  return {
    number: String(row.number),
    lineType: (row.lineType ?? "unknown") as LineType,
    confidence: Number(row.confidence ?? 0),
    dncFlags: parseFlags(row.dncFlags ?? null),
    // 0 is not a real scrub time — it is the SQL max() floor from the upsert.
    scrubbedAtMs: row.scrubbedAtMs ? Number(row.scrubbedAtMs) : null,
  };
}

/** Traced phones for a set of leads, for the map card and knock sheet. */
export function tracedPhonesForLeads(
  tenantId: number,
  leadIds: number[],
): Map<number, TracedPhone[]> {
  const out = new Map<number, TracedPhone[]>();
  if (leadIds.length === 0) return out;
  // Chunked: SQLite caps host parameters, and a map viewport can ask for
  // thousands of doors at once.
  for (let i = 0; i < leadIds.length; i += 400) {
    const chunk = leadIds.slice(i, i + 400);
    const rows = rawDb.prepare(`${TRACED_SELECT}
      WHERE (tenant_id IS NULL OR tenant_id=?) AND lead_id IN (${chunk.map(() => "?").join(",")})`)
      .all(tenantId, ...chunk) as any[];
    for (const row of rows) {
      const leadId = Number(row.leadId);
      const list = out.get(leadId) ?? [];
      list.push(toTracedPhone(row));
      out.set(leadId, list);
    }
  }
  for (const [leadId, phones] of out) out.set(leadId, rankPhones(phones));
  return out;
}

export function tracedPhonesForLead(tenantId: number, leadId: number): TracedPhone[] {
  return tracedPhonesForLeads(tenantId, [leadId]).get(leadId) ?? [];
}

// ── Run lifecycle ───────────────────────────────────────────────────────────

const RUN_SELECT = `SELECT id,territory_id AS territoryId,status,eligible_leads AS eligibleLeads,
  processed_leads AS processedLeads,failed_leads AS failedLeads,total_phones AS totalPhones,
  dialable_phones AS dialablePhones,error_code AS errorCode,started_at AS startedAt,
  finished_at AS finishedAt FROM area_skip_trace_runs`;

function toSummary(row: any): AreaSkipTraceSummary {
  return {
    areaId: Number(row.territoryId),
    runId: String(row.id),
    status: row.status as AreaSkipTraceStatus,
    eligibleLeads: Number(row.eligibleLeads ?? 0),
    processedLeads: Number(row.processedLeads ?? 0),
    failedLeads: Number(row.failedLeads ?? 0),
    totalPhones: Number(row.totalPhones ?? 0),
    dialablePhones: Number(row.dialablePhones ?? 0),
    errorCode: row.errorCode ?? null,
    startedAt: String(row.startedAt),
    finishedAt: row.finishedAt ?? null,
  };
}

/** Scoped by territory as well as tenant: a caller authorized for ONE area
 *  must not resolve a sibling area's run through it. */
export function getAreaSkipTraceRun(
  tenantId: number,
  runId: string,
  territoryId?: number,
): AreaSkipTraceSummary | null {
  const row = territoryId == null
    ? rawDb.prepare(`${RUN_SELECT} WHERE (tenant_id IS NULL OR tenant_id=?) AND id=?`).get(tenantId, runId) as any
    : rawDb.prepare(`${RUN_SELECT} WHERE (tenant_id IS NULL OR tenant_id=?) AND id=? AND territory_id=?`)
        .get(tenantId, runId, territoryId) as any;
  return row ? toSummary(row) : null;
}

export function latestAreaSkipTraceRun(tenantId: number, territoryId: number): AreaSkipTraceSummary | null {
  const row = rawDb.prepare(`${RUN_SELECT} WHERE (tenant_id IS NULL OR tenant_id=?) AND territory_id=?
    ORDER BY started_at DESC LIMIT 1`).get(tenantId, territoryId) as any;
  return row ? toSummary(row) : null;
}

/**
 * Fail runs that can no longer be making progress.
 *
 * A run is advanced only by an un-awaited in-process promise. A deploy or
 * crash mid-run leaves the row 'running' with no owner, and because the
 * concurrency lock is a DB index that row would block the area permanently.
 */
export function reconcileStrandedRuns(tenantId?: number, territoryId?: number): number {
  const where = ["status IN ('queued','running')",
    `datetime(coalesce(heartbeat_at,started_at))<datetime('now','-${RUN_STALE_MINUTES} minutes')`];
  const params: unknown[] = [];
  if (tenantId != null) { where.push("tenant_id=?"); params.push(tenantId); }
  if (territoryId != null) { where.push("territory_id=?"); params.push(territoryId); }
  if (!rawDb.prepare(`SELECT 1 FROM area_skip_trace_runs WHERE ${where.join(" AND ")} LIMIT 1`).get(...params)) return 0;
  return rawDb.prepare(`UPDATE area_skip_trace_runs
    SET status='failed',error_code='RUN_INTERRUPTED',finished_at=datetime('now')
    WHERE ${where.join(" AND ")}`).run(...params).changes;
}

/**
 * Close out every live run for an area that is going away.
 *
 * A run is driven by an un-awaited in-process promise reading
 * `assigned_territory_id = <area>`. Deleting the area NULLs that column, so the
 * driver's remaining chunks find nothing — but the ROW stays 'running' forever:
 * the stranded-run reaper only touches rows past the stale window, and until
 * then the partial unique index still counts it as an active run. Marking it
 * here means the delete leaves no run in a state anything downstream reads as
 * live. Returns how many were closed.
 */
export function cancelAreaSkipTraceRuns(territoryId: number, tenantId?: number): number {
  const where = ["status IN ('queued','running')", "territory_id=?"];
  const params: unknown[] = [territoryId];
  if (tenantId != null) { where.push("(tenant_id IS NULL OR tenant_id=?)"); params.push(tenantId); }
  return rawDb.prepare(`UPDATE area_skip_trace_runs
    SET status='failed',error_code='AREA_DELETED',finished_at=datetime('now')
    WHERE ${where.join(" AND ")}`).run(...params).changes;
}

export class AreaSkipTraceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly detail?: unknown) {
    super(message);
  }
}

/** Everything knowable before spending is checked here, so an operator gets a
 *  reason instead of a half-finished run. */
export function startAreaSkipTraceRun(input: {
  tenantId: number;
  territoryId: number;
  actorUserId: number;
}): AreaSkipTraceSummary {
  if (process.env.AREA_SKIP_TRACE_ENABLED !== "true") {
    throw new AreaSkipTraceError("Area skip trace is not enabled", 409, "AREA_SKIP_TRACE_DISABLED");
  }
  if (!process.env.TRACERFY_API_KEY) {
    throw new AreaSkipTraceError("Tracerfy is not configured", 409, "TRACERFY_NOT_CONFIGURED");
  }
  const eligible = countAreaLeads(input.tenantId, input.territoryId);
  if (eligible === 0) {
    throw new AreaSkipTraceError("No eligible doors in this area", 409, "NO_ELIGIBLE_LEADS");
  }
  const cap = areaSkipTraceMaxLeads();
  if (eligible > cap) {
    throw new AreaSkipTraceError(
      `This area has ${eligible} eligible doors, above the ${cap} per-run limit`,
      409, "AREA_TOO_LARGE", { eligible, limit: cap });
  }

  // Clear a run stranded by a restart BEFORE testing the concurrency lock,
  // or that area stays locked out forever.
  reconcileStrandedRuns(input.tenantId, input.territoryId);

  const runId = crypto.randomUUID();
  try {
    rawDb.prepare(`INSERT INTO area_skip_trace_runs
      (id,tenant_id,territory_id,status,requested_by,eligible_leads)
      VALUES (?,?,?, 'queued',?,?)`)
      .run(runId, input.tenantId, input.territoryId, input.actorUserId, eligible);
  } catch (error) {
    if (String((error as any)?.message ?? "").includes("UNIQUE")) {
      throw new AreaSkipTraceError("A run is already in progress for this area", 409, "RUN_ALREADY_ACTIVE");
    }
    throw error;
  }

  void driveRun({ ...input, runId }).catch((error) =>
    finishRun(input.tenantId, runId, "failed",
      (error instanceof Error ? error.message : "RUN_FAILED").slice(0, 120)));
  return getAreaSkipTraceRun(input.tenantId, runId)!;
}

function finishRun(tenantId: number, runId: string, status: AreaSkipTraceStatus, errorCode?: string | null): void {
  rawDb.prepare("UPDATE area_skip_trace_runs SET status=?,error_code=?,finished_at=datetime('now') WHERE tenant_id=? AND id=?")
    .run(status, errorCode ?? null, tenantId, runId);
}

/** Provider records per trace job. The API takes the whole list, but a single
 *  enormous job is all-or-nothing — a chunk keeps a failure partial. */
const TRACE_CHUNK = 100;

async function driveRun(input: {
  tenantId: number;
  territoryId: number;
  actorUserId: number;
  runId: string;
}): Promise<void> {
  const { tenantId, runId } = input;
  rawDb.prepare("UPDATE area_skip_trace_runs SET status='running',heartbeat_at=datetime('now') WHERE tenant_id=? AND id=?")
    .run(tenantId, runId);

  let processed = 0;
  let failed = 0;
  let totalPhones = 0;

  try {
    const leads = selectAreaLeads(tenantId, input.territoryId, areaSkipTraceMaxLeads());
    for (let offset = 0; offset < leads.length; offset += TRACE_CHUNK) {
      const chunk = leads.slice(offset, offset + TRACE_CHUNK);
      try {
        const traced = await skipTraceLeads(chunk.map(lead => ({
          leadId: lead.id, address: lead.address, city: lead.city,
          state: lead.state, zip: lead.zip, ownerName: lead.ownerName,
        })));

        // Scrub straight off the trace queue — no second upload of the numbers
        // we just received, and no address round-trip.
        let verdicts: Record<string, { dnc: boolean; flags?: DncFlags }> = {};
        let scrubbedAt: number | null = null;
        try {
          if (traced.traceQueueId) {
            verdicts = await scrubFromQueue(traced.traceQueueId);
            scrubbedAt = Date.now();
          }
        } catch (error) {
          // A failed scrub is NOT a failed trace. Store the numbers with no
          // scrub time: shared/tracerfy.ts reads that as never_scrubbed and
          // keeps them off every queue until a later run clears them.
          structuredLog("area_skip_trace.scrub_failed", {
            runId, areaId: input.territoryId,
            message: error instanceof Error ? error.message : "unknown error",
          });
        }

        for (const lead of chunk) {
          const result = traced.byLeadId.get(lead.id);
          const phones = result?.phones ?? [];
          const scrubbed = scrubbedAt != null ? applyScrub(phones, verdicts, scrubbedAt) : phones;
          storeTracedPhones({
            tenantId, leadId: lead.id,
            ownerName: result?.ownerName ?? null,
            phones: scrubbed,
          });
          processed += 1;
          totalPhones += scrubbed.length;
        }
      } catch (error) {
        failed += chunk.length;
        structuredLog("area_skip_trace.chunk_failed", {
          runId, areaId: input.territoryId, doors: chunk.length,
          message: error instanceof Error ? error.message : "unknown error",
        });
      }
      rawDb.prepare(`UPDATE area_skip_trace_runs SET processed_leads=?,failed_leads=?,total_phones=?,
        heartbeat_at=datetime('now') WHERE tenant_id=? AND id=?`)
        .run(processed, failed, totalPhones, tenantId, runId);
    }

    // Dialable is DERIVED from the same projection the UI reads, so the
    // summary and the list can never tell different stories.
    const dialable = countDialablePhones(tenantId, input.territoryId);
    rawDb.prepare(`UPDATE area_skip_trace_runs SET processed_leads=?,failed_leads=?,total_phones=?,
      dialable_phones=?,heartbeat_at=datetime('now') WHERE tenant_id=? AND id=?`)
      .run(processed, failed, totalPhones, dialable, tenantId, runId);
    finishRun(tenantId, runId, processed === 0 && failed > 0 ? "failed" : "completed",
      processed === 0 && failed > 0 ? "ALL_BATCHES_FAILED" : null);
  } catch (error) {
    finishRun(tenantId, runId, "failed", (error instanceof Error ? error.message : "RUN_FAILED").slice(0, 120));
  }
}

// ── Dialing worklist ────────────────────────────────────────────────────────

function areaTracedLeads(tenantId: number, territoryId: number, limit: number): StoredTracedLead[] {
  const rows = rawDb.prepare(`SELECT l.id AS leadId,l.address,l.city,l.state,l.zip,
      coalesce(nullif(trim(l.traced_owner_name),''),nullif(trim(l.owner_name),'')) AS ownerName,
      p.number,p.line_type AS lineType,p.confidence,p.dnc_flags AS dncFlags,p.scrubbed_at_ms AS scrubbedAtMs
    FROM leads l
    JOIN lead_traced_phones p ON p.lead_id=l.id
    WHERE l.assigned_territory_id=? AND (l.tenant_id IS NULL OR l.tenant_id=?)
      AND ${AREA_SKIP_TRACE_LEAD_FILTER_SQL}
    ORDER BY l.id,p.confidence DESC,p.number
    LIMIT ?`).all(territoryId, tenantId, limit) as any[];

  const byLead = new Map<number, StoredTracedLead>();
  for (const row of rows) {
    const leadId = Number(row.leadId);
    let entry = byLead.get(leadId);
    if (!entry) {
      entry = {
        leadId, address: row.address, city: row.city, state: row.state, zip: row.zip,
        ownerName: row.ownerName ?? null, phones: [],
      };
      byLead.set(leadId, entry);
    }
    entry.phones.push(toTracedPhone(row));
  }
  return [...byLead.values()];
}

export function countDialablePhones(tenantId: number, territoryId: number): number {
  const now = Date.now();
  return areaTracedLeads(tenantId, territoryId, 20_000)
    .reduce((count, lead) =>
      count + dialableNumbers(lead.phones.map(p => verdictForPhone(p, now))).length, 0);
}

/**
 * The rep-facing worklist for an Area.
 *
 * ADVISORY, NOT AUTHORIZATION: a number here passed the tracerfy projection —
 * scrubbed, current, on no list. It carries no calling-hours, frequency,
 * consent or identity guarantee. shared/calling.ts still gates every dial.
 *
 * Blocked numbers are INCLUDED by default, with their reasons: a rep needs to
 * know the household has a landline even when they must not dial it, and the
 * UI renders them inert.
 */
export function buildAreaDialingList(input: {
  tenantId: number;
  territoryId: number;
  dialableOnly?: boolean;
}): DialingListResponse {
  const now = Date.now();
  const limit = dialingListMaxPhones();
  // One extra row to detect truncation honestly rather than reporting a capped
  // list as if it were the whole area.
  const leads = areaTracedLeads(input.tenantId, input.territoryId, limit + 1);
  let seen = 0;
  let totalPhones = 0;
  let dialablePhones = 0;
  let truncated = false;
  const entries: DialingListEntry[] = [];

  for (const lead of leads) {
    const kept: TracedPhone[] = [];
    for (const phone of lead.phones) {
      if (seen >= limit) { truncated = true; break; }
      seen += 1;
      totalPhones += 1;
      const verdict = verdictForPhone(phone, now);
      if (!verdict.dnc) dialablePhones += 1;
      if (!input.dialableOnly || !verdict.dnc) kept.push(phone);
    }
    if (kept.length) {
      entries.push({
        leadId: lead.leadId, address: lead.address, city: lead.city,
        state: lead.state, zip: lead.zip, ownerName: lead.ownerName, phones: kept,
      });
    }
    if (truncated) break;
  }

  return {
    areaId: input.territoryId,
    entries, totalPhones, dialablePhones, truncated,
    advisory: true,
    authorizationRequired: true,
  };
}
