/**
 * FRESH HARVEST — one fluid, yield-ranked scanning system for Kinetic NC/SC.
 *
 * Every cycle ranks ALL due work by expected fresh-lead yield and spends the
 * budget top-down (no blind backlog sweeping):
 *
 *   (Coming-soon flip watching is NOT a harvest tier: the comingSoonWatchlist
 *    engine is the sole scheduler of those rechecks — governor-paced, with
 *    flip-window cadence tightening. A harvest tier here dispatched them under
 *    runKind 'fresh_harvest', which the engine's 18h dedup silently skipped —
 *    burning budget slots without ever producing the tight cadence.)
 *
 *   Tier B — CLUSTER NEIGHBORS, conversion-weighted: never-scanned addresses
 *            in ~1.1km cells of fresh leads, ranked by the cell's hit rate
 *            (fresh leads per scanned address) — the fleet concentrates where
 *            fiber is actively being lit, not just where it was lit once.
 *            The rate is empirical-Bayes smoothed toward the tenant-wide
 *            conversion rate (FRESH_HARVEST_CELL_PRIOR pseudo-scans, default
 *            12) so a lucky 1-hit/1-scan cell can't outrank a proven
 *            8-hits/20-scans cell.
 *   Tier B2— STREET COMPLETION: builders light whole streets at once. Every
 *            never-scanned address sharing a street with a fresh lead (21d).
 *            Streets match on a canonical key (house number + unit stripped,
 *            suffix synonyms folded: "Fiber Street" == "Fiber St").
 *   Tier E1— EXPANSION PUSH: never-scanned addresses in officially announced
 *            Kinetic build markets (state_fiber_markets verified_expanding).
 *            Solves the cold start: density tiers ignore a city until its
 *            first lead exists, but announced builds are where the next wave
 *            WILL light up — scan them before the first lead, not after.
 *   Tier C0— PRIORITY CITIES (Davidson/Lake Norman via FRESH_HARVEST_CITIES).
 *   Tier C — NC/SC cities ranked by 21-day fresh density.
 *   Tier E2— EXPANSION FLIP WATCH: stale negatives in announced build markets
 *            re-checked at 7 days (builds actively flip addresses; the 30-day
 *            stale tier is far too slow there, and the copper watch only
 *            covers cities that already produced a lead).
 *   Tier D1— COPPER-FLIP WATCH: stale copper in fresh-dense cities (7d).
 *   Tier D2— STALE REFRESH: 30-day negative verdicts, NC/SC only,
 *            footprint-gated to auto_scan_eligible Kinetic markets.
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
import { bandwidthBudgetScale, governorStats, isProxyCircuitOpen } from "./bandwidthGovernor";
import { canonicalAddressPart } from "./addressKey";
import { registerFootprintSqlFunctions, warmFootprintGate } from "./footprintGate";

const TIER_B_FRESH_WINDOW_DAYS = 21;          // cluster memory
const TIER_D1_COPPER_DAYS = 7;           // copper→fiber flip watch
const TIER_D_STALE_DAYS = 30;
const TIER_E2_STALE_DAYS = Math.max(1, Number(process.env.EXPANSION_RESCAN_DAYS) || 7);
// Empirical-Bayes prior strength for Tier B cell ranking: a cell's observed
// hit rate is blended with the tenant-wide rate as if the cell had this many
// extra scans at the global average. Low-evidence cells shrink to the mean.
const CELL_PRIOR_SCANS = Math.max(1, Number(process.env.FRESH_HARVEST_CELL_PRIOR) || 12);

// State focus: only these states get harvest budget (FRESH_HARVEST_STATES,
// default NC + SC — the Kinetic build footprint). Frontier scanning is off.
const FOCUS_STATES = (process.env.FRESH_HARVEST_STATES ?? "nc,sc")
  .split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
const STATE_IN = FOCUS_STATES.map(() => "?").join(",");
const stateArgs = () => [...FOCUS_STATES];

interface TierRow { id: number }

// ── Street identity for Tier B2 ──────────────────────────────────────────────
// Unit designators that end the street-name portion of an address.
const UNIT_TOKENS = new Set(["APT", "UNIT", "STE", "SUITE", "LOT", "TRLR", "BLDG", "FL", "RM", "BSMT", "DEPT", "OFC"]);
const DIRECTIONALS = new Set(["N", "S", "E", "W"]);

/**
 * Canonical street key: house number and unit stripped, suffix/directional
 * synonyms folded (via canonicalAddressPart), so "22 Fiber Street Apt 4",
 * "17 Fiber St" and "Fiber Street" all key to "FIBER ST". Addresses with no
 * leading house number (brand-new streets a geocoder hasn't numbered yet)
 * keep their full name instead of losing their first word. Empty string when
 * no street name survives.
 */
export function streetKeyOf(address: string | null | undefined): string {
  if (!address) return "";
  const tokens = canonicalAddressPart(String(address)).split(" ").filter(Boolean);
  let start = 0;
  // House number: "123", "123A", and split forms like "123 125" (ranges) or
  // "123 1 2" (fractions — "/" folds to a space in canonical form).
  while (start < tokens.length && /^\d+[A-Z]?$/.test(tokens[start])) start++;
  // "123-A Main St" canonicalizes to "123 A MAIN ST" — drop the orphaned unit
  // letter, but never a directional ("101 N Main St" keeps its N).
  if (start > 0 && start < tokens.length - 1
      && tokens[start].length === 1 && !DIRECTIONALS.has(tokens[start])) start++;
  let end = tokens.length;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].startsWith("#") || UNIT_TOKENS.has(tokens[i])) { end = i; break; }
  }
  return tokens.slice(start, end).join(" ");
}

// Registered as a SQL function so Tier B2 can match street identity inside the
// query instead of the naive substr-after-first-space it used before (which
// broke on unit suffixes and on "Fiber Street" vs "Fiber St").
let sqlFnsRegistered = false;
export function registerHarvestSqlFunctions(): void {
  if (sqlFnsRegistered) return;
  try {
    (rawDb as any).function("harvest_street_key", { deterministic: true },
      (addr: unknown) => streetKeyOf(typeof addr === "string" ? addr : ""));
    sqlFnsRegistered = true;
  } catch { /* re-registration or exotic driver — Tier B2 will fail loudly if truly absent */ }
}
registerHarvestSqlFunctions();

/** Tier B: never-scanned targets in ~1.1km cells containing a fresh lead.
 *  Cells rank by empirical-Bayes smoothed hit rate: observed hits/scans blended
 *  with the tenant-wide conversion rate at CELL_PRIOR_SCANS pseudo-scans, so a
 *  cell needs real evidence to rank above the global average. */
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
     , prior AS (
       SELECT CAST((SELECT COUNT(*) FROM leads l2
                     WHERE l2.tenant_id=? AND l2.lead_tag='fresh_fiber_confirmed'
                       AND l2.created_at >= datetime('now','-${TIER_B_FRESH_WINDOW_DAYS} days')) AS REAL)
              / (1 + (SELECT COUNT(*) FROM scan_targets s2
                       WHERE s2.tenant_id=? AND s2.last_scanned_at IS NOT NULL)) AS p0
     )
     SELECT s.id
       FROM scan_targets s
       JOIN fresh_cells fc
         ON ROUND(s.lat,2)=fc.clat AND ROUND(s.lng,2)=fc.clng
       LEFT JOIN cell_scans cs ON cs.clat=fc.clat AND cs.clng=fc.clng
      CROSS JOIN prior pr
      WHERE s.tenant_id=? AND s.last_scanned_at IS NULL
        AND s.lat IS NOT NULL AND s.lng IS NOT NULL
        AND lower(s.state) IN (${STATE_IN})
      ORDER BY (CAST(fc.hits AS REAL) + ${CELL_PRIOR_SCANS}*pr.p0)
               / (COALESCE(cs.scanned,0) + ${CELL_PRIOR_SCANS}) DESC,
               fc.hits DESC, s.id ASC
      LIMIT ?`,
  ).all(tenantId, tenantId, tenantId, tenantId, tenantId, ...stateArgs(), limit) as TierRow[];
}

/** Tier B2: street completion — every never-scanned address sharing a street
 *  with a fresh lead (builders light whole streets at once). Streets match on
 *  the canonical harvest_street_key: house number + unit stripped, suffix
 *  synonyms folded — "22 Fiber Street Apt 4" completes "17 Fiber St". */
export function tierB2(tenantId: number, limit: number): TierRow[] {
  if (limit <= 0) return [];
  registerHarvestSqlFunctions();
  return rawDb.prepare(
    `WITH fresh_streets AS (
       SELECT DISTINCT harvest_street_key(l.address) AS street,
              lower(l.city) AS city, lower(l.state) AS state
         FROM leads l
        WHERE l.tenant_id=? AND l.lead_tag='fresh_fiber_confirmed'
          AND l.created_at >= datetime('now','-${TIER_B_FRESH_WINDOW_DAYS} days')
          AND harvest_street_key(l.address) <> ''
     )
     SELECT s.id
       FROM scan_targets s
       JOIN fresh_streets fs
         ON harvest_street_key(s.address)=fs.street
        AND lower(s.city)=fs.city AND lower(s.state)=fs.state
      WHERE s.tenant_id=? AND s.last_scanned_at IS NULL
        AND lower(s.state) IN (${STATE_IN})
      ORDER BY s.id ASC
      LIMIT ?`,
  ).all(tenantId, tenantId, ...stateArgs(), limit) as TierRow[];
}

// Expansion tiers read state_fiber_markets, which a bare replay/test DB may
// not have yet — no markets known means no expansion work, not a crash.
function marketsTableReady(): boolean {
  return !!rawDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='state_fiber_markets'`).get();
}

/** Tier E1: never-scanned targets in officially announced expansion markets.
 *  Cold-start coverage — these cities may have zero fresh leads yet, so the
 *  density-driven tiers ignore them; the announced build is the evidence. */
export function tierE1(tenantId: number, limit: number): TierRow[] {
  if (limit <= 0 || !marketsTableReady()) return [];
  return rawDb.prepare(
    `SELECT s.id
       FROM scan_targets s
       JOIN state_fiber_markets m
         ON m.kinetic_status='verified_expanding' AND m.auto_scan_eligible=1
        AND lower(m.state)=lower(s.state) AND lower(m.city)=lower(s.city)
      WHERE s.tenant_id=? AND s.last_scanned_at IS NULL
        AND lower(s.state) IN (${STATE_IN})
      ORDER BY s.id ASC
      LIMIT ?`,
  ).all(tenantId, ...stateArgs(), limit) as TierRow[];
}

/** Tier E2: stale negatives in expansion markets, re-checked at 7 days —
 *  active builds flip addresses weekly, not monthly. */
export function tierE2(tenantId: number, limit: number): TierRow[] {
  if (limit <= 0 || !marketsTableReady()) return [];
  return rawDb.prepare(
    `SELECT s.id
       FROM scan_targets s
       JOIN state_fiber_markets m
         ON m.kinetic_status='verified_expanding' AND m.auto_scan_eligible=1
        AND lower(m.state)=lower(s.state) AND lower(m.city)=lower(s.city)
      WHERE s.tenant_id=?
        AND s.last_scanned_at IS NOT NULL
        AND s.last_scanned_at < datetime('now','-${TIER_E2_STALE_DAYS} days')
        AND COALESCE(s.last_fiber_status,'') IN ('no_service','copper')
        AND lower(s.state) IN (${STATE_IN})
      ORDER BY s.last_scanned_at ASC
      LIMIT ?`,
  ).all(tenantId, ...stateArgs(), limit) as TierRow[];
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

/** Tier D: stale no_service/copper verdicts, oldest first — FOOTPRINT-GATED.
 *  A negative verdict outside the Kinetic footprint can never flip to fiber, so
 *  re-checking it every 30 days is pure proxy waste. Only re-scan stale
 *  negatives in auto_scan_eligible markets. Fail-open: until the footprint is
 *  loaded (footprintGateActive false) the tier behaves as before. Tiers
 *  B/B2/C/C0/D1 are already implicitly footprint-gated (they join fresh-lead
 *  density or explicit priority cities); D is the only tier that would otherwise
 *  re-burn addresses in towns Kinetic will never serve. */
export function tierD(tenantId: number, limit: number): TierRow[] {
  if (limit <= 0) return [];
  registerFootprintSqlFunctions();
  warmFootprintGate(); // snapshot before the query — an in-query cold read fails open
  return rawDb.prepare(
    `SELECT s.id
       FROM scan_targets s
      WHERE s.tenant_id=?
        AND s.last_scanned_at IS NOT NULL
        AND s.last_scanned_at < datetime('now','-${TIER_D_STALE_DAYS} days')
        AND COALESCE(s.last_fiber_status,'') IN ('no_service','copper')
        AND lower(s.state) IN (${STATE_IN})
        AND footprint_city(s.state, s.city)=1
      ORDER BY s.last_scanned_at ASC
      LIMIT ?`,
  ).all(tenantId, ...stateArgs(), limit) as TierRow[];
}

/**
 * Compose and dispatch one harvest cycle. Returns per-tier counts (also
 * structured-logged). Daily-safe: selection is due-based, so cycles never
 * repeat work that isn't due again.
 */
export function runHarvestCycle(tenantId: number, budget = Number(process.env.FRESH_HARVEST_BUDGET) || 4000): { b: number; b2: number; e1: number; c0: number; c: number; e2: number; d1: number; d: number; runId?: string } {
  // Circuit breaker: proxy auth/limit denials → freeze the cycle entirely.
  if (isProxyCircuitOpen()) {
    structuredLog("fresh_harvest.cycle", { b: 0, b2: 0, e1: 0, c0: 0, c: 0, e2: 0, d1: 0, d: 0, skipped: "proxy circuit open" });
    return { b: 0, b2: 0, e1: 0, c0: 0, c: 0, e2: 0, d1: 0, d: 0 };
  }
  // Time-of-day budget shaping: proxy spend follows idle capacity.
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 6) budget = Math.round(budget * 1.5);        // overnight push
  else if (hour >= 9 && hour < 17) budget = Math.round(budget * 0.5);  // business hours: gentle
  // Bandwidth governor: pace spend against the monthly Decodo pool. When the
  // pool runs ahead of pace the budget shrinks; when we're behind pace it
  // grows (max ×1.5). Strategic cut order under scarcity: D2 dies first
  // (scale<0.5), then D1 (scale<0.25) — fresh-hunting tiers never starve.
  const bwScale = bandwidthBudgetScale();
  budget = Math.round(budget * bwScale);
  const d1Cap = bwScale < 0.25 ? 0 : budget;
  const dCap = bwScale < 0.5 ? 0 : budget;
  const seen = new Set<number>();
  const pick = (rows: TierRow[]) => rows.filter((r) => !seen.has(r.id)).map((r) => { seen.add(r.id); return r.id; });

  let left = budget;
  const spend = (rows: TierRow[]) => { const ids = pick(rows); left -= ids.length; return ids; };

  const b = spend(tierB(tenantId, left));
  const b2 = spend(tierB2(tenantId, left));
  const e1 = spend(tierE1(tenantId, left));
  const c0 = spend(tierC0(tenantId, left));
  const c = spend(tierC(tenantId, left));
  // Expansion flip watch is never scarcity-capped: announced builds are the
  // top-yield rechecks. D1/D keep the strategic cut order.
  const e2 = spend(tierE2(tenantId, left));
  const d1 = spend(tierD1(tenantId, Math.min(d1Cap, left)));
  const d = spend(tierD(tenantId, Math.min(dCap, left)));
  const ids = [...b, ...b2, ...e1, ...c0, ...c, ...e2, ...d1, ...d];

  const counts = { b: b.length, b2: b2.length, e1: e1.length, c0: c0.length, c: c.length, e2: e2.length, d1: d1.length, d: d.length };
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
    label: `FRESH HARVEST b${counts.b}/b2:${counts.b2}/e1:${counts.e1}/c0:${counts.c0}/c${counts.c}/e2:${counts.e2}/d1:${counts.d1}/d${counts.d}`,
  });
  structuredLog("fresh_harvest.cycle", { ...counts, runId, total: ids.length, bwScale });
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
    const bw = governorStats();
    structuredLog("fresh_harvest.economy", {
      checks24h: checks,
      blocked24h: Number(s?.blocked ?? 0),
      blockRate: checks ? +(Number(s?.blocked ?? 0) / checks).toFixed(3) : 0,
      freshVerdicts24h: fresh,
      freshLeads24h: leads,
      callsPerFreshLead: leads ? +(checks / leads).toFixed(1) : null,
      // bandwidth governor: the true Decodo cost of the operation
      requests24h: bw.requests24h,
      mb24h: bw.mb24h,
      mbToday: bw.mbToday,
      gbCycle: bw.gbCycle,
      cyclePctUsed: bw.cyclePctUsed,
      projectedCycleGb: bw.projectedCycleGb,
      budgetGb: bw.budgetGb,
      estReqBytes: bw.estReqBytes,
      bwScale: bw.scale,
      // rolling-24h bytes over rolling-24h leads: the windows must match
      kbPerFreshLead: leads && bw.requests24h ? +((bw.mb24h * 1000) / leads).toFixed(1) : null,
    });
  } catch { /* best-effort metrics */ }
}
