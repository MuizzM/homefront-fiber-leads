// ── Budgeted, resumable scan engine ───────────────────────────────────────────
// A scan is a durable, budgeted spend of proxy money against the address pool.
// This engine dispatches the highest-EV queued targets for a run, verifies each
// through Kinetic (the ONE real integration), records the availability signal +
// raw evidence, records provisional fresh-fiber transitions, and persists progress so a
// run survives a restart. It NEVER auto-starts — a run exists only because a
// route (admin-gated) created one — and it NEVER fabricates a result.
//
// The Kinetic checker is injectable so the whole pipeline (ranking → persistence
// → transition → lead creation → resume) is verifiable by REPLAYING real
// recorded responses, with zero proxy bandwidth spent. Rep-facing leads are
// projected later, only after independent fiber evidence.
import {
  ProviderAccessDeniedError,
  refreshTokenFromApi,
  scanAddress,
  type ScanResult,
} from "./scanner";
import crypto from "node:crypto";
import { storage } from "./storage";
import { rawDb } from "./db";
import { DEFAULT_BYTES_PER_CHECK } from "@shared/scanEconomics";
import {
  classifyCustomerOpportunity,
  classifyFiberAvailabilityTransition,
} from "@shared/opportunitySegment";
import {
  initController,
  observeRound,
  onSessionRefreshed,
  DEFAULT_RATE_CFG,
  type RateState,
} from "./rateController";
import {
  getRun,
  setRunStatus,
  claimRunTargets,
  finalizeRunTarget,
  touchRun,
  getTargetSnapshot,
  countQueued,
  getResumableRuns,
  resetInflightTargets,
  type ScanRunRow,
} from "./scanIntelStore";
import { projectConfirmedFreshLeads } from "./freshFiberProjector";
import { structuredLog } from "./structuredLog";
import { calculateFiberFreshness } from "@shared/fiberFreshness";
import type { ProviderRequestPriority } from "./providerRequestQueue";
import { ensureKineticScannerSchema, upsertKineticAddress } from "./kineticScannerStore";
import { hashKineticEvidence } from "./kineticProviderAdapter";
import {
  appendFiberEvent,
  beginFiberWorker,
  heartbeatWorker,
  persistFreshness,
  recordFiberFailure,
  recordProviderOutcome,
  targetAttempt,
} from "./fiberOperationsStore";

// The reduced result the engine needs, plus the bytes billed for cost evidence.
export interface CheckResult {
  result: ScanResult;
  bytes: number; // proxy bytes billed (measured or estimated)
  checkFailed: boolean;
}
export type Checker = (a: {
  address: string;
  city: string;
  state: string;
  zip: string;
  source?: ProviderRequestPriority;
}) => Promise<CheckResult>;

// Default checker — the existing authorized Kinetic path through the stable
// Decodo transport. scanner.ts owns authentication, request dedupe/caching,
// upstream-denial handling, and the provider concurrency ceiling.
const liveChecker: Checker = async (a) => {
  const result = await scanAddress(a.address, a.city, a.state, a.zip, { source: a.source ?? "market" });
  const checkFailed = result.apiSource === "failed";
  // Estimate bytes from the serialized raw response when present (the proxy bills
  // request + response); fall back to the flat estimate. Under-counting cost is
  // never acceptable, so failures still cost their request bytes.
  const bytes = result.rawResponse
    ? Math.max(
        DEFAULT_BYTES_PER_CHECK,
        JSON.stringify(result.rawResponse).length + 1200,
      )
    : DEFAULT_BYTES_PER_CHECK;
  return { result, bytes, checkFailed };
};

// In-process guard so a run is never dispatched by two workers at once (e.g. a
// resume racing a still-live worker). Cleared when the worker exits.
const activeRuns = new Set<string>();
let kineticMonitoringSchemaReady = false;

function ensureKineticMonitoringSchema(): void {
  if (kineticMonitoringSchemaReady) return;
  ensureKineticScannerSchema();
  kineticMonitoringSchemaReady = true;
}

export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

function providerPriorityForRun(kind: string): ProviderRequestPriority {
  const value = String(kind ?? "").toLowerCase();
  if (value.includes("manual") || value === "target_ids") return "manual";
  if (value.includes("lasso") || value.includes("bbox") || value.includes("area")) return "lasso";
  if (value.includes("city")) return "city";
  if (value.includes("recheck") || value.includes("rescan")) return "recheck";
  return "market";
}

// Run the worker loop for an already-created, already-enqueued run. Fire-and-
// forget from the route; it drives itself off the DB queue so it is resumable.
export async function runScanWorker(
  runId: string,
  tenantId: number,
  checker: Checker = liveChecker,
): Promise<void> {
  if (activeRuns.has(runId)) return;
  activeRuns.add(runId);
  const workerId = `scan:${runId}`;
  let terminalError: string | null = null;
  beginFiberWorker(tenantId, runId);
  heartbeatWorker({
    workerId,
    tenantId,
    runId,
    status: "running",
    concurrency: 1,
  });
  // Batch size is the AIMD congestion window, not a fixed 25 — it self-tunes to
  // Kinetic's 403 push-back so a budgeted market run obeys the same one-bucket
  // discipline as every other scan (measures blocked per batch, shrinks/refreshes).
  let ctrl: RateState = initController();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    for (;;) {
      const run = getRun(runId, tenantId);
      if (!run) return;
      if (run.status !== "running") return; // paused / cancelled / done
      if (run.verified + run.failed >= run.budget) {
        finish(run, "done");
        return;
      }

      const remainingBudget = run.budget - (run.verified + run.failed);
      // Atomically CLAIM the batch (marks them inflight) so a racing dispatch
      // can't grab the same targets and double-spend the proxy.
      const conc = Math.max(
        1,
        Math.min(Math.floor(ctrl.cwnd), remainingBudget),
      );
      const batch = claimRunTargets(runId, conc);
      if (batch.length === 0) {
        finish(run, "done");
        return;
      } // queue drained
      touchRun(runId); // heartbeat before a batch of slow network calls
      heartbeatWorker({
        workerId,
        tenantId,
        runId,
        status: "running",
        concurrency: batch.length,
        metadata: { completed: run.verified + run.failed, budget: run.budget },
      });

      const t0 = Date.now();
      let ok = 0,
        blocked = 0,
        neutral = 0;
      await Promise.all(
        batch.map(async (t) => {
          // Re-check status mid-batch so a cancel takes effect promptly. A claimed
          // target on a now-cancelled run is left 'inflight' — resume/reaper resets
          // it — and no check (no spend) is made.
          const live = getRun(runId, tenantId);
          if (!live || live.status !== "running") return;
          const checkStartedAt = Date.now();
          try {
            const { result, bytes, checkFailed } = await checker({
              address: t.address,
              city: t.city,
              state: t.state,
              zip: t.zip,
              source: providerPriorityForRun(run.kind),
            });
            applyCheck(
              runId,
              tenantId,
              t,
              result,
              bytes,
              checkFailed,
              Date.now() - checkStartedAt,
            );
            if (result.blocked) blocked++;
            else if (checkFailed) neutral++;
            else ok++;
          } catch (err: any) {
            if (err instanceof ProviderAccessDeniedError) throw err;
            // An unexpected throw is still a FAILED check — never a negative.
            finalizeRunTarget(runId, t.targetId, "failed", "failed", {
              failed: 1,
              estBytes: DEFAULT_BYTES_PER_CHECK,
            });
            const message = String(
              err?.message ?? err ?? "Provider check failed",
            );
            const attempt = targetAttempt(runId, t.targetId);
            recordFiberFailure({
              tenantId,
              runId,
              targetId: t.targetId,
              category: "provider_exception",
              message,
              attempt,
              retryable: true,
            });
            recordProviderOutcome(tenantId, false, message);
            appendFiberEvent({
              tenantId,
              runId,
              eventType: "address.failed",
              targetId: t.targetId,
              payload: { category: "provider_exception", attempt },
            });
            neutral++;
          }
        }),
      );

      const current = getRun(runId, tenantId);
      if (current)
        appendFiberEvent({
          tenantId,
          runId,
          eventType: "job.progress",
          payload: {
            completedTargets: current.verified + current.failed,
            verified: current.verified,
            failed: current.failed,
            newFiber: current.newFiber,
            newlyLive: current.newlyLive,
            budget: current.budget,
          },
        });

      // Independent evidence can arrive before the primary flip (for example a
      // licensed FCC/partner batch loaded earlier in the day). Project after
      // every completed batch so pre-existing evidence unlocks a confirmed lead
      // immediately instead of waiting for the evidence to be re-imported.
      const projected = projectConfirmedFreshLeads(
        tenantId,
        batch.map((target) => target.targetId),
      );
      if (projected.published > 0) {
        const alertHook = (globalThis as any).__flushFreshFiberAlerts;
        if (typeof alertHook === "function") {
          void Promise.resolve(alertHook(tenantId)).catch((error: any) => {
            structuredLog("fresh_fiber.immediate_alert_failed", {
              tenantId,
              error: String(error?.message ?? error),
            });
          });
        }
      }

      // Feed the round to the controller; act on its verdict (grow / shrink+pause /
      // refresh the session at the floor / wall-clock backoff when truly drained).
      const meanRttMs = (Date.now() - t0) / Math.max(1, batch.length);
      const d = observeRound(
        ctrl,
        { ok, blocked, neutral, meanRttMs },
        DEFAULT_RATE_CFG,
      );
      ctrl = d.state;
      if (d.action === "refresh_session") {
        try {
          await refreshTokenFromApi();
        } catch {
          // The controller remains throttled and retries only after backoff.
        }
        ctrl = onSessionRefreshed(ctrl);
      } else if (d.action === "hard_backoff")
        await sleep(d.backoffMs);
      else if (d.recoveryPauseMs > 0) await sleep(d.recoveryPauseMs);
    }
  } catch (err: any) {
    const message = String(err?.message ?? err).slice(0, 300);
    terminalError = message;
    setRunStatus(runId, "error", message);
    appendFiberEvent({
      tenantId,
      runId,
      eventType: "job.failed",
      payload: { message },
    });
    heartbeatWorker({
      workerId,
      tenantId,
      runId,
      status: "error",
      concurrency: 0,
      lastError: message,
    });
  } finally {
    heartbeatWorker({
      workerId,
      tenantId,
      runId,
      status: terminalError ? "error" : "idle",
      concurrency: 0,
      lastError: terminalError,
    });
    activeRuns.delete(runId);
  }
}

function applyCheck(
  runId: string,
  tenantId: number,
  t: {
    targetId: number;
    address: string;
    city: string;
    state: string;
    zip: string;
    lat: number | null;
    lng: number | null;
  },
  result: ScanResult,
  bytes: number,
  checkFailed: boolean,
  latencyMs: number,
): void {
  const snapshot = getTargetSnapshot(t.targetId);
  const customer = classifyCustomerOpportunity(result);
  const fiberTransition = classifyFiberAvailabilityTransition(
    {
      everObserved: snapshot.everScanned,
      fiberAvailable: snapshot.fiberAvailable,
    },
    { conclusive: !checkFailed, fiberAvailable: result.fiberAvailable },
  );
  persistSnapshot(
    runId,
    tenantId,
    t,
    result,
    checkFailed,
    customer,
    fiberTransition,
    latencyMs,
  );

  // FAILED CHECK: record nothing about availability, keep it in the recheck
  // queue conceptually (marked failed on THIS run so we don't re-dispatch it),
  // count it against budget + cost. Product law: a non-answer is not a "no".
  if (checkFailed) {
    finalizeRunTarget(runId, t.targetId, "failed", "failed", {
      failed: 1,
      estBytes: bytes,
    });
    const attempt = targetAttempt(runId, t.targetId);
    recordFiberFailure({
      tenantId,
      runId,
      targetId: t.targetId,
      category: result.blocked ? "provider_blocked" : "inconclusive",
      message:
        result.notes || "Provider returned no conclusive availability answer",
      attempt,
      retryable: true,
    });
    recordProviderOutcome(tenantId, false, result.notes);
    const freshness = calculateFiberFreshness({
      serviceability: "unknown",
      conclusive: false,
      checkedAtMs: Date.now(),
    });
    persistFreshness({ tenantId, targetId: t.targetId, ...freshness });
    appendFiberEvent({
      tenantId,
      runId,
      eventType: "address.failed",
      targetId: t.targetId,
      payload: {
        category: result.blocked ? "provider_blocked" : "inconclusive",
        attempt,
      },
    });
    return;
  }

  // Persist per-target scan memory + availability status + first-seen-live stamp.
  storage.recordScanTargetResult(t.targetId, {
    fiberStatus: result.fiberStatus,
    fiberAvailable: result.fiberAvailable,
    isNewFiber: result.isNewFiber,
    billingStatus: result.billingStatus,
    dfAddressId: result.dfAddressId,
    availabilityStatus: legacyAvailabilityStatus(fiberTransition.status),
    newlyLive: fiberTransition.fresh,
    customerSegment: customer.segment,
    customerConfidence: customer.confidence,
    customerSignals: customer.signals,
  });
  recordProviderOutcome(tenantId, true);

  // Keep known NEW FIBER addresses in the existing Kinetic monitoring inventory.
  // Active-service rows are silent Coming Soon watches; the nightly recheck worker
  // consumes the same shared queue and promotes nothing until billingStatus=N and
  // the independent fresh-fiber projector confirms the transition.
  if (result.isNewFiber && ["N", "Y"].includes(String(result.billingStatus))) {
    try {
      ensureKineticMonitoringSchema();
      const rawEvidence = result.rawResponse ?? result;
      const responseHash = hashKineticEvidence(rawEvidence);
      // Discovery scan IDs belong to scan_runs, not kinetic_scan_jobs; keep the
      // evidence address-linked without writing a cross-table foreign key.
      upsertKineticAddress(tenantId, null, {
        kineticAddressId: result.dfAddressId,
        sequentialId: null,
        address: result.address || t.address,
        city: result.city || t.city,
        state: result.state || t.state,
        zip: result.zip || t.zip,
        latitude: result.lat ?? t.lat,
        longitude: result.lng ?? t.lng,
        exchangeId: result.exchangeId,
        technologyType: result.techType,
        maximumQualification: result.maxDownloadMbps,
        estimatedCompletionDate: null,
        isLive: result.fiberAvailable,
        isComingSoon: result.billingStatus === "Y",
        isCopperUpgradeCandidate: null,
        billingStatus: result.billingStatus,
        householdSegmentType: result.householdSegmentType,
        fiberStatus: result.fiberStatus,
        isNewFiber: result.isNewFiber,
        evidenceMode: "approved_api",
        evidenceSource: "field-map-authorized-search",
        evidenceId: responseHash,
        observedAt: new Date().toISOString(),
        parserVersion: "field-map-authorized-search-v1",
        rawResponse: rawEvidence,
        responseHash,
      });
    } catch (error: any) {
      structuredLog("field_map.monitoring_sync_failed", {
        tenantId,
        runId,
        targetId: t.targetId,
        error: String(error?.message ?? error),
      }, "warn");
    }
  }

  // This is the primary-source opportunity signal. It remains provisional here:
  // scan workers NEVER publish a rep-facing lead. The independent-evidence gate
  // in freshFiberProjector is the sole lead projection path.
  const isTarget =
    result.isNewFiber && result.billingStatus === "N" && result.fiberAvailable;

  finalizeRunTarget(
    runId,
    t.targetId,
    "verified",
    isTarget
      ? "new_fiber"
      : result.fiberStatus === "no_service"
        ? "no_service"
        : "other",
    {
      verified: 1,
      newFiber: isTarget ? 1 : 0,
      newlyLive: fiberTransition.fresh ? 1 : 0,
      estBytes: bytes,
    },
  );
  const freshness = calculateFiberFreshness({
    serviceability: result.fiberAvailable ? "live" : "no_service",
    conclusive: true,
    checkedAtMs: Date.now(),
    transitionObserved: fiberTransition.fresh,
    firstSeenLiveAtMs: fiberTransition.fresh ? Date.now() : null,
    providerConfidence: customer.confidence === "medium" ? 0.75 : 0.55,
  });
  persistFreshness({ tenantId, targetId: t.targetId, ...freshness });
  appendFiberEvent({
    tenantId,
    runId,
    eventType: "address.completed",
    targetId: t.targetId,
    payload: {
      result: isTarget
        ? "new_fiber"
        : result.fiberStatus === "no_service"
          ? "no_service"
          : "other",
      freshnessScore: freshness.score,
      newlyLive: fiberTransition.fresh,
    },
  });
}

function legacyAvailabilityStatus(
  status: ReturnType<typeof classifyFiberAvailabilityTransition>["status"],
): string {
  return (
    {
      check_failed: "check_failed",
      baseline_available: "checked_available",
      unavailable: "checked_unavailable",
      freshly_available: "newly_live",
      still_available: "still_available",
      went_unavailable: "went_stale",
    } as const
  )[status];
}

function persistSnapshot(
  runId: string,
  tenantId: number,
  t: {
    targetId: number;
    address: string;
    city: string;
    state: string;
    zip: string;
    lat: number | null;
    lng: number | null;
  },
  result: ScanResult,
  checkFailed: boolean,
  customer: ReturnType<typeof classifyCustomerOpportunity>,
  transition: ReturnType<typeof classifyFiberAvailabilityTransition>,
  latencyMs: number,
): void {
  // A crash can replay a claimed target. The logical attempt is one
  // (tenant,run,target), so preserve exactly one snapshot and one legacy evidence
  // record for it before doing any append work.
  const alreadyPersisted = rawDb
    .prepare(
      `SELECT 1 FROM availability_snapshots
    WHERE tenant_id=? AND run_id=? AND scan_target_id=? LIMIT 1`,
    )
    .get(tenantId, runId, t.targetId);
  if (alreadyPersisted) return;
  const evidence = JSON.stringify(result.rawResponse ?? result);
  const evidenceHash = crypto
    .createHash("sha256")
    .update(evidence)
    .digest("hex");
  let fiberCheckId: number | null = null;
  try {
    fiberCheckId = storage.createFiberCheck({
      tenantId,
      address: `${t.address}, ${t.city}, ${t.state} ${t.zip}`,
      lat: result.lat ?? t.lat,
      lng: result.lng ?? t.lng,
      result: evidence,
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
    } as any).id;
  } catch {
    /* append the normalized snapshot even if the legacy evidence row fails */
  }
  rawDb
    .prepare(
      `INSERT OR IGNORE INTO availability_snapshots
    (tenant_id,scan_target_id,run_id,conclusive,fiber_available,fiber_status,max_download_mbps,service_status,
     household_segment_type,billing_status,customer_segment,customer_confidence,customer_signals,
     transition_status,fresh,api_source,evidence_hash,fiber_check_id,error,blocked,latency_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      tenantId,
      t.targetId,
      runId,
      checkFailed ? 0 : 1,
      checkFailed ? null : result.fiberAvailable ? 1 : 0,
      result.fiberStatus,
      result.maxDownloadMbps,
      result.notes,
      result.householdSegmentType,
      result.billingStatus,
      customer.segment,
      customer.confidence,
      JSON.stringify(customer.signals),
      transition.status,
      transition.fresh ? 1 : 0,
      result.apiSource,
      evidenceHash,
      fiberCheckId,
      checkFailed ? result.notes : null,
      result.blocked ? 1 : 0,
      Math.max(0, Math.round(latencyMs)),
    );
}

function finish(run: ScanRunRow, status: string): void {
  setRunStatus(run.id, status);
  const current = getRun(run.id, run.tenantId) ?? run;
  appendFiberEvent({
    tenantId: run.tenantId,
    runId: run.id,
    eventType: "job.completed",
    payload: {
      completedTargets: current.verified + current.failed,
      verified: current.verified,
      failed: current.failed,
      newFiber: current.newFiber,
      newlyLive: current.newlyLive,
      budget: current.budget,
    },
  });
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
      if (isRunActive(run.id)) continue; // a live worker already owns it
      resetInflightTargets(run.id); // return crash-orphaned claims to the queue
      if (countQueued(run.id) === 0) {
        setRunStatus(run.id, "done");
        continue;
      }
      console.log(
        `[scan-engine] resuming interrupted run ${run.id} (${countQueued(run.id)} pending)`,
      );
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
