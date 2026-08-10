// ── WAL maintenance process ───────────────────────────────────────────────────
// A process whose entire job is to block. It opens its own SQLite connection and
// runs the file-size-based WAL guard; when `PRAGMA wal_checkpoint(TRUNCATE)`
// sits for 30 seconds waiting for readers to drain, it stalls nothing anybody is
// waiting on.
//
// This exists because the same loop, run inside the web server, took production
// down in a way nobody could see: /api/health blocked for up to 26s every 120s,
// Caddy dropped every request in flight, and the browser reported the dead
// connection as "Load failed". See docs/architecture/BULK_ASSIGNMENT.md.
//
// The WAL guard is its FIRST duty, not its only one. Anything that blocks for
// longer than a request budget belongs here rather than in the web server, and
// yield-rollup maintenance qualifies twice over: a hard 5s synchronous budget
// per 30s tick, plus one blocking CREATE INDEX per tick and a full ANALYZE
// against an 18.8GB database. It is started here when HF_MAINTENANCE_ROLLUPS=1.
//
// The checkpoint path itself stays free of server/db.ts, which bootstraps the
// whole schema, builds the drizzle client and claims a page cache none of it
// needs. Rollups genuinely need that module graph, so it is imported LAZILY -
// a box running with rollups off pays nothing for it. Cache is trimmed via
// SQLITE_CACHE_KB below so the second connection cannot double the app's budget
// on an 8GB box.
//
// Bundled to dist/wal-maintenance.cjs by script/build.ts, the same way
// reset-areas and import-fcc-pins are, so it can run inside the production image
// where script/ never ships and tsx is a devDependency.
import Database from "better-sqlite3";
import path from "node:path";
import {
  bootWalCheckpointOn,
  forceWalTruncateOn,
  litestreamOwnsCheckpoints,
  startWalGuardOn,
  walFileMb,
  walGuardConfig,
  walLog,
} from "../server/walGuard";

const WHERE = "wal-maintenance";

/**
 * Blocking maintenance the web server must not run.
 *
 * Imported lazily and only when asked for: this drags in server/db.ts and the
 * storage layer, and a deployment with rollups off should not pay for that.
 * Every cursor and readiness flag it keeps lives in SQLite, so moving it out of
 * the server process is invisible to the scorer that reads them.
 */
function startDelegatedMaintenance(): boolean {
  if (process.env.HF_MAINTENANCE_ROLLUPS !== "1") return false;
  if (process.env.YIELD_ROLLUPS === "off") {
    walLog("db.wal_maintenance_rollups", { where: WHERE, skipped: "YIELD_ROLLUPS=off" });
    return false;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { startYieldRollupMaintenance } =
      require("../server/yieldRollups") as typeof import("../server/yieldRollups");
    const timer = startYieldRollupMaintenance();
    // startYieldRollupMaintenance unrefs its timer so it can never hold the web
    // server open. Here it is load-bearing: re-ref it or the process exits.
    if (timer && typeof (timer as any).ref === "function") (timer as any).ref();
    walLog("db.wal_maintenance_rollups", { where: WHERE, started: Boolean(timer) });
    return Boolean(timer);
  } catch (e: any) {
    // Never take the checkpointer down with it - the WAL guard is the more
    // urgent duty and must keep running.
    walLog("db.wal_maintenance_rollups_error", { where: WHERE, error: e?.message ?? String(e) });
    return false;
  }
}

function main(): void {
  const wantsRollups = process.env.HF_MAINTENANCE_ROLLUPS === "1" && process.env.YIELD_ROLLUPS !== "off";
  // The kill switches below silence the CHECKPOINTER. Exiting on them while
  // rollups are wanted would hand yield maintenance back to the web server,
  // which is the stall this process exists to prevent.
  if (process.env.WAL_GUARD === "off" && !wantsRollups) {
    walLog("db.wal_maintenance_exit", { where: WHERE, reason: "WAL_GUARD=off" });
    return; // nothing to do; the supervisor treats a clean exit as intentional
  }
  if (litestreamOwnsCheckpoints() && !wantsRollups) {
    walLog("db.wal_maintenance_exit", { where: WHERE, reason: "litestream owns checkpointing" });
    return;
  }

  const dataDir = process.env.DATA_DIR || process.cwd();
  const dbPath = path.join(dataDir, "data.db");
  const walPath = `${dbPath}-wal`;

  // Its own handle. Never sets journal_mode (the database is already WAL and a
  // maintenance process must not be the one deciding that) and runs no DDL.
  const conn = new Database(dbPath);
  // Wait for the write lock rather than throwing SQLITE_BUSY - blocking here is
  // free, which is the whole point of this process existing.
  conn.pragma(`busy_timeout = ${Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? 15000) || 15000}`);
  // Same file cap the app applies, so a checkpoint here truncates to the same
  // ceiling rather than leaving a file the app would immediately re-truncate.
  conn.pragma(`journal_size_limit = ${Math.max(64 * 1024 * 1024, Number(process.env.SQLITE_WAL_LIMIT_BYTES ?? 1_073_741_824) || 1_073_741_824)}`);
  // A checkpointer streams pages; it has no working set worth caching. 8MB
  // instead of inheriting the app's ~1GB budget.
  conn.pragma("cache_size = -8192");
  // This connection must never auto-checkpoint on its own writes (it makes
  // none) and must never fight the explicit guard below for the lock.
  conn.pragma("wal_autocheckpoint = 0");

  const { intervalMs, truncateMb } = walGuardConfig();
  walLog("db.wal_maintenance_started", {
    where: WHERE, pid: process.pid, dbPath,
    walMb: walFileMb(walPath), intervalMs, truncateMb, rollups: wantsRollups,
  });

  const checkpointing = process.env.WAL_GUARD !== "off" && !litestreamOwnsCheckpoints();
  if (checkpointing) {
    // One reclaim on the way in: the app's own bootWalCheckpoint runs before it
    // listens, but this process may be (re)started long after that.
    bootWalCheckpointOn(conn, walPath, WHERE);
    // unref:false - with rollups off this timer is the only thing keeping the
    // process alive.
    startWalGuardOn(conn, walPath, { where: WHERE, unref: false });
  }

  // A second connection must not double the app's page-cache budget on an 8GB
  // box. db.ts reads this at import, and the rollup import below is what pulls
  // it in, so it has to be set FIRST.
  if (!process.env.SQLITE_CACHE_KB) process.env.SQLITE_CACHE_KB = "65536"; // 64MB floor
  startDelegatedMaintenance();

  // On-demand reclaim, asked for by the server's resource sentinel when disk or
  // WAL pressure reaches emergency. It arrives here instead of running on the
  // web server's loop, which is the whole point of this process.
  //
  // `busy` matters: emergency ticks every 30s and a checkpoint against a
  // multi-GB WAL can outlast that, so without it the requests would queue and
  // each one would re-block behind the last.
  let busy = false;
  process.on("message", (msg: any) => {
    if (!msg || msg.type !== "checkpoint") return;
    if (busy) {
      walLog("db.wal_maintenance_skipped", { where: WHERE, reason: msg.reason, why: "checkpoint already running" });
      return;
    }
    busy = true;
    try {
      forceWalTruncateOn(conn, walPath, String(msg.reason ?? "requested"), WHERE);
    } finally {
      busy = false;
    }
  });

  const shutdown = (signal: string) => {
    walLog("db.wal_maintenance_stopping", { where: WHERE, signal });
    try { conn.close(); } catch { /* already gone */ }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
