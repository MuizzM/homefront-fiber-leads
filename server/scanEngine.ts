// ── Budgeted, resumable scan engine ───────────────────────────────────────────
// A scan is a durable, budgeted spend of proxy money against the address pool.
// This engine dispatches the highest-EV queued targets for a run, verifies each
// through Kinetic (the ONE real integration), records the availability signal +
// raw evidence, creates leads for genuine new-fiber, and persists progress so a
// run survives a restart. It NEVER auto-starts — a run exists only because a
// route (admin-gated) created one — and it NEVER fabricates a result.
//
// The Kinetic checker is injectable so the whole pipeline (ranking → persistence
// → transition → lead creation → resume) is verifiable by REPLAYING real
// recorded responses, with zero proxy bandwidth spent.
import { scanAddress, type ScanResult } from "./scanner";
import { storage } from "./storage";
import { DEFAULT_BYTES_PER_CHECK } from "@shared/scanEconomics";
import { classifyAvailabilityTransition } from "@shared/fiberDetect";
import {
  getRun, setRunStatus, claimRunTargets, finalizeRunTarget, touchRun,
  getTargetSnapshot, countQueued, getResumableRuns, resetInflightTargets, type ScanRunRow,
} from "./scanIntelStore";

// The reduced result the engine needs, plus the bytes billed for cost evidence.
export interface CheckResult {
  result: ScanResult;
  bytes: number;      // proxy bytes billed (measured or estimated)
  checkFailed: boolean;
}
export type Checker = (a: { address: string; city: string; state: string; zip: string }) => Promise<CheckResult>;

// Default checker — the real Kinetic path through the residential proxy.
const liveChecker: Checker = async (a) => {
  const result = await scanAddress(a.address, a.city, a.state, a.zip);
  const checkFailed = result.apiSource === "failed";
  // Estimate bytes from the serialized raw response when present (the proxy bills
  // request + response); fall back to the flat estimate. Under-counting cost is
  // never acceptable, so failures still cost their request bytes.
  const bytes = result.rawResponse
    ? Math.max(DEFAULT_BYTES_PER_CHECK, JSON.stringify(result.rawResponse).length + 1200)
    : DEFAULT_BYTES_PER_CHECK;
  return { result, bytes, checkFailed };
};

// Concurrency is deliberately modest — the proxy pool has 400 slots but a
// budgeted run is about spending carefully, not maximum burn. 25 in flight
// verifies a 1,000-address run in well under a minute without hammering.
const CONCURRENCY = 25;

// In-process guard so a run is never dispatched by two workers at once (e.g. a
// resume racing a still-live worker). Cleared when the worker exits.
const activeRuns = new Set<string>();

export function isRunActive(runId: string): boolean { return activeRuns.has(runId); }

// Run the worker loop for an already-created, already-enqueued run. Fire-and-
// forget from the route; it drives itself off the DB queue so it is resumable.
export async function runScanWorker(runId: string, tenantId: number, checker: Checker = liveChecker): Promise<void> {
  if (activeRuns.has(runId)) return;
  activeRuns.add(runId);
  try {
    for (;;) {
      const run = getRun(runId, tenantId);
      if (!run) return;
      if (run.status !== "running") return;                 // paused / cancelled / done
      if (run.verified + run.failed >= run.budget) { finish(run, "done"); return; }

      const remainingBudget = run.budget - (run.verified + run.failed);
      // Atomically CLAIM the batch (marks them inflight) so a racing dispatch
      // can't grab the same targets and double-spend the proxy.
      const batch = claimRunTargets(runId, Math.min(CONCURRENCY, remainingBudget));
      if (batch.length === 0) { finish(run, "done"); return; } // queue drained
      touchRun(runId); // heartbeat before a batch of slow network calls

      await Promise.all(batch.map(async (t) => {
        // Re-check status mid-batch so a cancel takes effect promptly. A claimed
        // target on a now-cancelled run is left 'inflight' — resume/reaper resets
        // it — and no check (no spend) is made.
        const live = getRun(runId, tenantId);
        if (!live || live.status !== "running") return;
        try {
          const { result, bytes, checkFailed } = await checker({ address: t.address, city: t.city, state: t.state, zip: t.zip });
          applyCheck(runId, tenantId, t, result, bytes, checkFailed);
        } catch (err: any) {
          // An unexpected throw is still a FAILED check — never a negative.
          finalizeRunTarget(runId, t.targetId, "failed", "failed", { failed: 1, estBytes: DEFAULT_BYTES_PER_CHECK });
        }
      }));
    }
  } catch (err: any) {
    setRunStatus(runId, "error", String(err?.message ?? err).slice(0, 300));
  } finally {
    activeRuns.delete(runId);
  }
}

function applyCheck(runId: string, tenantId: number, t: { targetId: number; address: string; city: string; state: string; zip: string; lat: number | null; lng: number | null }, result: ScanResult, bytes: number, checkFailed: boolean): void {
  // FAILED CHECK: record nothing about availability, keep it in the recheck
  // queue conceptually (marked failed on THIS run so we don't re-dispatch it),
  // count it against budget + cost. Product law: a non-answer is not a "no".
  if (checkFailed) {
    finalizeRunTarget(runId, t.targetId, "failed", "failed", { failed: 1, estBytes: bytes });
    return;
  }

  const snapshot = getTargetSnapshot(t.targetId);
  const reduced = {
    isNewFiber: result.isNewFiber,
    fiberAvailable: result.fiberAvailable,
    billingStatus: result.billingStatus,
    checkFailed: false,
  };
  const transition = classifyAvailabilityTransition(snapshot, reduced);

  // Persist per-target scan memory + availability status + first-seen-live stamp.
  storage.recordScanTargetResult(t.targetId, {
    fiberStatus: result.fiberStatus,
    isNewFiber: result.isNewFiber,
    billingStatus: result.billingStatus,
    dfAddressId: result.dfAddressId,
    availabilityStatus: transition.status,
    newlyLive: transition.isNewlyLive,
  });

  // Preserve the EVIDENCE behind the decision — the raw Kinetic response — so the
  // provider-verification claim is auditable, not a bare boolean.
  try {
    storage.createFiberCheck({
      tenantId,  // stamp the run's tenant so scoped reads (and boot adoption) stay correct
      address: `${t.address}, ${t.city}, ${t.state} ${t.zip}`,
      lat: result.lat ?? t.lat, lng: result.lng ?? t.lng,
      result: JSON.stringify(result.rawResponse ?? result),
      fiberAvailable: result.fiberAvailable,
      isNewFiber: result.isNewFiber,
      isTenured: result.isTenured,
      householdSegmentType: result.householdSegmentType,
      billingStatus: result.billingStatus,
      techType: result.techType,
      speedTier: result.speedTier,
      maxDownload: result.maxDownloadMbps,
      competitorName: result.competitorName,
      addressCatalogDate: result.addressCatalogDate,
      apiSource: result.apiSource,
    } as any);
  } catch { /* evidence is best-effort — never fail a check on it */ }

  // Create/refresh a lead only for a genuine door-knock target (NEW FIBER +
  // billing N + serviceable). Links the pool target to the lead it produced.
  const isTarget = result.isNewFiber && result.billingStatus === "N" && result.fiberAvailable;
  if (isTarget && transition.shouldCreateLead) {
    try {
      storage.upsertLeadByAddress({
        address: result.address, city: result.city, state: result.state, zip: result.zip,
        lat: result.lat ?? t.lat ?? undefined, lng: result.lng ?? t.lng ?? undefined,
        fiberStatus: result.fiberStatus,
        householdSegmentType: result.householdSegmentType,
        billingStatus: result.billingStatus,
        isNewFiber: result.isNewFiber, isTenured: false,
        speedTier: result.speedTier, maxDownloadMbps: result.maxDownloadMbps,
        techType: result.techType, chipSetType: result.chipSetType, placement: result.placement,
        maxQual: result.maxQual, competitorName: result.competitorName,
        competitorSpeedMbps: result.competitorSpeedMbps, competitorTech: result.competitorTech,
        inCompetitorArea: result.inCompetitorArea, dfAddressId: result.dfAddressId,
        accessId: result.accessId, exchangeId: result.exchangeId,
        addressCatalogDate: result.addressCatalogDate,
        leadStatus: "prospect", leadTag: result.leadTag, leadScore: result.leadScore,
        deploymentNotes: result.notes, tenantId,
      } as any);
    } catch { /* dedup/constraint — the pool row still records the availability */ }
  }

  finalizeRunTarget(runId, t.targetId, "verified",
    isTarget ? "new_fiber" : (result.fiberStatus === "no_service" ? "no_service" : "other"),
    { verified: 1, newFiber: isTarget ? 1 : 0, newlyLive: transition.isNewlyLive ? 1 : 0, estBytes: bytes });
}

function finish(run: ScanRunRow, status: string): void {
  setRunStatus(run.id, status);
  // A completed scan may have created leads — refresh the map layer for clients.
  const bust = (globalThis as any).__bustMapCache;
  if (typeof bust === "function") bust(run.tenantId);
}

// On boot: re-dispatch any run that was 'running' when the process died and
// whose heartbeat is stale. This is what makes "leave and return without losing
// progress" real across a crash/deploy. Each run continues from its DB queue.
export function resumeInterruptedRuns(): void {
  try {
    const runs = getResumableRuns(30);
    for (const run of runs) {
      if (isRunActive(run.id)) continue;           // a live worker already owns it
      resetInflightTargets(run.id);                // return crash-orphaned claims to the queue
      if (countQueued(run.id) === 0) { setRunStatus(run.id, "done"); continue; }
      console.log(`[scan-engine] resuming interrupted run ${run.id} (${countQueued(run.id)} pending)`);
      void runScanWorker(run.id, run.tenantId);
    }
  } catch (err: any) {
    console.warn("[scan-engine] resume failed:", err?.message);
  }
}

// PERIODIC REAPER — resumeInterruptedRuns on a timer, not just at boot, so a run
// whose worker died WITHOUT a process restart (an unhandled rejection, an OOM'd
// batch) is picked back up within a minute instead of hanging 'running' forever.
let _reaper: ReturnType<typeof setInterval> | null = null;
export function startScanReaper(intervalMs = 60_000): void {
  if (_reaper) return;
  _reaper = setInterval(() => resumeInterruptedRuns(), intervalMs);
  if (typeof (_reaper as any).unref === "function") (_reaper as any).unref();
}
