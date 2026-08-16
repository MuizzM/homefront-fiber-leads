// ── Commission File plane - persistence ──────────────────────────────────────
//
// Every write in this plane goes through here, every read is tenant-scoped at
// the SQL level, and the transaction discipline is the order plane's: one row
// is one short transaction, nothing wraps a whole file, and the import is
// resumable rather than atomic. Same WAL reasoning as vendorOrderStore.
//
// THE ONE WRITE THAT MATTERS is writeLineMoney: this module is the first and
// only writer of `vendor_order_commission_links`, the seam the order plane has
// read since it shipped ("no commission record yet" until something lands
// here). A link is keyed by the line's natural identity in source_reference,
// so a line restated across weekly files - Open in one, Closed in the next -
// UPDATES its one link rather than stacking amounts onto the order's timeline,
// while a chargeback, being its own line, lands as its own negative row on the
// SAME order. That is the runbook's promise kept: "a chargeback that arrives
// months later lands on the same order's timeline."
//
// And the one write it never makes: anything in the internal commission
// engine's tables beyond stamping customer_account_number onto a sale a human
// confirmed. Provider-paid truth is recorded ALONGSIDE what reps are paid,
// never into it.

import { rawDb } from "./db";
import { encryptOrderPayload, sha256Hex } from "./vendorOrderCrypto";
import { normalizeExternalId, toIsoOrNull } from "@shared/orderStatusSource";
import {
  commissionLinkFacts, commissionRestatementSupersedes,
  type CommissionCategory, type CommissionLineStatus, type NormalizedCommissionLine,
} from "@shared/commissionSource";
import type { ImportStatus } from "./vendorOrderMigrations";
import type { CommissionMatchResult } from "./commissionMatching";
import { COMMISSION_PROVIDER } from "./providers/perfectVisionCommissionFile";

const nowIso = () => new Date().toISOString();

// ── Imports ──────────────────────────────────────────────────────────────────

export function findCommissionImportByChecksum(tenantId: number, checksum: string): any | null {
  return rawDb.prepare(`
    SELECT * FROM commission_file_imports
     WHERE tenant_id = ? AND provider = ? AND source_file_checksum = ?
       AND status NOT IN ('failed','canceled')
     ORDER BY id DESC LIMIT 1
  `).get(tenantId, COMMISSION_PROVIDER, checksum) ?? null;
}

export function createCommissionImport(input: {
  tenantId: number;
  importMode: string;
  reportPeriodStart: string | null;
  reportPeriodEnd: string | null;
  sourceFileName: string;
  sourceFileChecksum: string;
  sourceFileStorageKey: string | null;
  importedByUserId: number | null;
  totalRows: number;
}): number {
  const info = rawDb.prepare(`
    INSERT INTO commission_file_imports (
      tenant_id, provider, import_mode, report_period_start, report_period_end,
      source_file_name, source_file_checksum, source_file_storage_key,
      status, imported_by_user_id, total_rows
    ) VALUES (?,?,?,?,?,?,?,?,'pending',?,?)
  `).run(
    input.tenantId, COMMISSION_PROVIDER, input.importMode,
    input.reportPeriodStart, input.reportPeriodEnd,
    input.sourceFileName, input.sourceFileChecksum, input.sourceFileStorageKey,
    input.importedByUserId, input.totalRows,
  );
  return Number(info.lastInsertRowid);
}

export function getCommissionImport(id: number, tenantId: number | null): any | null {
  const row = rawDb.prepare(`SELECT * FROM commission_file_imports WHERE id = ?`).get(id) as any;
  if (!row) return null;
  if (tenantId != null && row.tenant_id !== tenantId) return null;
  return row;
}

export function listCommissionImports(tenantId: number, limit = 50): any[] {
  return rawDb.prepare(`
    SELECT * FROM commission_file_imports WHERE tenant_id = ? ORDER BY id DESC LIMIT ?
  `).all(tenantId, Math.min(200, Math.max(1, limit))) as any[];
}

/** Atomic claim, same UPDATE-as-lock shape as the order plane's worker. */
export function claimNextPendingCommissionImport(): any | null {
  const candidate = rawDb.prepare(`
    SELECT id FROM commission_file_imports WHERE status = 'pending' ORDER BY id ASC LIMIT 1
  `).get() as any;
  if (!candidate) return null;
  const claimed = rawDb.prepare(`
    UPDATE commission_file_imports
       SET status = 'processing', started_at = COALESCE(started_at, ?), attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND status = 'pending'
  `).run(nowIso(), nowIso(), candidate.id);
  if (claimed.changes !== 1) return null;
  return getCommissionImport(candidate.id, null);
}

export function setCommissionImportStatus(id: number, status: ImportStatus, safeErrorSummary?: string | null): void {
  const done = status === "completed" || status === "completed_with_errors" || status === "failed" || status === "canceled";
  rawDb.prepare(`
    UPDATE commission_file_imports
       SET status = ?, safe_error_summary = COALESCE(?, safe_error_summary),
           completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END, updated_at = ?
     WHERE id = ?
  `).run(status, safeErrorSummary ?? null, done ? 1 : 0, nowIso(), nowIso(), id);
}

export type CommissionImportCounter =
  | "valid_rows" | "inserted_rows" | "updated_rows" | "duplicate_rows"
  | "matched_rows" | "unmatched_rows" | "links_written" | "error_rows";

export function bumpCommissionImportCounters(id: number, deltas: Partial<Record<CommissionImportCounter, number>>): void {
  const entries = Object.entries(deltas).filter(([, v]) => typeof v === "number" && v !== 0);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ${k} + ?`).join(", ");
  rawDb.prepare(`UPDATE commission_file_imports SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...entries.map(([, v]) => v as number), nowIso(), id);
}

export function reclaimStalledCommissionImports(maxAgeMinutes: number, maxAttempts: number): number {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
  const stalled = rawDb.prepare(`
    SELECT id, attempts FROM commission_file_imports
     WHERE status = 'processing' AND COALESCE(started_at, created_at) < ?
  `).all(cutoff) as any[];
  let reclaimed = 0;
  for (const row of stalled) {
    if (Number(row.attempts) >= maxAttempts) {
      setCommissionImportStatus(row.id, "failed", "The import did not finish after several attempts. Upload the file again or contact support.");
    } else {
      rawDb.prepare(`UPDATE commission_file_imports SET status = 'pending', updated_at = ? WHERE id = ?`).run(nowIso(), row.id);
    }
    reclaimed += 1;
  }
  return reclaimed;
}

// ── Rows: the evidence ───────────────────────────────────────────────────────

export function insertCommissionFileRow(input: {
  tenantId: number;
  importId: number;
  sourceRowNumber: number;
  line: NormalizedCommissionLine;
}): { rowId: number; encryptedPayload: boolean } {
  const { line } = input;
  const encrypted = encryptOrderPayload(line.sourceRowPayload);
  const row = rawDb.prepare(`
    INSERT INTO commission_file_rows (
      tenant_id, commission_file_import_id, source_row_number, raw_row_hash, line_key,
      account_number, document_number, product, category, line_status,
      pending_amount_cents, paid_amount_cents,
      act_deact_date, upload_date, payment_date,
      customer_name, sales_agent_name, encrypted_raw_payload
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(commission_file_import_id, source_row_number) DO UPDATE SET
      raw_row_hash = excluded.raw_row_hash,
      encrypted_raw_payload = excluded.encrypted_raw_payload,
      updated_at = datetime('now')
    RETURNING id
  `).get(
    input.tenantId, input.importId, input.sourceRowNumber, line.rawRowHash, line.lineKey,
    line.accountNumber, line.documentNumber, line.product, line.category, line.lineStatus,
    line.pendingAmountCents, line.paidAmountCents,
    toIsoOrNull(line.actDeactDate), toIsoOrNull(line.uploadDate), toIsoOrNull(line.paymentDate),
    line.customerName, line.salesAgentName, encrypted,
  ) as any;
  return { rowId: Number(row.id), encryptedPayload: encrypted != null };
}

// ── Lines: the working set ───────────────────────────────────────────────────

export interface UpsertLineResult {
  lineId: number;
  created: boolean;
  /** The line's current state now reflects THIS row. */
  applied: boolean;
  /** Byte-identical restatement of what the line already held. */
  duplicate: boolean;
  /** An OLDER restatement than the line already holds - evidence, no change. */
  stale: boolean;
}

export function getLine(id: number, tenantId: number | null): any | null {
  const row = rawDb.prepare(`SELECT * FROM commission_file_lines WHERE id = ?`).get(id) as any;
  if (!row) return null;
  if (tenantId != null && row.tenant_id !== tenantId) return null;
  return row;
}

export function findLineByKey(tenantId: number, lineKey: string): any | null {
  return rawDb.prepare(`
    SELECT * FROM commission_file_lines WHERE tenant_id = ? AND line_key = ?
  `).get(tenantId, lineKey) ?? null;
}

/**
 * Fold one file row into its line under the newest-upload-wins rule.
 *
 * An incoming restatement APPLIES when it supersedes what the line holds
 * (newer upload date; ties break Closed over Open, then knowing a payment
 * date) or ties it exactly - so within one file, later rows win
 * deterministically for given bytes. An older restatement only touches
 * last_seen_at: importing July's file after August's must not walk a paid
 * line back to pending.
 *
 * Match columns are untouched here. Matching is the caller's next step, and
 * only for rows that actually became the line's current state.
 */
export function upsertLineFromRow(input: {
  tenantId: number;
  importId: number;
  line: NormalizedCommissionLine;
}): UpsertLineResult {
  const { tenantId, importId, line } = input;
  const existing = findLineByKey(tenantId, line.lineKey);

  if (!existing) {
    const info = rawDb.prepare(`
      INSERT INTO commission_file_lines (
        tenant_id, provider, line_key,
        account_number, document_number, account_key, document_key,
        product, product_key, product_family, category, line_status,
        program, customer_name, sales_agent_name, comments, first_chargeback,
        pending_amount_cents, paid_amount_cents,
        act_deact_date, upload_date, payment_date,
        current_row_hash, first_import_id, last_import_id, last_seen_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      tenantId, COMMISSION_PROVIDER, line.lineKey,
      line.accountNumber, line.documentNumber, line.accountKey, line.documentKey,
      line.product, line.productKey, line.productFamily, line.category, line.lineStatus,
      line.program, line.customerName, line.salesAgentName, line.comments, line.firstChargeback ? 1 : 0,
      line.pendingAmountCents, line.paidAmountCents,
      toIsoOrNull(line.actDeactDate), toIsoOrNull(line.uploadDate), toIsoOrNull(line.paymentDate),
      line.rawRowHash, importId, importId, nowIso(),
    );
    return { lineId: Number(info.lastInsertRowid), created: true, applied: true, duplicate: false, stale: false };
  }

  if (existing.current_row_hash === line.rawRowHash) {
    rawDb.prepare(`UPDATE commission_file_lines SET last_seen_at = ?, last_import_id = ? WHERE id = ?`)
      .run(nowIso(), importId, existing.id);
    return { lineId: existing.id, created: false, applied: false, duplicate: true, stale: false };
  }

  const existingShape = {
    uploadDate: parseIso(existing.upload_date),
    lineStatus: String(existing.line_status) as CommissionLineStatus,
    paymentDate: parseIso(existing.payment_date),
  };
  const incomingShape = { uploadDate: line.uploadDate, lineStatus: line.lineStatus, paymentDate: line.paymentDate };
  // Strictly older loses; equal applies, so a same-day correction lands.
  if (commissionRestatementSupersedes(existingShape, incomingShape)) {
    rawDb.prepare(`UPDATE commission_file_lines SET last_seen_at = ? WHERE id = ?`).run(nowIso(), existing.id);
    return { lineId: existing.id, created: false, applied: false, duplicate: false, stale: true };
  }

  rawDb.prepare(`
    UPDATE commission_file_lines SET
      account_number = COALESCE(?, account_number),
      document_number = COALESCE(?, document_number),
      account_key = COALESCE(?, account_key),
      document_key = COALESCE(?, document_key),
      product = COALESCE(?, product),
      product_key = COALESCE(?, product_key),
      product_family = COALESCE(?, product_family),
      category = ?,
      line_status = ?,
      program = COALESCE(?, program),
      customer_name = COALESCE(?, customer_name),
      sales_agent_name = COALESCE(?, sales_agent_name),
      comments = COALESCE(?, comments),
      first_chargeback = CASE WHEN ? = 1 THEN 1 ELSE first_chargeback END,
      pending_amount_cents = ?,
      paid_amount_cents = ?,
      act_deact_date = COALESCE(?, act_deact_date),
      upload_date = COALESCE(?, upload_date),
      payment_date = COALESCE(?, payment_date),
      current_row_hash = ?,
      last_import_id = ?,
      last_seen_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    line.accountNumber, line.documentNumber, line.accountKey, line.documentKey,
    line.product, line.productKey, line.productFamily,
    line.category, line.lineStatus,
    line.program, line.customerName, line.salesAgentName, line.comments, line.firstChargeback ? 1 : 0,
    line.pendingAmountCents, line.paidAmountCents,
    toIsoOrNull(line.actDeactDate), toIsoOrNull(line.uploadDate), toIsoOrNull(line.paymentDate),
    line.rawRowHash, importId, nowIso(), nowIso(), existing.id,
  );
  return { lineId: existing.id, created: false, applied: true, duplicate: false, stale: false };
}

export function setLineMatch(lineId: number, verdict: CommissionMatchResult): void {
  rawDb.prepare(`
    UPDATE commission_file_lines
       SET match_status = ?, match_rule = ?, matched_sale_id = ?, matched_vendor_order_id = ?,
           matched_rep_id = ?, match_confidence_score = ?, exception_reason = ?,
           match_candidates_json = ?, updated_at = ?
     WHERE id = ?
  `).run(
    verdict.status, verdict.rule, verdict.saleId, verdict.vendorOrderId,
    verdict.repId, verdict.confidence, verdict.exceptionReason,
    verdict.candidates.length ? JSON.stringify(verdict.candidates) : null,
    nowIso(), lineId,
  );
}

/** The review queue: every line waiting on a person, newest first. Batch
 *  totals never appear - they are 'ignored' by the matcher, not work. */
export function listReviewLines(tenantId: number, limit = 100): any[] {
  return rawDb.prepare(`
    SELECT l.*, i.source_file_name, i.created_at AS import_created_at
      FROM commission_file_lines l
      LEFT JOIN commission_file_imports i ON i.id = l.last_import_id
     WHERE l.tenant_id = ? AND l.match_status IN ('exception','unmatched','matched_low_confidence')
     ORDER BY l.id DESC LIMIT ?
  `).all(tenantId, Math.min(500, Math.max(1, limit))) as any[];
}

export function listLinesByAccountKey(tenantId: number, accountKey: string): any[] {
  return rawDb.prepare(`
    SELECT * FROM commission_file_lines WHERE tenant_id = ? AND account_key = ? ORDER BY id ASC
  `).all(tenantId, accountKey) as any[];
}

export function listLinesForImport(tenantId: number, importId: number, limit = 500): any[] {
  return rawDb.prepare(`
    SELECT * FROM commission_file_lines
     WHERE tenant_id = ? AND last_import_id = ? ORDER BY id ASC LIMIT ?
  `).all(tenantId, importId, Math.min(2000, Math.max(1, limit))) as any[];
}

// ── Money: the vendor_order_commission_links writer ──────────────────────────

export interface LineMoneyResult {
  linkId: number | null;
  wrote: boolean;
  status: string | null;
  amountCents: number | null;
}

/**
 * Attach a MATCHED line's money to the order timeline.
 *
 * One link per line, upserted on (tenant_id, source_reference = line_key).
 * The caller has already established the match is payable; this function
 * resolves where the money lands (the matched vendor order, else the order
 * attached to the matched sale, else the account-keyed order) and carries the
 * sale's external order id onto the link so an order imported LATER can still
 * find its money by key.
 *
 * Batch totals and category-unknown lines write nothing, by construction:
 * commissionLinkFacts returns null for them.
 */
export function applyLineMoney(tenantId: number, lineRow: any): LineMoneyResult {
  const facts = commissionLinkFacts({
    category: String(lineRow.category) as CommissionCategory,
    lineStatus: String(lineRow.line_status) as CommissionLineStatus,
    pendingAmountCents: lineRow.pending_amount_cents ?? null,
    paidAmountCents: lineRow.paid_amount_cents ?? null,
    actDeactDate: parseIso(lineRow.act_deact_date),
    uploadDate: parseIso(lineRow.upload_date),
    paymentDate: parseIso(lineRow.payment_date),
  });
  if (!facts) return { linkId: null, wrote: false, status: null, amountCents: null };

  const saleId = lineRow.matched_sale_id == null ? null : Number(lineRow.matched_sale_id);
  let vendorOrderId = lineRow.matched_vendor_order_id == null ? null : Number(lineRow.matched_vendor_order_id);
  if (vendorOrderId == null && saleId != null) {
    const bySale = rawDb.prepare(`
      SELECT id FROM vendor_orders WHERE tenant_id = ? AND sale_id = ? ORDER BY id DESC LIMIT 1
    `).get(tenantId, saleId) as any;
    if (bySale) vendorOrderId = Number(bySale.id);
  }
  if (vendorOrderId == null && lineRow.account_key) {
    const byAccount = rawDb.prepare(`
      SELECT id FROM vendor_orders WHERE tenant_id = ? AND account_key = ? ORDER BY id DESC LIMIT 1
    `).get(tenantId, String(lineRow.account_key)) as any;
    if (byAccount) vendorOrderId = Number(byAccount.id);
  }

  let externalOrderKey: string | null = null;
  let externalTransactionKey: string | null = null;
  if (saleId != null) {
    const sale = rawDb.prepare(`
      SELECT external_order_id, external_transaction_id FROM commission_sales WHERE id = ? AND tenant_id = ?
    `).get(saleId, tenantId) as any;
    externalOrderKey = normalizeExternalId(sale?.external_order_id);
    externalTransactionKey = normalizeExternalId(sale?.external_transaction_id);
  }

  const effectiveAt = toIsoOrNull(facts.effectiveAt) ?? nowIso();
  const link = rawDb.prepare(`
    INSERT INTO vendor_order_commission_links (
      tenant_id, vendor_order_id, external_order_key, external_transaction_key,
      commission_status, amount_cents, period_label, effective_at, source_reference
    ) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id, source_reference) WHERE source_reference IS NOT NULL DO UPDATE SET
      vendor_order_id = COALESCE(excluded.vendor_order_id, vendor_order_id),
      external_order_key = COALESCE(excluded.external_order_key, external_order_key),
      external_transaction_key = COALESCE(excluded.external_transaction_key, external_transaction_key),
      commission_status = excluded.commission_status,
      amount_cents = excluded.amount_cents,
      period_label = COALESCE(excluded.period_label, period_label),
      effective_at = excluded.effective_at
    RETURNING id
  `).get(
    tenantId, vendorOrderId, externalOrderKey, externalTransactionKey,
    facts.status, facts.amountCents, facts.periodLabel, effectiveAt, String(lineRow.line_key),
  ) as any;

  rawDb.prepare(`
    UPDATE commission_file_lines
       SET commission_link_id = ?, link_status = ?, link_amount_cents = ?,
           matched_vendor_order_id = COALESCE(?, matched_vendor_order_id), updated_at = ?
     WHERE id = ?
  `).run(Number(link.id), facts.status, facts.amountCents, vendorOrderId, nowIso(), lineRow.id);

  return { linkId: Number(link.id), wrote: true, status: facts.status, amountCents: facts.amountCents };
}

/**
 * Stamp the provider's account number onto the sale and its vendor order.
 *
 * The confirmation dividend, same principle as the order plane's exception
 * resolver: a human matched these once, so the NEXT commission file matches
 * them at the top rung without anybody. COALESCE everywhere - a stamp never
 * overwrites an identity either record already carries.
 */
export function stampAccountNumber(input: {
  tenantId: number;
  saleId: number | null;
  vendorOrderId: number | null;
  accountNumber: string | null;
  accountKey: string | null;
}): void {
  if (!input.accountNumber || !input.accountKey) return;
  if (input.saleId != null) {
    rawDb.prepare(`
      UPDATE commission_sales SET customer_account_number = COALESCE(customer_account_number, ?)
       WHERE id = ? AND tenant_id = ?
    `).run(input.accountNumber, input.saleId, input.tenantId);
  }
  if (input.vendorOrderId != null) {
    try {
      rawDb.prepare(`
        UPDATE vendor_orders
           SET customer_account_number = COALESCE(customer_account_number, ?),
               account_key = COALESCE(account_key, ?), updated_at = ?
         WHERE id = ? AND tenant_id = ?
      `).run(input.accountNumber, input.accountKey, nowIso(), input.vendorOrderId, input.tenantId);
    } catch (e: any) {
      // The account-key partial unique index can, in principle, collide when
      // an id-less order already claimed this key. The stamp is an
      // optimization, never load-bearing, so a collision is a warning and the
      // resolution stands.
      if (!/UNIQUE constraint failed/i.test(String(e?.message ?? ""))) throw e;
      console.warn(`[commission-file] account key already claimed by another order (tenant ${input.tenantId})`);
    }
  }
}

/** A line row back in the normalized shape the matcher reads. Used by rematch
 *  and the resolve sweep, where the original file is not in hand. */
export function lineRowToNormalized(row: any): NormalizedCommissionLine {
  return {
    provider: "perfectvision_commission_file",
    organizationId: Number(row.tenant_id),
    accountNumber: row.account_number ?? null,
    documentNumber: row.document_number ?? null,
    accountKey: row.account_key ?? null,
    documentKey: row.document_key ?? null,
    product: row.product ?? null,
    productKey: row.product_key ?? null,
    productFamily: row.product_family ?? null,
    category: String(row.category) as CommissionCategory,
    lineStatus: String(row.line_status) as CommissionLineStatus,
    program: row.program ?? null,
    customerName: row.customer_name ?? null,
    salesAgentName: row.sales_agent_name ?? null,
    comments: row.comments ?? null,
    firstChargeback: Number(row.first_chargeback ?? 0) === 1,
    pendingAmountCents: row.pending_amount_cents ?? null,
    paidAmountCents: row.paid_amount_cents ?? null,
    actDeactDate: parseIso(row.act_deact_date),
    uploadDate: parseIso(row.upload_date),
    paymentDate: parseIso(row.payment_date),
    lineKey: String(row.line_key),
    rawRowHash: String(row.current_row_hash ?? ""),
    sourceRowPayload: {},
  };
}

function parseIso(value: unknown): Date | null {
  if (value == null) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export { sha256Hex };
