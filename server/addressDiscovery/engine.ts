import os from "node:os";
import crypto from "node:crypto";
import {
  geometryBbox,
  planDiscoveryTiles,
  validateDiscoveryGeometry,
} from "@shared/addressDiscovery";
import { MAX_CHECKS_PER_RUN } from "@shared/scanEconomics";
import { rawDb } from "../db";
import { storage } from "../storage";
import { createScanRun, enqueueRunTargets, getRun } from "../scanIntelStore";
import { runScanWorker } from "../scanEngine";
import { structuredLog } from "../structuredLog";
import { resolvePointLocality, resolveTownBoundary } from "./boundary";
import { isElectedAreaJob } from "./electedJob";
import { addressSources, stableSourceCacheKey } from "./sources";
import type { SourcePage } from "./types";
import { bboxPolygon, parseJson } from "./types";
import {
  activeQualificationJobs,
  appendDiscoveryEvent,
  attachScanTarget,
  cacheGet,
  cachePut,
  claimBoundaryJob,
  claimNextTile,
  completeTile,
  createQualificationCheck,
  discoveryReadyForQualification,
  failTile,
  getDiscoveryJob,
  jobsReadyForQualification,
  streamingDiscoveryJobs,
  mapDiscoveryRun,
  markBoundaryRetry,
  mergeAddressEvidence,
  planDiscoveryTiles as persistTiles,
  undispatchedQualificationCandidates,
  qualificationCandidateCount,
  markQualificationDispatchComplete,
  publishQualificationMapCandidates,
  publishQualificationMapResults,
  reconcileQualificationJob,
  recordHandoffCollision,
  setJobQualification,
  setResolvedBoundary,
  setResolvedLocality,
  terminalizeOrphanedElectedJobs,
  touchTileLease,
  updateSourceHealth,
  updateTileCheckpoint,
  type DiscoveryJobRow,
  type DiscoveryTileRow,
} from "./store";

const workerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;
// Unlimited budget → harvest addresses wide open: 6 tile workers by default
// (bound raised to 16) so city discovery finishes in minutes, not hours.
const maxWorkers = Math.max(
  1,
  Math.min(16, Number(process.env.DISCOVERY_WORKER_CONCURRENCY) || 6),
);
let running = 0;
let scheduler: ReturnType<typeof setInterval> | null = null;
let reconciler: ReturnType<typeof setInterval> | null = null;
let scheduling = false;

function sourcePageFromCache(
  payload: unknown,
  partial: boolean,
): SourcePage | null {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as any).records)
  )
    return null;
  return { ...(payload as SourcePage), partial };
}

async function processBoundary(job: DiscoveryJobRow): Promise<void> {
  if (job.phase === "locality" && job.areaJson) {
    try {
      const geometry = validateDiscoveryGeometry(parseJson(job.areaJson, null));
      const bbox = geometryBbox(geometry);
      const locality = await resolvePointLocality(
        (bbox.west + bbox.east) / 2,
        (bbox.south + bbox.north) / 2,
      );
      if (job.state !== "US" && job.state !== locality.state)
        throw new Error(
          `Selected geometry is in ${locality.state}, not ${job.state}`,
        );
      setResolvedLocality(job.id, locality.city, locality.state);
      const tiles = planDiscoveryTiles(geometry, {
        targetTileAreaKm2: Math.max(
          0.05,
          Number(process.env.DISCOVERY_TILE_AREA_KM2) || 5,
        ),
        maxTiles: Math.max(1, Number(process.env.DISCOVERY_MAX_TILES) || 2_048),
      });
      persistTiles(
        job.id,
        tiles.map((tile) => ({
          key: tile.id,
          bbox: tile.bbox,
          geometry: bboxPolygon(tile.bbox),
        })),
      );
      appendDiscoveryEvent(job.tenantId, job.id, "locality.resolved", {
        city: locality.city,
        state: locality.state,
        tileCount: tiles.length,
      });
    } catch (error: any) {
      markBoundaryRetry(job, String(error?.message ?? error));
    }
    return;
  }
  if (!job.townName) {
    markBoundaryRetry(job, "Town-boundary job is missing a town name");
    return;
  }
  try {
    const resolved = await resolveTownBoundary(
      job.tenantId,
      job.townName,
      job.state,
    );
    const geometry = validateDiscoveryGeometry(resolved.geometry, {
      maxAreaKm2: Math.max(
        1,
        Number(process.env.DISCOVERY_MAX_AREA_KM2) || 250_000,
      ),
      maxVertices: Math.max(
        1_000,
        Number(process.env.DISCOVERY_MAX_BOUNDARY_VERTICES) || 50_000,
      ),
    });
    setResolvedBoundary(job.id, geometry, resolved.bbox);
    const tiles = planDiscoveryTiles(geometry, {
      targetTileAreaKm2: Math.max(
        0.05,
        Number(process.env.DISCOVERY_TILE_AREA_KM2) || 5,
      ),
      maxTiles: Math.max(1, Number(process.env.DISCOVERY_MAX_TILES) || 2_048),
    });
    persistTiles(
      job.id,
      tiles.map((tile) => ({
        key: tile.id,
        bbox: tile.bbox,
        geometry: bboxPolygon(tile.bbox),
      })),
    );
    appendDiscoveryEvent(job.tenantId, job.id, "boundary.resolved", {
      source: resolved.source,
      sourceRef: resolved.sourceRef,
      cached: resolved.cached,
      geometryType: geometry.type,
      tileCount: tiles.length,
    });
  } catch (error: any) {
    markBoundaryRetry(job, String(error?.message ?? error));
  }
}

async function processTile(
  job: DiscoveryJobRow,
  tile: DiscoveryTileRow,
): Promise<void> {
  const current = getDiscoveryJob(job.tenantId, job.id);
  if (!current || current.status === "cancelled") return;
  const overallGeometry = validateDiscoveryGeometry(
    parseJson(current.areaJson, null),
  );
  const bbox = parseJson(tile.bboxJson, null);
  if (!bbox) throw new Error("Discovery tile is missing its bounding box");
  const configuredSources = addressSources(job.tenantId);
  const sourceConfig = parseJson<Record<string, any>>(job.sourceConfigJson, {});
  const requestedSources = sourceConfig.requestedSources;
  const requestedIds = Array.isArray(requestedSources)
    ? requestedSources.map(String)
    : null;
  const snapshot = Array.isArray(sourceConfig.sourceSnapshot)
    ? (sourceConfig.sourceSnapshot as Array<{
        sourceId: string;
        priority: number;
      }>)
    : null;
  const snapshotPriority = new Map(
    (snapshot ?? []).map((entry) => [
      String(entry.sourceId),
      Number(entry.priority),
    ]),
  );
  const snapshotted = snapshot
    ? configuredSources.filter((source) =>
        snapshotPriority.has(source.metadata.id),
      )
    : configuredSources;
  const sources = (
    requestedIds
      ? snapshotted.filter((source) =>
          requestedIds.includes(source.metadata.id),
        )
      : snapshotted
  ).sort(
    (a, b) =>
      (snapshotPriority.get(a.metadata.id) ?? a.metadata.defaultPriority) -
      (snapshotPriority.get(b.metadata.id) ?? b.metadata.defaultPriority),
  );
  if (!sources.length) {
    failTile(
      job.tenantId,
      job.id,
      tile.id,
      "No address source is configured or healthy",
    );
    return;
  }
  const controller = new AbortController();
  const leaseHeartbeat = setInterval(
    () => touchTileLease(tile.id, 180),
    30_000,
  );
  if (typeof (leaseHeartbeat as any).unref === "function")
    (leaseHeartbeat as any).unref();
  const errors: Record<string, string> = {};
  if (requestedIds) {
    const activeIds = new Set(sources.map((source) => source.metadata.id));
    for (const sourceId of requestedIds)
      if (!activeIds.has(sourceId))
        errors[sourceId] =
          "Requested source is unavailable or its circuit is open";
  }
  const checkpoints = parseJson<Record<string, any>>(
    tile.sourceCheckpointJson,
    {},
  );
  const canonicalUnion = new Set<number>();
  const authoritativeUnion = new Set<number>();
  const primaryUnion = new Set<number>();
  let observed = 0,
    inferred = 0,
    duplicates = 0,
    cacheHits = 0,
    cacheMisses = 0,
    evidenceOnly = 0;

  try {
    for (const source of sources) {
      const live = getDiscoveryJob(job.tenantId, job.id);
      if (!live || live.status === "cancelled") {
        controller.abort();
        return;
      }
      let page: SourcePage;
      const ctx = {
        tenantId: job.tenantId,
        jobId: job.id,
        tileId: tile.id,
        bbox,
        geometry: overallGeometry,
        city: job.townName,
        state: job.state,
        signal: controller.signal,
        thorough: isElectedAreaJob(job),
      };
      const key = stableSourceCacheKey(source.metadata.id, ctx);
      const cached = cacheGet(job.tenantId, source.metadata.id, key);
      try {
        const decoded = cached
          ? sourcePageFromCache(cached.payload, cached.partial)
          : null;
        if (decoded) {
          page = decoded;
          cacheHits++;
        } else {
          cacheMisses++;
          page = await source.discover(ctx);
          if (!page.partial)
            cachePut(
              job.tenantId,
              source.metadata.id,
              key,
              page,
              false,
              source.metadata.id === "osm_overpass"
                ? 6
                : source.metadata.id === "first_party" ||
                    source.metadata.id === "manual_upload"
                  ? 1
                  : 24,
            );
        }
        let sourceObserved = 0,
          sourceInferred = 0,
          sourceDuplicates = 0,
          sourceEvidenceOnly = 0;
        // Commit one source page as a batch. mergeAddressEvidence retains its
        // row-level savepoint semantics, while the outer transaction avoids a
        // disk fsync per address on 5k+ result pages.
        rawDb
          .transaction(() => {
            for (const record of page.records) {
              const merged = mergeAddressEvidence({
                tenantId: job.tenantId,
                jobId: job.id,
                tileId: tile.id,
                sourceId: record.sourceId ?? source.metadata.id,
                authoritative: source.metadata.authoritative,
                evidenceOnly: source.metadata.evidenceOnly,
                licenseName: source.metadata.licenseName,
                licenseUrl: record.licenseUrl ?? source.metadata.licenseUrl,
                city: job.townName,
                state: job.state,
                record: {
                  ...record,
                  licenseName:
                    record.licenseName ?? source.metadata.licenseName,
                },
              });
              if (merged.rejected === "evidence_only") {
                sourceEvidenceOnly++;
                continue;
              }
              if (merged.rejected || merged.canonicalAddressId == null)
                continue;
              canonicalUnion.add(merged.canonicalAddressId);
              if (source.metadata.authoritative || record.authoritative)
                authoritativeUnion.add(merged.canonicalAddressId);
              if (source.metadata.coverageClass === "primary")
                primaryUnion.add(merged.canonicalAddressId);
              if (merged.inferred) sourceInferred++;
              else sourceObserved++;
              if (merged.duplicate) sourceDuplicates++;
            }
          })
          .immediate();
        observed += sourceObserved;
        inferred += sourceInferred;
        duplicates += sourceDuplicates;
        evidenceOnly += sourceEvidenceOnly;
        const checkpoint = {
          status: page.partial ? "partial" : "complete",
          records: page.records.length,
          observed: sourceObserved,
          inferred: sourceInferred,
          duplicates: sourceDuplicates,
          evidenceOnly: sourceEvidenceOnly,
        };
        checkpoints[source.metadata.id] = checkpoint;
        updateTileCheckpoint(
          tile.id,
          source.metadata.id,
          checkpoint,
          page.partial ? "Source returned a partial page" : null,
        );
        updateSourceHealth({
          tenantId: job.tenantId,
          sourceId: source.metadata.id,
          ok: !page.partial,
          records: page.records.length,
          error: page.partial ? "Partial response" : undefined,
        });
        if (page.partial)
          errors[source.metadata.id] = "Source returned a partial page";
      } catch (error: any) {
        const message = String(error?.message ?? error).slice(0, 300);
        errors[source.metadata.id] = message;
        checkpoints[source.metadata.id] = { status: "failed", error: message };
        updateTileCheckpoint(
          tile.id,
          source.metadata.id,
          checkpoints[source.metadata.id],
          message,
        );
        updateSourceHealth({
          tenantId: job.tenantId,
          sourceId: source.metadata.id,
          ok: false,
          error: message,
        });
      }
    }
    completeTile({
      tenantId: job.tenantId,
      jobId: job.id,
      tileId: tile.id,
      observed,
      inferred,
      duplicates,
      partial: Object.keys(errors).length > 0,
      errors,
      cacheHits,
      cacheMisses,
      authoritativeCount: authoritativeUnion.size,
      unionCount: canonicalUnion.size,
      primaryCount: primaryUnion.size,
      buildingEvidenceCount: evidenceOnly,
    });
    if (discoveryReadyForQualification(job.id))
      beginQualification(getDiscoveryJob(job.tenantId, job.id)!);
  } catch (error: any) {
    failTile(job.tenantId, job.id, tile.id, String(error?.message ?? error));
  } finally {
    clearInterval(leaseHeartbeat);
  }
}

function targetAddress(candidate: any): string {
  return (
    [candidate.houseNumber, candidate.street, candidate.unit]
      .filter(Boolean)
      .join(" ")
      .trim() || candidate.fullAddress
  );
}

function beginQualification(job: DiscoveryJobRow): void {
  if (!discoveryReadyForQualification(job.id)) return;
  // Atomic phase transition is the paid-work admission claim. Only the process
  // that changes discovery -> qualification may create scan_runs.
  if (!setJobQualification(job.id)) return;
  prepareAndDispatchQualification(getDiscoveryJob(job.tenantId, job.id)!);
}

/**
 * Dispatch provider checks for every candidate discovered SO FAR. Idempotent:
 * check rows dedupe per (job, canonical address) and only never-dispatched
 * checks (run_id IS NULL) enter a new run — so this streams safely per tile
 * while discovery is still running (finalize=false) and once more at the
 * discovery→qualification phase flip (finalize=true), which stamps
 * dispatch-complete and emits the qualification.started event.
 */
/** Returns the amount of dispatch work actually done this pass (new checks,
 *  queued runs, published batches) so the reconciler can tell an active pass
 *  from an idle one and pace itself accordingly. */
function prepareAndDispatchQualification(job: DiscoveryJobRow, finalize = true): number {
  // EVERY unique discovered address gets a live provider check — no reuse of
  // cached results, scan history, existing targets, or existing Leads. The only
  // per-job dedupe is dispatch idempotency, and it lives in the SQL: the
  // anti-join returns only candidates with no check row for THIS job, so a
  // fully dispatched job costs one empty indexed query here, not a re-walk of
  // every address it ever discovered.
  const candidates = undispatchedQualificationCandidates(job.id);
  let work = 0;
  for (const candidate of candidates) {
    work++;
    // The authorized Kinetic qualifier and fresh-lead projector support
    // GA/NC/SC. Discovery may still inventory a wider map geometry, but
    // unsupported states never consume a provider request that cannot be
    // published safely.
    if (!["GA", "NC", "SC"].includes(String(candidate.state).toUpperCase())) {
      createQualificationCheck({
        tenantId: job.tenantId,
        jobId: job.id,
        canonicalAddressId: candidate.id,
        targetId: null,
        state: "skipped",
        result: "unsupported_market",
      });
      continue;
    }
    const address = targetAddress(candidate);
    const collision = rawDb
      .prepare(
        // lower(TRIM(...)), matching idx_scan_targets_addr_city_state exactly.
        // SQLite only uses an expression index when the query spells the
        // expression the same way, so `lower(address)` - one trim() short - fell
        // back to a full SCAN of scan_targets (919,688 rows in production).
        // This runs per candidate inside an unbounded loop. Measured on the
        // real table: 0.022s per call as written, 0.000s trimmed.
        `SELECT id,address,city,state,zip,tenant_id AS tenantId FROM scan_targets
      WHERE lower(trim(address))=lower(trim(?)) LIMIT 1`,
      )
      .get(address) as any;
    if (
      collision &&
      (collision.tenantId == null ||
        Number(collision.tenantId) !== job.tenantId ||
        String(collision.city).toLowerCase() !==
          String(candidate.city).toLowerCase() ||
        String(collision.state).toUpperCase() !==
          String(candidate.state).toUpperCase())
    ) {
      recordHandoffCollision(job.tenantId, job.id, candidate, collision);
      createQualificationCheck({
        tenantId: job.tenantId,
        jobId: job.id,
        canonicalAddressId: candidate.id,
        targetId: null,
        state: "collision",
        result: "handoff_collision",
      });
      continue;
    }
    storage.upsertScanTargets([
      {
        address,
        city: candidate.city,
        state: candidate.state,
        zip: candidate.postalCode ?? "",
        lat: candidate.lat,
        lng: candidate.lng,
        source: "address_discovery",
        tenantId: job.tenantId,
        canonicalKey: candidate.canonicalKey,
      },
    ]);
    const target = rawDb
      .prepare(
        `SELECT id,city,state,zip FROM scan_targets WHERE tenant_id=? AND lower(address)=lower(?)
      AND lower(city)=lower(?) AND lower(state)=lower(?) LIMIT 1`,
      )
      .get(job.tenantId, address, candidate.city, candidate.state) as any;
    if (!target) {
      recordHandoffCollision(job.tenantId, job.id, candidate, collision);
      createQualificationCheck({
        tenantId: job.tenantId,
        jobId: job.id,
        canonicalAddressId: candidate.id,
        targetId: null,
        state: "collision",
        result: "handoff_collision",
      });
      continue;
    }
    attachScanTarget(job.id, candidate.id, Number(target.id));
    createQualificationCheck({
      tenantId: job.tenantId,
      jobId: job.id,
      canonicalAddressId: candidate.id,
      targetId: target.id,
    });
  }
  try {
    // Only never-dispatched checks: streaming passes stamp run_id via
    // mapDiscoveryRun, so an address can never enter two runs / be checked twice.
    const queued = rawDb
      .prepare(
        `SELECT canonical_address_id AS canonicalAddressId,scan_target_id AS targetId
      FROM qualification_checks WHERE job_id=? AND state='queued' AND run_id IS NULL AND scan_target_id IS NOT NULL
      ORDER BY canonical_address_id`,
      )
      .all(job.id) as Array<{ canonicalAddressId: number; targetId: number }>;
    // Run ids continue from prior streaming passes.
    let sequence = Number(
      (rawDb.prepare(`SELECT COALESCE(MAX(sequence),-1)+1 AS next FROM discovery_job_runs WHERE job_id=?`).get(job.id) as any)?.next ?? 0,
    );
    for (let offset = 0; offset < queued.length; offset += MAX_CHECKS_PER_RUN) {
      const batch = queued.slice(offset, offset + MAX_CHECKS_PER_RUN);
      const runId = `discovery_${job.id.replace(/-/g, "")}_${sequence}`;
      if (!getRun(runId, job.tenantId)) {
        createScanRun({
          id: runId,
          tenantId: job.tenantId,
          kind: "address_discovery",
          label: `${job.townName ?? "Area"} discovery ${sequence + 1}`,
          city: job.townName ?? "Selected area",
          state: job.state,
          budget: batch.length,
          createdBy: job.createdBy,
        });
      }
      // COUNT WHAT WAS ENQUEUED, not what was offered. `batch.length` counted
      // rows that enqueueRunTargets had already deduped away, so a pass that
      // inserted nothing still reported work - and the caller's idle backoff
      // (1s -> 31s) reads this number to decide whether it may slow down. With
      // a permanently non-zero `work` the reconciler stayed pinned at its 1s
      // floor against the same jobs forever, which is the write pressure that
      // grew the WAL from 70MB to 3.4GB in 23 minutes on 2026-08-10.
      const enqueued = enqueueRunTargets(
        runId,
        batch.map((row, index) => ({ id: Number(row.targetId), seq: index })),
      );
      mapDiscoveryRun(job.id, runId, sequence++);
      void runScanWorker(runId, job.tenantId);
      work += enqueued;
    }
    if (!finalize) {
      // Streaming pass mid-discovery: dispatched what exists so far; the phase
      // flip finalizes later. Publish map candidates so pins/coverage stream too.
      for (let n; (n = publishQualificationMapCandidates(job)) > 0; ) {
        work += n; /* bounded event batches */
      }
      return work;
    }
    markQualificationDispatchComplete(job.id);
    for (let n; (n = publishQualificationMapCandidates(job)) > 0; ) {
      work += n; /* bounded event batches */
    }
    appendDiscoveryEvent(job.tenantId, job.id, "qualification.started", {
      observedCandidates: qualificationCandidateCount(job.id),
      queued: queued.length,
      runs: sequence,
      handoffCollisions:
        getDiscoveryJob(job.tenantId, job.id)?.handoffCollisions ?? 0,
    });
    if (!queued.length)
      reconcileQualificationJob(getDiscoveryJob(job.tenantId, job.id)!);
  } catch (error: any) {
    rawDb
      .prepare(
        `UPDATE discovery_jobs SET status='partial',error_summary=?,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`,
      )
      .run(
        `Qualification dispatch failed: ${String(error?.message ?? error).slice(0, 300)}`,
        job.id,
      );
    appendDiscoveryEvent(
      job.tenantId,
      job.id,
      "qualification.dispatch_failed",
      { error: String(error?.message ?? error).slice(0, 300) },
    );
  }
  return work;
}

// ── Reconciler pacing ────────────────────────────────────────────────────────
// The reconciler shares the event loop with the API and (in dev) Vite. A parked
// fleet of jobs that cannot progress — scan transports down, budget exhausted —
// used to be re-walked at full price every second, forever; profiled at ~99%
// CPU in Statement.get with a few hundred stuck jobs. Passes that do zero work
// now back off one extra tick at a time (1s → 2s → … → 30s) and any wake —
// a new job, a finished tile, a resumed run — snaps the cadence back to 1s.
// A slow pass also never overlaps the next tick (`reconciling`).
let reconciling = false;
let reconcileIdleStreak = 0;
let reconcileSkipsLeft = 0;

function reconcile(): void {
  if (reconciling) return;
  if (reconcileSkipsLeft > 0) {
    reconcileSkipsLeft--;
    return;
  }
  reconciling = true;
  let work = 0;
  try {
    // STREAMING: addresses enter provider checks as tiles complete — never
    // waiting for the whole OSM discovery to finish. Idempotent per pass
    // (only run_id IS NULL checks dispatch), finalized at the phase flip.
    for (const job of streamingDiscoveryJobs()) {
      try {
        work += prepareAndDispatchQualification(job, false);
      } catch (error: any) {
        structuredLog("address_discovery.streaming_dispatch_failed", {
          jobId: job.id, error: String(error?.message ?? error).slice(0, 200),
        }, "warn");
      }
    }
    for (const job of jobsReadyForQualification()) {
      beginQualification(job);
      work++;
    }
    for (const job of activeQualificationJobs()) {
      if (!job.qualificationDispatchCompletedAt) {
        work += prepareAndDispatchQualification(job);
        continue;
      }
      // A temporary failure is never final. Resurrect any targets a previous
      // pass finalized as 'failed' (old code / crash mid-retry): requeue them,
      // give the budget back, reopen the run, and kick its worker. They stay
      // pending until Kinetic gives a conclusive answer or the job is cancelled.
      const jobRuns = rawDb
        .prepare(`SELECT run_id AS runId FROM discovery_job_runs WHERE job_id=?`)
        .all(job.id) as Array<{ runId: string }>;
      for (const { runId } of jobRuns) {
        const revived = rawDb
          .prepare(`UPDATE scan_run_targets SET state='queued', next_attempt_at=NULL WHERE run_id=? AND state='failed'`)
          .run(runId).changes;
        if (!revived) continue;
        rawDb
          .prepare(`UPDATE scan_runs SET failed=MAX(0,failed-?), status='running', completed_at=NULL WHERE id=? AND tenant_id=?`)
          .run(revived, runId, job.tenantId);
        void runScanWorker(runId, job.tenantId);
        work += revived;
      }
      const result = reconcileQualificationJob(job);
      for (let n; (n = publishQualificationMapResults(job)) > 0; ) {
        work += n; /* bounded event batches */
      }
      if (result.terminal) {
        work++;
        structuredLog("address_discovery.completed", {
          jobId: job.id,
          tenantId: job.tenantId,
          status: result.status,
        });
      }
    }
    // No qualification-result cache: every discovered address always gets a
    // live provider check. Current truth comes from Kinetic, never a replay.
  } catch (error: any) {
    structuredLog("address_discovery.reconcile_failed", {
      error: String(error?.message ?? error),
    });
  } finally {
    reconciling = false;
    if (work === 0) {
      reconcileIdleStreak = Math.min(reconcileIdleStreak + 1, 30);
      reconcileSkipsLeft = reconcileIdleStreak;
    } else {
      reconcileIdleStreak = 0;
      reconcileSkipsLeft = 0;
    }
  }
}

// A contested SQLite lock (scan firehose + resume storms) makes better-sqlite3
// throw SQLITE_BUSY after busy_timeout expires. That must NEVER escape this
// scheduler: it runs on a microtask, so an uncaught busy error takes the whole
// cluster worker down (exit 1) → respawn → resume storm → more contention.
// Treat busy as "no work right now" — the next wake/processTile completion
// re-runs the scheduler and the claim retried.
function isSqliteBusy(e: any): boolean {
  return e?.code === "SQLITE_BUSY" || String(e?.message ?? "").includes("database is locked");
}

function schedule(): void {
  if (scheduling) return;
  scheduling = true;
  try {
    while (running < maxWorkers) {
      let boundary: ReturnType<typeof claimBoundaryJob>; 
      try { boundary = claimBoundaryJob(workerId); }
      catch (e: any) {
        if (isSqliteBusy(e)) { structuredLog("address_discovery.claim_busy", { kind: "boundary" }); break; }
        throw e;
      }
      if (boundary) {
        running++;
        void processBoundary(boundary).finally(() => {
          running--;
          queueMicrotask(schedule);
        });
        continue;
      }
      let claimed: ReturnType<typeof claimNextTile>; 
      try { claimed = claimNextTile(workerId); }
      catch (e: any) {
        if (isSqliteBusy(e)) { structuredLog("address_discovery.claim_busy", { kind: "tile" }); break; }
        throw e;
      }
      if (!claimed) break;
      running++;
      void processTile(claimed.job, claimed.tile).finally(() => {
        running--;
        queueMicrotask(schedule);
      });
    }
  } finally {
    scheduling = false;
  }
}

export function wakeDiscoveryWorkers(): void {
  // A wake is a signal that state changed — new job, finished tile, resumed
  // run — so the idle backoff resets and the next reconcile tick runs at
  // full 1s cadence again.
  reconcileIdleStreak = 0;
  reconcileSkipsLeft = 0;
  queueMicrotask(schedule);
}

export function resumeDiscoveryJobs(): void {
  // FIRST, terminalize crash-orphaned operator-ELECTED area scans. A stale
  // running elected scan is a zombie, not permission to restart: mark it failed
  // so neither the resume UPDATE below nor the tile scheduler ever re-drives it,
  // and so `?active=true` stops returning it (a root cause of "Scanning fiber"
  // reappearing on launch). Background market/frontier/town harvests are NOT
  // elected and fall through to the normal resume path — they are meant to
  // continue. Only stale-heartbeat jobs are touched, so a live worker's
  // in-flight elected scan in a multi-core cluster is never wrongly killed.
  const staleMinutes = Math.max(1, Number(process.env.DISCOVERY_ELECTED_STALE_MINUTES) || 5);
  try {
    terminalizeOrphanedElectedJobs({ staleMinutes });
  } catch (e: any) {
    structuredLog("address_discovery.orphaned_elected_terminalize_failed", {
      error: String(e?.message ?? e),
    });
  }
  rawDb
    .prepare(
      `UPDATE discovery_jobs SET status='queued',updated_at=datetime('now')
    WHERE phase IN ('boundary','locality') AND status='running' AND (heartbeat_at IS NULL OR heartbeat_at<datetime('now','-5 minutes'))`,
    )
    .run();
  rawDb
    .prepare(
      `UPDATE discovery_tiles SET status='queued',lease_owner=NULL,lease_expires_at=NULL,updated_at=datetime('now')
    WHERE status='running' AND (lease_expires_at IS NULL OR lease_expires_at<datetime('now'))`,
    )
    .run();
  startDiscoveryWorkers();
  reconcile();
}

export function startDiscoveryWorkers(): void {
  if (!scheduler) {
    scheduler = setInterval(
      schedule,
      Math.max(250, Number(process.env.DISCOVERY_SCHEDULER_MS) || 400),
    );
    if (typeof (scheduler as any).unref === "function")
      (scheduler as any).unref();
  }
  if (!reconciler) {
    reconciler = setInterval(
      reconcile,
      Math.max(1_000, Number(process.env.DISCOVERY_RECONCILE_MS) || 1_000),
    );
    if (typeof (reconciler as any).unref === "function")
      (reconciler as any).unref();
  }
  wakeDiscoveryWorkers();
}

