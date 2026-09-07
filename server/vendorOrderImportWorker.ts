// ── The import worker ────────────────────────────────────────────────────────
//
// Imports do NOT run in the request that uploads them. A 40,000-row export
// takes minutes of synchronous SQLite work, and better-sqlite3 blocks the one
// thread Node runs the app on - so doing it inline would wedge every API route
// including /api/health, which is the exact failure server/db.ts documents from
// the scanner. The upload handler validates, stores, and returns; this worker
// does the work.
//
// HOW IT STAYS OUT OF THE WAY
//   • It claims work with an atomic UPDATE, so two processes racing for the
//     same import means one winner and one no-op. No lock table to leak.
//   • It processes in small chunks and yields the event loop between them, so
//     an import in flight costs latency on other routes rather than
//     availability.
//   • It runs in ONE role. In a cluster the control process runs it; a scan
//     worker never does. Same placement rule the WAL guard follows.
//   • Retries are bounded and recorded. An import that has failed three times
//     is marked failed with a message an admin can act on, not retried forever.
//
// WHAT IT NEVER DOES. It never fetches from PerfectVision. The provider's
// fetchOrderReport refuses while the sync flag is off, and this worker only
// ever reads a file an authorized administrator uploaded.

import * as store from "./vendorOrderStore";
import { readSourceFile } from "./vendorOrderFiles";
import { getOrderStatusProvider, MAX_IMPORT_ROWS, ProviderError } from "./providers/perfectVisionSubmittedOrders";
import { matchVendorOrder, matchIsActionable } from "./orderMatching";
import { evaluateOneOrder } from "./orderRecoveryEngine";
import { looksLikeXlsx } from "./xlsx";
import { toIsoOrNull, type NormalizedVendorOrder } from "@shared/orderStatusSource";
import { DEFAULT_RECOVERY_POLICY } from "@shared/orderRecovery";

/** Rows processed between yields. Small enough that the event loop is never
 *  held for long; large enough that a 40,000-row file is 160 pauses, not
 *  40,000. */
const CHUNK_ROWS = 250;
/** How often the worker looks for work when idle. */
const POLL_MS = 5_000;
/** An import still `processing` after this is presumed dead and requeued. */
const STALL_MINUTES = 15;
/** After this many attempts an import is failed rather than requeued. */
const MAX_ATTEMPTS = 3;

/**
 * Files waiting for the worker, when encryption at rest is unavailable.
 *
 * Normally the uploaded file is stored encrypted and the worker reads it back,
 * which survives a restart. With no encryption key configured this plane
 * refuses to write customer PII to disk at all (see vendorOrderCrypto), so the
 * bytes live here for the few seconds until the worker picks them up. A restart
 * in that window loses them and the import fails with a message telling the
 * admin to upload again - which is the honest outcome, and a reason to
 * configure the key.
 */
const pendingContent = new Map<number, Buffer>();
/** Bounds the map: an operator uploading faster than the worker drains, with
 *  no encryption key, must not grow the heap without limit. */
const MAX_PENDING_BUFFERS = 8;

export function stageImportContent(importId: number, content: Buffer): boolean {
  if (pendingContent.size >= MAX_PENDING_BUFFERS) return false;
  pendingContent.set(importId, content);
  return true;
}

let running = false;
let busy = false;
let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;

export interface WorkerHandle { stop(): void }

/**
 * Start the poll loop.
 *
 * `unref` on the timer so the process can still exit cleanly: a worker that
 * keeps a test runner or a one-shot script alive forever is its own bug.
 */
export function startVendorOrderImportWorker(): WorkerHandle {
  if (running) return { stop: stopVendorOrderImportWorker };
  running = true;
  const tick = () => {
    if (!running) return;
    void pump().catch((e: any) => console.warn("[vendor-order-worker] tick failed:", e?.message));
  };
  timer = setInterval(tick, POLL_MS);
  if (typeof timer.unref === "function") timer.unref();
  // First pass shortly after boot rather than a full poll interval later, so an
  // import queued just before a restart is not stuck for five seconds.
  bootTimer = setTimeout(tick, 1_000);
  bootTimer.unref?.();
  return { stop: stopVendorOrderImportWorker };
}

export function stopVendorOrderImportWorker(): void {
  running = false;
  if (timer) { clearInterval(timer); timer = null; }
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
}

/** One pass. Exported so a test can drive the worker deterministically instead
 *  of waiting on a timer. */
export async function pump(): Promise<number> {
  if (busy) return 0;
  busy = true;
  let processed = 0;
  try {
    store.reclaimStalledImports(STALL_MINUTES, MAX_ATTEMPTS);
    for (;;) {
      const job = store.claimNextPendingImport();
      if (!job) break;
      await runImport(job);
      processed += 1;
      // One import per pass keeps a backlog from monopolising the process.
      break;
    }
  } finally {
    busy = false;
  }
  return processed;
}

// ── One import ───────────────────────────────────────────────────────────────

export async function runImport(job: any): Promise<void> {
  const importId = Number(job.id);
  const tenantId = Number(job.tenant_id);

  try {
    const content = pendingContent.get(importId) ?? readSourceFile(job.source_file_storage_key);
    pendingContent.delete(importId);
    if (!content) {
      store.setImportStatus(importId, "failed",
        "The uploaded file is no longer available. Upload the report again. If this keeps happening, ask an administrator to configure VENDOR_ORDER_ENCRYPTION_KEY so uploads survive a restart.");
      return;
    }

    const mapping = job.mapping_version != null
      ? store.getMappingByVersion(tenantId, Number(job.mapping_version))
      : store.getActiveMapping(tenantId);
    if (!mapping) {
      store.setImportStatus(importId, "failed", "No column mapping was saved for this provider. Set the mapping up and upload again.");
      return;
    }

    const provider = getOrderStatusProvider(String(job.provider));
    const parsed = await provider.parseOrderReport({
      report: {
        format: looksLikeXlsx(content.subarray(0, 8)) ? "xlsx" : "csv",
        content,
        fileName: String(job.source_file_name ?? "report"),
        sourceReportId: null,
        retrievedAt: new Date(),
      },
      maxRows: MAX_IMPORT_ROWS,
    });

    if (parsed.truncated) {
      store.setImportStatus(importId, "failed",
        `This report has more than ${MAX_IMPORT_ROWS.toLocaleString()} rows. Split it by date range and import each part.`);
      return;
    }

    const config = store.getOrgRecoveryConfig(tenantId);
    const policy = config.policy ?? DEFAULT_RECOVERY_POLICY;
    const now = new Date();
    const touchedOrderIds = new Set<number>();
    let errorRows = 0;
    let encryptionUnavailable = false;

    for (let i = 0; i < parsed.rows.length; i += 1) {
      const sourceRowNumber = i + 1;
      try {
        const normalized = await provider.normalizeOrderRow({
          organizationId: tenantId,
          mapping: mapping.mapping,
          row: parsed.rows[i],
          sourceRowNumber,
          sourceReportId: job.source_file_checksum ? String(job.source_file_checksum).slice(0, 16) : null,
          timeZone: mapping.mapping.timeZone || config.reportTimezone,
        });
        const outcome = importOneRow({ tenantId, importId, sourceRowNumber, normalized, policy, now });
        if (outcome.vendorOrderId != null) touchedOrderIds.add(outcome.vendorOrderId);
        if (!outcome.encryptedPayload) encryptionUnavailable = true;
      } catch (e: any) {
        errorRows += 1;
        store.bumpImportCounters(importId, { error_rows: 1 });
        // The row number is safe to log. The row is not.
        console.warn(`[vendor-order-worker] import ${importId} row ${sourceRowNumber} failed:`, e?.message);
      }

      if (sourceRowNumber % CHUNK_ROWS === 0) await yieldToEventLoop();
    }

    // Recovery evaluation runs over exactly the orders this file touched. A
    // full-organization scan happens on its own schedule; making every upload
    // pay for one would make a five-row correction as expensive as the original
    // import.
    let candidates = 0;
    let seen = 0;
    for (const orderId of touchedOrderIds) {
      const order = store.getOrder(orderId, tenantId);
      if (order) {
        if (evaluateOneOrder(tenantId, order, policy, now) === "opened") candidates += 1;
      }
      seen += 1;
      if (seen % CHUNK_ROWS === 0) await yieldToEventLoop();
    }
    store.bumpImportCounters(importId, { recovery_candidates: candidates });

    const notes: string[] = [];
    if (parsed.skippedRows > 0) notes.push(`${parsed.skippedRows} row(s) were malformed and skipped.`);
    if (errorRows > 0) notes.push(`${errorRows} row(s) could not be imported.`);
    if (encryptionUnavailable) {
      notes.push("Original row data was not retained because no encryption key is configured on the server.");
    }

    store.setImportStatus(
      importId,
      errorRows > 0 || parsed.skippedRows > 0 ? "completed_with_errors" : "completed",
      notes.length ? notes.join(" ") : null,
    );
  } catch (e: any) {
    // Provider errors carry a message written to be shown. Anything else gets a
    // generic one: an unexpected exception's text can contain a file path, a
    // SQL fragment, or a row of customer data.
    const safe = e instanceof ProviderError
      ? e.safeMessage
      : "The import could not be completed. Check the file and try again.";
    console.warn(`[vendor-order-worker] import ${importId} failed:`, e?.message);
    const attempts = Number(job.attempts ?? 0);
    if (attempts >= MAX_ATTEMPTS || e instanceof ProviderError) {
      // A provider error is deterministic - the same file will fail the same
      // way - so retrying it is just three copies of the same message.
      store.setImportStatus(importId, "failed", safe);
    } else {
      store.setImportStatus(importId, "pending", safe);
    }
  } finally {
    pendingContent.delete(importId);
  }
}

interface RowOutcome { vendorOrderId: number | null; encryptedPayload: boolean }

/**
 * One row, end to end: record it, match it, fold it into the order, and write
 * the transition.
 *
 * Each row is its own short transaction by virtue of being separate statements
 * against WAL - deliberately NOT wrapped in one transaction for the whole file.
 * A 40,000-row writer transaction is what starves the checkpointer.
 */
export function importOneRow(input: {
  tenantId: number;
  importId: number;
  sourceRowNumber: number;
  normalized: NormalizedVendorOrder;
  policy: typeof DEFAULT_RECOVERY_POLICY;
  now: Date;
}): RowOutcome {
  const { tenantId, importId, sourceRowNumber, normalized } = input;

  const inserted = store.insertImportRow({ tenantId, importId, sourceRowNumber, order: normalized });
  store.bumpImportCounters(importId, { valid_rows: 1 });

  const match = matchVendorOrder(tenantId, normalized);
  const actionable = matchIsActionable(match);

  // Attribution only follows an actionable match. A suggestion links nothing:
  // a rep must never find an order in their queue because two addresses looked
  // similar.
  const upsert = store.upsertOrder({
    tenantId,
    order: normalized,
    importId,
    match: {
      saleId: actionable ? match.saleId : null,
      leadId: actionable ? match.leadId : null,
      repId: actionable ? match.repId : null,
      status: match.status,
      confidence: match.confidence,
    },
  });

  store.setRowMatch(inserted.rowId, {
    matchStatus: match.status,
    matchRule: match.rule,
    matchedSaleId: match.saleId,
    matchedLeadId: match.leadId,
    matchedRepId: match.repId,
    confidence: match.confidence,
    exceptionReason: match.exceptionReason,
    vendorOrderId: upsert.vendorOrderId,
  });

  store.bumpImportCounters(importId, {
    inserted_rows: upsert.created ? 1 : 0,
    updated_rows: !upsert.created && upsert.changed ? 1 : 0,
    duplicate_rows: upsert.duplicate ? 1 : 0,
    matched_rows: actionable ? 1 : 0,
    unmatched_rows: actionable ? 0 : 1,
  });

  // The transition. Written only when something actually changed, and keyed so
  // that re-importing the same file adds nothing.
  if (upsert.created || (upsert.changed && upsert.previousStatus !== normalized.normalizedStatus)) {
    store.appendOrderEvent({
      tenantId,
      vendorOrderId: upsert.vendorOrderId,
      importId,
      importRowId: inserted.rowId,
      eventType: upsert.created ? "order_imported" : "status_changed",
      oldStatus: upsert.previousStatus,
      newStatus: normalized.normalizedStatus,
      sourceStatus: normalized.sourceStatus ?? null,
      effectiveAt: toIsoOrNull(normalized.sourceLastUpdatedAt)
        ?? toIsoOrNull(normalized.installDate)
        ?? toIsoOrNull(normalized.submittedDate)
        ?? new Date().toISOString(),
      failureReason: normalized.failureReason ?? null,
      requiredCustomerAction: normalized.requiredCustomerAction ?? null,
      idempotencySalt: normalized.rawRowHash,
    });
  }

  return { vendorOrderId: upsert.vendorOrderId, encryptedPayload: inserted.encryptedPayload };
}

/** Hand the event loop back. setImmediate rather than a timer: it runs after
 *  pending I/O callbacks, which is exactly the point - health checks and API
 *  reads queued during the last chunk get served before the next one starts. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
