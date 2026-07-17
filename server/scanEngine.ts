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
  refreshTokenFromApi,
  scanAddress,
  normalizeKineticAddressKey,
  type ScanResult,
} from "./scanner";
import { emitStage } from "./scanStageBus";
import { isCriticalPriority } from "./distributedProviderCoordinator";
import crypto from "node:crypto";
import { storage } from "./storage";
import { rawDb } from "./db";
import { recordAvailabilitySnapshot } from "./availabilitySnapshot";
import { DEFAULT_BYTES_PER_CHECK } from "@shared/scanEconomics";
import {
  classifyCustomerOpportunity,
  classifyFiberAvailabilityTransition,
} from "@shared/opportunitySegment";
import {
  getRun,
  setRunStatus,
  claimRunTargets,
  finalizeRunTarget,
  requeueRunTarget,
  addRunBytes,
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
  // Newly-detected construction jumps ahead of the bulk statewide sweep.
  if (value.includes("new_build")) return "new_build";
  if (value.includes("city")) return "city";
  if (value.includes("recheck") || value.includes("rescan")) return "recheck";
  if (value.includes("nightly") || value.includes("scheduled")) return "nightly";
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
  // Mint a fresh token before this run starts — Scan Map, city, and nightly scans
  // all pass through here. Best-effort: a mint hiccup is non-fatal (the pool and
  // the per-401 remint below still recover), but a stale token never starts a run.
  try { await refreshTokenFromApi(); } catch { /* pool + per-address remint recover */ }
  heartbeatWorker({
    workerId,
    tenantId,
    runId,
    status: "running",
    concurrency: 1,
  });
  // Fixed batch size. There is NO AIMD/backoff/cooldown: the shared distributed
  // coordinator's steady concurrency + requests-per-minute cap is the only pacing.
  const BATCH = Math.max(1, Number(process.env.SCAN_BATCH_CONCURRENCY) || 25);
  try {
    for (;;) {
      const run = getRun(runId, tenantId);
      if (!run) return;
      if (run.status !== "running") return; // paused / cancelled / done — stops the pump
      if (run.verified + run.failed >= run.budget) {
        finish(run, "done");
        return;
      }

      const remainingBudget = run.budget - (run.verified + run.failed);
      // Atomically CLAIM the batch (marks them inflight) so a racing dispatch can't
      // grab the same targets and double-spend the proxy. Requeued (transient-error)
      // targets are 'queued' again, so the queue only drains once every address has
      // a conclusive or unresolved answer.
      const batch = claimRunTargets(runId, Math.min(BATCH, remainingBudget));
      if (batch.length === 0) {
        finish(run, "done");
        return;
      } // queue drained — every address conclusively resolved
      touchRun(runId); // heartbeat before a batch of slow network calls
      heartbeatWorker({
        workerId,
        tenantId,
        runId,
        status: "running",
        concurrency: batch.length,
        metadata: { completed: run.verified + run.failed, budget: run.budget },
      });

      await Promise.all(
        batch.map(async (t) => {
          // Re-check status mid-batch so a cancel takes effect promptly. A claimed
          // target on a now-cancelled run is left 'inflight' — resume/reaper resets it.
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
            if (result.blocked || checkFailed) {
              // TRANSIENT non-answer (throttle, transport error, malformed body,
              // soft success=false) — REQUEUE and retry later with a fresh token.
              // Never finalized, never counted failed/unresolved, never a no-fiber.
              // A conclusive "not serviceable" is NOT this path — the scanner
              // returns that as a real kinetic_live answer. No retry-count limit:
              // it recurs until a valid response or an explicit cancel.
              requeueRunTarget(runId, t.targetId);
              addRunBytes(runId, bytes); // the failed attempt still cost its request bytes
              const category = result.blocked ? "provider_blocked" : "inconclusive";
              const attempt = targetAttempt(runId, t.targetId);
              recordFiberFailure({
                tenantId, runId, targetId: t.targetId, category,
                message: result.notes || "transient provider error", attempt, retryable: true,
              });
              recordProviderOutcome(tenantId, false, result.notes);
              appendFiberEvent({
                tenantId, runId, eventType: "address.requeued", targetId: t.targetId,
                payload: { category, attempt },
              });
            } else {
              // VALID provider response — a conclusive serviceability answer
              // (fiber, NEW FIBER, no-service, out-of-territory…). Record it,
              // finalize the target, and publish a Fresh Lead when it qualifies.
              applyCheck(runId, tenantId, t, result, bytes, Date.now() - checkStartedAt);
            }
          } catch (err: any) {
            // An unexpected throw is TRANSIENT — requeue (never lose the address,
            // never a no-fiber, never abort the run).
            requeueRunTarget(runId, t.targetId);
            addRunBytes(runId, DEFAULT_BYTES_PER_CHECK); // request bytes were still spent
            const message = String(err?.message ?? err ?? "Provider check failed");
            const attempt = targetAttempt(runId, t.targetId);
            recordFiberFailure({
              tenantId, runId, targetId: t.targetId, category: "provider_exception",
              message, attempt, retryable: true,
            });
            recordProviderOutcome(tenantId, false, message);
            appendFiberEvent({
              tenantId, runId, eventType: "address.requeued", targetId: t.targetId,
              payload: { category: "provider_exception", attempt },
            });
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
  latencyMs: number,
): void {
  // applyCheck is only ever called with a VALID provider response. Transient
  // non-answers (blocked / apiSource='failed') are requeued by the worker and
  // never reach here — a temporary failure is retry history, never a finalized
  // "unresolved" and never a "no".
  const snapshot = getTargetSnapshot(t.targetId);
  const customer = classifyCustomerOpportunity(result);
  const fiberTransition = classifyFiberAvailabilityTransition(
    {
      everObserved: snapshot.everScanned,
      fiberAvailable: snapshot.fiberAvailable,
    },
    { conclusive: true, fiberAvailable: result.fiberAvailable },
  );
  persistSnapshot(
    runId,
    tenantId,
    t,
    result,
    false,
    customer,
    fiberTransition,
    latencyMs,
  );

  // Persist per-target scan memory + availability status + first-seen-live stamp.
  storage.recordScanTargetResult(t.targetId, {
    fiberStatus: result.fiberStatus,
    fiberAvailable: result.fiberAvailable,
    isNewFiber: result.isNewFiber,
    billingStatus: result.billingStatus,
    dfAddressId: result.dfAddressId,
    accessId: result.accessId,
    serviceKey: result.serviceKey,
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

  // THE Fresh Lead rule, applied to the provider's current answer: NEW FIBER
  // segment + billing N + fiber qualified. The worker's post-batch
  // projectConfirmedFreshLeads call publishes it as a Lead immediately —
  // projector = the one shared idempotent publisher (same as Manual Check),
  // not a gate that can hold an authoritative answer back.
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
  // ONE shared writer (crash-idempotent on the run/target attempt key). A failed
  // attempt is retained here for diagnostics but conclusive=0, so it never becomes
  // the current serviceability state (recordScanTargetResult, called only on a
  // conclusive answer, owns that).
  recordAvailabilitySnapshot({
    tenantId,
    scanTargetId: t.targetId,
    runId,
    checkedAt: Date.now(),
    conclusive: !checkFailed,
    fiberAvailable: checkFailed ? null : result.fiberAvailable,
    fiberStatus: result.fiberStatus,
    maxDownloadMbps: result.maxDownloadMbps,
    serviceStatus: result.notes,
    householdSegmentType: result.householdSegmentType,
    billingStatus: result.billingStatus,
    customerSegment: customer.segment,
    customerConfidence: customer.confidence,
    customerSignals: customer.signals,
    transitionStatus: transition.status,
    fresh: transition.fresh,
    apiSource: result.apiSource,
    evidenceHash,
    fiberCheckId,
    error: checkFailed ? result.notes : null,
    blocked: result.blocked,
    latencyMs,
    orIgnore: true,
  });
  // Inspector: the conclusive snapshot has been persisted for this address.
  try {
    emitStage({
      addressKey: normalizeKineticAddressKey(t.address, t.city, t.state, t.zip),
      address: t.address, city: t.city, state: t.state, zip: t.zip,
      runId, source: "run", stage: "saving",
      status: checkFailed ? "error" : "ok",
      attempt: 1, latencyMs,
      classification: checkFailed ? null : result.fiberStatus,
      detail: checkFailed ? `not saved as conclusive — ${result.blocked ? "blocked/retry" : "unresolved"}` : `snapshot saved · ${result.fiberStatus}`,
      tsEpoch: Date.now(),
    });
  } catch { /* telemetry best-effort */ }
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

// On boot: IMMEDIATELY (re)dispatch incomplete CRITICAL-kind runs (new-build /
// manual / field / lasso / admin) — they must not wait for the 30s staleness
// window or the 60s reaper, so an immediate check never sits behind the bulk
// statewide sweep after a deploy. Idempotent: isRunActive + runScanWorker's own
// guard prevent double-dispatch; resetInflightTargets requeues only crash-orphaned
// claims (no duplication, no data loss).
export function resumeCriticalRuns(): void {
  try {
    for (const run of getResumableRuns(0)) {
      if (!isCriticalPriority(providerPriorityForRun(run.kind))) continue;
      if (isRunActive(run.id)) continue;
      resetInflightTargets(run.id);
      if (countQueued(run.id) === 0) { setRunStatus(run.id, "done"); continue; }
      console.log(`[scan-engine] fast-resuming CRITICAL run ${run.id} kind=${run.kind} (${countQueued(run.id)} pending)`);
      void runScanWorker(run.id, run.tenantId);
    }
  } catch (err: any) {
    console.warn("[scan-engine] critical resume failed:", err?.message);
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
