// ── Downline override API — RBAC-gated, tenant-scoped ─────────────────────────
// The HTTP surface over server/overrideStore.ts. Registered from routes.ts with
// the shared middleware injected (the commissionRoutes pattern). Every handler
// derives tenantId from the session — never the body.
//
// Scoping model: readScope/canReadRep (commissionRoutes.ts) gate WHOSE sheet a
// caller may open; the sheet's CONTENTS come from the beneficiary's ledger rows
// and the reports-to tree walk — readScope is authorization, not traversal.
//
// No team-feed emission anywhere in this file, deliberately: the feed's privacy
// contract (shared/teamFeed.ts) forbids per-rep dollar amounts on the broadcast
// bus, and an override announcement would re-broadcast someone else's sale
// under a second name. Override money is a statement concern, not a floor one.

import type { Express, Request, Response, NextFunction } from "express";
import { rawDb } from "./db";
import { storage } from "./storage";
import * as svc from "./commissionService";
import * as ov from "./overrideStore";
import { canReadRep, parseWeekRef } from "./commissionRoutes";
import { csvCell } from "./csv";
import { weekBoundsFor } from "@shared/workweek";
import { downlineOf } from "@shared/teamHierarchy";
import type {
  DownlineRollupRowWire,
  DownlineSheetResponse,
  DownlineTreeMemberWire,
  MyOverrideWeekResponse,
  OverrideRowWire,
  OverrideTotalsWire,
} from "@shared/commissionOverrides";

type Mw = (req: Request, res: Response, next: NextFunction) => void;
interface Deps { requireAuth: Mw; requireCapability: (cap: any) => Mw; }

function fail(res: Response, e: unknown) {
  if (e instanceof svc.CommissionError) return res.status(e.httpStatus).json({ error: e.message, code: e.code });
  if (e instanceof ov.OverrideError) return res.status(e.httpStatus).json({ error: e.message, code: e.code });
  const msg = e instanceof Error ? e.message : "Internal error";
  return res.status(500).json({ error: msg });
}

/** Depth of every member strictly below rootId (1 = direct report). BFS over
 *  the same child index downlineOf uses; kept here because only the wire needs
 *  depths — authorization uses the flat id list. */
function downlineDepths(rootId: number, members: Array<{ id: number; reportsToId: number | null }>): Map<number, number> {
  const children = new Map<number, number[]>();
  for (const m of members) {
    if (m.reportsToId == null) continue;
    const list = children.get(m.reportsToId);
    if (list) list.push(m.id); else children.set(m.reportsToId, [m.id]);
  }
  const depths = new Map<number, number>();
  const queue: Array<{ id: number; depth: number }> = [{ id: rootId, depth: 0 }];
  const visited = new Set<number>([rootId]);
  while (queue.length) {
    const { id, depth } = queue.shift()!;
    for (const child of children.get(id) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      depths.set(child, depth + 1);
      queue.push({ id: child, depth: depth + 1 });
    }
  }
  return depths;
}

function totalsOf(rows: OverrideRowWire[]): OverrideTotalsWire {
  const t: OverrideTotalsWire = { rowCount: rows.length, payableCents: 0, heldCents: 0, settledCents: 0 };
  for (const r of rows) {
    if (r.status === "PAYABLE") t.payableCents += r.amountCents;
    else if (r.status === "HELD") t.heldCents += r.amountCents;
    else if (r.status === "SETTLED") t.settledCents += r.amountCents;
    // EXCEPTION/RESOLVED rows are listed but never totaled — they are not money
    // until a manager's adjustment says so.
  }
  return t;
}

export function registerCommissionOverrideRoutes(app: Express, deps: Deps) {
  const { requireCapability } = deps;
  const uid = (req: Request) => (req as any).user?.id ?? null;
  const tid = (req: Request) => (req as any).user?.tenantId as number;
  const selfRepId = (req: Request): number | null => (req as any).user?.teamMemberId ?? null;

  /** Resolve ?week= to org-week bounds (noon-UTC anchored, commissionRoutes rule). */
  const boundsFor = (req: Request) => {
    const ref = parseWeekRef(req.query.week) ?? new Date().toISOString();
    return weekBoundsFor(ref, svc.loadOrgConfig(tid(req)));
  };

  /** Resolve the target rep for ?repId= (self default) and authorize via
   *  canReadRep — the statements-endpoint precedent. */
  const resolveTarget = (req: Request, res: Response): number | null => {
    const raw = req.query.repId;
    const target = raw != null && String(raw).trim() !== "" ? Number(raw) : selfRepId(req);
    if (target == null || !Number.isInteger(target)) {
      res.status(400).json({ error: "No team-member profile on this account and no repId given." });
      return null;
    }
    if (!canReadRep((req as any).user, target)) {
      res.status(403).json({ error: "Out of scope", code: "UNAUTHORIZED_COMMISSION_ACTION" });
      return null;
    }
    return target;
  };

  // ── The rep-facing card: my override earnings this week ─────────────────────
  app.get("/api/commission/overrides/me", requireCapability("commission.read.self"), (req, res) => {
    try {
      const repId = selfRepId(req);
      if (repId == null) {
        const empty: MyOverrideWeekResponse = {
          hasDownline: false, bounds: null,
          totals: { rowCount: 0, payableCents: 0, heldCents: 0, settledCents: 0 },
          rows: [], statementOverrideCents: null,
        };
        return res.json(empty);
      }
      const bounds = boundsFor(req);
      const members = storage.getTeamMembers(tid(req));
      const hasDownline = downlineOf(repId, members as any).length > 0;
      const rows = ov.listWeekOverridesForBeneficiary(tid(req), repId, bounds.weekStartUtc);
      const stmt = rawDb.prepare(
        `SELECT override_pay_cents FROM commission_statements WHERE tenant_id = ? AND rep_id = ? AND week_start_utc = ?`
      ).get(tid(req), repId, bounds.weekStartUtc) as any;
      const body: MyOverrideWeekResponse = {
        hasDownline,
        bounds: { weekStartUtc: bounds.weekStartUtc, nextWeekStartUtc: bounds.nextWeekStartUtc },
        totals: totalsOf(rows),
        rows,
        statementOverrideCents: stmt ? Number(stmt.override_pay_cents ?? 0) : null,
      };
      res.json(body);
    } catch (e) { fail(res, e); }
  });

  // ── The manager sheet: a target's downline overrides for a week ─────────────
  const buildSheet = (req: Request, target: number): DownlineSheetResponse => {
    const bounds = boundsFor(req);
    const members = storage.getTeamMembers(tid(req)) as any[];
    const byId = new Map(members.map(m => [m.id, m]));
    const depths = downlineDepths(target, members);
    const rows = ov.listWeekOverridesForBeneficiary(tid(req), target, bounds.weekStartUtc);

    // Rollup per downline member: sales + money split, depth from the CURRENT
    // tree (rows keep their frozen attribution regardless).
    const rollupMap = new Map<number, DownlineRollupRowWire>();
    for (const r of rows) {
      let entry = rollupMap.get(r.downlineRepId);
      if (!entry) {
        const m = byId.get(r.downlineRepId);
        entry = {
          repId: r.downlineRepId, repName: r.downlineRepName,
          role: m?.role ?? r.downlineRoleAtEarn, active: !!(m?.active ?? true),
          level: depths.get(r.downlineRepId) ?? r.level,
          saleCount: 0, payableCents: 0, heldCents: 0, settledCents: 0,
        };
        rollupMap.set(r.downlineRepId, entry);
      }
      if (r.entryType === "EARN") entry.saleCount += 1;
      if (r.status === "PAYABLE") entry.payableCents += r.amountCents;
      else if (r.status === "HELD") entry.heldCents += r.amountCents;
      else if (r.status === "SETTLED") entry.settledCents += r.amountCents;
    }

    const exceptions = ov.listExceptions(tid(req))
      .filter(ex => ex.beneficiaryRepId === target && ex.earnedWeekStartUtc === bounds.weekStartUtc)
      .map(ex => ({
        type: ex.reason === "OVERRIDE_REVERSED_AFTER_FINALIZE" ? "OVERRIDE_REVERSED_AFTER_FINALIZE" : "OVERRIDE_LOCKED_WEEK_EARN",
        repId: ex.downlineRepId, repName: ex.downlineRepName,
        detail: `${ex.downlineRepName} — ${Math.abs(ex.amountCents) / 100} needs a manager adjustment.`,
      }));

    const viewer = byId.get(target);
    return {
      bounds: { weekStartUtc: bounds.weekStartUtc, nextWeekStartUtc: bounds.nextWeekStartUtc },
      viewer: { repId: target, repName: viewer?.name ?? `Rep ${target}` },
      totals: totalsOf(rows),
      rows,
      rollup: [...rollupMap.values()].sort((a, b) => a.level - b.level || a.repName.localeCompare(b.repName)),
      exceptions,
    };
  };

  app.get("/api/commission/overrides/sheet", requireCapability("commission.read.downline"), (req, res) => {
    try {
      const target = resolveTarget(req, res);
      if (target == null) return;
      res.json(buildSheet(req, target));
    } catch (e) { fail(res, e); }
  });

  // CSV export of the sheet — moneyExportLimiter is mounted on this path in
  // server/index.ts beside the other money exports; names go through csvCell.
  app.get("/api/commission/overrides/sheet-export.csv", requireCapability("commission.read.downline"), (req, res) => {
    try {
      const target = resolveTarget(req, res);
      if (target == null) return;
      const sheet = buildSheet(req, target);
      const money = (c: number) => (c / 100).toFixed(2);
      const lines = [
        `Week,${csvCell(sheet.bounds.weekStartUtc.slice(0, 10))},Sheet for,${csvCell(sheet.viewer.repName)}`,
        "Sold At,Downline Rep,Role,Level,Sale Status,Entry,Amount,Status",
        ...sheet.rows.map(r => [
          csvCell(r.soldAt?.slice(0, 10) ?? ""), csvCell(r.downlineRepName), csvCell(r.downlineRoleAtEarn),
          r.level, csvCell(r.saleStatus ?? ""), csvCell(r.entryType), money(r.amountCents), csvCell(r.status),
        ].join(",")),
        `Total,,,,,,${money(sheet.totals.payableCents + sheet.totals.settledCents)},`,
      ];
      storage.logActivity(uid(req), "commission.overrides.exported", "commission_override", undefined,
        { week: sheet.bounds.weekStartUtc, repId: target, rows: sheet.rows.length }, req.ip);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="overrides-${sheet.bounds.weekStartUtc.slice(0, 10)}.csv"`);
      res.send(lines.join("\n"));
    } catch (e) { fail(res, e); }
  });

  // ── The downline tree (feeds the sheet's picker + invite upline picker) ─────
  app.get("/api/commission/downline", requireCapability("commission.read.downline"), (req, res) => {
    try {
      const target = resolveTarget(req, res);
      if (target == null) return;
      const members = storage.getTeamMembers(tid(req)) as any[];
      const depths = downlineDepths(target, members);
      const byId = new Map(members.map(m => [m.id, m]));
      const out: DownlineTreeMemberWire[] = [...depths.entries()]
        .map(([id, level]) => {
          const m = byId.get(id);
          return {
            repId: id, repName: m?.name ?? `Rep ${id}`, role: m?.role ?? "rep",
            active: !!m?.active, level, reportsToId: m?.reportsToId ?? null,
          };
        })
        .sort((a, b) => a.level - b.level || a.repName.localeCompare(b.repName));
      res.json({ rootRepId: target, members: out });
    } catch (e) { fail(res, e); }
  });

  // ── Exceptions console ──────────────────────────────────────────────────────
  app.get("/api/commission/overrides/exceptions", requireCapability("commission.read.all"), (req, res) => {
    try { res.json({ exceptions: ov.listExceptions(tid(req)) }); } catch (e) { fail(res, e); }
  });

  app.post("/api/commission/overrides/exceptions/:id/resolve", requireCapability("commission.overrides.manage"), (req, res) => {
    try {
      const overrideId = Number(req.params.id);
      const adjustmentId = Number(req.body?.adjustmentId);
      if (!Number.isInteger(overrideId) || !Number.isInteger(adjustmentId)) {
        return res.status(400).json({ error: "overrideId and adjustmentId are required integers." });
      }
      // The adjustment must exist in-tenant — resolving against a foreign or
      // imaginary adjustment would fake an audit trail.
      const adj = rawDb.prepare(`SELECT id FROM commission_adjustments WHERE id = ? AND tenant_id = ?`)
        .get(adjustmentId, tid(req));
      if (!adj) return res.status(404).json({ error: "Adjustment not found in tenant." });
      ov.resolveException(tid(req), overrideId, adjustmentId, uid(req));
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
}
