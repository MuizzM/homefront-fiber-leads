// ── Rep metrics - background aggregation ─────────────────────────────────────
//
// The one rule this file exists to keep: METRIC AGGREGATION NEVER RUNS INSIDE AN
// HTTP REQUEST, AND NEVER BLOCKS THE EVENT LOOP FOR LONG.
//
// better-sqlite3 is synchronous. A single statement that scans knock_log for a
// whole org holds the ONLY thread this process has, so every other request -
// including a rep saving a disposition on a doorstep - waits behind it. The
// yield engine already learned this the expensive way (see server/yieldRollups
// and the WAL-pinning incident it documents), so this module copies its shape
// rather than rediscovering it:
//
//   * work is CHUNKED - a bounded number of rep-days per tick
//   * each chunk is followed by a real `await` so the loop drains
//   * it runs on the cluster PRIMARY only, so N workers do not do N× the work
//   * it stands down entirely when the resource sentinel reports pressure
//   * it is resumable - the dirty-day queue is the cursor, and a crash mid-run
//     loses nothing because a row is only cleared after its day is written
//
// The queue is drained oldest-first. That matters on a cold start with a large
// backlog: the alternative (newest-first) would leave the oldest days
// permanently starved behind a steady trickle of today's writes.

import { rawDb } from "./db";
import { isSqliteContention, withoutSqliteBusyWait } from "./interactiveDb";
import { structuredLog } from "./structuredLog";
import { readPressure, PRESSURE_ORDER } from "./resourcePressure";
import {
  claimDirtyDays,
  clearDirtyDay,
  dirtyDayCount,
  localDateString,
  markHourlyRollupUnavailable,
  markRepDayDirty,
  markMissingHourlyRollupsDirty,
  readDailyRows,
  recomputeRepDay,
  tenantTimezone,
  parseTs,
  type DirtyDay,
} from "./repMetricsStore";
import { aggregateFacts, deriveMetrics, type RepDailyFacts } from "@shared/repMetrics";
import {
  buildTeamBaseline,
  generateInsights,
  MIN_TEAM_FOR_BASELINE,
  type InsightContext,
} from "@shared/coachingInsights";
import { assessTerritory, type TerritoryFacts } from "@shared/territoryHealth";

/** Rep-days recomputed per tick. Deliberately small: each one is ~6 indexed
 *  queries, and the point is a short, frequent slice rather than a long one. */
const CHUNK = Math.max(5, Number(process.env.REP_METRICS_CHUNK) || 40);
const TICK_MS = Math.max(5_000, Number(process.env.REP_METRICS_TICK_MS) || 20_000);
/** Insights and territory health are period-level and much heavier; they run on
 *  their own slower cadence rather than after every rollup tick. */
const INSIGHT_TICK_MS = Math.max(60_000, Number(process.env.REP_METRICS_INSIGHT_TICK_MS) || 30 * 60_000);

/** Kill switch, matching the house convention (YIELD_ROLLUPS=off). */
function enabled(): boolean {
  return String(process.env.REP_METRICS_ROLLUPS ?? "").toLowerCase() !== "off";
}

/** True when the box is under enough pressure that background work should stop.
 *  `warn` is allowed through - the job is small, and standing down at the first
 *  hint of load would mean the rollup never runs on a busy org. */
function shouldStandDown(): boolean {
  const { level } = readPressure();
  return PRESSURE_ORDER[level] >= PRESSURE_ORDER.throttle;
}

/** Give the event loop a real turn. setImmediate, not a Promise microtask:
 *  a resolved promise is drained in the SAME macrotask and would yield nothing. */
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

// ── Rollup ───────────────────────────────────────────────────────────────────

let rollupRunning = false;

/**
 * Drain one slice of the dirty-day queue.
 *
 * Returns how many rep-days were written. Each day is recomputed and cleared
 * INDIVIDUALLY: a single bad rep-day (a corrupt timestamp, a lead row that went
 * away mid-flight) must not strand the rest of the queue behind it, and a crash
 * between the write and the clear only costs one idempotent recomputation.
 */
export async function runRollupSlice(chunk = CHUNK): Promise<number> {
  if (!enabled() || rollupRunning) return 0;
  if (shouldStandDown()) return 0;

  rollupRunning = true;
  let written = 0;
  try {
    // Existing daily summaries predate hour buckets. Seed only one bounded
    // chunk per tick so deployment cannot turn a backfill into foreground load.
    withoutSqliteBusyWait(rawDb, () => markMissingHourlyRollupsDirty(chunk));
    const days = claimDirtyDays(chunk);
    for (const day of days) {
      try {
        withoutSqliteBusyWait(rawDb, () => {
          // Compute outside the writer; recomputeRepDay already publishes its
          // daily/hourly pair in one short transaction. A failed acknowledgment
          // leaves this idempotent day queued for another pass.
          recomputeRepDay(day.tenantId, day.repId, day.metricDate);
          clearDirtyDay(day);
        });
        written++;
      } catch (e: any) {
        if (isSqliteContention(e)) {
          structuredLog("rep_metrics.day_deferred", { reason: "database_busy" });
          break; // retain the historical day and prior summaries for the next tick
        }
        // Clear it anyway. A day that throws deterministically would otherwise
        // be retried forever at the head of an oldest-first queue and block
        // every day behind it - the failure mode is a stalled rollup for the
        // whole org, which is far worse than one stale rep-day.
        withoutSqliteBusyWait(rawDb, () => rawDb.transaction(() => {
          markHourlyRollupUnavailable(day);
          clearDirtyDay(day);
        }).immediate());
        structuredLog("rep_metrics.day_failed", {
          tenantId: day.tenantId, repId: day.repId, date: day.metricDate,
          error: String(e?.message ?? e),
        }, "warn");
      }
      // Between rep-days, not between chunks: one rep-day is ~6 synchronous
      // queries, and 40 of them back-to-back is a visible stall on a loaded box.
      if (written % 5 === 0) await yieldToLoop();
    }
  } finally {
    rollupRunning = false;
  }
  return written;
}

/**
 * Mark every active rep's TODAY as dirty.
 *
 * The safety net under the event-driven marking. Write paths call
 * markRepDayDirty, but some numbers change with no write at all - active
 * seconds tick up while a shift is open, and assignment counts change when
 * somebody else's lasso moves doors. This sweep means the dashboard is never
 * more than one tick stale even for those.
 */
export function markActiveRepsDirty(nowMs = Date.now()): number {
  try {
    const reps = rawDb.prepare(`
      SELECT DISTINCT tm.tenant_id AS tenantId, tm.id AS repId
        FROM team_members tm
       WHERE tm.active = 1
         AND tm.tenant_id IS NOT NULL
         AND (
           EXISTS (SELECT 1 FROM clock_sessions cs
                    WHERE cs.rep_id = tm.id AND cs.clocked_out IS NULL)
           OR EXISTS (SELECT 1 FROM knock_log k
                       WHERE k.rep_id = tm.id
                         AND replace(k.knocked_at,'T',' ') >= ?)
         )
    `).all(new Date(nowMs - 36 * 3_600_000).toISOString().replace("T", " ").slice(0, 19)) as any[];

    for (const r of reps) markRepDayDirty(Number(r.tenantId), Number(r.repId), nowMs);
    return reps.length;
  } catch (e: any) {
    structuredLog("rep_metrics.sweep_failed", { error: String(e?.message ?? e) }, "warn");
    return 0;
  }
}

// ── Coaching insights ────────────────────────────────────────────────────────

/** The trailing window insights are generated over. Seven days is long enough
 *  for the sample floors in shared/coachingInsights to be reachable and short
 *  enough that the advice is about this week. */
const INSIGHT_WINDOW_DAYS = 7;

let insightsRunning = false;

/**
 * Regenerate insights for every tenant with recent activity.
 *
 * Insights are UPSERTED on (tenant, rep, type, period), so re-running is free
 * and a dismissal survives - the unique index is what makes that true rather
 * than a convention.
 */
export async function runInsightSlice(nowMs = Date.now()): Promise<number> {
  if (!enabled() || insightsRunning) return 0;
  if (shouldStandDown()) return 0;

  insightsRunning = true;
  let produced = 0;
  try {
    const tenants = rawDb.prepare(`
      SELECT DISTINCT tenant_id AS tenantId FROM rep_daily_metrics
       WHERE metric_date >= ?
    `).all(dateNDaysAgo(nowMs, INSIGHT_WINDOW_DAYS, "UTC")) as any[];

    for (const t of tenants) {
      const tenantId = Number(t.tenantId);
      if (!Number.isFinite(tenantId)) continue;
      try {
        produced += generateForTenant(tenantId, nowMs);
      } catch (e: any) {
        structuredLog("rep_metrics.insights_failed", {
          tenantId, error: String(e?.message ?? e),
        }, "warn");
      }
      await yieldToLoop();
    }
  } finally {
    insightsRunning = false;
  }
  return produced;
}

function generateForTenant(tenantId: number, nowMs: number): number {
  const tz = tenantTimezone(tenantId);
  const periodEnd = localDateString(nowMs, tz);
  const periodStart = dateNDaysAgo(nowMs, INSIGHT_WINDOW_DAYS - 1, tz);

  const reps = rawDb.prepare(`
    SELECT id FROM team_members WHERE tenant_id = ? AND active = 1
  `).all(tenantId).map((r: any) => Number(r.id));
  if (reps.length === 0) return 0;

  const rows = readDailyRows(tenantId, reps, periodStart, periodEnd);
  if (rows.length === 0) return 0;

  // Per-rep folded facts, then the team baseline from those.
  const byRep = new Map<number, RepDailyFacts[]>();
  for (const r of rows) {
    const list = byRep.get(r.repId);
    if (list) list.push(r); else byRep.set(r.repId, [r]);
  }

  const folded = [...byRep.entries()].map(([repId, days]) => {
    const facts = aggregateFacts(days);
    return { repId, facts, metrics: deriveMetrics(facts) };
  });

  // Only reps with real activity contribute to the median. A rep who was off
  // all week is not a data point about how hard this team is knocking, and
  // including them as zeros would drag every baseline down and fire coaching
  // rules on everyone else.
  const contributing = folded.filter((f) => f.facts.doorsAttempted > 0);
  const baseline = contributing.length >= MIN_TEAM_FOR_BASELINE
    ? buildTeamBaseline(contributing)
    : null;

  const names = new Map<number, string>();
  for (const r of rawDb.prepare(
    `SELECT id, name FROM team_members WHERE tenant_id = ?`,
  ).all(tenantId) as any[]) names.set(Number(r.id), String(r.name ?? ""));

  let produced = 0;
  for (const f of folded) {
    // No activity at all: nothing to coach, and firing rules on an empty week
    // is exactly the false positive the sample floors exist to prevent.
    if (f.facts.doorsAttempted === 0 && f.facts.activeSeconds === 0) continue;

    const ctx: InsightContext = {
      repId: f.repId,
      repName: names.get(f.repId) ?? `Rep ${f.repId}`,
      periodStart, periodEnd,
      facts: f.facts,
      metrics: f.metrics,
      baseline,
      personal: null,
      nearbyUnworkedDoors: countNearbyUnworked(f.repId),
      overdueFollowUps: countOverdueFollowUps(f.repId, nowMs),
      hoursSinceLastActivity: f.facts.lastActivityAtMs != null
        ? (nowMs - f.facts.lastActivityAtMs) / 3_600_000
        : null,
      hasUnstartedTerritory: f.metrics.untouchedAssignedDoors > 0,
    };

    for (const insight of generateInsights(ctx)) {
      rawDb.prepare(`
        INSERT INTO rep_coaching_insights (
          tenant_id, rep_id, period_start, period_end, insight_type, severity,
          title, explanation, suggested_action, supporting_metrics_json, data_link
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(tenant_id, rep_id, insight_type, period_start, period_end)
        DO UPDATE SET
          severity = excluded.severity,
          title = excluded.title,
          explanation = excluded.explanation,
          suggested_action = excluded.suggested_action,
          supporting_metrics_json = excluded.supporting_metrics_json,
          data_link = excluded.data_link,
          updated_at = datetime('now')
      `).run(
        tenantId, f.repId, periodStart, periodEnd, insight.insightType, insight.severity,
        insight.title, insight.explanation, insight.suggestedAction,
        JSON.stringify(insight.supportingMetrics), insight.dataLink,
      );
      produced++;
    }
  }
  return produced;
}

/** Assigned doors this rep has never knocked. The pace rule uses it to decide
 *  whether a long gap is a routing problem or simply a finished area. */
function countNearbyUnworked(repId: number): number {
  try {
    const r = rawDb.prepare(`
      SELECT COUNT(*) AS n FROM leads l
       WHERE l.assigned_rep_id = ?
         AND COALESCE(l.do_not_knock,0) = 0
         AND NOT EXISTS (SELECT 1 FROM knock_log k WHERE k.lead_id = l.id)
    `).get(repId) as any;
    return Number(r?.n ?? 0);
  } catch { return 0; }
}

/** Follow-ups whose callback date has passed with no later knock. */
function countOverdueFollowUps(repId: number, nowMs: number): number {
  try {
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const r = rawDb.prepare(`
      SELECT COUNT(DISTINCT k.lead_id) AS n
        FROM knock_log k
       WHERE k.rep_id = ?
         AND k.callback_date IS NOT NULL
         AND k.callback_date < ?
         AND COALESCE(k.superseded,0) = 0
         AND NOT EXISTS (
           SELECT 1 FROM knock_log later
            WHERE later.lead_id = k.lead_id
              AND later.rep_id = k.rep_id
              AND replace(later.knocked_at,'T',' ') > replace(k.knocked_at,'T',' ')
         )
    `).get(repId, today) as any;
    return Number(r?.n ?? 0);
  } catch { return 0; }
}

// ── Territory health ─────────────────────────────────────────────────────────

/**
 * Recompute territory rollups and status labels.
 *
 * Writes `reclaim_recommended` and the rationale, and NOTHING ELSE. No area is
 * reclaimed, reassigned or touched here - the brief requires that decision to
 * be a human one, and this module has no code path that could take it.
 */
export async function runTerritorySlice(nowMs = Date.now()): Promise<number> {
  if (!enabled()) return 0;
  if (shouldStandDown()) return 0;

  let written = 0;
  const tenants = rawDb.prepare(
    `SELECT id FROM tenants WHERE status = 'active'`,
  ).all() as any[];

  for (const t of tenants) {
    const tenantId = Number(t.id);
    const tz = tenantTimezone(tenantId);
    const metricDate = localDateString(nowMs, tz);
    let rows: any[] = [];
    try {
      rows = rawDb.prepare(`
        SELECT
          t.id                                        AS territoryId,
          t.name                                      AS territoryName,
          t.assigned_at                               AS assignedAt,
          COUNT(l.id)                                 AS totalDoors,
          SUM(CASE WHEN COALESCE(l.do_not_knock,0)=1 THEN 1 ELSE 0 END)      AS dnk,
          SUM(CASE WHEN l.assigned_rep_id IS NOT NULL THEN 1 ELSE 0 END)     AS assignedDoors,
          SUM(CASE WHEN l.assigned_rep_id IS NULL     THEN 1 ELSE 0 END)     AS unassignedDoors,
          SUM(CASE WHEN COALESCE(l.is_new_fiber,0)=1 AND COALESCE(l.do_not_knock,0)=0
                   THEN 1 ELSE 0 END)                                        AS freshAssigned
        FROM territories t
        LEFT JOIN leads l ON l.assigned_territory_id = t.id
        WHERE t.tenant_id = ? AND t.status NOT IN ('archived','draft')
        GROUP BY t.id
      `).all(tenantId);
    } catch { rows = []; }

    for (const r of rows) {
      const territoryId = Number(r.territoryId);
      const activity = territoryActivity(territoryId);
      const facts: TerritoryFacts = {
        territoryId,
        territoryName: String(r.territoryName ?? ""),
        eligibleDoors: Math.max(0, Number(r.totalDoors ?? 0) - Number(r.dnk ?? 0)),
        assignedDoors: Number(r.assignedDoors ?? 0),
        unassignedDoors: Number(r.unassignedDoors ?? 0),
        doorsAttempted: activity.attempted,
        verifiedVisits: activity.verified,
        everWorkedDoors: activity.everWorked,
        contacts: activity.contacts,
        submittedOrders: activity.sold,
        installedOrders: 0,
        paidOrders: 0,
        freshAssigned: Number(r.freshAssigned ?? 0),
        freshAttempted: activity.freshWorked,
        activeRepCount: activity.activeReps,
        lastActivityAtMs: activity.lastActivityMs,
        assignedAtMs: parseTs(r.assignedAt),
        callbacksDue: activity.callbacksDue,
        openRecoveryCases: 0,
        estimatedCommissionCents: 0,
        paidCommissionCents: 0,
      };

      const health = assessTerritory(facts, nowMs);
      try {
        rawDb.prepare(`
          INSERT INTO territory_daily_metrics (
            tenant_id, territory_id, metric_date,
            eligible_doors, assigned_doors, unassigned_doors,
            doors_attempted, verified_visits, ever_worked_doors, contacts,
            submitted_orders, installed_orders, paid_orders,
            fresh_assigned, fresh_attempted, active_rep_count,
            callbacks_due, open_recovery_cases,
            estimated_commission_cents, paid_commission_cents,
            last_activity_at, assigned_at, status, reclaim_recommended, reclaim_rationale, computed_at
          ) VALUES (?,?,?, ?,?,?, ?,?,?,?, ?,?,?, ?,?,?, ?,?, ?,?, ?,?,?,?,?, datetime('now'))
          ON CONFLICT(tenant_id, territory_id, metric_date) DO UPDATE SET
            eligible_doors = excluded.eligible_doors,
            assigned_doors = excluded.assigned_doors,
            unassigned_doors = excluded.unassigned_doors,
            doors_attempted = excluded.doors_attempted,
            verified_visits = excluded.verified_visits,
            ever_worked_doors = excluded.ever_worked_doors,
            contacts = excluded.contacts,
            submitted_orders = excluded.submitted_orders,
            fresh_assigned = excluded.fresh_assigned,
            fresh_attempted = excluded.fresh_attempted,
            active_rep_count = excluded.active_rep_count,
            callbacks_due = excluded.callbacks_due,
            last_activity_at = excluded.last_activity_at,
            assigned_at = excluded.assigned_at,
            status = excluded.status,
            reclaim_recommended = excluded.reclaim_recommended,
            reclaim_rationale = excluded.reclaim_rationale,
            computed_at = datetime('now')
        `).run(
          tenantId, territoryId, metricDate,
          facts.eligibleDoors, facts.assignedDoors, facts.unassignedDoors,
          facts.doorsAttempted, facts.verifiedVisits, facts.everWorkedDoors, facts.contacts,
          facts.submittedOrders, facts.installedOrders, facts.paidOrders,
          facts.freshAssigned, facts.freshAttempted, facts.activeRepCount,
          facts.callbacksDue, facts.openRecoveryCases,
          facts.estimatedCommissionCents, facts.paidCommissionCents,
          facts.lastActivityAtMs == null ? null : new Date(facts.lastActivityAtMs).toISOString(),
          r.assignedAt ?? null,
          health.status, health.reclaimRecommended ? 1 : 0, health.reclaimRationale,
        );
        written++;
      } catch { /* one territory failing must not stop the sweep */ }
    }
    await yieldToLoop();
  }
  return written;
}

function territoryActivity(territoryId: number): {
  attempted: number; verified: number; everWorked: number; contacts: number;
  sold: number; freshWorked: number; activeReps: number; callbacksDue: number;
  lastActivityMs: number | null;
} {
  const base = { attempted: 0, verified: 0, everWorked: 0, contacts: 0, sold: 0, freshWorked: 0, activeReps: 0, callbacksDue: 0, lastActivityMs: null as number | null };
  try {
    const r = rawDb.prepare(`
      SELECT
        COUNT(k.id)                                                          AS attempted,
        COUNT(DISTINCT k.lead_id)                                            AS everWorked,
        SUM(CASE WHEN k.verification_status = 'verified' THEN 1 ELSE 0 END)  AS verified,
        SUM(CASE WHEN k.was_home = 1 AND COALESCE(k.superseded,0)=0 THEN 1 ELSE 0 END) AS contacts,
        SUM(CASE WHEN k.outcome = 'sold' AND COALESCE(k.superseded,0)=0 THEN 1 ELSE 0 END) AS sold,
        COUNT(DISTINCT CASE WHEN COALESCE(l.is_new_fiber,0)=1 THEN k.lead_id END) AS freshWorked,
        COUNT(DISTINCT k.rep_id)                                             AS activeReps,
        MAX(k.knocked_at)                                                    AS lastActivity
      FROM knock_log k
      JOIN leads l ON l.id = k.lead_id
      WHERE l.assigned_territory_id = ?
    `).get(territoryId) as any;

    const cb = rawDb.prepare(`
      SELECT COUNT(DISTINCT k.lead_id) AS n
        FROM knock_log k JOIN leads l ON l.id = k.lead_id
       WHERE l.assigned_territory_id = ?
         AND k.callback_date IS NOT NULL
         AND k.callback_date <= date('now')
    `).get(territoryId) as any;

    return {
      attempted: Number(r?.attempted ?? 0),
      verified: Number(r?.verified ?? 0),
      everWorked: Number(r?.everWorked ?? 0),
      contacts: Number(r?.contacts ?? 0),
      sold: Number(r?.sold ?? 0),
      freshWorked: Number(r?.freshWorked ?? 0),
      activeReps: Number(r?.activeReps ?? 0),
      callbacksDue: Number(cb?.n ?? 0),
      lastActivityMs: parseTs(r?.lastActivity),
    };
  } catch { return base; }
}

// ── Scheduling ───────────────────────────────────────────────────────────────

function dateNDaysAgo(nowMs: number, days: number, timezone: string): string {
  return localDateString(nowMs - days * 86_400_000, timezone);
}

/**
 * Start the background workers.
 *
 * Returns a stop function. The caller (server/index.ts) is responsible for
 * calling this only on the cluster primary - the same contract every other
 * background job in this process uses - and for unref'ing the timers so they
 * never hold the process open during a shutdown.
 */
export function startRepMetricsWorkers(): () => void {
  if (!enabled()) {
    structuredLog("rep_metrics.disabled", { reason: "REP_METRICS_ROLLUPS=off" }, "info");
    return () => {};
  }

  const rollupTimer = setInterval(() => {
    void (async () => {
      try {
        markActiveRepsDirty();
        const n = await runRollupSlice();
        if (n > 0) {
          structuredLog("rep_metrics.rollup", { written: n, pending: dirtyDayCount() }, "info");
        }
      } catch (e: any) {
        structuredLog("rep_metrics.rollup_failed", { error: String(e?.message ?? e) }, "warn");
      }
    })();
  }, TICK_MS);

  const insightTimer = setInterval(() => {
    void (async () => {
      try {
        const produced = await runInsightSlice();
        const territories = await runTerritorySlice();
        if (produced > 0 || territories > 0) {
          structuredLog("rep_metrics.insights", { produced, territories }, "info");
        }
      } catch (e: any) {
        structuredLog("rep_metrics.insights_failed", { error: String(e?.message ?? e) }, "warn");
      }
    })();
  }, INSIGHT_TICK_MS);

  rollupTimer.unref?.();
  insightTimer.unref?.();

  return () => {
    clearInterval(rollupTimer);
    clearInterval(insightTimer);
  };
}

export type { DirtyDay };
