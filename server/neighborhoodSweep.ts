// ── NEIGHBORHOOD SWEEP — finish whole neighborhoods, follow the fiber ─────────
// One producer for the Kinetic/Decodo scanner that replaces "one or two checks
// per street" with three moves, every cycle, in this order:
//
//   CONFIRM  re-check doors Kinetic already called NEW FIBER that never became
//            a lead (a legacy scan path left them without a conclusive snapshot,
//            so the projector could not publish them). Cheapest leads there are.
//   FLOOD    every cell (the ROUND(lat,2) grid, ~1 km) that has ever produced a
//            hit gets ALL of its unscanned doors enqueued as one run, street by
//            street, plus its stale negatives (the flip watch). A hit in a cell
//            is the single strongest predictor we have (22.5% vs 0.9%).
//   PROBE    cold cells are probed with one address per street (group testing:
//            streets are lit together). A hit promotes the cell to FLOOD on the
//            very next cycle, so a probe is never the end state.
//
// Sinks (a probed cell with nothing live, a city with hundreds of scans and no
// fiber) are parked for 45 days unless official build evidence says otherwise.
// Everything is decided by the pure functions in shared/neighborhoodSweep.ts.
//
// It runs ONLY on the control worker (index.ts producer block), enqueues through
// the durable engine with deterministic run ids (restart-safe, idempotent), and
// sizes each cycle to the measured drain so the queue stays short and a probe
// hit turns into a flood within one interval. It creates no leads itself: the
// engine's applyCheck -> projectConfirmedFreshLeads path does, unchanged.
import { rawDb } from "./db";
import { storage } from "./storage";
import { createScanRun, enqueueRunTargets, getRun, setRunStatus, setScanRunBudget } from "./scanIntelStore";
import { dispatchRun, isRunActive } from "./scanEngine";
import { isProxyCircuitOpen } from "./bandwidthGovernor";
import { readPressure } from "./resourcePressure";
import { isFootprintCity, warmFootprintGate } from "./footprintGate";
import { addressPointsInBbox, countAddressPoints } from "./addressPointStore";
import { structuredLog } from "./structuredLog";
import { backfillFromStoredEvidence, comingSummary, dueComingTargets, expireStaleWatches, markComingChecked, reconcileNowActiveWatches } from "./comingLedger";
import { anfParkedSql } from "@shared/scanPolicy";
import { normalizeKineticAddressKey, streetKeyOf } from "@shared/addressKey";
import {
  DEFAULT_SWEEP_POLICY, cellKey, cycleBudget, decideCell, houseNumberOf, neighborKeys, orderFlood, selectProbe,
  type CellDecision, type CellStats, type SweepPolicy,
} from "@shared/neighborhoodSweep";

const num = (v: string | undefined, dflt: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};

export const SWEEP_CFG = {
  enabled: () => process.env.NEIGHBORHOOD_SWEEP === "on",
  state: () => (process.env.NEIGHBORHOOD_SWEEP_STATE ?? "NC").trim().toUpperCase(),
  intervalMin: () => num(process.env.NEIGHBORHOOD_SWEEP_INTERVAL_MIN, 10, 2, 240),
  /** Budget floor/cap per cycle and how far ahead of the measured drain to run. */
  floor: () => num(process.env.NEIGHBORHOOD_SWEEP_FLOOR, 600, 10, 50_000),
  cap: () => num(process.env.NEIGHBORHOOD_SWEEP_MAX_PER_CYCLE, 6000, 10, 100_000),
  oversubscribe: () => num(process.env.NEIGHBORHOOD_SWEEP_OVERSUBSCRIBE, 1.5, 1, 5),
  /** Share of each cycle reserved for probing cold cells (the rest floods). */
  probeFraction: () => num(process.env.NEIGHBORHOOD_SWEEP_PROBE_FRACTION, 0.25, 0, 0.9),
  /** Confirm tier: at most this share of a cycle and this many doors, re-confirming one door at most every N days. */
  confirmFraction: () => num(process.env.NEIGHBORHOOD_SWEEP_CONFIRM_FRACTION, 0.4, 0, 1),
  confirmPerCycle: () => num(process.env.NEIGHBORHOOD_SWEEP_CONFIRM_PER_CYCLE, 600, 0, 20_000),
  confirmRecheckDays: () => num(process.env.NEIGHBORHOOD_SWEEP_CONFIRM_RECHECK_DAYS, 7, 1, 365),
  /** Negative verdicts older than this are due again inside a hot cell. */
  negativeRecheckDays: () => num(process.env.NEIGHBORHOOD_SWEEP_NEG_RECHECK_DAYS, 21, 1, 365),
  /** Cities to work first, in order. The operator's opening move. */
  seedCities: () => (process.env.NEIGHBORHOOD_SWEEP_SEED_CITIES ?? "broadway,wingate,rockwell")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  /** Doors per cycle for the street-completion tier (the highest-yield work). */
  streetPerCycle: () => num(process.env.NEIGHBORHOOD_SWEEP_STREET_PER_CYCLE, 1500, 0, 50_000),
  /** Promises collected per cycle from the coming ledger. */
  comingPerCycle: () => num(process.env.NEIGHBORHOOD_SWEEP_COMING_PER_CYCLE, 300, 0, 20_000),
  /** Stored bodies examined by the one-shot promise backfill. */
  backfillLimit: () => num(process.env.NEIGHBORHOOD_SWEEP_BACKFILL_LIMIT, 50_000, 0, 500_000),
  /** ONCE-ONLY: re-check conclusive negatives inside hot cells. Default OFF -
   *  55,503 such checks produced zero Kinetic flips (see @shared/scanPolicy). */
  rescanNegatives: () => process.env.NEIGHBORHOOD_SWEEP_RESCAN_NEGATIVES === "on",
  /** Confirm attempts per door per 90 days; past it the door is left to the projector backfill. */
  confirmMaxAttempts90d: () => num(process.env.NEIGHBORHOOD_SWEEP_CONFIRM_MAX_ATTEMPTS, 3, 1, 50),
  /** Per-run cap for a cell flood (a 0.01 degree cell rarely exceeds 2k doors). */
  maxPerCell: () => num(process.env.NEIGHBORHOOD_SWEEP_MAX_PER_CELL, 2500, 50, 20_000),
  /** Flood runs started per cycle (each is a worker loop; keep near MAX_ACTIVE_RUN_WORKERS). */
  maxFloodRuns: () => num(process.env.NEIGHBORHOOD_SWEEP_MAX_FLOOD_RUNS, 12, 1, 200),
  /** Stale bulk runs (other producers, now off) are cancelled so the sweep owns the queue. */
  // Exact kind names (the query uses IN, not LIKE), so every dead producer must
  // be listed explicitly. Measured on the production copy, these runs hold
  // never-scanned NC doors hostage: daily-diff 249,045, hot_market 20,222,
  // address_discovery 20,060, discovery 3,065 - and 207 of the coming ledger's
  // own promises are held by 27 dead coming_soon_watch* runs, which would have
  // blocked tier 0 outright. `manual` and `lasso` are never listed: a rep's work
  // is not ours to cancel. fresh_sweep% is excluded in the query itself.
  supersedeKinds: () => (process.env.NEIGHBORHOOD_SWEEP_SUPERSEDE_KINDS
    ?? "daily-diff,hot_market,city-sweep,copper_upgrade,state-monitor,market,fresh_harvest,keepwarm,"
     + "discovery,address_discovery,coming_soon_watch,coming_soon_watch_yield,frontier_hot,nightly")
    .split(",").map((s) => s.trim()).filter(Boolean),
  supersedeStaleHours: () => num(process.env.NEIGHBORHOOD_SWEEP_SUPERSEDE_HOURS, 24, 1, 24 * 365),
  /** E911 address points (when imported) fill a hot cell's inventory before it floods. */
  e911: () => process.env.NEIGHBORHOOD_SWEEP_E911 !== "off",
  e911CellsPerCycle: () => num(process.env.NEIGHBORHOOD_SWEEP_E911_CELLS, 4, 0, 50),
  /** A cell is bridged from E911 at most once per this many days. */
  e911RebridgeDays: () => num(process.env.NEIGHBORHOOD_SWEEP_E911_REBRIDGE_DAYS, 30, 1, 365),
  policy: (): SweepPolicy => ({
    ...DEFAULT_SWEEP_POLICY,
    probePerCell: num(process.env.NEIGHBORHOOD_SWEEP_PROBE_PER_CELL, DEFAULT_SWEEP_POLICY.probePerCell, 1, 200),
    sinkCellMinScans: num(process.env.NEIGHBORHOOD_SWEEP_SINK_CELL_SCANS, DEFAULT_SWEEP_POLICY.sinkCellMinScans, 3, 1000),
    parkDays: num(process.env.NEIGHBORHOOD_SWEEP_PARK_DAYS, DEFAULT_SWEEP_POLICY.parkDays, 1, 365),
  }),
};

/** Run kinds contain "fresh" on purpose: providerPriorityForRun maps them to the
 *  DISCOVERY admission class (revenue band: fast boot resume, FIFO jump) while
 *  keeping the 18 h bulk dedup at claim time. */
export const SWEEP_RUN_KIND = {
  // "recheck" makes dedupSkipSecondsForRun return 0 so the once-only guard does
  // not apply: this tier re-buys ANSWERED greens on purpose. "fresh" still wins
  // providerPriorityForRun, so it keeps the DISCOVERY admission class.
  confirm: "fresh_sweep_confirm_recheck",
  flood: "fresh_sweep_flood",
  probe: "fresh_sweep_probe",
  street: "fresh_sweep_street",
  // "coming_soon" wins providerPriorityForRun over "fresh" (NEW_BUILD class,
  // reserved capacity) and "watch" makes it dedup-exempt, so a dated promise is
  // the one thing allowed to re-buy an answered door.
  coming: "fresh_sweep_coming_soon_watch",
} as const;

// street_key is maintained by the yield rollups and is populated on every row in
// production, but a fresh install (or a replay DB) has it NULL until that job
// runs. Registering the same pure key function as a SQL callable lets the street
// tier work either way; SQLite short-circuits COALESCE, so the UDF only fires
// for the rows that actually lack the column.
let streetFnReady = false;
function registerStreetKeyFn(): void {
  if (streetFnReady) return;
  try {
    (rawDb as any).function("sweep_street_key", { deterministic: true },
      (addr: unknown) => streetKeyOf(typeof addr === "string" ? addr : ""));
  } catch { /* already registered */ }
  streetFnReady = true;
}
const STREET_KEY_SQL = (alias: string) => `COALESCE(NULLIF(${alias}.street_key,''), sweep_street_key(${alias}.address))`;

/** The evidence backfill is a one-shot per process, not per cycle. */
let evidenceBackfilled = false;

let schemaReady = false;
export function ensureSweepSchema(): void {
  if (schemaReady) return;
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS sweep_cells (
      tenant_id INTEGER NOT NULL,
      state TEXT NOT NULL,
      cell_lat REAL NOT NULL,
      cell_lng REAL NOT NULL,
      city TEXT,
      phase TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      expected_rate REAL NOT NULL DEFAULT 0,
      reasons TEXT NOT NULL DEFAULT '[]',
      scanned INTEGER NOT NULL DEFAULT 0,
      hits INTEGER NOT NULL DEFAULT 0,
      live INTEGER NOT NULL DEFAULT 0,
      unscanned INTEGER NOT NULL DEFAULT 0,
      stale_negatives INTEGER NOT NULL DEFAULT 0,
      unlinked_greens INTEGER NOT NULL DEFAULT 0,
      neighbor_hits INTEGER NOT NULL DEFAULT 0,
      last_hit_at TEXT,
      parked_until TEXT,
      parked_reason TEXT,
      last_run_id TEXT,
      last_enqueued_at TEXT,
      probes INTEGER NOT NULL DEFAULT 0,
      floods INTEGER NOT NULL DEFAULT 0,
      e911_bridged_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, state, cell_lat, cell_lng)
    );
    CREATE INDEX IF NOT EXISTS idx_sweep_cells_phase ON sweep_cells(tenant_id, state, phase, score);
    CREATE TABLE IF NOT EXISTS sweep_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      state TEXT NOT NULL,
      started_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      budget INTEGER NOT NULL DEFAULT 0,
      drain_per_min REAL NOT NULL DEFAULT 0,
      pending_before INTEGER NOT NULL DEFAULT 0,
      confirm INTEGER NOT NULL DEFAULT 0,
      flood INTEGER NOT NULL DEFAULT 0,
      probe INTEGER NOT NULL DEFAULT 0,
      flood_cells INTEGER NOT NULL DEFAULT 0,
      probe_cells INTEGER NOT NULL DEFAULT 0,
      e911_added INTEGER NOT NULL DEFAULT 0,
      coming INTEGER NOT NULL DEFAULT 0,
      street INTEGER NOT NULL DEFAULT 0,
      closed_now_active INTEGER NOT NULL DEFAULT 0,
      superseded_runs INTEGER NOT NULL DEFAULT 0,
      superseded_targets INTEGER NOT NULL DEFAULT 0,
      skipped TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sweep_cycles_tenant ON sweep_cycles(tenant_id, started_at);
  `);
  // Forward-only: an install created before the coming/street tiers existed.
  const cycleCols = new Set((rawDb.prepare(`PRAGMA table_info(sweep_cycles)`).all() as Array<{ name: string }>).map((c) => c.name));
  for (const [name, decl] of [["coming", "INTEGER NOT NULL DEFAULT 0"], ["street", "INTEGER NOT NULL DEFAULT 0"], ["closed_now_active", "INTEGER NOT NULL DEFAULT 0"]] as const) {
    if (!cycleCols.has(name)) { try { rawDb.exec(`ALTER TABLE sweep_cycles ADD COLUMN ${name} ${decl}`); } catch { /* concurrent boot */ } }
  }
  schemaReady = true;
}

// ── Frontier refresh: scan_targets -> per-cell stats -> decisions ─────────────
/** Fiber-available with the same fallback scanIntelStore.getTargetSnapshot uses:
 *  last_fiber_available is NULL on most legacy rows, whose status still says. */
const LIVE_SQL = `COALESCE(last_fiber_available, CASE WHEN last_fiber_status IN ('new_fiber','existing_fiber','tenured_fiber') THEN 1 ELSE 0 END)=1`;
/** A conclusive negative: answered, not live, not NEW FIBER. */
const NEGATIVE_SQL = `last_scanned_at IS NOT NULL AND NOT (${LIVE_SQL}) AND last_is_new_fiber=0`;
/** A green the projector can actually publish: NEW FIBER, no active billing, identity intact. */
const publishableGreenSql = (a = "") => {
  const p = a ? `${a}.` : "";
  return `${p}last_is_new_fiber=1 AND upper(COALESCE(${p}last_billing_status,''))='N' AND ${p}address_review_reason IS NULL`;
};

interface RawCellRow {
  cell_lat: number; cell_lng: number; city: string;
  n: number; scanned: number; hits: number; live: number; unscanned: number;
  stale_negatives: number; unlinked_greens: number; last_hit_at: string | null; coming_soon: number;
}

function cityKey(state: string, city: string): string { return `${state.toLowerCase()}|${(city || "").trim().toLowerCase()}`; }

export interface FrontierCell extends CellStats { decision: CellDecision; lastHitAt: string | null }

/** Aggregate scan_targets into cells and decide each one. Read-only on scan_targets. */
export function buildFrontier(tenantId: number, state: string, policy: SweepPolicy = SWEEP_CFG.policy(), nowMs = Date.now()): FrontierCell[] {
  ensureSweepSchema();
  const negDays = SWEEP_CFG.negativeRecheckDays();
  const nowIso = new Date(nowMs).toISOString();
  // Parks that have lapsed earn one re-probe (the decision layer reads parkExpired).
  const expiredParks = new Set<string>(
    (rawDb.prepare(`SELECT cell_lat, cell_lng FROM sweep_cells WHERE tenant_id=? AND state=? AND phase='parked' AND parked_until IS NOT NULL AND parked_until <= ?`)
      .all(tenantId, state, nowIso) as Array<{ cell_lat: number; cell_lng: number }>).map((r) => cellKey(r.cell_lat, r.cell_lng)),
  );
  const rows = rawDb.prepare(
    `SELECT cell_lat, cell_lng, lower(trim(city)) AS city,
            COUNT(*) AS n,
            SUM(last_scanned_at IS NOT NULL) AS scanned,
            SUM(last_is_new_fiber=1) AS hits,
            SUM(${LIVE_SQL}) AS live,
            SUM(last_scanned_at IS NULL AND NOT ${anfParkedSql("scan_targets", 14)}) AS unscanned,
            SUM(${NEGATIVE_SQL} AND last_scanned_at < datetime('now','-${negDays} days')) AS stale_negatives,
            SUM(${publishableGreenSql()} AND converted_to_lead_id IS NULL) AS unlinked_greens,
            MAX(CASE WHEN last_is_new_fiber=1 THEN last_scanned_at END) AS last_hit_at,
            SUM(lifecycle_state='COMING_SOON') AS coming_soon
       FROM scan_targets
      WHERE tenant_id=? AND state=? AND COALESCE(carrier,'kinetic')='kinetic'
        AND cell_lat IS NOT NULL AND cell_lng IS NOT NULL
      GROUP BY cell_lat, cell_lng, lower(trim(city))`,
  ).all(tenantId, state) as RawCellRow[];

  // Merge the per-(cell, city) groups into one row per cell; the city with the
  // most doors labels the cell (cells straddle town lines).
  const cells = new Map<string, RawCellRow & { cityN: number }>();
  for (const raw of rows) {
    // SUM() over a group whose values are all NULL is NULL; every count must be a number.
    const r: RawCellRow = {
      ...raw, n: Number(raw.n ?? 0), scanned: Number(raw.scanned ?? 0), hits: Number(raw.hits ?? 0), live: Number(raw.live ?? 0),
      unscanned: Number(raw.unscanned ?? 0), stale_negatives: Number(raw.stale_negatives ?? 0),
      unlinked_greens: Number(raw.unlinked_greens ?? 0), coming_soon: Number(raw.coming_soon ?? 0), city: raw.city ?? "",
    };
    const k = cellKey(r.cell_lat, r.cell_lng);
    const cur = cells.get(k);
    if (!cur) { cells.set(k, { ...r, cityN: r.n }); continue; }
    cur.n += r.n; cur.scanned += r.scanned; cur.hits += r.hits; cur.live += r.live; cur.unscanned += r.unscanned;
    cur.stale_negatives += r.stale_negatives; cur.unlinked_greens += r.unlinked_greens; cur.coming_soon += r.coming_soon;
    if (r.last_hit_at && (!cur.last_hit_at || r.last_hit_at > cur.last_hit_at)) cur.last_hit_at = r.last_hit_at;
    if (r.n > cur.cityN) { cur.city = r.city; cur.cityN = r.n; }
  }

  // City totals (the empirical-Bayes prior and the sink rule).
  const cityTotals = new Map<string, { scanned: number; hits: number; live: number }>();
  for (const r of rows) {
    const k = cityKey(state, r.city ?? "");
    const c = cityTotals.get(k) ?? { scanned: 0, hits: 0, live: 0 };
    c.scanned += Number(r.scanned ?? 0); c.hits += Number(r.hits ?? 0); c.live += Number(r.live ?? 0);
    cityTotals.set(k, c);
  }

  const expanding = expandingMarkets(state);
  const evidence = buildEvidenceByCell(tenantId);
  warmFootprintGate();

  const out: FrontierCell[] = [];
  for (const [k, r] of cells) {
    let neighborHits = 0, neighborScanned = 0;
    for (const nk of neighborKeys(r.cell_lat, r.cell_lng)) {
      const n = cells.get(nk);
      if (n) { neighborHits += n.hits; neighborScanned += n.scanned; }
    }
    const ct = cityTotals.get(cityKey(state, r.city)) ?? { scanned: 0, hits: 0, live: 0 };
    const lastHitDays = r.last_hit_at ? Math.max(0, (nowMs - parseSqlTime(r.last_hit_at)) / 86_400_000) : null;
    const stats: CellStats = {
      cellLat: r.cell_lat, cellLng: r.cell_lng, city: r.city, state,
      scanned: r.scanned, hits: r.hits, live: r.live, unscanned: r.unscanned,
      staleNegatives: r.hits > 0 ? r.stale_negatives : 0, // the flip watch only inside hot cells
      unlinkedGreens: r.unlinked_greens, lastHitDays,
      neighborHits, neighborScanned,
      expanding: expanding.has(cityKey(state, r.city)),
      buildEvidence: evidence.get(k) ?? 0,
      comingSoon: r.coming_soon,
      inFootprint: isFootprintCity(state, r.city),
      parkExpired: expiredParks.has(k),
      cityScanned: ct.scanned, cityHits: ct.hits, cityLive: ct.live,
    };
    out.push({ ...stats, decision: decideCell(stats, policy), lastHitAt: r.last_hit_at });
  }
  return out;
}

function parseSqlTime(s: string): number {
  const t = Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : 0;
}

function expandingMarkets(state: string): Set<string> {
  try {
    const rows = rawDb.prepare(
      `SELECT lower(city) AS city FROM state_fiber_markets
        WHERE upper(state)=? AND kinetic_status='verified_expanding' AND auto_scan_eligible=1`,
    ).all(state) as Array<{ city: string }>;
    return new Set(rows.map((r) => cityKey(state, r.city)));
  } catch { return new Set(); }
}

/** FCC-evidenced likely-2026 build addresses per cell (kinetic_build_state). */
function buildEvidenceByCell(tenantId: number): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const rows = rawDb.prepare(
      `SELECT ROUND(lat,2) AS cl, ROUND(lng,2) AS cg, COUNT(*) AS n FROM kinetic_build_state
        WHERE tenant_id=? AND classification='likely_2026' AND lat IS NOT NULL AND lng IS NOT NULL
        GROUP BY 1,2`,
    ).all(tenantId) as Array<{ cl: number; cg: number; n: number }>;
    for (const r of rows) out.set(cellKey(r.cl, r.cg), r.n);
  } catch { /* table absent on a bare DB */ }
  return out;
}

/** Persist the frontier so the API and the next cycle can read it. Parked
 *  cells keep their park window; a hit always un-parks. */
export function persistFrontier(tenantId: number, state: string, cells: FrontierCell[], policy: SweepPolicy, nowMs = Date.now()): void {
  ensureSweepSchema();
  const now = new Date(nowMs).toISOString();
  const parkedUntil = new Date(nowMs + policy.parkDays * 86_400_000).toISOString();
  const existing = new Map<string, { parked_until: string | null; parked_reason: string | null }>();
  for (const r of rawDb.prepare(`SELECT cell_lat, cell_lng, parked_until, parked_reason FROM sweep_cells WHERE tenant_id=? AND state=?`).all(tenantId, state) as any[]) {
    existing.set(cellKey(r.cell_lat, r.cell_lng), r);
  }
  const up = rawDb.prepare(`INSERT INTO sweep_cells
      (tenant_id, state, cell_lat, cell_lng, city, phase, score, expected_rate, reasons, scanned, hits, live, unscanned,
       stale_negatives, unlinked_greens, neighbor_hits, last_hit_at, parked_until, parked_reason, updated_at)
     VALUES (@tenantId,@state,@cellLat,@cellLng,@city,@phase,@score,@expectedRate,@reasons,@scanned,@hits,@live,@unscanned,
       @staleNegatives,@unlinkedGreens,@neighborHits,@lastHitAt,@parkedUntil,@parkedReason,@updatedAt)
     ON CONFLICT(tenant_id, state, cell_lat, cell_lng) DO UPDATE SET
       city=excluded.city, phase=excluded.phase, score=excluded.score, expected_rate=excluded.expected_rate,
       reasons=excluded.reasons, scanned=excluded.scanned, hits=excluded.hits, live=excluded.live,
       unscanned=excluded.unscanned, stale_negatives=excluded.stale_negatives, unlinked_greens=excluded.unlinked_greens,
       neighbor_hits=excluded.neighbor_hits, last_hit_at=excluded.last_hit_at,
       parked_until=excluded.parked_until, parked_reason=excluded.parked_reason, updated_at=excluded.updated_at`);
  const tx = rawDb.transaction((batch: FrontierCell[]) => {
    for (const c of batch) {
      const prev = existing.get(cellKey(c.cellLat, c.cellLng));
      let phase: string = c.decision.phase;
      let parked: string | null = null, reason: string | null = null;
      if (c.decision.phase === "parked") {
        // Keep an existing park window rather than extending it every cycle.
        parked = prev?.parked_until && prev.parked_until > now ? prev.parked_until : parkedUntil;
        reason = c.decision.parkedReason ?? "parked";
      } else if (prev?.parked_until && prev.parked_until > now && c.decision.phase === "probe") {
        // Still inside a park window and nothing new happened: stay parked.
        phase = "parked"; parked = prev.parked_until; reason = prev.parked_reason;
      }
      up.run({
        tenantId, state, cellLat: c.cellLat, cellLng: c.cellLng, city: c.city, phase,
        score: c.decision.score, expectedRate: c.decision.expectedRate, reasons: JSON.stringify(c.decision.reasons),
        scanned: c.scanned, hits: c.hits, live: c.live, unscanned: c.unscanned,
        staleNegatives: c.staleNegatives, unlinkedGreens: c.unlinkedGreens, neighborHits: c.neighborHits,
        lastHitAt: c.lastHitAt, parkedUntil: parked, parkedReason: reason, updatedAt: now,
      });
    }
  });
  // IMMEDIATE: take the write lock at BEGIN so busy_timeout covers the upsert
  // (a deferred read-then-write would throw SQLITE_BUSY_SNAPSHOT under the
  // scanner's continuous commits; see tests/unit/deferred-read-write-transactions).
  for (let i = 0; i < cells.length; i += 2000) tx.immediate(cells.slice(i, i + 2000));
}

// ── Supersede: stale bulk runs from producers that are now off ───────────────
/**
 * Cancel other producers' stale `running` runs and skip their queued tails, in
 * chunks, so (a) the reaper stops resuming them into the few worker slots and
 * (b) enqueueRunTargets' cross-run dedup stops dropping the sweep's targets
 * because a dead daily-diff run still "owns" them. Never touches a run with a
 * live worker in this process or a fresh heartbeat.
 */
export async function supersedeStaleBulkRuns(tenantId: number, opts: { kinds?: string[]; staleHours?: number; chunk?: number } = {}): Promise<{ runs: number; targets: number }> {
  const kinds = opts.kinds ?? SWEEP_CFG.supersedeKinds();
  const staleHours = opts.staleHours ?? SWEEP_CFG.supersedeStaleHours();
  const chunk = Math.max(100, opts.chunk ?? 2000);
  if (!kinds.length) return { runs: 0, targets: 0 };
  const runs = rawDb.prepare(
    `SELECT id, kind FROM scan_runs
      WHERE tenant_id=? AND status='running' AND kind IN (${kinds.map(() => "?").join(",")})
        AND kind NOT LIKE 'fresh_sweep%'
        AND (heartbeat_at IS NULL OR heartbeat_at < datetime('now', ?))
      ORDER BY heartbeat_at ASC LIMIT 500`,
  ).all(tenantId, ...kinds, `-${staleHours} hours`) as Array<{ id: string; kind: string }>;
  let targets = 0, cancelled = 0;
  const skip = rawDb.prepare(
    `UPDATE scan_run_targets SET state='skipped', result='superseded: neighborhood sweep owns the queue', next_attempt_at=NULL
      WHERE rowid IN (SELECT rowid FROM scan_run_targets WHERE run_id=? AND state IN ('queued','inflight') LIMIT ?)`);
  for (const r of runs) {
    if (isRunActive(r.id)) continue;
    setRunStatus(r.id, "cancelled", "superseded by neighborhood sweep");
    cancelled++;
    for (;;) {
      const n = skip.run(r.id, chunk).changes;
      targets += n;
      if (n < chunk) break;
      await new Promise((res) => setImmediate(res));
    }
  }
  if (cancelled) structuredLog("neighborhood_sweep.superseded", { runs: cancelled, targets, kinds: kinds.join(",") }, "warn");
  return { runs: cancelled, targets };
}

// ── Enqueue helpers ──────────────────────────────────────────────────────────
function dayKey(nowMs: number): string { return new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, ""); }

/** Idempotent run creation: deterministic id + getRun guard + cap-respecting dispatch. */
function startSweepRun(tenantId: number, runId: string, kind: string, label: string, city: string, state: string, ids: number[], dispatch: (runId: string, tenantId: number) => void): number {
  if (!ids.length) return 0;
  if (getRun(runId, tenantId)) return 0;
  createScanRun({ id: runId, tenantId, kind, label, city, state, budget: ids.length });
  const queued = enqueueRunTargets(runId, ids.map((id, seq) => ({ id, seq })));
  if (queued <= 0) {
    // Every id is already queued in another running run (cross-run dedup):
    // leave no empty run behind, the other run answers for those doors.
    rawDb.prepare(`DELETE FROM scan_runs WHERE id=? AND verified=0 AND failed=0`).run(runId);
    return 0;
  }
  setScanRunBudget(runId, queued);
  dispatch(runId, tenantId);
  return queued;
}

interface CellTargetRow { id: number; address: string; last_scanned_at: string | null; street_key: string | null }

function cellTargets(tenantId: number, state: string, cell: { cellLat: number; cellLng: number }, mode: "unscanned" | "due", limit: number): CellTargetRow[] {
  const negDays = SWEEP_CFG.negativeRecheckDays();
  // ONCE-ONLY: a flood buys UNSCANNED doors. Re-checking conclusive negatives is
  // opt-in (NEIGHBORHOOD_SWEEP_RESCAN_NEGATIVES=on) because the measured return
  // on it was zero - see the evidence in @shared/scanPolicy.
  const due = mode === "due" && SWEEP_CFG.rescanNegatives()
    ? `(last_scanned_at IS NULL OR (${NEGATIVE_SQL} AND last_scanned_at < datetime('now','-${negDays} days')))`
    : `last_scanned_at IS NULL`;
  // Never buy a door another run already holds. The confirm and street tiers
  // carry the same guard; without it here a door could land in this cycle's
  // street run AND its flood run, or in a flood still open from a prior cycle.
  return rawDb.prepare(
    `SELECT id, address, last_scanned_at, street_key FROM scan_targets s
      WHERE s.tenant_id=? AND s.state=? AND COALESCE(s.carrier,'kinetic')='kinetic'
        AND s.cell_lat=? AND s.cell_lng=? AND ${due.replace(/\b(last_scanned_at|last_fiber_available|last_is_new_fiber)\b/g, "s.$1")}
        AND NOT ${anfParkedSql("s", 14)}
        AND NOT EXISTS (SELECT 1 FROM scan_run_targets t JOIN scan_runs r ON r.id=t.run_id
                         WHERE t.target_id=s.id AND t.state IN ('queued','inflight') AND r.status='running')
      LIMIT ?`,
  ).all(tenantId, state, cell.cellLat, cell.cellLng, limit) as CellTargetRow[];
}

const withKeys = (rows: CellTargetRow[]) => rows.map((r) => ({
  id: r.id, streetKey: r.street_key ?? streetKeyOf(r.address), houseNumber: houseNumberOf(r.address),
}));

function cellHasRunningRun(tenantId: number, cellLat: number, cellLng: number): boolean {
  const row = rawDb.prepare(`SELECT last_run_id FROM sweep_cells WHERE tenant_id=? AND cell_lat=? AND cell_lng=?`).get(tenantId, cellLat, cellLng) as any;
  if (!row?.last_run_id) return false;
  const run = getRun(row.last_run_id, tenantId);
  return !!run && run.status === "running";
}

function noteCellRun(tenantId: number, state: string, cellLat: number, cellLng: number, runId: string, kind: "flood" | "probe", nowMs: number): void {
  rawDb.prepare(`UPDATE sweep_cells SET last_run_id=?, last_enqueued_at=?, ${kind === "flood" ? "floods=floods+1" : "probes=probes+1"}
    WHERE tenant_id=? AND state=? AND cell_lat=? AND cell_lng=?`)
    .run(runId, new Date(nowMs).toISOString(), tenantId, state, cellLat, cellLng);
}

// ── E911 bridge: fill a hot cell's inventory from county address points ──────
/**
 * OSM and the Mapbox grid miss new construction. When county E911 address
 * points are imported (server/addressPointImport.ts), every structure inside
 * a cell about to flood is upserted into scan_targets first, so the flood is
 * the whole neighborhood rather than the part the map knew about. No-op when
 * the table is empty. Bounded per cell by the viewport feed's own cap.
 */
export function bridgeE911ForCell(tenantId: number, state: string, cell: { cellLat: number; cellLng: number }, nowMs = Date.now()): number {
  try {
    const half = 0.005;
    const { points } = addressPointsInBbox(cell.cellLng - half, cell.cellLat - half, cell.cellLng + half, cell.cellLat + half, 4000);
    const rows = points
      .filter((p) => !!p.fullAddress && !!p.city && (p.state ?? state).toUpperCase() === state && Number.isFinite(p.lat) && Number.isFinite(p.lng))
      .map((p) => {
        const city = String(p.city);
        return {
          address: p.fullAddress, city, state, zip: p.zip ?? "", lat: p.lat, lng: p.lng,
          source: "e911-sweep", tenantId,
          canonicalKey: normalizeKineticAddressKey(p.fullAddress, city, state, p.zip ?? ""),
        };
      });
    let added = 0;
    for (let i = 0; i < rows.length; i += 500) added += storage.upsertScanTargets(rows.slice(i, i + 500));
    // Stamp the cell whether or not anything was new: the bridge is a read of
    // the county file plus an upsert, and it must not repeat every cycle.
    rawDb.prepare(`UPDATE sweep_cells SET e911_bridged_at=? WHERE tenant_id=? AND state=? AND cell_lat=? AND cell_lng=?`)
      .run(new Date(nowMs).toISOString(), tenantId, state, cell.cellLat, cell.cellLng);
    return added;
  } catch (e: any) {
    structuredLog("neighborhood_sweep.e911_failed", { error: String(e?.message ?? e).slice(0, 160) }, "warn");
    return 0;
  }
}

// ── The cycle ────────────────────────────────────────────────────────────────
export interface CycleResult {
  skipped?: string;
  budget: number; drainPerMin: number; pendingBefore: number;
  confirm: number; flood: number; probe: number; floodCells: number; probeCells: number;
  coming: number; street: number; closedNowActive: number; backfilled: number;
  e911Added: number; supersededRuns: number; supersededTargets: number;
  runIds: string[];
}

export interface CycleDeps {
  dispatch?: (runId: string, tenantId: number) => void;
  nowMs?: number;
  /** Tests: skip the supersede pass. */
  supersede?: boolean;
  policy?: SweepPolicy;
}

function measureDrainPerMinute(): number {
  // The unary + keeps the planner off any other predicate so the range index on
  // last_scanned_at drives. Without it SQLite picks a tenant-prefixed index and
  // walks every row: measured 2,966 ms versus 9 ms for the same answer, because
  // sqlite_stat1 carries stats for exactly one scan_targets index (and they are
  // 0 0 0 0). See the ANALYZE maintenance in server/yieldRollups.ts.
  const row = rawDb.prepare(`SELECT COUNT(*) AS n FROM scan_targets WHERE last_scanned_at > datetime('now','-60 minutes')`).get() as any;
  return Number(row?.n ?? 0) / 60;
}

function pendingSweepRows(tenantId: number): number {
  // Two steps on purpose. Joining scan_run_targets (803k rows) to scan_runs and
  // filtering on `kind LIKE` - a column with no index - drove the join from the
  // wrong side: 937 ms. Resolving the handful of sweep run ids first and letting
  // the run_id index do the counting is the same answer in 82 ms.
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM scan_run_targets
      WHERE state IN ('queued','inflight')
        AND run_id IN (SELECT id FROM scan_runs
                        WHERE tenant_id=? AND status='running' AND kind LIKE 'fresh_sweep%')`,
  ).get(tenantId) as any;
  return Number(row?.n ?? 0);
}

export async function runSweepCycle(tenantId: number, deps: CycleDeps = {}): Promise<CycleResult> {
  ensureSweepSchema();
  const nowMs = deps.nowMs ?? Date.now();
  const state = SWEEP_CFG.state();
  const policy = deps.policy ?? SWEEP_CFG.policy();
  const dispatch = deps.dispatch ?? dispatchRun;
  const t0 = Date.now();
  const result: CycleResult = {
    budget: 0, drainPerMin: 0, pendingBefore: 0, confirm: 0, flood: 0, probe: 0, floodCells: 0, probeCells: 0,
    coming: 0, street: 0, closedNowActive: 0, backfilled: 0,
    e911Added: 0, supersededRuns: 0, supersededTargets: 0, runIds: [],
  };
  const finish = (skipped?: string) => {
    result.skipped = skipped;
    rawDb.prepare(`INSERT INTO sweep_cycles (tenant_id, state, started_at, duration_ms, budget, drain_per_min, pending_before,
        confirm, flood, probe, flood_cells, probe_cells, e911_added, superseded_runs, superseded_targets, skipped,
        coming, street, closed_now_active)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(tenantId, state, new Date(nowMs).toISOString(), Date.now() - t0, result.budget, result.drainPerMin, result.pendingBefore,
        result.confirm, result.flood, result.probe, result.floodCells, result.probeCells, result.e911Added,
        result.supersededRuns, result.supersededTargets, skipped ?? null,
        result.coming, result.street, result.closedNowActive);
    structuredLog("neighborhood_sweep.cycle", {
      tenantId, state, skipped: skipped ?? null, budget: result.budget, drainPerMin: +result.drainPerMin.toFixed(2),
      pendingBefore: result.pendingBefore, coming: result.coming, street: result.street,
      closedNowActive: result.closedNowActive, backfilled: result.backfilled,
      confirm: result.confirm, flood: result.flood, probe: result.probe,
      floodCells: result.floodCells, probeCells: result.probeCells, e911Added: result.e911Added,
      supersededRuns: result.supersededRuns, supersededTargets: result.supersededTargets, ms: Date.now() - t0,
    }, skipped ? "warn" : "info");
    return result;
  };

  if (isProxyCircuitOpen()) return finish("proxy_circuit_open");
  if (readPressure().level === "emergency") return finish("resource_emergency");

  if (deps.supersede !== false) {
    const s = await supersedeStaleBulkRuns(tenantId);
    result.supersededRuns = s.runs; result.supersededTargets = s.targets;
  }

  // Budget from the measured drain, minus what this producer already has queued.
  result.drainPerMin = measureDrainPerMinute();
  result.pendingBefore = pendingSweepRows(tenantId);
  const b = cycleBudget({
    drainPerMinute: result.drainPerMin, intervalMinutes: SWEEP_CFG.intervalMin(), pending: result.pendingBefore,
    floor: SWEEP_CFG.floor(), cap: SWEEP_CFG.cap(), oversubscribe: SWEEP_CFG.oversubscribe(),
  });
  result.budget = b.budget;
  if (b.skip || b.budget <= 0) return finish(b.skip ?? "no_budget");
  let left = b.budget;

  // Frontier.
  const frontier = buildFrontier(tenantId, state, policy, nowMs);
  persistFrontier(tenantId, state, frontier, policy, nowMs);
  const day = dayKey(nowMs);

  // Seed cities lead every tier: the operator's opening move (Broadway,
  // Wingate, Rockwell), applied as an ORDERING boost rather than a tier of its
  // own, so starting there never starves the rest of the state.
  const seeds = SWEEP_CFG.seedCities();
  const seedRank = (city: string | null | undefined): number => {
    const i = seeds.indexOf(String(city ?? "").trim().toLowerCase());
    return i < 0 ? seeds.length : i;
  };
  const seedSql = seeds.length
    ? `CASE lower(trim(s.city)) ${seeds.map((c, i) => `WHEN '${c.replace(/'/g, "''")}' THEN ${i}`).join(" ")} ELSE ${seeds.length} END`
    : "0";

  // ── TIER 0: COMING DUE ──────────────────────────────────────────────────────
  // The one sanctioned re-purchase of an answered door: the provider told us it
  // would be serviceable by now. Closing mislabelled watches first keeps sold
  // doors (NEW FIBER + active account) out of this lane entirely.
  // One-shot per process: mine promises out of bodies we already paid for.
  // ~2 s over 22k stored responses, and it is how the ledger starts full rather
  // than empty (measured: 1,327 doors recovered, 525 with a stated month).
  if (!evidenceBackfilled) {
    evidenceBackfilled = true;
    try {
      const b = backfillFromStoredEvidence(tenantId, SWEEP_CFG.backfillLimit(), nowMs);
      result.backfilled = b.recorded;
    } catch (e: any) {
      structuredLog("neighborhood_sweep.backfill_failed", { error: String(e?.message ?? e).slice(0, 160) }, "warn");
    }
  }
  result.closedNowActive = reconcileNowActiveWatches(tenantId, nowMs);
  expireStaleWatches(tenantId, nowMs);
  const comingCap = Math.min(left, SWEEP_CFG.comingPerCycle());
  if (comingCap > 0) {
    const due = dueComingTargets(tenantId, state, comingCap, nowMs);
    if (due.length) {
      const prior = (rawDb.prepare(`SELECT COUNT(*) AS n FROM scan_runs WHERE tenant_id=? AND id LIKE ?`)
        .get(tenantId, `nsweep_${tenantId}_${state}_coming_${day}_%`) as any)?.n ?? 0;
      const runId = `nsweep_${tenantId}_${state}_coming_${day}_w${Number(prior) + 1}`;
      const dated = due.filter((d) => d.promisedDate).length;
      const queued = startSweepRun(tenantId, runId, SWEEP_RUN_KIND.coming,
        `Sweep coming ${state}: ${due.length} promised doors (${dated} dated)`,
        "sweep-coming", state, due.map((d) => d.targetId), dispatch);
      if (queued) {
        markComingChecked(tenantId, due.map((d) => d.targetId), nowMs);
        result.coming = queued; result.runIds.push(runId); left -= queued;
      }
    }
  }

  // CONFIRM: known NEW FIBER doors that never became leads.
  const confirmCap = Math.min(Math.round(left * SWEEP_CFG.confirmFraction()), SWEEP_CFG.confirmPerCycle());
  if (confirmCap > 0) {
    const ids = (rawDb.prepare(
      `SELECT s.id FROM scan_targets s
        WHERE s.tenant_id=? AND s.state=? AND COALESCE(s.carrier,'kinetic')='kinetic'
          AND ${publishableGreenSql("s")}
          AND s.converted_to_lead_id IS NULL
          AND (s.last_scanned_at IS NULL OR s.last_scanned_at < datetime('now','-${SWEEP_CFG.confirmRecheckDays()} days'))
          AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.tenant_id=s.tenant_id AND l.source_scan_target_id=s.id)
          AND NOT EXISTS (SELECT 1 FROM scan_run_targets t JOIN scan_runs r ON r.id=t.run_id
                           WHERE t.target_id=s.id AND t.state IN ('queued','inflight') AND r.status='running')
          -- bounded: a door that keeps coming back unpublishable leaves the rotation
          AND (SELECT COUNT(*) FROM scan_run_targets t2 JOIN scan_runs r2 ON r2.id=t2.run_id
                WHERE t2.target_id=s.id AND r2.kind='${SWEEP_RUN_KIND.confirm}' AND r2.started_at > datetime('now','-90 days')) < ?
        ORDER BY s.last_scanned_at ASC LIMIT ?`,
    ).all(tenantId, state, SWEEP_CFG.confirmMaxAttempts90d(), confirmCap) as Array<{ id: number }>).map((r) => r.id);
    if (ids.length) {
      const prior = (rawDb.prepare(`SELECT COUNT(*) AS n FROM scan_runs WHERE tenant_id=? AND id LIKE ?`)
        .get(tenantId, `nsweep_${tenantId}_${state}_confirm_${day}_%`) as any)?.n ?? 0;
      const runId = `nsweep_${tenantId}_${state}_confirm_${day}_c${Number(prior) + 1}`;
      const queued = startSweepRun(tenantId, runId, SWEEP_RUN_KIND.confirm, `Sweep confirm ${state}: ${ids.length} known NEW FIBER doors`, "sweep-confirm", state, ids, dispatch);
      if (queued) { result.confirm = queued; result.runIds.push(runId); left -= queued; }
    }
  }

  // ── TIER 2: STREET COMPLETION ───────────────────────────────────────────────
  // Builders light a street at a time: of 403 NC streets that produced a hit,
  // 264 came back 100% NEW FIBER and the p25 hit share is 72%. So an unscanned
  // door on a street that already produced a hit is the single highest-yield
  // check available, and it beats finishing the rest of a cell. ~6,000 such
  // doors exist statewide (Lilesville 939, Rockwell 935, Harrisburg 657...).
  const streetCap = Math.min(left, SWEEP_CFG.streetPerCycle());
  if (streetCap > 0) {
    registerStreetKeyFn();
    const rows = rawDb.prepare(
      `WITH hit_streets AS (
         -- alias is skey, never street_key: SQLite resolves a bare street_key
         -- in HAVING to the TABLE COLUMN (NULL before the rollup backfills it),
         -- which silently emptied this whole tier.
         SELECT ${STREET_KEY_SQL("scan_targets")} AS skey, lower(trim(city)) AS city,
                COUNT(*) AS scanned, SUM(last_is_new_fiber=1) AS hits
           FROM scan_targets
          WHERE tenant_id=? AND state=? AND COALESCE(carrier,'kinetic')='kinetic'
            AND last_scanned_at IS NOT NULL
          GROUP BY 1,2 HAVING SUM(last_is_new_fiber=1) > 0 AND skey <> ''
       )
       SELECT s.id, s.address, ${STREET_KEY_SQL("s")} AS street_key, lower(trim(s.city)) AS city,
              hs.hits AS hits, CAST(hs.hits AS REAL)/hs.scanned AS share
         FROM scan_targets s
         JOIN hit_streets hs ON hs.skey=${STREET_KEY_SQL("s")} AND hs.city=lower(trim(s.city))
        WHERE s.tenant_id=? AND s.state=? AND COALESCE(s.carrier,'kinetic')='kinetic'
          AND s.last_scanned_at IS NULL
          AND NOT ${anfParkedSql("s", 14)}
          AND NOT EXISTS (SELECT 1 FROM scan_run_targets t JOIN scan_runs r ON r.id=t.run_id
                           WHERE t.target_id=s.id AND t.state IN ('queued','inflight') AND r.status='running')
        ORDER BY ${seedSql} ASC, share DESC, hs.hits DESC, lower(trim(s.city)) ASC, hs.skey ASC, s.id ASC
        LIMIT ?`,
    ).all(tenantId, state, tenantId, state, streetCap) as Array<{ id: number; address: string; street_key: string; city: string; hits: number; share: number }>;
    if (rows.length) {
      const prior = (rawDb.prepare(`SELECT COUNT(*) AS n FROM scan_runs WHERE tenant_id=? AND id LIKE ?`)
        .get(tenantId, `nsweep_${tenantId}_${state}_street_${day}_%`) as any)?.n ?? 0;
      const runId = `nsweep_${tenantId}_${state}_street_${day}_s${Number(prior) + 1}`;
      const cities = new Set(rows.map((r) => r.city));
      const queued = startSweepRun(tenantId, runId, SWEEP_RUN_KIND.street,
        `Sweep streets ${state}: ${rows.length} doors on ${new Set(rows.map((r) => `${r.city}|${r.street_key}`)).size} streets that already produced fiber (${[...cities].slice(0, 3).map(titleCase).join(", ")})`,
        "sweep-street", state, rows.map((r) => r.id), dispatch);
      if (queued) { result.street = queued; result.runIds.push(runId); left -= queued; }
    }
  }

  // FLOOD: hot cells, best first, whole cell per run.
  const workOf = (c: FrontierCell) => c.unscanned + c.staleNegatives + c.unlinkedGreens;
  const floods = frontier.filter((c) => c.decision.phase === "flood")
    .sort((a, b) => seedRank(a.city) - seedRank(b.city) || b.decision.score - a.decision.score || workOf(b) - workOf(a));
  const probeBudget = Math.round(left * SWEEP_CFG.probeFraction());
  let floodLeft = left - probeBudget;
  let e911Cells = 0;
  const e911Enabled = SWEEP_CFG.e911() && countAddressPoints() > 0;
  const rebridgeCut = new Date(nowMs - SWEEP_CFG.e911RebridgeDays() * 86_400_000).toISOString();
  const bridgedAt = rawDb.prepare(`SELECT e911_bridged_at FROM sweep_cells WHERE tenant_id=? AND state=? AND cell_lat=? AND cell_lng=?`);
  for (const cell of floods) {
    if (floodLeft <= 0 || result.floodCells >= SWEEP_CFG.maxFloodRuns()) break;
    if (cellHasRunningRun(tenantId, cell.cellLat, cell.cellLng)) continue;
    if (e911Enabled && e911Cells < SWEEP_CFG.e911CellsPerCycle()) {
      const last = (bridgedAt.get(tenantId, state, cell.cellLat, cell.cellLng) as any)?.e911_bridged_at as string | null | undefined;
      if (!last || last < rebridgeCut) {
        e911Cells++; // every bridge attempt counts toward the per-cycle cap
        result.e911Added += bridgeE911ForCell(tenantId, state, cell, nowMs);
      }
    }
    const rows = withKeys(cellTargets(tenantId, state, cell, "due", SWEEP_CFG.maxPerCell()));
    if (!rows.length) continue;
    const ordered = orderFlood(rows).slice(0, floodLeft);
    const ck = cellKey(cell.cellLat, cell.cellLng);
    const seqRow = rawDb.prepare(`SELECT floods FROM sweep_cells WHERE tenant_id=? AND state=? AND cell_lat=? AND cell_lng=?`).get(tenantId, state, cell.cellLat, cell.cellLng) as any;
    const runId = `nsweep_${tenantId}_${ck}_${day}_f${Number(seqRow?.floods ?? 0) + 1}`;
    const queued = startSweepRun(tenantId, runId, SWEEP_RUN_KIND.flood,
      `Sweep flood ${titleCase(cell.city)} ${cell.cellLat.toFixed(2)},${cell.cellLng.toFixed(2)}: ${ordered.length} doors (${cell.hits} hits so far)`,
      cell.city, state, ordered.map((r) => r.id), dispatch);
    if (!queued) continue;
    noteCellRun(tenantId, state, cell.cellLat, cell.cellLng, runId, "flood", nowMs);
    result.flood += queued; result.floodCells++; result.runIds.push(runId); floodLeft -= queued;
  }
  left = floodLeft + probeBudget;

  // PROBE: cold cells, best evidence first, one address per street. All of a
  // cycle's probes travel in ONE run (cells in rank order) so a cycle starts a
  // handful of worker loops, not one per 12-door cell.
  const probes = frontier.filter((c) => c.decision.phase === "probe")
    .sort((a, b) => seedRank(a.city) - seedRank(b.city) || b.decision.score - a.decision.score);
  const probeIds: number[] = [];
  const probedCells: FrontierCell[] = [];
  for (const cell of probes) {
    const room = left - probeIds.length;
    if (room < Math.min(policy.probePerCell, 4)) break;
    if (cellHasRunningRun(tenantId, cell.cellLat, cell.cellLng)) continue;
    const rows = withKeys(cellTargets(tenantId, state, cell, "unscanned", SWEEP_CFG.maxPerCell()));
    if (!rows.length) continue;
    const ids = selectProbe(rows, Math.min(policy.probePerCell, room));
    if (!ids.length) continue;
    probeIds.push(...ids);
    probedCells.push(cell);
  }
  if (probeIds.length) {
    const prior = (rawDb.prepare(`SELECT COUNT(*) AS n FROM scan_runs WHERE tenant_id=? AND id LIKE ?`)
      .get(tenantId, `nsweep_${tenantId}_${state}_probe_${day}_%`) as any)?.n ?? 0;
    const runId = `nsweep_${tenantId}_${state}_probe_${day}_p${Number(prior) + 1}`;
    const queued = startSweepRun(tenantId, runId, SWEEP_RUN_KIND.probe,
      `Sweep probe ${state}: ${probeIds.length} doors across ${probedCells.length} cold neighborhoods`,
      "sweep-probe", state, probeIds, dispatch);
    if (queued) {
      for (const cell of probedCells) noteCellRun(tenantId, state, cell.cellLat, cell.cellLng, runId, "probe", nowMs);
      result.probe = queued; result.probeCells = probedCells.length; result.runIds.push(runId); left -= queued;
    }
  }

  return finish();
}

function titleCase(s: string): string { return (s || "").replace(/\b\w/g, (c) => c.toUpperCase()); }

// ── Scheduler ────────────────────────────────────────────────────────────────
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/** Start the periodic cycle. Caller guarantees this is the control worker. */
export function startNeighborhoodSweep(tenantId: number): void {
  if (timer || !SWEEP_CFG.enabled()) return;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try { await runSweepCycle(tenantId); }
    catch (e: any) { structuredLog("neighborhood_sweep.cycle_failed", { error: String(e?.message ?? e).slice(0, 200) }, "warn"); }
    finally { inFlight = false; }
  };
  void tick();
  timer = setInterval(() => { void tick(); }, SWEEP_CFG.intervalMin() * 60_000);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  structuredLog("neighborhood_sweep.started", { tenantId, state: SWEEP_CFG.state(), intervalMin: SWEEP_CFG.intervalMin() });
}

export function stopNeighborhoodSweep(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

// ── Read model for the manager surface ───────────────────────────────────────
export interface NeighborhoodRow {
  cellLat: number; cellLng: number; city: string; state: string; phase: string; score: number; expectedRate: number;
  reasons: string[]; scanned: number; hits: number; live: number; unscanned: number; staleNegatives: number;
  lastHitAt: string | null; parkedReason: string | null; lastRunId: string | null; lastEnqueuedAt: string | null;
  run: { status: string; verified: number; budget: number; newFiber: number } | null;
  leads: number; unworkedLeads: number; knockedLeads: number; assignedLeads: number;
  /** One unworked lead in the cell (or any lead), so the map can fly there. */
  sampleLeadId: number | null;
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number };
}

/**
 * Ranked neighborhoods for a manager: cells with fresh leads nobody has
 * knocked first, then the cells still being flooded. Lead counts come from the
 * leads table (the projector's output), knocks from knock_log, so "unworked"
 * means no rep has ever touched the door, whatever its current status.
 */
export function listNeighborhoods(tenantId: number, opts: { state?: string; limit?: number; phase?: string } = {}): NeighborhoodRow[] {
  ensureSweepSchema();
  const state = (opts.state ?? SWEEP_CFG.state()).toUpperCase();
  const limit = Math.max(1, Math.min(500, opts.limit ?? 60));
  const phaseFilter = opts.phase ? `AND c.phase=@phase` : "";
  const rows = rawDb.prepare(
    `WITH lead_cells AS (
       SELECT ROUND(l.lat,2) AS cl, ROUND(l.lng,2) AS cg,
              COUNT(*) AS leads,
              SUM(CASE WHEN k.lead_id IS NULL AND l.lead_status='prospect' AND l.last_outcome IS NULL THEN 1 ELSE 0 END) AS unworked,
              SUM(CASE WHEN k.lead_id IS NOT NULL THEN 1 ELSE 0 END) AS knocked,
              SUM(CASE WHEN l.assigned_rep_id IS NOT NULL OR l.assigned_territory_id IS NOT NULL THEN 1 ELSE 0 END) AS assigned,
              COALESCE(MIN(CASE WHEN k.lead_id IS NULL AND l.lead_status='prospect' AND l.last_outcome IS NULL THEN l.id END), MIN(l.id)) AS sample_lead_id
         FROM leads l
         LEFT JOIN (SELECT DISTINCT lead_id FROM knock_log) k ON k.lead_id=l.id
        WHERE l.tenant_id=@tenantId AND upper(l.state)=@state AND l.lat IS NOT NULL AND l.lng IS NOT NULL
          AND l.lead_tag='fresh_fiber_confirmed'
          AND l.lead_status NOT IN ('scope_suppressed','competitor_suppressed','address_review','now_active')
        GROUP BY 1,2
     )
     SELECT c.*, COALESCE(lc.leads,0) AS leads, COALESCE(lc.unworked,0) AS unworked,
            COALESCE(lc.knocked,0) AS knocked, COALESCE(lc.assigned,0) AS assigned, lc.sample_lead_id AS sample_lead_id
       FROM sweep_cells c
       LEFT JOIN lead_cells lc ON lc.cl=c.cell_lat AND lc.cg=c.cell_lng
      WHERE c.tenant_id=@tenantId AND c.state=@state ${phaseFilter}
        AND (c.phase IN ('flood','probe') OR COALESCE(lc.leads,0) > 0)
      ORDER BY COALESCE(lc.unworked,0) DESC, (c.phase='flood') DESC, c.score DESC
      LIMIT @limit`,
  ).all({ tenantId, state, limit, phase: opts.phase ?? null }) as any[];
  return rows.map((r) => {
    const run = r.last_run_id ? getRun(r.last_run_id, tenantId) : undefined;
    return {
      cellLat: r.cell_lat, cellLng: r.cell_lng, city: r.city ?? "", state: r.state, phase: r.phase,
      score: r.score, expectedRate: r.expected_rate, reasons: safeJson(r.reasons),
      scanned: r.scanned, hits: r.hits, live: r.live, unscanned: r.unscanned, staleNegatives: r.stale_negatives,
      lastHitAt: r.last_hit_at, parkedReason: r.parked_reason, lastRunId: r.last_run_id, lastEnqueuedAt: r.last_enqueued_at,
      run: run ? { status: run.status, verified: run.verified, budget: run.budget, newFiber: run.newFiber } : null,
      leads: r.leads, unworkedLeads: r.unworked, knockedLeads: r.knocked, assignedLeads: r.assigned,
      sampleLeadId: r.sample_lead_id ?? null,
      bbox: { minLat: r.cell_lat - 0.005, maxLat: r.cell_lat + 0.005, minLng: r.cell_lng - 0.005, maxLng: r.cell_lng + 0.005 },
    };
  });
}

export interface SweepSummary {
  enabled: boolean; state: string; intervalMin: number;
  cells: Record<string, number>;
  /** Cells holding at least one fresh lead no rep has touched, and those doors. */
  neighborhoodsWithUnworked: number; unworkedFreshDoors: number;
  unscannedInHotCells: number; unlinkedGreens: number;
  coming: ReturnType<typeof comingSummary>;
  lastCycle: any | null;
  last24h: { checks: number; hits: number; leads: number };
  pending: number;
}

export function sweepSummary(tenantId: number): SweepSummary {
  ensureSweepSchema();
  const state = SWEEP_CFG.state();
  const cells: Record<string, number> = {};
  let unscannedInHotCells = 0, unlinkedGreens = 0;
  for (const r of rawDb.prepare(`SELECT phase, COUNT(*) AS n, SUM(unscanned) AS u, SUM(unlinked_greens) AS g FROM sweep_cells WHERE tenant_id=? AND state=? GROUP BY phase`).all(tenantId, state) as any[]) {
    cells[r.phase] = r.n;
    if (r.phase === "flood") unscannedInHotCells = Number(r.u ?? 0);
    unlinkedGreens += Number(r.g ?? 0);
  }
  const lastCycle = rawDb.prepare(`SELECT * FROM sweep_cycles WHERE tenant_id=? AND state=? ORDER BY id DESC LIMIT 1`).get(tenantId, state) ?? null;
  // + on tenant_id/state so the last_scanned_at range index drives the scan;
  // the tenant-prefixed index the planner otherwise picks costs 2,966 ms here.
  const checks = rawDb.prepare(
    `SELECT COUNT(*) AS n, SUM(last_is_new_fiber=1) AS h FROM scan_targets
      WHERE last_scanned_at > datetime('now','-24 hours') AND +tenant_id=? AND +state=?`,
  ).get(tenantId, state) as any;
  // fresh_confirmed_at is copied from scan_targets (SQLite 'YYYY-MM-DD HH:MM:SS'); the
  // aggregate is unindexed, so normalizing the column is exact (server/sqlTime.ts).
  const leads = rawDb.prepare(`SELECT COUNT(*) AS n FROM leads WHERE tenant_id=? AND upper(state)=? AND lead_tag='fresh_fiber_confirmed'
    AND replace(COALESCE(fresh_confirmed_at,''),'T',' ') > datetime('now','-24 hours')`).get(tenantId, state) as any;
  const unworked = rawDb.prepare(
    `SELECT COUNT(*) AS cells, COALESCE(SUM(n),0) AS doors FROM (
       SELECT ROUND(l.lat,2) AS cl, ROUND(l.lng,2) AS cg, COUNT(*) AS n
         FROM leads l LEFT JOIN (SELECT DISTINCT lead_id FROM knock_log) k ON k.lead_id=l.id
        WHERE l.tenant_id=? AND upper(l.state)=? AND l.lat IS NOT NULL AND l.lng IS NOT NULL
          AND l.lead_tag='fresh_fiber_confirmed' AND l.lead_status='prospect' AND l.last_outcome IS NULL AND k.lead_id IS NULL
        GROUP BY 1,2)`,
  ).get(tenantId, state) as any;
  return {
    enabled: SWEEP_CFG.enabled(), state, intervalMin: SWEEP_CFG.intervalMin(),
    cells, neighborhoodsWithUnworked: Number(unworked?.cells ?? 0), unworkedFreshDoors: Number(unworked?.doors ?? 0),
    unscannedInHotCells, unlinkedGreens, coming: comingSummary(tenantId, state, Date.now()), lastCycle,
    last24h: { checks: Number(checks?.n ?? 0), hits: Number(checks?.h ?? 0), leads: Number(leads?.n ?? 0) },
    pending: pendingSweepRows(tenantId),
  };
}

function safeJson(s: unknown): string[] {
  try { const v = JSON.parse(String(s ?? "[]")); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
