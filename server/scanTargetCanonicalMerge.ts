/**
 * SCAN-TARGET CANONICAL MERGE — Slice 1 of the anti-miss hardening.
 *
 * Live dry-run (2026-07-23): same-canonical duplicate groups = 0 (the writer
 * guards + the raw-text ROW_NUMBER migration already drained the historical
 * backlog), postal-city alias twins = 152 pairs. This module:
 *   1. dryRunManifest()      — counts, never writes.
 *   2. mergeCityAliasTwins() — bounded, chunked, resumable, idempotent merge
 *      of same-premise twins filed under alias postal cities. Survivor order:
 *      conclusive result > lead-linked > most recently verified > highest
 *      scan_count > lowest id. Repoints EVERY referencing table before the
 *      loser row is deleted; per-batch transaction with invariant checks and
 *      rollback on any mismatch.
 *   3. promoteCanonicalUnique() — structural regrowth prevention: the
 *      (tenant_id, canonical_key) partial index becomes UNIQUE (safe at zero
 *      duplicate groups; refuses loudly if groups reappear).
 *
 * Genuine neighbors (different house numbers) and distinct units (street_key
 * retains the unit token) can never pair — the twin predicate requires equal
 * street_key + state + leading house number + rooftop-range coordinates.
 */
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";
import { readPressure, PRESSURE_ORDER } from "./resourcePressure";

// Every table observed (code grep + live PRAGMA sweep) that references a scan
// target. Missing tables are skipped (bare replay DBs).
const REPOINT: Array<{ table: string; col: string }> = [
  { table: "availability_snapshots", col: "scan_target_id" },
  { table: "scan_run_targets", col: "target_id" },
  { table: "coming_soon_watchlist", col: "scan_target_id" },
  { table: "fiber_transitions", col: "scan_target_id" },
  { table: "qualification_checks", col: "scan_target_id" },
  { table: "discovery_qualification_cache", col: "scan_target_id" },
  { table: "fiber_job_events", col: "target_id" },
  { table: "fiber_job_failures", col: "target_id" },
  { table: "fiber_dead_letters", col: "target_id" },
  { table: "fiber_freshness_scores", col: "scan_target_id" },
  { table: "scan_new_builds", col: "scan_target_id" },
  { table: "expansion_members", col: "target_id" },
  { table: "leads_rejected", col: "source_scan_target_id" },
  { table: "leads", col: "source_scan_target_id" },
  { table: "sweep_job_targets", col: "target_id" },
  { table: "monitor_targets", col: "target_id" },
  { table: "transition_episodes", col: "scan_target_id" },
  { table: "target_state", col: "target_id" },
];

const tableExists = (t: string): boolean =>
  !!rawDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
// Table AND column must both exist — replay/test schemas ship variant subsets,
// and one bad UPDATE would abort the whole merge (observed: sweep tables with
// different column names).
const columnExists = (t: string, c: string): boolean => {
  try {
    return (rawDb.prepare(`PRAGMA table_xinfo(${t})`).all() as Array<{ name: string }>).some((x) => x.name === c);
  } catch { return false; }
};

const TWIN_PAIRS_SQL = `
  SELECT a.id AS aId, b.id AS bId FROM scan_targets a JOIN scan_targets b
    ON b.street_key = a.street_key AND b.id > a.id
   AND upper(b.state) = upper(a.state)
   AND b.canonical_key <> a.canonical_key
   AND CAST(a.address AS INTEGER) = CAST(b.address AS INTEGER) AND CAST(a.address AS INTEGER) > 0
   AND b.lat BETWEEN a.lat - 0.00023 AND a.lat + 0.00023
   AND b.lng BETWEEN a.lng - 0.00028 AND a.lng + 0.00028
   WHERE a.street_key IS NOT NULL AND a.street_key <> ''`;

export function dryRunManifest(): { sameCanonicalGroups: number; cityAliasPairs: number; unkeyedRows: number } {
  const g = rawDb.prepare(`SELECT COUNT(*) g FROM (SELECT 1 FROM scan_targets
    WHERE canonical_key IS NOT NULL GROUP BY tenant_id, canonical_key HAVING COUNT(*) > 1)`).get() as any;
  const p = rawDb.prepare(`SELECT COUNT(*) p FROM (${TWIN_PAIRS_SQL})`).get() as any;
  // HOW BLIND THIS MANIFEST IS, AND WHY THE COUNT ABOVE IS NOT ENOUGH.
  // Both detectors above only see KEYED rows: the group-by filters
  // `canonical_key IS NOT NULL`, and TWIN_PAIRS_SQL compares
  // `b.canonical_key <> a.canonical_key`, which is NULL (never true) whenever
  // either side is un-keyed. On 2026-08-27 that made the manifest report 240
  // duplicate groups on a table holding 26,371 — 292,999 of 924,104 rows were
  // un-keyed and every duplicate behind them was invisible.
  //
  // That mattered because promoteCanonicalUnique() is gated on this count
  // reaching zero: an all-clear read off a blind detector would have made the
  // index UNIQUE while thousands of collisions were still latent, and the next
  // write to stamp any of those keys — this module's own backfill, or the
  // ordinary `canonical_key = COALESCE(canonical_key, ?)` enrich in
  // upsertScanTargets — would have failed with UNIQUE constraint violations
  // mid-harvest. So the manifest now reports what it cannot see.
  return { sameCanonicalGroups: Number(g?.g ?? 0), cityAliasPairs: Number(p?.p ?? 0), unkeyedRows: unkeyedRowCount() };
}

/** Rows the manifest above cannot reason about. Cheap on purpose: SQLite
 *  skip-scans idx_scan_targets_canonical for this, so it is sub-millisecond even
 *  on ~1M rows, which lets promoteCanonicalUnique refuse without first paying
 *  for TWIN_PAIRS_SQL (an unindexed self-join measured at ~3 min on 924k rows). */
export function unkeyedRowCount(): number {
  const u = rawDb.prepare(`SELECT COUNT(*) u FROM scan_targets WHERE canonical_key IS NULL`).get() as any;
  return Number(u?.u ?? 0);
}

// Survivor rank: conclusive (has a fiber verdict) > lead-linked > most recent
// scan > scan_count > lowest id. Returns [survivorId, loserId].
function pickSurvivor(aId: number, bId: number): [number, number] {
  const row = (id: number) => rawDb.prepare(
    `SELECT id, (last_fiber_status IS NOT NULL) conclusive, (converted_to_lead_id IS NOT NULL) hasLead,
            COALESCE(last_scanned_at,'') scannedAt, COALESCE(scan_count,0) scans FROM scan_targets WHERE id=?`,
  ).get(id) as any;
  const a = row(aId), b = row(bId);
  const rank = (r: any) => [r.conclusive, r.hasLead, r.scannedAt, r.scans, -r.id];
  const ra = rank(a), rb = rank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] > rb[i]) return [aId, bId];
    if (ra[i] < rb[i]) return [bId, aId];
  }
  return [aId, bId];
}

export interface MergeResult {
  pairsFound: number; merged: number; fksRepointed: number; skipped: number; halted: string | null;
}

/** Bounded, idempotent, sentinel-aware merge. apply=false → count only. */
export function mergeCityAliasTwins(opts: { apply: boolean; maxPairs?: number } = { apply: false }): MergeResult {
  const result: MergeResult = { pairsFound: 0, merged: 0, fksRepointed: 0, skipped: 0, halted: null };
  const pairs = rawDb.prepare(`${TWIN_PAIRS_SQL} LIMIT ?`).all(opts.maxPairs ?? 1000) as Array<{ aId: number; bId: number }>;
  result.pairsFound = pairs.length;
  if (!opts.apply) return result;
  const repointStmts = REPOINT.filter((r) => tableExists(r.table) && columnExists(r.table, r.col)).map((r) => ({
    ...r, stmt: rawDb.prepare(`UPDATE ${r.table} SET ${r.col} = @survivor WHERE ${r.col} = @loser`),
  }));
  const enrich = rawDb.prepare(`UPDATE scan_targets SET
      zip = CASE WHEN (zip IS NULL OR zip='') THEN (SELECT zip FROM scan_targets WHERE id=@loser) ELSE zip END,
      df_address_id = COALESCE(df_address_id, (SELECT df_address_id FROM scan_targets WHERE id=@loser))
    WHERE id = @survivor`);
  const del = rawDb.prepare(`DELETE FROM scan_targets WHERE id = ?`);
  const countAll = () => Number((rawDb.prepare(`SELECT COUNT(*) n FROM scan_targets`).get() as any).n);
  for (const pair of pairs) {
    if (PRESSURE_ORDER[readPressure().level] >= PRESSURE_ORDER.pause) { result.halted = "resource_pressure"; break; }
    const [survivor, loser] = pickSurvivor(pair.aId, pair.bId);
    const before = countAll();
    try {
      rawDb.transaction(() => {
        // Both rows must still exist (idempotency across resumes/races).
        const exists = rawDb.prepare(`SELECT COUNT(*) n FROM scan_targets WHERE id IN (?, ?)`).get(survivor, loser) as any;
        if (Number(exists.n) !== 2) { result.skipped++; return; }
        enrich.run({ survivor, loser });
        let repointed = 0;
        for (const r of repointStmts) repointed += r.stmt.run({ survivor, loser }).changes;
        del.run(loser);
        // INVARIANTS inside the txn: exactly one row gone; no orphaned refs.
        const after = countAll();
        if (after !== before - 1) throw new Error(`count invariant: ${before} -> ${after}`);
        for (const r of repointStmts) {
          const orphan = rawDb.prepare(`SELECT COUNT(*) n FROM ${r.table} WHERE ${r.col} = ?`).get(loser) as any;
          if (Number(orphan.n) !== 0) throw new Error(`orphan invariant: ${r.table}.${r.col}`);
        }
        result.merged++;
        result.fksRepointed += repointed;
      }).immediate();
    } catch (e: any) {
      result.halted = `rollback: ${String(e?.message ?? e).slice(0, 140)}`;
      structuredLog("scan_target_merge.halted", { pair: `${pair.aId}/${pair.bId}`, error: result.halted }, "error");
      break; // immediate stop on any integrity failure — nothing partial commits
    }
  }
  structuredLog("scan_target_merge.result", { ...result }, result.halted ? "error" : "info");
  return result;
}

/** Structural regrowth prevention — only when zero duplicate groups remain AND
 *  every row is keyed, so "zero groups" is a measurement rather than a blind
 *  spot. Fails closed: an un-keyed row is an unknown, not an absence. */
export function promoteCanonicalUnique(): { promoted: boolean; reason?: string } {
  // Cheap gate first: while anything is un-keyed the duplicate count below is a
  // lower bound, not a measurement, so there is no reason to spend the self-join
  // to reach a refusal we already know.
  const unkeyed = unkeyedRowCount();
  if (unkeyed > 0) {
    return {
      promoted: false,
      reason: `refusing: ${unkeyed} row(s) have no canonical_key, so the duplicate count above them is unknown — backfill first`,
    };
  }
  const m = dryRunManifest();
  if (m.sameCanonicalGroups > 0) {
    return { promoted: false, reason: `refusing: ${m.sameCanonicalGroups} duplicate group(s) present` };
  }
  rawDb.exec(`DROP INDEX IF EXISTS idx_scan_targets_canonical;
    CREATE UNIQUE INDEX idx_scan_targets_canonical ON scan_targets(tenant_id, canonical_key)
      WHERE canonical_key IS NOT NULL`);
  structuredLog("scan_target_merge.unique_promoted", {});
  return { promoted: true };
}
