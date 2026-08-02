// ── Hourly Pay internal API — rates, punch corrections, pay disputes ─────────
// Registered from routes.ts next to registerCommissionRoutes with the same
// injected requireAuth/requireCapability middleware. Tenant id comes from the
// session user — never the body; rep identity on rep-facing routes comes from
// the session's teamMemberId — never the body. All money integer cents.

import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import * as svc from "./commissionService";
import * as hourly from "./hourlyPay";
import { canReadRep, readScope, parseWeekRef } from "./commissionRoutes";
import { weekBoundsFor } from "@shared/workweek";

type Mw = (req: Request, res: Response, next: NextFunction) => void;
interface Deps { requireAuth: Mw; requireCapability: (cap: any) => Mw; }

function fail(res: Response, e: unknown) {
  if (e instanceof hourly.HourlyPayError) return res.status(e.httpStatus).json({ error: e.message, code: e.code });
  if (e instanceof svc.CommissionError) return res.status(e.httpStatus).json({ error: e.message, code: e.code });
  const msg = e instanceof Error ? e.message : "Internal error";
  return res.status(500).json({ error: msg });
}

export function registerHourlyPayRoutes(app: Express, deps: Deps) {
  const { requireCapability } = deps;
  const uid = (req: Request) => (req as any).user?.id ?? null;
  const tid = (req: Request) => (req as any).user?.tenantId as number;

  // ── Hourly rate management ──────────────────────────────────────────────────
  // Manager+ rate control, gated on the SAME capability as commission rate
  // config (commission.structure.manage). Write-scope mirrors the commission
  // write guard: a team_lead may only rate reps they can read, and nobody sets
  // their OWN rate (self-deal). Cross-tenant is a 404, never a tell.
  app.patch("/api/team-members/:id/hourly-rate", requireCapability("commission.structure.manage"), (req, res) => {
    const user = (req as any).user;
    const repId = Number(req.params.id);
    if (!Number.isInteger(repId) || repId <= 0) return res.status(400).json({ error: "Invalid team member id" });
    const rep = storage.getTeamMemberById(repId) as any;
    if (!rep || rep.tenantId !== tid(req)) return res.status(404).json({ error: "Rep not found" });
    if (!canReadRep(user, repId)) return res.status(403).json({ error: "Out of scope", code: "UNAUTHORIZED_COMMISSION_ACTION" });
    if (user?.teamMemberId != null && Number(user.teamMemberId) === repId) {
      return res.status(403).json({ error: "You cannot set your own hourly rate", code: "COMMISSION_SELF_DEAL" });
    }
    const { rateCents, effectiveFrom } = req.body || {};
    if (rateCents !== null && rateCents !== undefined && !(Number.isInteger(rateCents) && rateCents >= 0)) {
      return res.status(400).json({ error: "rateCents must be null (commission-only) or a non-negative integer", code: "INVALID_HOURLY_RATE" });
    }
    try {
      const member = hourly.setHourlyRate(tid(req), uid(req), repId, rateCents ?? null, effectiveFrom ?? null);
      res.json({ member, hourlyRateCents: (member as any).hourlyRateCents ?? null, hourlyRateEffectiveFrom: (member as any).hourlyRateEffectiveFrom ?? null });
    } catch (e) { fail(res, e); }
  });

  // ── Punch corrections (manager+, append-only) ───────────────────────────────
  // A correction NEVER edits the raw clock_sessions row — it appends a signed
  // minutes delta the hours aggregation folds into the weekly sum.
  app.post("/api/pay/punch-corrections", requireCapability("commission.adjustments.write"), (req, res) => {
    const user = (req as any).user;
    const { repId, sessionId, kind, minutesDelta, reason } = req.body || {};
    if (!Number.isInteger(Number(repId))) return res.status(400).json({ error: "repId is required" });
    if (!canReadRep(user, Number(repId))) return res.status(403).json({ error: "Out of scope", code: "UNAUTHORIZED_COMMISSION_ACTION" });
    try {
      const row = hourly.addPunchCorrection(tid(req), uid(req), {
        repId: Number(repId), sessionId: sessionId ?? null, kind: String(kind ?? ""),
        minutesDelta: Number(minutesDelta), reason: String(reason ?? ""),
      });
      res.status(201).json(row);
    } catch (e) { fail(res, e); }
  });

  // ── Pay disputes (rep-facing open; manager queue + resolve) ─────────────────
  // The rep is identified from the SESSION (teamMemberId), never the body — a
  // rep can only dispute their OWN lines. Idempotent on Idempotency-Key.
  app.post("/api/pay/disputes", requireCapability("commission.read.self"), (req, res) => {
    const user = (req as any).user;
    const repId = user?.teamMemberId;
    if (!repId) return res.status(400).json({ error: "No rep profile linked to your login." });
    const { weekStart, line, message } = req.body || {};
    const weekRef = parseWeekRef(weekStart);
    if (!weekRef) return res.status(400).json({ error: "weekStart is required", code: "INVALID_PAY_DISPUTE" });
    // Canonicalize to the org's commission week so the dispute keys the same
    // week_start_utc the statement uses, whatever day inside the week was sent.
    let weekStartUtc: string;
    try {
      weekStartUtc = weekBoundsFor(weekRef, svc.loadOrgConfig(tid(req))).weekStartUtc;
    } catch (e) { return fail(res, e); }
    const idemKey = (req.headers["idempotency-key"] as string) ?? req.body?.idempotencyKey ?? null;
    try {
      const out = hourly.openPayDispute(tid(req), uid(req), {
        repId, weekStartUtc, line, message: String(message ?? ""), idemKey,
      });
      res.status(out.duplicate ? 200 : 201).json(out.dispute);
    } catch (e) { fail(res, e); }
  });

  // Rep reads their OWN disputes; team_lead/manager read the scoped/tenant
  // queue (?status=open|resolved). Same readScope as the commission console.
  app.get("/api/pay/disputes", requireCapability("commission.read.self"), (req, res) => {
    const scope = readScope((req as any).user);
    const status = req.query.status != null ? String(req.query.status) : null;
    if (status != null && status !== "open" && status !== "resolved") {
      return res.status(400).json({ error: "status must be open or resolved", code: "INVALID_PAY_DISPUTE" });
    }
    try {
      const rows = hourly.listPayDisputes(tid(req), { repIds: scope.repIds, status });
      const names = new Map(storage.getTeamMembers(tid(req)).map((m: any) => [m.id, m.name]));
      res.json(rows.map((d: any) => ({ ...d, repName: names.get(d.rep_id) ?? null })));
    } catch (e) { fail(res, e); }
  });

  // Resolve (manager+ — the same cap that writes commission adjustments). An
  // 'adjusted' resolution references an adjustment created through the EXISTING
  // adjustments flow; the dispute flow never duplicates money math.
  app.post("/api/pay/disputes/:id/resolve", requireCapability("commission.adjustments.write"), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid dispute id" });
    const { resolution, note, adjustmentId } = req.body || {};
    if (resolution !== "upheld" && resolution !== "adjusted") {
      return res.status(400).json({ error: "resolution must be 'upheld' or 'adjusted'", code: "INVALID_PAY_DISPUTE" });
    }
    try {
      res.json(hourly.resolvePayDispute(tid(req), uid(req), id, { resolution, note: String(note ?? ""), adjustmentId: adjustmentId ?? null }));
    } catch (e) { fail(res, e); }
  });
}
