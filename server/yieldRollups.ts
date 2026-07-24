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
import fs from "fs";
import path from "path";
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";
import { readPressure, PRESSURE_ORDER } from "./resourcePressure";
import { streetKeyOf } from "./freshHarvest";

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
      // 5) Canonical cleanup (Slice 1): merge postal-city alias twins (live
      // manifest: 152 pairs) then promote the canonical index to UNIQUE —
      // bounded, idempotent, invariant-guarded, halts on any failure.
      // Kill-switch SCAN_TARGET_MERGE=off.
      if (process.env.SCAN_TARGET_MERGE !== "off" && getState("alias_merge_done") !== "1") {
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
      // 6) ADDRESS REPAIR LANE — terminally-parked addresses (the escalating
      // park window's endpoint) get repaired from our own verified neighbours
      // or quarantined as ADDRESS_REVIEW. Bounded per tick, sentinel-aware,
      // single-writer, idempotent (a processed row leaves the candidate set).
      // Kill-switch ADDRESS_REPAIR_LANE=off.
      if (process.env.ADDRESS_REPAIR_LANE !== "off") {
        try {
          const { runAddressRepairPass } = require("./addressRepairLane") as typeof import("./addressRepairLane");
          const res = runAddressRepairPass(Math.max(50, Number(process.env.ADDRESS_REPAIR_BATCH) || 300));
          if (res.examined > 0) return; // one duty per tick — keep ticks short
        } catch (e: any) {
          structuredLog("yield_rollups.repair_error", { error: String(e?.message ?? e).slice(0, 140) }, "error");
        }
      }
      // Steady-state: keep stats fresh the recommended way (cheap no-op when
      // nothing changed enough to matter).
      try { rawDb.exec("PRAGMA optimize"); } catch { /* advisory */ }
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
  while (!negStreakBackfillChunk() && i++ < maxIterations) { /* drain */ }
  rawDb.exec("ANALYZE");
  setState("analyze_done", "1");
  _resetYieldRollupReadyForTests();
}

// Evidence helper for ops: sizes the rollup state without heavy reads.
export function yieldRollupStatus(): Record<string, unknown> {
  const dataDir = process.env.DATA_DIR || process.cwd();
  const walPath = path.join(dataDir, "data.db-wal");
  let walMb = 0;
  try { walMb = Math.round(fs.statSync(walPath).size / 1_048_576); } catch { /* absent */ }
  return {
    ready: yieldRollupsReady(),
    streetkeyDone: getState("streetkey_done") === "1",
    negstreakDone: getState("negstreak_done") === "1",
    negstreakCursor: getState("negstreak_cursor"),
    indexes: INDEXES.map((i) => ({ name: i.name, exists: indexExists(i.name) })),
    walMb,
  };
}
