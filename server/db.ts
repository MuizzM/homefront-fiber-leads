import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@shared/schema";
import path from "path";
import { resolveScanWorkerCount } from "./scanWorkers";
import {
  bootWalCheckpointOn,
  forceWalTruncateOn,
  startWalGuardOn,
} from "./walGuard";
import { installSlowStatementLog, slowSqlThresholdMs } from "./slowStatements";

// DATA_DIR lets the SQLite file live on a persistent volume (set DATA_DIR=/data
// on the host and mount your volume there). Defaults to the working directory.
const dataDir = process.env.DATA_DIR || process.cwd();
export const dbPath = path.join(dataDir, "data.db");
const sqlite = new Database(dbPath);
// Name the statements that stall the loop. Wraps the better-sqlite3 prototypes
// once per process, so every handle opened after this (drizzle, maintenance,
// the perf pragmas in routes.ts) is covered. Off outside production unless
// SLOW_SQL_MS is set; see server/slowStatements.ts.
{
  const thresholdMs = slowSqlThresholdMs();
  if (thresholdMs != null) installSlowStatementLog(sqlite, { thresholdMs, where: walGuardWhere() });
}
sqlite.pragma("journal_mode = WAL");
// Enforce the durable discovery/qualification graph in SQLite in every environment.
// WAL allows concurrent readers; writes still serialize on one writer. Interactive
// operations override the native busy wait and retry asynchronously (interactiveDb).
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
export const walPath = `${dbPath}-wal`;

// The guard's mechanics live in walGuard.ts, parameterised by connection, so a
// process that serves NO HTTP can run them against its own handle. These three
// wrappers keep db.ts's original API for the callers that legitimately run the
// guard in-process: the cluster PRIMARY (a near-idle supervisor) and the
// resource-pressure sentinel's emergency reclaim.
//
// A single-process deployment must NOT call startWalGuard() directly - see
// walMaintenance.ts. The checkpoint blocks for up to MAX_CHECKPOINT_WAIT_MS and
// that process is the web server.
export function forceWalTruncate(reason: string): number {
  return forceWalTruncateOn(sqlite, walPath, reason, walGuardWhere());
}

export function bootWalCheckpoint(): void {
  bootWalCheckpointOn(sqlite, walPath, walGuardWhere());
}

export function startWalGuard(): NodeJS.Timeout | null {
  return startWalGuardOn(sqlite, walPath, { where: walGuardWhere() });
}

/** Attribution for every guard log line: which process actually blocked. */
function walGuardWhere(): string {
  if (process.env.HF_ROLE) return `worker:${process.env.HF_ROLE}`;
  return resolveScanWorkerCount() > 0 ? "cluster-primary" : "in-process";
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
