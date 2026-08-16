// ── Commission File plane - schema ───────────────────────────────────────────
//
// Three tables, split the way the order plane split its own and for the same
// reasons (see vendorOrderMigrations.ts):
//
// IMPORT vs LINE
//   `commission_file_imports` / `commission_file_rows` are the FILE: what
//   arrived, row by row, exactly as it arrived, encrypted. `commission_file_lines`
//   is the LINE: one row per (account, document, product, category), holding
//   its current state under the newest-upload-wins rule. The file tables are
//   evidence and never change after an import finishes; the line table is the
//   working set the review queue and the link writer read.
//
// LINE vs LINK
//   A line is what the PROVIDER's ledger says; a row in
//   `vendor_order_commission_links` (owned by vendorOrderMigrations.ts, and
//   until this plane existed written by nobody) is that fact ATTACHED to an
//   order we recognise. The two are separate because attachment is earned:
//   a line whose match is still with a human carries money that must sit
//   detached until somebody says whose it is.
//
// NO EVENT TABLE, deliberately. The order plane's event stream exists because
// a provider restates lifecycle constantly and the transitions ARE the story.
// A commission line's story is simpler - pending, then paid or clawed back -
// and every restatement that told it is retained verbatim in
// `commission_file_rows`, so "what did the file say on 3 August" is answered
// from evidence rather than from a second stream to keep honest.
//
// TENANCY. Every table carries `tenant_id` and no read leaves this plane
// without it in the WHERE clause, same as everywhere else.

import { rawDb } from "./db";
import {
  COMMISSION_CATEGORIES, COMMISSION_LINE_STATUSES, COMMISSION_LINK_STATUSES,
} from "@shared/commissionSource";
import { IMPORT_STATUSES, MATCH_STATUSES } from "./vendorOrderMigrations";

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const CATEGORY_CHECK = list(COMMISSION_CATEGORIES);
const LINE_STATUS_CHECK = list(COMMISSION_LINE_STATUSES);
const LINK_STATUS_CHECK = list(COMMISSION_LINK_STATUSES);
const IMPORT_STATUS_CHECK = list(IMPORT_STATUSES);
const MATCH_STATUS_CHECK = list(MATCH_STATUSES);

/**
 * Statements against tables this plane does not own. Run OUTSIDE the
 * transaction and tolerated one at a time, exactly like the order plane's
 * ADDITIVE list and for the same SQLite reason.
 */
const ADDITIVE: readonly string[] = [
  // The link writer upserts one link per commission line, keyed by the line's
  // natural identity in source_reference. Unique so a restatement (Open in one
  // weekly file, Closed in the next) UPDATES the same link instead of stacking
  // a second amount onto the order's timeline. Partial: the column was free
  // text before this plane existed, and rows without a reference (there are
  // none in production - this plane is the table's first writer - but the
  // guard costs nothing) stay out of the constraint.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_order_commission_links_source
     ON vendor_order_commission_links(tenant_id, source_reference)
     WHERE source_reference IS NOT NULL`,
];

export function runCommissionFileMigrations(): void {
  for (const sql of ADDITIVE) {
    try {
      rawDb.exec(sql);
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      if (!/duplicate column|already exists|no such table/i.test(msg)) {
        console.warn("[migration] commission-file additive:", msg);
      }
    }
  }

  rawDb.exec("BEGIN IMMEDIATE");
  try {
    rawDb.exec(`
      -- ── One import run ───────────────────────────────────────────────────
      -- Same lifecycle vocabulary and same worker contract as
      -- vendor_order_imports: claimed by an atomic UPDATE, counters bumped as
      -- rows land, checksum recorded for the duplicate-file guard at the route.
      CREATE TABLE IF NOT EXISTS commission_file_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        import_mode TEXT NOT NULL DEFAULT 'manual_upload',
        report_period_start TEXT,
        report_period_end TEXT,
        source_file_name TEXT,
        source_file_checksum TEXT,
        source_file_storage_key TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (${IMPORT_STATUS_CHECK})),
        imported_by_user_id INTEGER,
        total_rows INTEGER NOT NULL DEFAULT 0,
        valid_rows INTEGER NOT NULL DEFAULT 0,
        inserted_rows INTEGER NOT NULL DEFAULT 0,
        updated_rows INTEGER NOT NULL DEFAULT 0,
        duplicate_rows INTEGER NOT NULL DEFAULT 0,
        matched_rows INTEGER NOT NULL DEFAULT 0,
        unmatched_rows INTEGER NOT NULL DEFAULT 0,
        links_written INTEGER NOT NULL DEFAULT 0,
        error_rows INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        completed_at TEXT,
        -- SAFE text only, same contract as the order plane: shown to admins,
        -- pasted into tickets, never a row of customer data.
        safe_error_summary TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_commission_file_imports_tenant
        ON commission_file_imports(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_commission_file_imports_status
        ON commission_file_imports(status, created_at);
      -- Duplicate-file lookup. NOT unique, for the reason recorded on
      -- idx_vendor_order_import_checksum: a deliberate re-import is a real
      -- operation and the guard belongs at the route where it can be overruled.
      CREATE INDEX IF NOT EXISTS idx_commission_file_import_checksum
        ON commission_file_imports(tenant_id, provider, source_file_checksum);

      -- ── One row of one import: the evidence ──────────────────────────────
      CREATE TABLE IF NOT EXISTS commission_file_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        commission_file_import_id INTEGER NOT NULL,
        source_row_number INTEGER NOT NULL,
        raw_row_hash TEXT NOT NULL,
        line_key TEXT NOT NULL,
        account_number TEXT,
        document_number TEXT,
        product TEXT,
        category TEXT NOT NULL CHECK(category IN (${CATEGORY_CHECK})),
        line_status TEXT NOT NULL DEFAULT 'unknown' CHECK(line_status IN (${LINE_STATUS_CHECK})),
        pending_amount_cents INTEGER,
        paid_amount_cents INTEGER,
        act_deact_date TEXT,
        upload_date TEXT,
        payment_date TEXT,
        customer_name TEXT,
        sales_agent_name TEXT,
        -- The verbatim source record, AES-256-GCM under the vendor-order key
        -- slots. Null when no key is configured: same refusal to write PII in
        -- the clear, recorded on the import the same way.
        encrypted_raw_payload TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_file_row
        ON commission_file_rows(commission_file_import_id, source_row_number);
      CREATE INDEX IF NOT EXISTS idx_commission_file_rows_line
        ON commission_file_rows(tenant_id, line_key, id DESC);

      -- ── The line: current state per natural identity ─────────────────────
      CREATE TABLE IF NOT EXISTS commission_file_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        line_key TEXT NOT NULL,
        account_number TEXT,
        document_number TEXT,
        account_key TEXT,
        document_key TEXT,
        product TEXT,
        product_key TEXT,
        product_family TEXT,
        category TEXT NOT NULL CHECK(category IN (${CATEGORY_CHECK})),
        line_status TEXT NOT NULL DEFAULT 'unknown' CHECK(line_status IN (${LINE_STATUS_CHECK})),
        program TEXT,
        customer_name TEXT,
        sales_agent_name TEXT,
        comments TEXT,
        first_chargeback INTEGER NOT NULL DEFAULT 0 CHECK(first_chargeback IN (0,1)),
        pending_amount_cents INTEGER,
        paid_amount_cents INTEGER,
        act_deact_date TEXT,
        upload_date TEXT,
        payment_date TEXT,
        -- Matching. Same vocabulary and same discipline as the order plane:
        -- money follows only 'matched' at full confidence, and everything else
        -- waits for a person in the review queue.
        match_status TEXT NOT NULL DEFAULT 'unmatched' CHECK(match_status IN (${MATCH_STATUS_CHECK})),
        match_rule TEXT,
        matched_sale_id INTEGER,
        matched_vendor_order_id INTEGER,
        matched_rep_id INTEGER,
        match_confidence_score REAL,
        exception_reason TEXT,
        -- Candidates for the review screen, frozen at match time so the queue
        -- renders without re-running the matcher. Labels only, never contact
        -- details.
        match_candidates_json TEXT,
        -- The link row this line maintains in vendor_order_commission_links,
        -- once its money has somewhere to land.
        commission_link_id INTEGER,
        link_status TEXT CHECK(link_status IS NULL OR link_status IN (${LINK_STATUS_CHECK})),
        link_amount_cents INTEGER,
        current_row_hash TEXT,
        first_import_id INTEGER,
        last_import_id INTEGER,
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_file_line_key
        ON commission_file_lines(tenant_id, line_key);
      CREATE INDEX IF NOT EXISTS idx_commission_file_lines_account
        ON commission_file_lines(tenant_id, account_key);
      CREATE INDEX IF NOT EXISTS idx_commission_file_lines_match
        ON commission_file_lines(tenant_id, match_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_commission_file_lines_sale
        ON commission_file_lines(tenant_id, matched_sale_id);
      CREATE INDEX IF NOT EXISTS idx_commission_file_lines_order
        ON commission_file_lines(tenant_id, matched_vendor_order_id);
    `);

    rawDb.exec("COMMIT");
  } catch (e) {
    try { rawDb.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}
