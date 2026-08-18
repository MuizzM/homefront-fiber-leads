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
import { scanFrontierAddress } from "./frontierScanner";
import { emitStage } from "./scanStageBus";
import { isRevenueAdmissionClass, AdmissionTimeoutError } from "./distributedProviderCoordinator";
import { adaptivePace, adaptivePaceStats } from "./adaptivePace";
import { isProxyCircuitOpen, circuitBreakerSnapshot } from "./bandwidthGovernor";
import { triggerExpansionForTargets } from "./clusterExpansion";
import crypto from "node:crypto";
import os from "node:os";
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
  terminalizeQueuedTail,
  bumpRunReopen,
  countClaimableQueued,
  countActiveRuns,
  countOpenDeadLetters,
  ANF_QUIET_DAYS,
  type ScanRunRow,
} from "./scanIntelStore";
import { projectConfirmedFreshLeads } from "./freshFiberProjector";
import { watchComingSoon } from "./comingSoonProgram";
import { structuredLog } from "./structuredLog";
import { calculateFiberFreshness } from "@shared/fiberFreshness";
import { isActiveBilling } from "@shared/billingStatus";
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
  /** 'kinetic' (default) routes to the Kinetic scanner; 'frontier' routes to the
   * Frontier serviceability scanner (RED leads). */
  carrier?: string;
  source?: ProviderRequestPriority;
  /** Polled while waiting for admission — abandon promptly if the run is cancelled. */
  abort?: () => boolean;
}) => Promise<CheckResult>;

// Default checker — the existing authorized Kinetic path through the stable
// Decodo transport. scanner.ts owns authentication, request dedupe/caching,
// upstream-denial handling, and the provider concurrency ceiling.
const liveChecker: Checker = async (a) => {
  // Carrier routing: Frontier targets go to the Frontier serviceability API
  // (same result contract; the projector paints those leads RED downstream).
  const result = a.carrier === "frontier"
    ? await scanFrontierAddress(a.address, a.city, a.state, a.zip)
    : await scanAddress(a.address, a.city, a.state, a.zip, { source: a.source ?? "market", abort: a.abort });
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

// BOUNDED RUN DISPATCH. Each runScanWorker loop polls the DB (claimRunTargets is
// a synchronous better-sqlite3 transaction) every batch — so N concurrent worker
// loops means N synchronous DB hits contending for the single event-loop thread.
// On boot, resume/critical/reaper would spawn a worker for EVERY 'running' run at
// once; with a backlog of 100+ runs that pegged the one core to 99% and starved
// /api/health (prod outage + failed deploys). Cap concurrent workers and queue
// the rest; a finishing worker pumps the next. Provider concurrency is already
// bounded separately by the admission coordinator — this bounds the WORKER LOOPS.
const MAX_ACTIVE_RUN_WORKERS = Math.max(1, Math.floor(Number(process.env.MAX_ACTIVE_RUN_WORKERS ?? 16) || 16));
const _runQueue: Array<{ runId: string; tenantId: number; checker?: Checker }> = [];
const _runQueued = new Set<string>();

/** Dispatch a run through the concurrency cap. Use this instead of calling
 *  runScanWorker directly from resume/reaper/route paths. Idempotent per run. */
export function dispatchRun(runId: string, tenantId: number, checker?: Checker): void {
  if (activeRuns.has(runId) || _runQueued.has(runId)) return;
  if (activeRuns.size >= MAX_ACTIVE_RUN_WORKERS) {
    _runQueued.add(runId);
    // Revenue-class runs (frontier/manual/lasso/new-build/discovery) JUMP the
    // FIFO: bulk backlog (statewide/market/recheck) would otherwise starve them
    // for hours behind 16 busy worker slots. Non-revenue keeps FIFO order.
    let revenue = false;
    try {
      const r = getRun(runId, tenantId);
      revenue = !!r && isRevenueAdmissionClass(providerPriorityForRun((r as any).kind ?? ""));
    } catch { /* lookup is best-effort; FIFO fallback is safe */ }
    if (revenue) _runQueue.unshift({ runId, tenantId, checker });
    else _runQueue.push({ runId, tenantId, checker });
    return;
  }
  void runScanWorker(runId, tenantId, checker);
}

function pumpRunQueue(): void {
  while (activeRuns.size < MAX_ACTIVE_RUN_WORKERS && _runQueue.length > 0) {
    const next = _runQueue.shift()!;
    _runQueued.delete(next.runId);
    if (activeRuns.has(next.runId)) continue;
    void runScanWorker(next.runId, next.tenantId, next.checker);
  }
}
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
// address_not_found terminal: after this many needs-fix non-answers (per run,
// sessions rotating across attempts) the address string is concluded absent from
// Kinetic's fabric — a DATA verdict, never no-service. Parked from bulk claims
// for ANF_QUIET_DAYS, then re-probed (new fabric imports do add streets).
const ANF_TERMINAL_ATTEMPTS = Math.max(2, Math.floor(Number(process.env.ADDRESS_NOT_FOUND_ATTEMPTS ?? 6) || 6));
// 403-storm back-off: when at least this FRACTION of a batch came back blocked
// (throttle/403), sleep up to PROVIDER_BLOCK_BACKOFF_MS (scaled by severity) so
// workers stop hammering Decodo's depleted rolling window and it can refill.
const PROVIDER_BLOCK_BACKOFF_FRACTION = Math.min(1, Math.max(0, Number(process.env.PROVIDER_BLOCK_BACKOFF_FRACTION ?? 0.5) || 0.5));
const PROVIDER_BLOCK_BACKOFF_MS = Math.max(0, Number(process.env.PROVIDER_BLOCK_BACKOFF_MS ?? 15_000) || 15_000);
// C2 — breaker-wait cadence: how long a worker sleeps between breaker polls
// while the shared circuit is in COOLDOWN, and the throttle on the wait log
// (one event per 30s fleet-wide per process — never per batch).
const BREAKER_WAIT_MS = Math.max(50, Number(process.env.SCAN_BREAKER_WAIT_MS) || 2_000);
let lastBreakerWaitLogAt = 0;
function logBreakerWait(runId: string): void {
  const now = Date.now();
  if (now - lastBreakerWaitLogAt <= 30_000) return;
  lastBreakerWaitLogAt = now;
  structuredLog("scan.engine.breaker_wait", {
    runId, waitMs: BREAKER_WAIT_MS,
    reason: "shared proxy circuit COOLDOWN - yielding instead of claiming",
  }, "warn");
}
function dedupSkipSecondsForRun(kind: string): number {
  const v = String(kind ?? "").toLowerCase();
  if (v.includes("manual") || v === "target_ids" || v.includes("lasso") || v.includes("bbox") || v.includes("area") || v.includes("field")) return 0;
  // Change-detection runs must ALWAYS re-verify (never skip a recently-checked address):
  // rechecks, rescans, nightly, and the state/coming-soon MONITOR/WATCH watchers
  // (the Coming-Soon watchlist's 'coming_soon_watch' cadence — down to 6h — would
  // otherwise be silently swallowed by the 18h bulk dedup window).
  if (v.includes("recheck") || v.includes("rescan") || v.includes("nightly") || v.includes("scheduled") || v.includes("monitor") || v.includes("watch")) return 0;
  // Frontier runs check a DIFFERENT provider than the Kinetic sweeps — a recent
  // Kinetic verdict says nothing about Frontier serviceability. Without this,
  // Kinetic's constant last_scanned_at refreshes starved every frontier_hot run
  // into claiming 0 targets and finishing "done" with 0 checks (observed live).
  if (v.includes("frontier")) return 0;
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
  // FRONTIER — Frontier fiber sweeps are revenue work (red leads), not bulk:
  // without this frontier_hot fell through to "market" and starved behind the
  // statewide Kinetic backlog.
  if (value.includes("frontier")) return "discovery";
  // DISCOVERY — address/market discovery that surfaces fresh leads.
  if (value.includes("discovery") || value.includes("fresh")) return "discovery";
  // MAINTENANCE — stale + statewide baseline (share-capped bulk).
  if (value.includes("city")) return "city";
  if (value.includes("recheck") || value.includes("rescan")) return "recheck";
  if (value.includes("nightly") || value.includes("scheduled")) return "nightly";
  return "market";
}

/**
 * The identity of the scan worker in THIS process.
 *
 * Stable for the lifetime of the process and distinct across processes, so the
 * heartbeat UPSERT collapses onto one row per live worker instead of minting a
 * new one per run. Host + pid is enough: two processes on one box differ by pid,
 * and two boxes differ by hostname. A restart legitimately produces a new row —
 * that is a genuinely new worker — and the old one ages out of the health view
 * by `heartbeat_at`, which is what that view already sorts on.
 */
let cachedWorkerId: string | null = null;
function stableWorkerId(): string {
  if (cachedWorkerId) return cachedWorkerId;
  const host = process.env.HOSTNAME || os.hostname() || "host";
  cachedWorkerId = `scan:${host}:${process.pid}`;
  return cachedWorkerId;
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
  // STABLE worker identity — a property of the PROCESS, not of the run.
  //
  // This was `scan:${runId}`, which made every run a brand-new worker. The
  // heartbeat table is keyed `worker_id TEXT PRIMARY KEY` and written with
  // `ON CONFLICT(worker_id) DO UPDATE` precisely so a worker keeps ONE row and
  // re-stamps it — but a run-scoped id can never collide, so the UPSERT never
  // fired and the table gained a permanent row per run forever. Measured on a
  // representative copy: 270,907 rows / 270,907 distinct worker_ids — exactly
  // 1:1, i.e. not one row was ever reused.
  //
  // The run is NOT lost: `run_id` is already a column on the row and the UPSERT
  // already refreshes it, so "which run is this worker on right now" still
  // answers correctly — it just stops costing a row to ask.
  const workerId = stableWorkerId();
  let terminalError: string | null = null;
  // DECOUPLED RUN HEARTBEAT — the reaper's only cross-process ownership signal.
  // touchRun() is also called per-batch (below), but a batch can stall far past the
  // reaper's staleness window during a long admission wait (coordinator can block a
  // single address up to ~120s when Decodo's 403 window is depleted). In multi-process
  // mode a sibling worker's reaper would then see this run's heartbeat as stale and
  // reset its in-flight targets — double-spending the proxy on addresses this worker
  // is mid-flight on. Stamping heartbeat_at every 10s independently of batch progress
  // keeps "a live worker (in ANY process) owns this run" true for getResumableRuns(),
  // so no other process reaps a run we're actively working. When THIS worker dies the
  // timer stops, the heartbeat goes stale within the window, and recovery proceeds
  // correctly. Harmless in single-process (fewer false-positive self-reclaims). Unref
  // so it never keeps the process alive on shutdown.
  const hbTimer: ReturnType<typeof setInterval> = setInterval(() => {
    try { touchRun(runId); } catch { /* transient DB busy — next tick covers it */ }
  }, 10_000);
  if (typeof (hbTimer as any).unref === "function") (hbTimer as any).unref();
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
  const BATCH = Math.max(1, Number(process.env.SCAN_BATCH_CONCURRENCY) || 100);
  try {
    for (;;) {
      const run = getRun(runId, tenantId);
      if (!run) return;
      if (run.status !== "running") return; // paused / cancelled / done — stops the pump
      if (run.verified + run.failed >= run.budget) {
        // Budget spent — close the leftover queued tail so the stranded-tail
        // drain can't re-open this run into an infinite livelock.
        try { terminalizeQueuedTail(runId, "superseded: run budget exhausted"); } catch { /* next tick covers it */ }
        finish(run, "done");
        return;
      }

      const remainingBudget = run.budget - (run.verified + run.failed);
      // C2 — the engine honors the SHARED proxy breaker (C1). Before this gate
      // the bulk engine never consulted the breaker: in non-unlimited mode it
      // kept firing batches through the post-trip COOLDOWN, and every failure
      // during RECOVERING re-armed the cooldown — a self-perpetuating throttle.
      // While the circuit is in its brief full-stop, yield instead of claiming
      // (claiming would just buy a batch of doomed 407s). RECOVERING stays
      // claimable: the probe trickle is exactly how the breaker climbs shut,
      // and budgetScale already throttles the trickle. touchRun keeps the
      // heartbeat fresh so no sibling reaper reclaims the run mid-cooldown.
      // Unlimited mode: isProxyCircuitOpen() is always false → zero change.
      if (isProxyCircuitOpen()) {
        touchRun(runId);
        logBreakerWait(runId);
        await new Promise((r) => setTimeout(r, BREAKER_WAIT_MS));
        continue; // re-check run status at the loop top (a cancel lands promptly)
      }
      // Atomically CLAIM the batch (marks them inflight) so a racing dispatch can't
      // grab the same targets and double-spend the proxy. Requeued (transient-error)
      // targets are 'queued' again, so the queue only drains once every address has
      // a conclusive or unresolved answer.
      const batch = claimRunTargets(runId, Math.min(BATCH, remainingBudget), dedupSkipSecondsForRun(run.kind));
      // Yield a full event-loop turn every claim cycle: a batch of instantly-failing
      // addresses (fail-closed transport) would otherwise chain microtasks forever
      // and starve timers/cancels. One setImmediate per batch costs ~nothing.
      await new Promise(resolve => setImmediate(resolve));
      // Website-safety feedback loop: when the event loop or health probe shows
      // stress, every worker injects a shared, smoothly-adjusting delay between
      // batches (AIMD). The fleet can run continuously at max safe throughput —
      // it contracts before users feel it and re-expands when the site is idle.
      await adaptivePace();
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

      let blockedInBatch = 0; // 403/throttle count — drives the storm back-off below
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
              carrier: (t as any).carrier ?? "kinetic",
              source: providerPriorityForRun(run.kind),
              // Abandon the admission wait immediately if the run is cancelled/paused,
              // rather than blocking up to admissionMaxWaitMs.
              abort: () => { const r = getRun(runId, tenantId); return !r || r.status !== "running"; },
            });
            // The check may have taken seconds of network time — a cancel/pause
            // that landed MID-FLIGHT must win. Record NOTHING on a non-running
            // run (no finalize, no requeue, no counters): the claimed target
            // stays 'inflight' and resume/reaper returns it to the queue, same
            // as the pre-claim law above. Without this gate a cancelled run
            // could still accrue verified/failed from checks already in the air.
            const postCheck = getRun(runId, tenantId);
            if (!postCheck || postCheck.status !== "running") return;
            if (result.blocked || checkFailed) {
              // TRANSIENT non-answer (throttle, transport error, malformed body,
              // soft success=false) — REQUEUE and retry later with a fresh token.
              // Never finalized, never counted failed/unresolved, never a no-fiber.
              // A conclusive "not serviceable" is NOT this path — the scanner
              // returns that as a real kinetic_live answer. No retry-count limit:
              // it recurs until a valid response or an explicit cancel.
              const category = result.blocked ? "provider_blocked" : "inconclusive";
              if (result.blocked) blockedInBatch++; // 403/throttle — feeds storm back-off
              const attempt = targetAttempt(runId, t.targetId);
              // A throttle/transport block AND a generic transient check failure retry
              // promptly (they clear on the next attempt). ONLY a brand-new-address
              // non-answer — Kinetic returns AddressNeedsFix/AddressSuggestions for
              // addresses not yet in its fabric — backs off exponentially: hammering
              // it every second is wasteful and keeps the run spinning forever. The
              // address is still preserved + retried, just on a slower cadence, so the
              // run can drain instead of stranding a perpetually-requeued tail.
              const addressNotReady = !result.blocked && /AddressNeedsFix|AddressSuggestions/i.test(result.notes || "");
              // Target-level ledger of needs-fix non-answers. Only counts while the
              // address has never had a conclusive answer; a real answer later
              // resets it to 0 (recordScanTargetResult).
              const needsFixCount = addressNotReady ? storage.bumpScanTargetInconclusive({ id: t.targetId }) : 0;
              // TERMINAL requires the cap in REAL needs-fix non-answers (the
              // ledger), never in raw claim attempts: attempt_count also grows on
              // throttles and fail-closed no-session retries, and those must not
              // push an address toward an address_not_found verdict it never
              // earned. Ledger 0 with addressNotReady means the address already
              // has a conclusive answer (the ledger doesn't count then) — fall
              // back to the per-run attempt cap so such a run can still drain.
              if (addressNotReady && (needsFixCount >= ANF_TERMINAL_ATTEMPTS || (needsFixCount === 0 && attempt >= ANF_TERMINAL_ATTEMPTS))) {
                // N real attempts (sessions rotate across them), every one a needs-fix
                // non-answer with no adoptable suggestion → the ADDRESS STRING is not
                // in Kinetic's fabric today. Conclude address_not_found — a conclusive
                // DATA verdict about the address, never a no-service serviceability
                // verdict. The target parks out of BULK claims for the quiet window
                // (claimRunTargets; manual/lasso/recheck kinds always re-verify), is
                // re-probed after it (fabric imports do add streets), and the run
                // drains instead of dragging a permanently-requeued tail. Prod data
                // behind the cap: 30,385 targets stuck at 8+ attempts were re-burning
                // ~30% of daily check capacity with zero yield.
                finalizeRunTarget(runId, t.targetId, "failed", `address_not_found: ${attempt}× needs-fix non-answer, no adoptable suggestion`, { failed: 1, estBytes: bytes });
                emitStage({
                  addressKey: normalizeKineticAddressKey(t.address, t.city, t.state, t.zip),
                  address: t.address, city: t.city, state: t.state, zip: t.zip,
                  runId, source: run.kind, stage: "classified", status: "ok", attempt,
                  classification: "address_not_found",
                  detail: `conclusive after ${attempt} needs-fix attempts - address not in Kinetic fabric (NOT no-service); quiet ${ANF_QUIET_DAYS}d then re-probe`,
                  tsEpoch: Date.now(),
                });
                recordFiberFailure({
                  tenantId, runId, targetId: t.targetId, category: "address_not_found",
                  message: result.notes || "needs-fix non-answer", attempt, retryable: false,
                });
                recordProviderOutcome(tenantId, false, result.notes);
                appendFiberEvent({
                  tenantId, runId, eventType: "address.not_found_terminal", targetId: t.targetId,
                  payload: { attempt },
                });
              } else {
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
              }
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
            // If persistence failed after the engine emitted `saving`, make the
            // latest inspector state terminal. Otherwise a recovered/requeued
            // target looks permanently stuck at Saving even though the worker
            // already handled the exception.
            emitStage({
              addressKey: normalizeKineticAddressKey(t.address, t.city, t.state, t.zip),
              address: t.address, city: t.city, state: t.state, zip: t.zip,
              runId, source: run.kind, stage: "error", status: "error", attempt,
              latencyMs: Date.now() - checkStartedAt,
              retryReason: "worker/persistence exception - address requeued",
              detail: message.slice(0, 160),
              tsEpoch: Date.now(),
            });
          }
        }),
      );

      // 403-STORM BACK-OFF. Decodo's rolling-window throttle returns 403 for
      // (nearly) every request once the window is depleted. Without this, workers
      // keep hammering + rotating sessions at full tilt — pegging the CPU, starving
      // /api/health, and producing ~zero leads (all blocked) while KEEPING the
      // window depleted so it never refills. When most of a batch was blocked,
      // sleep proportionally so the worker yields the CPU and the window refills;
      // a clean batch resets to full speed. In-memory + per-batch only — never a
      // persisted halt (a DB-persisted 403 halt once survived restarts and stranded
      // scanning at "0 checked"). PROVIDER_BLOCK_* tune it.
      if (batch.length > 0 && blockedInBatch / batch.length >= PROVIDER_BLOCK_BACKOFF_FRACTION) {
        const severity = blockedInBatch / batch.length; // 0..1
        const backoffMs = Math.round(PROVIDER_BLOCK_BACKOFF_MS * severity);
        structuredLog("scan.provider.storm_backoff", { runId, blocked: blockedInBatch, batch: batch.length, backoffMs }, "warn");
        await new Promise((r) => setTimeout(r, backoffMs));
      }

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
      // GUARDED: a projection failure must never flip an otherwise-healthy run
      // to status='error' — the evidence is durably persisted, so the next
      // projector pass (any trigger) republishes what this one missed.
      let projected: ReturnType<typeof projectConfirmedFreshLeads>;
      try {
        projected = projectConfirmedFreshLeads(
          tenantId,
          batch.map((target) => target.targetId),
        );
      } catch (error: any) {
        structuredLog("fresh_fiber.projection_failed", {
          tenantId, batch: batch.length, error: String(error?.message ?? error),
        }, "warn");
        projected = { considered: 0, confirmed: 0, created: 0, linkedExisting: 0, published: 0, provisional: 0, rejected: 0, addressReview: 0, leadIds: [], errors: [] };
      }
      if (projected.published > 0) {
        // Wake the harvest: these new drops just made their cell/street
        // neighbours immediately due (flip-proximity), so scan them within
        // seconds rather than waiting for the next periodic cycle. Debounced +
        // rate-limited, so a whole street lighting at once coalesces to one wake.
        try {
          const { wakeHarvest } = await import("./harvestScheduler");
          wakeHarvest("fresh_drop");
        } catch { /* scheduler optional */ }
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
      // Every classified batch seeds deduplicated CRITICAL cluster expansion
      // for targets that prove the pocket is lit — fresh leads (new_fiber+N)
      // AND active customers on new fiber (new_fiber+A/Y). Runs OUTSIDE the
      // published>0 gate: a lit-customer observation publishes no lead yet is
      // the strongest possible signal that the unsold neighbors are due now.
      try {
        const started = triggerExpansionForTargets(tenantId, batch.map((t) => t.targetId));
        if (started) structuredLog("expansion.seeded", { tenantId, expansions: started }, "info");
      } catch (e: any) {
        structuredLog("expansion.seed_failed", { tenantId, error: String(e?.message ?? e).slice(0, 120) }, "warn");
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
    clearInterval(hbTimer); // stop the decoupled heartbeat so a finished/dead run goes stale and is reclaimable
    activeRuns.delete(runId);
    pumpRunQueue(); // a slot freed — start the next queued run, if any
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
  const inspectorBase = {
    addressKey: normalizeKineticAddressKey(t.address, t.city, t.state, t.zip),
    address: t.address, city: t.city, state: t.state, zip: t.zip,
    runId, source: "run", attempt: 1,
  } as const;
  // Correct lifecycle order: the scanner has parsed a conclusive response; the
  // engine is about to persist it. A second terminal `classified` event is
  // emitted only after every required write/finalization below succeeds.
  emitStage({
    ...inspectorBase,
    stage: "saving", status: "info",
    classification: result.fiberStatus,
    detail: `persisting conclusive snapshot · ${result.fiberStatus}`,
    tsEpoch: Date.now(),
  });

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
    // Frontier serving-area fingerprint ("cn:<controlNumber>"); null on Kinetic.
    frontierControl: (result as any).exchangeId ?? null,
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
    // service not yet orderable. Record it on the program board (opportunity
    // score, expected completion). Rechecks are scheduled exclusively by the
    // comingSoonWatchlist engine, whose row this same conclusive result also
    // upserts via recordAvailabilitySnapshot's choke point.
    if (isActiveBilling(result.billingStatus)) {
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
        isComingSoon: isActiveBilling(result.billingStatus),
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
  emitStage({
    ...inspectorBase,
    stage: "classified", status: "ok",
    httpStatus: 200,
    latencyMs: result.providerLatencyMs ?? latencyMs,
    classification: result.fiberStatus,
    detail: `snapshot saved · ${result.fiberStatus}`,
    tsEpoch: Date.now(),
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
    competitorName: result.competitorName,
    competitorTech: result.competitorTech,
    competitorSpeedMbps: result.competitorSpeedMbps,
    error: checkFailed ? result.notes : null,
    blocked: result.blocked,
    latencyMs,
    orIgnore: true,
  });
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

// BOOT-STORM GUARD (2026-07-24 — five failed deploy health gates). Both resume
// paths dispatched EVERY resumable run in a single tick; with 221 runs carrying
// 116k queued targets, a boot spawned 221 worker loops at once, each racing to
// mint a Decodo token. Against Decodo's 403 rolling window that becomes a
// mint/rotate spin across all four workers, the event loops peg, in-container
// health probes fail, and the deploy rolls back — stranding MORE runs, so the
// next boot's storm is bigger (self-amplifying). Resumes are now BOUNDED per
// tick; the 60s reaper drains the remainder progressively. Nothing is lost:
// runs stay 'running' with their queued rows intact until dispatched.
const RESUME_MAX_PER_TICK = Math.max(1, Number(process.env.SCAN_RESUME_MAX_PER_TICK) || 8);

// C3 — how many times the stranded-tail drain may re-open the same run before
// concluding it persistently errors on dispatch/claim and leaving it 'error'.
const REOPEN_BUDGET = Math.max(1, Number(process.env.SCAN_REOPEN_BUDGET) || 5);

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
    let dispatched = 0;
    let deferred = 0;
    for (const run of runs) {
      if (isRunActive(run.id)) continue; // a live worker already owns it
      resetInflightTargets(run.id); // return crash-orphaned claims to the queue
      if (countQueued(run.id) === 0) {
        setRunStatus(run.id, "done");
        continue;
      }
      if (dispatched >= RESUME_MAX_PER_TICK) { deferred++; continue; } // next reaper tick
      console.log(
        `[scan-engine] resuming interrupted run ${run.id} (${countQueued(run.id)} pending)`,
      );
      dispatchRun(run.id, run.tenantId);
      dispatched++;
    }
    if (deferred > 0) {
      console.log(`[scan-engine] resume bounded: ${dispatched} dispatched, ${deferred} deferred to the next reaper tick`);
    }
    // Drain STRANDED TAILS: 'done' or 'error' runs that still hold claimable queued
    // targets (a target requeued exactly as the batch drained, or a worker that died
    // on a terminal exception). Re-open a bounded number so every discovered address
    // is actually consumed — "preserve and retry every address." The requeue backoff
    // makes the re-opened run converge, not spin. ('cancelled' stays closed.)
    for (const run of getStrandedDoneRuns(10)) {
      if (isRunActive(run.id)) continue;
      // BUDGET-EXHAUSTED TAIL: the run already spent its full budget
      // (verified+failed >= budget), so a worker would finish 'done' on the
      // budget check WITHOUT claiming — leaving the queued tail stranded, and
      // this drain re-opening the same runs every tick forever (observed live:
      // 43 runs in a re-open livelock, scanning fully stalled). Terminalize
      // the leftover tail instead of re-opening.
      if (run.verified + run.failed >= run.budget) {
        const closed = terminalizeQueuedTail(run.id, "superseded: run budget exhausted");
        if (closed > 0) console.log(`[scan-engine] closed budget-exhausted tail on ${run.id} (${closed} skipped)`);
        continue;
      }
      // C3 — RE-OPEN ERROR BUDGET. A run that persistently errors on
      // dispatch/claim used to be re-opened every 60s FOREVER (each failed
      // worker flipped it back to 'error', the tail stayed claimable, the
      // drain matched it again next tick). The persisted reopen_count (shared
      // by every worker's reaper, restart-proof) caps the re-opens: past the
      // budget the run stays 'error', its tail is terminalized so it stops
      // matching the drain (one alert, not one per tick), and the addresses
      // remain in scan_targets for the next full sweep.
      if ((run.reopenCount ?? 0) >= REOPEN_BUDGET) {
        const closed = terminalizeQueuedTail(run.id, `re-open budget exhausted (${REOPEN_BUDGET} failed re-opens)`);
        setRunStatus(run.id, "error", `re-open budget exhausted after ${REOPEN_BUDGET} failed re-opens - tail terminalized (${closed} skipped)`);
        structuredLog("scan.run.reopen_budget_exhausted", {
          runId: run.id, kind: run.kind, status: run.status,
          reopens: run.reopenCount ?? 0, tailClosed: closed,
        }, "error");
        continue;
      }
      resetInflightTargets(run.id);
      bumpRunReopen(run.id);
      setRunStatus(run.id, "running");
      console.log(`[scan-engine] re-opening stranded '${run.status}' run ${run.id} (${countQueued(run.id)} claimable pending)`);
      dispatchRun(run.id, run.tenantId);
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
    let dispatched = 0;
    let deferred = 0;
    for (const run of getResumableRuns(0)) {
      // Fast-resume every REVENUE-class run (IMMEDIATE/NEW_BUILD/DISCOVERY) so a rep's
      // tap, a fresh new-build/Coming-Soon check, or a discovery run never waits for the
      // 30s staleness window after a deploy. EXPANSION/MAINTENANCE resume via the reaper.
      if (!isRevenueAdmissionClass(providerPriorityForRun(run.kind))) continue;
      if (isRunActive(run.id)) continue;
      resetInflightTargets(run.id);
      if (countQueued(run.id) === 0) { setRunStatus(run.id, "done"); continue; }
      // Bounded even for revenue class: a rep's live tap goes through the
      // CRITICAL admission reserve, not through this backlog drain, so capping
      // the boot burst costs no interactive latency.
      if (dispatched >= RESUME_MAX_PER_TICK) { deferred++; continue; }
      console.log(`[scan-engine] fast-resuming revenue run ${run.id} kind=${run.kind} (${countQueued(run.id)} pending)`);
      dispatchRun(run.id, run.tenantId);
      dispatched++;
    }
    if (deferred > 0) {
      console.log(`[scan-engine] critical resume bounded: ${dispatched} dispatched, ${deferred} deferred`);
    }
  } catch (err: any) {
    console.warn("[scan-engine] critical resume failed:", err?.message);
  }
}

// PERIODIC REAPER — resumeInterruptedRuns on a timer, not just at boot, so a run
// whose worker died WITHOUT a process restart (an unhandled rejection, an OOM'd
// batch) is picked back up within a minute instead of hanging 'running' forever.
let _reaper: ReturnType<typeof setInterval> | null = null;
/** A reaper tick above this is worth a log line: it is time the worker's request
 *  loop spent not serving requests. */
const REAPER_SLOW_TICK_MS = Math.max(50, Number(process.env.SCAN_REAPER_SLOW_MS) || 250);
export function startScanReaper(intervalMs = 60_000): void {
  if (_reaper) return;
  // INSTRUMENTATION (2026-08-10): this tick runs in EVERY cluster worker
  // (server/index.ts, "RUN CONSUMERS + REAPER — run in EVERY worker"), and
  // workers 1..N-1 DO serve HTTP - worker 0 does not, because controlSkipsHttp
  // (server/index.ts:1716) gives the control role a dedicated loop when
  // SCAN_WORKERS > 1. So this is charged to a request loop in every serving
  // worker. resumeInterruptedRuns() is synchronous better-sqlite3, and its
  // getStrandedDoneRuns() probe was measured at 0.6-6.9s against a 2.85GB
  // database with production pragmas.
  //
  // Without this line a slow tick is invisible: it produces no request log and
  // no error. It cannot even be inferred from http.request, because that
  // timer starts at Express middleware entry - i.e. AFTER the loop resumes, so
  // a 15s stall is logged as a 3ms request.
  _reaper = setInterval(() => {
    const startedAt = Date.now();
    resumeInterruptedRuns();
    const ms = Date.now() - startedAt;
    if (ms >= REAPER_SLOW_TICK_MS) {
      structuredLog("scan.reaper.slow_tick", {
        ms, pid: process.pid, role: process.env.HF_ROLE ?? null,
      }, "warn");
    }
  }, intervalMs);
  if (typeof (_reaper as any).unref === "function") (_reaper as any).unref();
  startFleetHeartbeat(); // C4 — started with the reaper so index.ts needs no new wiring
}

// ── C4: FLEET HEARTBEAT ──────────────────────────────────────────────────────
// adaptivePaceStats() had zero consumers and queue depth / breaker state were
// never emitted — a throttle storm was invisible until leads stopped. One cheap
// structured snapshot per minute from the CONTROL worker only (the reaper runs
// in every cluster worker; 4× duplicate events would be noise).
const FLEET_HEARTBEAT_MS = Math.max(5_000, Number(process.env.SCAN_FLEET_HEARTBEAT_MS) || 60_000);
let _fleetHeartbeat: ReturnType<typeof setInterval> | null = null;

export function emitFleetHeartbeat(): void {
  try {
    const pace = adaptivePaceStats();
    const breaker = circuitBreakerSnapshot();
    // INSTRUMENTATION (2026-08-10): "one cheap COUNT each" is not true at scale -
    // countClaimableQueued has no usable index for its next_attempt_at OR clause
    // and plans as a full SCAN of scan_run_targets (verified with EXPLAIN QUERY
    // PLAN); measured 84-228ms on a 2.85GB database.
    //
    // This runs in the CONTROL worker, which since aae365f does NOT serve HTTP
    // when SCAN_WORKERS > 1 (controlSkipsHttp, server/index.ts:1716) - so the
    // cost lands on a dedicated producer loop, not a request loop. countsMs is
    // here to keep that claim honest if the role ever changes.
    const countsStartedAt = Date.now();
    const claimableQueued = countClaimableQueued();
    const activeRunCount = countActiveRuns();
    const openDeadLetters = countOpenDeadLetters();
    const countsMs = Date.now() - countsStartedAt;
    structuredLog("scan.fleet.heartbeat", {
      paceMs: pace.paceMs,
      loopLagP95: pace.loopLagP95,
      healthMs: pace.healthMs,
      countsMs,
      claimableQueued,
      activeRuns: activeRunCount,
      activeWorkers: activeRuns.size,
      breakerOpen: breaker.open,
      breakerStep: breaker.step,
      breakerScale: breaker.scale,
      openDeadLetters,
    });
  } catch { /* heartbeat is best-effort — never wedge the control worker */ }
}

export function startFleetHeartbeat(intervalMs = FLEET_HEARTBEAT_MS): void {
  if (_fleetHeartbeat) return;
  // Control worker only. Single-process / dev (no HF_ROLE) IS the control role,
  // matching index.ts's IS_CONTROL_ROLE rule; scan-only workers (HF_ROLE=scan)
  // never emit.
  if (process.env.HF_ROLE && process.env.HF_ROLE !== "control") return;
  _fleetHeartbeat = setInterval(emitFleetHeartbeat, intervalMs);
  if (typeof (_fleetHeartbeat as any).unref === "function") (_fleetHeartbeat as any).unref();
}
