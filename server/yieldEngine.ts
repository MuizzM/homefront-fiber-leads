/**
 * YIELD ENGINE (Harvest 3.0) — one unified, self-learning scoring system.
 *
 * Replaces fixed tiers with a single expected-yield score per address,
 * recomputed every cycle from live conversion data:
 *
 *   score = wCell  · cell hit rate   (fresh leads per scanned address, ~1.1km)
 *         + wStreet· street match    (shares a street with a 21d fresh lead)
 *         + wCity  · ln(1+city hits) (21d fresh density of the city)
 *         + wWatch · coming-soon     (active watchlist member, due)
 *         + wNew   · new discovery   (target first seen < 7d ago — fresh
 *                                     construction inventory enters here)
 *
 * Budget flows top-down by score. No rigid tiers — the fleet flows to
 * wherever fiber is being lit THIS week.
 *
 * EXPLORE/EXPLOIT: 85% of the budget goes to the highest scores (exploit);
 * 15% goes to a random sample of never-scanned NC/SC addresses (explore) so
 * we discover NEW build zones before they appear in our lead data.
 *
 * NIGHTLY LEARNING (learnYieldWeights): the w-weights are recomputed from
 * realized conversion — of the addresses we checked in the last 14 days that
 * carried each signal, what fraction came back fresh? Rates are normalized
 * against the base rate and stored in yield_weights. The engine measurably
 * gets smarter every night.
 *
 * Spending is still governed end-to-end: circuit breaker, time-of-day
 * shaping, and the bandwidth governor's budgetScale all apply here.
 * YIELD_ENGINE=off falls back to the classic tier harvester.
 */
import { rawDb } from "./db";
import { startTargetRun } from "./scanService";
import { structuredLog } from "./structuredLog";
import { bandwidthBudgetScale, isProxyCircuitOpen } from "./bandwidthGovernor";
import { registerHarvestSqlFunctions } from "./freshHarvest";
import { registerFootprintSqlFunctions, warmFootprintGate } from "./footprintGate";

const FRESH_WINDOW_DAYS = 21;
const EXPLORE_FRACTION = 0.15;
const LEARN_MIN_SAMPLES = 200;         // don't learn from noise
// Empirical-Bayes prior strength for the cell hit-rate: a cell's observed
// hits/scans is blended with the tenant-wide conversion rate as if it had this
// many extra scans at the base rate, so a lucky 1-hit/1-scan cell can't outrank
// a proven 8-hits/20-scans cell.
const CELL_PRIOR = Math.max(1, Number(process.env.FRESH_HARVEST_CELL_PRIOR) || 12);
// FLIP PROXIMITY (the "be first" override): a confirmed fresh lead in an
// address's cell or street within this many days makes that address's stale
// negative immediately due — overriding the 30-day/7-day cooldown — because
// builders light contiguous streets over days, so the neighbour of a drop
// that just lit is the single highest-probability next flip.
const FLIP_PROXIMITY_DAYS = Math.max(1, Number(process.env.FLIP_PROXIMITY_DAYS) || 3);
// …but never re-check the same address more than once per this window, so the
// override tightens cadence to hours, not to every 15-min cycle.
const FLIP_MIN_COOLDOWN_HOURS = Math.max(1, Number(process.env.FLIP_MIN_COOLDOWN_HOURS) || 12);

const FOCUS_STATES = (process.env.FRESH_HARVEST_STATES ?? "nc,sc")
  .split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
const STATE_IN = FOCUS_STATES.map(() => "?").join(",");
const stateArgs = () => [...FOCUS_STATES];

interface Weights { cell: number; street: number; city: number; watch: number; new: number; prox: number; expand: number }
// prox sits just under watch: a fresh drop next door is nearly as strong a
// signal as a provider-confirmed coming-soon. expand gives announced-build
// cities cold-start lift before their first lead exists.
const DEFAULT_WEIGHTS: Weights = { cell: 1.0, street: 0.9, city: 0.35, watch: 2.0, new: 0.25, prox: 1.6, expand: 0.6 };

// state_fiber_markets is created by the market catalog on boot; a bare replay/
// test DB may lack it. footprint_city() fails open without it, but the
// expansion JOIN references it directly, so guard that fragment.
function marketsTableReady(): boolean {
  try {
    return !!rawDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='state_fiber_markets'`).get();
  } catch { return false; }
}

let ensured = false;
function ensureTable(): void {
  if (ensured) return;
  try {
    rawDb.exec(`CREATE TABLE IF NOT EXISTS yield_weights (
      name TEXT PRIMARY KEY, value REAL NOT NULL, samples INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    ensured = true;
  } catch { /* best-effort */ }
}

export function getWeights(): Weights {
  try {
    ensureTable();
    const rows = rawDb.prepare("SELECT name, value FROM yield_weights").all() as any[];
    const w = { ...DEFAULT_WEIGHTS } as any;
    for (const r of rows) if (r.name in w && Number.isFinite(r.value)) w[r.name] = r.value;
    return w as Weights;
  } catch { return { ...DEFAULT_WEIGHTS }; }
}

/**
 * Nightly learning: measure each signal's realized fresh-conversion over the
 * last 14 days and normalize against the base rate. Weights move toward the
 * signals that actually produce leads; every move is logged.
 */
export function learnYieldWeights(tenantId: number): void {
  try {
    ensureTable();
    const base = rawDb.prepare(
      `SELECT COUNT(*) AS n, SUM(fresh) AS f FROM availability_snapshots
        WHERE checked_at_epoch > ?`,
    ).get(Date.now() - 14 * 86_400_000) as any;
    const n = Number(base?.n ?? 0), f = Number(base?.f ?? 0);
    if (n < LEARN_MIN_SAMPLES) return;
    const baseRate = f / n;
    if (baseRate <= 0) return;

    // Street-signal conversion: fresh verdicts on addresses whose street
    // shared a 21d fresh lead at check time (approximated by current join).
    registerHarvestSqlFunctions();
    const street = rawDb.prepare(
      `WITH fs AS (
         SELECT DISTINCT harvest_street_key(l.address) AS street, lower(l.city) AS city
           FROM leads l
          WHERE l.tenant_id=? AND l.lead_tag='fresh_fiber_confirmed'
            AND l.created_at >= datetime('now','-${FRESH_WINDOW_DAYS} days')
            AND harvest_street_key(l.address) <> ''
       )
       SELECT COUNT(*) AS n, SUM(s.fresh) AS f
         FROM availability_snapshots s
         JOIN scan_targets t ON t.id = s.scan_target_id
         JOIN fs ON fs.street = harvest_street_key(t.address) AND fs.city = lower(t.city)
        WHERE s.checked_at_epoch > ?`,
    ).get(tenantId, Date.now() - 14 * 86_400_000) as any;

    const updates: Array<[string, number, number]> = [];
    if (Number(street?.n ?? 0) >= LEARN_MIN_SAMPLES) {
      const rate = Number(street.f ?? 0) / Number(street.n);
      // weight = signal lift over base, clamped to a sane band
      updates.push(["street", Math.min(2.5, Math.max(0.2, rate / baseRate)), Number(street.n)]);
    }
    for (const [name, value, samples] of updates) {
      rawDb.prepare(
        `INSERT INTO yield_weights (name, value, samples, updated_at) VALUES (?,?,?,datetime('now'))
         ON CONFLICT(name) DO UPDATE SET value=excluded.value, samples=excluded.samples, updated_at=excluded.updated_at`,
      ).run(name, value, samples);
    }
    if (updates.length) {
      const flat: Record<string, number> = { baseRate: +baseRate.toFixed(4) };
      for (const [k, v, n] of updates) { flat[`w_${k}`] = +v.toFixed(3); flat[`n_${k}`] = n; }
      structuredLog("yield_engine.learn", flat);
    }
  } catch (e: any) { console.warn("[yield-engine] learn skipped:", e?.message); }
}

interface ScoredRow { id: number; score: number }

/**
 * Score every due address in the focus states, footprint-gated to Kinetic
 * markets. Due = never scanned, stale negative (30d), stale copper (7d), due
 * coming-soon watchlist member, OR a flip-proximity override (stale negative
 * whose cell/street just produced a fresh drop → immediately due).
 */
export function scoreDueTargets(tenantId: number, limit: number): ScoredRow[] {
  if (limit <= 0) return [];
  registerHarvestSqlFunctions();   // harvest_street_key(address)
  registerFootprintSqlFunctions(); // footprint_city(state, city)
  warmFootprintGate();             // snapshot the eligible set before the query reads it
  const w = getWeights();
  const now = Date.now();
  const watchFreshCut = now - 12 * 3_600_000;
  const watchMatureCut = now - 2 * 3_600_000;
  const watchMatureAge = now - 48 * 3_600_000;
  const expand = marketsTableReady();
  // Expansion signal + CTE only when the market table exists (fail-safe on replay DBs).
  const expandCte = expand
    ? `, expanding AS (
         SELECT lower(state) AS state, lower(city) AS city FROM state_fiber_markets
          WHERE kinetic_status='verified_expanding' AND auto_scan_eligible=1
       )`
    : "";
  const expandJoin = expand
    ? `LEFT JOIN expanding ex ON ex.state=lower(s.state) AND ex.city=lower(s.city)`
    : "";
  const expandTerm = expand ? `+ ${w.expand} * (ex.city IS NOT NULL)` : "";
  return rawDb.prepare(
    `WITH fresh_cells AS (
       SELECT ROUND(l.lat,2) AS clat, ROUND(l.lng,2) AS clng, COUNT(*) AS hits
         FROM leads l
        WHERE l.tenant_id=? AND l.lat IS NOT NULL AND l.lng IS NOT NULL
          AND l.lead_tag='fresh_fiber_confirmed'
          AND l.created_at >= datetime('now','-${FRESH_WINDOW_DAYS} days')
        GROUP BY clat, clng
     ),
     recent_cells AS (
       SELECT ROUND(l.lat,2) AS clat, ROUND(l.lng,2) AS clng
         FROM leads l
        WHERE l.tenant_id=? AND l.lat IS NOT NULL AND l.lng IS NOT NULL
          AND l.lead_tag='fresh_fiber_confirmed'
          AND l.created_at >= datetime('now','-${FLIP_PROXIMITY_DAYS} days')
        GROUP BY clat, clng
     ),
     cell_scans AS (
       SELECT ROUND(s.lat,2) AS clat, ROUND(s.lng,2) AS clng, COUNT(*) AS scanned
         FROM scan_targets s
        WHERE s.tenant_id=? AND s.last_scanned_at IS NOT NULL
          AND s.lat IS NOT NULL AND s.lng IS NOT NULL
        GROUP BY clat, clng
     ),
     prior AS (
       SELECT CAST((SELECT COUNT(*) FROM leads l2
                     WHERE l2.tenant_id=? AND l2.lead_tag='fresh_fiber_confirmed'
                       AND l2.created_at >= datetime('now','-${FRESH_WINDOW_DAYS} days')) AS REAL)
              / (1 + (SELECT COUNT(*) FROM scan_targets s2
                       WHERE s2.tenant_id=? AND s2.last_scanned_at IS NOT NULL)) AS p0
     ),
     fresh_streets AS (
       SELECT DISTINCT harvest_street_key(l.address) AS street,
              lower(l.city) AS city, lower(l.state) AS state
         FROM leads l
        WHERE l.tenant_id=? AND l.lead_tag='fresh_fiber_confirmed'
          AND l.created_at >= datetime('now','-${FRESH_WINDOW_DAYS} days')
          AND harvest_street_key(l.address) <> ''
     ),
     recent_streets AS (
       SELECT DISTINCT harvest_street_key(l.address) AS street,
              lower(l.city) AS city, lower(l.state) AS state
         FROM leads l
        WHERE l.tenant_id=? AND l.lead_tag='fresh_fiber_confirmed'
          AND l.created_at >= datetime('now','-${FLIP_PROXIMITY_DAYS} days')
          AND harvest_street_key(l.address) <> ''
     ),
     city_hits AS (
       SELECT lower(l.city) AS city, lower(l.state) AS state, COUNT(*) AS hits
         FROM leads l
        WHERE l.tenant_id=? AND l.lead_tag='fresh_fiber_confirmed'
          AND l.created_at >= datetime('now','-${FRESH_WINDOW_DAYS} days')
        GROUP BY lower(l.city), lower(l.state)
     ),
     due_watch AS (
       SELECT w.scan_target_id AS id FROM coming_soon_watchlist w
        WHERE w.tenant_id=? AND w.status='active'
          AND (w.last_checked_at IS NULL
               OR (w.first_seen_at >  ? AND w.last_checked_at < ?)
               OR (w.first_seen_at <= ? AND w.last_checked_at < ?))
     )${expandCte}
     SELECT s.id,
            ( ${w.cell}   * COALESCE((CAST(fc.hits AS REAL) + ${CELL_PRIOR}*pr.p0)
                                     / (COALESCE(cs.scanned,0) + ${CELL_PRIOR}), 0)
            + ${w.street} * (fs.street IS NOT NULL)
            + ${w.city}   * COALESCE(ln(1+ch.hits), 0)
            + ${w.watch}  * (dw.id IS NOT NULL)
            + ${w.new}    * (s.created_at >= datetime('now','-7 days'))
            + ${w.prox}   * ((rc.clat IS NOT NULL) OR (rs.street IS NOT NULL))
            ${expandTerm}
            ) AS score
       FROM scan_targets s
       CROSS JOIN prior pr
       LEFT JOIN fresh_cells fc ON fc.clat=ROUND(s.lat,2) AND fc.clng=ROUND(s.lng,2)
       LEFT JOIN recent_cells rc ON rc.clat=ROUND(s.lat,2) AND rc.clng=ROUND(s.lng,2)
       LEFT JOIN cell_scans cs ON cs.clat=fc.clat AND cs.clng=fc.clng
       LEFT JOIN fresh_streets fs
         ON fs.street=harvest_street_key(s.address)
        AND fs.city=lower(s.city) AND fs.state=lower(s.state) AND harvest_street_key(s.address) <> ''
       LEFT JOIN recent_streets rs
         ON rs.street=harvest_street_key(s.address)
        AND rs.city=lower(s.city) AND rs.state=lower(s.state) AND harvest_street_key(s.address) <> ''
       LEFT JOIN city_hits ch ON ch.city=lower(s.city) AND ch.state=lower(s.state)
       LEFT JOIN due_watch dw ON dw.id = s.id
       ${expandJoin}
      WHERE s.tenant_id=?
        AND lower(s.state) IN (${STATE_IN})
        AND footprint_city(s.state, s.city)=1
        AND (
          s.last_scanned_at IS NULL
          OR (COALESCE(s.last_fiber_status,'')='copper' AND s.last_scanned_at < datetime('now','-7 days'))
          OR (COALESCE(s.last_fiber_status,'')='no_service' AND s.last_scanned_at < datetime('now','-30 days'))
          OR dw.id IS NOT NULL
          -- Flip-proximity override: a stale negative whose cell/street just
          -- produced a fresh drop is due NOW (past the min cooldown), not in 30d.
          OR (COALESCE(s.last_fiber_status,'') IN ('no_service','copper')
              AND (s.last_scanned_at IS NULL
                   OR s.last_scanned_at < datetime('now','-${FLIP_MIN_COOLDOWN_HOURS} hours'))
              AND (rc.clat IS NOT NULL OR rs.street IS NOT NULL))
        )
      ORDER BY score DESC, s.id ASC
      LIMIT ?`,
  ).all(
    tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId,
    watchMatureAge, watchFreshCut, watchMatureAge, watchMatureCut,
    tenantId, ...stateArgs(), limit,
  ) as ScoredRow[];
}

/**
 * One yield cycle: score → exploit top 85% → explore 15% random never-scanned
 * → dispatch. Same guards as the classic harvester (circuit, day/night,
 * bandwidth governor, scarcity cut: explore dies first, then low scores).
 */
export function runYieldCycle(tenantId: number, budget = Number(process.env.FRESH_HARVEST_BUDGET) || 4000): { exploit: number; explore: number; runId?: string } {
  if (isProxyCircuitOpen()) {
    structuredLog("yield_engine.cycle", { exploit: 0, explore: 0, skipped: "proxy circuit open" });
    return { exploit: 0, explore: 0 };
  }
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 6) budget = Math.round(budget * 1.5);
  else if (hour >= 9 && hour < 17) budget = Math.round(budget * 0.5);
  const bwScale = bandwidthBudgetScale();
  budget = Math.round(budget * bwScale);
  if (budget <= 0) {
    structuredLog("yield_engine.cycle", { exploit: 0, explore: 0, skipped: "bandwidth governor", bwScale });
    return { exploit: 0, explore: 0 };
  }

  // Scarcity cut order under a shrinking bandwidth pool: explore dies first.
  const exploreFrac = bwScale < 0.5 ? 0 : EXPLORE_FRACTION;
  const exploitBudget = Math.floor(budget * (1 - exploreFrac));
  const scored = scoreDueTargets(tenantId, exploitBudget);
  const exploit = scored.map((r) => r.id);
  const seen = new Set(exploit);

  // Explore: random never-scanned in focus states — discover NEW build zones.
  // Footprint-gated: exploration stays inside the Kinetic footprint so the 15%
  // discovery budget can never burn on towns Kinetic will not serve.
  let explore: number[] = [];
  const exploreBudget = budget - exploit.length;
  if (exploreBudget > 0) {
    registerFootprintSqlFunctions();
    warmFootprintGate();
    explore = (rawDb.prepare(
      `SELECT s.id FROM scan_targets s
        WHERE s.tenant_id=? AND s.last_scanned_at IS NULL
          AND lower(s.state) IN (${STATE_IN})
          AND footprint_city(s.state, s.city)=1
        ORDER BY RANDOM() LIMIT ?`,
    ).all(tenantId, ...stateArgs(), exploreBudget + seen.size) as any[])
      .map((r) => r.id).filter((id) => !seen.has(id)).slice(0, exploreBudget);
  }

  const ids = [...exploit, ...explore];
  if (!ids.length) {
    structuredLog("yield_engine.cycle", { exploit: 0, explore: 0, skipped: "nothing due", bwScale });
    return { exploit: 0, explore: 0 };
  }
  const { runId } = startTargetRun({
    tenantId,
    city: "yield-engine",
    state: "multi",
    targetIds: ids,
    runKind: "fresh_harvest",
    label: `YIELD ENGINE x${exploit.length}/e${explore.length} bw${bwScale.toFixed(2)}`,
  });
  const w = getWeights();
  structuredLog("yield_engine.cycle", {
    exploit: exploit.length, explore: explore.length, runId, total: ids.length,
    bwScale, topScore: +(scored[0]?.score ?? 0).toFixed(3), medianScore: +(scored[Math.floor(scored.length / 2)]?.score ?? 0).toFixed(3),
    wCell: w.cell, wStreet: w.street, wCity: w.city, wProx: w.prox, wExpand: w.expand,
  });
  return { exploit: exploit.length, explore: explore.length, runId };
}
