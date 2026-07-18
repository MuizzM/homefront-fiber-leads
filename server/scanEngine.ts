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
import { isRevenueAdmissionClass, AdmissionTimeoutError } from "./distributedProviderCoordinator";
import { triggerExpansionForTargets } from "./clusterExpansion";
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
  getStrandedDoneRuns,
  resetInflightTargets,
  type ScanRunRow,
} from "./scanIntelStore";
import { projectConfirmedFreshLeads } from "./freshFiberProjector";
import { watchComingSoon } from "./comingSoonProgram";
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
  /** Polled while waiting for admission — abandon promptly if the run is cancelled. */
  abort?: () => boolean;
}) => Promise<CheckResult>;

// Default checker — the existing authorized Kinetic path through the stable
// Decodo transport. scanner.ts owns authentication, request dedupe/caching,
// upstream-denial handling, and the provider concurrency ceiling.
const liveChecker: Checker = async (a) => {
  const result = await scanAddress(a.address, a.city, a.state, a.zip, { source: a.source ?? "market", abort: a.abort });
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

// Dedup window (seconds) for a run's claim guard: skip re-checking an address whose
// canonical answer is fresher than this. User-initiated (manual/lasso/field) and
// change-detection (recheck/rescan/nightly) runs ALWAYS re-verify → 0. Bulk sweeps,
// discovery, and expansion skip recently-answered addresses to kill duplicate proxy
// spend across the 65 daily-diff / 21 city-sweep runs sharing the same inventory.
const DEDUP_RECHECK_SEC = Math.max(0, Math.floor(Number(process.env.SCAN_DEDUP_RECHECK_HOURS ?? 18) * 3600));
function dedupSkipSecondsForRun(kind: string): number {
  const v = String(kind ?? "").toLowerCase();
  if (v.includes("manual") || v === "target_ids" || v.includes("lasso") || v.includes("bbox") || v.includes("area") || v.includes("field")) return 0;
  // Change-detection runs must ALWAYS re-verify (never skip a recently-checked address):
  // rechecks, rescans, nightly, and the state/coming-soon MONITOR/WATCH watchers
  // (the Coming-Soon watchlist's 'coming_soon_watch' cadence — down to 6h — would
  // otherwise be silently swallowed by the 18h bulk dedup window).
  if (v.includes("recheck") || v.includes("rescan") || v.includes("nightly") || v.includes("scheduled") || v.includes("monitor") || v.includes("watch")) return 0;
  return DEDUP_RECHECK_SEC;
}

function providerPriorityForRun(kind: string): ProviderRequestPriority {
  const value = String(kind ?? "").toLowerCase();
  // IMMEDIATE — user/admin-initiated: a rep's tap, lasso/field-map, manual/admin check.
  if (value.includes("manual") || value === "target_ids" || value.includes("admin")) return "manual";
  if (value.includes("lasso") || value.includes("bbox") || value.includes("area") || value.includes("field")) return "lasso";
  // EXPANSION — matched before new_build (kind 'lead_expansion' contains "expansion");
  // its own class so the coordinator can share-CAP it (never crowds out revenue work).
  if (value.includes("expansion")) return "expansion";
  // NEW_BUILD — newly-detected construction/permits + Coming Soon rechecks.
  if (value.includes("coming_soon") || value.includes("comingsoon")) return "coming_soon";
  if (value.includes("new_build") || value.includes("newbuild") || value.includes("permit")) return "new_build";
  // DISCOVERY — address/market discovery that surfaces fresh leads.
  if (value.includes("discovery") || value.includes("fresh")) return "discovery";
  // MAINTENANCE — stale + statewide baseline (share-capped bulk).
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
  // Only the LIVE checker touches the token pool: an injected replay checker
  // (tests) never waits on real mints. And without automation authorization the
  // checker fails closed per-address — minting tokens would be pointless spend.
  if (checker === liveChecker && process.env.KFS_AUTOMATION_AUTHORIZED) {
    try { await refreshTokenFromApi(); } catch { /* pool + per-address remint recover */ }
  }
  heartbeatWorker({
    workerId,
    tenantId,
    runId,
    status: "running",
    concurrency: 1,
  });
  // Fixed batch size. There is NO AIMD/backoff/cooldown: the shared distributed
  // coordinator's steady concurrency + requests-per-minute cap is the only pacing.
  const BATCH = Math.max(1, Number(process.env.SCAN_BATCH_CONCURRENCY) || 50);
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
      const batch = claimRunTargets(runId, Math.min(BATCH, remainingBudget), dedupSkipSecondsForRun(run.kind));
      // Yield a full event-loop turn every claim cycle: a batch of instantly-failing
      // addresses (fail-closed transport) would otherwise chain microtasks forever
      // and starve timers/cancels. One setImmediate per batch costs ~nothing.
      await new Promise(resolve => setImmediate(resolve));
      if (batch.length === 0) {
        finish(run, "done");
        return;
      } // queue drained — every address conclusively resolved (or deduped-skip)
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
              // Abandon the admission wait immediately if the run is cancelled/paused,
              // rather than blocking up to admissionMaxWaitMs.
              abort: () => { const r = getRun(runId, tenantId); return !r || r.status !== "running"; },
            });
            if (result.blocked || checkFailed) {
              // TRANSIENT non-answer (throttle, transport error, malformed body,
              // soft success=false) — REQUEUE and retry later with a fresh token.
              // Never finalized, never counted failed/unresolved, never a no-fiber.
              // A conclusive "not serviceable" is NOT this path — the scanner
              // returns that as a real kinetic_live answer. No retry-count limit:
              // it recurs until a valid response or an explicit cancel.
              const category = result.blocked ? "provider_blocked" : "inconclusive";
              const attempt = targetAttempt(runId, t.targetId);
              // A throttle/transport block AND a generic transient check failure retry
              // promptly (they clear on the next attempt). ONLY a brand-new-address
              // non-answer — Kinetic returns AddressNeedsFix/AddressSuggestions for
              // addresses not yet in its fabric — backs off exponentially: hammering
              // it every second is wasteful and keeps the run spinning forever. The
              // address is still preserved + retried, just on a slower cadence, so the
              // run can drain instead of stranding a perpetually-requeued tail.
              const addressNotReady = !result.blocked && /AddressNeedsFix|AddressSuggestions/i.test(result.notes || "");
              // Unlimited budget → recheck new/not-yet-cataloged addresses far more
              // eagerly (cap 1h, was 6h) so a NEW FIBER activation surfaces fast.
              const backoffSec = addressNotReady ? Math.min(3600, 20 * Math.pow(2, Math.min(attempt, 8))) : 0;
              requeueRunTarget(runId, t.targetId, backoffSec);
              addRunBytes(runId, bytes); // the failed attempt still cost its request bytes
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
            const message = String(err?.message ?? err ?? "Provider check failed");
            const attempt = targetAttempt(runId, t.targetId);
            // An ADMISSION TIMEOUT/abort means the coordinator was saturated (contention),
            // not an address problem. Back off before retrying so a starved target does
            // not hot-loop claim→120s wait→timeout→immediate re-claim and spin its run.
            const admissionTimedOut = err instanceof AdmissionTimeoutError || err?.name === "AdmissionTimeoutError";
            const backoffSec = admissionTimedOut ? Math.min(120, 15 * Math.max(1, attempt)) : 0;
            requeueRunTarget(runId, t.targetId, backoffSec);
            addRunBytes(runId, DEFAULT_BYTES_PER_CHECK); // request bytes were still spent
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
        // Every address that just became a green FRESH_LEAD immediately seeds a
        // deduplicated CRITICAL cluster-expansion scan outward from it. The lead
        // is already published + pinned above; expansion runs independently and
        // never blocks lead creation.
        try {
          const started = triggerExpansionForTargets(tenantId, batch.map((t) => t.targetId));
          if (started) structuredLog("expansion.seeded", { tenantId, expansions: started }, "info");
        } catch (e: any) {
          structuredLog("expansion.seed_failed", { tenantId, error: String(e?.message ?? e).slice(0, 120) }, "warn");
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
  // "A" is Kinetic's other active-billing value (verified live) — include it so
  // active-service NEW FIBER addresses stay in the monitoring inventory.
  if (result.isNewFiber && ["N", "Y", "A"].includes(String(result.billingStatus))) {
    // COMING SOON PROGRAM: NEW FIBER with billing still active = fiber built,
    // service not yet orderable. Add it to the durable watchlist — the built-in
    // worker rechecks it on an opportunity-weighted cadence and promotes it to a
    // green Fresh Lead the moment billing flips to inactive.
    if (String(result.billingStatus) === "Y") {
      try {
        watchComingSoon(tenantId, {
          address: result.address || t.address,
          city: result.city || t.city,
          state: result.state || t.state,
          zip: result.zip || t.zip,
          lat: result.lat ?? t.lat,
          lng: result.lng ?? t.lng,
          source: "kinetic-search",
          confidence: "provider",
        });
      } catch (e: any) {
        structuredLog("coming_soon.watch_failed", { tenantId, runId, error: String(e?.message ?? e).slice(0, 120) }, "warn");
      }
    }
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
// Heartbeat age past which a still-"active" worker is treated as WEDGED, not slow.
// Admission waits are now bounded (coordinator admissionMaxWaitMs ~120s) and a
// batch of network checks completes well under this, so a run whose heartbeat has
// been frozen this long is genuinely stuck — its in-memory activeRuns entry is a
// zombie that blocks the normal (isRunActive) resume path below. Evicting it is the
// "remove stale leases/deadlocks" fix; set generously so only truly-dead workers
// are reclaimed (a resurrected zombie is deduped by the coordinator address-lock).
const STUCK_RECLAIM_SECONDS = Number(process.env.SCAN_STUCK_RECLAIM_SECONDS ?? 300);

export function resumeInterruptedRuns(): void {
  try {
    // First evict zombie leases: runs whose worker is still in activeRuns but whose
    // heartbeat has been frozen far past any legitimate batch. Without this a wedged
    // worker holds its run 'active' forever and the reaper below skips it — the exact
    // deadlock that left the discovery run at "0 checked" with orphaned inflight rows.
    for (const run of getResumableRuns(STUCK_RECLAIM_SECONDS)) {
      if (!activeRuns.has(run.id)) continue; // worker already gone — normal resume covers it
      console.warn(`[scan-engine] force-reclaiming wedged run ${run.id} kind=${run.kind} (heartbeat ${run.heartbeatAt ?? "null"})`);
      activeRuns.delete(run.id); // drop the zombie lease so runScanWorker can re-enter below
    }
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
    // Drain STRANDED TAILS: 'done' or 'error' runs that still hold claimable queued
    // targets (a target requeued exactly as the batch drained, or a worker that died
    // on a terminal exception). Re-open a bounded number so every discovered address
    // is actually consumed — "preserve and retry every address." The requeue backoff
    // makes the re-opened run converge, not spin. ('cancelled' stays closed.)
    for (const run of getStrandedDoneRuns(10)) {
      if (isRunActive(run.id)) continue;
      resetInflightTargets(run.id);
      setRunStatus(run.id, "running");
      console.log(`[scan-engine] re-opening stranded '${run.status}' run ${run.id} (${countQueued(run.id)} claimable pending)`);
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
      // Fast-resume every REVENUE-class run (IMMEDIATE/NEW_BUILD/DISCOVERY) so a rep's
      // tap, a fresh new-build/Coming-Soon check, or a discovery run never waits for the
      // 30s staleness window after a deploy. EXPANSION/MAINTENANCE resume via the reaper.
      if (!isRevenueAdmissionClass(providerPriorityForRun(run.kind))) continue;
      if (isRunActive(run.id)) continue;
      resetInflightTargets(run.id);
      if (countQueued(run.id) === 0) { setRunStatus(run.id, "done"); continue; }
      console.log(`[scan-engine] fast-resuming revenue run ${run.id} kind=${run.kind} (${countQueued(run.id)} pending)`);
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
