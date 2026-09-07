// ── The commission file import worker ────────────────────────────────────────
//
// Same architecture as vendorOrderImportWorker, for the same reasons: imports
// never run in the upload request, work is claimed by an atomic UPDATE, rows
// process in chunks that yield the event loop, retries are bounded, and the
// worker runs in the control role only. A commission file is small next to a
// submitted-orders export - dozens to hundreds of rows - but "small" is a fact
// about today's files, not a contract, and the pattern costs nothing.
//
// WHAT ONE ROW BECOMES, in order:
//   1. Evidence: commission_file_rows, verbatim and encrypted.
//   2. State: folded into its commission_file_lines row under the
//      newest-upload-wins rule. A row that is older than the line's current
//      state stops here - it is history arriving late, not news.
//   3. A verdict: matched against orders and sales. Account-number rungs
//      match outright; a name-and-dates fit goes to the review queue.
//   4. Money, ONLY on a payable match: one vendor_order_commission_links row
//      per line, upserted, negative for a chargeback. Everything below
//      payable waits for a human in the review queue and writes nothing.

import * as store from "./commissionFileStore";
import { readSourceFile } from "./vendorOrderFiles";
import { getOrgRecoveryConfig } from "./vendorOrderStore";
import { ProviderError } from "./providers/perfectVisionSubmittedOrders";
import {
  MAX_COMMISSION_IMPORT_ROWS, normalizeCommissionRow, parseCommissionReport,
} from "./providers/perfectVisionCommissionFile";
import { commissionMatchIsPayable, matchCommissionLine } from "./commissionMatching";
import { looksLikeXlsx } from "./xlsx";

const CHUNK_ROWS = 250;
const POLL_MS = 5_000;
const STALL_MINUTES = 15;
const MAX_ATTEMPTS = 3;

/** In-memory bytes for imports queued while encryption at rest is
 *  unavailable. Same contract and same bound as the order worker's map. */
const pendingContent = new Map<number, Buffer>();
const MAX_PENDING_BUFFERS = 8;

export function stageCommissionImportContent(importId: number, content: Buffer): boolean {
  if (pendingContent.size >= MAX_PENDING_BUFFERS) return false;
  pendingContent.set(importId, content);
  return true;
}

let running = false;
let busy = false;
let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;

export interface WorkerHandle { stop(): void }

export function startCommissionFileImportWorker(): WorkerHandle {
  if (running) return { stop: stopCommissionFileImportWorker };
  running = true;
  const tick = () => {
    if (!running) return;
    void pump().catch((e: any) => console.warn("[commission-file-worker] tick failed:", e?.message));
  };
  timer = setInterval(tick, POLL_MS);
  if (typeof timer.unref === "function") timer.unref();
  bootTimer = setTimeout(tick, 1_000);
  bootTimer.unref?.();
  return { stop: stopCommissionFileImportWorker };
}

export function stopCommissionFileImportWorker(): void {
  running = false;
  if (timer) { clearInterval(timer); timer = null; }
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
}

/** One pass. Exported so tests drive the worker instead of waiting a timer. */
export async function pump(): Promise<number> {
  if (busy) return 0;
  busy = true;
  let processed = 0;
  try {
    store.reclaimStalledCommissionImports(STALL_MINUTES, MAX_ATTEMPTS);
    const job = store.claimNextPendingCommissionImport();
    if (job) {
      await runImport(job);
      processed = 1;
    }
  } finally {
    busy = false;
  }
  return processed;
}

export async function runImport(job: any): Promise<void> {
  const importId = Number(job.id);
  const tenantId = Number(job.tenant_id);

  try {
    const content = pendingContent.get(importId) ?? readSourceFile(job.source_file_storage_key);
    pendingContent.delete(importId);
    if (!content) {
      store.setCommissionImportStatus(importId, "failed",
        "The uploaded file is no longer available. Upload the commission file again. If this keeps happening, ask an administrator to configure VENDOR_ORDER_ENCRYPTION_KEY so uploads survive a restart.");
      return;
    }

    const parsed = parseCommissionReport({
      content,
      format: looksLikeXlsx(content.subarray(0, 8)) ? "xlsx" : "csv",
      maxRows: MAX_COMMISSION_IMPORT_ROWS,
    });

    const timeZone = getOrgRecoveryConfig(tenantId).reportTimezone;
    let errorRows = 0;
    let encryptionUnavailable = false;

    for (let i = 0; i < parsed.rows.length; i += 1) {
      const sourceRowNumber = i + 1;
      try {
        const line = normalizeCommissionRow({
          organizationId: tenantId,
          row: parsed.rows[i],
          byField: parsed.byField,
          timeZone,
        });
        const outcome = importOneCommissionRow({ tenantId, importId, sourceRowNumber, line });
        if (!outcome.encryptedPayload) encryptionUnavailable = true;
      } catch (e: any) {
        errorRows += 1;
        store.bumpCommissionImportCounters(importId, { error_rows: 1 });
        // The row number is safe to log. The row is not.
        console.warn(`[commission-file-worker] import ${importId} row ${sourceRowNumber} failed:`, e?.message);
      }
      if (sourceRowNumber % CHUNK_ROWS === 0) await yieldToEventLoop();
    }

    const notes: string[] = [];
    if (parsed.skippedRows > 0) notes.push(`${parsed.skippedRows} row(s) were malformed and skipped.`);
    if (errorRows > 0) notes.push(`${errorRows} row(s) could not be imported.`);
    if (encryptionUnavailable) {
      notes.push("Original row data was not retained because no encryption key is configured on the server.");
    }

    store.setCommissionImportStatus(
      importId,
      errorRows > 0 || parsed.skippedRows > 0 ? "completed_with_errors" : "completed",
      notes.length ? notes.join(" ") : null,
    );
  } catch (e: any) {
    const safe = e instanceof ProviderError
      ? e.safeMessage
      : "The import could not be completed. Check the file and try again.";
    console.warn(`[commission-file-worker] import ${importId} failed:`, e?.message);
    const attempts = Number(job.attempts ?? 0);
    if (attempts >= MAX_ATTEMPTS || e instanceof ProviderError) {
      // Deterministic failures do not improve with repetition.
      store.setCommissionImportStatus(importId, "failed", safe);
    } else {
      store.setCommissionImportStatus(importId, "pending", safe);
    }
  } finally {
    pendingContent.delete(importId);
  }
}

interface RowOutcome { lineId: number | null; encryptedPayload: boolean }

/** One row, end to end. Each step is its own short write, never one file-wide
 *  transaction - the same WAL discipline as the order plane. */
export function importOneCommissionRow(input: {
  tenantId: number;
  importId: number;
  sourceRowNumber: number;
  line: import("@shared/commissionSource").NormalizedCommissionLine;
}): RowOutcome {
  const { tenantId, importId, sourceRowNumber, line } = input;

  const evidence = store.insertCommissionFileRow({ tenantId, importId, sourceRowNumber, line });
  store.bumpCommissionImportCounters(importId, { valid_rows: 1 });

  const upsert = store.upsertLineFromRow({ tenantId, importId, line });
  store.bumpCommissionImportCounters(importId, {
    inserted_rows: upsert.created ? 1 : 0,
    updated_rows: !upsert.created && upsert.applied ? 1 : 0,
    duplicate_rows: upsert.duplicate || upsert.stale ? 1 : 0,
  });

  // Match and attach money only when THIS row is the line's current state. A
  // stale or byte-identical restatement re-proves what is already recorded.
  if (upsert.applied) {
    const verdict = matchCommissionLine(tenantId, line);
    store.setLineMatch(upsert.lineId, verdict);
    const payable = commissionMatchIsPayable(verdict);
    if (line.category !== "payment_batch") {
      store.bumpCommissionImportCounters(importId, {
        matched_rows: payable ? 1 : 0,
        unmatched_rows: payable ? 0 : 1,
      });
    }
    if (payable) {
      const lineRow = store.getLine(upsert.lineId, tenantId);
      if (lineRow) {
        const money = store.applyLineMoney(tenantId, lineRow);
        if (money.wrote) store.bumpCommissionImportCounters(importId, { links_written: 1 });
      }
    }
  }

  return { lineId: upsert.lineId, encryptedPayload: evidence.encryptedPayload };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
