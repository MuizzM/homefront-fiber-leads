import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@shared/schema";
import path from "path";

// DATA_DIR lets the SQLite file live on a persistent volume (set DATA_DIR=/data
// on the host and mount your volume there). Defaults to the working directory.
const dataDir = process.env.DATA_DIR || process.cwd();
const dbPath = path.join(dataDir, "data.db");
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");

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
