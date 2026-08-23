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
/**
 * Ceiling on how long ANY org may keep precise location, whatever their own
 * policy says. Per-tenant retention is configurable (field_location_policy),
 * but it is configurable *below* this line, not above it - a misconfigured or
 * maliciously-widened tenant setting cannot turn a 7-day window into forever.
 */
const LOCATION_PINGS_MAX_KEEP_DAYS = Math.max(1, Number(process.env.LOCATION_PINGS_KEEP_DAYS) || 7);

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
 * Availability snapshots, MINUS the one row per door the lead projector needs.
 *
 * This was a blanket `pruneBatched("availability_snapshots", "checked_at_epoch")`
 * at SNAPSHOTS_KEEP_DAYS (30), and that quietly capped the useful life of every
 * lead in the system at thirty days.
 *
 * `server/freshFiberProjector.ts:102-133` reads exactly one row per target - the
 * latest CONCLUSIVE snapshot - and publishes nothing without it
 * (`:243` rejects a null `fiber_available`, `:296` a non-true one, `:299` builds
 * `authoritativeFresh` from that row's segment and billing status). Meanwhile
 * the evidence that snapshot was derived from, `fiber_checks`, is kept forever
 * on purpose (see the header above). So a door scanned in July stopped being
 * publishable in August while its provider body sat on disk untouched.
 *
 * Measured on a production-shaped copy: 3,214 kinetic targets carry a
 * `lifecycle_state`, which `server/availabilitySnapshot.ts:113-115` only ever
 * writes on a successful snapshot insert - and have no snapshot left. A prune
 * run on 2026-08-22 removed 796 more. The pool regenerates every 30 days.
 *
 * The latest conclusive snapshot is the product's memory, not its exhaust,
 * exactly like the bodies behind it. History older than the window still goes;
 * that one row per door stays, whatever its age.
 *
 * Cost: the keep-set is resolved ONCE per prune (a grouped scan of
 * idx_availability_snapshots_target_epoch), not per batch, for the same reason
 * pruneFinishedRunTargets resolves its run ids once.
 */
export function pruneSnapshotsKeepingLatestConclusive(cutoff: number): number {
  // Ties on (scan_target_id, checked_at_epoch) keep both rows. Harmless: the
  // projector's ORDER BY picks one deterministically, and keeping a spare
  // costs a row where dropping the wrong one costs a lead.
  try {
    rawDb.exec(`DROP TABLE IF EXISTS temp.snapshot_keep;
      CREATE TEMP TABLE snapshot_keep AS
        SELECT scan_target_id, MAX(checked_at_epoch) AS keep_epoch
          FROM availability_snapshots WHERE conclusive = 1 GROUP BY scan_target_id;
      CREATE INDEX temp.idx_snapshot_keep ON snapshot_keep(scan_target_id, keep_epoch);`);
  } catch { return 0; } // busy — next night; deleting nothing is always safe here
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_TABLE; i++) {
    try {
      const n = rawDb.prepare(
        `DELETE FROM availability_snapshots WHERE rowid IN (
           SELECT a.rowid FROM availability_snapshots a
             LEFT JOIN temp.snapshot_keep k ON k.scan_target_id = a.scan_target_id
            WHERE a.checked_at_epoch < ?
              AND NOT (a.conclusive = 1 AND k.keep_epoch IS NOT NULL
                       AND a.checked_at_epoch = k.keep_epoch)
            LIMIT ${BATCH})`).run(cutoff).changes;
      total += n;
      if (n < BATCH) break;
    } catch { break; }
  }
  try { rawDb.exec("DROP TABLE IF EXISTS temp.snapshot_keep"); } catch { /* */ }
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

// ── Terminal job/run retention (2026-08-10) ─────────────────────────────────
// A page-level census of the 18.82 GB production file found that the six table
// families pruned above are not where the bytes are. ~63% of the database is
// job bookkeeping for work that FINISHED, spread across thirteen tables that
// had no retention at all:
//
//   discovery_job_addresses + 2 idx  12.8%      fiber_job_checkpoints + idx  4.9%
//   fiber_job_failures + idx          9.4%      scan_run_targets + 2 idx     3.1%
//   scan_runs + 2 idx                 8.0%      fiber_worker_heartbeats+2idx 2.9%
//   fiber_job_events + idx            6.6%      dead_letters/jobs/events/tiles 4.7%
//   qualification_checks + 3 idx      5.7%
//   discovery_job_runs + 2 idx        5.3%
//
// For scale: 21,561 leads against ~6.9M rows of this. The ratio is ~320:1.
//
// It collapses to TWO deletes. Every one of those tables is a child of either
// discovery_jobs(id) or scan_runs(id) with ON DELETE CASCADE, so removing a
// terminal parent removes its whole subtree. That is why this is three small
// functions and not thirteen.
//
// BATCH SIZE IS DELIBERATELY SMALL HERE. pruneBatched's 25k is right for a leaf
// table; for a cascading parent each deleted row drags an unbounded subtree with
// it (one scan_run can own thousands of scan_run_targets and fiber_job_events),
// and foreign_keys=ON makes SQLite walk every child row inside the same
// transaction. 25k parents would hold the write lock for minutes. 500 keeps each
// transaction short enough that a scan worker's commit waits milliseconds.
const CASCADE_BATCH = Math.max(50, Math.min(5_000, Number(process.env.PRUNE_CASCADE_BATCH) || 500));
const MAX_CASCADE_BATCHES = Math.max(1, Number(process.env.PRUNE_CASCADE_MAX_BATCHES) || 200);
/** Finished scan runs, and with them every fiber_job_* / dead-letter child.
 *
 *  SEVEN days, not thirty, and the reason is the churn rate. Measured on the
 *  production-shaped database: of 547,491 'done' runs, 511,051 were under a
 *  week old - roughly 73,000 runs created per DAY. A 30-day window against that
 *  rate is not retention, it is a no-op: the rehearsal deleted 1 row. A run
 *  whose targets are already pruned at 14 days is bookkeeping, and a week is
 *  well past anyone reopening it.
 *
 *  This is a ceiling, not a target. The churn itself was the accounting bug in
 *  addressDiscovery/engine.ts (a pass that enqueued nothing still reported work,
 *  so the reconciler never went idle); with that fixed the table should stop
 *  growing at this rate and the window stops mattering. */
export const SCAN_RUNS_KEEP_DAYS = Math.max(1, Number(process.env.SCAN_RUNS_KEEP_DAYS) || 7);
/** Finished discovery jobs, and with them addresses/checks/tiles/events. */
export const DISCOVERY_JOBS_KEEP_DAYS = Math.max(1, Number(process.env.DISCOVERY_JOBS_KEEP_DAYS) || 7);
/** Worker heartbeats. The only reader takes ORDER BY heartbeat_at DESC LIMIT 50
 *  (fiberOperationsStore), so anything older than a couple of days is unread by
 *  construction. The row is an UPSERT keyed on worker_id and every scan run mints
 *  a new id, so this table gains a permanent row per run forever - measured at
 *  107,100 rows in a single day. */
export const HEARTBEAT_KEEP_DAYS = Math.max(1, Number(process.env.HEARTBEAT_KEEP_DAYS) || 3);

// ── Abandoned jobs: the reason retention could not see the bloat ────────────
// Retention above is not missing, it is BLIND. Measured on the production-shaped
// database:
//
//   discovery_jobs status=running   675 jobs, oldest created 19 days ago,
//                                   holding 1,594,105 of 1,602,526
//                                   discovery_job_addresses rows (99.5%)
//   scan_runs      status=running   723 runs, 549 with a heartbeat over a day
//                                   stale, holding 791,992 of 804,229
//                                   fiber_job_failures (98.5%), 630,106
//                                   fiber_job_events, 491,486 scan_run_targets
//
// ~1,400 parents never reach a terminal state, so every retention rule - the
// ones that already existed and the ones added above - skips their entire
// subtree forever. Pruning only terminal rows would have freed 8,421 of those
// 1.6M address rows and looked like it worked.
//
// A worker touches its run's heartbeat every 10s (scanEngine's hbTimer). A
// heartbeat that is HOURS stale means the process that owned it is gone: killed
// mid-batch, OOMed, or lost to a redeploy. Nothing will ever finish these.
//
// CANCELLED, not error, and the distinction is load-bearing. getStrandedDoneRuns
// matches status IN ('done','error') and re-opens whatever still has claimable
// targets; marking these 'error' would feed 723 abandoned runs straight into
// that drain and re-open them every 60 seconds forever - the re-open livelock
// scanEngine already documents having hit once. 'cancelled' is explicitly
// excluded there ("those were deliberately stopped and must not resurrect"),
// and it is terminal, so the retention above can finally collect them.
const ABANDONED_RUN_STALE_HOURS = Math.max(1, Number(process.env.ABANDONED_RUN_STALE_HOURS) || 24);

// STAMP completed_at WITH WHEN IT DIED, NOT WHEN WE NOTICED.
//
// The obvious `completed_at = datetime('now')` is wrong and silently defeats the
// whole point: retention ages off completed_at, so stamping today would reset a
// run that actually stopped 19 days ago and hide it for another full retention
// window. Caught in rehearsal - the terminalizers converted 546 runs and 604
// jobs and the prune that followed deleted exactly zero.
//
// The last heartbeat IS the time of death, so that is what goes in.

/** Runs whose worker died without ever finishing them. */
export function cancelAbandonedScanRuns(staleHours = ABANDONED_RUN_STALE_HOURS): number {
  try {
    return rawDb.prepare(
      `UPDATE scan_runs
          SET status='cancelled',
              error=COALESCE(error, 'abandoned: no worker heartbeat for ' || ? || 'h'),
              completed_at=COALESCE(completed_at, heartbeat_at, started_at, datetime('now'))
        WHERE status='running'
          AND COALESCE(heartbeat_at, started_at) < datetime('now', ?)`,
    ).run(staleHours, `-${staleHours} hours`).changes;
  } catch { return 0; }
}

/** Discovery jobs abandoned mid-flight. Same rule, different clock: these have
 *  no heartbeat column, so updated_at is the liveness signal. */
export function cancelAbandonedDiscoveryJobs(staleHours = ABANDONED_RUN_STALE_HOURS): number {
  try {
    return rawDb.prepare(
      `UPDATE discovery_jobs
          SET status='cancelled',
              completed_at=COALESCE(completed_at, updated_at, created_at, datetime('now'))
        WHERE status IN ('running','queued')
          AND COALESCE(updated_at, created_at) < datetime('now', ?)`,
    ).run(`-${staleHours} hours`).changes;
  } catch { return 0; }
}

/**
 * Delete terminal rows from a CASCADE parent, in small batches.
 *
 * `statusCol`/`terminal` gate on the parent being finished - never delete a
 * live job's subtree out from under a running worker. `tsExpr` must be a SQL
 * expression yielding an ISO timestamp on the parent row.
 */
function pruneCascadeParent(
  table: string, idCol: string, statusCol: string, terminal: string[], tsExpr: string, cutoffIso: string,
): number {
  let total = 0;
  const holes = terminal.map(() => "?").join(",");
  for (let b = 0; b < MAX_CASCADE_BATCHES; b++) {
    try {
      const n = rawDb.prepare(
        `DELETE FROM ${table} WHERE ${idCol} IN (
           SELECT ${idCol} FROM ${table}
            WHERE ${statusCol} IN (${holes}) AND ${tsExpr} < ?
            LIMIT ${CASCADE_BATCH})`,
      ).run(...terminal, cutoffIso).changes;
      total += n;
      if (n < CASCADE_BATCH) break;
    } catch { break; } // busy, or the table shape differs on an older DB
  }
  return total;
}

/**
 * WITHOUT THESE, DELETING A scan_run IS A FULL TABLE SCAN. Four times.
 *
 * With foreign_keys=ON, SQLite enforces each ON DELETE CASCADE by looking up the
 * child rows for the parent being removed. That lookup needs an index whose
 * LEADING column is the foreign key. These four have indexes, but every one of
 * them leads with tenant_id or job_id:
 *
 *   fiber_job_events     idx(tenant_id, run_id, sequence)      816,782 rows
 *   fiber_job_failures   idx(tenant_id, run_id, created_at)    807,001 rows
 *   fiber_dead_letters   idx(tenant_id, resolved_at, created)  186,017 rows
 *   discovery_job_runs   pk(job_id, run_id) + idx(job_id, seq) 541,738 rows
 *
 * So each parent row deleted scans ~2.35M child rows. A 500-parent batch is
 * 1.2 BILLION row visits. The first rehearsal ran past ten minutes on a 2.85GB
 * copy before being killed - on the 18.8GB production file it would hold the
 * write lock for hours.
 *
 * Built HERE rather than in storage.ts's boot index list on purpose: that list
 * is executed by all four processes during the deploy health gate, and building
 * an index over 800k rows there is exactly the kind of blocking work that times
 * the gate out. The prune already runs in a non-serving role, once, off the
 * request path. IF NOT EXISTS makes it a no-op on every subsequent run.
 *
 * scan_runs' OTHER children are already covered: fiber_job_checkpoints is keyed
 * `run_id TEXT PRIMARY KEY`, and scan_run_targets has idx_srt_run_state(run_id,
 * state, seq). The discovery_jobs side needs nothing - every one of its children
 * indexes job_id first.
 */
export function ensureCascadeIndexes(): void {
  for (const ddl of [
    `CREATE INDEX IF NOT EXISTS idx_fiber_events_run_fk ON fiber_job_events(run_id)`,
    `CREATE INDEX IF NOT EXISTS idx_fiber_failures_run_fk ON fiber_job_failures(run_id)`,
    `CREATE INDEX IF NOT EXISTS idx_fiber_dead_letters_run_fk ON fiber_dead_letters(run_id)`,
    `CREATE INDEX IF NOT EXISTS idx_discovery_job_runs_run_fk ON discovery_job_runs(run_id)`,
  ]) {
    try { rawDb.exec(ddl); } catch { /* older DB without the table — nothing to index */ }
  }
}

export function pruneTerminalScanRuns(cutoffIso: string): number {
  // Non-negotiable: without the FK indexes each cascade is four full scans.
  ensureCascadeIndexes();
  // COALESCE(completed_at, started_at): a run that errored without ever being
  // stamped complete must still age out, or it is immortal.
  return pruneCascadeParent(
    "scan_runs", "id", "status", ["done", "error", "cancelled"],
    "COALESCE(completed_at, started_at)", cutoffIso);
}

export function pruneTerminalDiscoveryJobs(cutoffIso: string): number {
  return pruneCascadeParent(
    "discovery_jobs", "id", "status", ["completed", "failed", "cancelled"],
    "COALESCE(completed_at, updated_at, created_at)", cutoffIso);
}

export function pruneStaleHeartbeats(cutoffIso: string): number {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_TABLE; i++) {
    try {
      const n = rawDb.prepare(
        `DELETE FROM fiber_worker_heartbeats WHERE rowid IN (
           SELECT rowid FROM fiber_worker_heartbeats WHERE heartbeat_at < ? LIMIT ${BATCH})`,
      ).run(cutoffIso).changes;
      total += n;
      if (n < BATCH) break;
    } catch { break; }
  }
  return total;
}

/**
 * Has a prune completed recently enough?
 *
 * The scheduler used to be a single 30-minute setTimeout, and in production it
 * simply never fired: registered at 08:44:46, still nothing 38 uninterrupted
 * minutes later, with neither a success nor a failure line. The control worker
 * runs the producer/scorer loop, which the boot file itself documents as
 * "blocks 20-25s during every scoring cycle" — a long one-shot timer on a
 * saturated event loop is a promise nobody keeps.
 *
 * A DUE CHECK is robust to that, and to the two other things that were
 * indistinguishable from it: a deploy restarting the container before the timer
 * matured (six deploys in one day is enough to starve a 30-minute timer
 * forever), and a log line rotating out of a buffer a chatty scanner is filling.
 * Ask the database when the last prune finished; if it was long enough ago, run.
 */
export function isPruneDue(minHoursSince = 20): boolean {
  try {
    const row = rawDb.prepare(
      `SELECT ran_at FROM db_prune_runs ORDER BY id DESC LIMIT 1`,
    ).get() as { ran_at: string } | undefined;
    if (!row?.ran_at) return true; // never run
    const last = Date.parse(row.ran_at.includes("T") ? row.ran_at : row.ran_at.replace(" ", "T") + "Z");
    if (!Number.isFinite(last)) return true;
    return Date.now() - last >= minHoursSince * 3_600_000;
  } catch {
    return true; // no table yet — never pruned
  }
}


/**
 * Precise rep locations, aged out per tenant.
 *
 * Unlike every other table here, the window is not one global constant: an org
 * sets its own retention and the system caps it. So this prunes tenant by
 * tenant rather than with a single cutoff, and sweeps orphaned rows (no tenant,
 * from before location_pings had the column) on the tightest window of all.
 *
 * This is a HARD delete, not an anonymisation. A movement trail with the name
 * stripped off is still a movement trail - the route itself identifies the
 * person who walked it.
 */
export function pruneLocationPings(now = Date.now()): number {
  let total = 0;
  const cutoffFor = (days: number) =>
    Math.floor((now - Math.min(days, LOCATION_PINGS_MAX_KEEP_DAYS) * 86_400_000) / 1000);

  try {
    const tenants = rawDb.prepare(
      `SELECT DISTINCT tenant_id AS tenantId FROM location_pings WHERE tenant_id IS NOT NULL`,
    ).all() as any[];

    for (const { tenantId } of tenants) {
      let days = LOCATION_PINGS_MAX_KEEP_DAYS;
      try {
        const row = rawDb.prepare(
          `SELECT retention_days AS d FROM field_location_policy WHERE tenant_id = ?`,
        ).get(tenantId) as any;
        if (row?.d != null) days = Math.max(1, Number(row.d));
      } catch { /* no policy row - the ceiling applies */ }

      const cutoff = cutoffFor(days);
      for (let i = 0; i < MAX_BATCHES_PER_TABLE; i++) {
        try {
          const n = rawDb.prepare(
            `DELETE FROM location_pings WHERE rowid IN (
               SELECT rowid FROM location_pings
                WHERE tenant_id = ?
                  AND CAST(strftime('%s', COALESCE(captured_at, ping_at)) AS INTEGER) < ?
                LIMIT ${BATCH})`,
          ).run(tenantId, cutoff).changes;
          total += n;
          if (n < BATCH) break;
        } catch { break; } // busy — next night
      }
    }

    // Rows written before the tenant column existed. Nobody's policy covers
    // them, so they get the tightest window rather than an indefinite stay.
    total += pruneBatched(
      "location_pings",
      "CASE WHEN tenant_id IS NULL THEN CAST(strftime('%s', COALESCE(captured_at, ping_at)) AS INTEGER) * 1000 ELSE 9e18 END",
      now - LOCATION_PINGS_MAX_KEEP_DAYS * 86_400_000,
    );
  } catch { /* table may not exist yet */ }
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
  try { out.availability_snapshots = pruneSnapshotsKeepingLatestConclusive(now - SNAPSHOTS_KEEP_DAYS * 86_400_000); } catch { /* */ }
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
  try { out.location_pings = pruneLocationPings(now); } catch { /* */ }
  try { rawDb.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* */ }
  try { rawDb.pragma("incremental_vacuum(2000)"); } catch { /* */ }
  recordPruneRun(out);
  structuredLog("db_prune.done", out);
}

// ── Did it actually run? ────────────────────────────────────────────────────
// "Is the nightly prune running" was unanswerable for a month while the
// database grew to 18.8 GB, because the ONLY evidence was a log line — and a
// log line competes with a chatty scanner for a rotating 50 MB buffer, cannot
// be read without shell access to the box, and says nothing at all when the
// scheduler was never reached.
//
// A durable row answers it: last run, what it freed, and from which role. It
// survives rotation, restarts, and redeploys, and the disk report reads it
// without needing logs to still exist.
function recordPruneRun(out: Record<string, number>): void {
  try {
    rawDb.exec(`CREATE TABLE IF NOT EXISTS db_prune_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at TEXT NOT NULL DEFAULT (datetime('now')),
      role TEXT,
      removed_json TEXT,
      total_removed INTEGER NOT NULL DEFAULT 0
    )`);
    const total = Object.values(out).reduce((sum, n) => sum + (Number(n) || 0), 0);
    rawDb.prepare(
      `INSERT INTO db_prune_runs (role, removed_json, total_removed) VALUES (?,?,?)`,
    ).run(process.env.HF_ROLE ?? "single", JSON.stringify(out), total);
    // Keep this table from becoming its own problem.
    rawDb.prepare(`DELETE FROM db_prune_runs WHERE id NOT IN
      (SELECT id FROM db_prune_runs ORDER BY id DESC LIMIT 60)`).run();
  } catch { /* never let bookkeeping break the prune */ }
}
