/**
 * DB PRUNE — keeps the database (and therefore disk + deploy backups) lean.
 *
 * The scan firehose writes hundreds of thousands of rows a day; un-pruned it
 * grew the DB to 6.8GB with a 10.3GB WAL and started failing every deploy
 * backup. Nightly job, batched so it never holds the write lock long:
 *
 *   - scan_run_targets       for runs FINISHED more than
 *                            SCAN_RUN_TARGETS_KEEP_DAYS ago (default 14d)
 *   - scan_events            older than SCAN_EVENTS_KEEP_DAYS (default 7d)
 *   - availability_snapshots older than SNAPSHOTS_KEEP_DAYS (default 30d)
 *   - bandwidth_ledger       older than 40d (beyond any billing-cycle need)
 *   - leads_rejected         older than 90d (audit trail kept a quarter)
 *   - notification_outbox    sent/failed rows older than
 *                            OUTBOX_KEEP_DAYS (default 30d)
 *
 * ── Why scan_run_targets was added (2026-08) ────────────────────────────────
 * This job ran nightly for months and the production database still reached
 * 18.8 GB on a 38 GB disk, with the volume hitting 100% and SQLITE_FULL taking
 * out a maintenance run. Measuring inside the file rather than guessing showed
 * why: 0.0% of it was free pages — every byte was live — and ONE table carried
 * over half of it.
 *
 *     5.57 GB  scan_run_targets
 *     2.00 GB  idx_srt_run_state                     ┐
 *     1.52 GB  sqlite_autoindex_scan_run_targets_1   ├ its indexes
 *     1.04 GB  idx_srt_target_state                  ┘
 *     ────────
 *    10.13 GB  = 54% of the database
 *
 * It is the per-run work queue: one row per (run, address) with a state and a
 * result. While a run is live those rows ARE the run. Once it is finished they
 * are history nothing reads — and storage.ts's own index comment already called
 * it "the never-pruned table", so this was known and simply never done.
 *
 * Retention keys off the RUN, not the row, because scan_run_targets has no
 * timestamp of its own — only terminal runs (done/error/cancelled) are eligible,
 * so a paused run that resumes next week still finds its queue intact.
 *
 * ── What is deliberately NOT pruned ─────────────────────────────────────────
 * fiber_checks (2.66 GB) and the kinetic_* evidence tables (1.78 GB) are the
 * product's memory, not its exhaust: freshness provenance, and the independent
 * evidence behind every "confirmed fresh" claim (see docs/FRESH_FIBER_MOAT.md).
 * Deleting those to save disk trades a durable asset for a cheap byte. If they
 * ever have to shrink it should be a deliberate archival decision, not a
 * retention default set during a disk incident.
 *
 * fiber_job_events / fiber_job_failures already self-trim toward
 * FIBER_LOG_MAX_ROWS at their writers (see fiberOperationsStore).
 *
 * ── On the file not shrinking ───────────────────────────────────────────────
 * auto_vacuum is NONE, so deleting rows returns pages to SQLite's freelist, not
 * to the filesystem: the file stops GROWING but does not get smaller. That is
 * the right steady state for a box this size — reclaimed pages are reused by
 * new writes. Actually shrinking the file needs a rewrite (VACUUM INTO + swap),
 * which needs free space equal to the live data and is therefore an explicit,
 * supervised operation — see the `compact` action in
 * .github/workflows/host-disk.yml, which refuses unless the room exists.
 *
 * Deletes run in 25k-row batches inside short transactions; a TRUNCATE WAL
 * checkpoint + incremental_vacuum reclaims pages at the end. Everything is
 * best-effort: a busy DB just defers the batch.
 */
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";

const SCAN_EVENTS_KEEP_DAYS = Math.max(1, Number(process.env.SCAN_EVENTS_KEEP_DAYS) || 7);
const SNAPSHOTS_KEEP_DAYS = Math.max(7, Number(process.env.SNAPSHOTS_KEEP_DAYS) || 30);
// Two weeks of finished-run detail is well past the point where anyone reopens
// a run's per-address queue, and short enough that one bad night of scanning
// does not sit in the file for a month.
export const SCAN_RUN_TARGETS_KEEP_DAYS = Math.max(1, Number(process.env.SCAN_RUN_TARGETS_KEEP_DAYS) || 14);
const OUTBOX_KEEP_DAYS = Math.max(7, Number(process.env.OUTBOX_KEEP_DAYS) || 30);
const BATCH = 25_000;
const MAX_BATCHES_PER_TABLE = 40; // ≤1M rows per night per table; remainder next night

function pruneBatched(table: string, whereEpoch: string, cutoff: number): number {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_TABLE; i++) {
    try {
      const n = rawDb.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${whereEpoch} < ? LIMIT ${BATCH})`).run(cutoff).changes;
      total += n;
      if (n < BATCH) break;
    } catch { break; } // busy — next night
  }
  return total;
}

/**
 * The per-run work queue for runs that are OVER.
 *
 * Separate from pruneBatched because eligibility lives on scan_runs, not here:
 * scan_run_targets has no timestamp of its own, and "old" has to mean "its run
 * finished a while ago", never "this row was written a while ago" — a long
 * market run legitimately carries weeks-old queued rows it is still working.
 *
 * Only terminal runs qualify. A paused run resumed next month still finds its
 * queue whole, which is the property that makes this safe to run unattended.
 */
export function pruneFinishedRunTargets(cutoffIso: string): number {
  let total = 0;
  // The eligible run ids, resolved ONCE — re-running this correlated lookup
  // inside every batch would re-scan scan_runs forty times.
  let runIds: string[];
  try {
    // completed_at, NOT finished_at — the column is completed_at on scan_runs
    // (storage.ts). Naming it wrong throws SQLITE_ERROR, which the catch below
    // would swallow into a silent no-op, so the prune would look like it ran
    // and free nothing. tests/unit/db-prune-scan-targets.test.ts runs this
    // against the real schema for exactly that reason.
    runIds = (rawDb.prepare(
      `SELECT id FROM scan_runs
        WHERE status IN ('done','error','cancelled')
          AND COALESCE(completed_at, started_at) < ?`,
    ).all(cutoffIso) as Array<{ id: string }>).map((r) => r.id);
  } catch {
    return 0; // table shape differs (older DB) — nothing to do
  }
  if (!runIds.length) return 0;

  // Chunk the id list so the IN clause stays a sane size on a long history.
  for (let i = 0; i < runIds.length; i += 200) {
    const chunk = runIds.slice(i, i + 200);
    const holes = chunk.map(() => "?").join(",");
    for (let b = 0; b < MAX_BATCHES_PER_TABLE; b++) {
      try {
        const n = rawDb.prepare(
          `DELETE FROM scan_run_targets
            WHERE rowid IN (SELECT rowid FROM scan_run_targets
                             WHERE run_id IN (${holes}) LIMIT ${BATCH})`,
        ).run(...chunk).changes;
        total += n;
        if (n < BATCH) break;
      } catch { break; } // busy — next night
    }
  }
  return total;
}

export function runDbPrune(): void {
  const now = Date.now();
  const out: Record<string, number> = {};
  // First: the table that is over half the database.
  try {
    out.scan_run_targets = pruneFinishedRunTargets(
      new Date(now - SCAN_RUN_TARGETS_KEEP_DAYS * 86_400_000).toISOString());
  } catch { /* */ }
  try { out.scan_events = pruneBatched("scan_events", "ts_epoch", now - SCAN_EVENTS_KEEP_DAYS * 86_400_000); } catch { /* table may not exist yet */ }
  try { out.availability_snapshots = pruneBatched("availability_snapshots", "checked_at_epoch", now - SNAPSHOTS_KEEP_DAYS * 86_400_000); } catch { /* */ }
  try { out.bandwidth_ledger = pruneBatched("bandwidth_ledger", "ts", now - 40 * 86_400_000); } catch { /* */ }
  try { out.leads_rejected = pruneBatched("leads_rejected", "CAST(strftime('%s', rejected_at) AS INTEGER) * 1000", now - 90 * 86_400_000); } catch { /* */ }
  // Delivered notifications. `pending` is never touched at any age — an unsent
  // row is work outstanding, not history, however long it has been stuck.
  try {
    out.notification_outbox = pruneBatched(
      "notification_outbox",
      "CASE WHEN status IN ('sent','failed') THEN CAST(strftime('%s', COALESCE(sent_at, created_at)) AS INTEGER) * 1000 ELSE 9e18 END",
      now - OUTBOX_KEEP_DAYS * 86_400_000);
  } catch { /* */ }
  try { rawDb.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* */ }
  try { rawDb.pragma("incremental_vacuum(2000)"); } catch { /* */ }
  structuredLog("db_prune.done", out);
}
