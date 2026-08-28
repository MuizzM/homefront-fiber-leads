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
import { registerFootprintSqlFunctions, warmFootprintGate, footprintGateActive, isFootprintCity } from "./footprintGate";
import { budgetShapeFactor } from "./harvestScheduler";
import { yieldRollupsReady } from "./yieldRollups";
import { anfParkedSql, provenHourlyCapacity } from "@shared/scanPolicy";
import { isoDaysAgo } from "./sqlTime";

const FRESH_WINDOW_DAYS = 21;
// Fraction of each cycle's budget spent on random NEVER-scanned footprint
// addresses (discovery) vs. the highest-yield scored targets (exploit). Raising
// it reaches full coverage of enumerated inventory faster — worthwhile under an
// unlimited plan where breadth costs nothing. Env-tunable; clamped [0, 0.9] so
// exploit is never fully starved. Default 0.15.
const EXPLORE_FRACTION = Math.min(0.9, Math.max(0, Number(process.env.YIELD_EXPLORE_FRACTION) || 0.15));
// GUARANTEED DISCOVERY LANE (the Stonewyck fairness fix): a reserved share of
// EVERY cycle goes to the OLDEST never-scanned in-footprint targets,
// partitioned round-robin by city so one hot metro cannot consume the lane.
// Unlike explore (density-ranked, dies first under scarcity), this lane is
// never cut — an eligible address must not stay never-scanned indefinitely.
const DISCOVERY_FRACTION = Math.min(0.5, Math.max(0.05, Number(process.env.YIELD_DISCOVERY_FRACTION) || 0.2));
// First-scan SLA: never-scanned older than this logs a violation alert.
const FIRST_SCAN_SLA_DAYS = Math.max(1, Number(process.env.YIELD_FIRST_SCAN_SLA_DAYS) || 14);
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
// BUILD MOMENTUM: the cell hit-RATE says how likely a scan converts; momentum
// says how ACTIVELY fiber is being lit here right now. A cell's momentum is the
// recency-weighted count of its confirmed drops — each drop weighted
// 2^(-age/halflife) — so five drops all this week outscore five spread over a
// month. Surfaces the live build front, not last month's finished subdivision.
const MOMENTUM_HALFLIFE_DAYS = Math.max(0.5, Number(process.env.MOMENTUM_HALFLIFE_DAYS) || 7);
const MOMENTUM_WINDOW_DAYS = Math.max(1, Number(process.env.MOMENTUM_WINDOW_DAYS) || 21);
const LN2 = 0.6931471805599453;

// Parked address_not_found targets (INCONCLUSIVE_GIVEUP+ needs-fix non-answers
// inside the quiet window) are NOT eligible: the claim layer skips them, so
// picking them burns queue slots and produces 0 checks (observed live: 8,229
// enqueued → all skipped → zero checks).
const ANF_QUIET_DAYS = Math.max(1, Math.floor(Number(process.env.ADDRESS_NOT_FOUND_QUIET_DAYS ?? 14) || 14));
const ANF_GIVEUP = 3; // mirrors shared/scanPolicy INCONCLUSIVE_GIVEUP
const NOT_PARKED_ANF = `NOT ${anfParkedSql("s", ANF_QUIET_DAYS)}`;

// Default NC + SC + GA — the full Kinetic build footprint the operator works.
// This MUST match the KEEPWARM statewide feeder (index.ts) and the fresh-lead
// projector (freshFiberProjector.ts: `state IN ('GA','NC','SC')`): a narrower
// default here silently starved every GA target of yield-engine budget while
// the projector stood ready to mint GA leads, so GA scanned to zero checks.
const FOCUS_STATES = (process.env.FRESH_HARVEST_STATES ?? "nc,sc,ga")
  .split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
const STATE_IN = FOCUS_STATES.map(() => "?").join(",");
const stateArgs = () => [...FOCUS_STATES];

// KINETIC-ONLY (owner directive 2026-07-23): all live scanning, discovery, and
// rechecks target Kinetic-carrier addresses only. Frontier rows stay in the
// pool for audit/rollback but are never selected. NULL carrier = kinetic
// (legacy rows predate the column).
const KINETIC_ONLY = `COALESCE(s.carrier,'kinetic')='kinetic'`;

interface Weights { cell: number; street: number; city: number; watch: number; new: number; prox: number; expand: number; momentum: number }
// prox sits just under watch: a fresh drop next door is nearly as strong a
// signal as a provider-confirmed coming-soon. expand gives announced-build
// cities cold-start lift before their first lead exists. momentum favours the
// live build front (recency-weighted drop density).
const DEFAULT_WEIGHTS: Weights = { cell: 1.0, street: 0.9, city: 0.35, watch: 2.0, new: 0.25, prox: 1.6, expand: 0.6, momentum: 0.8 };

// state_fiber_markets is created by the market catalog on boot; a bare replay/
// test DB may lack it. footprint_city() fails open without it, but the
// expansion JOIN references it directly, so guard that fragment.
function tableReady(name: string): boolean {
  try {
    return !!rawDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  } catch { return false; }
}
function marketsTableReady(): boolean { return tableReady("state_fiber_markets"); }

// Adaptive recheck cadence for negatives: instead of a fixed cooldown, wait
// longer the more times an address has come back unchanged-negative — the
// change-likelihood is dropping. A fresh negative rechecks at NEG_BASE_DAYS;
// each additional unchanged negative doubles the wait, capped at NEG_MAX_DAYS.
// The flip-proximity override still bypasses this entirely, so a neighbour
// flipping instantly resets a chronic-dead address to due — we never freeze a
// high-probability neighbour for weeks. Powers of two via SQLite's << operator.
const NEG_BASE_DAYS = Math.max(1, Number(process.env.NEG_RECHECK_BASE_DAYS) || 7);
const NEG_MAX_DAYS = Math.max(NEG_BASE_DAYS, Number(process.env.NEG_RECHECK_MAX_DAYS) || 60);
const NEG_STREAK_WINDOW_DAYS = 120;
const NEG_SHIFT_CAP = 3; // 2^3 → base×8 before the MAX clamp

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

/** The weight names, derived from the defaults so the two cannot drift. A row
 *  whose name is not one of these is ignored: the table is written by the
 *  nightly learner, but an old row for a weight that no longer exists must not
 *  be able to add a key the scorer never reads. */
const WEIGHT_NAMES = Object.keys(DEFAULT_WEIGHTS) as (keyof Weights)[];
function isWeightName(name: unknown): name is keyof Weights {
  return typeof name === "string" && (WEIGHT_NAMES as string[]).includes(name);
}

export function getWeights(): Weights {
  try {
    ensureTable();
    const rows = rawDb.prepare("SELECT name, value FROM yield_weights").all() as Array<{ name: unknown; value: unknown }>;
    const w: Weights = { ...DEFAULT_WEIGHTS };
    for (const r of rows) {
      if (isWeightName(r.name) && typeof r.value === "number" && Number.isFinite(r.value)) w[r.name] = r.value;
    }
    return w;
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
    // With rollups ready, the target's street is the precomputed column — the
    // nightly pass stops evaluating the street UDF across the whole join, and
    // idx_availability_snapshots_epoch turns the 14d filter into a range scan.
    registerHarvestSqlFunctions();
    const targetStreet = yieldRollupsReady() ? "t.street_key" : "harvest_street_key(t.address)";
    const street = rawDb.prepare(
      `WITH fs AS (
         SELECT DISTINCT harvest_street_key(l.address) AS street, lower(l.city) AS city
           FROM leads l
          WHERE l.tenant_id=? AND l.lead_tag='fresh_fiber_confirmed'
            AND l.created_at >= ${isoDaysAgo(FRESH_WINDOW_DAYS)}
            AND harvest_street_key(l.address) <> ''
       )
       SELECT COUNT(*) AS n, SUM(s.fresh) AS f
         FROM availability_snapshots s
         JOIN scan_targets t ON t.id = s.scan_target_id
         JOIN fs ON fs.street = ${targetStreet} AND fs.city = lower(t.city)
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

interface ScoredRow {
  id: number;
  score: number;
  // Change-detection classes that must bypass the 18h bulk dedup window when
  // dispatched (see runYieldCycle's split): a due coming-soon watch member, and
  // a flip-proximity negative (a drop just lit its cell/street).
  isWatch?: number;
  isFlip?: number;
}

// Negative-recheck floor for verified_expanding markets: the adaptive backoff
// (7→56d) is right for settled towns, but in an ANNOUNCED build market the
// builders are actively flipping addresses — a chronic negative there must
// never back off past this many days, or we discover the build weeks late.
const EXPANSION_NEG_MAX_DAYS = Math.max(1, Number(process.env.EXPANSION_NEG_MAX_DAYS) || 7);

/**
 * Score every due address in the focus states, footprint-gated to Kinetic
 * markets. Due = never scanned, a negative past its ADAPTIVE recheck cadence
 * (base cadence doubled per unchanged-negative streak, capped), a due
 * coming-soon watchlist member, OR a flip-proximity override (a negative whose
 * cell/street just produced a fresh drop → immediately due, resetting cadence).
 */
export function scoreDueTargets(tenantId: number, limit: number): ScoredRow[] {
  if (limit <= 0) return [];
  // ROLLUP-BACKED PATH (yieldRollups.ts): once street_key/neg_streak/cell
  // columns + indexes are in place, score WITHOUT the per-row JS UDF calls and
  // WITHOUT the full availability_snapshots group — the reads that held a WAL
  // read mark for minutes and starved every checkpoint. Same signals, same
  // scoring expression, same due semantics; the legacy query below remains the
  // verbatim fallback until the backfill completes (and under YIELD_ROLLUPS=off).
  if (yieldRollupsReady()) return scoreDueTargetsRollup(tenantId, limit);
  registerHarvestSqlFunctions();   // harvest_street_key(address)
  registerFootprintSqlFunctions(); // footprint_city(state, city)
  warmFootprintGate();             // snapshot the eligible set before the query reads it
  const w = getWeights();
  const now = Date.now();
  const watchFreshCut = now - 12 * 3_600_000;
  const watchMatureCut = now - 2 * 3_600_000;
  const watchMatureAge = now - 48 * 3_600_000;
  const tid = tenantId | 0; // safe numeric inline for the optional CTE
  // Adaptive negative cadence: needs the snapshot history to count the streak.
  // Without it (replay/test DBs), fall back to the fixed 30d/7d cooldowns.
  const adaptive = tableReady("availability_snapshots");
  const negStreakCte = adaptive
    ? `, neg_streak AS (
         SELECT scan_target_id AS id, COUNT(*) AS streak
           FROM availability_snapshots
          WHERE tenant_id=${tid} AND conclusive=1 AND fiber_available=0
            AND checked_at_epoch > ${now - NEG_STREAK_WINDOW_DAYS * 86_400_000}
          GROUP BY scan_target_id
       )`
    : "";
  const negJoin = adaptive ? `LEFT JOIN neg_streak ns ON ns.id = s.id` : "";
  const expand = marketsTableReady();
  // Effective cadence in days = min(MAX, BASE × 2^min(streak-1, cap)) — but a
  // verified_expanding market gets a FLOOR (EXPANSION_NEG_MAX_DAYS): builders
  // are actively flipping addresses there, so a chronic negative never backs
  // off past ~a week in the exact towns where flips are most likely.
  const adaptiveDays = `${NEG_BASE_DAYS} * (1 << MIN(COALESCE(ns.streak,1)-1, ${NEG_SHIFT_CAP}))`;
  const negCadenceDays = expand
    ? `CASE WHEN ex.city IS NOT NULL
            THEN MIN(${EXPANSION_NEG_MAX_DAYS}, MIN(${NEG_MAX_DAYS}, ${adaptiveDays}))
            ELSE MIN(${NEG_MAX_DAYS}, ${adaptiveDays}) END`
    : `MIN(${NEG_MAX_DAYS}, ${adaptiveDays})`;
  const negDueClause = adaptive
    ? `(COALESCE(s.last_fiber_status,'') IN ('no_service','copper')
        AND s.last_scanned_at < datetime('now','-' || (${negCadenceDays}) || ' days'))`
    : `((COALESCE(s.last_fiber_status,'')='copper' AND s.last_scanned_at < datetime('now','-7 days'))
        OR (COALESCE(s.last_fiber_status,'')='no_service' AND s.last_scanned_at < datetime('now','-30 days')))`;
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
          AND l.created_at >= ${isoDaysAgo(FRESH_WINDOW_DAYS)}
        GROUP BY clat, clng
     ),
     recent_cells AS (
       SELECT ROUND(l.lat,2) AS clat, ROUND(l.lng,2) AS clng
         FROM leads l
        WHERE l.tenant_id=? AND l.lat IS NOT NULL AND l.lng IS NOT NULL
          AND l.lead_tag='fresh_fiber_confirmed'
          AND l.created_at >= ${isoDaysAgo(FLIP_PROXIMITY_DAYS)}
        GROUP BY clat, clng
     ),
     cell_momentum AS (
       -- recency-weighted drop count per cell: each drop counts 2^(-age/halflife)
       SELECT ROUND(l.lat,2) AS clat, ROUND(l.lng,2) AS clng,
              SUM(exp(-${LN2} * MAX(0, julianday('now')-julianday(l.created_at)) / ${MOMENTUM_HALFLIFE_DAYS})) AS momentum
         FROM leads l
        WHERE l.tenant_id=${tid} AND l.lat IS NOT NULL AND l.lng IS NOT NULL
          AND l.lead_tag='fresh_fiber_confirmed'
          AND l.created_at >= ${isoDaysAgo(MOMENTUM_WINDOW_DAYS)}
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
                       AND l2.created_at >= ${isoDaysAgo(FRESH_WINDOW_DAYS)}) AS REAL)
              / (1 + (SELECT COUNT(*) FROM scan_targets s2
                       WHERE s2.tenant_id=? AND s2.last_scanned_at IS NOT NULL)) AS p0
     ),
     fresh_streets AS (
       SELECT DISTINCT harvest_street_key(l.address) AS street,
              lower(l.city) AS city, lower(l.state) AS state
         FROM leads l
        WHERE l.tenant_id=? AND l.lead_tag='fresh_fiber_confirmed'
          AND l.created_at >= ${isoDaysAgo(FRESH_WINDOW_DAYS)}
          AND harvest_street_key(l.address) <> ''
     ),
     recent_streets AS (
       SELECT DISTINCT harvest_street_key(l.address) AS street,
              lower(l.city) AS city, lower(l.state) AS state
         FROM leads l
        WHERE l.tenant_id=? AND l.lead_tag='fresh_fiber_confirmed'
          AND l.created_at >= ${isoDaysAgo(FLIP_PROXIMITY_DAYS)}
          AND harvest_street_key(l.address) <> ''
     ),
     city_hits AS (
       SELECT lower(l.city) AS city, lower(l.state) AS state, COUNT(*) AS hits
         FROM leads l
        WHERE l.tenant_id=? AND l.lead_tag='fresh_fiber_confirmed'
          AND l.created_at >= ${isoDaysAgo(FRESH_WINDOW_DAYS)}
        GROUP BY lower(l.city), lower(l.state)
     ),
     due_watch AS (
       SELECT w.scan_target_id AS id FROM coming_soon_watchlist w
        WHERE w.tenant_id=? AND w.status='active'
          AND (w.last_checked_at IS NULL
               OR (w.first_seen_at >  ? AND w.last_checked_at < ?)
               OR (w.first_seen_at <= ? AND w.last_checked_at < ?))
     )${expandCte}${negStreakCte}
     SELECT s.id,
            (dw.id IS NOT NULL) AS isWatch,
            (COALESCE(s.last_fiber_status,'') IN ('no_service','copper')
             AND (rc.clat IS NOT NULL OR rs.street IS NOT NULL)) AS isFlip,
            ( ${w.cell}   * COALESCE((CAST(fc.hits AS REAL) + ${CELL_PRIOR}*pr.p0)
                                     / (COALESCE(cs.scanned,0) + ${CELL_PRIOR}), 0)
            + ${w.street} * (fs.street IS NOT NULL)
            + ${w.city}   * COALESCE(ln(1+ch.hits), 0)
            + ${w.watch}  * (dw.id IS NOT NULL)
            + ${w.new}    * (s.created_at >= datetime('now','-7 days'))
            + ${w.prox}   * ((rc.clat IS NOT NULL) OR (rs.street IS NOT NULL))
            + ${w.momentum} * COALESCE(ln(1+cm.momentum), 0)
            ${expandTerm}
            ) AS score
       FROM scan_targets s NOT INDEXED
       CROSS JOIN prior pr
       LEFT JOIN fresh_cells fc ON fc.clat=ROUND(s.lat,2) AND fc.clng=ROUND(s.lng,2)
       LEFT JOIN recent_cells rc ON rc.clat=ROUND(s.lat,2) AND rc.clng=ROUND(s.lng,2)
       LEFT JOIN cell_momentum cm ON cm.clat=ROUND(s.lat,2) AND cm.clng=ROUND(s.lng,2)
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
       ${negJoin}
      WHERE s.tenant_id=?
        AND lower(s.state) IN (${STATE_IN})
        AND ${KINETIC_ONLY}
        AND footprint_city(s.state, s.city)=1
        AND ${NOT_PARKED_ANF}
        AND (
          s.last_scanned_at IS NULL
          OR ${negDueClause}
          OR dw.id IS NOT NULL
          -- Flip-proximity override: a negative whose cell/street just produced
          -- a fresh drop is due NOW (past the min cooldown), regardless of how
          -- far its adaptive cadence had backed off.
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
 * Rollup-backed scoring (yieldRollups.ts ready): identical signals and score
 * expression, but every per-row recomputation is a precomputed column —
 *   harvest_street_key(s.address)  → s.street_key   (janitor-maintained)
 *   ROUND(s.lat,2)/ROUND(s.lng,2)  → s.cell_lat/s.cell_lng (GENERATED — the
 *                                    exact same expressions, by construction)
 *   neg_streak CTE over snapshots  → s.neg_streak   (maintained in the
 *                                    conclusive-result UPDATE; reset by a
 *                                    conclusive positive — the documented
 *                                    "unchanged-negative streak" intent)
 * cell_scans groups over idx_scan_targets_cell (index-only) instead of a
 * full-table pass. footprint_city() stays: it is an in-memory Set lookup,
 * warmed before the query. The statement is timed and logged every cycle.
 */
function scoreDueTargetsRollup(tenantId: number, limit: number): ScoredRow[] {
  registerFootprintSqlFunctions();
  warmFootprintGate();
  const w = getWeights();
  const started = Date.now();
  const now = started;
  // INDEXED TEMP TABLES for the lead-side signal sets. As plain CTEs, SQLite
  // materialized them but then FULL-SCANNED each one PER OUTER ROW for five of
  // the seven joins (EXPLAIN: "SCAN fc LEFT-JOIN" …) — ~949k × five small
  // scans ≈ billions of comparisons; observed live as a 14-minute 97%-CPU
  // statement. Temp tables are per-connection, live in temp_store=MEMORY (zero
  // WAL), rebuild in milliseconds from the small leads table, and their
  // explicit indexes turn every join into a point lookup.
  rawDb.exec(`
    DROP TABLE IF EXISTS temp.yf_fresh_cells;
    -- TYPED columns are load-bearing: CREATE TABLE AS SELECT ROUND(…) yields
    -- NO column affinity, and SQLite cannot SEEK a REAL probe into a
    -- none-affinity index - the cell joins silently degrade to a full index
    -- scan PER OUTER ROW (observed live: 8.8-minute cycles; the local repro
    -- hid it because its signal tables were empty).
    CREATE TEMP TABLE yf_fresh_cells (clat REAL NOT NULL, clng REAL NOT NULL, hits INTEGER NOT NULL);
    INSERT INTO yf_fresh_cells (clat, clng, hits)
      SELECT ROUND(l.lat,2) AS clat, ROUND(l.lng,2) AS clng, COUNT(*) AS hits
        FROM leads l
       WHERE l.tenant_id=${tenantId | 0} AND l.lat IS NOT NULL AND l.lng IS NOT NULL
         AND l.lead_tag='fresh_fiber_confirmed'
         AND l.created_at >= ${isoDaysAgo(FRESH_WINDOW_DAYS)}
       GROUP BY clat, clng;
    CREATE INDEX idx_yf_fresh_cells ON yf_fresh_cells(clat, clng);
    DROP TABLE IF EXISTS temp.yf_recent_cells;
    CREATE TEMP TABLE yf_recent_cells (clat REAL NOT NULL, clng REAL NOT NULL);
    INSERT INTO yf_recent_cells (clat, clng)
      SELECT ROUND(l.lat,2) AS clat, ROUND(l.lng,2) AS clng
        FROM leads l
       WHERE l.tenant_id=${tenantId | 0} AND l.lat IS NOT NULL AND l.lng IS NOT NULL
         AND l.lead_tag='fresh_fiber_confirmed'
         AND l.created_at >= ${isoDaysAgo(FLIP_PROXIMITY_DAYS)}
       GROUP BY clat, clng;
    CREATE INDEX idx_yf_recent_cells ON yf_recent_cells(clat, clng);
    DROP TABLE IF EXISTS temp.yf_cell_momentum;
    CREATE TEMP TABLE yf_cell_momentum (clat REAL NOT NULL, clng REAL NOT NULL, momentum REAL);
    INSERT INTO yf_cell_momentum (clat, clng, momentum)
      SELECT ROUND(l.lat,2) AS clat, ROUND(l.lng,2) AS clng,
             SUM(exp(-${LN2} * MAX(0, julianday('now')-julianday(l.created_at)) / ${MOMENTUM_HALFLIFE_DAYS})) AS momentum
        FROM leads l
       WHERE l.tenant_id=${tenantId | 0} AND l.lat IS NOT NULL AND l.lng IS NOT NULL
         AND l.lead_tag='fresh_fiber_confirmed'
         AND l.created_at >= ${isoDaysAgo(MOMENTUM_WINDOW_DAYS)}
       GROUP BY clat, clng;
    CREATE INDEX idx_yf_cell_momentum ON yf_cell_momentum(clat, clng);
    DROP TABLE IF EXISTS temp.yf_fresh_streets;
    CREATE TEMP TABLE yf_fresh_streets (street TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL);
    INSERT INTO yf_fresh_streets (street, city, state)
      SELECT DISTINCT harvest_street_key(l.address) AS street,
             lower(l.city) AS city, lower(l.state) AS state
        FROM leads l
       WHERE l.tenant_id=${tenantId | 0} AND l.lead_tag='fresh_fiber_confirmed'
         AND l.created_at >= ${isoDaysAgo(FRESH_WINDOW_DAYS)}
         AND harvest_street_key(l.address) <> '';
    CREATE INDEX idx_yf_fresh_streets ON yf_fresh_streets(street, city, state);
    DROP TABLE IF EXISTS temp.yf_recent_streets;
    CREATE TEMP TABLE yf_recent_streets (street TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL);
    INSERT INTO yf_recent_streets (street, city, state)
      SELECT DISTINCT harvest_street_key(l.address) AS street,
             lower(l.city) AS city, lower(l.state) AS state
        FROM leads l
       WHERE l.tenant_id=${tenantId | 0} AND l.lead_tag='fresh_fiber_confirmed'
         AND l.created_at >= ${isoDaysAgo(FLIP_PROXIMITY_DAYS)}
         AND harvest_street_key(l.address) <> '';
    CREATE INDEX idx_yf_recent_streets ON yf_recent_streets(street, city, state);
    DROP TABLE IF EXISTS temp.yf_city_hits;
    CREATE TEMP TABLE yf_city_hits (city TEXT NOT NULL, state TEXT NOT NULL, hits INTEGER NOT NULL);
    INSERT INTO yf_city_hits (city, state, hits)
      SELECT lower(l.city) AS city, lower(l.state) AS state, COUNT(*) AS hits
        FROM leads l
       WHERE l.tenant_id=${tenantId | 0} AND l.lead_tag='fresh_fiber_confirmed'
         AND l.created_at >= ${isoDaysAgo(FRESH_WINDOW_DAYS)}
       GROUP BY lower(l.city), lower(l.state);
    CREATE INDEX idx_yf_city_hits ON yf_city_hits(city, state);
  `);
  // FOOTPRINT AS DATA, NOT A UDF: footprint_city() is an in-memory Set lookup,
  // but crossing the JS boundary ~1M times per cycle is real time. Evaluate it
  // ONCE per distinct (state, city) pair (a few hundred) into an indexed temp
  // table and JOIN — identical verdicts (same isFootprintCity, same
  // normalization), zero per-row JS. Fail-open stays: gate inactive → no join.
  const gateActive = footprintGateActive();
  if (gateActive) {
    rawDb.exec(`DROP TABLE IF EXISTS temp.yf_footprint;
      CREATE TEMP TABLE yf_footprint (state TEXT NOT NULL, city TEXT NOT NULL, PRIMARY KEY (state, city)) WITHOUT ROWID;`);
    const pairs = rawDb.prepare(
      `SELECT DISTINCT lower(state) AS state, lower(city) AS city FROM scan_targets WHERE tenant_id=?`,
    ).all(tenantId) as Array<{ state: string; city: string }>;
    const ins = rawDb.prepare(`INSERT OR IGNORE INTO temp.yf_footprint (state, city) VALUES (?, ?)`);
    const tx = rawDb.transaction((list: typeof pairs) => {
      for (const p of list) if (isFootprintCity(p.state, p.city)) ins.run(p.state, p.city);
    });
    tx(pairs);
  }
  const footprintClause = gateActive
    ? `AND EXISTS (SELECT 1 FROM temp.yf_footprint fp WHERE fp.state=lower(s.state) AND fp.city=lower(s.city))`
    : "";
  // DATETIME CUTOFFS AS STRINGS: datetime('now', …) is non-deterministic, so
  // SQLite re-evaluates it PER ROW — several string parses × ~1M rows. All
  // cutoffs are hoisted to UTC 'YYYY-MM-DD HH:MM:SS' literals (exactly what
  // datetime() emits and what every timestamp column stores); the adaptive
  // negative cadence has only 4 possible shift values per branch, so it
  // becomes a static CASE over neg_streak with precomputed cutoff literals.
  const expand = marketsTableReady();
  const tsMinusDays = (days: number) =>
    new Date(now - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const tsMinusHours = (hours: number) =>
    new Date(now - hours * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  const negCut = [0, 1, 2, 3].map((n) => tsMinusDays(Math.min(NEG_MAX_DAYS, NEG_BASE_DAYS * (1 << n))));
  const negCutExp = [0, 1, 2, 3].map((n) =>
    tsMinusDays(Math.min(EXPANSION_NEG_MAX_DAYS, Math.min(NEG_MAX_DAYS, NEG_BASE_DAYS * (1 << n)))));
  const caseOf = (cuts: string[]) =>
    `CASE MIN(MAX(s.neg_streak,1)-1, ${NEG_SHIFT_CAP}) WHEN 0 THEN '${cuts[0]}' WHEN 1 THEN '${cuts[1]}' WHEN 2 THEN '${cuts[2]}' ELSE '${cuts[3]}' END`;
  const newDiscoveryCut = tsMinusDays(7);
  const flipCooldownCut = tsMinusHours(FLIP_MIN_COOLDOWN_HOURS);
  const anfQuietCut = tsMinusDays(ANF_QUIET_DAYS);
  const notParkedAnf = `NOT (s.last_scanned_at IS NULL AND s.inconclusive_attempts >= ${ANF_GIVEUP} AND s.last_inconclusive_at IS NOT NULL AND s.last_inconclusive_at > '${anfQuietCut}')`;
  const negDueClause = expand
    ? `(COALESCE(s.last_fiber_status,'') IN ('no_service','copper')
        AND s.last_scanned_at < CASE WHEN ex.city IS NOT NULL THEN ${caseOf(negCutExp)} ELSE ${caseOf(negCut)} END)`
    : `(COALESCE(s.last_fiber_status,'') IN ('no_service','copper')
        AND s.last_scanned_at < ${caseOf(negCut)})`;
  const watchFreshCut = now - 12 * 3_600_000;
  const watchMatureCut = now - 2 * 3_600_000;
  const watchMatureAge = now - 48 * 3_600_000;
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
  const rows = rawDb.prepare(
    `WITH cell_scans AS (
       SELECT s.cell_lat AS clat, s.cell_lng AS clng, COUNT(*) AS scanned
         FROM scan_targets s
        WHERE s.tenant_id=? AND s.last_scanned_at IS NOT NULL
          AND s.cell_lat IS NOT NULL AND s.cell_lng IS NOT NULL
        GROUP BY s.cell_lat, s.cell_lng
     ),
     prior AS (
       SELECT CAST((SELECT COUNT(*) FROM leads l2
                     WHERE l2.tenant_id=? AND l2.lead_tag='fresh_fiber_confirmed'
                       AND l2.created_at >= ${isoDaysAgo(FRESH_WINDOW_DAYS)}) AS REAL)
              / (1 + (SELECT COUNT(*) FROM scan_targets s2
                       WHERE s2.tenant_id=? AND s2.last_scanned_at IS NOT NULL)) AS p0
     ),
     due_watch AS (
       SELECT w.scan_target_id AS id FROM coming_soon_watchlist w
        WHERE w.tenant_id=? AND w.status='active'
          AND (w.last_checked_at IS NULL
               OR (w.first_seen_at >  ? AND w.last_checked_at < ?)
               OR (w.first_seen_at <= ? AND w.last_checked_at < ?))
     )${expandCte}
     SELECT s.id,
            (dw.id IS NOT NULL) AS isWatch,
            (COALESCE(s.last_fiber_status,'') IN ('no_service','copper')
             AND (rc.clat IS NOT NULL OR rs.street IS NOT NULL)) AS isFlip,
            ( ${w.cell}   * COALESCE((CAST(fc.hits AS REAL) + ${CELL_PRIOR}*pr.p0)
                                     / (COALESCE(cs.scanned,0) + ${CELL_PRIOR}), 0)
            + ${w.street} * (fs.street IS NOT NULL)
            + ${w.city}   * COALESCE(ln(1+ch.hits), 0)
            + ${w.watch}  * (dw.id IS NOT NULL)
            + ${w.new}    * (s.created_at >= '${newDiscoveryCut}')
            + ${w.prox}   * ((rc.clat IS NOT NULL) OR (rs.street IS NOT NULL))
            + ${w.momentum} * COALESCE(ln(1+cm.momentum), 0)
            ${expandTerm}
            ) AS score
       FROM scan_targets s NOT INDEXED
       CROSS JOIN prior pr
       LEFT JOIN temp.yf_fresh_cells fc INDEXED BY idx_yf_fresh_cells ON fc.clat=s.cell_lat AND fc.clng=s.cell_lng
       LEFT JOIN temp.yf_recent_cells rc INDEXED BY idx_yf_recent_cells ON rc.clat=s.cell_lat AND rc.clng=s.cell_lng
       LEFT JOIN temp.yf_cell_momentum cm INDEXED BY idx_yf_cell_momentum ON cm.clat=s.cell_lat AND cm.clng=s.cell_lng
       LEFT JOIN cell_scans cs ON cs.clat=fc.clat AND cs.clng=fc.clng
       LEFT JOIN temp.yf_fresh_streets fs
         ON fs.street=s.street_key
        AND fs.city=lower(s.city) AND fs.state=lower(s.state) AND COALESCE(s.street_key,'') <> ''
       LEFT JOIN temp.yf_recent_streets rs
         ON rs.street=s.street_key
        AND rs.city=lower(s.city) AND rs.state=lower(s.state) AND COALESCE(s.street_key,'') <> ''
       LEFT JOIN temp.yf_city_hits ch ON ch.city=lower(s.city) AND ch.state=lower(s.state)
       LEFT JOIN due_watch dw ON dw.id = s.id
       ${expandJoin}
      WHERE s.tenant_id=?
        AND lower(s.state) IN (${STATE_IN})
        AND ${KINETIC_ONLY}
        ${footprintClause}
        AND ${notParkedAnf}
        AND (
          s.last_scanned_at IS NULL
          OR ${negDueClause}
          OR dw.id IS NOT NULL
          OR (COALESCE(s.last_fiber_status,'') IN ('no_service','copper')
              AND (s.last_scanned_at IS NULL
                   OR s.last_scanned_at < '${flipCooldownCut}')
              AND (rc.clat IS NOT NULL OR rs.street IS NOT NULL))
        )
      ORDER BY score DESC, s.id ASC
      LIMIT ?`,
  ).all(
    // WITH params: cell_scans(1) + prior(2) + due_watch(1 tenant + 4 cuts) —
    // the six lead-side signal sets are indexed TEMP tables now, zero params.
    tenantId, tenantId, tenantId, tenantId,
    watchMatureAge, watchFreshCut, watchMatureAge, watchMatureCut,
    tenantId, ...stateArgs(), limit,
  ) as ScoredRow[];
  structuredLog("yield_engine.score_ms", { ms: Date.now() - started, rows: rows.length, rollups: 1 });
  return rows;
}

/**
 * One yield cycle: score → exploit top 85% → explore 15% random never-scanned
 * → dispatch. Same guards as the classic harvester (circuit, day/night,
 * bandwidth governor, scarcity cut: explore dies first, then low scores).
 */
export function runYieldCycle(tenantId: number, budget = Number(process.env.FRESH_HARVEST_BUDGET) || 4000): { exploit: number; explore: number; discovery?: number; runId?: string } {
  if (isProxyCircuitOpen()) {
    structuredLog("yield_engine.cycle", { exploit: 0, explore: 0, skipped: "proxy circuit open" });
    return { exploit: 0, explore: 0 };
  }
  budget = Math.round(budget * budgetShapeFactor()); // Eastern-time idle-capacity shaping
  const bwScale = bandwidthBudgetScale();
  budget = Math.round(budget * bwScale);
  // THROUGHPUT-MATCHED DISPATCH (2026-07-24, measured): a cycle was enqueueing
  // 251,033 targets/hour against 2,863 completed checks — 88x oversubscription.
  // Every excess row is an INSERT plus a claim/skip UPDATE on the single writer
  // (9.3M 'skipped' rows accumulated), which is the churn that grows the WAL,
  // competes with the portal, and starves the real backlog. Dispatch is now
  // sized to PROVEN recent throughput: at most OVERSUBSCRIBE x the checks the
  // provider actually completed in the last hour. Nothing is lost — unselected
  // targets stay in the pool and are picked up by the next cycle, which is the
  // durable queue working as designed. YIELD_THROUGHPUT_MATCH=off restores the
  // fixed budget.
  if (process.env.YIELD_THROUGHPUT_MATCH !== "off") {
    try {
      const oversubscribe = Math.max(1, Number(process.env.YIELD_OVERSUBSCRIBE) || 2);
      const cyclesPerHour = Math.max(1, 60 / Math.max(1, Number(process.env.FRESH_HARVEST_INTERVAL_MIN) || 15));
      const checkedLastHour = Number((rawDb.prepare(
        `SELECT COUNT(*) n FROM availability_snapshots WHERE checked_at_epoch > ?`,
      ).get(Date.now() - 3_600_000) as any)?.n ?? 0);
      const checkedLast24h = Number((rawDb.prepare(
        `SELECT COUNT(*) n FROM availability_snapshots WHERE checked_at_epoch > ?`,
      ).get(Date.now() - 86_400_000) as any)?.n ?? 0);
      // BEST recent evidence, never the worst — see provenHourlyCapacity. Using
      // the raw last hour here created a downward spiral that took production
      // from 3,376 checks/hr to 43/hr with no self-recovery.
      const perHour = provenHourlyCapacity(checkedLastHour, checkedLast24h);
      const capacity = Math.max(500, Math.round((perHour * oversubscribe) / cyclesPerHour));
      if (capacity < budget) {
        structuredLog("yield_engine.throughput_capped", {
          requested: budget, capped: capacity, checkedLastHour, checkedLast24h, perHour, oversubscribe, cyclesPerHour,
        });
        budget = capacity;
      }
    } catch { /* measurement is best-effort — never block a cycle */ }
  }
  if (budget <= 0) {
    structuredLog("yield_engine.cycle", { exploit: 0, explore: 0, skipped: "bandwidth governor", bwScale });
    return { exploit: 0, explore: 0 };
  }

  // GUARANTEED DISCOVERY LANE — reserved BEFORE exploit/explore and never
  // zeroed by the scarcity cut. Oldest never-scanned first, one queue per
  // city (ROW_NUMBER round-robin) so a 40k-address metro cannot starve a
  // 60-house street. Emits the fairness metrics + SLA alert every cycle.
  const discoveryBudget = Math.max(1, Math.floor(budget * DISCOVERY_FRACTION));
  let discovery: number[] = [];
  try {
    registerFootprintSqlFunctions();
    warmFootprintGate();
    // TWO-TIER FAIRNESS (Concord catch-up): tier 1 is a guaranteed per-city
    // floor (round-robin, oldest first — a 60-house street always gets its
    // slots); tier 2 spends the REMAINING lane budget proportionally to each
    // city's never-scanned BACKLOG, so a 59k-backlog giant (Concord) drains at
    // scale instead of one-slot-per-lap. Both tiers stay oldest-first.
    const cityFloor = Math.max(1, Number(process.env.YIELD_DISCOVERY_CITY_FLOOR) || 25);
    discovery = (rawDb.prepare(
      `WITH ranked AS (
         SELECT s.id, s.created_at,
                ROW_NUMBER() OVER (PARTITION BY lower(s.city), lower(s.state)
                                   ORDER BY s.created_at ASC, s.id ASC) AS cityRank,
                COUNT(*) OVER (PARTITION BY lower(s.city), lower(s.state)) AS cityBacklog
           FROM scan_targets s
          WHERE s.tenant_id=? AND s.last_scanned_at IS NULL
            AND lower(s.state) IN (${STATE_IN})
            AND ${KINETIC_ONLY}
            AND footprint_city(s.state, s.city)=1
            AND ${NOT_PARKED_ANF}
            -- Active watchlist members must reach the scored path so they ship
            -- under the dedup-exempt coming-soon run, never as bulk discovery
            -- (the bulk run's 18h dedup window would swallow their tight
            -- 2h/12h recheck cadence).
            AND s.id NOT IN (SELECT w.scan_target_id FROM coming_soon_watchlist w WHERE w.status='active')
       )
       SELECT id FROM ranked
        ORDER BY MIN(cityRank, ${cityFloor}) ASC,
                 CAST(cityRank AS REAL) / MAX(cityBacklog, 1) ASC,
                 created_at ASC, id ASC
        LIMIT ?`,
    ).all(tenantId, ...stateArgs(), discoveryBudget) as any[]).map((r) => r.id);
    const oldest = rawDb.prepare(
      `SELECT MIN(created_at) o, COUNT(*) n FROM scan_targets s
        WHERE s.tenant_id=? AND s.last_scanned_at IS NULL AND lower(s.state) IN (${STATE_IN})
          AND ${KINETIC_ONLY} AND footprint_city(s.state, s.city)=1 AND ${NOT_PARKED_ANF}`,
    ).get(tenantId, ...stateArgs()) as any;
    const oldestDays = oldest?.o ? Math.floor((Date.now() - Date.parse(oldest.o + "Z")) / 86_400_000) : 0;
    const neverScanned = Number(oldest?.n ?? 0);
    const admittedPct = neverScanned > 0 ? +(100 * discovery.length / neverScanned).toFixed(2) : 100;
    structuredLog("yield_engine.discovery_lane", {
      admitted: discovery.length, neverScanned, oldestDays, admittedPct, slaDays: FIRST_SCAN_SLA_DAYS,
    }, oldestDays > FIRST_SCAN_SLA_DAYS ? "warn" : "info");
    if (oldestDays > FIRST_SCAN_SLA_DAYS) {
      structuredLog("yield_engine.first_scan_sla_violation", { oldestDays, neverScanned }, "warn");
    }
  } catch (e: any) {
    structuredLog("yield_engine.discovery_lane_error", { error: String(e?.message ?? e).slice(0, 140) }, "error");
  }
  const seen = new Set(discovery);
  const remaining = Math.max(0, budget - discovery.length);
  // Scarcity cut order under a shrinking bandwidth pool: explore dies first
  // (the guaranteed lane above is already funded).
  const exploreFrac = bwScale < 0.5 ? 0 : EXPLORE_FRACTION;
  const exploitBudget = Math.floor(remaining * (1 - exploreFrac));
  const scored = scoreDueTargets(tenantId, exploitBudget).filter((r) => !seen.has(r.id));
  const exploit = scored.map((r) => r.id);
  for (const id of exploit) seen.add(id);

  // Explore: random never-scanned in focus states — discover NEW build zones.
  // Footprint-gated: exploration stays inside the Kinetic footprint so the 15%
  // discovery budget can never burn on towns Kinetic will not serve.
  let explore: number[] = [];
  const exploreBudget = remaining - exploit.length;
  if (exploreBudget > 0) {
    registerFootprintSqlFunctions();
    warmFootprintGate();
    // Explore = NEIGHBORHOOD SATURATION (operator directive: full fresh
    // neighborhoods, not scattered): sweep the densest never-scanned ~1.1km
    // cells first so reps get whole untouched streets to knock. With the
    // rollup columns ready, both passes ride idx_scan_targets_cell instead of
    // full-table ROUND() groups (the generated cells ARE ROUND(lat,2)).
    const cellExpr = yieldRollupsReady()
      ? { cell: "cell_lat", cellNotNull: "cell_lat IS NOT NULL AND cell_lng IS NOT NULL", join: "s.cell_lat=cc.clat AND s.cell_lng=cc.clng", cellLng: "cell_lng" }
      : { cell: "ROUND(lat,2)", cellNotNull: "lat IS NOT NULL AND lng IS NOT NULL", join: "ROUND(s.lat,2)=cc.clat AND ROUND(s.lng,2)=cc.clng", cellLng: "ROUND(lng,2)" };
    explore = (rawDb.prepare(
      `WITH cold_cells AS (
         SELECT ${cellExpr.cell} AS clat, ${cellExpr.cellLng} AS clng, COUNT(*) AS unscanned
           FROM scan_targets
          WHERE tenant_id=? AND last_scanned_at IS NULL AND ${cellExpr.cellNotNull}
          GROUP BY clat, clng
       )
       SELECT s.id FROM scan_targets s NOT INDEXED
       JOIN cold_cells cc ON ${cellExpr.join}
        WHERE s.tenant_id=? AND s.last_scanned_at IS NULL
          AND lower(s.state) IN (${STATE_IN})
          AND ${KINETIC_ONLY}
          AND footprint_city(s.state, s.city)=1
          AND ${NOT_PARKED_ANF}
        ORDER BY cc.unscanned DESC, s.id ASC LIMIT ?`,
    ).all(tenantId, tenantId, ...stateArgs(), exploreBudget + seen.size) as any[])
      .map((r) => r.id).filter((id) => !seen.has(id)).slice(0, exploreBudget);
  }

  const ids = [...discovery, ...exploit, ...explore];
  if (!ids.length) {
    structuredLog("yield_engine.cycle", { exploit: 0, explore: 0, skipped: "nothing due", bwScale });
    return { exploit: 0, explore: 0 };
  }
  // SPLIT DISPATCH — change-detection targets must not go out as bulk harvest.
  // A single 'fresh_harvest' run put every target behind the 18h dedup window,
  // silently swallowing the 2h/12h coming-soon watch cadence and the 12h
  // flip-proximity cooldown this engine just computed. Watch members ship under
  // a 'coming_soon…watch' kind (dedup-exempt + reserved coming_soon class) and
  // flip-proximity negatives under a '…recheck' kind (dedup-exempt, discovery
  // class), so their tight cadences are real. Everything else stays bulk.
  const watchIds = scored.filter((r) => r.isWatch).map((r) => r.id);
  const flipIds = scored.filter((r) => !r.isWatch && r.isFlip).map((r) => r.id);
  const changeSet = new Set([...watchIds, ...flipIds]);
  const bulkIds = ids.filter((id) => !changeSet.has(id));
  let runId: string | undefined;
  if (watchIds.length) {
    runId = startTargetRun({
      tenantId, city: "yield-engine", state: "multi", targetIds: watchIds,
      runKind: "coming_soon_watch_yield",
      label: `YIELD WATCH x${watchIds.length}`,
    }).runId ?? runId;
  }
  if (flipIds.length) {
    runId = startTargetRun({
      tenantId, city: "yield-engine", state: "multi", targetIds: flipIds,
      runKind: "fresh_flip_recheck",
      label: `YIELD FLIP-PROX x${flipIds.length}`,
    }).runId ?? runId;
  }
  if (bulkIds.length) {
    runId = startTargetRun({
      tenantId, city: "yield-engine", state: "multi", targetIds: bulkIds,
      runKind: "fresh_harvest",
      label: `YIELD ENGINE x${exploit.length}/e${explore.length} bw${bwScale.toFixed(2)}`,
    }).runId ?? runId;
  }
  const w = getWeights();
  structuredLog("yield_engine.cycle", {
    exploit: exploit.length, explore: explore.length, discovery: discovery.length, runId, total: ids.length,
    watch: watchIds.length, flip: flipIds.length, bulk: bulkIds.length,
    bwScale, topScore: +(scored[0]?.score ?? 0).toFixed(3), medianScore: +(scored[Math.floor(scored.length / 2)]?.score ?? 0).toFixed(3),
    wCell: w.cell, wStreet: w.street, wCity: w.city, wProx: w.prox, wExpand: w.expand, wMomentum: w.momentum,
  });
  return { exploit: exploit.length, explore: explore.length, discovery: discovery.length, runId };
}
