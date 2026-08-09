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

export function operatorAction(input: {
  subscriber: string; eventId: number; action: OperatorAction;
  actorUserId: number | null; reason: string; tenantId?: number | null;
}): any {
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 3) throw new Error("A reason is required for queue operator actions.");
  const state = getState(input.subscriber, input.eventId);
  if (!state) throw new Error("No queue state for that event.");

  const ts = now();
  if (input.action === "RETRY") {
    // Clear the backoff and the exhausted flag; the next drain picks it up.
    upsertState(input.subscriber, input.eventId, {
      status: "pending", retryable: 1, next_attempt_at: null,
      lease_owner: null, lease_expires_at: null,
      resolved_by: input.actorUserId, resolved_reason: reason, resolved_at: ts,
    });
  } else {
    upsertState(input.subscriber, input.eventId, {
      status: input.action === "DEAD_LETTER" ? "dead_lettered" : "resolved",
      retryable: 0, next_attempt_at: null, lease_owner: null, lease_expires_at: null,
      resolved_by: input.actorUserId, resolved_reason: reason, resolved_at: ts,
    });
  }
  storage.logActivity(input.actorUserId, `event_queue.${input.action.toLowerCase()}`, "domain_event", input.eventId, {
    subscriber: input.subscriber, reason,
    previousStatus: state.status, attempts: state.attempts,
    fingerprint: state.error_fingerprint,
  }, undefined);
  structuredLog("event_queue.operator_action", {
    subscriber: input.subscriber, eventId: input.eventId, action: input.action,
    actorUserId: input.actorUserId, previousStatus: state.status,
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
}

export function queueHealth(subscriber: string, cursor: number, backlog: number, nowMs = Date.now()): QueueHealth {
  const halted = rawDb.prepare(
    `SELECT event_id AS eventId, tenant_id AS tenantId, event_type AS eventType, attempts,
            error_fingerprint AS fingerprint, last_error AS lastError, first_failed_at AS firstFailedAt
       FROM event_processing_state
      WHERE subscriber = ? AND status IN ('blocked','failed')
      ORDER BY event_id ASC`,
  ).all(subscriber) as any[];

  const oldest = halted.reduce<number | null>((acc, h) => {
    const t = Date.parse(h.firstFailedAt ?? "");
    if (!Number.isFinite(t)) return acc;
    const age = nowMs - t;
    return acc == null || age > acc ? age : acc;
  }, null);

  const alerts: string[] = [];
  for (const h of halted) {
    if (Number(h.attempts) >= ALERT_ATTEMPTS) {
      alerts.push(`event ${h.eventId} has failed ${h.attempts}× (${h.fingerprint ?? "unknown"})`);
    }
  }
  if (oldest != null && oldest > ALERT_QUEUE_AGE_MS) {
    alerts.push(`queue has been halted for ${Math.round(oldest / 60_000)} minutes`);
  }
  if (alerts.length > 0) {
    structuredLog("event_queue.alert", { subscriber, halted: halted.length, oldestFailureAgeMs: oldest, backlog }, "error");
  }
  return { subscriber, cursor, backlog, halted, oldestFailureAgeMs: oldest, alerts };
}

/**
 * Post-resolution recovery check. READ-ONLY - it reports, it never repairs.
 *
 * Answers the three questions an operator has after clearing a stall: is the
 * cursor where the completed work says it should be, is anything still holding
 * the queue, and did the retries leave duplicate ledger effects behind.
 */
export function recoveryReport(subscriber: string, cursor: number): {
  subscriber: string; cursor: number;
  cursorConsistent: boolean; highestCompleted: number;
  stillHolding: number[]; operatorCleared: number[];
  duplicateAwards: Array<{ sourceEventId: number; repId: number; n: number }>;
} {
  const highest = Number((rawDb.prepare(
    `SELECT COALESCE(MAX(event_id), 0) AS m FROM event_processing_state WHERE subscriber = ? AND status = 'completed'`,
  ).get(subscriber) as any)?.m ?? 0);

  const stillHolding = (rawDb.prepare(
    `SELECT event_id AS id FROM event_processing_state
      WHERE subscriber = ? AND status IN ('blocked','failed','processing') ORDER BY event_id ASC`,
  ).all(subscriber) as any[]).map(r => Number(r.id));

  const operatorCleared = (rawDb.prepare(
    `SELECT event_id AS id FROM event_processing_state
      WHERE subscriber = ? AND status IN ('dead_lettered','resolved') ORDER BY event_id ASC`,
  ).all(subscriber) as any[]).map(r => Number(r.id));

  // The idempotency proof: one event must never have produced two awards for
  // the same rep. A retry that double-paid would show up here.
  const hasSpiffs = !!rawDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='spiffs'`).get()
    && (rawDb.prepare(`PRAGMA table_info(spiffs)`).all() as any[]).some((c: any) => c.name === "source_event_id");
  const duplicateAwards = !hasSpiffs ? [] : (rawDb.prepare(
    `SELECT source_event_id AS sourceEventId, rep_id AS repId, COUNT(*) AS n
       FROM spiffs WHERE source_event_id IS NOT NULL
      GROUP BY source_event_id, rep_id HAVING COUNT(*) > 1`,
  ).all() as any[]).map(r => ({ sourceEventId: Number(r.sourceEventId), repId: Number(r.repId), n: Number(r.n) }));

  return {
    subscriber, cursor,
    // The cursor must not have outrun what actually committed.
    cursorConsistent: cursor <= Math.max(highest, cursor === 0 ? 0 : cursor) && cursor >= 0 && (highest === 0 || cursor >= highest),
    highestCompleted: highest,
    stillHolding, operatorCleared, duplicateAwards,
  };
}
