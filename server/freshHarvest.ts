/**
 * FRESH HARVEST — yield-ranked selection algorithm for fresh + coming-soon fiber.
 *
 * New fiber is built in CLUSTERS (a terminal/serving area goes live, then the
 * whole neighborhood is fresh). And "coming soon" (NEW FIBER with an active
 * billing account) flips to fresh when the account clears. So instead of
 * sweeping the backlog blindly, every harvest cycle ranks all due work by
 * expected yield and spends the budget top-down:
 *
 *   Tier A — COMING-SOON FLIP WATCH: coming_soon_watchlist entries due for a
 *            re-check (6h cadence). One API call away from turning into a
 *            fresh lead. Highest yield per call.
 *   Tier B — CLUSTER NEIGHBORS: never-scanned addresses within ~1.1km geo-cells
 *            (ROUND(lat,2)/ROUND(lng,2)) that contain a fresh lead from the
 *            last 21 days. Neighbors of a fresh build are the likeliest
 *            unscanned fresh addresses in the entire database.
 *   Tier C — FRONTIER OF THE KNOWN: never-scanned addresses in the cities with
 *            the most fresh hits in 21 days (explores the edges of active
 *            build markets), densest city first.
 *   Tier D — STALE REFRESH: no_service/copper verdicts older than 30 days,
 *            oldest first — territories change; cheap re-qualification.
 *
 * Each tier fills only the budget left by the tiers above it, so the fleet
 * always works the highest-EV address available. Runs as kind "fresh_harvest"
 * (revenue/discovery admission class) and is paced by adaptivePace, so it can
 * run CONTINUOUSLY without ever wedging the website.
 *
 * FRESH_HARVEST=off disables; FRESH_HARVEST_BUDGET (default 4000/cycle),
 * FRESH_HARVEST_INTERVAL_MIN (default 15).
 */
import { rawDb } from "./db";
import { startTargetRun } from "./scanService";
import { structuredLog } from "./structuredLog";

const TIER_A_RECHECK_MS = 6 * 3_600_000;      // coming-soon re-check cadence
const TIER_B_FRESH_WINDOW_DAYS = 21;          // cluster memory
const TIER_D_STALE_DAYS = 30;

interface TierRow { id: number }

/** Tier A: coming-soon watchlist entries due for re-check. */
export function tierA(tenantId: number, limit: number): TierRow[] {
  if (limit <= 0) return [];
  const due = Date.now() - TIER_A_RECHECK_MS;
  return rawDb.prepare(
    `SELECT w.scan_target_id AS id
       FROM coming_soon_watchlist w
      WHERE w.tenant_id=? AND w.status='active'
        AND (w.last_checked_at IS NULL OR w.last_checked_at < ?)
      ORDER BY (w.last_checked_at IS NULL) DESC, w.last_checked_at ASC
      LIMIT ?`,
  ).all(tenantId, due, limit) as TierRow[];
}

/** Tier B: never-scanned targets in ~1.1km cells containing a fresh lead. */
export function tierB(tenantId: number, limit: number): TierRow[] {
  if (limit <= 0) return [];
  return rawDb.prepare(
    `WITH fresh_cells AS (
       SELECT ROUND(l.lat,2) AS clat, ROUND(l.lng,2) AS clng, COUNT(*) AS hits
         FROM leads l
        WHERE l.tenant_id=? AND l.lat IS NOT NULL AND l.lng IS NOT NULL
          AND l.lead_tag='fresh_fiber_confirmed'
          AND l.created_at >= datetime('now','-${TIER_B_FRESH_WINDOW_DAYS} days')
        GROUP BY clat, clng
     )
     SELECT s.id
       FROM scan_targets s
       JOIN fresh_cells fc
         ON ROUND(s.lat,2)=fc.clat AND ROUND(s.lng,2)=fc.clng
      WHERE s.tenant_id=? AND s.last_scanned_at IS NULL
        AND s.lat IS NOT NULL AND s.lng IS NOT NULL
      ORDER BY fc.hits DESC, s.id ASC
      LIMIT ?`,
  ).all(tenantId, tenantId, limit) as TierRow[];
}

/** Tier C: never-scanned targets in cities ranked by 21-day fresh density. */
export function tierC(tenantId: number, limit: number): TierRow[] {
  if (limit <= 0) return [];
  return rawDb.prepare(
    `WITH hot_cities AS (
       SELECT lower(l.city) AS city, lower(l.state) AS state, COUNT(*) AS hits
         FROM leads l
        WHERE l.tenant_id=? AND l.lead_tag='fresh_fiber_confirmed'
          AND l.created_at >= datetime('now','-${TIER_B_FRESH_WINDOW_DAYS} days')
        GROUP BY lower(l.city), lower(l.state)
     )
     SELECT s.id
       FROM scan_targets s
       JOIN hot_cities hc ON lower(s.city)=hc.city AND lower(s.state)=hc.state
      WHERE s.tenant_id=? AND s.last_scanned_at IS NULL
      ORDER BY hc.hits DESC, s.id ASC
      LIMIT ?`,
  ).all(tenantId, tenantId, limit) as TierRow[];
}

/** Tier D: stale no_service/copper verdicts, oldest first. */
export function tierD(tenantId: number, limit: number): TierRow[] {
  if (limit <= 0) return [];
  return rawDb.prepare(
    `SELECT s.id
       FROM scan_targets s
      WHERE s.tenant_id=?
        AND s.last_scanned_at IS NOT NULL
        AND s.last_scanned_at < datetime('now','-${TIER_D_STALE_DAYS} days')
        AND COALESCE(s.last_fiber_status,'') IN ('no_service','copper')
      ORDER BY s.last_scanned_at ASC
      LIMIT ?`,
  ).all(tenantId, limit) as TierRow[];
}

/**
 * Compose and dispatch one harvest cycle. Returns per-tier counts (also
 * structured-logged). Daily-safe: selection is due-based, so cycles never
 * repeat work that isn't due again.
 */
export function runHarvestCycle(tenantId: number, budget = Number(process.env.FRESH_HARVEST_BUDGET) || 4000): { a: number; b: number; c: number; d: number; runId?: string } {
  const seen = new Set<number>();
  const pick = (rows: TierRow[]) => rows.filter((r) => !seen.has(r.id)).map((r) => { seen.add(r.id); return r.id; });

  const aRows = tierA(tenantId, budget);
  const a = pick(aRows);
  const b = pick(tierB(tenantId, budget - a.length));
  const c = pick(tierC(tenantId, budget - a.length - b.length));
  const d = pick(tierD(tenantId, budget - a.length - b.length - c.length));
  const ids = [...a, ...b, ...c, ...d];

  const counts = { a: a.length, b: b.length, c: c.length, d: d.length };
  if (!ids.length) {
    structuredLog("fresh_harvest.cycle", { ...counts, skipped: "nothing due" });
    return counts;
  }
  const { runId } = startTargetRun({
    tenantId,
    city: "fresh-harvest",
    state: "multi",
    targetIds: ids,
    runKind: "fresh_harvest",
    label: `FRESH HARVEST a${counts.a}/b${counts.b}/c${counts.c}/d${counts.d}`,
  });
  structuredLog("fresh_harvest.cycle", { ...counts, runId, total: ids.length });
  return { ...counts, runId };
}
