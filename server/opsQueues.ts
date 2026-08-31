// ── Operations command center: the queue rules ────────────────────────────────
// Every queue here is a DETERMINISTIC rule over verified columns - the rule
// string each entry carries is rendered verbatim in the UI, so what the
// manager reads is exactly what the SQL below does. No scores are invented:
// lead_score and buyer_score are existing, documented columns
// (shared/schema.ts:234-241), and every other signal is a date or status
// comparison a person can check by opening the record.
//
// Scope contract: callers pass the SAME repIds that leadVisibilityScope hands
// the assignment endpoints (undefined = whole tenant, [-1] = fail-closed
// empty), so a row shown here is a row the caller could act on - the
// permission-level twin of the lasso's preview/apply parity. Queues marked
// managerOnly need the unrestricted scope (they reach pool doors or
// audit-plane data a team_lead's lead surfaces never show).
import { rawDb } from "./db";
import { storage, orgTimezoneFor } from "./storage";
import { localYmdParts } from "@shared/workweek";

export interface OpsScope {
  tenantId: number | null;
  /** undefined = whole tenant; [] or [-1] = nothing (fail-closed). */
  repIds?: number[];
}

export interface OpsParams {
  /** "Not worked" window after assignment, hours. */
  windowHours: number;
  /** "Gone quiet" window for previously-worked leads, days. */
  staleDays: number;
  nowMs: number;
}

export interface OpsQueueSummary {
  key: string;
  label: string;
  rule: string;
  count: number;
  /** Queues a scoped (team-lead) caller does not receive. */
  managerOnly: boolean;
  /** false for the workload table (rows are reps, not dismissible work). */
  dismissible: boolean;
}

const ACTIVE_IN = `('prospect','contacted','interested','follow_up')`;
export const OPS_ROW_LIMIT = 200;
const PARTIAL_WRITE_ACTIONS = `('lead.assign_selection','lead.bulk_assign','lead.assign_selection.undo')`;

// Clamps mirror the UI's own bounds so a hand-crafted request cannot turn a
// queue into a full-table sweep of ancient history.
export function clampWindowHours(v: unknown): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(24 * 30, Math.max(1, n)) : 48;
}
export function clampStaleDays(v: unknown): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 14;
}

function tenantSql(column: string): string {
  return `${column} IS ?`; // IS matches NULL and values alike - exact wall
}

function scopeSql(scope: OpsScope, column: string): { sql: string; args: number[] } {
  if (scope.repIds === undefined) return { sql: "", args: [] };
  const ids = scope.repIds.length ? scope.repIds : [-1];
  return { sql: ` AND ${column} IN (${ids.map(() => "?").join(",")})`, args: ids };
}

// Rows the caller has dismissed (and whose dismissal has not lapsed) stay out
// of every list and count, so a dismissal is a real answer, not a hidden one.
function notDismissedSql(entityIdColumn: string): string {
  return ` AND NOT EXISTS (
    SELECT 1 FROM ops_dismissals d
     WHERE d.tenant_id IS ? AND d.queue_key = ? AND d.entity_kind = ?
       AND d.entity_id = ${entityIdColumn} AND d.expires_at > ?
  )`;
}

function isoDaysAgo(nowMs: number, days: number): string {
  return new Date(nowMs - days * 86_400_000).toISOString();
}

/** Org-local calendar day, the same clock the follow-up surfaces read. */
function todayLocal(tenantId: number | null, nowMs: number): string {
  const tz = orgTimezoneFor(tenantId ?? undefined);
  const { y, mo, d } = localYmdParts(nowMs, tz);
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

interface QueueDef {
  label: string;
  managerOnly: boolean;
  dismissible: boolean;
  entityKind: "lead" | "activity";
  rule: (p: OpsParams) => string;
  count: (scope: OpsScope, p: OpsParams) => number;
  rows: (scope: OpsScope, p: OpsParams) => any[];
}

// ── assigned_unworked - the flagship queue ────────────────────────────────────
function assignedUnworkedWhere(scope: OpsScope, p: OpsParams) {
  const cutoff = new Date(p.nowMs - p.windowHours * 3_600_000).toISOString();
  const sc = scopeSql(scope, "l.assigned_rep_id");
  const sql = `FROM leads l
    WHERE ${tenantSql("l.tenant_id")}
      AND l.assigned_rep_id IS NOT NULL
      AND l.assigned_at IS NOT NULL AND l.assigned_at <= ?
      AND (l.last_outcome_at IS NULL OR l.last_outcome_at < l.assigned_at)
      AND l.lead_status IN ${ACTIVE_IN}${sc.sql}${notDismissedSql("l.id")}`;
  const args = [scope.tenantId, cutoff, ...sc.args, scope.tenantId, "assigned_unworked", "lead", new Date(p.nowMs).toISOString()];
  return { sql, args };
}

// ── followups_overdue - the aggregator's proven latest-knock pattern ─────────
function followupsOverdueWhere(scope: OpsScope, p: OpsParams) {
  const today = todayLocal(scope.tenantId, p.nowMs);
  const sc = scopeSql(scope, "l.assigned_rep_id");
  const sql = `FROM knock_log k
    JOIN leads l ON l.id = k.lead_id
    WHERE ${tenantSql("k.tenant_id")}
      AND k.callback_date IS NOT NULL
      AND k.callback_date < ?
      AND COALESCE(k.superseded, 0) = 0
      AND NOT EXISTS (
        SELECT 1 FROM knock_log later
         WHERE later.lead_id = k.lead_id
           AND replace(later.knocked_at,'T',' ') > replace(k.knocked_at,'T',' ')
      )
      AND l.lead_status IN ${ACTIVE_IN}${sc.sql}${notDismissedSql("l.id")}`;
  const args = [scope.tenantId, today, ...sc.args, scope.tenantId, "followups_overdue", "lead", new Date(p.nowMs).toISOString()];
  return { sql, args };
}

function unassignedHotWhere(scope: OpsScope, p: OpsParams) {
  const sql = `FROM leads l
    WHERE ${tenantSql("l.tenant_id")}
      AND l.assigned_rep_id IS NULL
      AND l.lead_status IN ${ACTIVE_IN}
      AND (l.assign_mark = 'priority' OR COALESCE(l.lead_score,0) >= 70 OR COALESCE(l.buyer_score,0) >= 8)${notDismissedSql("l.id")}`;
  const args = [scope.tenantId, scope.tenantId, "unassigned_hot", "lead", new Date(p.nowMs).toISOString()];
  return { sql, args };
}

function staleActiveWhere(scope: OpsScope, p: OpsParams) {
  const cutoff = isoDaysAgo(p.nowMs, p.staleDays);
  const sc = scopeSql(scope, "l.assigned_rep_id");
  const sql = `FROM leads l
    WHERE ${tenantSql("l.tenant_id")}
      AND l.assigned_rep_id IS NOT NULL
      AND l.last_outcome_at IS NOT NULL AND l.last_outcome_at <= ?
      AND l.lead_status IN ('prospect','contacted','interested')${sc.sql}${notDismissedSql("l.id")}`;
  const args = [scope.tenantId, cutoff, ...sc.args, scope.tenantId, "stale_active", "lead", new Date(p.nowMs).toISOString()];
  return { sql, args };
}

function inactiveRepWhere(scope: OpsScope, p: OpsParams) {
  const sc = scopeSql(scope, "t.id");
  const sql = `FROM leads l
    JOIN team_members t ON t.id = l.assigned_rep_id
    WHERE ${tenantSql("l.tenant_id")}
      AND t.active = 0
      AND l.lead_status IN ${ACTIVE_IN}${sc.sql}${notDismissedSql("l.id")}`;
  const args = [scope.tenantId, ...sc.args, scope.tenantId, "inactive_rep_holdings", "lead", new Date(p.nowMs).toISOString()];
  return { sql, args };
}

function territoryConflictWhere(scope: OpsScope, p: OpsParams) {
  const sql = `FROM leads l
    LEFT JOIN territories tr ON tr.id = l.assigned_territory_id
    WHERE ${tenantSql("l.tenant_id")}
      AND l.assigned_territory_id IS NOT NULL
      AND (tr.id IS NULL OR tr.status = 'archived')${notDismissedSql("l.id")}`;
  const args = [scope.tenantId, scope.tenantId, "territory_link_conflicts", "lead", new Date(p.nowMs).toISOString()];
  return { sql, args };
}

const LEAD_ROW_SELECT = `l.id, l.address, l.city, l.state, l.zip, l.lead_status AS leadStatus,
  l.assigned_rep_id AS assignedRepId, l.assigned_at AS assignedAt,
  l.last_outcome AS lastOutcome, l.last_outcome_at AS lastOutcomeAt,
  l.lead_score AS leadScore, l.buyer_score AS buyerScore, l.assign_mark AS assignMark`;

function repNamesFor(rows: any[], tenantId: number | null): Map<number, string> {
  const ids = [...new Set(rows.map(r => r.assignedRepId).filter((v: any) => v != null))] as number[];
  const map = new Map<number, string>();
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(",");
  for (const t of rawDb.prepare(
    `SELECT id, name FROM team_members WHERE ${tenantSql("tenant_id")} AND id IN (${placeholders})`,
  ).all(tenantId, ...ids) as any[]) {
    map.set(t.id, t.name);
  }
  return map;
}

function withRepNames(rows: any[], tenantId: number | null): any[] {
  const names = repNamesFor(rows, tenantId);
  return rows.map(r => ({ ...r, repName: r.assignedRepId != null ? names.get(r.assignedRepId) ?? null : null }));
}

export const OPS_QUEUES: Record<string, QueueDef> = {
  assigned_unworked: {
    label: "Assigned but not worked",
    managerOnly: false,
    dismissible: true,
    entityKind: "lead",
    rule: p => `Assigned more than ${p.windowHours} hours ago with no recorded door activity since the assignment, and still in an active status.`,
    count(scope, p) {
      const w = assignedUnworkedWhere(scope, p);
      return Number((rawDb.prepare(`SELECT COUNT(*) AS n ${w.sql}`).get(...w.args) as any)?.n ?? 0);
    },
    rows(scope, p) {
      const w = assignedUnworkedWhere(scope, p);
      const rows = rawDb.prepare(
        `SELECT ${LEAD_ROW_SELECT} ${w.sql} ORDER BY l.assigned_at ASC LIMIT ${OPS_ROW_LIMIT}`,
      ).all(...w.args) as any[];
      return withRepNames(rows, scope.tenantId).map(r => ({
        ...r,
        reason: r.lastOutcomeAt == null
          ? "No door activity has ever been recorded on this lead."
          : "Last door activity predates the current assignment.",
      }));
    },
  },

  unassigned_hot: {
    label: "Unassigned priority leads",
    managerOnly: true,
    dismissible: true,
    entityKind: "lead",
    rule: () => "In the pool (no assigned rep), active status, and at least one of: marked priority, lead score 70+, buyer score 8+.",
    count(scope, p) {
      const w = unassignedHotWhere(scope, p);
      return Number((rawDb.prepare(`SELECT COUNT(*) AS n ${w.sql}`).get(...w.args) as any)?.n ?? 0);
    },
    rows(scope, p) {
      const w = unassignedHotWhere(scope, p);
      const rows = rawDb.prepare(
        `SELECT ${LEAD_ROW_SELECT} ${w.sql}
          ORDER BY COALESCE(l.buyer_score,0) DESC, COALESCE(l.lead_score,0) DESC LIMIT ${OPS_ROW_LIMIT}`,
      ).all(...w.args) as any[];
      return rows.map(r => {
        const factors: string[] = [];
        if (r.assignMark === "priority") factors.push("marked priority");
        if ((r.leadScore ?? 0) >= 70) factors.push(`lead score ${r.leadScore}`);
        if ((r.buyerScore ?? 0) >= 8) factors.push(`buyer score ${r.buyerScore}`);
        return { ...r, repName: null, reason: factors.join(" · ") };
      });
    },
  },

  followups_overdue: {
    label: "Overdue follow-ups",
    managerOnly: false,
    dismissible: true,
    entityKind: "lead",
    rule: () => "The lead's most recent door visit scheduled a return date that has passed (org-local calendar), and the lead is still in an active status.",
    count(scope, p) {
      const w = followupsOverdueWhere(scope, p);
      return Number((rawDb.prepare(`SELECT COUNT(DISTINCT k.lead_id) AS n ${w.sql}`).get(...w.args) as any)?.n ?? 0);
    },
    rows(scope, p) {
      const w = followupsOverdueWhere(scope, p);
      const rows = rawDb.prepare(
        `SELECT ${LEAD_ROW_SELECT}, k.callback_date AS callbackDate, k.callback_time AS callbackTime ${w.sql}
          ORDER BY k.callback_date ASC LIMIT ${OPS_ROW_LIMIT}`,
      ).all(...w.args) as any[];
      return withRepNames(rows, scope.tenantId).map(r => ({
        ...r,
        reason: `Follow-up was due ${r.callbackDate}${r.callbackTime ? ` at ${r.callbackTime}` : ""}.`,
      }));
    },
  },

  stale_active: {
    label: "Gone quiet",
    managerOnly: false,
    dismissible: true,
    entityKind: "lead",
    rule: p => `Worked at least once, but no door activity in ${p.staleDays}+ days, and still prospect/contacted/interested.`,
    count(scope, p) {
      const w = staleActiveWhere(scope, p);
      return Number((rawDb.prepare(`SELECT COUNT(*) AS n ${w.sql}`).get(...w.args) as any)?.n ?? 0);
    },
    rows(scope, p) {
      const w = staleActiveWhere(scope, p);
      const rows = rawDb.prepare(
        `SELECT ${LEAD_ROW_SELECT} ${w.sql} ORDER BY l.last_outcome_at ASC LIMIT ${OPS_ROW_LIMIT}`,
      ).all(...w.args) as any[];
      return withRepNames(rows, scope.tenantId).map(r => ({
        ...r,
        reason: `Last activity ${String(r.lastOutcomeAt).slice(0, 10)}.`,
      }));
    },
  },

  inactive_rep_holdings: {
    label: "Held by a deactivated rep",
    managerOnly: false,
    dismissible: true,
    entityKind: "lead",
    rule: () => "Assigned to a roster member whose account is deactivated - offboarding never moves doors, so these are parked until a manager reassigns them.",
    count(scope, p) {
      const w = inactiveRepWhere(scope, p);
      return Number((rawDb.prepare(`SELECT COUNT(*) AS n ${w.sql}`).get(...w.args) as any)?.n ?? 0);
    },
    rows(scope, p) {
      const w = inactiveRepWhere(scope, p);
      const rows = rawDb.prepare(
        `SELECT ${LEAD_ROW_SELECT}, t.name AS repName ${w.sql} ORDER BY t.name, l.id LIMIT ${OPS_ROW_LIMIT}`,
      ).all(...w.args) as any[];
      return rows.map(r => ({ ...r, reason: `${r.repName} is deactivated.` }));
    },
  },

  territory_link_conflicts: {
    label: "Broken territory links",
    managerOnly: true,
    dismissible: true,
    entityKind: "lead",
    rule: () => "assigned_territory_id points at a territory that no longer exists or is archived. Read-only: reconciliation is an open product decision (docs/OPEN_DECISIONS-2026-08-30.md §3).",
    count(scope, p) {
      const w = territoryConflictWhere(scope, p);
      return Number((rawDb.prepare(`SELECT COUNT(*) AS n ${w.sql}`).get(...w.args) as any)?.n ?? 0);
    },
    rows(scope, p) {
      const w = territoryConflictWhere(scope, p);
      const rows = rawDb.prepare(
        `SELECT ${LEAD_ROW_SELECT}, l.assigned_territory_id AS territoryId,
                tr.id AS trId, tr.status AS trStatus, tr.name AS trName ${w.sql}
          ORDER BY l.assigned_territory_id, l.id LIMIT ${OPS_ROW_LIMIT}`,
      ).all(...w.args) as any[];
      return withRepNames(rows, scope.tenantId).map(r => ({
        ...r,
        reason: r.trId == null
          ? `Territory #${r.territoryId} no longer exists.`
          : `Territory "${r.trName}" is archived.`,
      }));
    },
  },

  partial_writes: {
    label: "Partial bulk writes",
    managerOnly: true,
    dismissible: true,
    entityKind: "activity",
    rule: () => "A bulk assignment or undo reported incomplete:true in the last 7 days - some chunks committed, the rest did not. Verify the affected area and re-run if needed.",
    count(scope, p) {
      const since = isoDaysAgo(p.nowMs, 7);
      return Number((rawDb.prepare(
        `SELECT COUNT(*) AS n FROM activity_log a
          WHERE ${tenantSql("a.tenant_id")} AND a.at >= ?
            AND a.action IN ${PARTIAL_WRITE_ACTIONS}
            AND a.details LIKE '%"incomplete":true%'${notDismissedSql("a.id")}`,
      ).get(scope.tenantId, since, scope.tenantId, "partial_writes", "activity", new Date(p.nowMs).toISOString()) as any)?.n ?? 0);
    },
    rows(scope, p) {
      const since = isoDaysAgo(p.nowMs, 7);
      const rows = rawDb.prepare(
        `SELECT a.id, a.action, a.at, a.details, a.user_id AS userId FROM activity_log a
          WHERE ${tenantSql("a.tenant_id")} AND a.at >= ?
            AND a.action IN ${PARTIAL_WRITE_ACTIONS}
            AND a.details LIKE '%"incomplete":true%'${notDismissedSql("a.id")}
          ORDER BY a.at DESC LIMIT 50`,
      ).all(scope.tenantId, since, scope.tenantId, "partial_writes", "activity", new Date(p.nowMs).toISOString()) as any[];
      return rows.map(r => {
        let d: any = {};
        try { d = JSON.parse(r.details ?? "{}"); } catch { /* keep {} */ }
        return {
          id: r.id,
          action: r.action,
          at: r.at,
          updated: d.updated ?? d.restored ?? null,
          skipped: d.skipped ?? null,
          repId: d.repId ?? d.appliedRepId ?? null,
          reason: `${r.action} stopped part-way: ${d.updated ?? d.restored ?? "?"} committed, remainder untouched.`,
        };
      });
    },
  },
};

// ── Workload distribution (rows are reps, not dismissible work) ──────────────
export interface OpsWorkloadRow {
  repId: number;
  name: string;
  active: boolean;
  onShift: boolean;
  activeLeads: number;
  unworked: number;
  overdueFollowUps: number;
  areasHeld: number;
  areaCap: number;
  lastActivityAt: string | null;
}

export function opsWorkload(scope: OpsScope, p: OpsParams): OpsWorkloadRow[] {
  const members = storage.getTeamMembers(scope.tenantId ?? undefined)
    .filter((m: any) => m.active !== false)
    .filter((m: any) => scope.repIds === undefined || scope.repIds.includes(m.id));
  if (!members.length) return [];
  const ids = members.map((m: any) => m.id);
  const ph = ids.map(() => "?").join(",");
  const cutoff = new Date(p.nowMs - p.windowHours * 3_600_000).toISOString();
  const today = todayLocal(scope.tenantId, p.nowMs);

  const leadAgg = new Map<number, { active: number; unworked: number; last: string | null }>();
  for (const r of rawDb.prepare(
    `SELECT l.assigned_rep_id AS repId,
            COUNT(*) AS activeLeads,
            SUM(CASE WHEN l.assigned_at IS NOT NULL AND l.assigned_at <= ?
                      AND (l.last_outcome_at IS NULL OR l.last_outcome_at < l.assigned_at)
                     THEN 1 ELSE 0 END) AS unworked,
            MAX(l.last_outcome_at) AS lastActivityAt
       FROM leads l
      WHERE ${tenantSql("l.tenant_id")} AND l.assigned_rep_id IN (${ph})
        AND l.lead_status IN ${ACTIVE_IN}
      GROUP BY l.assigned_rep_id`,
  ).all(cutoff, scope.tenantId, ...ids) as any[]) {
    leadAgg.set(r.repId, { active: r.activeLeads, unworked: r.unworked ?? 0, last: r.lastActivityAt ?? null });
  }

  const overdue = new Map<number, number>();
  for (const r of rawDb.prepare(
    `SELECT l.assigned_rep_id AS repId, COUNT(DISTINCT k.lead_id) AS n
       FROM knock_log k JOIN leads l ON l.id = k.lead_id
      WHERE ${tenantSql("k.tenant_id")} AND l.assigned_rep_id IN (${ph})
        AND k.callback_date IS NOT NULL AND k.callback_date < ?
        AND COALESCE(k.superseded,0) = 0
        AND l.lead_status IN ${ACTIVE_IN}
        AND NOT EXISTS (
          SELECT 1 FROM knock_log later
           WHERE later.lead_id = k.lead_id
             AND replace(later.knocked_at,'T',' ') > replace(k.knocked_at,'T',' ')
        )
      GROUP BY l.assigned_rep_id`,
  ).all(scope.tenantId, ...ids, today) as any[]) {
    overdue.set(r.repId, r.n);
  }

  const onShift = new Set<number>(
    (rawDb.prepare(
      `SELECT rep_id FROM clock_sessions WHERE ${tenantSql("tenant_id")} AND clocked_out IS NULL AND rep_id IN (${ph})`,
    ).all(scope.tenantId, ...ids) as any[]).map(r => r.rep_id),
  );

  return members.map((m: any) => {
    const agg = leadAgg.get(m.id);
    // Same definition the assignment cap enforces (active|shared, per rep).
    const areas = storage.getTerritoriesByRep(m.id, scope.tenantId ?? undefined)
      .filter((t: any) => t.status === "active" || t.status === "shared").length;
    return {
      repId: m.id,
      name: m.name,
      active: m.active !== false,
      onShift: onShift.has(m.id),
      activeLeads: agg?.active ?? 0,
      unworked: agg?.unworked ?? 0,
      overdueFollowUps: overdue.get(m.id) ?? 0,
      areasHeld: areas,
      areaCap: 5,
      lastActivityAt: agg?.last ?? null,
    };
  }).sort((a, b) => b.unworked - a.unworked || b.activeLeads - a.activeLeads);
}

// ── Overview (counts for every visible queue) ────────────────────────────────
// Memoized briefly per (tenant, scope, params): eight COUNT queries per poll
// per viewer adds up, and a 30-second-old count is fine for a triage surface.
const overviewMemo = new Map<string, { at: number; body: OpsQueueSummary[] }>();
const OVERVIEW_MEMO_MS = 30_000;

export function opsOverview(scope: OpsScope, p: OpsParams): OpsQueueSummary[] {
  const scopeKey = scope.repIds === undefined ? "all" : [...scope.repIds].sort((a, b) => a - b).join(",");
  const key = `${scope.tenantId ?? "null"}|${scopeKey}|${p.windowHours}|${p.staleDays}`;
  const hit = overviewMemo.get(key);
  if (hit && p.nowMs - hit.at < OVERVIEW_MEMO_MS) return hit.body;

  const out: OpsQueueSummary[] = [];
  for (const [queueKey, def] of Object.entries(OPS_QUEUES)) {
    if (def.managerOnly && scope.repIds !== undefined) continue;
    out.push({
      key: queueKey,
      label: def.label,
      rule: def.rule(p),
      count: def.count(scope, p),
      managerOnly: def.managerOnly,
      dismissible: def.dismissible,
    });
  }
  if (overviewMemo.size > 200) overviewMemo.clear();
  overviewMemo.set(key, { at: p.nowMs, body: out });
  return out;
}

export function opsQueueRows(queueKey: string, scope: OpsScope, p: OpsParams) {
  const def = OPS_QUEUES[queueKey];
  if (!def) return null;
  if (def.managerOnly && scope.repIds !== undefined) return null;
  return {
    key: queueKey,
    label: def.label,
    rule: def.rule(p),
    total: def.count(scope, p),
    limit: OPS_ROW_LIMIT,
    entityKind: def.entityKind,
    dismissible: def.dismissible,
    rows: def.rows(scope, p),
  };
}

// ── Dismissals ───────────────────────────────────────────────────────────────
export function dismissOpsRow(opts: {
  tenantId: number | null;
  queueKey: string;
  entityKind: "lead" | "activity";
  entityId: number;
  reason: string;
  userId: number;
  days: number;
  nowMs: number;
}): void {
  const now = new Date(opts.nowMs).toISOString();
  const expires = new Date(opts.nowMs + opts.days * 86_400_000).toISOString();
  rawDb.prepare(
    `INSERT INTO ops_dismissals (tenant_id, queue_key, entity_kind, entity_id, reason, dismissed_by_user_id, dismissed_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, queue_key, entity_kind, entity_id)
     DO UPDATE SET reason = excluded.reason,
                   dismissed_by_user_id = excluded.dismissed_by_user_id,
                   dismissed_at = excluded.dismissed_at,
                   expires_at = excluded.expires_at`,
  ).run(opts.tenantId, opts.queueKey, opts.entityKind, opts.entityId, opts.reason, opts.userId, now, expires);
}

export function undismissOpsRow(opts: {
  tenantId: number | null;
  queueKey: string;
  entityKind: "lead" | "activity";
  entityId: number;
}): boolean {
  const res = rawDb.prepare(
    `DELETE FROM ops_dismissals
      WHERE tenant_id IS ? AND queue_key = ? AND entity_kind = ? AND entity_id = ?`,
  ).run(opts.tenantId, opts.queueKey, opts.entityKind, opts.entityId);
  return res.changes > 0;
}

/** Test seam: the overview memo must not leak between test tenants/cases. */
export function __clearOpsMemoForTests(): void {
  overviewMemo.clear();
}
