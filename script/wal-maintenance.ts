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
// DELIBERATELY MINIMAL. It does NOT import server/db.ts: that module bootstraps
// the whole schema, builds the drizzle client and claims a ~1GB page cache, none
// of which a checkpointer needs, all of which costs RAM on an 8GB box. The only
// contract it shares with the app is the file path and the guard mechanics.
//
// Bundled to dist/wal-maintenance.cjs by script/build.ts, the same way
// reset-areas and import-fcc-pins are, so it can run inside the production image
// where script/ never ships and tsx is a devDependency.
import Database from "better-sqlite3";
import path from "node:path";
import {
  bootWalCheckpointOn,
  litestreamOwnsCheckpoints,
  startWalGuardOn,
  walFileMb,
  walGuardConfig,
  walLog,
} from "../server/walGuard";

const WHERE = "wal-maintenance";

function main(): void {
  if (process.env.WAL_GUARD === "off") {
    walLog("db.wal_maintenance_exit", { where: WHERE, reason: "WAL_GUARD=off" });
    return; // nothing to do; the supervisor treats a clean exit as intentional
  }
  if (litestreamOwnsCheckpoints()) {
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
    walMb: walFileMb(walPath), intervalMs, truncateMb,
  });

  // One reclaim on the way in: the app's own bootWalCheckpoint runs before it
  // listens, but this process may be (re)started long after that.
  bootWalCheckpointOn(conn, walPath, WHERE);
  // unref:false - this timer is the only thing keeping the process alive.
  startWalGuardOn(conn, walPath, { where: WHERE, unref: false });

  const shutdown = (signal: string) => {
    walLog("db.wal_maintenance_stopping", { where: WHERE, signal });
    try { conn.close(); } catch { /* already gone */ }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
