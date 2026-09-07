import { rawDb } from "./db";
import { retrySqliteOperation } from "./interactiveDb";
import { structuredLog } from "./structuredLog";

/** Owned by the cluster primary, or the single-process server. Never installed
 * in each HTTP worker. Single-process retries yield during SQLite contention. */
export async function startCallingMaintenance(): Promise<() => void> {
  const { purgeExpiredProviderPayloads } = await import("./calling/providerRetention");
  const { reconcileStrandedRuns } = await import("./areaSkipTrace");
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      let purged = 0;
      let hasMore = true;
      for (let batch = 0; batch < 10 && hasMore && !stopped; batch++) {
        const result = await retrySqliteOperation(rawDb, () => stopped
          ? { purged: 0, hasMore: false } : purgeExpiredProviderPayloads({ batchSize: 500 }), 120_000);
        purged += result.purged;
        hasMore = result.hasMore;
      }
      if (purged > 0 || hasMore) structuredLog("calling.provider_payload_retention", { purged, hasMore });
    } catch (error) {
      structuredLog("calling.provider_payload_retention_failed", { message: error instanceof Error ? error.message : "unknown error" });
    }
    try {
      const reaped = await retrySqliteOperation(rawDb, () => stopped ? 0 : reconcileStrandedRuns(), 120_000);
      if (reaped > 0) structuredLog("calling.area_skip_trace_runs_reaped", { reaped });
    } catch (error) {
      structuredLog("calling.area_skip_trace_reap_failed", { message: error instanceof Error ? error.message : "unknown error" });
    } finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, 60 * 60 * 1000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
