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
 * A pair must be the SAME DOOR under two spellings: equal canonical address
 * (house, street AND unit), differing only in the city/state the canonical key
 * bakes in, at coordinates within rooftop range.
 *
 * The equal-canonical-address term was added 2026-08-27. Until then the header
 * here claimed "genuine neighbors (different house numbers) and distinct units
 * (street_key retains the unit token) can never pair", and neither half was
 * true: streetKeyOf CUTS the unit clause off instead of retaining it, and
 * CAST(address AS INTEGER) reads "313", "313A", "313-A" and "313-B" as one
 * house. Measured against the live dev database that day, 6,696 pairs were
 * queued for merge and 943 of them were NOT the same door — 579 differing only
 * by unit ("77 Lake Vista Dr" vs "77 Lake Vista Dr Lot 16"), 327 differing by
 * house letter ("313-A Charlotte Ave" vs "313-B Charlotte Ave"), 37 by a
 * secondary number ("314 318 Malcolm Way" vs "314 322 Malcolm Way"). 655
 * distinct real doors, each one a row this module would have DELETED.
 */
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";
import { readPressure, PRESSURE_ORDER } from "./resourcePressure";
import { canonicalAddressPart } from "@shared/addressKey";

// The exact same-door test, in SQL. Registered here rather than reusing
// freshHarvest's registerHarvestSqlFunctions because this module is required
// lazily by the yield-rollup janitor and must not drag the scanner graph in.
// It has to live in the predicate, not in a JS filter over the results: the
// janitor stops (and sets alias_merge_done) only when pairsFound reaches 0, so
// pairs we refuse must leave the manifest rather than be dropped after LIMIT.
try {
  (rawDb as any).function("harvest_canonical_address", { deterministic: true },
    (addr: unknown) => canonicalAddressPart(typeof addr === "string" ? addr : ""));
} catch { /* already registered on this connection — the predicate below still resolves */ }

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

// street_key / state / house-integer / coordinates are the CHEAP, index-friendly
// narrowing; harvest_canonical_address is the exact test and is written last so
// the planner evaluates it only on rows that already survived the rest. The
// CAST terms stay: they cost nothing, and `> 0` keeps the whole predicate off
// addresses with no house number at all.
//
// TENANT: this pairing had no tenant term until 2026-08-27, so two tenants
// holding the same premise under different postal cities could pair — and the
// merge DELETES the loser and repoints its leads/snapshots at the survivor,
// across the boundary. `IS` (not `=`) because legacy rows carry tenant_id NULL
// and must only ever pair with each other, which is the same operator the
// sibling guard in storage.upsertScanTargets uses. Latent, not exercised: the
// live database measured 0 cross-tenant pairs (one tenant), so adding this
// changes no existing merge.
const TWIN_PAIRS_SQL = `
  SELECT a.id AS aId, b.id AS bId FROM scan_targets a JOIN scan_targets b
    ON b.street_key = a.street_key AND b.id > a.id
   AND b.tenant_id IS a.tenant_id
   AND upper(b.state) = upper(a.state)
   AND b.canonical_key <> a.canonical_key
   AND CAST(a.address AS INTEGER) = CAST(b.address AS INTEGER) AND CAST(a.address AS INTEGER) > 0
   AND b.lat BETWEEN a.lat - 0.00023 AND a.lat + 0.00023
   AND b.lng BETWEEN a.lng - 0.00028 AND a.lng + 0.00028
   AND harvest_canonical_address(b.address) = harvest_canonical_address(a.address)
   WHERE a.street_key IS NOT NULL AND a.street_key <> ''`;

export function dryRunManifest(): { sameCanonicalGroups: number; cityAliasPairs: number } {
  const g = rawDb.prepare(`SELECT COUNT(*) g FROM (SELECT 1 FROM scan_targets
    WHERE canonical_key IS NOT NULL GROUP BY tenant_id, canonical_key HAVING COUNT(*) > 1)`).get() as any;
  const p = rawDb.prepare(`SELECT COUNT(*) p FROM (${TWIN_PAIRS_SQL})`).get() as any;
  return { sameCanonicalGroups: Number(g?.g ?? 0), cityAliasPairs: Number(p?.p ?? 0) };
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

/** Structural regrowth prevention — only when zero duplicate groups remain. */
export function promoteCanonicalUnique(): { promoted: boolean; reason?: string } {
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
