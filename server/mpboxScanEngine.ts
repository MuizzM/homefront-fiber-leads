// ── MP Box incremental scan ──────────────────────────────────────────────────
//
// The rule the whole design serves: a repeated scan of an unchanged area must
// produce the SAME answers while doing far less work. Everything below exists
// to make "did this record actually change in a way that could change its
// classification?" cheap and honest to answer.
//
// Why not timestamps. scan_targets rows are rewritten by several producers -
// the sweep, the projector, the repair lane, manual taps - and there is no
// reliable per-row updated_at that all of them maintain. Trusting one would
// silently skip records whose evidence really did change. So "changed" means
// the FINGERPRINT of the classifying fields differs, and nothing else.
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";
import {
  CLASSIFIER_VERSION, classify, emptyStats, ensureMpboxSchema, fingerprintOf,
  loadPriorState, needsWork, persistBatch, alreadyRecorded, saveCheckpoint,
  saveStats, type MpboxOutcome, type MpboxStats,
} from "./mpboxScanStore";

export interface MpboxRecord {
  targetId: number;
  address: string; city: string; state: string; zip: string;
  lastFiberStatus?: string | null;
  isNewFiber?: number | boolean | null;
  billingStatus?: string | null;
  customerSegment?: string | null;
  fiberAvailable?: number | boolean | null;
}

/**
 * Work the caller does per record that we cannot do ourselves - the provider
 * check. Returns the fields a classification is derived from, or throws.
 * Deliberately NOT called inside a transaction.
 */
export type Classifier = (r: MpboxRecord) => Promise<{
  lastFiberStatus?: string | null;
  isNewFiber?: number | boolean | null;
  billingStatus?: string | null;
  fiberAvailable?: number | boolean | null;
}>;

export interface RunOptions {
  scanId: string;
  tenantId: number;
  records: MpboxRecord[];
  classify: Classifier;
  /** Bounded write batch. Small enough that the write lock is held briefly. */
  batchSize?: number;
  /** Checked between records; a true return stops the run cleanly. */
  shouldStop?: () => boolean;
  nowMs?: number;
  onProgress?: (stats: MpboxStats) => void;
}

/** Discovered records, deduplicated on the stable source id. */
export function dedupe(records: MpboxRecord[]): { unique: MpboxRecord[]; removed: number } {
  const seen = new Map<number, MpboxRecord>();
  for (const r of records) if (!seen.has(r.targetId)) seen.set(r.targetId, r);
  return { unique: [...seen.values()], removed: records.length - seen.size };
}

/**
 * One incremental scan.
 *
 * Order of operations matters and is the spec of the algorithm:
 *   1  dedupe on the stable id
 *   2  ONE bounded query for all prior state (never per-record: that is the N+1)
 *   3  fingerprint from classifying fields only
 *   4  decide work vs cache, keeping the REASON for the statistics
 *   5  put new and changed records first, so an interrupted run has already
 *      done the most valuable part
 *   6  classify outside any transaction
 *   7  persist in bounded batches, checkpointing as we go
 *   8  a resumed run skips what is already recorded, so nothing is counted twice
 */
export async function runIncrementalScan(opts: RunOptions): Promise<MpboxStats> {
  ensureMpboxSchema();
  const now = opts.nowMs ?? Date.now();
  const started = Date.now();
  const batchSize = Math.max(1, Math.min(500, opts.batchSize ?? 100));
  const stats = emptyStats();

  // 1 - dedupe
  stats.discovered = opts.records.length;
  const { unique, removed } = dedupe(opts.records);
  stats.duplicatesRemoved = removed;
  stats.eligible = unique.length;

  // 8 (setup) - a resumed run must not redo or recount finished records.
  const done = alreadyRecorded(opts.scanId);

  // 2 - one bounded read for every prior state
  const prior = loadPriorState(unique.map((r) => r.targetId));

  // 3 + 4 - fingerprint and triage
  type Item = { rec: MpboxRecord; fp: string; reason: ReturnType<typeof needsWork>["reason"]; work: boolean };
  const items: Item[] = [];
  for (const rec of unique) {
    if (done.has(rec.targetId)) continue; // already persisted by an earlier attempt
    const fp = fingerprintOf(rec);
    const d = needsWork(prior.get(rec.targetId), fp, now);
    items.push({ rec, fp, reason: d.reason, work: d.work });
    if (!d.work) stats.unchanged++;
    else if (d.reason === "new") stats.new++;
    else if (d.reason === "changed") stats.changed++;
    else if (d.reason === "expired") stats.staleRescanned++;
    // "version" and "incomplete" are re-work, not new/changed: counted in
    // processed and succeeded, but they must not inflate "new".
  }

  // 5 - new and changed first. An interrupted scan should have spent its time
  // on the records that could actually have moved.
  const rank = (r: Item["reason"]) =>
    r === "new" ? 0 : r === "changed" ? 1 : r === "expired" ? 2 : r === "version" ? 3 : r === "incomplete" ? 4 : 5;
  items.sort((a, b) => rank(a.reason) - rank(b.reason) || a.rec.targetId - b.rec.targetId);

  let batch: Parameters<typeof persistBatch>[1] = [];
  let cancelled = false;

  const flush = (checkpointAfter?: number) => {
    if (!batch.length) return;
    persistBatch(opts.scanId, batch);
    batch = [];
    if (checkpointAfter != null) {
      saveCheckpoint(opts.scanId, { lastTargetId: checkpointAfter, at: Date.now(), version: CLASSIFIER_VERSION });
    }
  };

  for (const it of items) {
    if (opts.shouldStop?.()) { cancelled = true; break; }

    if (!it.work) {
      // 5 - reuse the cached classification. Recorded against THIS run so the
      // filter counts cover every record the run considered, not only the ones
      // it paid for.
      const p = prior.get(it.rec.targetId)!;
      stats.skippedFromCache++;
      stats.processed++;
      stats.succeeded++;
      tally(stats, p.tenured, p.freshFiber);
      batch.push({
        targetId: it.rec.targetId, fingerprint: it.fp, outcome: "cache_hit" as MpboxOutcome,
        tenured: p.tenured, freshFiber: p.freshFiber, scannedAt: now,
      });
    } else {
      // 6 - the slow part, deliberately outside any transaction.
      try {
        const fresh = await opts.classify(it.rec);
        const c = classify({ ...it.rec, ...fresh });
        stats.processed++;
        stats.succeeded++;
        tally(stats, c.tenured, c.freshFiber);
        // Re-fingerprint from what the provider actually returned: the stored
        // cache must describe the evidence it was derived from, not the stale
        // row we started with.
        const fp2 = fingerprintOf({ ...it.rec, ...fresh });
        batch.push({
          targetId: it.rec.targetId, fingerprint: fp2, outcome: "classified" as MpboxOutcome,
          tenured: c.tenured, freshFiber: c.freshFiber, scannedAt: now,
        });
      } catch (e: any) {
        stats.processed++;
        stats.failed++;
        // A failure is recorded so the run is honest about partial success, but
        // it never writes record_scan_state - a transport error teaches us
        // nothing about the door (see persistBatch).
        batch.push({
          targetId: it.rec.targetId, fingerprint: it.fp, outcome: "failed" as MpboxOutcome,
          tenured: null, freshFiber: null, error: String(e?.message ?? e).slice(0, 200), scannedAt: now,
        });
      }
    }

    if (batch.length >= batchSize) {
      flush(it.rec.targetId);
      stats.elapsedMs = Date.now() - started;
      stats.cacheHitPct = pct(stats.skippedFromCache, stats.processed);
      opts.onProgress?.({ ...stats });
    }
  }

  if (cancelled) {
    // Everything not yet processed is cancelled, not failed. The distinction
    // matters: failed invites a retry, cancelled was the operator's choice.
    stats.cancelled = Math.max(0, stats.eligible - done.size - stats.processed);
  }
  flush(items.length ? items[items.length - 1].rec.targetId : undefined);

  stats.matched = stats.tenured + stats.freshFiber - stats.both;
  stats.elapsedMs = Date.now() - started;
  stats.cacheHitPct = pct(stats.skippedFromCache, stats.processed);
  saveStats(opts.scanId, stats, cancelled ? "cancelled" : stats.failed && !stats.succeeded ? "error" : "done");

  structuredLog("mpbox.scan_complete", {
    scanId: opts.scanId, ...stats, classifierVersion: CLASSIFIER_VERSION,
  }, cancelled ? "warn" : "info");
  return stats;
}

function tally(s: MpboxStats, tenured: boolean | null, fresh: boolean | null): void {
  if (tenured) s.tenured++;
  if (fresh) s.freshFiber++;
  if (tenured && fresh) s.both++;
}

const pct = (n: number, d: number) => (d <= 0 ? 0 : Math.round((1000 * n) / d) / 10);

/**
 * Read the records inside a bbox straight from scan_targets. Keyset-ordered by
 * id and bounded; the cell columns drive the window off idx_scan_targets_cell
 * rather than making the planner walk a tenant prefix (measured elsewhere in
 * this codebase at 412 ms vs 2 ms for the same shape).
 */
export function recordsInBbox(
  tenantId: number,
  b: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  limit = 5000,
): MpboxRecord[] {
  const CELL = 0.01;
  return (rawDb.prepare(
    `SELECT id, address, city, state, zip,
            last_fiber_status, last_is_new_fiber, last_billing_status,
            last_customer_segment, last_fiber_available
       FROM scan_targets
      WHERE tenant_id = ?
        AND cell_lat BETWEEN ? AND ? AND cell_lng BETWEEN ? AND ?
        AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
      ORDER BY id
      LIMIT ?`,
  ).all(tenantId, b.minLat - CELL, b.maxLat + CELL, b.minLng - CELL, b.maxLng + CELL,
    b.minLat, b.maxLat, b.minLng, b.maxLng, Math.max(1, Math.min(20_000, limit))) as any[])
    .map((r) => ({
      targetId: Number(r.id), address: String(r.address ?? ""), city: String(r.city ?? ""),
      state: String(r.state ?? ""), zip: String(r.zip ?? ""),
      lastFiberStatus: r.last_fiber_status, isNewFiber: r.last_is_new_fiber,
      billingStatus: r.last_billing_status, customerSegment: r.last_customer_segment,
      fiberAvailable: r.last_fiber_available,
    }));
}
