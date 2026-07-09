// ── Weekly Commission internal API — RBAC-gated, tenant-scoped ────────────────
// Registered from routes.ts (which injects the shared requireAuth /
// requireCapability middleware so authorization is identical to the rest of the
// app). Every handler derives tenantId from the session user — never the body —
// and reads are scoped by the caller's commission.read.{self,team,all} grant.
// Isolated from the legacy commission/MLM surfaces.

import type { Express, Request, Response, NextFunction } from "express";
import { can } from "@shared/capabilities";
import { storage } from "./storage";
import * as svc from "./commissionService";

type Mw = (req: Request, res: Response, next: NextFunction) => void;
interface Deps { requireAuth: Mw; requireCapability: (cap: any) => Mw; }

// Read scope from capabilities (fail-closed): all → whole tenant; team → self +
// direct reports; self → own team-member only. `null` means "no rep filter".
export function readScope(user: any): { repIds: number[] | null } {
  if (can(user?.role, "commission.read.all")) return { repIds: null };
  if (can(user?.role, "commission.read.team")) {
    const reports = storage.getTeamMembers(user?.tenantId ?? undefined)
      .filter((m: any) => m.reportsToId === user?.teamMemberId).map((m: any) => m.id);
    const ids = user?.teamMemberId ? [user.teamMemberId, ...reports] : reports;
    return { repIds: [...new Set(ids)] };
  }
  return { repIds: user?.teamMemberId ? [user.teamMemberId] : [] };
}

// May the caller read this rep's data? (used when a specific repId is requested)
export function canReadRep(user: any, repId: number): boolean {
  const { repIds } = readScope(user);
  return repIds === null || repIds.includes(repId);
}

// Map a thrown CommissionError to its HTTP status; everything else is a 500.
function fail(res: Response, e: unknown) {
  if (e instanceof svc.CommissionError) return res.status(e.httpStatus).json({ error: e.message, code: e.code });
  const msg = e instanceof Error ? e.message : "Internal error";
  return res.status(500).json({ error: msg });
}

const parseWeekRef = (v: any): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function registerCommissionRoutes(app: Express, deps: Deps) {
  // requireCapability wraps requireAuth internally, so we gate every route on a
  // capability (auth is implied). requireAuth is accepted for API symmetry.
  const { requireCapability } = deps;
  const uid = (req: Request) => (req as any).user?.id ?? null;
  const tid = (req: Request) => (req as any).user?.tenantId as number;
  const rid = (req: Request) => (req.headers["x-request-id"] as string) || undefined;

  // ── Org config ──────────────────────────────────────────────────────────────
  app.get("/api/commission/config", requireCapability("commission.read.team"), (req, res) => {
    try { res.json(svc.loadOrgConfig(tid(req))); } catch (e) { fail(res, e); }
  });
  app.patch("/api/commission/config", requireCapability("settings.manage.org"), (req, res) => {
    try { res.json(svc.updateOrgConfig(tid(req), uid(req), req.body || {})); } catch (e) { fail(res, e); }
  });

  // ── Plans / versions / activation ─────────────────────────────────────────────
  app.get("/api/commission/plans", requireCapability("commission.structure.manage"), (req, res) => {
    try { res.json(svc.listPlans(tid(req))); } catch (e) { fail(res, e); }
  });
  app.post("/api/commission/plans", requireCapability("commission.structure.manage"), (req, res) => {
    try { res.status(201).json(svc.createPlan(tid(req), uid(req), req.body || {})); } catch (e) { fail(res, e); }
  });
  app.post("/api/commission/plans/:id/versions", requireCapability("commission.structure.manage"), (req, res) => {
    try { res.status(201).json(svc.addPlanVersion(tid(req), uid(req), Number(req.params.id), req.body || {})); } catch (e) { fail(res, e); }
  });
  app.post("/api/commission/plans/:id/activate", requireCapability("commission.structure.manage"), (req, res) => {
    try { res.json(svc.activatePlan(tid(req), uid(req), Number(req.params.id))); } catch (e) { fail(res, e); }
  });

  // ── Rep assignments (overlap-checked) ─────────────────────────────────────────
  app.post("/api/commission/assignments", requireCapability("commission.structure.manage"), (req, res) => {
    try { res.status(201).json(svc.assignPlanVersionToRep(tid(req), uid(req), req.body || {})); } catch (e) { fail(res, e); }
  });

  // High-level "set this rep's commission structure" (flat vs tiered). Replaces
  // the rep's current structure by default (closeExisting) — this is the control
  // behind onboarding + the Team page's "change commission" action.
  app.post("/api/commission/assign-structure", requireCapability("commission.structure.manage"), (req, res) => {
    const { repId, structure, flatRateCents, flatRateDollars, commissionPlanVersionId, effectiveFrom, closeExisting } = req.body || {};
    if (!repId || (structure !== "FLAT" && structure !== "TIERED")) {
      return res.status(400).json({ error: "repId and structure (FLAT|TIERED) are required" });
    }
    const rate = flatRateCents != null ? Number(flatRateCents)
      : flatRateDollars != null ? Math.round(Number(flatRateDollars) * 100)
      : undefined;
    try {
      const out = svc.assignStructureToRep(tid(req), uid(req), {
        repId: Number(repId), structure, flatRateCents: rate,
        commissionPlanVersionId: commissionPlanVersionId ?? null,
        effectiveFrom: effectiveFrom || undefined,
        closeExisting: closeExisting !== false, // default true (re-assign replaces)
      });
      res.status(201).json(out);
    } catch (e) { fail(res, e); }
  });

  // Options for the structure picker (default tiers preview, suggested flat rate,
  // existing custom plans).
  app.get("/api/commission/assignable-options", requireCapability("commission.structure.manage"), (req, res) => {
    try { res.json(svc.getAssignablePlanOptions(tid(req))); } catch (e) { fail(res, e); }
  });

  // A rep's current effective structure (for Team cards / rep view). Scoped read.
  app.get("/api/commission/reps/:repId/structure", requireCapability("commission.read.team"), (req, res) => {
    const repId = Number(req.params.repId);
    if (!canReadRep((req as any).user, repId)) return res.status(403).json({ error: "Out of scope", code: "UNAUTHORIZED_COMMISSION_ACTION" });
    try { res.json(svc.getCurrentStructureForRep(tid(req), repId) || { structure: null }); } catch (e) { fail(res, e); }
  });
  app.get("/api/commission/reps/:repId/assignments", requireCapability("commission.read.team"), (req, res) => {
    const repId = Number(req.params.repId);
    if (!canReadRep((req as any).user, repId)) return res.status(403).json({ error: "Out of scope", code: "UNAUTHORIZED_COMMISSION_ACTION" });
    try { res.json(svc.listRepAssignments(tid(req), repId)); } catch (e) { fail(res, e); }
  });

  // ── Commissionable sales (idempotent ingest + lifecycle) ──────────────────────
  app.post("/api/commission/sales", requireCapability("commission.structure.manage"), (req, res) => {
    try { res.status(201).json(svc.upsertSale(tid(req), uid(req), req.body || {})); } catch (e) { fail(res, e); }
  });
  app.post("/api/commission/sales/:externalId/transition", requireCapability("commission.structure.manage"), (req, res) => {
    const { action, at, reason } = req.body || {};
    try { res.json(svc.transitionSale(tid(req), uid(req), String(req.params.externalId), action, { at, reason })); } catch (e) { fail(res, e); }
  });

  // ── Statements — the calculation surface ──────────────────────────────────────
  app.post("/api/commission/statements/recalculate", requireCapability("commission.read.team"), (req, res) => {
    const repId = Number(req.body?.repId);
    const weekReference = parseWeekRef(req.body?.week) ?? parseWeekRef(req.body?.weekReference);
    if (!repId || !weekReference) return res.status(400).json({ error: "repId and week are required" });
    if (!canReadRep((req as any).user, repId)) return res.status(403).json({ error: "Out of scope", code: "UNAUTHORIZED_COMMISSION_ACTION" });
    try {
      const out = svc.calculateOrRecalculateStatement({ tenantId: tid(req), repId, weekReference, actorId: uid(req), requestId: rid(req) });
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  // Rep-facing "my commission this week" — the caller computes/reads their OWN
  // current-week statement (self-scoped write is fine and keeps it fresh). Falls
  // back to read-only on a locked week, and an empty state when unassigned.
  app.get("/api/commission/statements/me/current", requireCapability("commission.read.self"), (req, res) => {
    const user = (req as any).user;
    const repId = user?.teamMemberId;
    if (!repId) return res.json({ statement: null, structure: null, noRepProfile: true });
    const now = new Date();
    try {
      const out = svc.calculateOrRecalculateStatement({ tenantId: tid(req), repId, weekReference: now, actorId: uid(req), requestId: rid(req) });
      res.json({ ...out, structure: svc.getCurrentStructureForRep(tid(req), repId) });
    } catch (e) {
      if (e instanceof svc.CommissionError && e.code === "STATEMENT_LOCKED") {
        const { statement, bounds } = svc.getStatementForWeek(tid(req), repId, now);
        return res.json({ statement, bounds, structure: svc.getCurrentStructureForRep(tid(req), repId), locked: true });
      }
      if (e instanceof svc.CommissionError && e.code === "NO_EFFECTIVE_PLAN_ASSIGNMENT") {
        return res.json({ statement: null, structure: null, noPlan: true });
      }
      fail(res, e);
    }
  });

  app.get("/api/commission/statements", requireCapability("commission.read.self"), (req, res) => {
    const scope = readScope((req as any).user);
    let repIds = scope.repIds;
    const requested = req.query.repId ? Number(req.query.repId) : undefined;
    if (requested != null && !Number.isNaN(requested)) {
      if (!canReadRep((req as any).user, requested)) return res.status(403).json({ error: "Out of scope", code: "UNAUTHORIZED_COMMISSION_ACTION" });
      repIds = [requested];
    }
    try { res.json(svc.listStatements(tid(req), { repIds, weekStartUtc: parseWeekRef(req.query.weekStartUtc) })); } catch (e) { fail(res, e); }
  });

  app.get("/api/commission/statements/:id", requireCapability("commission.read.self"), (req, res) => {
    try {
      const stmt = svc.getStatementById(tid(req), Number(req.params.id));
      if (!stmt) return res.status(404).json({ error: "Not found" });
      if (!canReadRep((req as any).user, stmt.rep_id)) return res.status(403).json({ error: "Out of scope", code: "UNAUTHORIZED_COMMISSION_ACTION" });
      res.json({ statement: stmt, adjustments: svc.getStatementAdjustments(tid(req), stmt.id) });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/commission/statements/:id/transition", requireCapability("commission.read.all"), (req, res) => {
    const { action } = req.body || {};
    try { res.json(svc.transitionStatement(tid(req), uid(req), Number(req.params.id), action)); } catch (e) { fail(res, e); }
  });

  // ── Adjustments (create = structure.manage; approve = read.all, i.e. mgr/admin) ─
  app.post("/api/commission/adjustments", requireCapability("commission.structure.manage"), (req, res) => {
    try { res.status(201).json(svc.createAdjustment(tid(req), uid(req), req.body || {})); } catch (e) { fail(res, e); }
  });
  app.post("/api/commission/adjustments/:id/decide", requireCapability("commission.read.all"), (req, res) => {
    const { decision } = req.body || {};
    if (decision !== "APPROVE" && decision !== "REJECT") return res.status(400).json({ error: "decision must be APPROVE or REJECT" });
    try { res.json(svc.decideAdjustment(tid(req), uid(req), Number(req.params.id), decision)); } catch (e) { fail(res, e); }
  });
}
