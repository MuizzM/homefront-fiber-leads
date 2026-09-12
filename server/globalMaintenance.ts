import { setImmediate as yieldToLoop } from "node:timers/promises";
import { rawDb } from "./db";
import { interactiveTransaction, retrySqliteOperation } from "./interactiveDb";
import { structuredLog } from "./structuredLog";
import { drainOtpDeliveries } from "./otpDeliveryWorker";
import { purgeAssignmentReceipts, assignmentReceiptCleanupDue } from "./assignmentOperationStore";
import { purgeOtpDeliveryReceipts } from "./otpDeliveryStore";
import { purgeTerminalScannerProgress } from "./scannerReliability";

/** One bounded, atomic delete; a quiet tick takes no writer lock. */
export function purgeExpiredAuthBatch(table: "sessions" | "otp_codes", nowIso: string): number {
  if (!rawDb.prepare(`SELECT 1 FROM ${table} WHERE expires_at < ? LIMIT 1`).get(nowIso)) return 0;
  return rawDb.prepare(`DELETE FROM ${table} WHERE id IN (
    SELECT id FROM ${table} WHERE expires_at < ? ORDER BY expires_at LIMIT 500
  ) AND expires_at < ?`).run(nowIso, nowIso).changes;
}

/** Cluster primary or standalone process only. Keeping the guard in the actual
 * installer prevents a future worker startup call from duplicating global jobs. */
export async function startGlobalMaintenance(isClusterWorker: boolean): Promise<() => void> {
  if (isClusterWorker) return () => {};
  const { startCallingMaintenance } = await import("./callingMaintenance");
  const { verifyCallingAuditIntegrity } = await import("./calling/store");
  const { drainOnce, SUBSCRIBER_NAME } = await import("./incentiveSubscriber");
  const { nextBatch } = await import("./domainEventStore");
  const stopCalling = await startCallingMaintenance();
  let stopped = false;
  const otpStop = new AbortController();
  const timers: ReturnType<typeof setInterval>[] = [];
  const install = (name: string, intervalMs: number, work: () => Promise<void>) => {
    let running = false;
    const tick = async () => {
      if (stopped || running) return;
      running = true;
      try { await work(); }
      catch (error) {
        structuredLog(`${name}_failed`, { message: error instanceof Error ? error.message : "unknown error" }, "warn");
      } finally { running = false; }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref();
    timers.push(timer);
  };

  install("auth.delivery_drain", 2_000, async () => {
    await drainOtpDeliveries(rawDb, { signal: otpStop.signal });
  });

  install("scanner.progress_cleanup", 60_000, async () => {
    await purgeTerminalScannerProgress(rawDb);
    const cutoff = Date.now() - 30 * 86400_000;
    if (rawDb.prepare("SELECT 1 FROM scanner_count_checks WHERE checked_at<? LIMIT 1").get(cutoff))
      await retrySqliteOperation(rawDb, () => rawDb.prepare("DELETE FROM scanner_count_checks WHERE run_id IN (SELECT run_id FROM scanner_count_checks WHERE checked_at<? LIMIT 500)").run(cutoff));
  });

  install("reliability.receipt_cleanup", 60_000, async () => {
    await retrySqliteOperation(rawDb, () => purgeOtpDeliveryReceipts(rawDb));
    if (assignmentReceiptCleanupDue(rawDb)) await interactiveTransaction(rawDb, () => purgeAssignmentReceipts(rawDb));
  });

  install("incentives.drain", 30_000, async () => {
    let processed = 0, awarded = 0, reversed = 0;
    // Retain the previous 10,000-event upper bound, but release the writer and
    // yield between events. Each award, lease and cursor advances atomically.
    for (let count = 0; count < 10_000 && !stopped; count++) {
      if (nextBatch(SUBSCRIBER_NAME, 1).length === 0) break;
      const result = await interactiveTransaction(rawDb, () => stopped ? null : drainOnce(new Date().toISOString(), 1));
      if (!result) break;
      processed += result.processed;
      awarded += result.awarded;
      reversed += result.reversed;
      if (result.failed.length || result.deferred.length || (result.processed === 0 && result.skipped.length === 0)) break;
      await yieldToLoop();
    }
    if (processed) structuredLog("incentives.drained", { processed, awarded, reversed });
  });

  install("calling.audit_integrity", 6 * 60 * 60_000, async () => {
    const result = verifyCallingAuditIntegrity();
    structuredLog(result.invalidTenants.length ? "calling.audit_integrity_failed" : "calling.audit_integrity_ok", {
      tenantsChecked: result.tenantsChecked, eventsChecked: result.eventsChecked,
      invalidTenants: JSON.stringify(result.invalidTenants),
    });
  });

  install("auth.expiry_purge", 6 * 60 * 60_000, async () => {
    const nowIso = new Date().toISOString();
    for (const table of ["sessions", "otp_codes"] as const) {
      while (!stopped) {
        const purged = await retrySqliteOperation(rawDb, () => stopped ? 0 : purgeExpiredAuthBatch(table, nowIso));
        if (purged < 500) break;
        await yieldToLoop();
      }
    }
  });

  return () => {
    stopped = true;
    otpStop.abort();
    timers.forEach(clearInterval);
    stopCalling();
  };
}
