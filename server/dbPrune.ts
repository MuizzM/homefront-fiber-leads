/**
 * DB PRUNE — keeps the database (and therefore disk + deploy backups) lean.
 *
 * The scan firehose writes hundreds of thousands of rows a day; un-pruned it
 * grew the DB to 6.8GB with a 10.3GB WAL and started failing every deploy
 * backup. Nightly job, batched so it never holds the write lock long:
 *
 *   - scan_events            older than SCAN_EVENTS_KEEP_DAYS (default 7d)
 *   - availability_snapshots older than SNAPSHOTS_KEEP_DAYS (default 30d)
 *   - bandwidth_ledger       older than 40d (beyond any billing-cycle need)
 *   - leads_rejected         older than 90d (audit trail kept a quarter)
 *
 * Deletes run in 25k-row batches inside short transactions; a TRUNCATE WAL
 * checkpoint + incremental_vacuum reclaims pages at the end. Everything is
 * best-effort: a busy DB just defers the batch.
 */
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";

const SCAN_EVENTS_KEEP_DAYS = Math.max(1, Number(process.env.SCAN_EVENTS_KEEP_DAYS) || 7);
const SNAPSHOTS_KEEP_DAYS = Math.max(7, Number(process.env.SNAPSHOTS_KEEP_DAYS) || 30);
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

export function runDbPrune(): void {
  const now = Date.now();
  const out: Record<string, number> = {};
  try { out.scan_events = pruneBatched("scan_events", "ts_epoch", now - SCAN_EVENTS_KEEP_DAYS * 86_400_000); } catch { /* table may not exist yet */ }
  try { out.availability_snapshots = pruneBatched("availability_snapshots", "checked_at_epoch", now - SNAPSHOTS_KEEP_DAYS * 86_400_000); } catch { /* */ }
  try { out.bandwidth_ledger = pruneBatched("bandwidth_ledger", "ts", now - 40 * 86_400_000); } catch { /* */ }
  try { out.leads_rejected = pruneBatched("leads_rejected", "CAST(strftime('%s', rejected_at) AS INTEGER) * 1000", now - 90 * 86_400_000); } catch { /* */ }
  try { rawDb.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* */ }
  try { rawDb.pragma("incremental_vacuum(2000)"); } catch { /* */ }
  structuredLog("db_prune.done", out);
}
