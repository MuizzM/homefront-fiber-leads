// ── Weekly Commission internal API — RBAC-gated, tenant-scoped ────────────────
// Registered from routes.ts (which injects the shared requireAuth /
// requireCapability middleware so authorization is identical to the rest of the
// app). Every handler derives tenantId from the session user — never the body —
// and reads are scoped by the caller's commission.read.{self,team,all} grant.
// Isolated from the legacy commission/MLM surfaces.

import type { Express, Request, Response, NextFunction } from "express";
import { can } from "@shared/capabilities";
import { branchOwnerOf, downlineOf } from "@shared/teamHierarchy";
import { storage } from "./storage";
import * as svc from "./commissionService";
import * as reserve from "./reserveService";

import { hourlyBlockForStatement, sumWeekSpiffsByRep } from "./hourlyPay";
import { computeHoldback } from "@shared/commissionReserve";
import { buildStatementDocumentFor } from "./commissionStatementDoc";
import { renderCommissionStatementPdf } from "./commissionStatementPdf";
import { reconcile } from "./commissionReconciliation";
import * as queueOps from "./eventQueueOps";
import { cursorFor, backlogFor } from "./domainEventStore";

type Mw = (req: Request, res: Response, next: NextFunction) => void;
interface Deps { requireAuth: Mw; requireCapability: (cap: any) => Mw; }

// Read scope from capabilities (fail-closed): all → whole tenant; downline →
// self + the FULL reports-to subtree; team → self + direct reports; self → own
// team-member only. `null` means "no rep filter".
export function readScope(user: any): { repIds: number[] | null } {
  if (can(user?.role, "commission.read.all")) return { repIds: null };
  // Downline before team, deliberately: team_lead holds BOTH grants, and full
  // depth supersedes one level — the team branch now only serves roles that
  // carry read.team without read.downline.
  if (can(user?.role, "commission.read.downline")) {
    const members = storage.getTeamMembers(user?.tenantId ?? undefined);
    const ids = user?.teamMemberId ? [user.teamMemberId, ...downlineOf(user.teamMemberId, members as any)] : [];
    return { repIds: [...new Set(ids)] };
  }
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

// Map a thrown CommissionError / ReserveError to its HTTP status; everything
// else is a 500. Both carry {code, httpStatus} so the mapping is identical.
function fail(res: Response, e: unknown) {
  if (e instanceof svc.CommissionError) return res.status(e.httpStatus).json({ error: e.message, code: e.code });
  if (e instanceof reserve.ReserveError) return res.status(e.httpStatus).json({ error: e.message, code: e.code });
  const msg = e instanceof Error ? e.message : "Internal error";
  return res.status(500).json({ error: msg });
}

// Normalize a ?week= param. A DATE-ONLY string (YYYY-MM-DD) is anchored to NOON
// UTC so it lands squarely inside the intended org week — a bare "2026-07-06"
// parses as UTC-midnight, which in America/New_York is the *previous* Sunday
// evening and would silently resolve to the prior commission week.
export const parseWeekRef = (v: any): string | undefined => {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const s = v.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00.000Z` : s;
};

// Shape-check the two per-rep chargeback-reserve overrides off a request body.
// Tri-state on purpose: a field ABSENT means "leave it alone", an explicit
// `null` means "clear the override, inherit the org default", and a number is
// the override itself. Whole numbers only — money is integer cents and the
// percent is whole, so a float here is a client bug, not something to round
// into a rep's pay. `reserveCapDollars` is accepted as a convenience for the
// editor and converted ONCE, here, at the boundary.
function parseReservePatch(body: any): { patch: { reservePercent?: number | null; reserveCapCents?: number | null }; error?: string } {
  const patch: { reservePercent?: number | null; reserveCapCents?: number | null } = {};
  if (body.reservePercent !== undefined) {
    if (body.reservePercent === null) patch.reservePercent = null;
    else if (!Number.isInteger(body.reservePercent) || body.reservePercent < 0 || body.reservePercent > 100) {
      return { patch, error: "reservePercent must be a whole number from 0 to 100, or null to inherit the org default." };
    } else patch.reservePercent = body.reservePercent;
  }
  if (body.reserveCapCents !== undefined) {
    if (body.reserveCapCents === null) patch.reserveCapCents = null;
    else if (!Number.isInteger(body.reserveCapCents) || body.reserveCapCents < 0) {
      return { patch, error: "reserveCapCents must be a whole number of cents (0 = uncapped), or null to inherit the org default." };
    } else patch.reserveCapCents = body.reserveCapCents;
  } else if (body.reserveCapDollars !== undefined) {
    if (body.reserveCapDollars === null) patch.reserveCapCents = null;
    else if (typeof body.reserveCapDollars !== "number" || !Number.isFinite(body.reserveCapDollars) || body.reserveCapDollars < 0) {
      return { patch, error: "reserveCapDollars must be a non-negative number, or null to inherit the org default." };
    } else patch.reserveCapCents = Math.round(body.reserveCapDollars * 100);
  }
  return { patch };
}

// CSV formula-injection guard: a leading = + - @ (or tab/CR) makes a cell
// executable in Excel/Sheets. Rep names come from the PUBLIC application form,
// so neutralize by prefixing a single quote, then quote + escape.
function csvCell(v: string | number): string {
  const s = String(v ?? "");
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function registerCommissionRoutes(app: Express, deps: Deps) {
  // requireCapability wraps requireAuth internally, so we gate every route on a
  // capability (auth is implied). requireAuth is accepted for API symmetry.
  const { requireCapability } = deps;
  const uid = (req: Request) => (req as any).user?.id ?? null;
  const tid = (req: Request) => (req as any).user?.tenantId as number;
  const rid = (req: Request) => ((req as any).id as string | undefined);

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

  // Branch guard for MONEY WRITES. A manager holds commission.read.all, so
  // readScope hands them `repIds: null` — every rep in the tenant — which makes
  // the read test below a no-op for exactly the role that also holds
  // sales.write / adjustments.write / statements.write. Before this existed,
  // manager A could book a sale, file an adjustment, or recalculate a statement
  // against manager B's rep; the self-deal guard did not catch it, because it
  // only blocks writing your OWN commission, never a peer's rep.
  //
  // This is the same rule the roster routes and PATCH /reps/:repId/override-rates
  // already enforce (commissionOverrideRoutes.ts) — that route's comment named
  // this hole. Unowned members fail OPEN by branchOwnerOf's deliberate design, so
  // orphans and new hires stay writable; admins arbitrate between branches and
  // pass through. Applied to WRITES only: a manager's org-wide READ is oversight
  // they are meant to have.
  const denyOutOfBranch = (req: Request, res: Response, repId: number): boolean => {
    const actor = (req as any).user;
    if (actor?.role !== "manager" || actor?.teamMemberId == null) return false;
    const owner = branchOwnerOf(repId, storage.getTeamMembers(tid(req)) as any[]);
    if (owner == null || owner === actor.teamMemberId) return false;
    res.status(403).json({
      error: "That member belongs to another manager's team - ask an admin to transfer them",
      code: "OUT_OF_BRANCH",
    });
    return true;
  };

  // Write-scope guard: a structure.manage holder (team_lead+) may only WRITE to
  // reps they can READ. Without this a team_lead could fabricate sales / set
  // rates for reps outside their team (write-scope exceeding read-scope).
  const denyOutOfScope = (req: Request, res: Response, repId: number): boolean => {
    if (!repId || Number.isNaN(repId) || !canReadRep((req as any).user, repId)) {
      res.status(403).json({ error: "Out of scope", code: "UNAUTHORIZED_COMMISSION_ACTION" });
      return true;
    }
    // Self-dealing guard: your own rep record is inside your read scope (so you
    // can SEE your commission), but you may never WRITE your own commission —
    // set a structure/plan, book a sale, or transition one — for yourself.
    // Someone above you does that. Applies to every commission WRITE route,
    // which all funnel through this helper. (Reads use canReadRep directly and
    // are unaffected; the onboarding flow calls the service, not this route.)
    const user = (req as any).user;
    if (user?.teamMemberId != null && Number(repId) === Number(user.teamMemberId)) {
      res.status(403).json({ error: "You cannot set your own commission", code: "COMMISSION_SELF_DEAL" });
      return true;
    }
    return denyOutOfBranch(req, res, repId);
  };

  // ── Rep assignments (overlap-checked) ─────────────────────────────────────────
  app.post("/api/commission/assignments", requireCapability("commission.structure.manage"), (req, res) => {
    if (denyOutOfScope(req, res, Number(req.body?.repId))) return;
    try { res.status(201).json(svc.assignPlanVersionToRep(tid(req), uid(req), req.body || {})); } catch (e) { fail(res, e); }
  });

  // High-level "set this rep's commission structure" (flat vs tiered). Replaces
  // the rep's current structure by default (closeExisting) — this is the control
  // behind onboarding + the Team page's "change commission" action.
  app.post("/api/commission/assign-structure", requireCapability("commission.structure.manage"), (req, res) => {
    const { repId, structure, flatRateCents, flatRateDollars, commissionPlanVersionId, effectiveFrom, closeExisting, tiers } = req.body || {};
    if (!repId || (structure !== "FLAT" && structure !== "TIERED")) {
      return res.status(400).json({ error: "repId and structure (FLAT|TIERED) are required" });
    }
    if (denyOutOfScope(req, res, Number(repId))) return;
    const rate = flatRateCents != null ? Number(flatRateCents)
      : flatRateDollars != null ? Math.round(Number(flatRateDollars) * 100)
      : undefined;
    // The edited ladder, shape-checked field by field before it can reach the
    // money engine. Only the four meaningful fields cross the boundary — a body
    // is not allowed to smuggle extra keys into a plan version — and every
    // number must already be an integer: rounding client mistakes here would
    // book a rate the manager never typed. Deep validation (tiling, open final
    // band, positive rates) happens in the service via the SAME shared
    // validateTiers module the client editor runs, so the two can never drift.
    let parsedTiers: any[] | undefined;
    if (structure === "TIERED" && tiers != null) {
      if (!Array.isArray(tiers) || tiers.length === 0 || tiers.length > 20) {
        return res.status(400).json({ error: "tiers must be a non-empty array (max 20)", code: "INVALID_TIER_CONFIGURATION" });
      }
      parsedTiers = [];
      for (const [i, t] of tiers.entries()) {
        const min = (t as any)?.minimumSales, max = (t as any)?.maximumSales ?? null, rc = (t as any)?.rateCents;
        if (!Number.isInteger(min) || (max !== null && !Number.isInteger(max)) || !Number.isInteger(rc)) {
          return res.status(400).json({ error: `Tier ${i + 1}: minimumSales/maximumSales/rateCents must be whole numbers`, code: "INVALID_TIER_CONFIGURATION" });
        }
        parsedTiers.push({ position: i, minimumSales: min, maximumSales: max, rateCents: rc, label: typeof (t as any)?.label === "string" ? (t as any).label.slice(0, 40) : "" });
      }
    }
    // Chargeback-reserve overrides ride along with the comp change. Both are
    // OPTIONAL: omit → leave as-is; explicit null → clear back to the org
    // default. Integer cents only — the service re-validates the range.
    const reservePatch = parseReservePatch(req.body || {});
    if (reservePatch.error) return res.status(400).json({ error: reservePatch.error, code: "RESERVE_INVALID_CONFIG" });
    try {
      const out = svc.assignStructureToRep(tid(req), uid(req), {
        repId: Number(repId), structure, flatRateCents: rate,
        commissionPlanVersionId: commissionPlanVersionId ?? null,
        effectiveFrom: effectiveFrom || undefined,
        closeExisting: closeExisting !== false, // default true (re-assign replaces)
        tiers: parsedTiers,
        ...reservePatch.patch,
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

  // ══ CHARGEBACK RESERVE ══════════════════════════════════════════════════════
  // Per the owner's explicit decisions: a chargeback is applied MANUALLY by an
  // admin (the reserve never auto-draws when a sale reverses) and a release is
  // MANUAL (nothing auto-releases on a timer or on departure).
  //
  // CAPABILITIES, deliberately split:
  //   • read   → commission.read.all  (manager oversight may SEE a rep's reserve)
  //   • config → commission.structure.manage  (the existing money-config cap)
  //   • move   → payouts.pay          (admin/owner ONLY — a drawdown or release
  //                                    moves real money, and a manager's
  //                                    oversight read must never authorize it)
  // Every route is tenant-scoped by the session's tenantId; a rep from another
  // tenant resolves to 404, never 403 (repo convention — no id-space probing).

  // Admin/manager read: summary + append-only ledger history for one rep.
  app.get("/api/commission/reps/:repId/reserve", requireCapability("commission.read.all"), (req, res) => {
    const repId = Number(req.params.repId);
    if (!canReadRep((req as any).user, repId)) return res.status(403).json({ error: "Out of scope", code: "UNAUTHORIZED_COMMISSION_ACTION" });
    try {
      res.json(reserve.getReserveSummary(tid(req), repId, { actorId: uid(req), historyLimit: 200 }));
    } catch (e) { fail(res, e); }
  });

  // Set a rep's reserve percent / cap on its own (the comp editor also sends
  // these on assign-structure). Same money-config capability as every other
  // rate change, plus the write-scope + self-dealing guard.
  app.patch("/api/commission/reps/:repId/reserve-config", requireCapability("commission.structure.manage"), (req, res) => {
    const repId = Number(req.params.repId);
    if (denyOutOfScope(req, res, repId)) return;
    const parsed = parseReservePatch(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error, code: "RESERVE_INVALID_CONFIG" });
    if (Object.keys(parsed.patch).length === 0) {
      return res.status(400).json({ error: "Nothing to update - send reservePercent and/or reserveCapCents.", code: "RESERVE_INVALID_CONFIG" });
    }
    try { res.json(reserve.setRepReserveConfig(tid(req), repId, uid(req), parsed.patch)); } catch (e) { fail(res, e); }
  });

  // Apply a chargeback AGAINST the reserve. Bounded so it can never take the
  // balance below zero (400 if it would) — the guard and the append happen in
  // one transaction inside the service, so two admins cannot race past it.
  app.post("/api/commission/reps/:repId/reserve/drawdown", requireCapability("payouts.pay"), (req, res) => {
    const repId = Number(req.params.repId);
    const { amountCents, reason } = req.body || {};
    try {
      res.status(201).json(reserve.applyDrawdown({
        tenantId: tid(req), repId, amountCents, reason, actorId: uid(req),
      }));
    } catch (e) { fail(res, e); }
  });

  // Return reserve to the rep. `amountCents: null` (or omitted) releases the
  // FULL balance. Same non-negative guard; a reason is always required.
  app.post("/api/commission/reps/:repId/reserve/release", requireCapability("payouts.pay"), (req, res) => {
    const repId = Number(req.params.repId);
    const { amountCents, reason } = req.body || {};
    try {
      res.status(201).json(reserve.releaseReserve({
        tenantId: tid(req), repId,
        amountCents: amountCents === undefined ? null : amountCents,
        reason, actorId: uid(req),
      }));
    } catch (e) { fail(res, e); }
  });

  // ── Rep-facing, SELF-SCOPED ────────────────────────────────────────────────
  // The repId is taken from the SESSION, never from the request, so a rep can
  // only ever read their own reserve — there is no parameter to tamper with.
  app.get("/api/me/reserve", requireCapability("commission.read.self"), (req, res) => {
    const repId = (req as any).user?.teamMemberId;
    if (!repId) return res.json({ noRepProfile: true });
    try {
      res.json(reserve.getReserveSummary(tid(req), Number(repId), { actorId: uid(req), historyLimit: 50 }));
    } catch (e) { fail(res, e); }
  });

  // ── Commissionable sales (idempotent ingest + lifecycle) ──────────────────────
  // Booking or transitioning a sale IS booking money — gated on the dedicated
  // sales.write cap (manager+), never on rate-config (structure.manage) which a
  // team_lead holds and could otherwise use to fabricate QUALIFIED sales.
  app.post("/api/commission/sales", requireCapability("commission.sales.write"), (req, res) => {
    // Guard the sale's CURRENT owner as well as the incoming one. The upsert's
    // ON CONFLICT rewrites rep_id, so checking only the destination let a
    // manager re-point a sale that belongs to a PEER's rep into their own
    // branch — the transfer direction, as opposed to the direct-write direction
    // the incoming check already closed. The transition route below has always
    // done this; this route did not.
    const priorSale = svc.getSaleByExternalId(tid(req), String(req.body?.externalId ?? ""));
    if (priorSale && denyOutOfScope(req, res, priorSale.rep_id)) return;
    if (denyOutOfScope(req, res, Number(req.body?.repId))) return;
    // serverReceivedAt is stamped HERE and deliberately spread AFTER the body so a
    // caller-supplied receipt time can never widen its own correction window. The
    // clamp, the QUALIFIED-sale freeze, and the locked-week refusal all live in
    // upsertSale itself, so this route cannot reach the raw upsert without them.
    try {
      res.status(201).json(svc.upsertSale(tid(req), uid(req), { ...(req.body || {}), serverReceivedAt: new Date().toISOString() }));
    } catch (e) { fail(res, e); }
  });
  app.post("/api/commission/sales/:externalId/transition", requireCapability("commission.sales.write"), (req, res) => {
    const { action, at, reason } = req.body || {};
    const sale = svc.getSaleByExternalId(tid(req), String(req.params.externalId));
    if (!sale) return res.status(404).json({ error: "Sale not found" });
    if (denyOutOfScope(req, res, sale.rep_id)) return;
    try { res.json(svc.transitionSale(tid(req), uid(req), String(req.params.externalId), action, { at, reason })); } catch (e) { fail(res, e); }
  });

  // ── Statements — the calculation surface ──────────────────────────────────────
  // Recalculation (re)writes statement rows — a WRITE, gated manager+. A read
  // cap here would let any oversight role mutate the money ledger.
  app.post("/api/commission/statements/recalculate", requireCapability("commission.statements.write"), (req, res) => {
    const repId = Number(req.body?.repId);
    const weekReference = parseWeekRef(req.body?.week) ?? parseWeekRef(req.body?.weekReference);
    if (!repId || !weekReference) return res.status(400).json({ error: "repId and week are required" });
    if (!canReadRep((req as any).user, repId)) return res.status(403).json({ error: "Out of scope", code: "UNAUTHORIZED_COMMISSION_ACTION" });
    // Recalculation REWRITES a statement row, so it takes the same branch guard
    // as the other money writes rather than only the read test.
    if (denyOutOfBranch(req, res, repId)) return;
    try {
      const out = svc.calculateOrRecalculateStatement({ tenantId: tid(req), repId, weekReference, actorId: uid(req), requestId: rid(req) });
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  // Rep-facing "my commission this week" — the caller computes/reads their OWN
  // current-week statement (self-scoped write is fine and keeps it fresh). Falls
  // back to read-only on a locked week, and an empty state when unassigned.
  // Always carries the per-sale list ("what counts") + plan acceptance state.
  app.get("/api/commission/statements/me/current", requireCapability("commission.read.self"), (req, res) => {
    const user = (req as any).user;
    const repId = user?.teamMemberId;
    if (!repId) return res.json({ statement: null, structure: null, noRepProfile: true });
    const now = new Date();
    // Surface APPROVED adjustments (reason + amount + date) so a deduction is
    // never an unexplained number on the rep's own paycheck screen.
    const adjustmentsFor = (statementId: number | null | undefined) =>
      statementId ? svc.getStatementAdjustments(tid(req), statementId).filter((a: any) => a.status === "APPROVED") : [];
    // Holdback: the current week's reserve split + the rep's running reserve
    // ledger, computed from the authoritative statement finals — so "what you're
    // paid this week" and "what's held" always agree with the number above them.
    const withExtras = (payload: any) => {
      const finalCents = Number(payload?.statement?.final_commission_cents ?? payload?.computation?.finalCommissionCents ?? 0);
      return {
        ...payload,
        // The hourly block ({hours, rateCents, hourlyPayCents}) — live from the
        // computation when present, else the persisted statement row.
        hourly: payload?.hourly
          ? { hours: payload.hourly.hours, rateCents: payload.hourly.rateCents, hourlyPayCents: payload.hourly.payCents }
          : hourlyBlockForStatement(payload?.statement),
        sales: svc.listWeekSalesForRep(tid(req), repId, now),
        adjustments: adjustmentsFor(payload?.statement?.id),
        holdback: {
          // Per-rep + cap-aware: once the rep's balance reaches their cap this
          // reports a 0 hold and a full net, which is exactly what they'll be paid.
          current: svc.holdbackForStatement(tid(req), finalCents, repId),
          ledger: svc.getReserveLedgerForRep(tid(req), repId),
        },
      };
    };
    try {
      const out = svc.calculateOrRecalculateStatement({ tenantId: tid(req), repId, weekReference: now, actorId: uid(req), requestId: rid(req) });
      res.json(withExtras({ ...out, structure: svc.getCurrentStructureForRep(tid(req), repId) }));
    } catch (e) {
      if (e instanceof svc.CommissionError && e.code === "STATEMENT_LOCKED") {
        const { statement, bounds } = svc.getStatementForWeek(tid(req), repId, now);
        return res.json(withExtras({ statement, bounds, structure: svc.getCurrentStructureForRep(tid(req), repId), locked: true }));
      }
      if (e instanceof svc.CommissionError && e.code === "NO_EFFECTIVE_PLAN_ASSIGNMENT") {
        return res.json({ statement: null, structure: null, noPlan: true, sales: svc.listWeekSalesForRep(tid(req), repId, now), adjustments: [] });
      }
      fail(res, e);
    }
  });

  // Rep accepts their current plan — the direct-onboarding handshake. Terms are
  // frozen with a SHA-256 into the assignment row; audited.
  app.post("/api/commission/my-plan/accept", requireCapability("commission.read.self"), (req, res) => {
    const user = (req as any).user;
    if (!user?.teamMemberId) return res.status(400).json({ error: "No rep profile linked to your login." });
    try { res.json(svc.acceptCurrentPlan(tid(req), user.teamMemberId, uid(req), req.ip)); } catch (e) { fail(res, e); }
  });

  // ── Week overview — the manager/admin closeout read model ────────────────────
  // Production, projected payroll, tier proximity + payroll exposure, exceptions,
  // per-rep statements. Scoped: team leads see their team, managers the tenant.
  app.get("/api/commission/week-overview", requireCapability("commission.read.team"), (req, res) => {
    const scope = readScope((req as any).user);
    const weekReference = parseWeekRef(req.query.week) ?? new Date().toISOString();
    try { res.json(svc.getWeekOverview(tid(req), uid(req), weekReference, scope.repIds)); } catch (e) { fail(res, e); }
  });

  // Batch closeout — the Sunday ritual. Finalize recalculates-then-locks every
  // OPEN statement in the week; mark-paid only touches FINALIZED ones. Both are
  // idempotent and per-rep reported.
  // FINALIZE locks the week and MARK_PAID moves REAL money — a manager's
  // oversight read (commission.read.all) must never authorize this. Admin only.
  app.post("/api/commission/week/transition", requireCapability("payouts.pay"), (req, res) => {
    const { week, action, repIds } = req.body || {};
    if (action !== "FINALIZE" && action !== "MARK_PAID") return res.status(400).json({ error: "action must be FINALIZE or MARK_PAID" });
    const weekReference = parseWeekRef(week) ?? new Date().toISOString();
    try { res.json(svc.batchTransitionWeek(tid(req), uid(req), weekReference, action, Array.isArray(repIds) ? repIds.map(Number) : null)); } catch (e) { fail(res, e); }
  });

  // Penny-exact payroll CSV for the week — what the payroll provider ingests.
  // The original 8 columns are STABLE (provider-compat); the hourly+spiff+
  // reserve+total money-plane columns are APPENDED after them. Per-row:
  // Total = Hourly Pay + Gross commissions + Adjustments + Overrides + Spiffs − Reserve.
  //
  // Install-hold columns are APPENDED last (same additive rule): held sales
  // are already EXCLUDED from Gross/Final/Total by the statement computation
  // itself (countQualifiedSales in commissionService), so the money columns
  // reconcile penny-for-penny with NACHA exactly as before; the two extra
  // columns only EXPLAIN what is being held back and when it releases.
  //
  // The Overrides column (downline override pay) is likewise APPENDED after
  // the install-hold pair so no existing column moves. Overrides are already
  // INSIDE Final (and therefore inside Reserve, which holds on final), so the
  // column explains the Final/Total delta rather than adding a second rail.
  app.get("/api/commission/week-export.csv", requireCapability("commission.read.all"), (req, res) => {
    const weekReference = parseWeekRef(req.query.week) ?? new Date().toISOString();
    try {
      const ov = svc.getWeekOverview(tid(req), uid(req), weekReference, null);
      const money = (c: number) => (c / 100).toFixed(2);
      const spiffs = sumWeekSpiffsByRep(tid(req), ov.bounds.weekStartUtc, ov.bounds.nextWeekStartUtc);
      const reservePercent = svc.loadOrgConfig(tid(req)).reservePercent;
      const rowMoney = (r: (typeof ov.rows)[number]) => {
        const spiffCents = spiffs.get(r.repId) ?? 0;
        const reserveCents = computeHoldback({ earnedCents: r.finalCommissionCents, reservePercent }).reserveCents;
        const totalCents = r.hourlyPayCents + r.grossCommissionCents + r.adjustmentCents + r.overridePayCents + spiffCents - reserveCents;
        return { spiffCents, reserveCents, totalCents };
      };
      const holdDate = (r: (typeof ov.rows)[number]) => r.installHold.earliestPayableAfter?.slice(0, 10) ?? "";
      const lines = [
        `Week,${csvCell(ov.bounds.localWeekLabel)}`,
        "Rep,Status,Qualified Sales,Tier,Rate,Gross,Adjustments,Final,Hours,Hourly Rate,Hourly Pay,Spiffs,Reserve,Total,Install Hold Sales,Install Hold Payable After,Overrides",
        ...ov.rows.map(r => {
          const m = rowMoney(r);
          return [
            csvCell(r.repName), csvCell(r.status), r.qualifiedSaleCount,
            csvCell(r.tierLabel ?? (r.structure === "FLAT" ? "Flat" : " - ")),
            money(r.rateCents), money(r.grossCommissionCents), money(r.adjustmentCents), money(r.finalCommissionCents),
            r.hours.toFixed(2), r.hourlyRateCents != null ? money(r.hourlyRateCents) : "", money(r.hourlyPayCents),
            money(m.spiffCents), money(m.reserveCents), money(m.totalCents),
            r.installHold.saleCount, csvCell(holdDate(r)),
            money(r.overridePayCents),
          ].join(",");
        }),
        (() => {
          const sum = (f: (r: (typeof ov.rows)[number]) => number) => ov.rows.reduce((s, r) => s + f(r), 0);
          return `Total,,,,,${money(sum(r => r.grossCommissionCents))},${money(sum(r => r.adjustmentCents))},${money(sum(r => r.finalCommissionCents))},${sum(r => r.hours).toFixed(2)},,${money(sum(r => r.hourlyPayCents))},${money(sum(r => rowMoney(r).spiffCents))},${money(sum(r => rowMoney(r).reserveCents))},${money(sum(r => rowMoney(r).totalCents))},${sum(r => r.installHold.saleCount)},,${money(sum(r => r.overridePayCents))}`;
        })(),
      ];
      storage.logActivity(uid(req), "commission.week.exported", "commission_statement", undefined, { week: ov.bounds.localWeekLabel, rows: ov.rows.length }, req.ip);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="payroll-${ov.bounds.weekStartUtc.slice(0, 10)}.csv"`);
      res.send(lines.join("\n"));
    } catch (e) { fail(res, e); }
  });

  // The sales behind any rep's week — statement explainability for managers.
  app.get("/api/commission/reps/:repId/week-sales", requireCapability("commission.read.team"), (req, res) => {
    const repId = Number(req.params.repId);
    if (!canReadRep((req as any).user, repId)) return res.status(403).json({ error: "Out of scope", code: "UNAUTHORIZED_COMMISSION_ACTION" });
    const weekReference = parseWeekRef(req.query.week) ?? new Date().toISOString();
    try { res.json(svc.listWeekSalesForRep(tid(req), repId, weekReference)); } catch (e) { fail(res, e); }
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
      // Locked statements read their FROZEN door snapshot (audit fidelity); open
      // ones read live. Fall back to live if a legacy lock predates the snapshot.
      const locked = stmt.status === "FINALIZED" || stmt.status === "PAID";
      let sales: any[];
      if (locked && stmt.contributing_sales) { try { sales = JSON.parse(stmt.contributing_sales); } catch { sales = svc.listWeekSalesForRep(tid(req), stmt.rep_id, stmt.week_start_utc); } }
      else sales = svc.listWeekSalesForRep(tid(req), stmt.rep_id, stmt.week_start_utc);
      res.json({ statement: stmt, hourly: hourlyBlockForStatement(stmt), adjustments: svc.getStatementAdjustments(tid(req), stmt.id), sales });
    } catch (e) { fail(res, e); }
  });

  // ── The statement document (screen + PDF) ───────────────────────────────────
  // One assembled document, two renderings. Both go through the same scope check
  // as GET /statements/:id — a rep sees their own, a team lead their reports, a
  // manager the tenant. Out of scope is 403 with the same code the sibling
  // statement reads use, so the client can treat them identically.
  const loadDocument = (req: Request, res: Response) => {
    const stmt = svc.getStatementById(tid(req), Number(req.params.id));
    if (!stmt) { res.status(404).json({ error: "Not found" }); return null; }
    if (!canReadRep((req as any).user, stmt.rep_id)) {
      res.status(403).json({ error: "Out of scope", code: "UNAUTHORIZED_COMMISSION_ACTION" });
      return null;
    }
    const doc = buildStatementDocumentFor(tid(req), stmt.id, new Date().toISOString());
    if (!doc) { res.status(404).json({ error: "Not found" }); return null; }
    return doc;
  };

  app.get("/api/commission/statements/:id/document", requireCapability("commission.read.self"), (req, res) => {
    try {
      const doc = loadDocument(req, res);
      if (doc) res.json(doc);
    } catch (e) { fail(res, e); }
  });

  app.get("/api/commission/statements/:id/statement.pdf", requireCapability("commission.read.self"), async (req, res) => {
    try {
      const doc = loadDocument(req, res);
      if (!doc) return;
      const pdf = await renderCommissionStatementPdf(doc);
      // The rep's own name is in the filename, so neutralize path separators and
      // quotes before they reach the Content-Disposition header.
      const safeName = doc.rep.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "rep";
      storage.logActivity(uid(req), "commission.statement.downloaded", "commission_statement", doc.statement.id ?? undefined,
        { repId: doc.rep.id, week: doc.period.label }, req.ip);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="commission-statement-${safeName}-${doc.period.startUtc.slice(0, 10)}.pdf"`);
      res.setHeader("Cache-Control", "no-store");
      res.send(pdf);
    } catch (e) { fail(res, e); }
  });

  // Statement lifecycle (FINALIZE / REOPEN / MARK_PAID) moves or unlocks real
  // money — admin only (payouts.pay), never the manager oversight read.
  app.post("/api/commission/statements/:id/transition", requireCapability("payouts.pay"), (req, res) => {
    const { action } = req.body || {};
    // Validate the action ENUM — an unknown action must never fall through to a
    // money-moving default (e.g. MARK_PAID). REOPEN is deliberate + audited.
    if (!["FINALIZE", "REOPEN", "MARK_PAID"].includes(action)) {
      return res.status(400).json({ error: "action must be FINALIZE, REOPEN, or MARK_PAID" });
    }
    try { res.json(svc.transitionStatement(tid(req), uid(req), Number(req.params.id), action)); } catch (e) { fail(res, e); }
  });

  // ── Adjustments (create = adjustments.write, manager+; decide = payouts.pay,
  // admin only — approving an adjustment moves real money on the paycheck) ──────
  app.post("/api/commission/adjustments", requireCapability("commission.adjustments.write"), (req, res) => {
    const stmt = svc.getStatementById(tid(req), Number(req.body?.statementId));
    if (!stmt) return res.status(404).json({ error: "Statement not found" });
    if (denyOutOfScope(req, res, stmt.rep_id)) return;
    try { res.status(201).json(svc.createAdjustment(tid(req), uid(req), req.body || {})); } catch (e) { fail(res, e); }
  });
  app.post("/api/commission/adjustments/:id/decide", requireCapability("payouts.pay"), (req, res) => {
    const { decision } = req.body || {};
    if (decision !== "APPROVE" && decision !== "REJECT") return res.status(400).json({ error: "decision must be APPROVE or REJECT" });
    try { res.json(svc.decideAdjustment(tid(req), uid(req), Number(req.params.id), decision)); } catch (e) { fail(res, e); }
  });

  // ── Reconciliation + queue operations (ADMIN ONLY, read-only by default) ────
  // The report NEVER repairs anything: an auto-corrector that is wrong pays the
  // wrong amount and destroys the evidence, so every finding is routed to a
  // human who fixes it through the existing audited adjustment / override
  // exception workflows.
  app.get("/api/commission/reconciliation", requireCapability("audit.read.org"), (req, res) => {
    try {
      const nowIso = new Date().toISOString();
      const report = reconcile({ tenantId: tid(req), nowIso, runId: `recon:${tid(req)}:${nowIso}` });
      res.json(report);
    } catch (e) { fail(res, e); }
  });

  // CSV export of the same report, for an operator working a backlog offline.
  app.get("/api/commission/reconciliation.csv", requireCapability("audit.read.org"), (req, res) => {
    try {
      const nowIso = new Date().toISOString();
      const report = reconcile({ tenantId: tid(req), nowIso, runId: `recon:${tid(req)}:${nowIso}` });
      const rows = [
        "Kind,Severity,Tenant,Rep,Sale,Week,Correlation,Detail",
        ...report.findings.map(f => [
          f.kind, f.severity, f.tenantId ?? "", f.repId ?? "", f.saleId ?? "",
          f.statementWeekUtc ?? "", f.correlationId, f.detail,
        ].map(csvCell).join(",")),
      ];
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader("content-disposition", `attachment; filename="reconciliation-${nowIso.slice(0, 10)}.csv"`);
      res.setHeader("cache-control", "no-store");
      res.send(rows.join("\n"));
    } catch (e) { fail(res, e); }
  });

  // Queue health for the incentive subscriber: what is halted, for how long, and
  // whether anything has crossed an alert threshold.
  app.get("/api/commission/queue/health", requireCapability("audit.read.org"), (_req, res) => {
    try {
      const subscriber = "incentives";
      res.json(queueOps.queueHealth(subscriber, cursorFor(subscriber), backlogFor(subscriber)));
    } catch (e) { fail(res, e); }
  });

  app.get("/api/commission/queue/recovery", requireCapability("audit.read.org"), (_req, res) => {
    try {
      const subscriber = "incentives";
      res.json(queueOps.recoveryReport(subscriber, cursorFor(subscriber)));
    } catch (e) { fail(res, e); }
  });

  // The only WRITE here, and it moves no money — it decides whether the queue
  // may advance. settings.manage.org (admin/owner) plus a mandatory reason.
  app.post("/api/commission/queue/events/:eventId/action", requireCapability("settings.manage.org"), (req, res) => {
    const { action, reason } = req.body || {};
    if (!["RETRY", "DEAD_LETTER", "RESOLVE"].includes(action)) {
      return res.status(400).json({ error: "action must be RETRY, DEAD_LETTER or RESOLVE" });
    }
    try {
      res.json(queueOps.operatorAction({
        subscriber: "incentives", eventId: Number(req.params.eventId),
        action, actorUserId: uid(req), reason: String(reason ?? ""), tenantId: tid(req),
      }));
    } catch (e: any) {
      if (/reason is required/i.test(e?.message ?? "")) return res.status(400).json({ error: e.message, code: "REASON_REQUIRED" });
      fail(res, e);
    }
  });
}
