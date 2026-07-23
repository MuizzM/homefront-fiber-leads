import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@shared/schema";
import fs from "fs";
import path from "path";
import { resolveScanWorkerCount } from "./scanWorkers";

// DATA_DIR lets the SQLite file live on a persistent volume (set DATA_DIR=/data
// on the host and mount your volume there). Defaults to the working directory.
const dataDir = process.env.DATA_DIR || process.cwd();
const dbPath = path.join(dataDir, "data.db");
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
// Enforce the durable discovery/qualification graph in local SQLite just as
// PostgreSQL does in production. WAL + a busy timeout lets background workers
// checkpoint while field/API reads continue without spurious SQLITE_BUSY.
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("synchronous = NORMAL");
// Longer busy timeout: under heavy scanning a writer transaction can hold the
// lock for a moment; 15s lets readers wait rather than throw SQLITE_BUSY.
sqlite.pragma(`busy_timeout = ${Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? 15000) || 15000}`);
// HARD WAL FILE CAP. With ~4 worker processes always holding a read mark, a
// PASSIVE (or even TRUNCATE) checkpoint can never advance past the pinned tail,
// so the WAL file appended without bound and grew to 8GB — filling the 38GB box
// and blocking the pre-deploy backup (2026-07-23). journal_size_limit truncates
// the WAL file back to this cap after every checkpoint (reclaiming the already-
// checkpointed prefix even when the tail is pinned), so the file can't run the
// disk out. Default 1GB; tune with SQLITE_WAL_LIMIT_BYTES.
sqlite.pragma(`journal_size_limit = ${Math.max(64 * 1024 * 1024, Number(process.env.SQLITE_WAL_LIMIT_BYTES ?? 1_073_741_824) || 1_073_741_824)}`);
// DEDICATED-CHECKPOINTER architecture (SQLite's recommendation for busy
// systems). First live guard firing (2026-07-23 14:58) showed WHY: with 24
// concurrent writers each auto-checkpointing every 4000 pages, some worker
// holds the checkpoint lock in a reader-starved PASSIVE attempt almost
// continuously, so the primary guard's TRUNCATE returned busy:1 while the WAL
// kept growing. CLUSTER WORKERS (HF_ROLE is set only by the cluster fork)
// therefore back off to a ~1GB BACKSTOP — they stop fighting the guard for
// the checkpoint lock, yet still bound the WAL if the primary ever dies.
// The primary guard (startWalGuard below) is the one routine checkpointer.
// Single-process/one-shot/test connections keep the 4000-page default.
const isClusterWorkerConn = Boolean(process.env.HF_ROLE);
const workerBackstopPages = Math.max(50_000, Number(process.env.SQLITE_WAL_AUTOCHECKPOINT_WORKER ?? 250_000) || 250_000);
const autoCheckpointPages = isClusterWorkerConn
  ? workerBackstopPages
  : Math.max(1000, Number(process.env.SQLITE_WAL_AUTOCHECKPOINT ?? 4000) || 4000);
sqlite.pragma(`wal_autocheckpoint = ${autoCheckpointPages}`);

// ── Use the box's RAM: keep the whole DB hot in memory ───────────────────────
// The single biggest scanner-throughput lever on this workload. Node runs the
// app on ONE thread and better-sqlite3 is synchronous, so every scan transaction
// that touches DISK stalls that one thread — the root cause of the event-loop
// wedges that took the portal down. The DB is ~1.6GB and the box has 8GB, so we
// cache it entirely in RAM: transactions then complete in microseconds and the
// thread stays free to serve /api and dispatch more scans. All sizes are env-
// tunable so they can be trimmed on a smaller box without a redeploy.
//   cache_size (negative = KiB of page cache) — 1GB SQLite page cache.
//   mmap_size — memory-map up to 4GB of the file (reads via the OS page cache,
//     no syscall per page).
//   temp_store=MEMORY — sorts/temp b-trees (big GROUP BY / ORDER BY) stay in RAM.
try {
  // Multi-core (SCAN_WORKERS>0): every worker opens its OWN connection with its own
  // private page cache, so an un-divided 1GB cache_size would be multiplied by the
  // worker count and could OOM the box. Divide the private cache across workers. This
  // costs almost nothing: mmap_size below maps the whole DB through the OS page cache,
  // which is SHARED across every process (same file → same physical pages), so the DB
  // stays fully hot in RAM once regardless of the per-connection cache. cache_size is
  // only an extra private cache on top.
  // Shared SCAN_WORKERS parser (scanWorkers.ts) — a drifted copy here would
  // silently give every worker the FULL cache budget.
  const workers = Math.max(1, resolveScanWorkerCount());
  const baseCacheKb = Math.max(2000, Number(process.env.SQLITE_CACHE_KB ?? 1_048_576) || 1_048_576); // ~1GB total budget
  const cacheKb = Math.max(65_536, Math.floor(baseCacheKb / workers)); // ≥64MB per connection
  sqlite.pragma(`cache_size = -${cacheKb}`);
  // mmap is virtual + OS-page-cache-shared, so mapping 4GB per connection is NOT 4GB
  // physical per worker — the pages are shared. Keep it full so the whole DB is hot.
  const mmapBytes = Math.max(0, Number(process.env.SQLITE_MMAP_BYTES ?? 4_294_967_296) || 4_294_967_296); // 4GB
  sqlite.pragma(`mmap_size = ${mmapBytes}`);
  sqlite.pragma("temp_store = MEMORY");
} catch (e: any) {
  console.warn("[db] RAM pragma tuning skipped:", e?.message);
}

export const db = drizzle(sqlite, { schema });
export const rawDb = sqlite; // Raw better-sqlite3 instance for prepared statements

// ── WAL guard: FILE-SIZE-based forced checkpoint ─────────────────────────────
// 2026-07-23 disk-full incident: the previous guard sized the WAL from the
// `log` column of `PRAGMA wal_checkpoint(PASSIVE)` — but under checkpoint-lock
// contention that pragma reports busy=1/log=-1, so the guard computed a
// NEGATIVE size and never escalated while the file grew to 12GB and filled the
// 38GB box. Past ~95% disk the death spiral locks in: a checkpoint must grow
// data.db, there is no disk, so every checkpoint fails and the WAL can only
// grow. This guard measures the -wal file with fs.stat (ground truth, immune
// to pragma result quirks), forces TRUNCATE past the threshold, and logs every
// action AND every error — a silent catch is how the last failure hid.
//
// Placement matters: wal_checkpoint is synchronous and can block up to
// busy_timeout waiting for readers to drain. Run the guard in the CLUSTER
// PRIMARY (its event loop is a near-idle supervisor — blocking it stalls no
// HTTP or scan work) or in the single process when SCAN_WORKERS=0.
const walPath = `${dbPath}-wal`;

function walFileMb(): number {
  try {
    return Math.round(fs.statSync(walPath).size / 1_048_576);
  } catch {
    return 0; // no WAL file → nothing to reclaim
  }
}

function walLog(event: string, fields: Record<string, unknown>): void {
  const level = event.endsWith("_error") ? "error" : "info";
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
}

// One blocking TRUNCATE attempt with before/after evidence. Returns the MB
// still in the WAL afterwards. Never throws. The wait is bounded to 30s (not
// the connection's full busy_timeout, 120s in prod): the guard retries every
// tick anyway, and the cluster primary must stay responsive to worker exits.
export function forceWalTruncate(reason: string): number {
  const beforeMb = walFileMb();
  const prevTimeout = Number(sqlite.pragma("busy_timeout", { simple: true }) ?? 0) || 15000;
  try {
    sqlite.pragma(`busy_timeout = ${Math.min(prevTimeout, 30000)}`);
    const res = sqlite.pragma("wal_checkpoint(TRUNCATE)");
    const afterMb = walFileMb();
    walLog("db.wal_guard", { reason, beforeMb, afterMb, result: JSON.stringify(res) });
    return afterMb;
  } catch (e: any) {
    walLog("db.wal_guard_error", { reason, beforeMb, error: e?.message ?? String(e) });
    return beforeMb;
  } finally {
    try { sqlite.pragma(`busy_timeout = ${prevTimeout}`); } catch { /* connection closed */ }
  }
}

// When Litestream is enabled it OWNS checkpointing: it holds a long-lived read
// lock specifically so no other connection can checkpoint/reset the WAL out
// from under its replication position, and it runs its own checkpoints. Our
// guard must stand down or it would just spin busy against that lock.
const litestreamOwnsCheckpoints = Boolean(process.env.LITESTREAM_BUCKET);

// Boot-time reclaim. Call where there is NO connection contention yet (cluster
// primary before forking workers; single-process before listen): with no other
// readers the TRUNCATE always wins and the WAL starts at 0 bytes.
export function bootWalCheckpoint(): void {
  if (litestreamOwnsCheckpoints) {
    walLog("db.wal_guard", { reason: "boot", skipped: "litestream owns checkpointing" });
    return;
  }
  if (walFileMb() < 16) return; // nothing worth logging
  forceWalTruncate("boot");
}

// Periodic guard. Small WALs are left to wal_autocheckpoint+journal_size_limit;
// past the threshold we force TRUNCATE every tick until the file shrinks.
export function startWalGuard(): NodeJS.Timeout | null {
  if (process.env.WAL_GUARD === "off") return null;
  if (litestreamOwnsCheckpoints) {
    walLog("db.wal_guard", { reason: "start", skipped: "litestream owns checkpointing" });
    return null;
  }
  const intervalMs = Math.max(30_000, Number(process.env.WAL_CHECKPOINT_MS ?? 120_000) || 120_000);
  const truncateMb = Math.max(64, Number(process.env.WAL_TRUNCATE_MB ?? 512) || 512);
  const timer = setInterval(() => {
    if (walFileMb() <= truncateMb) return;
    forceWalTruncate("interval");
  }, intervalMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  return timer;
}

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL,
    city TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'NC',
    zip TEXT NOT NULL,
    lat REAL,
    lng REAL,
    fiber_status TEXT NOT NULL DEFAULT 'unknown',
    household_segment_type TEXT,
    is_new_fiber INTEGER DEFAULT 0,
    is_tenured INTEGER DEFAULT 0,
    speed_tier TEXT,
    max_download_mbps INTEGER,
    tech_type TEXT,
    chip_set_type TEXT,
    placement TEXT,
    max_qual TEXT,
    competitor_name TEXT,
    competitor_speed_mbps INTEGER,
    competitor_tech TEXT,
    in_competitor_area INTEGER DEFAULT 0,
    df_address_id TEXT,
    access_id TEXT,
    exchange_id TEXT,
    address_catalog_date TEXT,
    contact_name TEXT,
    contact_phone TEXT,
    contact_email TEXT,
    lead_status TEXT NOT NULL DEFAULT 'prospect',
    notes TEXT,
    deployment_notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS fiber_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL,
    lat REAL,
    lng REAL,
    result TEXT NOT NULL,
    fiber_available INTEGER DEFAULT 0,
    is_new_fiber INTEGER DEFAULT 0,
    is_tenured INTEGER DEFAULT 0,
    household_segment_type TEXT,
    tech_type TEXT,
    speed_tier TEXT,
    max_download INTEGER,
    competitor_name TEXT,
    address_catalog_date TEXT,
    api_source TEXT,
    checked_at TEXT NOT NULL
  );
`);
