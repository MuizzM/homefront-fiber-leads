// ── Provider order status and recovery - schema ──────────────────────────────
//
// Seven concerns, and the split between them is deliberate.
//
// IMPORT vs ORDER
//   `vendor_order_imports` / `vendor_order_import_rows` are the FILE: what
//   arrived, row by row, exactly as it arrived. `vendor_orders` is the ORDER:
//   one row per provider order, holding its current state. The file tables are
//   the evidence and never change after an import finishes; the order table is
//   the working set every screen reads. Collapsing them would mean either
//   losing the ability to answer "what did the report actually say on 3 August"
//   or re-deriving the current state by replaying every file, every read.
//
// STATE vs HISTORY
//   `vendor_orders` holds current state, `vendor_order_events` holds the
//   transitions. A provider restates the same order in every export it sends,
//   so the event stream - not the row - is the audit trail. Events carry an
//   idempotency key so re-importing yesterday's file writes nothing new.
//
// ORDER vs CASE
//   An order needing attention and a person working on it are different facts
//   with different lifetimes. `order_recovery_cases` is assignment, priority
//   and outcome; it survives the order flipping status and is what a rep's
//   queue is built from.
//
// CASE vs OUTREACH
//   `order_recovery_outreach` is one row per message we sent or drafted, with
//   the body we actually rendered and the consent basis we relied on, frozen.
//   Reconstructing that later from a template id would be worthless: templates
//   get edited.
//
// CONSENT vs SUPPRESSION
//   `customer_contact_consents` is what someone AGREED to; suppression is what
//   someone REFUSED. They are not two values of one column because they have
//   different origins, different lifetimes and different authority: a consent
//   record can be superseded by a newer one, a suppression is permanent until
//   an explicit, audited lift. Suppression always wins.
//
// DESTINATIONS ARE HASHED
//   Suppression and consent match on a keyed hash of the normalized phone or
//   email, never on the value. The list has to be able to say "this number is
//   blocked" without being a second copy of the customer database, and a
//   suppression list is the one table an attacker most wants: it is a list of
//   people who are definitely reachable.
//
// TENANCY
//   Every table carries `tenant_id`, which is this repo's organization id. No
//   read in this plane is written without it in the WHERE clause.

import { rawDb } from "./db";
import { ORDER_STATUSES } from "@shared/orderStatusSource";
import {
  RECOVERY_CASE_STATUSES, RECOVERY_PRIORITIES, RECOVERY_REASONS, RESOLUTION_CODES,
} from "@shared/orderRecovery";
import {
  CONSENT_BASES, CONSENT_SOURCES, CONSENT_STATUSES, CONTACT_CHANNELS, SUPPRESSION_REASONS,
} from "@shared/contactConsent";
import { TEMPLATE_KINDS } from "@shared/orderRecoveryTemplates";

/** CHECK bodies generated from the shared unions, so the database and the code
 *  that reads it cannot drift apart. Same device as liveOpsMigrations. */
const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const ORDER_STATUS_CHECK = list(ORDER_STATUSES);
const RECOVERY_REASON_CHECK = list(RECOVERY_REASONS);
const PRIORITY_CHECK = list(RECOVERY_PRIORITIES);
const CASE_STATUS_CHECK = list(RECOVERY_CASE_STATUSES);
const RESOLUTION_CHECK = list(RESOLUTION_CODES);
const CHANNEL_CHECK = list(CONTACT_CHANNELS);
const CONSENT_STATUS_CHECK = list(CONSENT_STATUSES);
const CONSENT_BASIS_CHECK = list(CONSENT_BASES);
const CONSENT_SOURCE_CHECK = list(CONSENT_SOURCES);
const SUPPRESSION_REASON_CHECK = list(SUPPRESSION_REASONS);
const TEMPLATE_KIND_CHECK = list(TEMPLATE_KINDS);

/** Import lifecycle. Not a shared union because nothing outside the server
 *  needs to branch on it, and the client only ever renders the label. */
export const IMPORT_STATUSES = [
  "pending", "validating", "processing", "completed", "completed_with_errors", "failed", "canceled",
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const MATCH_STATUSES = [
  "matched", "matched_low_confidence", "unmatched", "exception", "ignored",
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const OUTREACH_STATUSES = [
  "draft", "queued", "sent", "delivered", "failed", "blocked", "canceled",
] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

/**
 * Additive columns on tables this plane does not own.
 *
 * Run OUTSIDE the transaction and tolerated one at a time: SQLite aborts the
 * whole transaction on a duplicate-column error, so a single already-applied
 * ALTER inside BEGIN IMMEDIATE would roll back every table created alongside
 * it. Same tolerate-per-statement shape runMigrations() uses.
 */
const ADDITIVE: readonly string[] = [
  // The identity a provider order matches an internal sale on. commission_sales
  // has always had `external_id` (our own idempotency key from whatever booked
  // the sale); these are the CARRIER's ids, which are a different namespace and
  // arrive later. Nullable, and null on every existing row - matching degrades
  // to the address rules for those, which is exactly what it should do.
  `ALTER TABLE commission_sales ADD COLUMN external_order_id TEXT`,
  `ALTER TABLE commission_sales ADD COLUMN external_transaction_id TEXT`,
  `ALTER TABLE commission_sales ADD COLUMN customer_account_number TEXT`,
  // Set by an admin when a sale is confirmed fraudulent. Read by the recovery
  // engine as a hard block: a fraudulent order must never generate outreach.
  `ALTER TABLE commission_sales ADD COLUMN fraud_flagged INTEGER NOT NULL DEFAULT 0`,
  // The carrier's own id for a rep, when the org has one. Rule 4 of the matcher
  // needs it; without it that rule simply never fires and matching falls
  // through to the address rules, which is the correct degradation.
  `ALTER TABLE team_members ADD COLUMN external_rep_id TEXT`,
  // Matching reads commission_sales by carrier identity and by sale date. Both
  // indexes live out here rather than in the transaction below because the
  // table belongs to another migration: on a database where it does not exist
  // yet, a failed CREATE INDEX inside BEGIN IMMEDIATE would roll back every
  // table this file creates.
  `CREATE INDEX IF NOT EXISTS idx_commission_sales_external_order ON commission_sales(tenant_id, external_order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_commission_sales_external_txn ON commission_sales(tenant_id, external_transaction_id)`,
  `CREATE INDEX IF NOT EXISTS idx_commission_sales_account ON commission_sales(tenant_id, customer_account_number)`,
  `CREATE INDEX IF NOT EXISTS idx_commission_sales_sold_at ON commission_sales(tenant_id, sold_at)`,
  // Retire the UNIQUE checksum index an earlier revision of this file created.
  // See the note beside idx_vendor_order_import_checksum below: uniqueness at
  // the database made a deliberate re-import impossible.
  `DROP INDEX IF EXISTS uq_vendor_order_import_checksum`,
];

export function runVendorOrderMigrations(): void {
  for (const sql of ADDITIVE) {
    try {
      rawDb.exec(sql);
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      if (!/duplicate column|already exists|no such table/i.test(msg)) {
        console.warn("[migration] vendor-order additive:", msg);
      }
    }
  }

  rawDb.exec("BEGIN IMMEDIATE");
  try {
    rawDb.exec(`
      -- ── Connection: where a provider's report comes from ──────────────────
      -- One row per organization per provider. Credentials are encrypted at
      -- rest and only ever decrypted inside the worker; nothing on this table
      -- reaches a browser except through redactConnection.
      CREATE TABLE IF NOT EXISTS vendor_order_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        label TEXT NOT NULL,
        source_url TEXT,
        mode TEXT NOT NULL DEFAULT 'manual_upload'
          CHECK(mode IN ('manual_upload','scheduled_export','sftp','api')),
        encrypted_credentials TEXT,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        last_test_at TEXT,
        last_test_ok INTEGER,
        last_test_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_order_conn
        ON vendor_order_connections(tenant_id, provider);

      -- ── Saved column mapping, per organization and provider ───────────────
      -- Versioned rather than overwritten: an import records the mapping
      -- version it ran under, so a row imported in July can still be explained
      -- after the mapping changed in September.
      CREATE TABLE IF NOT EXISTS vendor_order_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        mapping_json TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
        created_by_user_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_order_mapping_version
        ON vendor_order_mappings(tenant_id, provider, version);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_order_mapping_active
        ON vendor_order_mappings(tenant_id, provider) WHERE is_active = 1;

      -- ── One import run ───────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS vendor_order_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        source_url TEXT,
        import_mode TEXT NOT NULL DEFAULT 'manual_upload',
        report_period_start TEXT,
        report_period_end TEXT,
        source_file_name TEXT,
        source_file_checksum TEXT,
        source_file_storage_key TEXT,
        mapping_version INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (${list(IMPORT_STATUSES)})),
        imported_by_user_id INTEGER,
        total_rows INTEGER NOT NULL DEFAULT 0,
        valid_rows INTEGER NOT NULL DEFAULT 0,
        inserted_rows INTEGER NOT NULL DEFAULT 0,
        updated_rows INTEGER NOT NULL DEFAULT 0,
        duplicate_rows INTEGER NOT NULL DEFAULT 0,
        matched_rows INTEGER NOT NULL DEFAULT 0,
        unmatched_rows INTEGER NOT NULL DEFAULT 0,
        recovery_candidates INTEGER NOT NULL DEFAULT 0,
        error_rows INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        completed_at TEXT,
        -- SAFE error text only. Never provider HTML, headers, cookies, tokens,
        -- or a customer's details - this string is shown to an admin and is
        -- copied into support tickets.
        safe_error_summary TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_vendor_order_imports_tenant
        ON vendor_order_imports(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_vendor_order_imports_status
        ON vendor_order_imports(status, created_at);
      -- Duplicate-file lookup. Deliberately NOT unique.
      --
      -- Re-importing a file on purpose is a real operation: an admin who has
      -- fixed a mapping re-runs yesterday's export against it, and the pipeline
      -- is built to make that free (an unchanged row is recognised by its hash
      -- and writes no event). A UNIQUE index here turned that intentional path
      -- into a constraint violation surfacing as a 500, which is why the guard
      -- lives at the route instead: POST /api/order-imports answers 409 with
      -- the date of the earlier import unless the caller explicitly overrides.
      -- Accidental duplicates are stopped by a decision somebody can see and
      -- overrule, rather than by a wall that cannot be.
      CREATE INDEX IF NOT EXISTS idx_vendor_order_import_checksum
        ON vendor_order_imports(tenant_id, provider, source_file_checksum);

      -- ── One row of one import ────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS vendor_order_import_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        vendor_order_import_id INTEGER NOT NULL,
        source_row_number INTEGER NOT NULL,
        raw_row_hash TEXT NOT NULL,
        external_order_id TEXT,
        external_transaction_id TEXT,
        customer_account_number TEXT,
        carrier TEXT,
        product_sold TEXT,
        program TEXT,
        rep_external_name TEXT,
        rep_external_id TEXT,
        normalized_service_address TEXT,
        submitted_date TEXT,
        install_scheduled_at TEXT,
        install_date TEXT,
        source_status TEXT,
        normalized_status TEXT NOT NULL DEFAULT 'unknown' CHECK(normalized_status IN (${ORDER_STATUS_CHECK})),
        failure_reason TEXT,
        required_customer_action TEXT,
        match_status TEXT NOT NULL DEFAULT 'unmatched' CHECK(match_status IN (${list(MATCH_STATUSES)})),
        match_rule TEXT,
        matched_sale_id INTEGER,
        matched_lead_id INTEGER,
        matched_rep_id INTEGER,
        match_confidence_score REAL,
        exception_reason TEXT,
        vendor_order_id INTEGER,
        -- The verbatim source record, AES-256-GCM. Null when no encryption key
        -- is configured: this plane refuses to write customer PII in the clear,
        -- so the column is empty and the import records why.
        encrypted_raw_payload TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_order_import_row
        ON vendor_order_import_rows(vendor_order_import_id, source_row_number);
      CREATE INDEX IF NOT EXISTS idx_vendor_order_import_rows_hash
        ON vendor_order_import_rows(tenant_id, raw_row_hash);
      CREATE INDEX IF NOT EXISTS idx_vendor_order_import_rows_match
        ON vendor_order_import_rows(tenant_id, match_status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_vendor_order_import_rows_import
        ON vendor_order_import_rows(vendor_order_import_id, match_status);

      -- ── The order itself: current state, one row per provider order ──────
      CREATE TABLE IF NOT EXISTS vendor_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        external_order_id TEXT,
        external_transaction_id TEXT,
        customer_account_number TEXT,
        -- Normalized identity keys. The raw columns above are for display; the
        -- *_key columns are what the unique indexes and the matcher compare, so
        -- a provider reformatting its own ids between exports cannot create a
        -- second order for the same job.
        external_order_key TEXT,
        external_transaction_key TEXT,
        account_key TEXT,
        sale_id INTEGER,
        lead_id INTEGER,
        rep_id INTEGER,
        customer_name TEXT,
        -- Contact details are stored MASKED plus a keyed hash. The full values
        -- live only inside the encrypted import-row payload, which is what the
        -- messaging path decrypts at send time. A dashboard query can never
        -- leak a phone number it never loaded.
        customer_phone_masked TEXT,
        customer_email_masked TEXT,
        customer_phone_hash TEXT,
        customer_email_hash TEXT,
        service_address TEXT,
        normalized_service_address TEXT,
        carrier TEXT,
        product_sold TEXT,
        program TEXT,
        rep_external_name TEXT,
        rep_external_id TEXT,
        manager_external_name TEXT,
        normalized_status TEXT NOT NULL DEFAULT 'unknown' CHECK(normalized_status IN (${ORDER_STATUS_CHECK})),
        source_status TEXT,
        sale_date TEXT,
        submitted_date TEXT,
        install_scheduled_at TEXT,
        install_date TEXT,
        cancellation_date TEXT,
        failure_reason TEXT,
        required_customer_action TEXT,
        match_status TEXT NOT NULL DEFAULT 'unmatched' CHECK(match_status IN (${list(MATCH_STATUSES)})),
        match_confidence_score REAL,
        last_vendor_updated_at TEXT,
        last_synced_at TEXT NOT NULL DEFAULT (datetime('now')),
        current_source_import_id INTEGER,
        current_row_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- Identity uniqueness, one partial index per key so a report that carries
      -- only some of them still cannot duplicate an order.
      CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_orders_order_key
        ON vendor_orders(tenant_id, provider, external_order_key)
        WHERE external_order_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_orders_txn_key
        ON vendor_orders(tenant_id, provider, external_transaction_key)
        WHERE external_transaction_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_orders_account_key
        ON vendor_orders(tenant_id, provider, account_key)
        WHERE account_key IS NOT NULL AND external_order_key IS NULL AND external_transaction_key IS NULL;
      CREATE INDEX IF NOT EXISTS idx_vendor_orders_status
        ON vendor_orders(tenant_id, normalized_status, submitted_date DESC);
      CREATE INDEX IF NOT EXISTS idx_vendor_orders_rep
        ON vendor_orders(tenant_id, rep_id, normalized_status);
      CREATE INDEX IF NOT EXISTS idx_vendor_orders_sale
        ON vendor_orders(tenant_id, sale_id);
      CREATE INDEX IF NOT EXISTS idx_vendor_orders_address
        ON vendor_orders(tenant_id, normalized_service_address);
      CREATE INDEX IF NOT EXISTS idx_vendor_orders_scheduled
        ON vendor_orders(tenant_id, install_scheduled_at);

      -- ── Transitions ──────────────────────────────────────────────────────
      -- Append-only. The idempotency key is what makes re-importing yesterday's
      -- file a no-op rather than a second copy of every transition.
      CREATE TABLE IF NOT EXISTS vendor_order_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        vendor_order_id INTEGER NOT NULL,
        source_import_id INTEGER,
        source_import_row_id INTEGER,
        event_type TEXT NOT NULL,
        old_status TEXT,
        new_status TEXT NOT NULL,
        source_status TEXT,
        effective_at TEXT NOT NULL,
        failure_reason TEXT,
        required_customer_action TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_order_events_idem
        ON vendor_order_events(tenant_id, idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_vendor_order_events_order
        ON vendor_order_events(vendor_order_id, effective_at DESC, id DESC);

      -- ── Commission linkage (the Phase 3 seam) ────────────────────────────
      -- Written by the Commission File plane when it recognises an order id it
      -- has already seen here. Kept as its own table rather than columns on
      -- vendor_orders so neither integration has to be deployed before the
      -- other, and so a chargeback arriving months later has somewhere to land.
      CREATE TABLE IF NOT EXISTS vendor_order_commission_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        vendor_order_id INTEGER,
        external_order_key TEXT,
        external_transaction_key TEXT,
        commission_status TEXT NOT NULL,
        amount_cents INTEGER NOT NULL DEFAULT 0,
        period_label TEXT,
        effective_at TEXT NOT NULL,
        source_reference TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_vendor_order_commission_links_order
        ON vendor_order_commission_links(tenant_id, vendor_order_id, effective_at DESC);
      CREATE INDEX IF NOT EXISTS idx_vendor_order_commission_links_key
        ON vendor_order_commission_links(tenant_id, external_order_key);

      -- ── Recovery policy, per organization ────────────────────────────────
      CREATE TABLE IF NOT EXISTS order_recovery_policies (
        tenant_id INTEGER PRIMARY KEY,
        policy_json TEXT NOT NULL,
        -- Messaging is off until an org admin turns it on AND the process flag
        -- is set. Two switches, because one of them belongs to the operator of
        -- the platform and the other to the owner of the organization.
        messaging_approved INTEGER NOT NULL DEFAULT 0 CHECK(messaging_approved IN (0,1)),
        messaging_approved_by_user_id INTEGER,
        messaging_approved_at TEXT,
        consent_policy_configured INTEGER NOT NULL DEFAULT 0 CHECK(consent_policy_configured IN (0,1)),
        automated_sequences_enabled INTEGER NOT NULL DEFAULT 0 CHECK(automated_sequences_enabled IN (0,1)),
        support_phone TEXT,
        company_mailing_address TEXT,
        sms_sender_identity TEXT,
        email_sender_identity TEXT,
        email_reply_to TEXT,
        -- Where {{callback_link}} points. An organization's own scheduling or
        -- support page; empty means templates using that variable cannot render
        -- and therefore cannot send, which is the correct refusal.
        callback_url TEXT,
        quiet_hours_start INTEGER NOT NULL DEFAULT 9,
        quiet_hours_end INTEGER NOT NULL DEFAULT 20,
        max_per_destination_per_day INTEGER NOT NULL DEFAULT 1,
        max_per_case_total INTEGER NOT NULL DEFAULT 4,
        min_hours_between_outreach INTEGER NOT NULL DEFAULT 24,
        report_timezone TEXT NOT NULL DEFAULT 'America/New_York',
        updated_by_user_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- ── The work item ────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS order_recovery_cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        vendor_order_id INTEGER NOT NULL,
        sale_id INTEGER,
        lead_id INTEGER,
        assigned_to_user_id INTEGER,
        assigned_to_rep_id INTEGER,
        recovery_reason TEXT NOT NULL CHECK(recovery_reason IN (${RECOVERY_REASON_CHECK})),
        priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN (${PRIORITY_CHECK})),
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN (${CASE_STATUS_CHECK})),
        days_stalled INTEGER NOT NULL DEFAULT 0,
        next_action_at TEXT,
        last_outreach_at TEXT,
        outreach_count INTEGER NOT NULL DEFAULT 0,
        -- Denormalized on purpose. The queue renders thousands of rows and the
        -- consent answer is three joins away; a stale value here can only ever
        -- make the UI show a lock that the send gate would also apply, never
        -- unlock one - the gate is re-evaluated from source at send time.
        opt_out_blocked INTEGER NOT NULL DEFAULT 0 CHECK(opt_out_blocked IN (0,1)),
        opened_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        resolved_by_user_id INTEGER,
        resolution_code TEXT CHECK(resolution_code IS NULL OR resolution_code IN (${RESOLUTION_CHECK})),
        resolution_note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- One ACTIVE case per order. A resolved case does not block a new one:
      -- an order that fails a second install deserves a second case, and its
      -- own outcome record.
      CREATE UNIQUE INDEX IF NOT EXISTS uq_order_recovery_active
        ON order_recovery_cases(tenant_id, vendor_order_id)
        WHERE status IN ('open','in_progress','snoozed');
      CREATE INDEX IF NOT EXISTS idx_order_recovery_queue
        ON order_recovery_cases(tenant_id, status, priority, next_action_at);
      CREATE INDEX IF NOT EXISTS idx_order_recovery_assignee
        ON order_recovery_cases(tenant_id, assigned_to_rep_id, status, priority);
      CREATE INDEX IF NOT EXISTS idx_order_recovery_order
        ON order_recovery_cases(vendor_order_id, status);

      -- ── Case timeline ────────────────────────────────────────────────────
      -- Assignment, notes, callbacks, resolution. Append-only by convention and
      -- by the absence of any update path in the store.
      CREATE TABLE IF NOT EXISTS order_recovery_case_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        recovery_case_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        actor_user_id INTEGER,
        actor_name TEXT,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_recovery_case_events
        ON order_recovery_case_events(recovery_case_id, created_at DESC, id DESC);

      -- ── Templates ────────────────────────────────────────────────────────
      -- Versioned. Editing an approved version publishes a new DRAFT rather
      -- than changing words an approval was granted for.
      CREATE TABLE IF NOT EXISTS order_recovery_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN (${TEMPLATE_KIND_CHECK})),
        channel TEXT NOT NULL CHECK(channel IN (${CHANNEL_CHECK})),
        name TEXT NOT NULL,
        subject TEXT,
        body TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
        approved INTEGER NOT NULL DEFAULT 0 CHECK(approved IN (0,1)),
        approved_by_user_id INTEGER,
        approved_at TEXT,
        created_by_user_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_recovery_templates_tenant
        ON order_recovery_templates(tenant_id, channel, kind, is_active);

      -- ── One message, drafted or sent ─────────────────────────────────────
      CREATE TABLE IF NOT EXISTS order_recovery_outreach (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        recovery_case_id INTEGER NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN (${CHANNEL_CHECK})),
        message_template_id INTEGER,
        template_version INTEGER,
        -- The words we actually rendered, frozen. Templates get edited; this is
        -- the only thing that can answer "what did we send this person".
        message_body_snapshot TEXT NOT NULL,
        subject_snapshot TEXT,
        recipient_phone_masked TEXT,
        recipient_email_masked TEXT,
        recipient_hash TEXT,
        consent_basis TEXT CHECK(consent_basis IS NULL OR consent_basis IN (${CONSENT_BASIS_CHECK})),
        consent_record_id INTEGER,
        sender_identity TEXT,
        purpose TEXT NOT NULL DEFAULT 'transactional_service_update',
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN (${list(OUTREACH_STATUSES)})),
        -- Why a send was refused, as reason codes. Kept on the record so an
        -- admin can see the wall a rep hit without re-running the gate.
        blocked_reasons TEXT,
        provider_message_id TEXT,
        sent_at TEXT,
        delivered_at TEXT,
        failed_at TEXT,
        failure_detail TEXT,
        response_at TEXT,
        opt_out_detected_at TEXT,
        created_by_user_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_recovery_outreach_case
        ON order_recovery_outreach(recovery_case_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_recovery_outreach_rate
        ON order_recovery_outreach(tenant_id, recipient_hash, sent_at);
      CREATE INDEX IF NOT EXISTS idx_recovery_outreach_status
        ON order_recovery_outreach(tenant_id, status, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_recovery_outreach_provider_msg
        ON order_recovery_outreach(tenant_id, provider_message_id)
        WHERE provider_message_id IS NOT NULL;

      -- ── Consent ledger ───────────────────────────────────────────────────
      -- Append-mostly: a new grant supersedes an older one by being newer, and
      -- a revocation stamps revoked_at rather than deleting the row. The proof
      -- reference points at wherever the artifact actually lives (a signed
      -- agreement id, a form submission id); this table never holds the artifact.
      CREATE TABLE IF NOT EXISTS customer_contact_consents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        lead_id INTEGER,
        sale_id INTEGER,
        vendor_order_id INTEGER,
        channel TEXT NOT NULL CHECK(channel IN (${CHANNEL_CHECK})),
        destination_hash TEXT NOT NULL,
        destination_masked TEXT,
        hash_scheme TEXT NOT NULL DEFAULT 'hmac-sha256',
        consent_status TEXT NOT NULL CHECK(consent_status IN (${CONSENT_STATUS_CHECK})),
        consent_basis TEXT NOT NULL CHECK(consent_basis IN (${CONSENT_BASIS_CHECK})),
        consent_source TEXT NOT NULL CHECK(consent_source IN (${CONSENT_SOURCE_CHECK})),
        consent_language TEXT,
        consent_captured_at TEXT NOT NULL,
        consent_proof_reference TEXT,
        revoked_at TEXT,
        created_by_user_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_contact_consents_lookup
        ON customer_contact_consents(tenant_id, channel, destination_hash, consent_captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_contact_consents_order
        ON customer_contact_consents(tenant_id, vendor_order_id);

      -- ── Suppression list ─────────────────────────────────────────────────
      -- The wall. One row per destination per channel per organization, and
      -- there is no delete path in the store: a lift writes lifted_at and is
      -- audited, so "who un-blocked this number" always has an answer.
      CREATE TABLE IF NOT EXISTS customer_contact_suppressions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        lead_id INTEGER,
        vendor_order_id INTEGER,
        channel TEXT NOT NULL CHECK(channel IN (${CHANNEL_CHECK})),
        destination_hash TEXT NOT NULL,
        destination_masked TEXT,
        hash_scheme TEXT NOT NULL DEFAULT 'hmac-sha256',
        reason TEXT NOT NULL CHECK(reason IN (${SUPPRESSION_REASON_CHECK})),
        source TEXT NOT NULL,
        evidence TEXT,
        suppressed_at TEXT NOT NULL DEFAULT (datetime('now')),
        lifted_at TEXT,
        lifted_by_user_id INTEGER,
        lift_reason TEXT,
        created_by_user_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_suppression
        ON customer_contact_suppressions(tenant_id, channel, destination_hash);
      CREATE INDEX IF NOT EXISTS idx_contact_suppression_active
        ON customer_contact_suppressions(tenant_id, channel, lifted_at);
    `);

    // Append-only enforcement for the two streams whose value IS their
    // immutability. Same device adminAudit uses: the database refuses, so a
    // future code change cannot quietly rewrite history.
    rawDb.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_vendor_order_events_no_update
        BEFORE UPDATE ON vendor_order_events
        BEGIN SELECT RAISE(ABORT, 'vendor_order_events is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_vendor_order_events_no_delete
        BEFORE DELETE ON vendor_order_events
        BEGIN SELECT RAISE(ABORT, 'vendor_order_events is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_recovery_case_events_no_update
        BEFORE UPDATE ON order_recovery_case_events
        BEGIN SELECT RAISE(ABORT, 'order_recovery_case_events is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_recovery_case_events_no_delete
        BEFORE DELETE ON order_recovery_case_events
        BEGIN SELECT RAISE(ABORT, 'order_recovery_case_events is append-only'); END;
    `);

    rawDb.exec("COMMIT");
  } catch (e) {
    try { rawDb.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}
