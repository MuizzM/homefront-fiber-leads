/**
 * FRESH HARVEST — one fluid, yield-ranked scanning system for Kinetic NC/SC.
 *
 * Every cycle ranks ALL due work by expected fresh-lead yield and spends the
 * budget top-down (no blind backlog sweeping):
 *
 *   Tier A — COMING-SOON FLIP WATCH with age-tightened cadence: fresh entries
 *            (<48h old) re-checked every 12h; mature entries every 2h (flips
 *            cluster at days 3–14) — we catch the flip within hours.
 *   Tier B — CLUSTER NEIGHBORS, conversion-weighted: never-scanned addresses
 *            in ~1.1km cells of fresh leads, ranked by the cell's hit rate
 *            (fresh leads per scanned address) — the fleet concentrates where
 *            fiber is actively being lit, not just where it was lit once.
 *   Tier B2— STREET COMPLETION: builders light whole streets at once. Every
 *            never-scanned address sharing a street with a fresh lead (21d).
 *   Tier C0— PRIORITY CITIES (Davidson/Lake Norman via FRESH_HARVEST_CITIES).
 *   Tier C — NC/SC cities ranked by 21-day fresh density.
 *   Tier D1— COPPER-FLIP WATCH: stale copper in fresh-dense cities (7d).
 *   Tier D2— STALE REFRESH: 30-day negative verdicts, NC/SC only.
 *
 * BALANCED CADENCE:
 *   - Budget shapes by time of day: ×1.5 overnight (00–06), ×0.5 business
 *     hours (09–17), ×1 otherwise — proxy spend follows idle capacity.
 *   - adaptivePace self-throttles against live website health between batches.
 *   - Every tier is due-gated: a Decodo call only happens when an address is
 *     actually due. Never-scanned costs exactly one call, ever.
 *
 * ECONOMY REPORT (emitEconomyReport, every 6h): checks, block rate, fresh
 * hits, and calls-per-fresh-lead — the true cost of a lead, visible in logs.
 *
 * FRESH_HARVEST=off disables; FRESH_HARVEST_BUDGET (default 4000/cycle),
 * FRESH_HARVEST_INTERVAL_MIN (default 15), FRESH_HARVEST_STATES (default nc,sc).
 */
import { rawDb } from "./db";
import { startTargetRun } from "./scanService";
import { structuredLog } from "./structuredLog";

const TIER_B_FRESH_WINDOW_DAYS = 21;          // cluster memory
const TIER_D1_COPPER_DAYS = 7;           // copper→fiber flip watch
const TIER_D_STALE_DAYS = 30;

// State focus: only these states get harvest budget (FRESH_HARVEST_STATES,
// default NC + SC — the Kinetic build footprint). Frontier scanning is off.
const FOCUS_STATES = (process.env.FRESH_HARVEST_STATES ?? "nc,sc")
  .split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
const STATE_IN = FOCUS_STATES.map(() => "?").join(",");
const stateArgs = () => [...FOCUS_STATES];

interface TierRow { id: number }

/** Tier A: coming-soon watchlist entries due for re-check. */
export function tierA(tenantId: number, limit: number): TierRow[] {
  if (limit <= 0) return [];
  const now = Date.now();
  const freshCut = now - 12 * 3_600_000;   // young entries: 12h cadence
  const matureCut = now - 2 * 3_600_000;   // mature entries (48h+): 2h cadence
  const matureAge = now - 48 * 3_600_000;
  return rawDb.prepare(
    `SELECT w.scan_target_id AS id
       FROM coming_soon_watchlist w
      WHERE w.tenant_id=? AND w.status='active'
        AND (w.last_checked_at IS NULL
             OR (w.first_seen_at >  ? AND w.last_checked_at < ?)
             OR (w.first_seen_at <= ? AND w.last_checked_at < ?))
      ORDER BY (w.last_checked_at IS NULL) DESC, w.last_checked_at ASC
      LIMIT ?`,
  ).all(tenantId, matureAge, freshCut, matureAge, matureCut, limit) as TierRow[];
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
     , cell_scans AS (
       SELECT ROUND(s.lat,2) AS clat, ROUND(s.lng,2) AS clng, COUNT(*) AS scanned
         FROM scan_targets s
        WHERE s.tenant_id=? AND s.last_scanned_at IS NOT NULL
          AND s.lat IS NOT NULL AND s.lng IS NOT NULL
        GROUP BY clat, clng
     )
     SELECT s.id
       FROM scan_targets s
       JOIN fresh_cells fc
         ON ROUND(s.lat,2)=fc.clat AND ROUND(s.lng,2)=fc.clng
       LEFT JOIN cell_scans cs ON cs.clat=fc.clat AND cs.clng=fc.clng
      WHERE s.tenant_id=? AND s.last_scanned_at IS NULL
        AND s.lat IS NOT NULL AND s.lng IS NOT NULL
        AND lower(s.state) IN (${STATE_IN})
      ORDER BY CAST(fc.hits AS REAL)/(1+COALESCE(cs.scanned,0)) DESC, fc.hits DESC, s.id ASC
      LIMIT ?`,
  ).all(tenantId, tenantId, tenantId, ...stateArgs(), limit) as TierRow[];
}

/** Tier B2: street completion — every never-scanned address sharing a street
 *  with a fresh lead (builders light whole streets at once). */
export function tierB2(tenantId: number, limit: number): TierRow[] {
  if (limit <= 0) return [];
  return rawDb.prepare(
    `WITH fresh_streets AS (
       SELECT DISTINCT lower(substr(l.address, instr(l.address,' ')+1)) AS street,
              lower(l.city) AS city, lower(l.state) AS state
         FROM leads l
        WHERE l.tenant_id=? AND l.lead_tag='fresh_fiber_confirmed'
          AND l.created_at >= datetime('now','-${TIER_B_FRESH_WINDOW_DAYS} days')
          AND instr(l.address,' ') > 0
     )
     SELECT s.id
       FROM scan_targets s
       JOIN fresh_streets fs
         ON lower(substr(s.address, instr(s.address,' ')+1))=fs.street
        AND lower(s.city)=fs.city AND lower(s.state)=fs.state
      WHERE s.tenant_id=? AND s.last_scanned_at IS NULL
        AND instr(s.address,' ') > 0
        AND lower(s.state) IN (${STATE_IN})
      ORDER BY s.id ASC
      LIMIT ?`,
  ).all(tenantId, tenantId, ...stateArgs(), limit) as TierRow[];
}

/** Tier C0: never-scanned targets in explicitly configured priority cities. */
export function tierC0(tenantId: number, limit: number): TierRow[] {
  if (limit <= 0) return [];
  const cities = (process.env.FRESH_HARVEST_CITIES ?? process.env.PRIORITY_CITIES ?? "")
    .split(",").map((v) => v.trim()).filter(Boolean)
    .map((entry) => entry.split(":").map((s) => s.trim()))
    .filter((p) => p[0]);
  if (!cities.length) return [];
  const where = cities.map(() => "(lower(city)=? AND lower(state)=?)").join(" OR ");
  const args: any[] = [];
  for (const [city, st = "nc"] of cities) args.push(city, st);
  return rawDb.prepare(
    `SELECT s.id FROM scan_targets s
      WHERE s.tenant_id=? AND s.last_scanned_at IS NULL AND (${where})
      ORDER BY s.id ASC LIMIT ?`,
  ).all(tenantId, ...args, limit) as TierRow[];
}

/** Tier D1: COPPER verdicts in fresh-dense cities older than 7 days (flip watch). */
export function tierD1(tenantId: number, limit: number): TierRow[] {
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
      WHERE s.tenant_id=? AND COALESCE(s.last_fiber_status,'')='copper'
        AND s.last_scanned_at IS NOT NULL
        AND s.last_scanned_at < datetime('now','-${TIER_D1_COPPER_DAYS} days')
        AND lower(s.state) IN (${STATE_IN})
      ORDER BY s.last_scanned_at ASC
      LIMIT ?`,
  ).all(tenantId, tenantId, ...stateArgs(), limit) as TierRow[];
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
        AND lower(s.state) IN (${STATE_IN})
      ORDER BY hc.hits DESC, s.id ASC
      LIMIT ?`,
  ).all(tenantId, tenantId, ...stateArgs(), limit) as TierRow[];
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
        AND lower(s.state) IN (${STATE_IN})
      ORDER BY s.last_scanned_at ASC
      LIMIT ?`,
  ).all(tenantId, ...stateArgs(), limit) as TierRow[];
}

/**
 * Compose and dispatch one harvest cycle. Returns per-tier counts (also
 * structured-logged). Daily-safe: selection is due-based, so cycles never
 * repeat work that isn't due again.
 */
export function runHarvestCycle(tenantId: number, budget = Number(process.env.FRESH_HARVEST_BUDGET) || 4000): { a: number; b: number; b2: number; c0: number; c: number; d1: number; d: number; runId?: string } {
  // Time-of-day budget shaping: proxy spend follows idle capacity.
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 6) budget = Math.round(budget * 1.5);        // overnight push
  else if (hour >= 9 && hour < 17) budget = Math.round(budget * 0.5);  // business hours: gentle
  const seen = new Set<number>();
  const pick = (rows: TierRow[]) => rows.filter((r) => !seen.has(r.id)).map((r) => { seen.add(r.id); return r.id; });

  const a = pick(tierA(tenantId, budget));
  const b = pick(tierB(tenantId, budget - a.length));
  const b2 = pick(tierB2(tenantId, budget - a.length - b.length));
  const c0 = pick(tierC0(tenantId, budget - a.length - b.length - b2.length));
  const c = pick(tierC(tenantId, budget - a.length - b.length - b2.length - c0.length));
  const d1 = pick(tierD1(tenantId, budget - a.length - b.length - b2.length - c0.length - c.length));
  const d = pick(tierD(tenantId, budget - a.length - b.length - b2.length - c0.length - c.length - d1.length));
  const ids = [...a, ...b, ...b2, ...c0, ...c, ...d1, ...d];

  const counts = { a: a.length, b: b.length, b2: b2.length, c0: c0.length, c: c.length, d1: d1.length, d: d.length };
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
    label: `FRESH HARVEST a${counts.a}/b${counts.b}/b2:${counts.b2}/c0:${counts.c0}/c${counts.c}/d1:${counts.d1}/d${counts.d}`,
  });
  structuredLog("fresh_harvest.cycle", { ...counts, runId, total: ids.length });
  return { ...counts, runId };
}

/** Economy report: checks, block rate, fresh hits, calls-per-fresh-lead (24h). */
export function emitEconomyReport(tenantId: number): void {
  try {
    const cut = Date.now() - 24 * 3_600_000;
    const s = rawDb.prepare(`SELECT COUNT(*) AS checks, SUM(blocked) AS blocked, SUM(fresh) AS fresh
      FROM availability_snapshots WHERE checked_at_epoch > ?`).get(cut) as any;
    const l = rawDb.prepare(`SELECT COUNT(*) AS c FROM leads
      WHERE tenant_id=? AND lead_tag='fresh_fiber_confirmed' AND created_at > datetime('now','-1 day')`).get(tenantId) as any;
    const checks = Number(s?.checks ?? 0), fresh = Number(s?.fresh ?? 0), leads = Number(l?.c ?? 0);
    structuredLog("fresh_harvest.economy", {
      checks24h: checks,
      blocked24h: Number(s?.blocked ?? 0),
      blockRate: checks ? +(Number(s?.blocked ?? 0) / checks).toFixed(3) : 0,
      freshVerdicts24h: fresh,
      freshLeads24h: leads,
      callsPerFreshLead: leads ? +(checks / leads).toFixed(1) : null,
    });
  } catch { /* best-effort metrics */ }
}
