// ── Provider order status and recovery - persistence ─────────────────────────
//
// Every write in this plane goes through here, and every read is tenant-scoped
// at the SQL level rather than filtered afterwards. That is not style: the
// import worker runs outside any request, so there is no session to fall back
// on and no middleware to catch a query that forgot its organization.
//
// TRANSACTION DISCIPLINE. server/db.ts records an 8 GB WAL incident caused by
// long writer transactions starving the checkpointer, and an import is exactly
// the shape of job that reproduces it. So: one row is one short transaction,
// batches are bounded, and nothing here opens a transaction around an entire
// file. The import is resumable instead of atomic, which is the right trade for
// a job that can legitimately take minutes.

import { rawDb } from "./db";
import { encryptOrderPayload, hashDestination, orderPayloadEncryptionReady, sha256Hex } from "./vendorOrderCrypto";
import {
  toIsoOrNull,
  type NormalizedOrderStatus,
  type NormalizedVendorOrder,
  type OrderColumnMapping,
} from "@shared/orderStatusSource";
import { orderIdentityKeys } from "@shared/orderColumnMapping";
import {
  resolveRecoveryPolicy,
  type RecoveryPolicy, type RecoveryPriority, type RecoveryReason,
} from "@shared/orderRecovery";
import { maskEmail, maskPhone, type ContactChannel } from "@shared/contactConsent";
import type { ImportStatus, MatchStatus, OutreachStatus } from "./vendorOrderMigrations";

export const PROVIDER = "perfectvision_submitted_orders";

const nowIso = () => new Date().toISOString();

// ── Organization policy ──────────────────────────────────────────────────────

export interface OrgRecoveryConfig {
  tenantId: number;
  policy: RecoveryPolicy;
  messagingApproved: boolean;
  messagingApprovedByUserId: number | null;
  messagingApprovedAt: string | null;
  consentPolicyConfigured: boolean;
  automatedSequencesEnabled: boolean;
  supportPhone: string | null;
  companyMailingAddress: string | null;
  smsSenderIdentity: string | null;
  emailSenderIdentity: string | null;
  emailReplyTo: string | null;
  callbackUrl: string | null;
  quietHoursStart: number;
  quietHoursEnd: number;
  maxPerDestinationPerDay: number;
  maxPerCaseTotal: number;
  minHoursBetweenOutreach: number;
  reportTimezone: string;
}

/** Defaults for an organization that has never opened the screen. Every switch
 *  that could cause a message to leave the building is off. */
export function getOrgRecoveryConfig(tenantId: number): OrgRecoveryConfig {
  const row = rawDb.prepare(`SELECT * FROM order_recovery_policies WHERE tenant_id = ?`).get(tenantId) as any;
  if (!row) {
    return {
      tenantId,
      // resolveRecoveryPolicy(null), not a spread: the defaults' arrays are
      // module-level and must never be handed out by reference.
      policy: resolveRecoveryPolicy(null),
      messagingApproved: false,
      messagingApprovedByUserId: null,
      messagingApprovedAt: null,
      consentPolicyConfigured: false,
      automatedSequencesEnabled: false,
      supportPhone: null,
      companyMailingAddress: null,
      smsSenderIdentity: null,
      emailSenderIdentity: null,
      emailReplyTo: null,
      callbackUrl: null,
      quietHoursStart: 9,
      quietHoursEnd: 20,
      maxPerDestinationPerDay: 1,
      maxPerCaseTotal: 4,
      minHoursBetweenOutreach: 24,
      reportTimezone: "America/New_York",
    };
  }
  let parsed: Partial<RecoveryPolicy> | null = null;
  try { parsed = JSON.parse(row.policy_json); } catch { parsed = null; }
  return {
    tenantId,
    policy: resolveRecoveryPolicy(parsed),
    messagingApproved: !!row.messaging_approved,
    messagingApprovedByUserId: row.messaging_approved_by_user_id ?? null,
    messagingApprovedAt: row.messaging_approved_at ?? null,
    consentPolicyConfigured: !!row.consent_policy_configured,
    automatedSequencesEnabled: !!row.automated_sequences_enabled,
    supportPhone: row.support_phone ?? null,
    companyMailingAddress: row.company_mailing_address ?? null,
    smsSenderIdentity: row.sms_sender_identity ?? null,
    emailSenderIdentity: row.email_sender_identity ?? null,
    emailReplyTo: row.email_reply_to ?? null,
    callbackUrl: row.callback_url ?? null,
    quietHoursStart: row.quiet_hours_start ?? 9,
    quietHoursEnd: row.quiet_hours_end ?? 20,
    maxPerDestinationPerDay: row.max_per_destination_per_day ?? 1,
    maxPerCaseTotal: row.max_per_case_total ?? 4,
    minHoursBetweenOutreach: row.min_hours_between_outreach ?? 24,
    reportTimezone: row.report_timezone ?? "America/New_York",
  };
}

export function saveOrgRecoveryConfig(
  tenantId: number,
  patch: Partial<Omit<OrgRecoveryConfig, "tenantId">>,
  updatedByUserId: number | null,
): OrgRecoveryConfig {
  const current = getOrgRecoveryConfig(tenantId);
  const next: OrgRecoveryConfig = { ...current, ...patch, tenantId };
  // Approving messaging stamps who and when. Un-approving clears it, so a
  // stale approval can never look current.
  const approvalChanged = patch.messagingApproved != null && patch.messagingApproved !== current.messagingApproved;
  const approvedAt = approvalChanged ? (next.messagingApproved ? nowIso() : null) : current.messagingApprovedAt;
  const approvedBy = approvalChanged ? (next.messagingApproved ? updatedByUserId : null) : current.messagingApprovedByUserId;

  rawDb.prepare(`
    INSERT INTO order_recovery_policies (
      tenant_id, policy_json, messaging_approved, messaging_approved_by_user_id, messaging_approved_at,
      consent_policy_configured, automated_sequences_enabled, support_phone, company_mailing_address,
      sms_sender_identity, email_sender_identity, email_reply_to, callback_url,
      quiet_hours_start, quiet_hours_end, max_per_destination_per_day, max_per_case_total,
      min_hours_between_outreach, report_timezone, updated_by_user_id, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      policy_json = excluded.policy_json,
      messaging_approved = excluded.messaging_approved,
      messaging_approved_by_user_id = excluded.messaging_approved_by_user_id,
      messaging_approved_at = excluded.messaging_approved_at,
      consent_policy_configured = excluded.consent_policy_configured,
      automated_sequences_enabled = excluded.automated_sequences_enabled,
      support_phone = excluded.support_phone,
      company_mailing_address = excluded.company_mailing_address,
      sms_sender_identity = excluded.sms_sender_identity,
      email_sender_identity = excluded.email_sender_identity,
      email_reply_to = excluded.email_reply_to,
      callback_url = excluded.callback_url,
      quiet_hours_start = excluded.quiet_hours_start,
      quiet_hours_end = excluded.quiet_hours_end,
      max_per_destination_per_day = excluded.max_per_destination_per_day,
      max_per_case_total = excluded.max_per_case_total,
      min_hours_between_outreach = excluded.min_hours_between_outreach,
      report_timezone = excluded.report_timezone,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = excluded.updated_at
  `).run(
    tenantId, JSON.stringify(next.policy), next.messagingApproved ? 1 : 0, approvedBy, approvedAt,
    next.consentPolicyConfigured ? 1 : 0, next.automatedSequencesEnabled ? 1 : 0,
    next.supportPhone, next.companyMailingAddress,
    next.smsSenderIdentity, next.emailSenderIdentity, next.emailReplyTo, next.callbackUrl,
    clampHour(next.quietHoursStart, 9), clampHour(next.quietHoursEnd, 20),
    Math.max(0, next.maxPerDestinationPerDay), Math.max(0, next.maxPerCaseTotal),
    Math.max(0, next.minHoursBetweenOutreach), next.reportTimezone,
    updatedByUserId, nowIso(),
  );
  return getOrgRecoveryConfig(tenantId);
}

function clampHour(v: number, fallback: number): number {
  return Number.isInteger(v) && v >= 0 && v <= 23 ? v : fallback;
}

// ── Column mapping ───────────────────────────────────────────────────────────

export interface StoredMapping {
  id: number;
  version: number;
  mapping: OrderColumnMapping;
  createdAt: string;
  createdByUserId: number | null;
}

export function getActiveMapping(tenantId: number, provider = PROVIDER): StoredMapping | null {
  const row = rawDb.prepare(`
    SELECT * FROM vendor_order_mappings WHERE tenant_id = ? AND provider = ? AND is_active = 1
  `).get(tenantId, provider) as any;
  if (!row) return null;
  try {
    return {
      id: row.id, version: row.version, mapping: JSON.parse(row.mapping_json),
      createdAt: row.created_at, createdByUserId: row.created_by_user_id ?? null,
    };
  } catch {
    return null;
  }
}

export function getMappingByVersion(tenantId: number, version: number, provider = PROVIDER): StoredMapping | null {
  const row = rawDb.prepare(`
    SELECT * FROM vendor_order_mappings WHERE tenant_id = ? AND provider = ? AND version = ?
  `).get(tenantId, provider, version) as any;
  if (!row) return null;
  try {
    return {
      id: row.id, version: row.version, mapping: JSON.parse(row.mapping_json),
      createdAt: row.created_at, createdByUserId: row.created_by_user_id ?? null,
    };
  } catch {
    return null;
  }
}

/** Saving publishes a NEW version and retires the old one. An import records
 *  the version it ran under, so a row imported under version 2 stays
 *  explainable after version 3 lands. */
export function saveMapping(
  tenantId: number, mapping: OrderColumnMapping, userId: number | null, provider = PROVIDER,
): StoredMapping {
  const tx = rawDb.transaction(() => {
    const max = rawDb.prepare(
      `SELECT COALESCE(MAX(version), 0) AS v FROM vendor_order_mappings WHERE tenant_id = ? AND provider = ?`,
    ).get(tenantId, provider) as any;
    const version = Number(max?.v ?? 0) + 1;
    rawDb.prepare(
      `UPDATE vendor_order_mappings SET is_active = 0, updated_at = ? WHERE tenant_id = ? AND provider = ? AND is_active = 1`,
    ).run(nowIso(), tenantId, provider);
    rawDb.prepare(`
      INSERT INTO vendor_order_mappings (tenant_id, provider, version, mapping_json, is_active, created_by_user_id)
      VALUES (?,?,?,?,1,?)
    `).run(tenantId, provider, version, JSON.stringify({ ...mapping, version }), userId);
    return version;
  });
  // .immediate(), not a deferred invoke: this transaction READS the current max
  // version and then writes, so under a deferred BEGIN another connection's
  // commit in between turns the write into an instant SQLITE_BUSY_SNAPSHOT that
  // busy_timeout does not cover. Taking the write lock up front is the repo-wide
  // rule (see tests/unit/deferred-read-write-transactions.test.ts).
  const version = tx.immediate();
  return getMappingByVersion(tenantId, version, provider)!;
}

// ── Connection ───────────────────────────────────────────────────────────────

export function getConnection(tenantId: number, provider = PROVIDER): any | null {
  return rawDb.prepare(
    `SELECT * FROM vendor_order_connections WHERE tenant_id = ? AND provider = ?`,
  ).get(tenantId, provider) ?? null;
}

export function upsertConnection(input: {
  tenantId: number; provider?: string; label: string; sourceUrl: string | null;
  mode: string; enabled: boolean; encryptedCredentials?: string | null;
}): void {
  const provider = input.provider ?? PROVIDER;
  const existing = getConnection(input.tenantId, provider);
  if (existing) {
    rawDb.prepare(`
      UPDATE vendor_order_connections
         SET label = ?, source_url = ?, mode = ?, enabled = ?,
             encrypted_credentials = COALESCE(?, encrypted_credentials), updated_at = ?
       WHERE tenant_id = ? AND provider = ?
    `).run(
      input.label, input.sourceUrl, input.mode, input.enabled ? 1 : 0,
      input.encryptedCredentials ?? null, nowIso(), input.tenantId, provider,
    );
    return;
  }
  rawDb.prepare(`
    INSERT INTO vendor_order_connections (tenant_id, provider, label, source_url, mode, enabled, encrypted_credentials)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    input.tenantId, provider, input.label, input.sourceUrl, input.mode,
    input.enabled ? 1 : 0, input.encryptedCredentials ?? null,
  );
}

/** Organizations whose connection is an ENABLED scheduled report delivery.
 *  The inbound delivery endpoint resolves its tenant from this set - the
 *  deliverer holds a shared secret, not a session, so the org an import lands
 *  in must come from state an admin explicitly configured, never from an
 *  unauthenticated request body. */
export function listEnabledScheduledConnections(provider = PROVIDER): { tenant_id: number }[] {
  return rawDb.prepare(`
    SELECT tenant_id FROM vendor_order_connections
     WHERE provider = ? AND mode = 'scheduled_export' AND enabled = 1
     ORDER BY tenant_id
  `).all(provider) as { tenant_id: number }[];
}

export function recordConnectionTest(tenantId: number, provider: string, ok: boolean, message: string): void {
  rawDb.prepare(`
    UPDATE vendor_order_connections SET last_test_at = ?, last_test_ok = ?, last_test_message = ?, updated_at = ?
     WHERE tenant_id = ? AND provider = ?
  `).run(nowIso(), ok ? 1 : 0, message.slice(0, 500), nowIso(), tenantId, provider);
}

// ── Imports ──────────────────────────────────────────────────────────────────

export interface CreateImportInput {
  tenantId: number;
  provider?: string;
  sourceUrl: string | null;
  importMode: string;
  reportPeriodStart: string | null;
  reportPeriodEnd: string | null;
  sourceFileName: string;
  sourceFileChecksum: string;
  sourceFileStorageKey: string | null;
  mappingVersion: number;
  importedByUserId: number | null;
  totalRows: number;
}

/** A checksum that already imported successfully. The duplicate guard the admin
 *  screen shows BEFORE the upload is accepted, so the answer is "you already
 *  imported this file on 3 August" rather than a constraint violation. */
export function findImportByChecksum(tenantId: number, checksum: string, provider = PROVIDER): any | null {
  return rawDb.prepare(`
    SELECT * FROM vendor_order_imports
     WHERE tenant_id = ? AND provider = ? AND source_file_checksum = ?
       AND status NOT IN ('failed','canceled')
     ORDER BY id DESC LIMIT 1
  `).get(tenantId, provider, checksum) ?? null;
}

export function createImport(input: CreateImportInput): number {
  const info = rawDb.prepare(`
    INSERT INTO vendor_order_imports (
      tenant_id, provider, source_url, import_mode, report_period_start, report_period_end,
      source_file_name, source_file_checksum, source_file_storage_key, mapping_version,
      status, imported_by_user_id, total_rows
    ) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)
  `).run(
    input.tenantId, input.provider ?? PROVIDER, input.sourceUrl, input.importMode,
    input.reportPeriodStart, input.reportPeriodEnd, input.sourceFileName,
    input.sourceFileChecksum, input.sourceFileStorageKey, input.mappingVersion,
    input.importedByUserId, input.totalRows,
  );
  return Number(info.lastInsertRowid);
}

export function getImport(id: number, tenantId: number | null): any | null {
  const row = rawDb.prepare(`SELECT * FROM vendor_order_imports WHERE id = ?`).get(id) as any;
  if (!row) return null;
  if (tenantId != null && row.tenant_id !== tenantId) return null;
  return row;
}

export function listImports(tenantId: number, limit = 50): any[] {
  return rawDb.prepare(`
    SELECT * FROM vendor_order_imports WHERE tenant_id = ? ORDER BY id DESC LIMIT ?
  `).all(tenantId, Math.min(200, Math.max(1, limit))) as any[];
}

/**
 * Claim the oldest pending import, atomically.
 *
 * The UPDATE ... WHERE status='pending' is the lock: two workers racing for the
 * same row means exactly one UPDATE reports a change, and the loser sees zero
 * and moves on. Nothing here relies on a separate lock table that could be left
 * held by a process that died.
 */
export function claimNextPendingImport(): any | null {
  const candidate = rawDb.prepare(`
    SELECT id FROM vendor_order_imports WHERE status = 'pending' ORDER BY id ASC LIMIT 1
  `).get() as any;
  if (!candidate) return null;
  const claimed = rawDb.prepare(`
    UPDATE vendor_order_imports
       SET status = 'processing', started_at = COALESCE(started_at, ?), attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND status = 'pending'
  `).run(nowIso(), nowIso(), candidate.id);
  if (claimed.changes !== 1) return null;
  return getImport(candidate.id, null);
}

export function setImportStatus(id: number, status: ImportStatus, safeErrorSummary?: string | null): void {
  const done = status === "completed" || status === "completed_with_errors" || status === "failed" || status === "canceled";
  rawDb.prepare(`
    UPDATE vendor_order_imports
       SET status = ?, safe_error_summary = COALESCE(?, safe_error_summary),
           completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END, updated_at = ?
     WHERE id = ?
  `).run(status, safeErrorSummary ?? null, done ? 1 : 0, nowIso(), nowIso(), id);
}

export type ImportCounter =
  | "valid_rows" | "inserted_rows" | "updated_rows" | "duplicate_rows"
  | "matched_rows" | "unmatched_rows" | "recovery_candidates" | "error_rows";

export function bumpImportCounters(id: number, deltas: Partial<Record<ImportCounter, number>>): void {
  const entries = Object.entries(deltas).filter(([, v]) => typeof v === "number" && v !== 0);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ${k} + ?`).join(", ");
  rawDb.prepare(`UPDATE vendor_order_imports SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...entries.map(([, v]) => v as number), nowIso(), id);
}

/** Any import stuck in `processing` past the deadline. A worker that was killed
 *  mid-file leaves one behind, and a job nobody will ever finish must not look
 *  like a job in flight. */
export function reclaimStalledImports(maxAgeMinutes: number, maxAttempts: number): number {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
  const stalled = rawDb.prepare(`
    SELECT id, attempts FROM vendor_order_imports
     WHERE status = 'processing' AND COALESCE(started_at, created_at) < ?
  `).all(cutoff) as any[];
  let reclaimed = 0;
  for (const row of stalled) {
    if (Number(row.attempts) >= maxAttempts) {
      setImportStatus(row.id, "failed", "The import did not finish after several attempts. Upload the file again or contact support.");
    } else {
      rawDb.prepare(`UPDATE vendor_order_imports SET status = 'pending', updated_at = ? WHERE id = ?`).run(nowIso(), row.id);
    }
    reclaimed += 1;
  }
  return reclaimed;
}

// ── Import rows ──────────────────────────────────────────────────────────────

export interface InsertImportRowResult {
  rowId: number;
  encryptedPayload: boolean;
}

export function insertImportRow(input: {
  tenantId: number;
  importId: number;
  sourceRowNumber: number;
  order: NormalizedVendorOrder;
}): InsertImportRowResult {
  const { order } = input;
  const encrypted = encryptOrderPayload(order.sourceRowPayload);
  // RETURNING rather than lastInsertRowid: a retried import re-runs rows it
  // already wrote, and lastInsertRowid is meaningless on the UPDATE branch of
  // an upsert - it would hand the caller the id of some unrelated earlier row.
  const row = rawDb.prepare(`
    INSERT INTO vendor_order_import_rows (
      tenant_id, vendor_order_import_id, source_row_number, raw_row_hash,
      external_order_id, external_transaction_id, customer_account_number,
      carrier, product_sold, program, rep_external_name, rep_external_id,
      normalized_service_address, submitted_date, install_scheduled_at, install_date,
      source_status, normalized_status, failure_reason, required_customer_action,
      encrypted_raw_payload
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(vendor_order_import_id, source_row_number) DO UPDATE SET
      raw_row_hash = excluded.raw_row_hash,
      normalized_status = excluded.normalized_status,
      encrypted_raw_payload = excluded.encrypted_raw_payload,
      updated_at = datetime('now')
    RETURNING id
  `).get(
    input.tenantId, input.importId, input.sourceRowNumber, order.rawRowHash,
    order.externalOrderId ?? null, order.externalTransactionId ?? null, order.customerAccountNumber ?? null,
    order.carrier ?? null, order.productSold ?? null, order.program ?? null,
    order.repExternalName ?? null, order.repExternalId ?? null,
    order.normalizedServiceAddress ?? null,
    toIsoOrNull(order.submittedDate), toIsoOrNull(order.installScheduledAt), toIsoOrNull(order.installDate),
    order.sourceStatus ?? null, order.normalizedStatus,
    order.failureReason ?? null, order.requiredCustomerAction ?? null,
    encrypted,
  ) as any;
  return { rowId: Number(row.id), encryptedPayload: encrypted != null };
}

export function setRowMatch(rowId: number, patch: {
  matchStatus: MatchStatus;
  matchRule: string | null;
  matchedSaleId: number | null;
  matchedLeadId: number | null;
  matchedRepId: number | null;
  confidence: number | null;
  exceptionReason: string | null;
  vendorOrderId: number | null;
}): void {
  rawDb.prepare(`
    UPDATE vendor_order_import_rows
       SET match_status = ?, match_rule = ?, matched_sale_id = ?, matched_lead_id = ?, matched_rep_id = ?,
           match_confidence_score = ?, exception_reason = ?, vendor_order_id = ?, updated_at = ?
     WHERE id = ?
  `).run(
    patch.matchStatus, patch.matchRule, patch.matchedSaleId, patch.matchedLeadId, patch.matchedRepId,
    patch.confidence, patch.exceptionReason, patch.vendorOrderId, nowIso(), rowId,
  );
}

export function getImportRow(rowId: number, tenantId: number | null): any | null {
  const row = rawDb.prepare(`SELECT * FROM vendor_order_import_rows WHERE id = ?`).get(rowId) as any;
  if (!row) return null;
  if (tenantId != null && row.tenant_id !== tenantId) return null;
  return row;
}

/** The most recent import row for an order, which is where the encrypted
 *  payload with the customer's real contact details lives. */
export function latestImportRowForOrder(tenantId: number, vendorOrderId: number): any | null {
  return rawDb.prepare(`
    SELECT * FROM vendor_order_import_rows
     WHERE tenant_id = ? AND vendor_order_id = ?
     ORDER BY id DESC LIMIT 1
  `).get(tenantId, vendorOrderId) ?? null;
}

export function listMatchExceptions(tenantId: number, limit = 100): any[] {
  return rawDb.prepare(`
    SELECT r.*, i.source_file_name, i.created_at AS import_created_at
      FROM vendor_order_import_rows r
      JOIN vendor_order_imports i ON i.id = r.vendor_order_import_id
     WHERE r.tenant_id = ? AND r.match_status IN ('exception','unmatched','matched_low_confidence')
     ORDER BY r.id DESC LIMIT ?
  `).all(tenantId, Math.min(500, Math.max(1, limit))) as any[];
}

// ── Orders ───────────────────────────────────────────────────────────────────

export interface UpsertOrderResult {
  vendorOrderId: number;
  created: boolean;
  changed: boolean;
  previousStatus: NormalizedOrderStatus | null;
  /** True when the incoming row is byte-identical to what we already hold. */
  duplicate: boolean;
}

/**
 * Write the current state of one provider order.
 *
 * Identity resolution is ordered exactly like the matcher: order key, then
 * transaction key, then account key. An order that arrives with only an account
 * number and later gains a real order id updates the SAME row rather than
 * forking, which is why the lookup tries each key in turn instead of relying on
 * a single unique constraint.
 */
export function upsertOrder(input: {
  tenantId: number;
  order: NormalizedVendorOrder;
  importId: number;
  match: {
    saleId: number | null; leadId: number | null; repId: number | null;
    status: MatchStatus; confidence: number | null;
  };
}): UpsertOrderResult {
  const { tenantId, order, importId, match } = input;
  const keys = orderIdentityKeys(order);
  const existing = findOrderByIdentity(tenantId, keys);

  const phoneMasked = order.customerPhone ? maskPhone(order.customerPhone) : null;
  const emailMasked = order.customerEmail ? maskEmail(order.customerEmail) : null;
  const phoneHash = order.customerPhone ? hashDestination(tenantId, "sms", order.customerPhone).hash : null;
  const emailHash = order.customerEmail ? hashDestination(tenantId, "email", order.customerEmail).hash : null;

  if (!existing) {
    const info = rawDb.prepare(`
      INSERT INTO vendor_orders (
        tenant_id, provider, external_order_id, external_transaction_id, customer_account_number,
        external_order_key, external_transaction_key, account_key,
        sale_id, lead_id, rep_id, customer_name,
        customer_phone_masked, customer_email_masked, customer_phone_hash, customer_email_hash,
        service_address, normalized_service_address, carrier, product_sold, program,
        rep_external_name, rep_external_id, manager_external_name,
        normalized_status, source_status, sale_date, submitted_date, install_scheduled_at,
        install_date, cancellation_date, failure_reason, required_customer_action,
        match_status, match_confidence_score, last_vendor_updated_at, last_synced_at,
        current_source_import_id, current_row_hash
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      tenantId, PROVIDER, order.externalOrderId ?? null, order.externalTransactionId ?? null,
      order.customerAccountNumber ?? null, keys.orderKey, keys.transactionKey, keys.accountKey,
      match.saleId, match.leadId, match.repId, order.customerName ?? null,
      phoneMasked, emailMasked, phoneHash, emailHash,
      order.serviceAddress ?? null, order.normalizedServiceAddress ?? null,
      order.carrier ?? null, order.productSold ?? null, order.program ?? null,
      order.repExternalName ?? null, order.repExternalId ?? null, order.managerExternalName ?? null,
      order.normalizedStatus, order.sourceStatus ?? null,
      toIsoOrNull(order.saleDate), toIsoOrNull(order.submittedDate), toIsoOrNull(order.installScheduledAt),
      toIsoOrNull(order.installDate), toIsoOrNull(order.cancellationDate),
      order.failureReason ?? null, order.requiredCustomerAction ?? null,
      match.status, match.confidence, toIsoOrNull(order.sourceLastUpdatedAt), nowIso(),
      importId, order.rawRowHash,
    );
    return {
      vendorOrderId: Number(info.lastInsertRowid),
      created: true, changed: true, previousStatus: null, duplicate: false,
    };
  }

  // Byte-identical restatement. Touch last_synced_at so "when did we last see
  // this order" stays true, and change nothing else.
  if (existing.current_row_hash === order.rawRowHash) {
    rawDb.prepare(`UPDATE vendor_orders SET last_synced_at = ?, current_source_import_id = ? WHERE id = ?`)
      .run(nowIso(), importId, existing.id);
    return {
      vendorOrderId: existing.id, created: false, changed: false,
      previousStatus: existing.normalized_status as NormalizedOrderStatus, duplicate: true,
    };
  }

  rawDb.prepare(`
    UPDATE vendor_orders SET
      external_order_id = COALESCE(?, external_order_id),
      external_transaction_id = COALESCE(?, external_transaction_id),
      customer_account_number = COALESCE(?, customer_account_number),
      external_order_key = COALESCE(?, external_order_key),
      external_transaction_key = COALESCE(?, external_transaction_key),
      account_key = COALESCE(?, account_key),
      sale_id = COALESCE(?, sale_id),
      lead_id = COALESCE(?, lead_id),
      rep_id = COALESCE(?, rep_id),
      customer_name = COALESCE(?, customer_name),
      customer_phone_masked = COALESCE(?, customer_phone_masked),
      customer_email_masked = COALESCE(?, customer_email_masked),
      customer_phone_hash = COALESCE(?, customer_phone_hash),
      customer_email_hash = COALESCE(?, customer_email_hash),
      service_address = COALESCE(?, service_address),
      normalized_service_address = COALESCE(?, normalized_service_address),
      carrier = COALESCE(?, carrier),
      product_sold = COALESCE(?, product_sold),
      program = COALESCE(?, program),
      rep_external_name = COALESCE(?, rep_external_name),
      rep_external_id = COALESCE(?, rep_external_id),
      manager_external_name = COALESCE(?, manager_external_name),
      normalized_status = ?,
      source_status = ?,
      sale_date = COALESCE(?, sale_date),
      submitted_date = COALESCE(?, submitted_date),
      install_scheduled_at = COALESCE(?, install_scheduled_at),
      install_date = COALESCE(?, install_date),
      cancellation_date = COALESCE(?, cancellation_date),
      failure_reason = ?,
      required_customer_action = ?,
      match_status = ?,
      match_confidence_score = ?,
      last_vendor_updated_at = COALESCE(?, last_vendor_updated_at),
      last_synced_at = ?,
      current_source_import_id = ?,
      current_row_hash = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    order.externalOrderId ?? null, order.externalTransactionId ?? null, order.customerAccountNumber ?? null,
    keys.orderKey, keys.transactionKey, keys.accountKey,
    match.saleId, match.leadId, match.repId, order.customerName ?? null,
    phoneMasked, emailMasked, phoneHash, emailHash,
    order.serviceAddress ?? null, order.normalizedServiceAddress ?? null,
    order.carrier ?? null, order.productSold ?? null, order.program ?? null,
    order.repExternalName ?? null, order.repExternalId ?? null, order.managerExternalName ?? null,
    order.normalizedStatus, order.sourceStatus ?? null,
    toIsoOrNull(order.saleDate), toIsoOrNull(order.submittedDate), toIsoOrNull(order.installScheduledAt),
    toIsoOrNull(order.installDate), toIsoOrNull(order.cancellationDate),
    order.failureReason ?? null, order.requiredCustomerAction ?? null,
    match.status, match.confidence, toIsoOrNull(order.sourceLastUpdatedAt), nowIso(),
    importId, order.rawRowHash, nowIso(), existing.id,
  );

  return {
    vendorOrderId: existing.id, created: false, changed: true,
    previousStatus: existing.normalized_status as NormalizedOrderStatus, duplicate: false,
  };
}

export function findOrderByIdentity(
  tenantId: number,
  keys: { orderKey: string | null; transactionKey: string | null; accountKey: string | null },
  provider = PROVIDER,
): any | null {
  if (keys.orderKey) {
    const hit = rawDb.prepare(
      `SELECT * FROM vendor_orders WHERE tenant_id = ? AND provider = ? AND external_order_key = ?`,
    ).get(tenantId, provider, keys.orderKey);
    if (hit) return hit;
  }
  if (keys.transactionKey) {
    const hit = rawDb.prepare(
      `SELECT * FROM vendor_orders WHERE tenant_id = ? AND provider = ? AND external_transaction_key = ?`,
    ).get(tenantId, provider, keys.transactionKey);
    if (hit) return hit;
  }
  if (keys.accountKey) {
    const hit = rawDb.prepare(
      `SELECT * FROM vendor_orders WHERE tenant_id = ? AND provider = ? AND account_key = ?`,
    ).get(tenantId, provider, keys.accountKey);
    if (hit) return hit;
  }
  return null;
}

export function getOrder(id: number, tenantId: number | null): any | null {
  const row = rawDb.prepare(`SELECT * FROM vendor_orders WHERE id = ?`).get(id) as any;
  if (!row) return null;
  if (tenantId != null && row.tenant_id !== tenantId) return null;
  return row;
}

export interface OrderListFilter {
  status?: NormalizedOrderStatus | null;
  carrier?: string | null;
  program?: string | null;
  repIds?: number[] | null;
  search?: string | null;
  limit?: number;
  offset?: number;
}

export function listOrders(tenantId: number, filter: OrderListFilter = {}): any[] {
  const where: string[] = ["tenant_id = ?"];
  const args: any[] = [tenantId];
  if (filter.status) { where.push("normalized_status = ?"); args.push(filter.status); }
  if (filter.carrier) { where.push("carrier = ?"); args.push(filter.carrier); }
  if (filter.program) { where.push("program = ?"); args.push(filter.program); }
  if (filter.repIds) {
    if (filter.repIds.length === 0) return [];
    where.push(`rep_id IN (${filter.repIds.map(() => "?").join(",")})`);
    args.push(...filter.repIds);
  }
  if (filter.search) {
    // Identity and address only. Deliberately NOT customer name: a substring
    // search over names across the whole org is a people-finder, and every
    // legitimate lookup here starts from an order or an address.
    where.push("(external_order_id LIKE ? OR external_transaction_id LIKE ? OR normalized_service_address LIKE ?)");
    const like = `%${String(filter.search).toUpperCase().slice(0, 64)}%`;
    args.push(like, like, like);
  }
  const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
  const offset = Math.max(0, filter.offset ?? 0);
  return rawDb.prepare(`
    SELECT * FROM vendor_orders WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(submitted_date, created_at) DESC, id DESC
     LIMIT ? OFFSET ?
  `).all(...args, limit, offset) as any[];
}

/** Orders the recovery evaluator should look at. Bounded and ordered so a pass
 *  over a large org is a series of pages rather than one enormous result set. */
export function listOrdersForRecoveryScan(tenantId: number, limit: number, afterId: number): any[] {
  return rawDb.prepare(`
    SELECT * FROM vendor_orders
     WHERE tenant_id = ? AND id > ? AND normalized_status NOT IN ('installed','rejected')
     ORDER BY id ASC LIMIT ?
  `).all(tenantId, afterId, Math.min(1000, Math.max(1, limit))) as any[];
}

export function distinctTenantIdsWithOrders(): number[] {
  return (rawDb.prepare(`SELECT DISTINCT tenant_id FROM vendor_orders`).all() as any[])
    .map((r) => Number(r.tenant_id)).filter((n) => Number.isFinite(n));
}

export function orderStatusCounts(tenantId: number, repIds: number[] | null): Record<string, number> {
  const args: any[] = [tenantId];
  let scope = "";
  if (repIds) {
    if (repIds.length === 0) return {};
    scope = ` AND rep_id IN (${repIds.map(() => "?").join(",")})`;
    args.push(...repIds);
  }
  const rows = rawDb.prepare(`
    SELECT normalized_status AS s, COUNT(*) AS n FROM vendor_orders
     WHERE tenant_id = ?${scope} GROUP BY normalized_status
  `).all(...args) as any[];
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.s)] = Number(r.n);
  return out;
}

// ── Events ───────────────────────────────────────────────────────────────────

/** Append a transition. Returns false when the idempotency key already exists,
 *  which is what makes re-importing yesterday's file free. */
export function appendOrderEvent(input: {
  tenantId: number;
  vendorOrderId: number;
  importId: number | null;
  importRowId: number | null;
  eventType: string;
  oldStatus: NormalizedOrderStatus | null;
  newStatus: NormalizedOrderStatus;
  sourceStatus: string | null;
  effectiveAt: string;
  failureReason: string | null;
  requiredCustomerAction: string | null;
  /** Extra material folded into the key. Two different transitions of the same
   *  order on the same day must not collide. */
  idempotencySalt: string;
}): boolean {
  const key = sha256Hex([
    input.tenantId, input.vendorOrderId, input.eventType,
    input.oldStatus ?? "", input.newStatus, input.effectiveAt, input.idempotencySalt,
  ].join("|"));
  try {
    rawDb.prepare(`
      INSERT INTO vendor_order_events (
        tenant_id, vendor_order_id, source_import_id, source_import_row_id, event_type,
        old_status, new_status, source_status, effective_at, failure_reason,
        required_customer_action, idempotency_key
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      input.tenantId, input.vendorOrderId, input.importId, input.importRowId, input.eventType,
      input.oldStatus, input.newStatus, input.sourceStatus, input.effectiveAt,
      input.failureReason, input.requiredCustomerAction, key,
    );
    return true;
  } catch (e: any) {
    if (/UNIQUE constraint failed/i.test(String(e?.message ?? ""))) return false;
    throw e;
  }
}

export function listOrderEvents(tenantId: number, vendorOrderId: number, limit = 100): any[] {
  return rawDb.prepare(`
    SELECT * FROM vendor_order_events WHERE tenant_id = ? AND vendor_order_id = ?
     ORDER BY effective_at DESC, id DESC LIMIT ?
  `).all(tenantId, vendorOrderId, Math.min(500, Math.max(1, limit))) as any[];
}

export function listCommissionLinks(tenantId: number, vendorOrderId: number): any[] {
  return rawDb.prepare(`
    SELECT * FROM vendor_order_commission_links
     WHERE tenant_id = ? AND vendor_order_id = ? ORDER BY effective_at ASC, id ASC
  `).all(tenantId, vendorOrderId) as any[];
}

/** True when commission truth says this order has been PAID. The recovery
 *  engine's hard block, and the one place that answer is computed - `installed`
 *  on a vendor order never means paid. */
export function commissionPaidForOrder(tenantId: number, vendorOrderId: number): boolean {
  const row = rawDb.prepare(`
    SELECT 1 FROM vendor_order_commission_links
     WHERE tenant_id = ? AND vendor_order_id = ? AND commission_status = 'paid' LIMIT 1
  `).get(tenantId, vendorOrderId);
  return !!row;
}

// ── Recovery cases ───────────────────────────────────────────────────────────

export function findActiveCase(tenantId: number, vendorOrderId: number): any | null {
  return rawDb.prepare(`
    SELECT * FROM order_recovery_cases
     WHERE tenant_id = ? AND vendor_order_id = ? AND status IN ('open','in_progress','snoozed')
     ORDER BY id DESC LIMIT 1
  `).get(tenantId, vendorOrderId) ?? null;
}

export function openCase(input: {
  tenantId: number; vendorOrderId: number; saleId: number | null; leadId: number | null;
  assignedToRepId: number | null; assignedToUserId: number | null;
  reason: RecoveryReason; priority: RecoveryPriority; daysStalled: number;
  nextActionAt: string | null; optOutBlocked: boolean;
}): number | null {
  try {
    const info = rawDb.prepare(`
      INSERT INTO order_recovery_cases (
        tenant_id, vendor_order_id, sale_id, lead_id, assigned_to_user_id, assigned_to_rep_id,
        recovery_reason, priority, status, days_stalled, next_action_at, opt_out_blocked
      ) VALUES (?,?,?,?,?,?,?,?,'open',?,?,?)
    `).run(
      input.tenantId, input.vendorOrderId, input.saleId, input.leadId,
      input.assignedToUserId, input.assignedToRepId, input.reason, input.priority,
      input.daysStalled, input.nextActionAt, input.optOutBlocked ? 1 : 0,
    );
    return Number(info.lastInsertRowid);
  } catch (e: any) {
    // The partial unique index did its job: another pass opened a case for this
    // order between our check and our insert.
    if (/UNIQUE constraint failed/i.test(String(e?.message ?? ""))) return null;
    throw e;
  }
}

export function getCase(id: number, tenantId: number | null): any | null {
  const row = rawDb.prepare(`SELECT * FROM order_recovery_cases WHERE id = ?`).get(id) as any;
  if (!row) return null;
  if (tenantId != null && row.tenant_id !== tenantId) return null;
  return row;
}

export function updateCase(id: number, patch: Record<string, unknown>): void {
  const allowed = new Set([
    "assigned_to_user_id", "assigned_to_rep_id", "priority", "recovery_reason", "status", "days_stalled",
    "next_action_at", "last_outreach_at", "outreach_count", "opt_out_blocked",
    "resolved_at", "resolved_by_user_id", "resolution_code", "resolution_note",
  ]);
  const entries = Object.entries(patch).filter(([k]) => allowed.has(k));
  if (entries.length === 0) return;
  rawDb.prepare(
    `UPDATE order_recovery_cases SET ${entries.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
  ).run(...entries.map(([, v]) => v as any), nowIso(), id);
}

export interface CaseListFilter {
  statuses?: string[];
  priorities?: string[];
  reasons?: string[];
  repIds?: number[] | null;
  assignedToUserId?: number | null;
  limit?: number;
  offset?: number;
}

/**
 * The queue read, joined to the order so a list row needs no second query.
 *
 * `repIds` is the scope wall. A null means "no rep filter" and is only ever
 * passed by a caller that has already established org-wide authority; an empty
 * array means "this caller may see nothing" and short-circuits to no rows,
 * which is the safe direction for a scope resolver that found nothing.
 */
export function listCases(tenantId: number, filter: CaseListFilter = {}): any[] {
  const where: string[] = ["c.tenant_id = ?"];
  const args: any[] = [tenantId];
  const statuses = filter.statuses?.length ? filter.statuses : ["open", "in_progress", "snoozed"];
  where.push(`c.status IN (${statuses.map(() => "?").join(",")})`);
  args.push(...statuses);
  if (filter.priorities?.length) {
    where.push(`c.priority IN (${filter.priorities.map(() => "?").join(",")})`);
    args.push(...filter.priorities);
  }
  if (filter.reasons?.length) {
    where.push(`c.recovery_reason IN (${filter.reasons.map(() => "?").join(",")})`);
    args.push(...filter.reasons);
  }
  if (filter.repIds) {
    if (filter.repIds.length === 0) return [];
    where.push(`c.assigned_to_rep_id IN (${filter.repIds.map(() => "?").join(",")})`);
    args.push(...filter.repIds);
  }
  if (filter.assignedToUserId != null) {
    where.push("c.assigned_to_user_id = ?");
    args.push(filter.assignedToUserId);
  }
  const limit = Math.min(500, Math.max(1, filter.limit ?? 100));
  const offset = Math.max(0, filter.offset ?? 0);
  return rawDb.prepare(`
    SELECT
      c.*,
      o.external_order_id, o.external_transaction_id, o.customer_name, o.service_address,
      o.carrier, o.product_sold, o.program, o.normalized_status, o.source_status,
      o.failure_reason, o.required_customer_action, o.install_scheduled_at, o.install_date,
      o.submitted_date, o.rep_external_name, o.customer_phone_masked, o.customer_email_masked,
      o.match_status, o.match_confidence_score
    FROM order_recovery_cases c
    JOIN vendor_orders o ON o.id = c.vendor_order_id AND o.tenant_id = c.tenant_id
    WHERE ${where.join(" AND ")}
    ORDER BY
      CASE c.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      COALESCE(c.next_action_at, c.opened_at) ASC,
      c.id ASC
    LIMIT ? OFFSET ?
  `).all(...args, limit, offset) as any[];
}

export function appendCaseEvent(input: {
  tenantId: number; caseId: number; eventType: string;
  actorUserId: number | null; actorName: string | null; detail: string | null;
}): void {
  rawDb.prepare(`
    INSERT INTO order_recovery_case_events (tenant_id, recovery_case_id, event_type, actor_user_id, actor_name, detail)
    VALUES (?,?,?,?,?,?)
  `).run(input.tenantId, input.caseId, input.eventType, input.actorUserId, input.actorName, input.detail);
}

export function listCaseEvents(tenantId: number, caseId: number, limit = 200): any[] {
  return rawDb.prepare(`
    SELECT * FROM order_recovery_case_events WHERE tenant_id = ? AND recovery_case_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(tenantId, caseId, Math.min(500, Math.max(1, limit))) as any[];
}

// ── Outreach ─────────────────────────────────────────────────────────────────

export function insertOutreach(input: {
  tenantId: number; caseId: number; channel: ContactChannel;
  templateId: number | null; templateVersion: number | null;
  body: string; subject: string | null;
  phoneMasked: string | null; emailMasked: string | null; recipientHash: string | null;
  consentBasis: string | null; consentRecordId: number | null;
  senderIdentity: string | null; purpose: string;
  status: OutreachStatus; blockedReasons: string[] | null;
  createdByUserId: number | null;
}): number {
  const info = rawDb.prepare(`
    INSERT INTO order_recovery_outreach (
      tenant_id, recovery_case_id, channel, message_template_id, template_version,
      message_body_snapshot, subject_snapshot, recipient_phone_masked, recipient_email_masked,
      recipient_hash, consent_basis, consent_record_id, sender_identity, purpose,
      status, blocked_reasons, created_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    input.tenantId, input.caseId, input.channel, input.templateId, input.templateVersion,
    input.body, input.subject, input.phoneMasked, input.emailMasked,
    input.recipientHash, input.consentBasis, input.consentRecordId, input.senderIdentity,
    input.purpose, input.status, input.blockedReasons?.length ? JSON.stringify(input.blockedReasons) : null,
    input.createdByUserId,
  );
  return Number(info.lastInsertRowid);
}

export function markOutreachSent(id: number, providerMessageId: string | null): void {
  rawDb.prepare(`UPDATE order_recovery_outreach SET status = 'sent', sent_at = ?, provider_message_id = ? WHERE id = ?`)
    .run(nowIso(), providerMessageId, id);
}

export function markOutreachFailed(id: number, safeDetail: string): void {
  rawDb.prepare(`UPDATE order_recovery_outreach SET status = 'failed', failed_at = ?, failure_detail = ? WHERE id = ?`)
    .run(nowIso(), safeDetail.slice(0, 300), id);
}

export function markOutreachDelivered(tenantId: number, providerMessageId: string): boolean {
  const res = rawDb.prepare(`
    UPDATE order_recovery_outreach SET status = 'delivered', delivered_at = ?
     WHERE tenant_id = ? AND provider_message_id = ? AND status IN ('sent','queued')
  `).run(nowIso(), tenantId, providerMessageId);
  return res.changes > 0;
}

export function recordInboundResponse(tenantId: number, recipientHash: string, optOut: boolean): number {
  const res = rawDb.prepare(`
    UPDATE order_recovery_outreach
       SET response_at = COALESCE(response_at, ?), opt_out_detected_at = CASE WHEN ? = 1 THEN COALESCE(opt_out_detected_at, ?) ELSE opt_out_detected_at END
     WHERE tenant_id = ? AND recipient_hash = ? AND status IN ('sent','delivered')
  `).run(nowIso(), optOut ? 1 : 0, nowIso(), tenantId, recipientHash);
  return res.changes;
}

export function listOutreachForCase(tenantId: number, caseId: number, limit = 50): any[] {
  return rawDb.prepare(`
    SELECT * FROM order_recovery_outreach WHERE tenant_id = ? AND recovery_case_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(tenantId, caseId, Math.min(200, Math.max(1, limit))) as any[];
}

/** The three counters the rate limiter needs, in one pass. */
export function outreachCounters(tenantId: number, caseId: number, recipientHash: string | null): {
  sentToDestinationToday: number; sentForCaseTotal: number; hoursSinceLastOutreachToCase: number | null;
} {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const daily = recipientHash
    ? (rawDb.prepare(`
        SELECT COUNT(*) AS n FROM order_recovery_outreach
         WHERE tenant_id = ? AND recipient_hash = ? AND status IN ('sent','delivered','queued') AND sent_at >= ?
      `).get(tenantId, recipientHash, since) as any)
    : { n: 0 };
  const total = rawDb.prepare(`
    SELECT COUNT(*) AS n, MAX(sent_at) AS last FROM order_recovery_outreach
     WHERE tenant_id = ? AND recovery_case_id = ? AND status IN ('sent','delivered','queued')
  `).get(tenantId, caseId) as any;
  const lastMs = total?.last ? Date.parse(total.last) : NaN;
  return {
    sentToDestinationToday: Number(daily?.n ?? 0),
    sentForCaseTotal: Number(total?.n ?? 0),
    hoursSinceLastOutreachToCase: Number.isFinite(lastMs) ? (Date.now() - lastMs) / 3_600_000 : null,
  };
}

// ── Templates ────────────────────────────────────────────────────────────────

export function listTemplates(tenantId: number, opts: { activeOnly?: boolean } = {}): any[] {
  const active = opts.activeOnly === false ? "" : " AND is_active = 1";
  return rawDb.prepare(`
    SELECT * FROM order_recovery_templates WHERE tenant_id = ?${active}
     ORDER BY channel ASC, kind ASC, version DESC, id DESC
  `).all(tenantId) as any[];
}

export function getTemplate(id: number, tenantId: number | null): any | null {
  const row = rawDb.prepare(`SELECT * FROM order_recovery_templates WHERE id = ?`).get(id) as any;
  if (!row) return null;
  if (tenantId != null && row.tenant_id !== tenantId) return null;
  return row;
}

export function insertTemplate(input: {
  tenantId: number; kind: string; channel: ContactChannel; name: string;
  subject: string | null; body: string; version: number; createdByUserId: number | null;
}): number {
  const info = rawDb.prepare(`
    INSERT INTO order_recovery_templates (tenant_id, kind, channel, name, subject, body, version, is_active, approved, created_by_user_id)
    VALUES (?,?,?,?,?,?,?,1,0,?)
  `).run(
    input.tenantId, input.kind, input.channel, input.name,
    input.subject, input.body, input.version, input.createdByUserId,
  );
  return Number(info.lastInsertRowid);
}

export function retireTemplate(id: number): void {
  rawDb.prepare(`UPDATE order_recovery_templates SET is_active = 0, updated_at = ? WHERE id = ?`).run(nowIso(), id);
}

export function approveTemplate(id: number, userId: number | null, approved: boolean): void {
  rawDb.prepare(`
    UPDATE order_recovery_templates
       SET approved = ?, approved_by_user_id = ?, approved_at = ?, updated_at = ?
     WHERE id = ?
  `).run(approved ? 1 : 0, approved ? userId : null, approved ? nowIso() : null, nowIso(), id);
}

/** Seed an organization's template set on first visit. Everything lands in
 *  DRAFT: shipping a template is not approving it. */
export function seedTemplatesIfEmpty(
  tenantId: number,
  seeds: readonly { kind: string; channel: ContactChannel; name: string; subject: string | null; body: string }[],
): number {
  const existing = rawDb.prepare(`SELECT COUNT(*) AS n FROM order_recovery_templates WHERE tenant_id = ?`).get(tenantId) as any;
  if (Number(existing?.n ?? 0) > 0) return 0;
  const tx = rawDb.transaction(() => {
    for (const s of seeds) {
      insertTemplate({
        tenantId, kind: s.kind, channel: s.channel, name: s.name,
        subject: s.subject, body: s.body, version: 1, createdByUserId: null,
      });
    }
  });
  tx();
  return seeds.length;
}

// ── Consent and suppression ──────────────────────────────────────────────────

export function recordConsent(input: {
  tenantId: number; leadId: number | null; saleId: number | null; vendorOrderId: number | null;
  channel: ContactChannel; destinationNormalized: string;
  status: string; basis: string; source: string; language: string | null;
  capturedAt: string; proofReference: string | null; createdByUserId: number | null;
}): number {
  const { hash, scheme } = hashDestination(input.tenantId, input.channel, input.destinationNormalized);
  const masked = input.channel === "sms" ? maskPhone(input.destinationNormalized) : maskEmail(input.destinationNormalized);
  const info = rawDb.prepare(`
    INSERT INTO customer_contact_consents (
      tenant_id, lead_id, sale_id, vendor_order_id, channel, destination_hash, destination_masked,
      hash_scheme, consent_status, consent_basis, consent_source, consent_language,
      consent_captured_at, consent_proof_reference, revoked_at, created_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    input.tenantId, input.leadId, input.saleId, input.vendorOrderId, input.channel, hash, masked,
    scheme, input.status, input.basis, input.source, input.language,
    input.capturedAt, input.proofReference, input.status === "revoked" ? nowIso() : null,
    input.createdByUserId,
  );
  return Number(info.lastInsertRowid);
}

/** The newest consent record for a destination. Newest wins: a customer who
 *  revoked in June and re-subscribed in August is subscribed. */
export function latestConsent(tenantId: number, channel: ContactChannel, hashes: string[]): any | null {
  if (hashes.length === 0) return null;
  return rawDb.prepare(`
    SELECT * FROM customer_contact_consents
     WHERE tenant_id = ? AND channel = ? AND destination_hash IN (${hashes.map(() => "?").join(",")})
     ORDER BY consent_captured_at DESC, id DESC LIMIT 1
  `).get(tenantId, channel, ...hashes) ?? null;
}

export function isSuppressed(tenantId: number, channel: ContactChannel, hashes: string[]): boolean {
  if (hashes.length === 0) return false;
  const row = rawDb.prepare(`
    SELECT 1 FROM customer_contact_suppressions
     WHERE tenant_id = ? AND channel = ? AND lifted_at IS NULL
       AND destination_hash IN (${hashes.map(() => "?").join(",")}) LIMIT 1
  `).get(tenantId, channel, ...hashes);
  return !!row;
}

/**
 * Add a destination to the block list.
 *
 * Idempotent, and deliberately RE-ARMING: an INSERT that collides with a lifted
 * suppression clears lifted_at rather than doing nothing. A customer who opts
 * out again after an admin lifted their block must end up blocked.
 */
export function suppressDestination(input: {
  tenantId: number; leadId: number | null; vendorOrderId: number | null;
  channel: ContactChannel; destinationNormalized: string;
  reason: string; source: string; evidence: string | null; createdByUserId: number | null;
}): { id: number; created: boolean } {
  const { hash, scheme } = hashDestination(input.tenantId, input.channel, input.destinationNormalized);
  const masked = input.channel === "sms" ? maskPhone(input.destinationNormalized) : maskEmail(input.destinationNormalized);
  const existing = rawDb.prepare(
    `SELECT id, lifted_at FROM customer_contact_suppressions WHERE tenant_id = ? AND channel = ? AND destination_hash = ?`,
  ).get(input.tenantId, input.channel, hash) as any;
  if (existing) {
    if (existing.lifted_at) {
      rawDb.prepare(`
        UPDATE customer_contact_suppressions
           SET lifted_at = NULL, lifted_by_user_id = NULL, lift_reason = NULL,
               reason = ?, source = ?, evidence = ?, suppressed_at = ?
         WHERE id = ?
      `).run(input.reason, input.source, input.evidence, nowIso(), existing.id);
    }
    return { id: existing.id, created: false };
  }
  const info = rawDb.prepare(`
    INSERT INTO customer_contact_suppressions (
      tenant_id, lead_id, vendor_order_id, channel, destination_hash, destination_masked,
      hash_scheme, reason, source, evidence, created_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    input.tenantId, input.leadId, input.vendorOrderId, input.channel, hash, masked,
    scheme, input.reason, input.source, input.evidence, input.createdByUserId,
  );
  return { id: Number(info.lastInsertRowid), created: true };
}

/** Lifting is an audited admin act, never a side effect. There is no delete. */
export function liftSuppression(tenantId: number, id: number, userId: number, reason: string): boolean {
  const res = rawDb.prepare(`
    UPDATE customer_contact_suppressions
       SET lifted_at = ?, lifted_by_user_id = ?, lift_reason = ?
     WHERE id = ? AND tenant_id = ? AND lifted_at IS NULL
  `).run(nowIso(), userId, reason.slice(0, 500), id, tenantId);
  return res.changes > 0;
}

export function listSuppressions(tenantId: number, limit = 200): any[] {
  return rawDb.prepare(`
    SELECT id, channel, destination_masked, reason, source, suppressed_at, lifted_at, lift_reason
      FROM customer_contact_suppressions WHERE tenant_id = ?
     ORDER BY suppressed_at DESC, id DESC LIMIT ?
  `).all(tenantId, Math.min(500, Math.max(1, limit))) as any[];
}

/** True when every channel we could reach this order on is blocked. Feeds the
 *  recovery engine's OPTED_OUT refusal. */
export function optedOutEverywhere(tenantId: number, order: { customer_phone_hash: string | null; customer_email_hash: string | null }): boolean {
  const hasPhone = !!order.customer_phone_hash;
  const hasEmail = !!order.customer_email_hash;
  if (!hasPhone && !hasEmail) return false; // no destination at all is not an opt-out
  const phoneBlocked = !hasPhone || isSuppressed(tenantId, "sms", [order.customer_phone_hash!]);
  const emailBlocked = !hasEmail || isSuppressed(tenantId, "email", [order.customer_email_hash!]);
  return phoneBlocked && emailBlocked;
}

// ── Reporting ────────────────────────────────────────────────────────────────

export interface RecoveryMetrics {
  openCases: number;
  byPriority: Record<string, number>;
  byReason: Record<string, number>;
  resolvedTotal: number;
  recoveredTotal: number;
  recoveredInstalled: number;
  conversionRate: number;
  outreachSent: number;
  outreachDelivered: number;
  outreachReplied: number;
  outreachOptOuts: number;
  estimatedCommissionAtRiskCents: number;
  estimatedRecoveredCommissionCents: number;
}

export function recoveryMetrics(tenantId: number, repIds: number[] | null, estimatedOrderValueCents: number): RecoveryMetrics {
  const scope = repIds ? ` AND c.assigned_to_rep_id IN (${repIds.map(() => "?").join(",")})` : "";
  const scopeArgs = repIds ?? [];
  if (repIds && repIds.length === 0) {
    return emptyMetrics();
  }

  const open = rawDb.prepare(`
    SELECT c.priority AS p, c.recovery_reason AS r, COUNT(*) AS n
      FROM order_recovery_cases c
     WHERE c.tenant_id = ? AND c.status IN ('open','in_progress','snoozed')${scope}
     GROUP BY c.priority, c.recovery_reason
  `).all(tenantId, ...scopeArgs) as any[];

  const byPriority: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  let openCases = 0;
  for (const row of open) {
    const n = Number(row.n);
    openCases += n;
    byPriority[String(row.p)] = (byPriority[String(row.p)] ?? 0) + n;
    byReason[String(row.r)] = (byReason[String(row.r)] ?? 0) + n;
  }

  const resolved = rawDb.prepare(`
    SELECT c.resolution_code AS code, COUNT(*) AS n
      FROM order_recovery_cases c
     WHERE c.tenant_id = ? AND c.status IN ('resolved','not_recoverable')${scope}
     GROUP BY c.resolution_code
  `).all(tenantId, ...scopeArgs) as any[];

  let resolvedTotal = 0, recoveredTotal = 0, recoveredInstalled = 0;
  const RECOVERED = new Set([
    "recovered_installed", "recovered_rescheduled", "customer_completed_action",
    "documents_received", "resubmitted_as_new_order",
  ]);
  for (const row of resolved) {
    const n = Number(row.n);
    resolvedTotal += n;
    if (RECOVERED.has(String(row.code))) recoveredTotal += n;
    if (String(row.code) === "recovered_installed") recoveredInstalled += n;
  }

  const outreach = rawDb.prepare(`
    SELECT
      SUM(CASE WHEN o.status IN ('sent','delivered') THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN o.status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN o.response_at IS NOT NULL THEN 1 ELSE 0 END) AS replied,
      SUM(CASE WHEN o.opt_out_detected_at IS NOT NULL THEN 1 ELSE 0 END) AS optouts
    FROM order_recovery_outreach o
    JOIN order_recovery_cases c ON c.id = o.recovery_case_id
   WHERE o.tenant_id = ?${scope}
  `).get(tenantId, ...scopeArgs) as any;

  return {
    openCases,
    byPriority,
    byReason,
    resolvedTotal,
    recoveredTotal,
    recoveredInstalled,
    conversionRate: resolvedTotal > 0 ? recoveredTotal / resolvedTotal : 0,
    outreachSent: Number(outreach?.sent ?? 0),
    outreachDelivered: Number(outreach?.delivered ?? 0),
    outreachReplied: Number(outreach?.replied ?? 0),
    outreachOptOuts: Number(outreach?.optouts ?? 0),
    // An ESTIMATE, and labelled as one everywhere it is shown. Real commission
    // comes from the Commission File plane; this multiplies an admin-configured
    // per-order value by a count, and is zero until they configure one.
    estimatedCommissionAtRiskCents: openCases * Math.max(0, estimatedOrderValueCents),
    estimatedRecoveredCommissionCents: recoveredTotal * Math.max(0, estimatedOrderValueCents),
  };
}

function emptyMetrics(): RecoveryMetrics {
  return {
    openCases: 0, byPriority: {}, byReason: {}, resolvedTotal: 0, recoveredTotal: 0,
    recoveredInstalled: 0, conversionRate: 0, outreachSent: 0, outreachDelivered: 0,
    outreachReplied: 0, outreachOptOuts: 0,
    estimatedCommissionAtRiskCents: 0, estimatedRecoveredCommissionCents: 0,
  };
}

export { orderPayloadEncryptionReady };
