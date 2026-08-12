// ── Guarded actions - the machinery ──────────────────────────────────────────
//
// submit -> (execute | queue | refuse) -> approve/reject -> execute -> undo
//
// Everything domain-specific lives behind the Executor interface below. This
// file knows about states, policy, races and reversal; it knows nothing about
// doors, cases or suppressions, which is what keeps a new action kind a matter
// of writing one executor rather than editing the gate.
//
// FIVE RULES THAT ARE EASY TO GET WRONG, AND HOW THEY ARE HELD HERE.
//
// 1. PREFLIGHT RUNS TWICE. Once at submit, so a request that cannot possibly
//    work is refused while the person is still looking at the screen, and again
//    immediately before execution, because an approval that sat in a queue for
//    two days was granted against a world that has since moved. The second run
//    is the one that matters; the first is a courtesy.
//
// 2. THE EXECUTOR RUNS OUTSIDE ANY TRANSACTION THIS FILE OPENS. It is arbitrary
//    domain code that writes rows of its own, and db.ts records an 8 GB WAL
//    incident caused by exactly this shape of long writer transaction. The
//    state machine is a sequence of short writes instead, each one guarded by
//    the expected-state check in store.transition().
//
// 3. A LOST RACE IS A CLEAR MESSAGE, NOT A SECOND EXECUTION. Every transition
//    carries the state the caller believed the row was in. Two approvers
//    clicking together means one UPDATE matches zero rows, and that becomes
//    "somebody already decided this" rather than the action running twice.
//
// 4. SELF-APPROVAL IS OFF UNLESS AN ORGANIZATION SAYS OTHERWISE. A queue one
//    person can clear alone is a log with extra steps.
//
// 5. UNDO REFUSES ON DRIFT. The fingerprint the execution left behind is
//    recomputed before reversing; if the targets have changed since, undo stops
//    and says so. Reversing over somebody else's later edit would be a silent
//    second incident caused by the tool meant to clean up the first.

import {
  clampPolicy, decideGate, guardedActionSpec, undoAvailability, undoUnavailableReason,
  type GuardedActionKind, type GatePolicy,
} from "@shared/guardedActions";
import { can } from "@shared/capabilities";
import * as store from "./guardedActionStore";
import type { GuardedActionRow } from "./guardedActionStore";
import { recordAdminAudit } from "./adminAudit";

// ── Feature flag ─────────────────────────────────────────────────────────────

/**
 * Ships OFF. With the flag down the HTTP surface answers 404 and
 * submitGuardedAction() returns a passthrough verdict, so a call site that has
 * been wired through the gate behaves exactly as it did before the gate
 * existed. That is the property that makes this safe to merge: turning it on is
 * a deliberate act, and turning it back off restores the previous behaviour
 * without a deploy of anything but an environment variable.
 */
export function guardedActionsEnabled(): boolean {
  return process.env.GUARDED_ACTIONS_ENABLED === "true";
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** A refusal the caller is allowed to see. Anything not wrapped in one of these
 *  becomes a generic 500 and is logged, never echoed. */
export class GuardedActionError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = "GuardedActionError";
  }
}

// ── Executor contract ────────────────────────────────────────────────────────

export interface ActorContext {
  tenantId: number;
  userId: number | null;
  name: string | null;
  role: string | null;
}

export interface ExecutorResult {
  /** One sentence, past tense, for the history row. */
  summary: string;
  /**
   * What to do to reverse this, captured from state observed just before the
   * write. null means the executor could not describe a reversal, and undo will
   * refuse rather than guess.
   */
  inverse: unknown | null;
}

export interface GuardedActionExecutor<P = unknown> {
  kind: GuardedActionKind;
  /** Validate and normalize the submitted payload. Throw GuardedActionError for
   *  anything a caller can fix. */
  parse(raw: unknown, ctx: ActorContext): P;
  /** How much this moves, in the kind's own unit. Feeds the magnitude gate. */
  magnitude(payload: P): number;
  /** A queue row that reads as a sentence without four joins. */
  label(payload: P, ctx: ActorContext): string;
  /** Can this run right now? Throw to refuse. Called at submit and again
   *  immediately before execution. */
  preflight(payload: P, ctx: ActorContext): void;
  execute(payload: P, ctx: ActorContext): ExecutorResult;
  /**
   * A hash of the CURRENT state of everything this payload targets. Stored
   * after execution and recomputed before undo; a mismatch means somebody else
   * has since touched the same rows.
   */
  fingerprint(payload: P, ctx: ActorContext): string;
  /** Apply a previously captured inverse. Separate from execute() because a
   *  reversal is not always the same shape as the forward action. */
  reverse(inverse: unknown, ctx: ActorContext): { summary: string };
}

const EXECUTORS = new Map<GuardedActionKind, GuardedActionExecutor<any>>();

export function registerExecutor<P>(executor: GuardedActionExecutor<P>): void {
  EXECUTORS.set(executor.kind, executor);
}

export function executorFor(kind: GuardedActionKind): GuardedActionExecutor<any> {
  const executor = EXECUTORS.get(kind);
  if (!executor) {
    // A kind in the catalogue with no executor is a programming error, not a
    // user one: the catalogue is the thing that advertises the action exists.
    throw new GuardedActionError(500, "That action is not available on this server.", "no_executor");
  }
  return executor;
}

export function registeredKinds(): GuardedActionKind[] {
  return [...EXECUTORS.keys()];
}

// ── Submit ───────────────────────────────────────────────────────────────────

export type SubmitResult =
  /** The gate is off. The caller runs its own legacy path unchanged. */
  | { status: "passthrough" }
  | { status: "executed"; action: GuardedActionRow }
  | { status: "pending"; action: GuardedActionRow }
  | { status: "denied"; action: GuardedActionRow };

export interface SubmitInput {
  kind: GuardedActionKind;
  payload: unknown;
  actor: ActorContext;
  reason?: string | null;
  idempotencyKey?: string | null;
}

export function submitGuardedAction(input: SubmitInput): SubmitResult {
  if (!guardedActionsEnabled()) return { status: "passthrough" };

  const { kind, actor } = input;
  const spec = guardedActionSpec(kind);
  const executor = executorFor(kind);

  if (!can(actor.role, spec.requestCapability)) {
    throw new GuardedActionError(403, "You do not have permission to request this action.", "forbidden");
  }

  // An idempotent retry returns the ORIGINAL outcome. Deliberately checked
  // before parse: a repeat of a request that already executed must not be
  // re-validated against a world it already changed.
  if (input.idempotencyKey) {
    const existing = store.findByIdempotencyKey(actor.tenantId, input.idempotencyKey);
    if (existing) return replayResult(existing);
  }

  const payload = executor.parse(input.payload, actor);
  executor.preflight(payload, actor);

  const magnitude = Math.max(1, Math.floor(executor.magnitude(payload)));
  const policy = store.getPolicy(actor.tenantId, kind);
  const verdict = decideGate(kind, policy, { magnitude });
  const label = safeLabel(executor, payload, actor);

  if (verdict.outcome === "deny") {
    const action = store.createAction({
      tenantId: actor.tenantId, kind, state: "rejected",
      payload, magnitude, targetLabel: label,
      requestedByUserId: actor.userId, requestedByName: actor.name,
      requestReason: input.reason ?? null,
      verdict, policy, idempotencyKey: input.idempotencyKey ?? null, expiresAt: null,
    });
    store.recordEvent({
      tenantId: actor.tenantId, actionId: action.id, type: "submitted",
      actorUserId: actor.userId, actorName: actor.name, note: verdict.reason,
    });
    store.recordEvent({
      tenantId: actor.tenantId, actionId: action.id, type: "rejected",
      actorUserId: null, actorName: "Policy", note: verdict.reason,
    });
    audit(actor, "guarded_action.denied", action, verdict.reason, "denied");
    return { status: "denied", action };
  }

  if (verdict.outcome === "approval") {
    const expiresAt = new Date(Date.now() + policy.pendingExpiryMinutes * 60_000).toISOString();
    const action = store.createAction({
      tenantId: actor.tenantId, kind, state: "pending",
      payload, magnitude, targetLabel: label,
      requestedByUserId: actor.userId, requestedByName: actor.name,
      requestReason: input.reason ?? null,
      verdict, policy, idempotencyKey: input.idempotencyKey ?? null, expiresAt,
    });
    store.recordEvent({
      tenantId: actor.tenantId, actionId: action.id, type: "submitted",
      actorUserId: actor.userId, actorName: actor.name, note: verdict.reason,
      detail: { magnitude, expiresAt },
    });
    audit(actor, "guarded_action.queued", action, verdict.reason);
    return { status: "pending", action };
  }

  const action = store.createAction({
    tenantId: actor.tenantId, kind, state: "approved",
    payload, magnitude, targetLabel: label,
    requestedByUserId: actor.userId, requestedByName: actor.name,
    requestReason: input.reason ?? null,
    verdict, policy, idempotencyKey: input.idempotencyKey ?? null, expiresAt: null,
  });
  store.recordEvent({
    tenantId: actor.tenantId, actionId: action.id, type: "submitted",
    actorUserId: actor.userId, actorName: actor.name, note: verdict.reason, detail: { magnitude },
  });
  store.recordEvent({
    tenantId: actor.tenantId, actionId: action.id, type: "auto_executed",
    actorUserId: actor.userId, actorName: actor.name, note: verdict.reason,
  });
  const executed = runExecution(action, actor, policy);
  return { status: "executed", action: executed };
}

/** An idempotent retry reports what the original request did, in the shape the
 *  first call returned. */
function replayResult(action: GuardedActionRow): SubmitResult {
  if (action.state === "pending") return { status: "pending", action };
  if (action.state === "rejected" && action.gate_outcome === "deny") return { status: "denied", action };
  return { status: "executed", action };
}

// ── Approve / reject ─────────────────────────────────────────────────────────

export function approveAction(
  actionId: number, actor: ActorContext, note: string | null,
): GuardedActionRow {
  const action = requirePending(actionId, actor);
  const spec = guardedActionSpec(action.kind);

  if (!can(actor.role, spec.approveCapability)) {
    throw new GuardedActionError(403, "You do not have permission to approve this action.", "forbidden");
  }

  // The policy the action was JUDGED under decides whether its requester may
  // also approve it. Reading live policy here would let an admin retroactively
  // legitimise a self-approval by flipping the switch after the fact.
  const policy = snapshotPolicy(action);
  if (!policy.selfApproval && action.requested_by_user_id != null && action.requested_by_user_id === actor.userId) {
    throw new GuardedActionError(
      403,
      "This action needs a second person. You submitted it, so somebody else has to approve it.",
      "self_approval",
    );
  }

  if (action.expires_at && Date.parse(action.expires_at) <= Date.now()) {
    expire(action);
    throw new GuardedActionError(409, "This request expired before it was approved.", "expired");
  }

  const moved = store.transition(actor.tenantId, action.id, "pending", "approved", {
    decided_by_user_id: actor.userId,
    decided_by_name: actor.name,
    decided_at: new Date().toISOString(),
    decision_note: note,
  });
  if (!moved) throw new GuardedActionError(409, "Somebody else already decided this request.", "race");

  store.recordEvent({
    tenantId: actor.tenantId, actionId: action.id, type: "approved",
    actorUserId: actor.userId, actorName: actor.name, note,
  });
  audit(actor, "guarded_action.approved", action, note);

  const fresh = store.getAction(actor.tenantId, action.id)!;
  return runExecution(fresh, actor, policy);
}

export function rejectAction(
  actionId: number, actor: ActorContext, note: string | null,
): GuardedActionRow {
  const action = requirePending(actionId, actor);
  const spec = guardedActionSpec(action.kind);

  if (!can(actor.role, spec.approveCapability)) {
    throw new GuardedActionError(403, "You do not have permission to decide this action.", "forbidden");
  }

  const moved = store.transition(actor.tenantId, action.id, "pending", "rejected", {
    decided_by_user_id: actor.userId,
    decided_by_name: actor.name,
    decided_at: new Date().toISOString(),
    decision_note: note,
  });
  if (!moved) throw new GuardedActionError(409, "Somebody else already decided this request.", "race");

  store.recordEvent({
    tenantId: actor.tenantId, actionId: action.id, type: "rejected",
    actorUserId: actor.userId, actorName: actor.name, note,
  });
  audit(actor, "guarded_action.rejected", action, note);
  return store.getAction(actor.tenantId, action.id)!;
}

// ── Execution ────────────────────────────────────────────────────────────────

/**
 * Run an approved action and record what it did.
 *
 * Never throws on executor failure. A failed execution is a legitimate outcome
 * that the requester needs to SEE - the row moves to `failed` with the reason,
 * which is far more useful than a 500 that leaves the queue showing `approved`
 * forever.
 */
function runExecution(action: GuardedActionRow, actor: ActorContext, policy: GatePolicy): GuardedActionRow {
  const executor = executorFor(action.kind);
  const spec = guardedActionSpec(action.kind);
  const payload = JSON.parse(action.payload_json);

  try {
    // The second preflight. An approval granted two days ago was granted
    // against a world that has since moved; this is the check that matters.
    executor.preflight(payload, actor);

    const result = executor.execute(payload, actor);
    const executedAt = new Date().toISOString();
    const fingerprint = safeFingerprint(executor, payload, actor);

    const undoWindow = spec.reversibility === "reversible"
      ? Math.min(policy.undoWindowMinutes, spec.maxUndoWindowMinutes)
      : 0;
    const undoDeadline = undoWindow > 0 && result.inverse != null
      ? new Date(Date.parse(executedAt) + undoWindow * 60_000).toISOString()
      : null;

    store.transition(actor.tenantId, action.id, "approved", "executed", {
      executed_at: executedAt,
      result_summary: result.summary,
      inverse_json: result.inverse == null ? null : JSON.stringify(result.inverse),
      post_fingerprint: fingerprint,
      undo_deadline: undoDeadline,
    });
    store.recordEvent({
      tenantId: actor.tenantId, actionId: action.id, type: "executed",
      actorUserId: actor.userId, actorName: actor.name, note: result.summary,
      detail: { undoDeadline },
    });
    audit(actor, "guarded_action.executed", action, result.summary);
    return store.getAction(actor.tenantId, action.id)!;
  } catch (error: any) {
    const reason = error instanceof GuardedActionError
      ? error.message
      : "The action could not be completed.";
    if (!(error instanceof GuardedActionError)) {
      console.error("[guarded-actions] execute failed:", action.kind, String(error?.message ?? error).slice(0, 300));
    }
    store.transition(actor.tenantId, action.id, "approved", "failed", { failure_reason: reason });
    store.recordEvent({
      tenantId: actor.tenantId, actionId: action.id, type: "execution_failed",
      actorUserId: actor.userId, actorName: actor.name, note: reason,
    });
    audit(actor, "guarded_action.execution_failed", action, reason, "failure");
    return store.getAction(actor.tenantId, action.id)!;
  }
}

// ── Undo ─────────────────────────────────────────────────────────────────────

export function undoAction(
  actionId: number, actor: ActorContext, reason: string | null,
): GuardedActionRow {
  const action = store.getAction(actor.tenantId, actionId);
  if (!action) throw new GuardedActionError(404, "That action does not exist.", "not_found");

  const spec = guardedActionSpec(action.kind);
  if (!can(actor.role, spec.approveCapability)) {
    throw new GuardedActionError(403, "You do not have permission to reverse this action.", "forbidden");
  }

  const policy = snapshotPolicy(action);
  const availability = undoAvailability({
    kind: action.kind,
    state: action.state,
    executedAt: action.executed_at,
    undoWindowMinutes: policy.undoWindowMinutes,
    hasInverse: !!action.inverse_json,
  });
  if (!availability.available) {
    // The shared helper owns the wording, so the API and the button's tooltip
    // say the same thing rather than two paraphrases that drift.
    throw new GuardedActionError(409, undoUnavailableReason(availability.because), availability.because);
  }

  const executor = executorFor(action.kind);
  const payload = JSON.parse(action.payload_json);

  // The drift check. See the file header: reversing over somebody else's later
  // edit would be a second incident caused by the tool meant to clean up the
  // first.
  const current = safeFingerprint(executor, payload, actor);
  if (action.post_fingerprint && current !== action.post_fingerprint) {
    store.recordEvent({
      tenantId: actor.tenantId, actionId: action.id, type: "undo_failed",
      actorUserId: actor.userId, actorName: actor.name,
      note: "State changed after this action ran, so it was not reversed.",
    });
    throw new GuardedActionError(
      409,
      "Something else changed these records after this action ran. Reversing now would overwrite that, so it was not applied.",
      "drift",
    );
  }

  try {
    const result = executor.reverse(JSON.parse(action.inverse_json!), actor);
    const moved = store.transition(actor.tenantId, action.id, "executed", "undone", {
      undone_at: new Date().toISOString(),
      undone_by_user_id: actor.userId,
      undone_by_name: actor.name,
      undo_reason: reason,
    });
    if (!moved) throw new GuardedActionError(409, "This action was already reversed.", "race");

    store.recordEvent({
      tenantId: actor.tenantId, actionId: action.id, type: "undone",
      actorUserId: actor.userId, actorName: actor.name, note: result.summary,
    });
    audit(actor, "guarded_action.undone", action, result.summary);
    return store.getAction(actor.tenantId, action.id)!;
  } catch (error: any) {
    if (error instanceof GuardedActionError) throw error;
    console.error("[guarded-actions] undo failed:", action.kind, String(error?.message ?? error).slice(0, 300));
    store.recordEvent({
      tenantId: actor.tenantId, actionId: action.id, type: "undo_failed",
      actorUserId: actor.userId, actorName: actor.name, note: "The reversal did not complete.",
    });
    throw new GuardedActionError(500, "The reversal did not complete. Nothing was changed.", "undo_failed");
  }
}

// ── Expiry sweep ─────────────────────────────────────────────────────────────

/**
 * Expire pending actions past their deadline.
 *
 * Called from the read path as well as any scheduler, deliberately: an
 * organization that never runs a background job must still never see a
 * two-week-old request presented as actionable. Bounded per call so it can ride
 * on a request without becoming one.
 */
export function sweepExpiredActions(limit = 100): number {
  const rows = store.findExpirable(limit);
  let expired = 0;
  for (const row of rows) if (expire(row)) expired += 1;
  return expired;
}

function expire(action: GuardedActionRow): boolean {
  const moved = store.transition(action.tenant_id, action.id, "pending", "expired", {
    decision_note: "No decision before the request expired.",
  });
  if (moved) {
    store.recordEvent({
      tenantId: action.tenant_id, actionId: action.id, type: "expired",
      actorUserId: null, actorName: "System",
      note: "No decision before the request expired.",
    });
  }
  return moved;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function requirePending(actionId: number, actor: ActorContext): GuardedActionRow {
  const action = store.getAction(actor.tenantId, actionId);
  // Out of scope is 404, not 403: a 403 confirms the row exists, which is
  // itself a disclosure. Same convention as the recovery and live-map routes.
  if (!action) throw new GuardedActionError(404, "That request does not exist.", "not_found");
  if (action.state !== "pending") {
    throw new GuardedActionError(409, `This request is already ${action.state}.`, "not_pending");
  }
  return action;
}

/** The policy frozen onto the action, clamped through the current catalogue.
 *  A snapshot taken before a floor was tightened must not outrank the floor. */
function snapshotPolicy(action: GuardedActionRow): GatePolicy {
  try {
    return clampPolicy({ ...JSON.parse(action.policy_snapshot_json), kind: action.kind });
  } catch {
    return store.getPolicy(action.tenant_id, action.kind);
  }
}

/** A label is presentation. Never let one fail a submit. */
function safeLabel(executor: GuardedActionExecutor<any>, payload: unknown, ctx: ActorContext): string {
  try {
    return String(executor.label(payload, ctx)).slice(0, 200);
  } catch {
    return guardedActionSpec(executor.kind).label;
  }
}

/** A fingerprint that cannot be computed is recorded as empty, which
 *  undoAvailability treats as "no drift check possible" and the undo path then
 *  compares against nothing. Deliberate: the alternative is failing an
 *  execution that already succeeded. */
function safeFingerprint(executor: GuardedActionExecutor<any>, payload: unknown, ctx: ActorContext): string {
  try {
    return String(executor.fingerprint(payload, ctx)).slice(0, 200);
  } catch {
    return "";
  }
}

function audit(
  actor: ActorContext,
  action: string,
  row: GuardedActionRow,
  reason: string | null,
  outcome: "success" | "failure" | "denied" = "success",
): void {
  recordAdminAudit({
    actor: { id: actor.userId, name: actor.name, role: actor.role, tenantId: actor.tenantId },
    action,
    targetType: "guarded_action",
    targetId: row.id,
    targetLabel: row.target_label ?? guardedActionSpec(row.kind).label,
    after: { kind: row.kind, magnitude: row.magnitude },
    reason,
    outcome,
    tenantId: actor.tenantId,
  });
}
