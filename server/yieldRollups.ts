/**
 * YIELD ROLLUPS — kill the WAL-pinning mega-query with precomputed columns.
 *
 * The yield engine's scoreDueTargets() was a single synchronous statement that
 * full-scanned ~949k scan_targets rows calling JS UDFs per row
 * (harvest_street_key twice) plus a full group over availability_snapshots
 * (neg_streak) and a second full group over scan_targets (cell_scans). One
 * such statement holds a WAL read mark for minutes — observed live as the
 * reader that starves wal_checkpoint(TRUNCATE) (db.wal_guard busy:1) while
 * the WAL grows toward the disk-full death spiral.
 *
 * The fix: precompute what the query recomputed per row —
 *   • cell_lat/cell_lng  — VIRTUAL GENERATED columns, exactly ROUND(lat,2)/
 *     ROUND(lng,2), always correct by construction, indexable. No backfill.
 *   • street_key         — plain column = harvest_street_key(address), filled
 *     by a chunked janitor (new rows within minutes, legacy rows once).
 *   • neg_streak         — plain column maintained in the SAME UPDATE that
 *     records every conclusive result (single-writer path, no new write
 *     sites): +1 on a conclusive negative, reset on a conclusive positive.
 *     Truer to the documented "unchanged-negative streak" intent than the old
 *     120d window COUNT it replaces (that window was itself the approximation).
 *   • indexes            — cell group + street joins + snapshot epoch ranges
 *     become index-backed instead of full scans.
 *
 * All maintenance runs POST-LISTEN in the cluster PRIMARY (near-idle event
 * loop; a blocking one-time CREATE INDEX stalls no HTTP or scanning), chunked,
 * resumable via a cursor table, and pauses whenever the resource sentinel
 * reports pressure. The yield engine keeps using its ORIGINAL query until
 * every readiness flag is set, then switches. Kill-switch: YIELD_ROLLUPS=off.
 */
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";
import { readPressure, PRESSURE_ORDER } from "./resourcePressure";
import { streetKeyOf } from "./freshHarvest";
import { canonicalAddressPart, normalizeKineticAddressKey } from "@shared/addressKey";

const NEG_STREAK_WINDOW_DAYS = 120; // backfill parity with the old CTE window

function columnExists(table: string, column: string): boolean {
  try {
    // table_xinfo, NOT table_info: plain table_info OMITS generated columns,
    // which made a re-run try to re-add cell_lat and fail on duplicate.
    return (rawDb.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string }>)
      .some((c) => c.name === column);
  } catch { return false; }
}

function indexExists(name: string): boolean {
  try {
    return !!rawDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`).get(name);
  } catch { return false; }
}

// Cheap, instant DDL only — safe to run at boot from runMigrations().
// (ADD COLUMN and ADD virtual generated column do not rewrite the table.)
export function ensureYieldRollupSchema(): void {
  rawDb.exec(`CREATE TABLE IF NOT EXISTS yield_rollup_state (
    k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`);
  if (!columnExists("scan_targets", "street_key")) {
    rawDb.exec(`ALTER TABLE scan_targets ADD COLUMN street_key TEXT`);
  }
  if (!columnExists("scan_targets", "neg_streak")) {
    rawDb.exec(`ALTER TABLE scan_targets ADD COLUMN neg_streak INTEGER NOT NULL DEFAULT 0`);
  }
  // Exactly the expressions the yield engine grouped/joined on — the generated
  // columns can never drift from ROUND(lat,2)/ROUND(lng,2).
  if (!columnExists("scan_targets", "cell_lat")) {
    rawDb.exec(`ALTER TABLE scan_targets ADD COLUMN cell_lat REAL GENERATED ALWAYS AS (ROUND(lat, 2)) VIRTUAL`);
  }
  if (!columnExists("scan_targets", "cell_lng")) {
    rawDb.exec(`ALTER TABLE scan_targets ADD COLUMN cell_lng REAL GENERATED ALWAYS AS (ROUND(lng, 2)) VIRTUAL`);
  }
}

function getState(k: string): string | null {
  try { return (rawDb.prepare(`SELECT v FROM yield_rollup_state WHERE k=?`).get(k) as any)?.v ?? null; }
  catch { return null; }
}
function setState(k: string, v: string): void {
  rawDb.prepare(`INSERT INTO yield_rollup_state (k, v, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at`).run(k, v, Date.now());
}

// The three one-time index builds. Each is a single blocking statement run in
// the PRIMARY under sentinel gating; busy_timeout lets concurrent workers ride
// out the write lock.
const INDEXES: Array<{ name: string; ddl: string }> = [
  {
    name: "idx_scan_targets_cell",
    ddl: `CREATE INDEX IF NOT EXISTS idx_scan_targets_cell
            ON scan_targets (tenant_id, cell_lat, cell_lng, last_scanned_at)`,
  },
  {
    name: "idx_scan_targets_street",
    ddl: `CREATE INDEX IF NOT EXISTS idx_scan_targets_street
            ON scan_targets (tenant_id, street_key)`,
  },
  {
    name: "idx_availability_snapshots_epoch",
    ddl: `CREATE INDEX IF NOT EXISTS idx_availability_snapshots_epoch
            ON availability_snapshots (checked_at_epoch)`,
  },
];

const STREET_CHUNK = Math.max(500, Number(process.env.YIELD_STREET_CHUNK) || 10_000);
const NEG_CHUNK = Math.max(500, Number(process.env.YIELD_NEG_CHUNK) || 10_000);
const CANON_CHUNK = Math.max(500, Number(process.env.YIELD_CANON_CHUNK) || 2_000);

// Fill street_key for rows that lack it (legacy rows once; brand-new inserts
// within a couple of ticks). Returns rows processed.
export function streetKeyJanitorChunk(limit = STREET_CHUNK): number {
  const rows = rawDb.prepare(
    `SELECT id, address FROM scan_targets WHERE street_key IS NULL LIMIT ?`,
  ).all(limit) as Array<{ id: number; address: string | null }>;
  if (!rows.length) return 0;
  const update = rawDb.prepare(`UPDATE scan_targets SET street_key=? WHERE id=?`);
  const tx = rawDb.transaction((batch: typeof rows) => {
    for (const r of batch) update.run(streetKeyOf(r.address ?? ""), r.id);
  });
  tx(rows);
  return rows.length;
}

/**
 * One resumable chunk of the canonical_key backfill. Returns true when done.
 *
 * WHY: storage.upsertScanTargets stops a re-spelled house becoming a second row
 * with `WHERE tenant_id IS ? AND canonical_key = ?`. That lookup cannot fire on
 * a NULL key, so every un-keyed row is invisible to the guard and to
 * scanTargetCanonicalMerge's duplicate manifest. Measured 2026-08-27: 292,999 of
 * 924,104 rows un-keyed, hiding 26,131 duplicate groups — 7,163 of them a door
 * scanned (and paid for) on two rows.
 *
 * Both insert paths stamp the key today, so this is a one-time drain of rows
 * written before that, hence the cursor + done flag rather than a steady-state
 * sweep like the street_key janitor. It must run BEFORE the alias merge and the
 * UNIQUE promotion in step 5 — see promoteCanonicalUnique, which now refuses
 * while any row is still un-keyed.
 *
 * Rows whose address has no canonical street part are SKIPPED, never stamped: a
 * blank street yields a degenerate "|CITY|STATE" key that would make every such
 * row in a city one another's twin. The cursor (not a bare `IS NULL LIMIT n`)
 * is what keeps those skipped rows from trapping the loop forever.
 */
export function canonicalKeyBackfillChunk(chunk = CANON_CHUNK): boolean {
  if (getState("canonkey_done") === "1") return true;
  if (!columnExists("scan_targets", "canonical_key")) {
    setState("canonkey_done", "1"); // replay/fresh DB without the column
    return true;
  }
  const cursor = Number(getState("canonkey_cursor") ?? 0);
  const rows = rawDb.prepare(
    `SELECT id, address, city, state, zip FROM scan_targets
      WHERE canonical_key IS NULL AND id > ? ORDER BY id LIMIT ?`,
  ).all(cursor, chunk) as Array<{ id: number; address: string | null; city: string | null; state: string | null; zip: string | null }>;
  if (!rows.length) { setState("canonkey_done", "1"); return true; }

  const update = rawDb.prepare(`UPDATE scan_targets SET canonical_key=? WHERE id=? AND canonical_key IS NULL`);
  const tx = rawDb.transaction((batch: typeof rows) => {
    for (const r of batch) {
      // The exact rule upsertScanTargets applies to a new row.
      if (!canonicalAddressPart(r.address ?? "")) continue;
      update.run(
        normalizeKineticAddressKey(r.address ?? "", r.city ?? "", r.state ?? "NC", r.zip ?? ""),
        r.id,
      );
    }
  });
  // .immediate() takes the write lock up front; a deferred transaction would
  // start as a reader and upgrade on the first UPDATE, which is the shape that
  // returns SQLITE_BUSY while a scan run holds the lock.
  tx.immediate(rows);
  setState("canonkey_cursor", String(rows[rows.length - 1].id));
  return false;
}

// One resumable chunk of the neg_streak backfill: parity with the old CTE
// (COUNT of conclusive negatives in the 120d window per target), computed via
// the existing (scan_target_id, checked_at_epoch) index. Cursor persists so a
// restart resumes where it left off. Returns true when finished.
export function negStreakBackfillChunk(chunk = NEG_CHUNK): boolean {
  if (getState("negstreak_done") === "1") return true;
  if (!columnExists("availability_snapshots", "checked_at_epoch")) {
    setState("negstreak_done", "1"); // replay/fresh DB — nothing to derive from
    return true;
  }
  const cursor = Number(getState("negstreak_cursor") ?? 0);
  const maxRow = rawDb.prepare(`SELECT MAX(id) m FROM scan_targets`).get() as any;
  const maxId = Number(maxRow?.m ?? 0);
  if (cursor > maxId) { setState("negstreak_done", "1"); return true; }
  const hi = cursor + chunk;
  const cut = Date.now() - NEG_STREAK_WINDOW_DAYS * 86_400_000;
  rawDb.prepare(
    `UPDATE scan_targets SET neg_streak = (
       SELECT COUNT(*) FROM availability_snapshots a
        WHERE a.scan_target_id = scan_targets.id
          AND a.conclusive = 1 AND a.fiber_available = 0
          AND a.checked_at_epoch > ?)
     WHERE id > ? AND id <= ? AND last_scanned_at IS NOT NULL`,
  ).run(cut, cursor, hi);
  setState("negstreak_cursor", String(hi));
  if (hi > maxId) { setState("negstreak_done", "1"); return true; }
  return false;
}

// Readiness: the yield engine switches to the rollup-backed query only when
// everything it depends on exists. Cached briefly — it's read every cycle.
let readyCache: { at: number; ready: boolean } | null = null;
export function yieldRollupsReady(): boolean {
  if (process.env.YIELD_ROLLUPS === "off") return false;
  const now = Date.now();
  if (readyCache && now - readyCache.at < 60_000 && readyCache.ready) return true;
  const ready =
    columnExists("scan_targets", "street_key") &&
    columnExists("scan_targets", "cell_lat") &&
    INDEXES.every((i) => indexExists(i.name)) &&
    getState("streetkey_done") === "1" &&
    getState("negstreak_done") === "1" &&
    getState("analyze_done") === "1";
  readyCache = { at: now, ready };
  return ready;
}
export function _resetYieldRollupReadyForTests(): void { readyCache = null; }

// ── Maintenance runner ───────────────────────────────────────────────────────
// One owner per box (cluster primary / single process), interval ticks, never
// at boot, pauses under any sentinel pressure, logs every step and error.
export function startYieldRollupMaintenance(): NodeJS.Timeout | null {
  if (process.env.YIELD_ROLLUPS === "off") return null;
  try { ensureYieldRollupSchema(); } catch (e: any) {
    structuredLog("yield_rollups.schema_error", { error: e?.message ?? String(e) }, "error");
    return null;
  }
  const intervalMs = Math.max(10_000, Number(process.env.YIELD_ROLLUP_TICK_MS) || 30_000);
  // Per-tick work budget: chunks loop until this much wall time is spent, so
  // the one-time backfill of ~1M rows completes in minutes, not hours. Each
  // chunk is its own short transaction — writers only wait chunk-sized beats.
  const tickBudgetMs = Math.max(500, Number(process.env.YIELD_ROLLUP_TICK_BUDGET_MS) || 5_000);
  const tick = () => {
    try {
      // Gate ONLY on pause/emergency. Under warn/throttle the maintenance MUST
      // keep running — the WAL pressure is CAUSED by the legacy scoring query,
      // and this backfill is precisely what retires it. Pausing on warn would
      // deadlock the fix behind the symptom.
      const level = readPressure().level;
      if (PRESSURE_ORDER[level] >= PRESSURE_ORDER.pause) {
        structuredLog("yield_rollups.paused", { reason: `resource_pressure_${level}` });
        return;
      }
      // 1) One-time index builds, one per tick (each is a single blocking
      // statement; spreading them across ticks bounds any one stall).
      for (const idx of INDEXES) {
        if (!indexExists(idx.name)) {
          const started = Date.now();
          rawDb.exec(idx.ddl);
          structuredLog("yield_rollups.index_built", { index: idx.name, ms: Date.now() - started });
          return;
        }
      }
      const deadline = Date.now() + tickBudgetMs;
      // 2) street_key janitor (also the steady-state duty for new inserts).
      let processed = 0;
      let chunk = streetKeyJanitorChunk();
      while (chunk > 0 && Date.now() < deadline) { processed += chunk; chunk = streetKeyJanitorChunk(); }
      processed += chunk;
      if (processed > 0) {
        structuredLog("yield_rollups.street_chunk", { processed });
        if (Date.now() >= deadline) return; // budget spent — resume next tick
      }
      if (getState("streetkey_done") !== "1" && processed === 0) {
        setState("streetkey_done", "1");
        structuredLog("yield_rollups.street_done", {});
      }
      // 3) neg_streak backfill (one-time, resumable).
      if (getState("negstreak_done") !== "1") {
        let done = false;
        while (!done && Date.now() < deadline) done = negStreakBackfillChunk();
        structuredLog("yield_rollups.neg_chunk", { cursor: getState("negstreak_cursor"), done });
        return;
      }
      // 4) ANALYZE once after the indexes+backfills exist. Without sqlite_stat1
      // the planner chose a tenant-prefixed index for ~950k-row outer scans
      // (single tenant → the prefix matches EVERY row → an index crawl with a
      // random rowid lookup per row). Observed live: the control worker pinned
      // at ~100% CPU for 17+ minutes in queries that run in seconds with stats.
      // Readiness (yieldRollupsReady) requires this flag, so the rollup scorer
      // can never run against a stats-less planner.
      if (getState("analyze_done") !== "1") {
        const t = Date.now();
        rawDb.exec("ANALYZE");
        setState("analyze_done", "1");
        structuredLog("yield_rollups.analyze_done", { ms: Date.now() - t });
        return;
      }
      // 4b) canonical_key backfill (one-time, resumable). MUST precede step 5:
      // the merge manifest and the UNIQUE promotion both read canonical_key, so
      // running them first would measure — and lock in — a table a third of
      // which has no key. See canonicalKeyBackfillChunk.
      if (getState("canonkey_done") !== "1") {
        let done = false;
        while (!done && Date.now() < deadline) done = canonicalKeyBackfillChunk();
        structuredLog("yield_rollups.canonkey_chunk", { cursor: getState("canonkey_cursor"), done });
        return;
      }
      // 5) Canonical cleanup (Slice 1): merge postal-city alias twins then
      // promote the canonical index to UNIQUE — bounded, idempotent,
      // invariant-guarded, halts on any failure.
      //
      // OPT-IN (SCAN_TARGET_MERGE=on), not opt-out. This step DELETES rows, and
      // step 4b above changed how many: the alias predicate compares
      // `b.canonical_key <> a.canonical_key`, which is NULL — never true — while
      // either side is un-keyed, so every row the backfill keys becomes newly
      // eligible. Measured on the live local database 2026-08-27: 2,845 pairs
      // before the backfill, 6,677 after. Letting a background job quietly widen
      // a destructive merge by 3,832 pairs because a repair made rows visible is
      // exactly the surprise this flag now prevents. Turn it on deliberately,
      // after reading the manifest.
      if (process.env.SCAN_TARGET_MERGE !== "on" && getState("alias_merge_done") !== "1") {
        // Say so once, cheaply. dryRunManifest() runs an unindexed self-join
        // (~3 min on 924k rows) so it is NOT called here — only on the path that
        // is actually going to merge.
        if (getState("alias_merge_pending_logged") !== "1") {
          structuredLog("yield_rollups.alias_merge_pending",
            { reason: "SCAN_TARGET_MERGE is not 'on'; alias twins are reported, never merged", enable: "SCAN_TARGET_MERGE=on" }, "warn");
          setState("alias_merge_pending_logged", "1");
        }
        // Deliberately falls through to steady state: an unmade decision must
        // not pin this loop on step 5 forever.
      } else if (getState("alias_merge_done") !== "1") {
        const { mergeCityAliasTwins, promoteCanonicalUnique, dryRunManifest } =
          require("./scanTargetCanonicalMerge") as typeof import("./scanTargetCanonicalMerge");
        const res = mergeCityAliasTwins({ apply: true, maxPairs: 500 });
        if (res.halted) return; // logged inside; retry next tick unless integrity-halted
        if (res.pairsFound === 0) {
          const uq = promoteCanonicalUnique();
          structuredLog("yield_rollups.alias_merge_done", { ...dryRunManifest(), uniquePromoted: uq.promoted, reason: uq.reason ?? "" });
          setState("alias_merge_done", "1");
        }
        return;
      }
      // Steady state: nothing one-time is left. Planner statistics were already
      // refreshed at the top of this tick (step 0), which is the only work the
      // steady state has to do.
      // NOTE: PRAGMA optimize only reconsiders tables THIS CONNECTION has
      // queried, which is why the 0x10002 mask is used for the first pass.
    } catch (e: any) {
      structuredLog("yield_rollups.error", { error: e?.message ?? String(e) }, "error");
    }
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  structuredLog("yield_rollups.maintenance_started", { intervalMs });
  return timer;
}

// Test/ops helper: run maintenance to completion synchronously (small DBs).
export function runYieldRollupMaintenanceToCompletion(maxIterations = 10_000): void {
  ensureYieldRollupSchema();
  for (const idx of INDEXES) if (!indexExists(idx.name)) rawDb.exec(idx.ddl);
  let i = 0;
  while (streetKeyJanitorChunk() > 0 && i++ < maxIterations) { /* drain */ }
  setState("streetkey_done", "1");
  i = 0;
  while (!canonicalKeyBackfillChunk() && i++ < maxIterations) { /* drain */ }
  i = 0;
  while (!negStreakBackfillChunk() && i++ < maxIterations) { /* drain */ }
  rawDb.exec("ANALYZE");
  setState("analyze_done", "1");
  _resetYieldRollupReadyForTests();
}

/**
 * Planner statistics get their OWN timer, deliberately.
 *
 * They used to ride the yield-rollup tick, which is wrong twice over:
 *
 *  1. `YIELD_ROLLUPS=off` returns before the timer is even created
 *     (startYieldRollupMaintenance above) - and production sets exactly that.
 *     So the statistics fix shipped in 342be18 never ran in production at all.
 *  2. Even with rollups on, the call sat below five one-time migration steps
 *     that each `return`, so any install still draining a migration ran blind,
 *     and an alias merge halted on its integrity guard would block it forever.
 *
 * This is the same trap the address-repair lane already fell into and was
 * pulled out of (see server/index.ts, "INDEPENDENT of YIELD_ROLLUPS"). Query
 * planner upkeep is infrastructure, not a feature: it belongs to the process,
 * not to a feature flag. Its only switch is its own, ANALYZE_MAINTENANCE=off.
 *
 * Cost: 0-5 ms per tick in steady state; 14 s once, on the first
 * PRAGMA optimize=0x10002 pass. Primary/control worker only - it serves no
 * HTTP, so a one-off blocking pragma stalls nothing that answers a request.
 */
export function startPlannerStatsMaintenance(): NodeJS.Timeout | null {
  if (process.env.ANALYZE_MAINTENANCE === "off") return null;
  const intervalMs = Math.max(30_000, Number(process.env.ANALYZE_TICK_MS) || 300_000);
  const tick = () => {
    try {
      if (PRESSURE_ORDER[readPressure().level] >= PRESSURE_ORDER.pause) return;
      optimizePlannerStats();
    } catch (e: any) {
      structuredLog("planner_stats.error", { error: e?.message ?? String(e) }, "error");
    }
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  structuredLog("planner_stats.maintenance_started", { intervalMs });
  return timer;
}

// ── Planner statistics upkeep ────────────────────────────────────────────────
// SQLite's documented lifecycle for a long-lived connection (lang_analyze.html):
// `PRAGMA optimize=0x10002` once when the connection is first used, then plain
// `PRAGMA optimize` periodically. Since 3.46.0 optimize bounds its own ANALYZE
// work, so this is preferred over routine full ANALYZE - which is what this
// module used to do, and which the SQLite performance standard explicitly warns
// against running unbounded on a schedule.
//
// Why it was needed at all: `analyze_done` was a one-shot latch, so a long-lived
// install kept whatever statistics existed the first time it ran. Measured on a
// production-shaped copy (app build 3.49.2), sqlite_stat1 held stats for exactly
// ONE scan_targets index and their value was "0 0 0 0"; the planner therefore
// chose a tenant-prefixed index and walked all 919k rows for a 24-hour count the
// range index answers immediately. Plain `PRAGMA optimize` could not fix it
// because it only reconsiders tables THIS CONNECTION has queried, and the
// maintenance connection never touches scan_targets. The 0x10002 mask lifts
// exactly that restriction.
//
// Measured on the 3.3 GB copy: the first 0x10002 pass took 26.6 s and moved the
// query from 3,373 ms to 0 ms; every later plain optimize took 5 ms. It runs on
// the cluster primary, which serves no HTTP, and only after the deferred boot
// window - never at open, so it cannot delay the health gate.
// Rows examined per index. 0 means unlimited, which is exactly what must never
// run here - see the write-lock note in optimizePlannerStats.
const ANALYSIS_LIMIT = () => Math.max(100, Number(process.env.ANALYZE_ANALYSIS_LIMIT) || 1000);
const OPTIMIZE_PERIOD_H = Math.max(1, Number(process.env.ANALYZE_MAX_AGE_HOURS) || 24);
// How long a maintenance ANALYZE may WAIT for the database write lock. This is
// deliberately NOT the connection's busy_timeout, which production sets to
// 120000 (docker-compose.production.yml) so that real request work rides out a
// long writer. Planner upkeep is optional work: if the lock is busy it should
// come back in five minutes, not sit on the busy handler for two minutes.
const ANALYZE_LOCK_WAIT_MS = () => Math.max(100, Number(process.env.ANALYZE_LOCK_WAIT_MS) || 2000);
// A single table's ANALYZE that exceeds this is pathological and gets reported.
const ANALYZE_TABLE_BUDGET_MS = () => Math.max(500, Number(process.env.ANALYZE_TABLE_BUDGET_MS) || 5000);

/** Returns what it did, for logging and tests. */
export function optimizePlannerStats(nowMs = Date.now()): "full" | "incremental" | null {
  if (process.env.ANALYZE_MAINTENANCE === "off") return null;
  // Bound the WHOLE tick, not just the ANALYZE. setState is a write too, so at
  // production's busy_timeout of 120000 the cursor stamp blocked for two
  // minutes before the ANALYZE was even reached — lowering the wait around only
  // the ANALYZE fixed nothing. Restored in the finally below so request-path
  // statements keep their full tolerance.
  const priorWait = Number(rawDb.pragma("busy_timeout", { simple: true }) ?? 0);
  try {
    rawDb.pragma(`busy_timeout = ${ANALYZE_LOCK_WAIT_MS()}`);
    // ── Why ONE TABLE PER TICK, and why bounded ─────────────────────────────
    // PRAGMA optimize runs its ANALYZE as a SINGLE write transaction across
    // every table it touches, and SQLite's write lock is database-wide ACROSS
    // PROCESSES. "The primary serves no HTTP" protects the primary's event loop
    // and nothing else: while that transaction is open, every HTTP worker doing
    // any write blocks on the busy handler, freezes its event loop, and then
    // throws SQLITE_BUSY once busy_timeout (15 s, server/db.ts:34) elapses.
    //
    // Measured on a production-shaped copy, and production's database is five
    // times larger:
    //   PRAGMA optimize=0x10002, analysis_limit=1000 .... 13.6 s  in ONE lock
    //   per-table ANALYZE, cold, worst single table .....  3.2 s  per lock
    //   per-table ANALYZE, warm, all 251 tables .........   65 ms total
    //
    // So the whole cost is the first analysis of each table, and taking it one
    // table at a time turns a single 13.6 s lock into a series of short ones.
    // Production has never run this pragma at all (YIELD_ROLLUPS=off), so
    // shipping the unbounded form would have INTRODUCED the stall behind
    // PR #169/#170 rather than avoiding it.
    //
    // analysis_limit is SQLite's own bound (lang_analyze.html). Approximate
    // statistics beat the single `0 0 0 0` row this install has today.
    rawDb.exec(`PRAGMA analysis_limit=${ANALYSIS_LIMIT()}`);

    const table = nextTableToAnalyse();
    if (table) {
      // ── WHY THE CURSOR ADVANCES BEFORE THE ANALYZE, AND NOT AFTER ─────────
      // It used to advance after, so a table whose ANALYZE THREW left the
      // cursor untouched and the next tick chose the SAME table again. With
      // production's busy_timeout of 120000 that is not a retry, it is a
      // permanent outage: every 5 minutes this connection sat on the busy
      // handler for two full minutes and then failed, forever. Measured live
      // 2026-08-27 18:57 — `ANALYZE "rep_daily_metrics"` 120167ms x2, primary
      // event-loop lag 240384ms, and every writer queued behind it timing out
      // at exactly 120171ms (rep_metrics_dirty_days, resource_pressure — the
      // pressure sentinel itself could not record that there was pressure).
      //
      // Stamping the cursor FIRST makes the sweep monotonic: each table gets
      // at most one attempt per pass, a failure costs one tick instead of
      // every future tick, and the next daily pass retries it from scratch.
      // Statistics are an optimization; skipping one table's is survivable,
      // wedging the box is not.
      attemptedTable = table;                        // in memory: cannot fail
      try { setState(STAT_CURSOR_KEY, table); }      // on disk: may fail, fine
      catch { /* lock held; attemptedTable already guarantees progress */ }
      const started = Date.now();
      try {
        rawDb.exec(`ANALYZE "${table.replace(/"/g, '""')}"`);
      } catch (e: any) {
        // Almost always SQLITE_BUSY. Not worth alarming on: the table keeps the
        // statistics it had and the next daily pass retries it. What matters is
        // that we do NOT come back to this same table in five minutes.
        structuredLog("yield_rollups.analyze_skipped",
          { table, ms: Date.now() - started, error: String(e?.message ?? e).slice(0, 120) }, "warn");
        return "full";
      }
      const ms = Date.now() - started;
      structuredLog("yield_rollups.analyze_table", { table, ms },
        ms > ANALYZE_TABLE_BUDGET_MS() ? "warn" : "info");
      return "full";
    }

    // Every table has been analysed at least once: fall back to SQLite's
    // recommended steady-state upkeep, which is a no-op when nothing changed
    // enough to matter (measured 1 ms).
    rawDb.exec("PRAGMA optimize");
    // Start the clock when the sweep FINISHES, not before. Reading an unset key
    // as 0 makes "a day has passed" true on the very first incremental tick,
    // which cleared the cursor and restarted the sweep immediately - an endless
    // loop that never reaches steady state.
    const key = "optimize_full_at";
    const last = Number(getState(key) ?? 0);
    if (!last) setState(key, String(nowMs));
    else if (nowMs - last >= OPTIMIZE_PERIOD_H * 3_600_000) {
      setState(key, String(nowMs));
      setState(STAT_CURSOR_KEY, ""); // a fresh bounded sweep tomorrow
      // BOTH copies, or the sweep never restarts: nextTableToAnalyse prefers
      // the in-memory cursor, so clearing only the row would leave this process
      // pinned at the last table it reached and freeze statistics for good.
      attemptedTable = null;
    }
    return "incremental";
  } catch (e: any) {
    structuredLog("yield_rollups.optimize_failed", { error: String(e?.message ?? e).slice(0, 120) }, "warn");
    return null;
  } finally {
    if (priorWait > 0) rawDb.pragma(`busy_timeout = ${priorWait}`);
  }
}

const STAT_CURSOR_KEY = "analyze_table_cursor";
// The cursor ALSO lives in memory, because persisting it is itself a write and
// the case that matters is precisely the one where writes are failing. If the
// lock is held, setState throws too — so a disk-only cursor leaves the sweep
// choosing the same table on every tick, which is the loop that took production
// down. The row is the restart-durable copy; this is the one that guarantees
// forward progress inside a process.
let attemptedTable: string | null = null;

/**
 * The next table to analyse this tick, biggest-impact first, or null once the
 * sweep is done. Ordering matters: the planner is blind on scan_targets today,
 * so that must not wait behind 250 alphabetically-earlier tables.
 */
function nextTableToAnalyse(): string | null {
  const PRIORITY = ["scan_targets", "leads", "availability_snapshots", "fiber_checks",
                    "scan_run_targets", "scan_runs", "coming_soon_watchlist"];
  const done = attemptedTable ?? String(getState(STAT_CURSOR_KEY) ?? "");
  const all = (rawDb.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as Array<{ name: string }>).map((r) => r.name);
  const ordered = [...PRIORITY.filter((p) => all.includes(p)),
                   ...all.filter((n) => !PRIORITY.includes(n))];
  if (!done) return ordered[0] ?? null;
  const i = ordered.indexOf(done);
  return i >= 0 && i + 1 < ordered.length ? ordered[i + 1] : null;
}

/** Test hook: forget that the full pass ran in this process. */
export function _resetPlannerStatsForTests(): void {
  attemptedTable = null;
  try { setState(STAT_CURSOR_KEY, ""); } catch { /* lock held — the in-memory reset is what matters */ }
}

/** Test hook: the table this process last committed to analysing. Read from
 *  memory on purpose — the persisted row is unwritable exactly when the lock is
 *  held, which is the scenario worth testing. */
export function _plannerStatsCursorForTests(): string | null { return attemptedTable; }
