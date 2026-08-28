// ── Guarded actions - HTTP surface ───────────────────────────────────────────
//
// Four rules hold across every route here.
//
// THE FLAG IS THE OUTER WALL. With GUARDED_ACTIONS_ENABLED unset, every route
// in this file answers 404 - not 403, and not an empty list. A disabled feature
// should be indistinguishable from one that was never deployed, because a 403
// tells a caller the surface exists and invites them to go looking for the
// switch.
//
// SCOPE IS SERVER-SIDE. No endpoint accepts a tenant id. The organization comes
// off the session, and out of scope is 404 rather than 403 for the same reason
// the recovery and live-map routes made that choice: a 403 confirms the row
// exists, which is itself a disclosure.
//
// THE ROUTE GATES THE SURFACE, THE ENGINE GATES THE ACTION. Reading the queue
// needs one capability; approving a particular KIND needs whatever that kind
// declares. Putting the per-kind check in the engine means it also applies to
// any future caller that never goes through HTTP.
//
// PAYLOADS ARE NEVER ECHOED BACK RAW. A queue row carries the label, the
// magnitude and the frozen verdict. The payload itself is returned only on the
// detail route, to a caller who already holds the read capability.

import type { Express, Request, Response } from "express";
import {
  GUARDED_ACTIONS, GUARDED_ACTION_KINDS, GUARDED_ACTION_STATES, clampPolicy, defaultPolicy,
  guardedActionSpec, isGuardedActionKind, undoAvailability, undoUnavailableReason,
  type GatePolicy, type GuardedActionKind, type GuardedActionState,
} from "@shared/guardedActions";
import { can, type Capability } from "@shared/capabilities";
import type { JsonValue } from "@shared/json";
import * as store from "./guardedActionStore";
import type { GuardedActionRow } from "./guardedActionStore";
import {
  GuardedActionError, approveAction, guardedActionsEnabled, rejectAction,
  registeredKinds, submitGuardedAction, sweepExpiredActions, undoAction,
  type ActorContext,
} from "./guardedActionEngine";
import { registerGuardedActionExecutors } from "./guardedActionExecutors";
import { recordAdminAudit } from "./adminAudit";

interface Deps {
  requireAuth: any;
  requireCapability: (cap: Capability) => any;
}

export function registerGuardedActionRoutes(app: Express, deps: Deps): void {
  const { requireAuth, requireCapability } = deps;
  registerGuardedActionExecutors();

  /** The outer wall. Mounted ahead of every handler below. */
  const requireFlag = (_req: Request, res: Response, next: () => void) => {
    if (!guardedActionsEnabled()) return void res.status(404).json({ error: "Not found" });
    next();
  };

  /**
   * The organization. No cross-tenant read exists in this plane, so a super
   * admin without an org context gets 400 rather than every tenant's queue.
   */
  const requireOrg = (req: Request, res: Response): number | null => {
    const raw = (req as any).user?.tenantId;
    const id = Number.isSafeInteger(raw) && raw > 0 ? Number(raw) : null;
    if (id == null) {
      res.status(400).json({ error: "This view is scoped to one organization. Sign in as a member of one." });
      return null;
    }
    return id;
  };

  const actorOf = (req: Request, tenantId: number): ActorContext => {
    const user = (req as any).user ?? {};
    return {
      tenantId,
      userId: user.id ?? null,
      name: user.name ?? null,
      role: user.role ?? null,
    };
  };

  /** Turn an engine refusal into its status code; anything else is a 500 whose
   *  detail stays in the log. */
  const fail = (res: Response, error: any, where: string) => {
    if (error instanceof GuardedActionError) {
      return void res.status(error.status).json({ error: error.message, code: error.code ?? null });
    }
    console.error(`[guarded-actions] ${where}:`, String(error?.message ?? error).slice(0, 300));
    res.status(500).json({ error: "Something went wrong handling that action." });
  };

  /** Which kinds this caller may approve. Drives both the queue filter and the
   *  nav badge, so an approver never sees a count they cannot act on. */
  const approvableKinds = (req: Request): GuardedActionKind[] => {
    const role = (req as any).user?.role;
    return registeredKinds().filter((kind) => can(role, GUARDED_ACTIONS[kind].approveCapability));
  };

  /** The wire shape of one action. `payload` is included only where stated. */
  const present = (row: GuardedActionRow, opts: { payload?: boolean } = {}) => {
    const spec = guardedActionSpec(row.kind);
    let policy: GatePolicy;
    try {
      policy = clampPolicy({ ...JSON.parse(row.policy_snapshot_json), kind: row.kind });
    } catch {
      policy = defaultPolicy(row.kind);
    }
    const undo = undoAvailability({
      kind: row.kind,
      state: row.state,
      executedAt: row.executed_at,
      undoWindowMinutes: policy.undoWindowMinutes,
      hasInverse: !!row.inverse_json,
    });
    return {
      id: row.id,
      kind: row.kind,
      kindLabel: spec.label,
      describes: spec.describes,
      reversibility: spec.reversibility,
      state: row.state,
      magnitude: row.magnitude,
      magnitudeUnit: spec.magnitudeUnit,
      targetLabel: row.target_label,
      requestedBy: row.requested_by_name,
      requestedByUserId: row.requested_by_user_id,
      requestedAt: row.requested_at,
      requestReason: row.request_reason,
      gateOutcome: row.gate_outcome,
      gateReason: row.gate_reason,
      expiresAt: row.expires_at,
      decidedBy: row.decided_by_name,
      decidedAt: row.decided_at,
      decisionNote: row.decision_note,
      executedAt: row.executed_at,
      resultSummary: row.result_summary,
      failureReason: row.failure_reason,
      undoneAt: row.undone_at,
      undoneBy: row.undone_by_name,
      undoReason: row.undo_reason,
      undo: undo.available
        ? { available: true as const, deadline: undo.deadline }
        : { available: false as const, because: undo.because, reason: undoUnavailableReason(undo.because) },
      ...(opts.payload ? { payload: safeParse(row.payload_json) } : {}),
    };
  };

  // ── Catalogue ──────────────────────────────────────────────────────────────
  // What kinds exist, what each one promises, and what this organization has
  // configured. One call so the client never re-derives a floor or a default.

  app.get("/api/actions/catalogue", requireFlag, requireAuth, requireCapability("action.queue.read"),
    (req: Request, res: Response) => {
      const tenantId = requireOrg(req, res);
      if (tenantId == null) return;
      const role = (req as any).user?.role;
      const available = new Set(registeredKinds());
      const policies = new Map(store.listPolicies(tenantId).map((p) => [p.kind, p]));

      res.json({
        kinds: GUARDED_ACTION_KINDS.filter((kind) => available.has(kind)).map((kind) => {
          const spec = GUARDED_ACTIONS[kind];
          const policy = policies.get(kind)!;
          return {
            kind,
            label: spec.label,
            describes: spec.describes,
            floor: spec.floor,
            reversibility: spec.reversibility,
            maxUndoWindowMinutes: spec.maxUndoWindowMinutes,
            magnitudeUnit: spec.magnitudeUnit,
            canRequest: can(role, spec.requestCapability),
            canApprove: can(role, spec.approveCapability),
            policy,
          };
        }),
        states: GUARDED_ACTION_STATES,
      });
    });

  // ── Policy ─────────────────────────────────────────────────────────────────

  app.get("/api/actions/policies", requireFlag, requireAuth, requireCapability("action.policy.manage"),
    (req: Request, res: Response) => {
      const tenantId = requireOrg(req, res);
      if (tenantId == null) return;
      res.json({ policies: store.listPolicies(tenantId) });
    });

  app.put("/api/actions/policies/:kind", requireFlag, requireAuth, requireCapability("action.policy.manage"),
    (req: Request, res: Response) => {
      const tenantId = requireOrg(req, res);
      if (tenantId == null) return;
      const kind = req.params.kind;
      if (!isGuardedActionKind(kind)) return void res.status(404).json({ error: "Unknown action kind." });

      const body = req.body ?? {};
      const requested: GatePolicy = {
        kind,
        mode: body.mode,
        approvalAboveMagnitude: body.approvalAboveMagnitude ?? null,
        selfApproval: body.selfApproval === true,
        undoWindowMinutes: Number(body.undoWindowMinutes ?? 0),
        pendingExpiryMinutes: Number(body.pendingExpiryMinutes ?? 0),
      };
      // clampPolicy is where the floor is enforced. An admin who posts
      // mode:"auto" for a kind whose floor is "approval" gets "approval" back,
      // saved and echoed, rather than a 400 - the response IS the answer to
      // "what did you actually set", and the UI renders it.
      const before = store.getPolicy(tenantId, kind);
      const saved = store.savePolicy(tenantId, requested, (req as any).user?.id ?? null);

      recordAdminAudit({
        actor: (req as any).user,
        action: "guarded_action.policy_updated",
        targetType: "guarded_action_policy",
        targetId: kind,
        targetLabel: GUARDED_ACTIONS[kind].label,
        before, after: saved,
        tenantId,
      });
      res.json({ policy: saved, floor: GUARDED_ACTIONS[kind].floor });
    });

  // ── Queue and history ──────────────────────────────────────────────────────

  app.get("/api/actions/pending-count", requireFlag, requireAuth, requireCapability("action.queue.read"),
    (req: Request, res: Response) => {
      const tenantId = requireOrg(req, res);
      if (tenantId == null) return;
      // Sweeping on the badge read is deliberate: it is the most frequent call
      // in this plane, so an organization with no scheduler still never shows a
      // count that includes requests nobody can action any more.
      sweepExpiredActions(50);
      res.json({ pending: store.countPending(tenantId, approvableKinds(req)) });
    });

  app.get("/api/actions", requireFlag, requireAuth, requireCapability("action.queue.read"),
    (req: Request, res: Response) => {
      const tenantId = requireOrg(req, res);
      if (tenantId == null) return;
      sweepExpiredActions(50);

      const q = req.query as Record<string, string | undefined>;
      const states = parseList(q.state).filter((s): s is GuardedActionState =>
        (GUARDED_ACTION_STATES as readonly string[]).includes(s));
      const kinds = parseList(q.kind).filter(isGuardedActionKind);

      const { rows, total } = store.listActions({
        tenantId,
        states: states.length ? states : undefined,
        kinds: kinds.length ? kinds : undefined,
        requestedByUserId: q.mine === "1" ? ((req as any).user?.id ?? -1) : undefined,
        limit: Number(q.limit ?? 50),
        offset: Number(q.offset ?? 0),
        order: q.order === "oldest" ? "oldest" : "newest",
      });
      res.json({ actions: rows.map((r) => present(r)), total });
    });

  app.get("/api/actions/pending", requireFlag, requireAuth, requireCapability("action.queue.read"),
    (req: Request, res: Response) => {
      const tenantId = requireOrg(req, res);
      if (tenantId == null) return;
      sweepExpiredActions(50);

      const kinds = approvableKinds(req);
      if (!kinds.length) return void res.json({ actions: [], total: 0 });
      // Oldest first: the request that has waited longest is the one at risk of
      // expiring, so it belongs at the top rather than buried under new ones.
      const { rows, total } = store.listActions({
        tenantId, states: ["pending"], kinds, order: "oldest",
        limit: Number((req.query as any).limit ?? 100),
      });
      res.json({ actions: rows.map((r) => present(r)), total });
    });

  app.get("/api/actions/:id", requireFlag, requireAuth, requireCapability("action.queue.read"),
    (req: Request, res: Response) => {
      const tenantId = requireOrg(req, res);
      if (tenantId == null) return;
      const id = Number(req.params.id);
      const row = Number.isSafeInteger(id) ? store.getAction(tenantId, id) : null;
      if (!row) return void res.status(404).json({ error: "That request does not exist." });

      res.json({
        action: present(row, { payload: true }),
        events: store.listEvents(tenantId, row.id).map((e) => ({
          type: e.event_type,
          at: e.at,
          actor: e.actor_name,
          note: e.note,
          detail: e.detail_json ? safeParse(e.detail_json) : null,
        })),
      });
    });

  // ── Submit ─────────────────────────────────────────────────────────────────
  //
  // Gated on requireAuth alone: the per-kind request capability is checked
  // inside the engine, so the same rule applies to any future non-HTTP caller.

  app.post("/api/actions", requireFlag, requireAuth, (req: Request, res: Response) => {
    const tenantId = requireOrg(req, res);
    if (tenantId == null) return;
    const body = req.body ?? {};
    if (!isGuardedActionKind(body.kind)) {
      return void res.status(400).json({ error: "Unknown action kind." });
    }
    try {
      const result = submitGuardedAction({
        kind: body.kind,
        payload: body.payload,
        actor: actorOf(req, tenantId),
        reason: typeof body.reason === "string" ? body.reason.slice(0, 500) : null,
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey.slice(0, 120) : null,
      });
      if (result.status === "passthrough") {
        // Unreachable behind requireFlag, and worth answering honestly if the
        // flag is ever flipped mid-request rather than pretending it executed.
        return void res.status(503).json({ error: "The action gate is not enabled." });
      }
      // 202 for a queued request: accepted, not yet done. The client renders a
      // different confirmation for each, so the status code carries meaning.
      res.status(result.status === "pending" ? 202 : 200).json({
        status: result.status,
        action: present(result.action, { payload: true }),
      });
    } catch (error) {
      fail(res, error, "submit");
    }
  });

  // ── Decide ─────────────────────────────────────────────────────────────────

  const decide = (verb: "approve" | "reject") => (req: Request, res: Response) => {
    const tenantId = requireOrg(req, res);
    if (tenantId == null) return;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return void res.status(404).json({ error: "That request does not exist." });
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : null;
    try {
      const fn = verb === "approve" ? approveAction : rejectAction;
      res.json({ action: present(fn(id, actorOf(req, tenantId), note), { payload: true }) });
    } catch (error) {
      fail(res, error, verb);
    }
  };

  app.post("/api/actions/:id/approve", requireFlag, requireAuth, requireCapability("action.queue.read"), decide("approve"));
  app.post("/api/actions/:id/reject", requireFlag, requireAuth, requireCapability("action.queue.read"), decide("reject"));

  app.post("/api/actions/:id/undo", requireFlag, requireAuth, requireCapability("action.queue.read"),
    (req: Request, res: Response) => {
      const tenantId = requireOrg(req, res);
      if (tenantId == null) return;
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id)) return void res.status(404).json({ error: "That request does not exist." });
      const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null;
      try {
        res.json({ action: present(undoAction(id, actorOf(req, tenantId), reason), { payload: true }) });
      } catch (error) {
        fail(res, error, "undo");
      }
    });
}

// ── Small helpers ────────────────────────────────────────────────────────────

function parseList(value: string | undefined): string[] {
  return typeof value === "string" && value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function safeParse(json: string): JsonValue {
  try { return JSON.parse(json); } catch { return null; }
}
