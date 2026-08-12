// ── Rep metrics and field performance - HTTP surface ─────────────────────────
//
// Three rules hold across every route in this file. They are the same three
// liveOpsRoutes established, restated because this surface exposes a strictly
// wider set of facts about a person than that one does.
//
//   SCOPE IS RESOLVED SERVER-SIDE, ALWAYS.
//   No endpoint accepts a rep id, team, or territory and trusts it. The
//   caller's scope comes from their own roster seat via liveOpsScope; a
//   client-supplied filter can only NARROW that set. There is deliberately no
//   "all reps" mode on the store's read function, so forgetting to narrow is a
//   compile-time absence rather than a silent org-wide leak.
//
//   OUT OF SCOPE IS 404, NOT 403.
//   A 403 confirms the row exists, which is itself a disclosure about somebody
//   the caller is not entitled to know about.
//
//   NO RAW COORDINATE LEAVES THIS FILE.
//   The metrics plane returns SUMMARIES - seconds inside territory, metres
//   travelled, doors verified. Raw trails stay behind field.location.export in
//   liveOpsRoutes, which audits every pull. A supervisor asking "how is this rep
//   doing" gets numbers; a supervisor asking "where has this person been" has to
//   go through the door that writes an audit row. Keeping those two questions on
//   two different endpoints is the entire point.

import type { Express, Request, Response } from "express";
import { storage } from "./storage";
import { rawDb } from "./db";
import { recordAdminAudit, auditContext } from "./adminAudit";
import { structuredLog } from "./structuredLog";
import { liveOpsScope, repInLiveOpsScope, type ScopeMember } from "./liveOpsScope";
import {
  localDateString,
  readDailyRows,
  tenantTimezone,
  parseTs,
  type DailyRow,
} from "./repMetricsStore";
import {
  aggregateFacts,
  buildFunnel,
  deriveMetrics,
  emptyFacts,
  METRIC_DEFS,
  type ChargebackBasis,
  type RepDailyFacts,
} from "@shared/repMetrics";
import { buildTeamBaseline, MIN_TEAM_FOR_BASELINE } from "@shared/coachingInsights";
import {
  assessTerritory,
  reclaimRiskScore,
  TERRITORY_STATUS_LABEL,
  type TerritoryFacts,
} from "@shared/territoryHealth";
import type { Capability } from "@shared/capabilities";

interface Deps {
  requireAuth: any;
  requireCapability: (cap: Capability) => any;
}

/** No period may exceed this. A year of daily rows per rep is a report, not a
 *  dashboard read, and an unbounded range is how one request pins the WAL. */
const MAX_PERIOD_DAYS = 400;
const TEAM_ROW_CAP = 500;
const TERRITORY_ROW_CAP = 500;
const INSIGHT_ROW_CAP = 200;

export function registerRepMetricsRoutes(app: Express, deps: Deps) {
  const { requireAuth, requireCapability } = deps;
  const uid = (req: Request) => (req as any).user?.id ?? null;
  const tid = (req: Request) => ((req as any).user?.tenantId ?? null) as number | null;
  const actor = (req: Request) => (req as any).user ?? null;
  const myRepId = (req: Request) => ((req as any).user?.teamMemberId ?? null) as number | null;

  const roster = (req: Request): ScopeMember[] =>
    (storage.getTeamMembers(tid(req) ?? undefined) as any[]).map((m) => ({
      id: Number(m.id),
      role: String(m.role ?? "rep"),
      reportsToId: m.reportsToId == null ? null : Number(m.reportsToId),
      active: m.active !== false && Number(m.active ?? 1) !== 0,
    }));

  const scopeOf = (req: Request) => liveOpsScope(actor(req), roster(req));

  /** Every rep id the caller may read, as a concrete list. `null` from the
   *  scope resolver means "unrestricted", which we materialise HERE rather than
   *  passing a null through to a query - a null that reaches SQL is a query with
   *  no WHERE clause. */
  const readableReps = (req: Request): number[] => {
    const scope = scopeOf(req);
    if (scope !== null) return scope;
    return roster(req).map((m) => m.id);
  };

  // ── Period parsing ─────────────────────────────────────────────────────────

  function periodOf(req: Request): { from: string; to: string; timezone: string } {
    const timezone = tenantTimezone(tid(req));
    const today = localDateString(Date.now(), timezone);
    const raw = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    let from = raw(req.query.from);
    let to = raw(req.query.to);

    // Named presets, resolved in the ORG's timezone so "today" means the same
    // day here as it does on the rep's pay statement.
    const preset = String(req.query.period ?? "");
    if (!from || !to) {
      const dayOffset = (n: number) => localDateString(Date.now() - n * 86_400_000, timezone);
      switch (preset) {
        case "yesterday": from = to = dayOffset(1); break;
        case "week": from = dayOffset(6); to = today; break;
        case "last_week": from = dayOffset(13); to = dayOffset(7); break;
        case "month": from = dayOffset(29); to = today; break;
        default: from = to = today;
      }
    }
    if (from > to) [from, to] = [to, from];
    // Clamp rather than reject: a bookmarked link with a silly range should
    // render the last 400 days, not an error page.
    const spanDays = Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
    );
    if (spanDays > MAX_PERIOD_DAYS) {
      from = localDateString(Date.parse(`${to}T00:00:00Z`) - MAX_PERIOD_DAYS * 86_400_000, timezone);
    }
    return { from, to, timezone };
  }

  /** The immediately preceding period of equal length - the "vs last" baseline. */
  function previousPeriod(from: string, to: string): { from: string; to: string } {
    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const toMs = Date.parse(`${to}T00:00:00Z`);
    const span = toMs - fromMs + 86_400_000;
    return {
      from: new Date(fromMs - span).toISOString().slice(0, 10),
      to: new Date(toMs - span).toISOString().slice(0, 10),
    };
  }

  function chargebackBasis(req: Request): ChargebackBasis {
    try {
      const r = rawDb.prepare(
        `SELECT chargeback_basis AS b FROM field_location_policy WHERE tenant_id = ?`,
      ).get(tid(req)) as any;
      return r?.b === "submitted" ? "submitted" : "paid";
    } catch { return "paid"; }
  }

  /** Whether reps may see team medians at all. Org policy, default on. */
  function repSeesBenchmarks(tenantId: number | null): boolean {
    try {
      const r = rawDb.prepare(
        `SELECT rep_sees_team_benchmarks AS v FROM field_location_policy WHERE tenant_id = ?`,
      ).get(tenantId) as any;
      return r == null ? true : Number(r.v) !== 0;
    } catch { return true; }
  }

  function foldByRep(rows: readonly DailyRow[]): Map<number, RepDailyFacts> {
    const grouped = new Map<number, DailyRow[]>();
    for (const r of rows) {
      const list = grouped.get(r.repId);
      if (list) list.push(r); else grouped.set(r.repId, [r]);
    }
    const out = new Map<number, RepDailyFacts>();
    for (const [repId, days] of grouped) out.set(repId, aggregateFacts(days));
    return out;
  }

  // ── My Metrics ─────────────────────────────────────────────────────────────

  /**
   * The rep's own numbers. Gated on dashboard.read.self, which every field role
   * holds, and scoped to the caller's OWN roster seat with no way to pass an id.
   */
  app.get("/api/metrics/me", requireAuth, requireCapability("dashboard.read.self"),
    (req: Request, res: Response) => {
      const repId = myRepId(req);
      const tenantId = tid(req);
      if (repId == null || tenantId == null) {
        // A signed-in user with no roster seat (an office admin) has no field
        // metrics. An empty scorecard is the honest answer, not a 403.
        return res.json({ hasSeat: false, facts: emptyFacts(), metrics: deriveMetrics(emptyFacts()) });
      }

      const { from, to, timezone } = periodOf(req);
      const basis = chargebackBasis(req);
      const rows = readDailyRows(tenantId, [repId], from, to);
      const facts = aggregateFacts(rows);
      const metrics = deriveMetrics(facts, { chargebackBasis: basis });

      const prev = previousPeriod(from, to);
      const prevFacts = aggregateFacts(readDailyRows(tenantId, [repId], prev.from, prev.to));

      // The rep's own trailing 30 days, for "compared with your usual".
      const personalFrom = localDateString(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000, timezone);
      const personalFacts = aggregateFacts(readDailyRows(tenantId, [repId], personalFrom, to));

      // Team median, only when policy allows AND the team is big enough that a
      // median does not identify one colleague (MIN_TEAM_FOR_BASELINE).
      let teamBaseline = null;
      if (repSeesBenchmarks(tenantId)) {
        const peers = roster(req).filter((m) => m.active).map((m) => m.id);
        const peerRows = readDailyRows(tenantId, peers, from, to);
        const folded = [...foldByRep(peerRows).values()]
          .filter((f) => f.doorsAttempted > 0)
          .map((f) => ({ metrics: deriveMetrics(f, { chargebackBasis: basis }) }));
        teamBaseline = folded.length >= MIN_TEAM_FOR_BASELINE ? buildTeamBaseline(folded) : null;
      }

      res.json({
        hasSeat: true,
        period: { from, to, timezone },
        facts,
        metrics,
        funnel: buildFunnel(facts),
        previous: { facts: prevFacts, metrics: deriveMetrics(prevFacts, { chargebackBasis: basis }) },
        personal: { facts: personalFacts, metrics: deriveMetrics(personalFacts, { chargebackBasis: basis }) },
        teamBaseline,
        daily: rows,
        definitions: METRIC_DEFS,
      });
    });

  /**
   * Hour-of-day door activity for the caller. Separate from /me because it is a
   * different shape and only one chart needs it.
   */
  app.get("/api/metrics/me/hourly", requireAuth, requireCapability("dashboard.read.self"),
    (req: Request, res: Response) => {
      const repId = myRepId(req);
      if (repId == null) return res.json({ hours: [] });
      const { from, to } = periodOf(req);
      try {
        const rows = rawDb.prepare(`
          SELECT CAST(strftime('%H', replace(knocked_at,'T',' ')) AS INTEGER) AS hour,
                 COUNT(*) AS doors,
                 SUM(CASE WHEN was_home = 1 THEN 1 ELSE 0 END) AS contacts,
                 SUM(CASE WHEN outcome = 'sold' THEN 1 ELSE 0 END) AS sales
            FROM knock_log
           WHERE rep_id = ?
             AND date(replace(knocked_at,'T',' ')) BETWEEN ? AND ?
           GROUP BY hour ORDER BY hour
        `).all(repId, from, to) as any[];
        res.json({ hours: rows });
      } catch { res.json({ hours: [] }); }
    });

  // ── Team Metrics ───────────────────────────────────────────────────────────

  app.get("/api/metrics/team", requireAuth, requireCapability("dashboard.read.team"),
    (req: Request, res: Response) => {
      const tenantId = tid(req);
      if (tenantId == null) return res.json({ rows: [], kpis: null });

      const scope = readableReps(req);
      if (scope.length === 0) return res.json({ rows: [], kpis: null, period: periodOf(req) });

      const { from, to, timezone } = periodOf(req);
      const basis = chargebackBasis(req);

      // A client-supplied rep filter may only NARROW the server-resolved scope.
      //
      // The empty-string guard is load-bearing, not defensive noise: `Number("")`
      // is 0, not NaN, so "".split(",") -> [""] -> [0] passes Number.isFinite and
      // produces a NON-EMPTY filter of [0] that matches no rep. Without it, a
      // request with no `reps` parameter at all - which is every normal request -
      // narrows the scope to nothing and the table renders empty.
      const requested = String(req.query.reps ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
      const repIds = requested.length > 0
        ? scope.filter((id) => requested.includes(id))
        : scope;
      if (repIds.length === 0) return res.json({ rows: [], kpis: null, period: { from, to, timezone } });

      const folded = foldByRep(readDailyRows(tenantId, repIds, from, to));

      const members = new Map<number, any>();
      for (const m of storage.getTeamMembers(tenantId) as any[]) members.set(Number(m.id), m);

      const liveState = new Map<number, any>();
      try {
        for (const s of rawDb.prepare(`
          SELECT rep_id AS repId, status, captured_at AS capturedAt, territory_id AS territoryId
            FROM rep_location_state WHERE tenant_id = ?
        `).all(tenantId) as any[]) liveState.set(Number(s.repId), s);
      } catch { /* live state is optional garnish on this table */ }

      const openShifts = new Set<number>();
      try {
        for (const s of rawDb.prepare(
          `SELECT DISTINCT rep_id AS repId FROM clock_sessions WHERE tenant_id = ? AND clocked_out IS NULL`,
        ).all(tenantId) as any[]) openShifts.add(Number(s.repId));
      } catch { /* ditto */ }

      const rows = [...folded.entries()]
        .slice(0, TEAM_ROW_CAP)
        .map(([repId, facts]) => {
          const m = members.get(repId);
          const live = liveState.get(repId);
          return {
            repId,
            repName: m?.name ?? `Rep ${repId}`,
            role: m?.role ?? "rep",
            inFieldMode: openShifts.has(repId),
            // A STATUS, never a position. See the file header.
            status: live?.status ?? "offline",
            lastActivityAt: facts.lastActivityAtMs == null ? null : new Date(facts.lastActivityAtMs).toISOString(),
            territoryId: live?.territoryId ?? null,
            facts,
            metrics: deriveMetrics(facts, { chargebackBasis: basis }),
          };
        });

      // Team KPIs are recomputed from SUMMED facts, never averaged from the row
      // rates above - the same rule the shared module enforces per rep.
      const teamFacts = aggregateFacts([...folded.values()].map((f) => f as DailyRow));
      const contributing = rows.filter((r) => r.facts.doorsAttempted > 0).map((r) => ({ metrics: r.metrics }));

      res.json({
        period: { from, to, timezone },
        rows,
        kpis: {
          facts: teamFacts,
          metrics: deriveMetrics(teamFacts, { chargebackBasis: basis }),
          activeNow: rows.filter((r) => r.inFieldMode).length,
          repCount: rows.length,
        },
        baseline: contributing.length >= MIN_TEAM_FOR_BASELINE ? buildTeamBaseline(contributing) : null,
        definitions: METRIC_DEFS,
      });
    });

  /** Manager drill-down on ONE rep. 404 outside scope - see the header. */
  app.get("/api/metrics/rep/:repId", requireAuth, requireCapability("dashboard.read.team"),
    (req: Request, res: Response) => {
      const repId = Number(req.params.repId);
      const tenantId = tid(req);
      if (!Number.isFinite(repId) || tenantId == null) {
        return res.status(400).json({ error: "Bad rep id" });
      }
      // Tenant wall first, then branch scope. Both answer 404 so neither
      // confirms that a rep outside the caller's world exists.
      const member = storage.getTeamMemberById(repId, tenantId);
      if (!member) return res.status(404).json({ error: "Not found" });
      if (!repInLiveOpsScope(actor(req), roster(req), repId)) {
        return res.status(404).json({ error: "Not found" });
      }

      const { from, to, timezone } = periodOf(req);
      const basis = chargebackBasis(req);
      const daily = readDailyRows(tenantId, [repId], from, to);
      const facts = aggregateFacts(daily);

      const shifts = loadShiftHistory(repId, from, to);

      res.json({
        repId,
        repName: (member as any).name ?? `Rep ${repId}`,
        period: { from, to, timezone },
        facts,
        metrics: deriveMetrics(facts, { chargebackBasis: basis }),
        funnel: buildFunnel(facts),
        daily,
        shifts,
        insights: readInsights(tenantId, [repId], false),
        notes: readNotes(tenantId, repId),
        definitions: METRIC_DEFS,
      });

      logViewOnce(uid(req), tenantId, "metrics.rep_viewed", { repId });
    });

  // ── Territory Metrics ──────────────────────────────────────────────────────

  app.get("/api/metrics/territories", requireAuth, requireCapability("dashboard.read.team"),
    (req: Request, res: Response) => {
      const tenantId = tid(req);
      if (tenantId == null) return res.json({ rows: [] });

      const timezone = tenantTimezone(tenantId);
      const today = localDateString(Date.now(), timezone);
      const scope = scopeOf(req);

      let rows: any[] = [];
      try {
        rows = rawDb.prepare(`
          SELECT tdm.*, t.name AS territoryName, t.rep_id AS repId, t.assignee_ids AS assigneeIds,
                 t.status AS territoryStatus
            FROM territory_daily_metrics tdm
            JOIN territories t ON t.id = tdm.territory_id
           WHERE tdm.tenant_id = ? AND tdm.metric_date = ?
           ORDER BY tdm.reclaim_recommended DESC, tdm.eligible_doors DESC
           LIMIT ?
        `).all(tenantId, today, TERRITORY_ROW_CAP) as any[];
      } catch { rows = []; }

      // A supervisor sees the areas held by reps in their branch, plus the
      // unassigned pool (which is nobody's, and which they need in order to
      // assign work). Admins see everything.
      const visible = scope === null
        ? rows
        : rows.filter((r) => {
            const assignees = parseAssignees(r.assigneeIds, r.repId);
            return assignees.length === 0 || assignees.some((id) => scope.includes(id));
          });

      res.json({
        period: { date: today, timezone },
        rows: visible.map((r) => {
          const facts = territoryFactsFromRow(r);
          const health = assessTerritory(facts, Date.now());
          return {
            territoryId: facts.territoryId,
            territoryName: facts.territoryName,
            facts,
            health,
            statusLabel: TERRITORY_STATUS_LABEL[health.status],
            riskScore: reclaimRiskScore(health),
          };
        }),
      });
    });

  /**
   * Record a decision on a reclaim recommendation.
   *
   * This route does NOT reclaim anything. It writes what a human decided, to an
   * audited row. Actually moving doors still goes through the existing
   * rank-gated territory routes, which is deliberate: the brief requires reclaim
   * to be review-only and audited, and the way to guarantee that is for the
   * recommendation surface to have no power to act.
   */
  app.post("/api/metrics/territories/:id/review", requireAuth,
    requireCapability("territory.reclaim.review"),
    (req: Request, res: Response) => {
      const territoryId = Number(req.params.id);
      const tenantId = tid(req);
      if (!Number.isFinite(territoryId) || tenantId == null) {
        return res.status(400).json({ error: "Bad territory id" });
      }
      const decision = String(req.body?.decision ?? "");
      if (!["reclaimed", "reassigned", "kept", "deferred"].includes(decision)) {
        return res.status(400).json({ error: "decision must be reclaimed, reassigned, kept or deferred" });
      }
      const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 2000) : null;

      const territory = rawDb.prepare(
        `SELECT id, name FROM territories WHERE id = ? AND tenant_id = ?`,
      ).get(territoryId, tenantId) as any;
      if (!territory) return res.status(404).json({ error: "Not found" });

      const today = localDateString(Date.now(), tenantTimezone(tenantId));
      const metrics = rawDb.prepare(
        `SELECT * FROM territory_daily_metrics WHERE tenant_id = ? AND territory_id = ? AND metric_date = ?`,
      ).get(tenantId, territoryId, today) as any;

      rawDb.prepare(`
        INSERT INTO territory_reclaim_reviews (
          tenant_id, territory_id, recommended_at, rationale, supporting_metrics_json,
          decision, decided_by_user_id, decided_at, decision_note
        ) VALUES (?,?,?,?,?,?,?,datetime('now'),?)
      `).run(
        tenantId, territoryId, new Date().toISOString(),
        metrics?.reclaim_rationale ?? "Manual review",
        metrics ? JSON.stringify(metrics) : null,
        decision, uid(req), note,
      );

      recordAdminAudit({
        ...auditContext(req),
        action: "metrics.territory_reclaim_reviewed",
        targetType: "territory",
        targetId: territoryId,
        targetLabel: territory.name ?? String(territoryId),
        after: { decision, note },
        tenantId,
        outcome: "success",
      });

      res.json({ ok: true, decision });
    });

  // ── Coaching Insights ──────────────────────────────────────────────────────

  /** A rep's own insights. Every rule that produced one is written to be read
   *  by its subject - see the header of shared/coachingInsights. */
  app.get("/api/metrics/insights/me", requireAuth, requireCapability("coaching.read.self"),
    (req: Request, res: Response) => {
      const repId = myRepId(req);
      const tenantId = tid(req);
      if (repId == null || tenantId == null) return res.json({ insights: [] });
      res.json({ insights: readInsights(tenantId, [repId], false) });
    });

  /** The supervisor's board, scoped to their branch. */
  app.get("/api/metrics/insights", requireAuth, requireCapability("coaching.read.team"),
    (req: Request, res: Response) => {
      const tenantId = tid(req);
      if (tenantId == null) return res.json({ insights: [] });
      const scope = readableReps(req);
      if (scope.length === 0) return res.json({ insights: [] });
      const includeDismissed = String(req.query.includeDismissed ?? "") === "1";
      res.json({ insights: readInsights(tenantId, scope, includeDismissed) });
      logViewOnce(uid(req), tenantId, "metrics.insights_viewed", { repCount: scope.length });
    });

  app.post("/api/metrics/insights/:id/dismiss", requireAuth, requireCapability("coaching.read.team"),
    (req: Request, res: Response) => {
      const id = Number(req.params.id);
      const tenantId = tid(req);
      if (!Number.isFinite(id) || tenantId == null) return res.status(400).json({ error: "Bad id" });

      const row = rawDb.prepare(
        `SELECT rep_id AS repId FROM rep_coaching_insights WHERE id = ? AND tenant_id = ?`,
      ).get(id, tenantId) as any;
      if (!row) return res.status(404).json({ error: "Not found" });
      if (!repInLiveOpsScope(actor(req), roster(req), Number(row.repId))) {
        return res.status(404).json({ error: "Not found" });
      }

      rawDb.prepare(`
        UPDATE rep_coaching_insights
           SET dismissed_at = datetime('now'), dismissed_by_user_id = ?, updated_at = datetime('now')
         WHERE id = ? AND tenant_id = ?
      `).run(uid(req), id, tenantId);
      res.json({ ok: true });
    });

  /** A rep marking their own insight as read. Deliberately a different verb
   *  from dismiss: a rep acknowledging advice must not delete it from their
   *  supervisor's board, and a supervisor dismissing it must not imply the rep
   *  ever saw it. */
  app.post("/api/metrics/insights/:id/acknowledge", requireAuth, requireCapability("coaching.read.self"),
    (req: Request, res: Response) => {
      const id = Number(req.params.id);
      const tenantId = tid(req);
      const repId = myRepId(req);
      if (!Number.isFinite(id) || tenantId == null || repId == null) {
        return res.status(400).json({ error: "Bad id" });
      }
      const changed = rawDb.prepare(`
        UPDATE rep_coaching_insights SET acknowledged_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND tenant_id = ? AND rep_id = ?
      `).run(id, tenantId, repId);
      if (changed.changes === 0) return res.status(404).json({ error: "Not found" });
      res.json({ ok: true });
    });

  // ── Coaching notes and goals ───────────────────────────────────────────────

  app.post("/api/metrics/notes", requireAuth, requireCapability("coaching.note.write"),
    (req: Request, res: Response) => {
      const tenantId = tid(req);
      const repId = Number(req.body?.repId);
      if (tenantId == null || !Number.isFinite(repId)) {
        return res.status(400).json({ error: "repId required" });
      }
      if (!storage.getTeamMemberById(repId, tenantId)) return res.status(404).json({ error: "Not found" });
      if (!repInLiveOpsScope(actor(req), roster(req), repId)) {
        return res.status(404).json({ error: "Not found" });
      }
      const body = String(req.body?.body ?? "").trim();
      if (!body) return res.status(400).json({ error: "body required" });

      const row = rawDb.prepare(`
        INSERT INTO rep_coaching_notes (
          tenant_id, rep_id, author_user_id, insight_id, body, shared_with_rep,
          goal_metric, goal_target, goal_due_date, review_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
        RETURNING id
      `).get(
        tenantId, repId, uid(req),
        Number.isFinite(Number(req.body?.insightId)) ? Number(req.body.insightId) : null,
        body.slice(0, 5000),
        req.body?.sharedWithRep === true ? 1 : 0,
        typeof req.body?.goalMetric === "string" ? req.body.goalMetric.slice(0, 60) : null,
        Number.isFinite(Number(req.body?.goalTarget)) ? Number(req.body.goalTarget) : null,
        typeof req.body?.goalDueDate === "string" ? req.body.goalDueDate.slice(0, 10) : null,
        typeof req.body?.reviewAt === "string" ? req.body.reviewAt.slice(0, 30) : null,
      ) as any;

      res.json({ ok: true, id: row?.id ?? null });
    });

  app.get("/api/metrics/notes", requireAuth, requireCapability("coaching.read.team"),
    (req: Request, res: Response) => {
      const tenantId = tid(req);
      const repId = Number(req.query.repId);
      if (tenantId == null || !Number.isFinite(repId)) return res.json({ notes: [] });
      if (!repInLiveOpsScope(actor(req), roster(req), repId)) {
        return res.status(404).json({ error: "Not found" });
      }
      res.json({ notes: readNotes(tenantId, repId) });
    });

  /**
   * The rep's own view of their coaching file: SHARED notes only.
   *
   * The WHERE clause is the whole feature. A supervisor's private note is their
   * working record, and publishing it by default would either stop supervisors
   * writing anything useful or blindside the rep with a file they never knew
   * existed. Sharing is a deliberate act at write time.
   */
  app.get("/api/metrics/notes/me", requireAuth, requireCapability("coaching.read.self"),
    (req: Request, res: Response) => {
      const tenantId = tid(req);
      const repId = myRepId(req);
      if (tenantId == null || repId == null) return res.json({ notes: [] });
      const notes = rawDb.prepare(`
        SELECT id, body, goal_metric AS goalMetric, goal_target AS goalTarget,
               goal_due_date AS goalDueDate, goal_status AS goalStatus, created_at AS createdAt
          FROM rep_coaching_notes
         WHERE tenant_id = ? AND rep_id = ? AND shared_with_rep = 1
         ORDER BY created_at DESC LIMIT 100
      `).all(tenantId, repId);
      res.json({ notes });
    });

  // ── Reports ────────────────────────────────────────────────────────────────

  /**
   * Org-wide yield by carrier, product, program and team.
   *
   * dashboard.read.org, not .team: this is a whole-organization revenue view
   * with no per-rep scoping, so a branch-scoped supervisor must not reach it.
   */
  app.get("/api/metrics/reports", requireAuth, requireCapability("dashboard.read.org"),
    (req: Request, res: Response) => {
      const tenantId = tid(req);
      if (tenantId == null) return res.json({ groups: {} });
      const { from, to } = periodOf(req);

      const byDimension = (column: string) => {
        try {
          return rawDb.prepare(`
            SELECT COALESCE(NULLIF(${column}, ''), 'Unspecified') AS label,
                   COUNT(*) AS submitted,
                   SUM(CASE WHEN normalized_status = 'installed' THEN 1 ELSE 0 END) AS installed,
                   SUM(CASE WHEN normalized_status IN ('canceled','rejected') THEN 1 ELSE 0 END) AS canceled
              FROM vendor_orders
             WHERE tenant_id = ?
               AND date(replace(COALESCE(submitted_date, sale_date),'T',' ')) BETWEEN ? AND ?
             GROUP BY label ORDER BY submitted DESC LIMIT 50
          `).all(tenantId, from, to);
        } catch { return []; }
      };

      // Team yield comes from the rollup rather than the provider feed, so it
      // still reports something real when the carrier integration is dark -
      // which it is in this org today.
      const teams = (() => {
        try {
          return rawDb.prepare(`
            SELECT COALESCE(lead.name, 'Unassigned') AS label,
                   SUM(m.doors_attempted)  AS doorsAttempted,
                   SUM(m.contacts)         AS contacts,
                   SUM(m.submitted_orders) AS submitted,
                   SUM(m.installed_orders) AS installed,
                   SUM(m.paid_commission_cents) AS paidCents
              FROM rep_daily_metrics m
              JOIN team_members tm ON tm.id = m.rep_id
              LEFT JOIN team_members lead ON lead.id = tm.reports_to_id
             WHERE m.tenant_id = ? AND m.metric_date BETWEEN ? AND ?
             GROUP BY label ORDER BY submitted DESC LIMIT 50
          `).all(tenantId, from, to);
        } catch { return []; }
      })();

      res.json({
        period: { from, to },
        groups: {
          carrier: byDimension("carrier"),
          product: byDimension("product_sold"),
          program: byDimension("program"),
          team: teams,
        },
      });
    });

  // ── Field Mode ─────────────────────────────────────────────────────────────

  /**
   * The Field Mode HUD, in one request.
   *
   * Deliberately one endpoint rather than five: a rep opening this on LTE at a
   * doorstep should pay one round trip, not five. Everything here is already
   * indexed or already computed.
   */
  app.get("/api/field-mode/state", requireAuth, requireCapability("field.app.use"),
    (req: Request, res: Response) => {
      const repId = myRepId(req);
      const tenantId = tid(req);
      if (repId == null) return res.json({ hasSeat: false });

      const session = storage.getActiveClockSession(repId);
      const timezone = tenantTimezone(tenantId);
      const today = localDateString(Date.now(), timezone);
      const rows = tenantId == null ? [] : readDailyRows(tenantId, [repId], today, today);
      const facts = rows.length > 0 ? rows[0] : emptyFacts();

      let assignment: any = { assigned: 0, remaining: 0 };
      try {
        assignment = rawDb.prepare(`
          SELECT COUNT(*) AS assigned,
                 SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM knock_log k WHERE k.lead_id = l.id)
                          THEN 1 ELSE 0 END) AS remaining
            FROM leads l
           WHERE l.assigned_rep_id = ? AND COALESCE(l.do_not_knock,0) = 0
        `).get(repId);
      } catch { /* defaults above */ }

      const lastKnock = (() => {
        try {
          return rawDb.prepare(`
            SELECT outcome, knocked_at AS knockedAt
              FROM knock_log WHERE rep_id = ? ORDER BY knocked_at DESC LIMIT 1
          `).get(repId) as any;
        } catch { return null; }
      })();

      res.json({
        hasSeat: true,
        fieldMode: !!session,
        // The visible "tracking active" indicator the brief requires is driven
        // from this. It is deliberately the SAME field the tracking gate uses,
        // so the indicator cannot say off while collection is on.
        shiftStartedAt: session?.clockedIn ?? null,
        sessionId: session?.id ?? null,
        today,
        timezone,
        facts,
        metrics: deriveMetrics(facts),
        doorsAssigned: Number(assignment?.assigned ?? 0),
        doorsRemaining: Number(assignment?.remaining ?? 0),
        lastOutcome: lastKnock?.outcome ?? null,
        lastOutcomeAt: lastKnock?.knockedAt ?? null,
      });
    });

  /**
   * Record arriving at a door, so dwell time becomes computable.
   *
   * Accepts an idempotency key from the offline queue and NEVER fails the
   * caller: a rep whose arrival ping is rejected must still be able to save a
   * disposition, so every failure path here returns 200 with recorded:false
   * rather than an error the client would have to handle at a doorstep.
   */
  app.post("/api/field-mode/arrival", requireAuth, requireCapability("field.app.use"),
    (req: Request, res: Response) => {
      const repId = myRepId(req);
      const tenantId = tid(req);
      const leadId = Number(req.body?.leadId);
      if (repId == null || !Number.isFinite(leadId)) {
        return res.json({ recorded: false, reason: "no_seat_or_lead" });
      }
      // No open shift = no collection. This is the brief's rule expressed at the
      // write boundary rather than filtered on read: an arrival carries a
      // position, and a position outside a shift is never written in the first
      // place.
      const session = storage.getActiveClockSession(repId);
      if (!session) return res.json({ recorded: false, reason: "no_active_shift" });

      const lat = Number(req.body?.lat);
      const lng = Number(req.body?.lng);
      const hasFix = Number.isFinite(lat) && Number.isFinite(lng)
        && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

      try {
        const retentionDays = readRetentionDays(tenantId);
        rawDb.prepare(`
          INSERT INTO door_arrivals (
            tenant_id, rep_id, user_id, lead_id, clock_session_id, arrived_at,
            lat, lng, accuracy_m, client_id, retention_expires_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now', ?))
          -- The WHERE is required, not decorative: the unique index on
          -- (tenant_id, client_id) is PARTIAL (it excludes null client ids, so
          -- an online arrival with no idempotency key is never blocked by
          -- another one). SQLite only matches an ON CONFLICT target to a partial
          -- index when the predicate is repeated here, and without it every
          -- insert raises "ON CONFLICT clause does not match any PRIMARY KEY or
          -- UNIQUE constraint" - which this route would then swallow, silently
          -- recording no arrivals at all.
          ON CONFLICT(tenant_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
        `).run(
          tenantId, repId, uid(req), leadId, session.id, new Date().toISOString(),
          hasFix ? lat : null, hasFix ? lng : null,
          Number.isFinite(Number(req.body?.accuracyM)) ? Number(req.body.accuracyM) : null,
          typeof req.body?.clientId === "string" ? req.body.clientId.slice(0, 64) : null,
          `+${retentionDays} days`,
        );
        res.json({ recorded: true, locationVerified: hasFix });
      } catch (e: any) {
        // The CALLER is never failed - see the doc comment. But the failure is
        // logged rather than swallowed silently: a broken insert here means no
        // arrival is ever recorded and every dwell time is null, and the only
        // symptom is a metric that is quietly always empty. That is exactly the
        // class of bug that survives for months, so it gets a log line.
        structuredLog("rep_metrics.arrival_write_failed", {
          repId, leadId, error: String(e?.message ?? e),
        }, "warn");
        res.json({ recorded: false, reason: "write_failed" });
      }
    });

  /** The end-of-shift summary the brief specifies. Read-only; ending the shift
   *  itself stays on the existing /api/clock/out route. */
  app.get("/api/field-mode/summary", requireAuth, requireCapability("field.app.use"),
    (req: Request, res: Response) => {
      const repId = myRepId(req);
      const tenantId = tid(req);
      if (repId == null || tenantId == null) return res.json({ hasSeat: false });

      const timezone = tenantTimezone(tenantId);
      const today = localDateString(Date.now(), timezone);
      const rows = readDailyRows(tenantId, [repId], today, today);
      const facts = rows.length > 0 ? rows[0] : emptyFacts();

      // Personal best and the trailing comparison, both from the rollup.
      const priorFrom = localDateString(Date.now() - 30 * 86_400_000, timezone);
      const prior = readDailyRows(tenantId, [repId], priorFrom, today)
        .filter((r) => r.metricDate !== today);
      const bestDoors = prior.length > 0 ? Math.max(...prior.map((r) => r.doorsAttempted)) : 0;
      const priorAvg = prior.length > 0
        ? prior.reduce((s, r) => s + r.doorsAttempted, 0) / prior.length
        : null;

      res.json({
        hasSeat: true,
        date: today,
        facts,
        metrics: deriveMetrics(facts),
        comparison: {
          personalBestDoors: bestDoors,
          priorAverageDoors: priorAvg,
          isPersonalBest: facts.doorsAttempted > bestDoors && facts.doorsAttempted > 0,
        },
      });
    });

  // ── Field Activity & Privacy settings ──────────────────────────────────────

  app.get("/api/metrics/settings", requireAuth, requireCapability("settings.manage.org"),
    (req: Request, res: Response) => {
      res.json({ settings: readPolicy(tid(req)) });
    });

  app.put("/api/metrics/settings", requireAuth, requireCapability("settings.manage.org"),
    (req: Request, res: Response) => {
      const tenantId = tid(req);
      if (tenantId == null) return res.status(400).json({ error: "No tenant" });
      const before = readPolicy(tenantId);

      const int = (v: unknown, lo: number, hi: number, fallback: number) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
      };
      const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
      const b = req.body ?? {};

      const next = {
        captureInterval: ["battery_saver", "standard", "high"].includes(String(b.captureInterval))
          ? String(b.captureInterval) : before.captureInterval,
        requireAcknowledgment: bool(b.requireAcknowledgment, before.requireAcknowledgment),
        requireActiveShift: bool(b.requireActiveShift, before.requireActiveShift),
        allowTeamLeadLive: bool(b.allowTeamLeadLive, before.allowTeamLeadLive),
        allowManagerLive: bool(b.allowManagerLive, before.allowManagerLive),
        requireLocationForDisposition: bool(b.requireLocationForDisposition, before.requireLocationForDisposition),
        graceRadiusM: int(b.graceRadiusM, 10, 500, before.graceRadiusM),
        minDwellSeconds: int(b.minDwellSeconds, 0, 600, before.minDwellSeconds),
        rawTrailsVisible: bool(b.rawTrailsVisible, before.rawTrailsVisible),
        requireReacknowledgeOnChange: bool(b.requireReacknowledgeOnChange, before.requireReacknowledgeOnChange),
        chargebackBasis: b.chargebackBasis === "submitted" ? "submitted" : "paid",
        leaderboardsEnabled: bool(b.leaderboardsEnabled, before.leaderboardsEnabled),
        repSeesTeamBenchmarks: bool(b.repSeesTeamBenchmarks, before.repSeesTeamBenchmarks),
        privacyNoticeText: typeof b.privacyNoticeText === "string"
          ? b.privacyNoticeText.slice(0, 20000) : before.privacyNoticeText,
        // Retention stays clamped by the same floor and ceiling the prune job
        // enforces, so no admin setting can ever mean "keep forever".
        retentionDays: int(b.retentionDays, 1, 90, before.retentionDays),
      };

      rawDb.prepare(`
        INSERT INTO field_location_policy (tenant_id, updated_by, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(tenant_id) DO NOTHING
      `).run(tenantId, uid(req));

      rawDb.prepare(`
        UPDATE field_location_policy SET
          capture_interval = ?, require_acknowledgment = ?, require_active_shift = ?,
          allow_team_lead_live = ?, allow_manager_live = ?, require_location_for_disposition = ?,
          grace_radius_m = ?, min_dwell_seconds = ?, raw_trails_visible = ?,
          require_reacknowledge_on_change = ?, chargeback_basis = ?, leaderboards_enabled = ?,
          rep_sees_team_benchmarks = ?, privacy_notice_text = ?, retention_days = ?,
          updated_by = ?, updated_at = datetime('now')
        WHERE tenant_id = ?
      `).run(
        next.captureInterval, next.requireAcknowledgment ? 1 : 0, next.requireActiveShift ? 1 : 0,
        next.allowTeamLeadLive ? 1 : 0, next.allowManagerLive ? 1 : 0,
        next.requireLocationForDisposition ? 1 : 0,
        next.graceRadiusM, next.minDwellSeconds, next.rawTrailsVisible ? 1 : 0,
        next.requireReacknowledgeOnChange ? 1 : 0, next.chargebackBasis,
        next.leaderboardsEnabled ? 1 : 0, next.repSeesTeamBenchmarks ? 1 : 0,
        next.privacyNoticeText, next.retentionDays,
        uid(req), tenantId,
      );

      // "Who changed the location policy, when, and from what" is the first
      // question anyone will ask, so it lands in the trigger-protected audit
      // table with a full before/after rather than the ordinary activity log.
      recordAdminAudit({
        ...auditContext(req),
        action: "metrics.field_privacy_settings_changed",
        targetType: "tenant",
        targetId: tenantId,
        before, after: next,
        tenantId,
        outcome: "success",
      });

      res.json({ settings: readPolicy(tenantId) });
    });
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function readRetentionDays(tenantId: number | null): number {
  try {
    const r = rawDb.prepare(
      `SELECT retention_days AS d FROM field_location_policy WHERE tenant_id = ?`,
    ).get(tenantId) as any;
    const n = Number(r?.d);
    return Number.isFinite(n) ? Math.max(1, Math.min(90, n)) : 7;
  } catch { return 7; }
}

function readPolicy(tenantId: number | null) {
  const fallback = {
    mode: "off", retentionDays: 7, captureInterval: "standard",
    requireAcknowledgment: true, requireActiveShift: true,
    allowTeamLeadLive: false, allowManagerLive: true,
    requireLocationForDisposition: false, graceRadiusM: 75, minDwellSeconds: 0,
    rawTrailsVisible: false, requireReacknowledgeOnChange: true,
    chargebackBasis: "paid", leaderboardsEnabled: true, repSeesTeamBenchmarks: true,
    privacyNoticeText: null as string | null,
  };
  try {
    const r = rawDb.prepare(
      `SELECT * FROM field_location_policy WHERE tenant_id = ?`,
    ).get(tenantId) as any;
    if (!r) return fallback;
    return {
      mode: String(r.mode ?? "off"),
      retentionDays: Number(r.retention_days ?? 7),
      captureInterval: String(r.capture_interval ?? "standard"),
      requireAcknowledgment: Number(r.require_acknowledgment ?? 1) !== 0,
      requireActiveShift: Number(r.require_active_shift ?? 1) !== 0,
      allowTeamLeadLive: Number(r.allow_team_lead_live ?? 0) !== 0,
      allowManagerLive: Number(r.allow_manager_live ?? 1) !== 0,
      requireLocationForDisposition: Number(r.require_location_for_disposition ?? 0) !== 0,
      graceRadiusM: Number(r.grace_radius_m ?? 75),
      minDwellSeconds: Number(r.min_dwell_seconds ?? 0),
      rawTrailsVisible: Number(r.raw_trails_visible ?? 0) !== 0,
      requireReacknowledgeOnChange: Number(r.require_reacknowledge_on_change ?? 1) !== 0,
      chargebackBasis: String(r.chargeback_basis ?? "paid"),
      leaderboardsEnabled: Number(r.leaderboards_enabled ?? 1) !== 0,
      repSeesTeamBenchmarks: Number(r.rep_sees_team_benchmarks ?? 1) !== 0,
      privacyNoticeText: r.privacy_notice_text ?? null,
    };
  } catch { return fallback; }
}

function readInsights(tenantId: number, repIds: readonly number[], includeDismissed: boolean) {
  if (repIds.length === 0) return [];
  const placeholders = repIds.map(() => "?").join(",");
  try {
    const rows = rawDb.prepare(`
      SELECT i.id, i.rep_id AS repId, tm.name AS repName, i.period_start AS periodStart,
             i.period_end AS periodEnd, i.insight_type AS insightType, i.severity,
             i.title, i.explanation, i.suggested_action AS suggestedAction,
             i.supporting_metrics_json AS supportingMetricsJson, i.data_link AS dataLink,
             i.acknowledged_at AS acknowledgedAt, i.dismissed_at AS dismissedAt
        FROM rep_coaching_insights i
        LEFT JOIN team_members tm ON tm.id = i.rep_id
       WHERE i.tenant_id = ? AND i.rep_id IN (${placeholders})
         ${includeDismissed ? "" : "AND i.dismissed_at IS NULL"}
       ORDER BY
         CASE i.severity WHEN 'urgent' THEN 0 WHEN 'coaching_needed' THEN 1
                         WHEN 'positive' THEN 2 ELSE 3 END,
         i.period_end DESC
       LIMIT ?
    `).all(tenantId, ...repIds, INSIGHT_ROW_CAP) as any[];
    return rows.map((r) => ({
      ...r,
      supportingMetrics: safeJson(r.supportingMetricsJson),
      supportingMetricsJson: undefined,
    }));
  } catch { return []; }
}

function readNotes(tenantId: number, repId: number) {
  try {
    return rawDb.prepare(`
      SELECT n.id, n.body, n.shared_with_rep AS sharedWithRep, n.goal_metric AS goalMetric,
             n.goal_target AS goalTarget, n.goal_due_date AS goalDueDate,
             n.goal_status AS goalStatus, n.review_at AS reviewAt,
             n.created_at AS createdAt, u.name AS authorName
        FROM rep_coaching_notes n
        LEFT JOIN users u ON u.id = n.author_user_id
       WHERE n.tenant_id = ? AND n.rep_id = ?
       ORDER BY n.created_at DESC LIMIT 200
    `).all(tenantId, repId);
  } catch { return []; }
}

function loadShiftHistory(repId: number, from: string, to: string) {
  try {
    return rawDb.prepare(`
      SELECT id, clocked_in AS clockedIn, clocked_out AS clockedOut,
             duration_minutes AS durationMinutes, date
        FROM clock_sessions
       WHERE rep_id = ? AND date BETWEEN ? AND ?
       ORDER BY clocked_in DESC LIMIT 100
    `).all(repId, from, to);
  } catch { return []; }
}

function territoryFactsFromRow(r: any): TerritoryFacts {
  return {
    territoryId: Number(r.territory_id),
    territoryName: String(r.territoryName ?? ""),
    eligibleDoors: Number(r.eligible_doors ?? 0),
    assignedDoors: Number(r.assigned_doors ?? 0),
    unassignedDoors: Number(r.unassigned_doors ?? 0),
    doorsAttempted: Number(r.doors_attempted ?? 0),
    verifiedVisits: Number(r.verified_visits ?? 0),
    everWorkedDoors: Number(r.ever_worked_doors ?? 0),
    contacts: Number(r.contacts ?? 0),
    submittedOrders: Number(r.submitted_orders ?? 0),
    installedOrders: Number(r.installed_orders ?? 0),
    paidOrders: Number(r.paid_orders ?? 0),
    freshAssigned: Number(r.fresh_assigned ?? 0),
    freshAttempted: Number(r.fresh_attempted ?? 0),
    activeRepCount: Number(r.active_rep_count ?? 0),
    lastActivityAtMs: parseTs(r.last_activity_at),
    assignedAtMs: parseTs(r.assigned_at),
    callbacksDue: Number(r.callbacks_due ?? 0),
    openRecoveryCases: Number(r.open_recovery_cases ?? 0),
    estimatedCommissionCents: Number(r.estimated_commission_cents ?? 0),
    paidCommissionCents: Number(r.paid_commission_cents ?? 0),
  };
}

function parseAssignees(assigneeIds: unknown, repId: unknown): number[] {
  if (typeof assigneeIds === "string") {
    try {
      const parsed = JSON.parse(assigneeIds);
      if (Array.isArray(parsed)) return parsed.filter((n): n is number => typeof n === "number");
    } catch { /* legacy row - fall through to repId */ }
  }
  const r = Number(repId);
  return Number.isFinite(r) && r > 0 ? [r] : [];
}

function safeJson(v: unknown): unknown {
  if (typeof v !== "string") return null;
  try { return JSON.parse(v); } catch { return null; }
}

/**
 * One audit row per viewer per window, not one per poll.
 *
 * Same device and same reasoning as liveOpsRoutes: a dashboard refreshing every
 * ten seconds would otherwise file 360 rows an hour per viewer, and an audit
 * trail nobody can read is the same as no audit trail.
 */
const VIEW_COALESCE_MS = 15 * 60_000;
const lastViewLog = new Map<string, number>();
function logViewOnce(userId: number | null, tenantId: number | null, action: string, details?: any) {
  if (userId == null) return;
  const key = `${userId}:${action}`;
  const now = Date.now();
  if (now - (lastViewLog.get(key) ?? 0) < VIEW_COALESCE_MS) return;
  lastViewLog.set(key, now);
  try { storage.logActivity(userId, action, "metrics", undefined, details, undefined, tenantId ?? undefined); }
  catch { /* audit must never break the read */ }
}
