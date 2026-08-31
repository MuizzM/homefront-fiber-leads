// ── Operations command center endpoints ───────────────────────────────────────
// Read plane for the manager triage surface. Every mutation stays on the
// existing gated endpoints (assign, bulk-assign, knock, territory routes) -
// these routes only answer "what needs attention" and record dismissals.
//
// Gate: dashboard.read.team (team_lead+), the same capability the team
// metrics read; rows resolve through leadVisibilityScope so a team lead sees
// exactly the work they could act on and a manager sees the tenant.
import type { Express, NextFunction, Request, Response } from "express";
import type { Capability } from "@shared/capabilities";
import {
  clampStaleDays, clampWindowHours, dismissOpsRow, opsOverview, opsQueueRows,
  opsWorkload, OPS_QUEUES, undismissOpsRow, type OpsScope,
} from "./opsQueues";
import { storage } from "./storage";

interface Deps {
  requireCapability: (cap: Capability) => (req: Request, res: Response, next: NextFunction) => void;
  /** routes.ts's leadVisibilityScope - the assignment surfaces' scope rule. */
  leadVisibilityScope: (user: any) => number | number[] | undefined;
}

export function registerOpsRoutes(app: Express, deps: Deps) {
  const { requireCapability, leadVisibilityScope } = deps;

  function scopeOf(req: Request): OpsScope {
    const user = (req as any).user;
    const raw = leadVisibilityScope(user);
    return {
      tenantId: user?.tenantId ?? null,
      repIds: raw === undefined ? undefined : Array.isArray(raw) ? raw : [raw],
    };
  }

  function paramsOf(req: Request) {
    return {
      windowHours: clampWindowHours(req.query.window ?? 48),
      staleDays: clampStaleDays(req.query.stale ?? 14),
      nowMs: Date.now(),
    };
  }

  app.get("/api/ops/overview", requireCapability("dashboard.read.team"), (req, res) => {
    res.json({ queues: opsOverview(scopeOf(req), paramsOf(req)) });
  });

  app.get("/api/ops/workload", requireCapability("dashboard.read.team"), (req, res) => {
    const rows = opsWorkload(scopeOf(req), paramsOf(req));
    res.json({
      rule: "Active leads, unworked assignments, and overdue follow-ups per rep in your scope - a distribution to balance by eye, not a capacity score (no per-rep lead capacity is configured anywhere).",
      rows,
    });
  });

  app.get("/api/ops/queue/:key", requireCapability("dashboard.read.team"), (req, res) => {
    const result = opsQueueRows(String(req.params.key), scopeOf(req), paramsOf(req));
    if (!result) return res.status(404).json({ error: "No such queue", code: "UNKNOWN_QUEUE" });
    res.json(result);
  });

  // Dismiss-with-reason: "this row is not actionable, and here is why". The
  // reason is required and audited; the row returns automatically when the
  // dismissal lapses (default 30 days, max 90).
  app.post("/api/ops/dismiss", requireCapability("dashboard.read.team"), (req, res) => {
    const user = (req as any).user;
    const queueKey = String(req.body?.queue ?? "");
    const def = OPS_QUEUES[queueKey];
    if (!def) return res.status(400).json({ error: "No such queue", code: "UNKNOWN_QUEUE" });
    if (!def.dismissible) return res.status(400).json({ error: "This queue's rows cannot be dismissed", code: "NOT_DISMISSIBLE" });
    const scope = scopeOf(req);
    if (def.managerOnly && scope.repIds !== undefined) {
      return res.status(403).json({ error: "Forbidden", code: "MANAGER_ONLY_QUEUE" });
    }
    const entityId = Number(req.body?.entityId);
    if (!Number.isInteger(entityId) || entityId <= 0) {
      return res.status(400).json({ error: "entityId must be a positive integer", code: "BAD_ENTITY" });
    }
    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) return res.status(400).json({ error: "A reason is required - dismissals are audited", code: "REASON_REQUIRED" });
    const days = Math.min(90, Math.max(1, Math.trunc(Number(req.body?.days)) || 30));

    // A lead-entity dismissal must reference a lead the caller can see -
    // otherwise a dismissal id-space walk would confirm cross-tenant ids.
    if (def.entityKind === "lead") {
      const lead = storage.getLeadById(entityId, user?.tenantId ?? undefined);
      if (!lead) return res.status(404).json({ error: "Not found" });
    }

    dismissOpsRow({
      tenantId: user?.tenantId ?? null,
      queueKey,
      entityKind: def.entityKind,
      entityId,
      reason: reason.slice(0, 300),
      userId: user.id,
      days,
      nowMs: Date.now(),
    });
    storage.logActivity(user.id, "ops.queue.dismissed", def.entityKind, entityId,
      { queue: queueKey, reason: reason.slice(0, 300), days }, req.ip);
    res.json({ ok: true, queue: queueKey, entityId, days });
  });

  app.post("/api/ops/undismiss", requireCapability("dashboard.read.team"), (req, res) => {
    const user = (req as any).user;
    const queueKey = String(req.body?.queue ?? "");
    const def = OPS_QUEUES[queueKey];
    if (!def) return res.status(400).json({ error: "No such queue", code: "UNKNOWN_QUEUE" });
    const entityId = Number(req.body?.entityId);
    if (!Number.isInteger(entityId) || entityId <= 0) {
      return res.status(400).json({ error: "entityId must be a positive integer", code: "BAD_ENTITY" });
    }
    const removed = undismissOpsRow({
      tenantId: user?.tenantId ?? null,
      queueKey,
      entityKind: def.entityKind,
      entityId,
    });
    if (removed) {
      storage.logActivity(user.id, "ops.queue.restored", def.entityKind, entityId, { queue: queueKey }, req.ip);
    }
    res.json({ ok: true, restored: removed });
  });
}
