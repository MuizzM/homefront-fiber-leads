// ── Poison-event operations ──────────────────────────────────────────────────
//
// The subscriber already does the financially correct thing with a failing
// event: it STOPS rather than skipping, because these events are ordered and
// order is load-bearing (a SALE_CANCELLED clawback must not be applied before
// the SALE_APPROVED award it reverses). Stopping is safe. What it was not, was
// OPERABLE — the stall was a log line, nobody could see how long it had been
// stuck, and the only way out was a code deploy.
//
// This module makes that state durable, leased, backed off, visible and
// recoverable, WITHOUT ever letting a later event bypass an unresolved
// predecessor. Nothing here moves money: the money paths are unchanged, and the
// only thing an operator can do is decide whether an event should be retried,
// set aside, or declared handled — each with a reason and an audit record.

import { rawDb } from "./db";
import { storage } from "./storage";
import { structuredLog } from "./structuredLog";
import { cursorFor } from "./domainEventStore";
import { interactiveTransaction } from "./interactiveDb";

export type EventStatus =
  | "pending"        // never attempted, or waiting out its backoff
  | "processing"     // leased by a worker right now
  | "completed"      // committed and the cursor moved past it
  | "failed"         // threw; will be retried when next_attempt_at passes
  | "blocked"        // retries exhausted; holds the queue until an operator acts
  | "dead_lettered"  // operator set it aside; the queue may advance past it
  | "resolved";      // operator declares the effects handled; queue may advance

/** Retries before an event stops retrying itself and waits for a human. */
export const MAX_ATTEMPTS = 5;
/** Backoff schedule in ms, indexed by attempt count. Bounded, not unbounded. */
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];
/** A lease older than this is treated as abandoned (worker crashed). */
export const LEASE_TTL_MS = 60_000;
/** Operator-visible thresholds. */
export const ALERT_ATTEMPTS = 3;
export const ALERT_QUEUE_AGE_MS = 30 * 60_000;

export function ensureEventQueueSchema(): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS event_processing_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscriber TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      tenant_id INTEGER,
      event_type TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      retryable INTEGER NOT NULL DEFAULT 1,
      first_failed_at TEXT,
      last_failed_at TEXT,
      next_attempt_at TEXT,
      error_fingerprint TEXT,
      last_error TEXT,
      run_id TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      resolved_by INTEGER,
      resolved_reason TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- One state row per (subscriber, event): the identity that makes every
    -- update below idempotent under concurrent workers.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_event_state_once
      ON event_processing_state(subscriber, event_id);
    CREATE INDEX IF NOT EXISTS idx_event_state_status
      ON event_processing_state(subscriber, status, event_id);
  `);
}
ensureEventQueueSchema();

const now = () => new Date().toISOString();

/**
 * Collapse an error to a stable fingerprint so repeated failures of the SAME
 * cause group together in the operator view instead of reading as N unrelated
 * incidents. Ids, timestamps and quoted values are the parts that vary between
 * two instances of one bug, so they are the parts removed.
 */
export function fingerprint(err: unknown): string {
  const name = (err as any)?.name ?? "Error";
  const code = (err as any)?.code;
  const msg = String((err as any)?.message ?? err ?? "")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<ts>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/'[^']*'/g, "<v>")
    .replace(/"[^"]*"/g, "<v>")
    .slice(0, 200);
  return [name, code, msg].filter(Boolean).join(":");
}

function upsertState(subscriber: string, eventId: number, patch: Record<string, any>): void {
  const ts = now();
  rawDb.prepare(
    `INSERT INTO event_processing_state (subscriber, event_id, created_at, updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(subscriber, event_id) DO NOTHING`,
  ).run(subscriber, eventId, ts, ts);
  const cols = Object.keys(patch);
  if (cols.length === 0) return;
  rawDb.prepare(
    `UPDATE event_processing_state SET ${cols.map(c => `${c} = ?`).join(", ")}, updated_at = ?
      WHERE subscriber = ? AND event_id = ?`,
  ).run(...cols.map(c => patch[c]), ts, subscriber, eventId);
}

export function getState(subscriber: string, eventId: number): any {
  return rawDb.prepare(
    `SELECT * FROM event_processing_state WHERE subscriber = ? AND event_id = ?`,
  ).get(subscriber, eventId);
}

/**
 * Try to take this event for processing.
 *
 * Returns false when another worker holds a live lease, or when the event is
 * backing off, or when an operator has set it aside. A lease older than
 * LEASE_TTL_MS is reclaimable - that is the crash-recovery path, and it is safe
 * because the work itself is idempotent (every award insert is ON CONFLICT DO
 * NOTHING against a unique key), so at worst the retry re-does committed work
 * and writes nothing new.
 *
 * The compare-and-swap in the WHERE clause is what makes two workers unable to
 * hold the same event: better-sqlite3 is synchronous and this is a single
 * statement, so exactly one UPDATE reports changes === 1.
 */
export function acquireLease(subscriber: string, eventId: number, owner: string, opts: { tenantId?: number | null; eventType?: string | null } = {}): boolean {
  const ts = now();
  const expires = new Date(Date.parse(ts) + LEASE_TTL_MS).toISOString();
  upsertState(subscriber, eventId, {
    tenant_id: opts.tenantId ?? null,
    event_type: opts.eventType ?? null,
  });
  const res = rawDb.prepare(
    `UPDATE event_processing_state
        SET status = 'processing', lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE subscriber = ? AND event_id = ?
        AND status IN ('pending','failed','processing')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
  ).run(owner, expires, ts, subscriber, eventId, ts, ts);
  return res.changes === 1;
}

export function markCompleted(subscriber: string, eventId: number, runId: string): void {
  upsertState(subscriber, eventId, {
    status: "completed", lease_owner: null, lease_expires_at: null,
    next_attempt_at: null, last_error: null, run_id: runId,
  });
}

/** Record a failure, schedule the next attempt, and block once retries run out. */
export function markFailed(subscriber: string, eventId: number, err: unknown, runId: string): { status: EventStatus; attempts: number } {
  const prior = getState(subscriber, eventId);
  const attempts = Number(prior?.attempts ?? 0) + 1;
  const exhausted = attempts >= MAX_ATTEMPTS;
  const ts = now();
  const backoff = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
  const status: EventStatus = exhausted ? "blocked" : "failed";
  upsertState(subscriber, eventId, {
    status, attempts,
    first_failed_at: prior?.first_failed_at ?? ts,
    last_failed_at: ts,
    next_attempt_at: exhausted ? null : new Date(Date.parse(ts) + backoff).toISOString(),
    error_fingerprint: fingerprint(err),
    last_error: String((err as any)?.message ?? err).slice(0, 500),
    run_id: runId,
    lease_owner: null, lease_expires_at: null,
    retryable: exhausted ? 0 : 1,
  });
  structuredLog("event_queue.attempt_failed", {
    subscriber, eventId, attempts, status, runId,
    fingerprint: fingerprint(err), message: String((err as any)?.message ?? err).slice(0, 200),
  }, exhausted ? "error" : "warn");
  return { status, attempts };
}

/** True when this event is currently holding the queue and needs a human. */
export function isHalted(state: any): boolean {
  return !!state && (state.status === "blocked" || (state.status === "failed" && Number(state.attempts) >= MAX_ATTEMPTS));
}

/** Statuses an operator has explicitly cleared - the queue may advance past them. */
export function isOperatorCleared(state: any): boolean {
  return !!state && (state.status === "dead_lettered" || state.status === "resolved");
}

// ── Operator actions ─────────────────────────────────────────────────────────
// Every one requires a reason and writes an append-only audit record. None of
// them move money: retry re-runs idempotent work, dead-letter and resolve only
// change whether the queue may advance - the underlying event row is never
// deleted, so its financial effect stays inspectable and replayable.

export type OperatorAction = "RETRY" | "DEAD_LETTER" | "RESOLVE";

export class QueueAccessError extends Error {
  constructor(public readonly code: "ORG_REQUIRED" | "QUEUE_EVENT_NOT_FOUND" | "QUEUE_STATE_CHANGED" | "QUEUE_CURSOR_PASSED" | "FORBIDDEN", public readonly httpStatus: number, message: string) {
    super(message);
  }
}

export function requireQueueTenant(tenantId: number): number {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
    throw new QueueAccessError("ORG_REQUIRED", 400, "An organization context is required.");
  }
  return tenantId;
}

export async function operatorAction(input: {
  subscriber: string; eventId: number; action: OperatorAction;
  actorUserId: number | null; reason: string; tenantId: number;
  /** HTTP callers must revalidate current authority inside the writer lease. */
  authorize?: () => void;
}): Promise<any> {
  const tenantId = requireQueueTenant(input.tenantId);
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 3 || reason.length > 500) throw new Error("A reason is required for queue operator actions (3–500 characters).");
  if (!["RETRY", "DEAD_LETTER", "RESOLVE"].includes(input.action)) throw new Error("Invalid queue operator action.");

  const ownedState = rawDb.prepare(`SELECT s.* FROM event_processing_state s
    JOIN domain_events e ON e.id=s.event_id WHERE s.subscriber=? AND s.event_id=? AND e.tenant_id=?`);
  const getOwnedState = () => {
    const row = ownedState.get(input.subscriber, input.eventId, tenantId) as any;
    if (!row) throw new QueueAccessError("QUEUE_EVENT_NOT_FOUND", 404, "No queue state for that event.");
    return row;
  };
  getOwnedState(); // Denied/absent work takes no writer lease.

  const ts = now();
  const state = await interactiveTransaction(rawDb, () => {
    input.authorize?.();
    // Queue metadata is mutable and historically nullable. Only the immutable
    // event establishes ownership; a cached tenant must never grant access.
    const prior = getOwnedState();
    if (!["failed", "blocked", "dead_lettered"].includes(prior.status))
      throw new QueueAccessError("QUEUE_STATE_CHANGED", 409, "This event has changed. Refresh the queue before acting.");
    if (input.action === "RETRY" && input.eventId <= cursorFor(input.subscriber))
      throw new QueueAccessError("QUEUE_CURSOR_PASSED", 409, "The queue has advanced past this event. Review its financial effects; replay is unavailable.");
    const status = input.action === "RETRY" ? "pending" : input.action === "DEAD_LETTER" ? "dead_lettered" : "resolved";
    rawDb.prepare(`UPDATE event_processing_state SET status=?,retryable=?,next_attempt_at=NULL,
      lease_owner=NULL,lease_expires_at=NULL,resolved_by=?,resolved_reason=?,resolved_at=?,updated_at=?
      WHERE subscriber=? AND event_id=? AND EXISTS
        (SELECT 1 FROM domain_events e WHERE e.id=event_processing_state.event_id AND e.tenant_id=?)`)
      .run(status, input.action === "RETRY" ? 1 : 0, input.actorUserId, reason, ts, ts, input.subscriber, input.eventId, tenantId);
    storage.logActivity(input.actorUserId, `event_queue.${input.action.toLowerCase()}`, "domain_event", input.eventId, {
      subscriber: input.subscriber, reason,
      previousStatus: prior.status, attempts: prior.attempts,
      fingerprint: prior.error_fingerprint,
    }, undefined, tenantId);
    return prior;
  });
  structuredLog("event_queue.operator_action", {
    subscriber: input.subscriber, eventId: input.eventId, action: input.action,
    actorUserId: input.actorUserId, previousStatus: state.status, tenantId,
  });
  return getState(input.subscriber, input.eventId);
}

// ── Operator visibility ──────────────────────────────────────────────────────

export interface QueueHealth {
  subscriber: string;
  cursor: number;
  backlog: number;
  halted: Array<{ eventId: number; tenantId: number | null; eventType: string | null; attempts: number; fingerprint: string | null; lastError: string | null; firstFailedAt: string | null }>;
  oldestFailureAgeMs: number | null;
  alerts: string[];
  truncated: boolean;
}

export const QUEUE_REPORT_LIMIT = 200;

/** Project the internal global checkpoint onto this organization's event stream.
 * This is a read view; it never changes delivery ordering or worker progress. */
function tenantProgress(subscriber: string, tenantId: number) {
  const globalCursor = cursorFor(subscriber);
  const cursor = (rawDb.prepare("SELECT COALESCE(MAX(id),0) n FROM domain_events WHERE tenant_id=? AND id<=?").get(tenantId, globalCursor) as { n: number }).n;
  const backlog = (rawDb.prepare("SELECT COUNT(*) n FROM domain_events WHERE tenant_id=? AND id>?").get(tenantId, globalCursor) as { n: number }).n;
  return { cursor, backlog };
}

export function queueHealth(subscriber: string, tenantId: number, nowMs = Date.now()): QueueHealth {
  requireQueueTenant(tenantId);
  const { cursor, backlog } = tenantProgress(subscriber, tenantId);
  const rows = rawDb.prepare(
    `SELECT s.event_id AS eventId, e.tenant_id AS tenantId, e.type AS eventType, s.attempts,
            s.error_fingerprint AS fingerprint, s.last_error AS lastError, s.first_failed_at AS firstFailedAt
       FROM event_processing_state s JOIN domain_events e ON e.id=s.event_id
      WHERE s.subscriber=? AND e.tenant_id=? AND s.status IN ('blocked','failed')
      ORDER BY s.event_id ASC LIMIT ?`,
  ).all(subscriber, tenantId, QUEUE_REPORT_LIMIT + 1) as QueueHealth["halted"];
  const halted = rows.slice(0, QUEUE_REPORT_LIMIT);

  const first = (rawDb.prepare(`SELECT MIN(s.first_failed_at) first FROM event_processing_state s
    JOIN domain_events e ON e.id=s.event_id WHERE s.subscriber=? AND e.tenant_id=? AND s.status IN ('blocked','failed')`)
    .get(subscriber, tenantId) as { first: string | null }).first;
  const firstMs = Date.parse(first ?? "");
  const oldest = Number.isFinite(firstMs) ? Math.max(0, nowMs - firstMs) : null;

  const alerts: string[] = [];
  for (const h of halted) {
    if (Number(h.attempts) >= ALERT_ATTEMPTS) {
      alerts.push(`event ${h.eventId} has failed ${h.attempts}× (${h.fingerprint ?? "unknown"})`);
    }
  }
  if (oldest != null && oldest > ALERT_QUEUE_AGE_MS) {
    alerts.push(`queue has been halted for ${Math.round(oldest / 60_000)} minutes`);
  }
  return { subscriber, cursor, backlog, halted, oldestFailureAgeMs: oldest, alerts, truncated: rows.length > QUEUE_REPORT_LIMIT };
}

/**
 * Post-resolution recovery check. READ-ONLY - it reports, it never repairs.
 *
 * Answers the three questions an operator has after clearing a stall: is the
 * cursor where the completed work says it should be, is anything still holding
 * the queue, and did the retries leave duplicate ledger effects behind.
 */
export function recoveryReport(subscriber: string, tenantId: number): {
  subscriber: string; cursor: number;
  cursorConsistent: boolean; highestCompleted: number;
  stillHolding: number[]; operatorCleared: number[];
  duplicateAwards: Array<{ sourceEventId: number; repId: number; n: number }>;
  truncated: boolean;
} {
  requireQueueTenant(tenantId);
  const { cursor } = tenantProgress(subscriber, tenantId);
  const highest = Number((rawDb.prepare(
    `SELECT COALESCE(MAX(s.event_id), 0) AS m FROM event_processing_state s
      JOIN domain_events e ON e.id=s.event_id WHERE s.subscriber=? AND e.tenant_id=? AND s.status='completed'`,
  ).get(subscriber, tenantId) as any)?.m ?? 0);

  const stillHolding = (rawDb.prepare(
    `SELECT s.event_id AS id FROM event_processing_state s JOIN domain_events e ON e.id=s.event_id
      WHERE s.subscriber=? AND e.tenant_id=? AND s.status IN ('blocked','failed','processing') ORDER BY s.event_id ASC LIMIT ?`,
  ).all(subscriber, tenantId, QUEUE_REPORT_LIMIT + 1) as any[]).map(r => Number(r.id));

  const operatorCleared = (rawDb.prepare(
    `SELECT s.event_id AS id FROM event_processing_state s JOIN domain_events e ON e.id=s.event_id
      WHERE s.subscriber=? AND e.tenant_id=? AND s.status IN ('dead_lettered','resolved') ORDER BY s.event_id ASC LIMIT ?`,
  ).all(subscriber, tenantId, QUEUE_REPORT_LIMIT + 1) as any[]).map(r => Number(r.id));

  // The idempotency proof: one event must never have produced two awards for
  // the same rep. A retry that double-paid would show up here.
  const hasSpiffs = !!rawDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='spiffs'`).get()
    && (rawDb.prepare(`PRAGMA table_info(spiffs)`).all() as any[]).some((c: any) => c.name === "source_event_id");
  const duplicateAwards = !hasSpiffs ? [] : (rawDb.prepare(
    `SELECT source_event_id AS sourceEventId, rep_id AS repId, COUNT(*) AS n
       FROM spiffs WHERE tenant_id=? AND source_event_id IS NOT NULL AND EXISTS
         (SELECT 1 FROM domain_events e WHERE e.id=spiffs.source_event_id AND e.tenant_id=?)
      GROUP BY source_event_id, rep_id HAVING COUNT(*) > 1 ORDER BY source_event_id,rep_id LIMIT ?`,
  ).all(tenantId, tenantId, QUEUE_REPORT_LIMIT + 1) as any[]).map(r => ({ sourceEventId: Number(r.sourceEventId), repId: Number(r.repId), n: Number(r.n) }));

  return {
    subscriber, cursor,
    // A completed local event ahead of the visible checkpoint needs recovery.
    // This tenant view does not assert the global queue's full consistency.
    cursorConsistent: cursor >= highest,
    highestCompleted: highest,
    stillHolding: stillHolding.slice(0, QUEUE_REPORT_LIMIT),
    operatorCleared: operatorCleared.slice(0, QUEUE_REPORT_LIMIT),
    duplicateAwards: duplicateAwards.slice(0, QUEUE_REPORT_LIMIT),
    truncated: [stillHolding, operatorCleared, duplicateAwards].some(rows => rows.length > QUEUE_REPORT_LIMIT),
  };
}
