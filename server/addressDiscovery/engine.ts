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
import { projectConfirmedFreshLeads } from "../freshFiberProjector";
import { structuredLog } from "../structuredLog";
import { getKineticEvidenceGateway } from "../kineticProviderAdapter";
import { resolvePointLocality, resolveTownBoundary } from "./boundary";
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
  getQualificationCache,
  jobsReadyForQualification,
  mapDiscoveryRun,
  markBoundaryRetry,
  mergeAddressEvidence,
  planDiscoveryTiles as persistTiles,
  qualificationCandidates,
  markQualificationDispatchComplete,
  publishQualificationMapCandidates,
  publishQualificationMapResults,
  reconcileQualificationJob,
  recordHandoffCollision,
  setJobQualification,
  setResolvedBoundary,
  setResolvedLocality,
  touchTileLease,
  updateSourceHealth,
  updateTileCheckpoint,
  type DiscoveryJobRow,
  type DiscoveryTileRow,
} from "./store";

const workerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;
const maxWorkers = Math.max(
  1,
  Math.min(8, Number(process.env.DISCOVERY_WORKER_CONCURRENCY) || 2),
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

function prepareAndDispatchQualification(job: DiscoveryJobRow): void {
  const candidates = qualificationCandidates(job.id);
  let reused = 0;
  const existingChecks = new Set(
    (
      rawDb
        .prepare(
          `SELECT canonical_address_id AS id FROM qualification_checks WHERE job_id=?`,
        )
        .all(job.id) as any[]
    ).map((row) => Number(row.id)),
  );
  for (const candidate of candidates) {
    if (existingChecks.has(Number(candidate.id))) continue;
    // The authorized Kinetic qualifier and fresh-lead projector currently
    // support NC/SC only. Discovery may still inventory a wider map geometry,
    // but unsupported states never consume a provider request that cannot be
    // published safely.
    if (!["NC", "SC"].includes(String(candidate.state).toUpperCase())) {
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
        `SELECT id,address,city,state,zip,tenant_id AS tenantId FROM scan_targets
      WHERE lower(address)=lower(?) LIMIT 1`,
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
    const cached = getQualificationCache(job.tenantId, candidate.canonicalKey);
    if (
      cached?.conclusive &&
      Number(cached.scanTargetId) === Number(target.id)
    ) {
      createQualificationCheck({
        tenantId: job.tenantId,
        jobId: job.id,
        canonicalAddressId: candidate.id,
        targetId: target.id,
        cacheReused: true,
        state: "cached",
        result: cached.result,
      });
      reused++;
    } else {
      createQualificationCheck({
        tenantId: job.tenantId,
        jobId: job.id,
        canonicalAddressId: candidate.id,
        targetId: target.id,
      });
    }
  }
  if (reused) {
    rawDb
      .prepare(`UPDATE discovery_jobs SET cache_hits=cache_hits+? WHERE id=?`)
      .run(reused, job.id);
    const reusedTargets = rawDb
      .prepare(
        `SELECT scan_target_id AS id FROM qualification_checks WHERE job_id=? AND state='cached'`,
      )
      .all(job.id) as any[];
    projectConfirmedFreshLeads(
      job.tenantId,
      reusedTargets.map((row) => Number(row.id)),
    );
  }
  const evidenceStatus = getKineticEvidenceGateway().status();
  if (!evidenceStatus.supportsLiveQualification || evidenceStatus.circuitOpen) {
    const reason = evidenceStatus.circuitOpen
      ? `Availability verification paused: ${evidenceStatus.circuitReason ?? "evidence-source circuit open"}.`
      : "Addresses found. Availability verification requires an approved live evidence adapter or an authorized evidence import.";
    rawDb
      .prepare(
        `UPDATE qualification_checks SET state='failed',result='verification_required',
      checked_at=datetime('now'),updated_at=datetime('now') WHERE job_id=? AND state='queued'`,
      )
      .run(job.id);
    rawDb
      .prepare(
        `UPDATE discovery_jobs SET error_summary=?,updated_at=datetime('now') WHERE id=?`,
      )
      .run(reason, job.id);
    markQualificationDispatchComplete(job.id);
    while (publishQualificationMapCandidates(job) > 0) {
      /* bounded event batches */
    }
    while (publishQualificationMapResults(job) > 0) {
      /* bounded event batches */
    }
    appendDiscoveryEvent(
      job.tenantId,
      job.id,
      "qualification.verification_required",
      {
        reason,
        evidenceMode: evidenceStatus.mode,
        evidenceSource: evidenceStatus.source,
        candidates: candidates.length,
      },
    );
    reconcileQualificationJob(getDiscoveryJob(job.tenantId, job.id)!);
    return;
  }
  try {
    const queued = rawDb
      .prepare(
        `SELECT canonical_address_id AS canonicalAddressId,scan_target_id AS targetId
      FROM qualification_checks WHERE job_id=? AND state='queued' AND scan_target_id IS NOT NULL
      ORDER BY canonical_address_id`,
      )
      .all(job.id) as Array<{ canonicalAddressId: number; targetId: number }>;
    let sequence = 0;
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
      enqueueRunTargets(
        runId,
        batch.map((row, index) => ({ id: Number(row.targetId), seq: index })),
      );
      mapDiscoveryRun(job.id, runId, sequence++);
      void runScanWorker(runId, job.tenantId);
    }
    markQualificationDispatchComplete(job.id);
    while (publishQualificationMapCandidates(job) > 0) {
      /* bounded event batches */
    }
    appendDiscoveryEvent(job.tenantId, job.id, "qualification.started", {
      observedCandidates: candidates.length,
      queued: queued.length,
      cacheReused: reused,
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
}

function reconcile(): void {
  try {
    for (const job of jobsReadyForQualification()) beginQualification(job);
    for (const job of activeQualificationJobs()) {
      if (!job.qualificationDispatchCompletedAt) {
        prepareAndDispatchQualification(job);
        continue;
      }
      const result = reconcileQualificationJob(job);
      while (publishQualificationMapResults(job) > 0) {
        /* bounded event batches */
      }
      if (result.terminal)
        structuredLog("address_discovery.completed", {
          jobId: job.id,
          tenantId: job.tenantId,
          status: result.status,
        });
    }
    // Persist a short qualification-result cache only after conclusive terminal
    // checks. Failed/unknown results are never cached as a negative.
    const cacheTtlSeconds = Math.max(
      60,
      Number(process.env.QUALIFICATION_CACHE_TTL_SECONDS) || 86_400,
    );
    rawDb
      .prepare(
        `INSERT INTO discovery_qualification_cache
      (tenant_id,canonical_key,scan_target_id,result,conclusive,checked_at,expires_at,evidence_hash)
      SELECT q.tenant_id,c.canonical_key,q.scan_target_id,q.result,1,COALESCE(q.checked_at,datetime('now')),
             datetime(COALESCE(q.checked_at,datetime('now')),?),NULL
      FROM qualification_checks q JOIN canonical_addresses c ON c.id=q.canonical_address_id
      WHERE q.state='verified' AND q.result IS NOT NULL
      ON CONFLICT(tenant_id,canonical_key) DO UPDATE SET scan_target_id=excluded.scan_target_id,result=excluded.result,
        conclusive=excluded.conclusive,checked_at=excluded.checked_at,expires_at=excluded.expires_at`,
      )
      .run(`+${cacheTtlSeconds} seconds`);
  } catch (error: any) {
    structuredLog("address_discovery.reconcile_failed", {
      error: String(error?.message ?? error),
    });
  }
}

function schedule(): void {
  if (scheduling) return;
  scheduling = true;
  try {
    while (running < maxWorkers) {
      const boundary = claimBoundaryJob(workerId);
      if (boundary) {
        running++;
        void processBoundary(boundary).finally(() => {
          running--;
          queueMicrotask(schedule);
        });
        continue;
      }
      const claimed = claimNextTile(workerId);
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
  queueMicrotask(schedule);
}

export function resumeDiscoveryJobs(): void {
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
      Math.max(250, Number(process.env.DISCOVERY_SCHEDULER_MS) || 1_000),
    );
    if (typeof (scheduler as any).unref === "function")
      (scheduler as any).unref();
  }
  if (!reconciler) {
    reconciler = setInterval(
      reconcile,
      Math.max(1_000, Number(process.env.DISCOVERY_RECONCILE_MS) || 2_000),
    );
    if (typeof (reconciler as any).unref === "function")
      (reconciler as any).unref();
  }
  wakeDiscoveryWorkers();
}

export function stopDiscoveryWorkersForTest(): void {
  if (scheduler) clearInterval(scheduler);
  if (reconciler) clearInterval(reconciler);
  scheduler = null;
  reconciler = null;
}
