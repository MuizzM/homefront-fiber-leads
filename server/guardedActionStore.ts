// ── Guarded actions - persistence ────────────────────────────────────────────
//
// Every read here is tenant-scoped at the SQL level rather than filtered
// afterwards, for the same reason vendorOrderStore is: the expiry sweep runs
// outside any request, so there is no session to fall back on and no middleware
// to catch a query that forgot its organization.
//
// TRANSACTION DISCIPLINE. server/db.ts records an 8 GB WAL incident caused by
// long writer transactions starving the checkpointer. Nothing here holds a
// transaction across an executor: the executor is arbitrary domain code that
// may itself write, and wrapping it would nest a slow, unpredictable body
// inside a writer lock. State transitions are short single-statement writes;
// the engine sequences them.

import { rawDb } from "./db";
import {
  clampPolicy, defaultPolicy, GUARDED_ACTION_KINDS,
  type GatePolicy, type GateVerdict, type GuardedActionKind, type GuardedActionState,
} from "@shared/guardedActions";
import type { GuardedActionEventType } from "./guardedActionMigrations";

const nowIso = () => new Date().toISOString();

// ── Policy ───────────────────────────────────────────────────────────────────

interface PolicyRow {
  kind: string;
  mode: string;
  approval_above_magnitude: number | null;
  self_approval: number;
  undo_window_minutes: number;
  pending_expiry_minutes: number;
  updated_by_user_id: number | null;
  updated_at: string | null;
}

function rowToPolicy(row: PolicyRow): GatePolicy {
  // Clamped on the way OUT as well as in. A row written before a kind's floor
  // was tightened must not keep running under the old rule; the floor lives in
  // the code, and the code is what is deployed.
  return clampPolicy({
    kind: row.kind as GuardedActionKind,
    mode: row.mode as GatePolicy["mode"],
    approvalAboveMagnitude: row.approval_above_magnitude,
    selfApproval: row.self_approval === 1,
    undoWindowMinutes: row.undo_window_minutes,
    pendingExpiryMinutes: row.pending_expiry_minutes,
  });
}

/** The effective policy for one kind. A missing row is the catalogue default,
 *  never an error: an organization that has never opened the settings screen is
 *  the common case, not a broken one. */
export function getPolicy(tenantId: number, kind: GuardedActionKind): GatePolicy {
  const row = rawDb.prepare(
    `SELECT * FROM guarded_action_policies WHERE tenant_id = ? AND kind = ?`,
  ).get(tenantId, kind) as PolicyRow | undefined;
  return row ? rowToPolicy(row) : defaultPolicy(kind);
}

/** Every kind's effective policy, in catalogue order so the settings screen is
 *  stable between renders. */
export function listPolicies(tenantId: number): Array<GatePolicy & { configured: boolean; updatedAt: string | null }> {
  const rows = rawDb.prepare(
    `SELECT * FROM guarded_action_policies WHERE tenant_id = ?`,
  ).all(tenantId) as PolicyRow[];
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return GUARDED_ACTION_KINDS.map((kind) => {
    const row = byKind.get(kind);
    return {
      ...(row ? rowToPolicy(row) : defaultPolicy(kind)),
      configured: !!row,
      updatedAt: row?.updated_at ?? null,
    };
  });
}

export function savePolicy(tenantId: number, input: GatePolicy, updatedByUserId: number | null): GatePolicy {
  const policy = clampPolicy(input);
  rawDb.prepare(
    `INSERT INTO guarded_action_policies
       (tenant_id, kind, mode, approval_above_magnitude, self_approval,
        undo_window_minutes, pending_expiry_minutes, updated_by_user_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, kind) DO UPDATE SET
       mode = excluded.mode,
       approval_above_magnitude = excluded.approval_above_magnitude,
       self_approval = excluded.self_approval,
       undo_window_minutes = excluded.undo_window_minutes,
       pending_expiry_minutes = excluded.pending_expiry_minutes,
       updated_by_user_id = excluded.updated_by_user_id,
       updated_at = excluded.updated_at`,
  ).run(
    tenantId, policy.kind, policy.mode, policy.approvalAboveMagnitude,
    policy.selfApproval ? 1 : 0, policy.undoWindowMinutes, policy.pendingExpiryMinutes,
    updatedByUserId, nowIso(), nowIso(),
  );
  return policy;
}

// ── Actions ──────────────────────────────────────────────────────────────────

export interface GuardedActionRow {
  id: number;
  tenant_id: number;
  kind: GuardedActionKind;
  state: GuardedActionState;
  payload_json: string;
  magnitude: number;
  target_label: string | null;
  requested_by_user_id: number | null;
  requested_by_name: string | null;
  requested_at: string;
  request_reason: string | null;
  gate_outcome: "execute" | "approval" | "deny";
  gate_reason: string;
  policy_snapshot_json: string;
  idempotency_key: string | null;
  expires_at: string | null;
  decided_by_user_id: number | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  executed_at: string | null;
  result_summary: string | null;
  inverse_json: string | null;
  post_fingerprint: string | null;
  undo_deadline: string | null;
  failure_reason: string | null;
  undone_at: string | null;
  undone_by_user_id: number | null;
  undone_by_name: string | null;
  undo_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateActionInput {
  tenantId: number;
  kind: GuardedActionKind;
  state: GuardedActionState;
  payload: unknown;
  magnitude: number;
  targetLabel: string | null;
  requestedByUserId: number | null;
  requestedByName: string | null;
  requestReason: string | null;
  verdict: GateVerdict;
  policy: GatePolicy;
  idempotencyKey: string | null;
  expiresAt: string | null;
}

export function createAction(input: CreateActionInput): GuardedActionRow {
  const at = nowIso();
  const info = rawDb.prepare(
    `INSERT INTO guarded_actions
       (tenant_id, kind, state, payload_json, magnitude, target_label,
        requested_by_user_id, requested_by_name, requested_at, request_reason,
        gate_outcome, gate_reason, policy_snapshot_json, idempotency_key, expires_at,
        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    input.tenantId, input.kind, input.state, JSON.stringify(input.payload ?? {}),
    Math.max(1, Math.floor(input.magnitude)), input.targetLabel,
    input.requestedByUserId, input.requestedByName, at, input.requestReason,
    input.verdict.outcome, input.verdict.reason, JSON.stringify(input.policy),
    input.idempotencyKey, input.expiresAt, at, at,
  );
  return getAction(input.tenantId, Number(info.lastInsertRowid))!;
}

export function getAction(tenantId: number, id: number): GuardedActionRow | null {
  return (rawDb.prepare(
    `SELECT * FROM guarded_actions WHERE tenant_id = ? AND id = ?`,
  ).get(tenantId, id) as GuardedActionRow | undefined) ?? null;
}

export function findByIdempotencyKey(tenantId: number, key: string): GuardedActionRow | null {
  return (rawDb.prepare(
    `SELECT * FROM guarded_actions WHERE tenant_id = ? AND idempotency_key = ?`,
  ).get(tenantId, key) as GuardedActionRow | undefined) ?? null;
}

/**
 * Move an action to a new state.
 *
 * `expectedState` is not optional and not decoration: approve, reject, execute
 * and undo all read the row, decide, then write, and two approvers clicking at
 * the same moment must not both win. The UPDATE carries the state the caller
 * believed it was in, so the loser writes zero rows and the engine turns that
 * into a clear "somebody else already decided this".
 */
export function transition(
  tenantId: number,
  id: number,
  expectedState: GuardedActionState,
  next: GuardedActionState,
  patch: Partial<Record<
    | "decided_by_user_id" | "decided_by_name" | "decided_at" | "decision_note"
    | "executed_at" | "result_summary" | "inverse_json" | "post_fingerprint"
    | "undo_deadline" | "failure_reason"
    | "undone_at" | "undone_by_user_id" | "undone_by_name" | "undo_reason",
    string | number | null
  >> = {},
): boolean {
  const columns = Object.keys(patch);
  const sets = ["state = ?", "updated_at = ?", ...columns.map((c) => `${c} = ?`)];
  const values: Array<string | number | null> = [next, nowIso(), ...columns.map((c) => patch[c as keyof typeof patch] ?? null)];
  const info = rawDb.prepare(
    `UPDATE guarded_actions SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ? AND state = ?`,
  ).run(...values, tenantId, id, expectedState);
  return info.changes > 0;
}

export interface ListActionsFilter {
  tenantId: number;
  states?: GuardedActionState[];
  kinds?: GuardedActionKind[];
  /** Restrict to actions this person submitted. The queue uses it for "mine". */
  requestedByUserId?: number;
  limit?: number;
  offset?: number;
  /** Pending queue reads oldest-first; history reads newest-first. */
  order?: "oldest" | "newest";
}

export function listActions(filter: ListActionsFilter): { rows: GuardedActionRow[]; total: number } {
  const where: string[] = ["tenant_id = ?"];
  const params: Array<string | number> = [filter.tenantId];

  if (filter.states?.length) {
    where.push(`state IN (${filter.states.map(() => "?").join(",")})`);
    params.push(...filter.states);
  }
  if (filter.kinds?.length) {
    where.push(`kind IN (${filter.kinds.map(() => "?").join(",")})`);
    params.push(...filter.kinds);
  }
  if (filter.requestedByUserId != null) {
    where.push("requested_by_user_id = ?");
    params.push(filter.requestedByUserId);
  }

  const clause = where.join(" AND ");
  const total = Number((rawDb.prepare(
    `SELECT COUNT(*) AS n FROM guarded_actions WHERE ${clause}`,
  ).get(...params) as { n: number }).n);

  const limit = Math.max(1, Math.min(Math.floor(filter.limit ?? 50), 200));
  const offset = Math.max(0, Math.floor(filter.offset ?? 0));
  const direction = filter.order === "oldest" ? "ASC" : "DESC";
  const rows = rawDb.prepare(
    `SELECT * FROM guarded_actions WHERE ${clause} ORDER BY requested_at ${direction}, id ${direction} LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as GuardedActionRow[];

  return { rows, total };
}

/** How many pending actions this approver would see. Rendered as the nav badge,
 *  so it is its own query rather than a full listing the caller counts. */
export function countPending(tenantId: number, kinds: GuardedActionKind[]): number {
  if (!kinds.length) return 0;
  return Number((rawDb.prepare(
    `SELECT COUNT(*) AS n FROM guarded_actions
      WHERE tenant_id = ? AND state = 'pending' AND kind IN (${kinds.map(() => "?").join(",")})`,
  ).get(tenantId, ...kinds) as { n: number }).n);
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface ActionEventRow {
  id: number;
  event_type: GuardedActionEventType;
  at: string;
  actor_user_id: number | null;
  actor_name: string | null;
  note: string | null;
  detail_json: string | null;
}

/** Append one transition. Never throws: an action that succeeded must not be
 *  reported as failed because its history row hiccuped. Same rule as
 *  recordAdminAudit, and for the same reason. */
export function recordEvent(input: {
  tenantId: number;
  actionId: number;
  type: GuardedActionEventType;
  actorUserId?: number | null;
  actorName?: string | null;
  note?: string | null;
  detail?: unknown;
}): void {
  try {
    rawDb.prepare(
      `INSERT INTO guarded_action_events
         (tenant_id, action_id, event_type, at, actor_user_id, actor_name, note, detail_json)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      input.tenantId, input.actionId, input.type, nowIso(),
      input.actorUserId ?? null, input.actorName ?? null,
      input.note ?? null,
      input.detail === undefined ? null : JSON.stringify(input.detail),
    );
  } catch (error: any) {
    console.warn("[guarded-actions] event write failed:", String(error?.message ?? error).slice(0, 200));
  }
}

export function listEvents(tenantId: number, actionId: number): ActionEventRow[] {
  return rawDb.prepare(
    `SELECT id, event_type, at, actor_user_id, actor_name, note, detail_json
       FROM guarded_action_events
      WHERE tenant_id = ? AND action_id = ?
      ORDER BY at ASC, id ASC`,
  ).all(tenantId, actionId) as ActionEventRow[];
}

// ── Expiry ───────────────────────────────────────────────────────────────────

/**
 * Pending actions whose deadline has passed, across every tenant.
 *
 * Returned rather than expired in place so the caller can write the transition
 * and the event together per row, and so a sweep is a normal bounded read
 * instead of one long UPDATE holding the writer lock.
 */
export function findExpirable(limit = 200): GuardedActionRow[] {
  return rawDb.prepare(
    `SELECT * FROM guarded_actions
      WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY expires_at ASC LIMIT ?`,
  ).all(nowIso(), Math.max(1, Math.min(limit, 1000))) as GuardedActionRow[];
}
