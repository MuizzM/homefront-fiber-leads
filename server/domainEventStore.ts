// ── Domain event log — the durable half of shared/domainEvents.ts ───────────
//
// APPEND-ONLY. Rows are never updated and never deleted; DB triggers ABORT both,
// the same guard `reserve_entries` uses. An event is a statement that something
// happened, and a statement that can be edited afterwards is worth nothing to
// the reward that cites it as `source_event_id`.
//
// ── IDEMPOTENCY IS THE DATABASE'S JOB, NOT THE CALLER'S ─────────────────────
// `UNIQUE(tenant_id, dedupe_key)` plus `INSERT … ON CONFLICT DO NOTHING` means
// `emit()` is safe to call from a retried request, a replayed webhook, or two
// concurrent writers, and the caller never has to ask "did I already do this?".
// A collapsed emission returns the EXISTING row rather than null, so the caller
// still gets an event id to attribute work to — this is the difference between
// "the retry did nothing" and "the retry silently lost its reward".
//
// ── DELIVERY: CURSORS, NOT TRIGGERS ─────────────────────────────────────────
// Subscribers pull with a monotonic id cursor stored in `event_subscriptions`.
// Deliberately not a per-row trigger or an in-process emitter:
//
//   * a subscriber that crashes mid-batch resumes exactly where it stopped,
//     because the cursor only advances after the batch's work is committed;
//   * back-pressure is a `LIMIT`, not an unbounded queue in memory;
//   * a new subscriber can be added later and replayed from 0 over history,
//     which is what makes "we should have been paying this all along" a
//     recoverable situation rather than a data-entry project.
//
// The cost is that delivery is at-least-once, never exactly-once. That is fine
// and is why `rewardKey` exists: the reward write is itself idempotent, so a
// re-delivered event pays nothing extra.

import { rawDb } from "./db";
import {
  eventDedupeKey, validateEventInput, isDomainEventType,
  type DomainEvent, type DomainEventInput, type DomainEventType,
} from "@shared/domainEvents";

export function ensureDomainEventSchema(): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS domain_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id INTEGER NOT NULL,
      subject_rep_id INTEGER,
      actor_user_id INTEGER,
      payload TEXT,
      -- The instant the FACT happened (caller-supplied). ISO .000Z always.
      occurred_at TEXT NOT NULL,
      -- The instant WE learned it. Differs from occurred_at for anything that
      -- syncs from the field; both are kept because reporting wants the first
      -- and replay ordering wants the second.
      recorded_at TEXT NOT NULL,
      dedupe_key TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_events_dedupe
      ON domain_events(tenant_id, dedupe_key);
    -- The subscriber's read path: "everything after cursor N", id-ordered.
    CREATE INDEX IF NOT EXISTS idx_domain_events_cursor
      ON domain_events(id, tenant_id);
    CREATE INDEX IF NOT EXISTS idx_domain_events_tenant_cursor
      ON domain_events(tenant_id, id);
    -- Reporting: "what happened to this thing?" and "what happened to this rep?"
    CREATE INDEX IF NOT EXISTS idx_domain_events_subject
      ON domain_events(tenant_id, subject_type, subject_id, id);
    CREATE INDEX IF NOT EXISTS idx_domain_events_rep
      ON domain_events(tenant_id, subject_rep_id, type, occurred_at);

    CREATE TABLE IF NOT EXISTS event_subscriptions (
      name TEXT PRIMARY KEY,
      last_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);

  // Append-only, enforced where it cannot be forgotten. The application has no
  // update or delete path for this table; these make that a property of the
  // database rather than a property of everyone's future diligence.
  rawDb.exec(`
    CREATE TRIGGER IF NOT EXISTS domain_events_no_update
      BEFORE UPDATE ON domain_events
      BEGIN SELECT RAISE(ABORT, 'domain_events is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS domain_events_no_delete
      BEFORE DELETE ON domain_events
      BEGIN SELECT RAISE(ABORT, 'domain_events is append-only'); END;
  `);
}
ensureDomainEventSchema();

function mapEvent(r: any): DomainEvent | null {
  if (!r) return null;
  let payload: Record<string, unknown> | null = null;
  if (r.payload) {
    // A malformed payload must not take down the subscriber that reads it. The
    // event's identity and type are what drive money; the payload is detail.
    try { payload = JSON.parse(r.payload); } catch { payload = null; }
  }
  return {
    id: r.id,
    tenantId: r.tenant_id,
    type: r.type as DomainEventType,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    subjectRepId: r.subject_rep_id ?? null,
    actorUserId: r.actor_user_id ?? null,
    payload,
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
    dedupeKey: r.dedupe_key,
  };
}

/**
 * Record that something happened. Returns the event — the newly inserted one,
 * or the one that was already there when this emission was a duplicate.
 *
 * `nowIso` is passed in rather than read from the clock so the emit path stays
 * testable at a fixed instant, matching how every other money-adjacent module
 * here takes its timestamp from the call site.
 */
export function emit(input: DomainEventInput, nowIso: string): DomainEvent {
  const problems = validateEventInput(input);
  if (problems.length > 0) throw new Error(`INVALID_EVENT:${problems.join("; ")}`);

  const key = eventDedupeKey(input);
  const payload = input.payload == null ? null : JSON.stringify(input.payload);

  rawDb.prepare(
    `INSERT INTO domain_events
       (tenant_id, type, subject_type, subject_id, subject_rep_id, actor_user_id,
        payload, occurred_at, recorded_at, dedupe_key)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, dedupe_key) DO NOTHING`,
  ).run(
    input.tenantId, input.type, input.subjectType, input.subjectId,
    input.subjectRepId ?? null, input.actorUserId ?? null,
    payload, input.occurredAt, nowIso, key,
  );

  // Read back unconditionally rather than trusting lastInsertRowid: on the
  // conflict path there is no new rowid, and on the insert path this is the
  // same row. One shape of return value, whichever branch ran.
  const row = rawDb.prepare(
    `SELECT * FROM domain_events WHERE tenant_id = ? AND dedupe_key = ?`,
  ).get(input.tenantId, key);
  const event = mapEvent(row);
  if (!event) throw new Error("EVENT_EMIT_FAILED");
  return event;
}

/** Was this exact fact already recorded? Cheap pre-check for callers that want
 *  to skip expensive work before emitting, never a substitute for the UNIQUE. */
export function alreadyEmitted(tenantId: number, dedupeKey: string): boolean {
  return !!rawDb.prepare(
    `SELECT 1 FROM domain_events WHERE tenant_id = ? AND dedupe_key = ? LIMIT 1`,
  ).get(tenantId, dedupeKey);
}

export function getEvent(tenantId: number, id: number): DomainEvent | null {
  return mapEvent(rawDb.prepare(
    `SELECT * FROM domain_events WHERE tenant_id = ? AND id = ?`,
  ).get(tenantId, id));
}

/** Everything that has happened to one subject, oldest first — the audit view
 *  behind "referral history" and "why was this trip paid?". */
export function eventsForSubject(
  tenantId: number, subjectType: string, subjectId: number, limit = 200,
): DomainEvent[] {
  const rows = rawDb.prepare(
    `SELECT * FROM domain_events
      WHERE tenant_id = ? AND subject_type = ? AND subject_id = ?
      ORDER BY id ASC LIMIT ?`,
  ).all(tenantId, subjectType, subjectId, Math.max(1, Math.min(1000, limit)));
  return rows.map(mapEvent).filter((e): e is DomainEvent => e != null);
}

// ── Subscriptions ───────────────────────────────────────────────────────────

export function cursorFor(name: string): number {
  const row = rawDb.prepare(
    `SELECT last_event_id AS id FROM event_subscriptions WHERE name = ?`,
  ).get(name) as { id: number } | undefined;
  return row?.id ?? 0;
}

/**
 * The next batch for a subscriber, id-ordered. Deliberately CROSS-TENANT: the
 * subscriber is a background worker, not a request, and giving it one ordered
 * stream is what keeps a single cursor meaningful. Every consumer must still
 * scope its own writes by `event.tenantId` — which the incentive subscriber
 * does, because campaigns are looked up per tenant.
 */
export function nextBatch(name: string, limit = 500): DomainEvent[] {
  const after = cursorFor(name);
  const rows = rawDb.prepare(
    `SELECT * FROM domain_events WHERE id > ? ORDER BY id ASC LIMIT ?`,
  ).all(after, Math.max(1, Math.min(5000, limit)));
  return rows.map(mapEvent).filter((e): e is DomainEvent => e != null);
}

/**
 * Advance a cursor. Call this only AFTER the batch's effects are committed —
 * an advance that outruns its work is an event nobody ever processes, and
 * because rewards are separately idempotent, the opposite ordering (work
 * committed, cursor advance lost) is harmless: the batch simply re-runs and
 * pays nothing extra.
 *
 * Monotonic by construction: a lower id is ignored rather than rewinding a
 * cursor that another process already moved forward.
 */
export function advanceCursor(name: string, lastEventId: number, nowIso: string): void {
  rawDb.prepare(
    `INSERT INTO event_subscriptions (name, last_event_id, updated_at)
     VALUES (?,?,?)
     ON CONFLICT(name) DO UPDATE SET
       last_event_id = MAX(event_subscriptions.last_event_id, excluded.last_event_id),
       updated_at = excluded.updated_at`,
  ).run(name, Math.trunc(lastEventId), nowIso);
}

/** Rewind a subscriber so it replays history. The recovery tool for "this
 *  campaign should have been paying since Tuesday" — safe precisely because
 *  every reward write is keyed and a replay re-pays nothing. */
export function resetCursor(name: string, toEventId: number, nowIso: string): void {
  rawDb.prepare(
    `INSERT INTO event_subscriptions (name, last_event_id, updated_at)
     VALUES (?,?,?)
     ON CONFLICT(name) DO UPDATE SET last_event_id = excluded.last_event_id, updated_at = excluded.updated_at`,
  ).run(name, Math.max(0, Math.trunc(toEventId)), nowIso);
}

/** How far behind a subscriber is — the number surfaced on the admin ops page. */
export function backlogFor(name: string): number {
  const after = cursorFor(name);
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM domain_events WHERE id > ?`,
  ).get(after) as { n: number };
  return row?.n ?? 0;
}

/** Guard for routes that accept an event type from a client. */
export function parseEventType(v: unknown): DomainEventType | null {
  return isDomainEventType(v) ? v : null;
}
