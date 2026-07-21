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

const FRESH_WINDOW_DAYS = 21;
const EXPLORE_FRACTION = 0.15;
const LEARN_MIN_SAMPLES = 200;         // don't learn from noise

const FOCUS_STATES = (process.env.FRESH_HARVEST_STATES ?? "nc,sc")
  .split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
const STATE_IN = FOCUS_STATES.map(() => "?").join(",");
const stateArgs = () => [...FOCUS_STATES];

interface Weights { cell: number; street: number; city: number; watch: number; new: number }
const DEFAULT_WEIGHTS: Weights = { cell: 1.0, street: 0.9, city: 0.35, watch: 2.0, new: 0.25 };

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
    const street = rawDb.prepare(
      `WITH fs AS (
         SELECT DISTINCT lower(substr(l.address, instr(l.address,' ')+1)) AS street,
                lower(l.city) AS city
           FROM leads l
          WHERE l.tenant_id=? AND l.lead_tag='fresh_fiber_confirmed'
            AND l.created_at >= datetime('now','-${FRESH_WINDOW_DAYS} days')
            AND instr(l.address,' ') > 0
       )
       SELECT COUNT(*) AS n, SUM(s.fresh) AS f
         FROM availability_snapshots s
         JOIN scan_targets t ON t.id = s.scan_target_id
         JOIN fs ON lower(substr(t.address, instr(t.address,' ')+1)) = fs.street
                AND lower(t.city) = fs.city
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
 * Score every due address in the focus states. Due = never scanned, stale
 * negative (30d), stale copper (7d), or due coming-soon watchlist member.
 */
export function scoreDueTargets(tenantId: number, limit: number): ScoredRow[] {
  if (limit <= 0) return [];
  const w = getWeights();
  const now = Date.now();
  const watchFreshCut = now - 12 * 3_600_000;
  const watchMatureCut = now - 2 * 3_600_000;
  const watchMatureAge = now - 48 * 3_600_000;
  return rawDb.prepare(
    `WITH fresh_cells AS (
       SELECT ROUND(l.lat,2) AS clat, ROUND(l.lng,2) AS clng, COUNT(*) AS hits
         FROM leads l
        WHERE l.tenant_id=? AND l.lat IS NOT NULL AND l.lng IS NOT NULL
          AND l.lead_tag='fresh_fiber_confirmed'
          AND l.created_at >= datetime('now','-${FRESH_WINDOW_DAYS} days')
        GROUP BY clat, clng
     ),
     cell_scans AS (
       SELECT ROUND(s.lat,2) AS clat, ROUND(s.lng,2) AS clng, COUNT(*) AS scanned
         FROM scan_targets s
        WHERE s.tenant_id=? AND s.last_scanned_at IS NOT NULL
          AND s.lat IS NOT NULL AND s.lng IS NOT NULL
        GROUP BY clat, clng
     ),
     fresh_streets AS (
       SELECT DISTINCT lower(substr(l.address, instr(l.address,' ')+1)) AS street,
              lower(l.city) AS city, lower(l.state) AS state
         FROM leads l
        WHERE l.tenant_id=? AND l.lead_tag='fresh_fiber_confirmed'
          AND l.created_at >= datetime('now','-${FRESH_WINDOW_DAYS} days')
          AND instr(l.address,' ') > 0
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
     )
     SELECT s.id,
            ( ${w.cell}   * COALESCE(CAST(fc.hits AS REAL)/(1+COALESCE(cs.scanned,0)), 0)
            + ${w.street} * (fs.street IS NOT NULL)
            + ${w.city}   * COALESCE(ln(1+ch.hits), 0)
            + ${w.watch}  * (dw.id IS NOT NULL)
            + ${w.new}    * (s.created_at >= datetime('now','-7 days'))
            ) AS score
       FROM scan_targets s
       LEFT JOIN fresh_cells fc ON ROUND(s.lat,2)=fc.clat AND ROUND(s.lng,2)=fc.clng
       LEFT JOIN cell_scans cs ON cs.clat=fc.clat AND cs.clng=fc.clng
       LEFT JOIN fresh_streets fs
         ON lower(substr(s.address, instr(s.address,' ')+1))=fs.street
        AND lower(s.city)=fs.city AND lower(s.state)=fs.state AND instr(s.address,' ') > 0
       LEFT JOIN city_hits ch ON lower(s.city)=ch.city AND lower(s.state)=ch.state
       LEFT JOIN due_watch dw ON dw.id = s.id
      WHERE s.tenant_id=?
        AND lower(s.state) IN (${STATE_IN})
        AND (
          s.last_scanned_at IS NULL
          OR (COALESCE(s.last_fiber_status,'')='copper' AND s.last_scanned_at < datetime('now','-7 days'))
          OR (COALESCE(s.last_fiber_status,'')='no_service' AND s.last_scanned_at < datetime('now','-30 days'))
          OR dw.id IS NOT NULL
        )
      ORDER BY score DESC, s.id ASC
      LIMIT ?`,
  ).all(
    tenantId, tenantId, tenantId, tenantId, tenantId,
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
  let explore: number[] = [];
  const exploreBudget = budget - exploit.length;
  if (exploreBudget > 0) {
    explore = (rawDb.prepare(
      `SELECT s.id FROM scan_targets s
        WHERE s.tenant_id=? AND s.last_scanned_at IS NULL
          AND lower(s.state) IN (${STATE_IN})
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
  structuredLog("yield_engine.cycle", {
    exploit: exploit.length, explore: explore.length, runId, total: ids.length,
    bwScale, topScore: +(scored[0]?.score ?? 0).toFixed(3), medianScore: +(scored[Math.floor(scored.length / 2)]?.score ?? 0).toFixed(3),
    wCell: getWeights().cell, wStreet: getWeights().street, wCity: getWeights().city,
  });
  return { exploit: exploit.length, explore: explore.length, runId };
}
