// ── WAL guard core, connection-agnostic ──────────────────────────────────────
// The checkpoint logic used to live inside db.ts, bound to that module's single
// app connection. It is lifted here unchanged in behaviour so that a process
// which is NOT serving HTTP can run it against its own connection.
//
// WHY THAT MATTERS (2026-08-10 incident): `PRAGMA wal_checkpoint(TRUNCATE)` is
// synchronous in better-sqlite3 and waits up to busy_timeout for readers to
// drain. db.ts documented that the guard is safe "in the CLUSTER PRIMARY ... or
// in the single process when SCAN_WORKERS=0". The first half is true - the
// primary serves nothing. The second half is false: with SCAN_WORKERS=0 there is
// no primary, and that single process IS the web server. Production ran the
// guard on the request loop and blocked it for up to 26s every 120s; every
// request in flight was dropped by Caddy and surfaced in the browser as
// "Load failed". See docs/architecture/BULK_ASSIGNMENT.md.
//
// Nothing here decides WHERE the guard runs - that is walMaintenance.ts. This
// module only knows how to measure a WAL and checkpoint one connection.
import fs from "fs";

/** Any connection we can checkpoint through. Kept structural so both the app's
 *  better-sqlite3 handle and the maintenance process's own handle satisfy it
 *  without importing db.ts (which would drag the whole schema into a process
 *  that only needs to run one pragma). */
export interface CheckpointableDb {
  pragma(source: string, options?: { simple?: boolean }): unknown;
}

/** Hard ceiling on how long ONE checkpoint attempt may wait for readers. The
 *  connection's own busy_timeout is 120s in production; the guard retries every
 *  tick anyway, so waiting that long buys nothing and costs availability
 *  wherever the guard happens to be running. */
export const MAX_CHECKPOINT_WAIT_MS = 30_000;

/** Below this the WAL is not worth a blocking boot-time reclaim. */
const BOOT_RECLAIM_FLOOR_MB = 16;

export function walFileMb(walPath: string): number {
  try {
    return Math.round(fs.statSync(walPath).size / 1_048_576);
  } catch {
    return 0; // no WAL file -> nothing to reclaim
  }
}

export function walLog(event: string, fields: Record<string, unknown>): void {
  const level = event.endsWith("_error") ? "error" : "info";
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
}

/** When Litestream is enabled it OWNS checkpointing: it holds a long-lived read
 *  lock specifically so no other connection can checkpoint/reset the WAL out
 *  from under its replication position, and it runs its own checkpoints. Our
 *  guard must stand down or it would just spin busy against that lock. */
export function litestreamOwnsCheckpoints(): boolean {
  return Boolean(process.env.LITESTREAM_BUCKET);
}

/** Resolved guard tuning. Read at call time, never cached at import: the tests
 *  and the maintenance child both set these via env after module load. */
export function walGuardConfig(): { intervalMs: number; truncateMb: number } {
  return {
    intervalMs: Math.max(30_000, Number(process.env.WAL_CHECKPOINT_MS ?? 120_000) || 120_000),
    truncateMb: Math.max(64, Number(process.env.WAL_TRUNCATE_MB ?? 512) || 512),
  };
}

/**
 * One blocking TRUNCATE attempt with before/after evidence. Returns the MB still
 * in the WAL afterwards. Never throws.
 *
 * The `beforeMb`/`afterMb` pair in the `db.wal_guard` log line is the fastest
 * way to tell a SLOW checkpoint from a STARVED one: a guard that fires every
 * tick and never shrinks the file is being held off by a pinned read mark, not
 * doing useful work slowly.
 */
export function forceWalTruncateOn(
  conn: CheckpointableDb,
  walPath: string,
  reason: string,
  where: string,
): number {
  const beforeMb = walFileMb(walPath);
  const prevTimeout = Number(conn.pragma("busy_timeout", { simple: true }) ?? 0) || 15000;
  const started = Date.now();
  try {
    conn.pragma(`busy_timeout = ${Math.min(prevTimeout, MAX_CHECKPOINT_WAIT_MS)}`);
    const res = conn.pragma("wal_checkpoint(TRUNCATE)");
    const afterMb = walFileMb(walPath);
    walLog("db.wal_guard", {
      reason, where, beforeMb, afterMb,
      blockedMs: Date.now() - started,
      result: JSON.stringify(res),
    });
    return afterMb;
  } catch (e: any) {
    walLog("db.wal_guard_error", {
      reason, where, beforeMb,
      blockedMs: Date.now() - started,
      error: e?.message ?? String(e),
    });
    return beforeMb;
  } finally {
    try { conn.pragma(`busy_timeout = ${prevTimeout}`); } catch { /* connection closed */ }
  }
}

/** Boot-time reclaim. Call where there is NO connection contention yet (cluster
 *  primary before forking workers; single-process before listen): with no other
 *  readers the TRUNCATE always wins and the WAL starts at 0 bytes. */
export function bootWalCheckpointOn(conn: CheckpointableDb, walPath: string, where: string): void {
  if (litestreamOwnsCheckpoints()) {
    walLog("db.wal_guard", { reason: "boot", where, skipped: "litestream owns checkpointing" });
    return;
  }
  if (walFileMb(walPath) < BOOT_RECLAIM_FLOOR_MB) return; // nothing worth logging
  forceWalTruncateOn(conn, walPath, "boot", where);
}

export interface StartWalGuardOptions {
  /** Names the process in every log line, so a stall can be attributed. */
  where: string;
  /** Leave the timer REFERENCED when it is the only thing keeping a dedicated
   *  maintenance process alive. The in-process guard unrefs so it can never
   *  hold the web server open during shutdown. */
  unref?: boolean;
}

/** Periodic guard. Small WALs are left to wal_autocheckpoint+journal_size_limit;
 *  past the threshold we force TRUNCATE every tick until the file shrinks. */
export function startWalGuardOn(
  conn: CheckpointableDb,
  walPath: string,
  opts: StartWalGuardOptions,
): NodeJS.Timeout | null {
  if (process.env.WAL_GUARD === "off") return null;
  if (litestreamOwnsCheckpoints()) {
    walLog("db.wal_guard", { reason: "start", where: opts.where, skipped: "litestream owns checkpointing" });
    return null;
  }
  const { intervalMs, truncateMb } = walGuardConfig();
  const timer = setInterval(() => {
    if (walFileMb(walPath) <= truncateMb) return;
    forceWalTruncateOn(conn, walPath, "interval", opts.where);
  }, intervalMs);
  if (opts.unref !== false && typeof (timer as any).unref === "function") (timer as any).unref();
  return timer;
}
