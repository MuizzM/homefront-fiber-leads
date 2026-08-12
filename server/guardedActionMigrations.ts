// ── Guarded actions - schema ─────────────────────────────────────────────────
//
// Three tables, and the split between them is the whole design.
//
// POLICY vs ACTION
//   `guarded_action_policies` is CONFIGURATION: what this organization has
//   decided about a kind of action. `guarded_actions` is one REQUEST. They are
//   separate because policy changes and requests do not: an action approved in
//   August under a 200-door threshold must still read as correctly approved in
//   October after somebody lowered it to 50. So every action freezes the policy
//   it was judged under (`policy_snapshot_json`) at submit time and never reads
//   the live row again. Re-deriving the verdict later from current policy would
//   quietly rewrite history every time an admin touched a setting.
//
// STATE vs TRANSITIONS
//   `guarded_actions` holds where a request IS. `guarded_action_events` holds
//   how it got there, append-only, enforced by triggers the way admin_audit is.
//   The state column is what the queue renders; the event stream is what an
//   incident review reads. Collapsing them would mean either losing "who
//   approved this and when" or reconstructing it from the audit log, which is
//   filed by actor and not by action.
//
// THE INVERSE IS CAPTURED, NEVER RE-DERIVED
//   `inverse_json` is written at execution time from state that was OBSERVED
//   just before the write. Computing an inverse at undo time would read a world
//   that has moved on: if a door was reassigned Sam -> Alex and later Alex ->
//   Jo, an inverse derived at undo time reads "put it back to Alex", which is
//   not where it started and not what anyone asked for.
//
//   `post_fingerprint` is the other half of that guarantee. It hashes the state
//   the execution LEFT BEHIND. Undo recomputes it and refuses if it has drifted,
//   because a drifted fingerprint means somebody else changed the same rows
//   afterwards and reversing would silently clobber their work. Refusing is the
//   correct answer there; the operator can still act, they just cannot do it by
//   pretending nothing happened in between.
//
// TENANCY
//   Every table carries `tenant_id`, and no read in this plane is written
//   without it in the WHERE clause.

import { rawDb } from "./db";
import {
  GATE_MODES, GUARDED_ACTION_KINDS, GUARDED_ACTION_STATES,
} from "@shared/guardedActions";

/** CHECK bodies generated from the shared unions so the database and the code
 *  that reads it cannot drift apart. Same device as vendorOrderMigrations. */
const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const KIND_CHECK = list(GUARDED_ACTION_KINDS);
const MODE_CHECK = list(GATE_MODES);
const STATE_CHECK = list(GUARDED_ACTION_STATES);

/** Transitions worth their own row. Distinct from the state list: `submitted`
 *  is an event and never a state, and `undo_failed` records an ATTEMPT that
 *  left the action still executed. */
export const GUARDED_ACTION_EVENT_TYPES = [
  "submitted", "auto_executed", "approved", "rejected", "expired",
  "executed", "execution_failed", "undone", "undo_failed",
] as const;
export type GuardedActionEventType = (typeof GUARDED_ACTION_EVENT_TYPES)[number];
const EVENT_CHECK = list(GUARDED_ACTION_EVENT_TYPES);

let schemaReady = false;

/** Idempotent DDL. Safe on every boot and from any test. */
export function runGuardedActionMigrations(): void {
  if (schemaReady) return;

  rawDb.exec("BEGIN IMMEDIATE");
  try {
    rawDb.exec(`
      -- ── Per-organization policy, one row per kind ────────────────────────
      -- Absent row means "the catalogue default". Deliberately NOT seeded for
      -- every tenant at migration time: a missing row and a row that happens
      -- to match the default are the same thing, and seeding would mean a
      -- later change to a default silently failing to reach anyone.
      CREATE TABLE IF NOT EXISTS guarded_action_policies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN (${KIND_CHECK})),
        mode TEXT NOT NULL CHECK(mode IN (${MODE_CHECK})),
        approval_above_magnitude INTEGER,
        self_approval INTEGER NOT NULL DEFAULT 0 CHECK(self_approval IN (0,1)),
        undo_window_minutes INTEGER NOT NULL DEFAULT 60,
        pending_expiry_minutes INTEGER NOT NULL DEFAULT 4320,
        updated_by_user_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_guarded_action_policy
        ON guarded_action_policies(tenant_id, kind);

      -- ── One request through the gate ─────────────────────────────────────
      CREATE TABLE IF NOT EXISTS guarded_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN (${KIND_CHECK})),
        state TEXT NOT NULL CHECK(state IN (${STATE_CHECK})),

        -- The intent, exactly as submitted. Never mutated: an approver must be
        -- able to see what they are approving, not what it became.
        payload_json TEXT NOT NULL,
        -- How much this moves, in the kind's own unit. Denormalized out of the
        -- payload because the queue sorts and filters on it.
        magnitude INTEGER NOT NULL DEFAULT 1,
        -- Human-readable target, for a queue row that reads as a sentence
        -- without joining to four other tables.
        target_label TEXT,

        requested_by_user_id INTEGER,
        requested_by_name TEXT,
        requested_at TEXT NOT NULL DEFAULT (datetime('now')),
        request_reason TEXT,

        -- The verdict and the rules it ran under, both frozen at submit time.
        gate_outcome TEXT NOT NULL CHECK(gate_outcome IN ('execute','approval','deny')),
        gate_reason TEXT NOT NULL,
        policy_snapshot_json TEXT NOT NULL,

        -- Caller-supplied de-duplication. A retried request returns the
        -- original action rather than queueing a second one, which matters
        -- most on exactly the flaky-network path where a rep taps twice.
        idempotency_key TEXT,

        expires_at TEXT,
        decided_by_user_id INTEGER,
        decided_by_name TEXT,
        decided_at TEXT,
        decision_note TEXT,

        executed_at TEXT,
        result_summary TEXT,
        -- What to do to reverse it, and what the world looked like immediately
        -- after. See the header: both are captured, never re-derived.
        inverse_json TEXT,
        post_fingerprint TEXT,
        undo_deadline TEXT,
        failure_reason TEXT,

        undone_at TEXT,
        undone_by_user_id INTEGER,
        undone_by_name TEXT,
        undo_reason TEXT,

        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- The approval queue's own query: this tenant, still pending, oldest
      -- first so the thing that has waited longest is the thing on top.
      CREATE INDEX IF NOT EXISTS idx_guarded_actions_pending
        ON guarded_actions(tenant_id, state, requested_at);
      -- History, newest first.
      CREATE INDEX IF NOT EXISTS idx_guarded_actions_recent
        ON guarded_actions(tenant_id, requested_at DESC);
      CREATE INDEX IF NOT EXISTS idx_guarded_actions_kind
        ON guarded_actions(tenant_id, kind, requested_at DESC);
      -- The expiry sweep reads pending rows by deadline across all tenants, so
      -- this index deliberately leads with state rather than tenant_id.
      CREATE INDEX IF NOT EXISTS idx_guarded_actions_expiry
        ON guarded_actions(state, expires_at);
      -- Partial, so the many rows with no key cost nothing. Unique per tenant:
      -- two organizations may legitimately generate the same client-side key.
      CREATE UNIQUE INDEX IF NOT EXISTS uq_guarded_actions_idempotency
        ON guarded_actions(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

      -- ── Append-only transition log ───────────────────────────────────────
      CREATE TABLE IF NOT EXISTS guarded_action_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        action_id INTEGER NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN (${EVENT_CHECK})),
        at TEXT NOT NULL DEFAULT (datetime('now')),
        actor_user_id INTEGER,
        actor_name TEXT,
        note TEXT,
        detail_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_guarded_action_events_action
        ON guarded_action_events(action_id, at);

      -- History that can be edited is not history. Same enforcement as
      -- admin_audit: the database refuses, not a convention in a code review.
      CREATE TRIGGER IF NOT EXISTS guarded_action_events_no_update
        BEFORE UPDATE ON guarded_action_events
        BEGIN SELECT RAISE(ABORT, 'guarded_action_events is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS guarded_action_events_no_delete
        BEFORE DELETE ON guarded_action_events
        BEGIN SELECT RAISE(ABORT, 'guarded_action_events is append-only'); END;
    `);
    rawDb.exec("COMMIT");
  } catch (error) {
    try { rawDb.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  }

  schemaReady = true;
}

/** Test-only: forget the memoised flag when the database is rebuilt under us. */
export function resetGuardedActionSchemaCache(): void {
  schemaReady = false;
}
