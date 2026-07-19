import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@shared/schema";
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
