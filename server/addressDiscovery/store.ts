import crypto from "node:crypto";
import { rawDb } from "../db";
import { structuredLog } from "../structuredLog";
import { projectConfirmedFreshLeads } from "../freshFiberProjector";
import { normalizeAddress } from "@shared/addressDiscovery";
import type {
  DiscoveryBBox,
  DiscoveryGeometry,
  SourceAddressRecord,
} from "./types";
import { parseJson } from "./types";
import { isElectedAreaJob } from "./electedJob";

export type DiscoveryJobStatus =
  "queued" | "running" | "partial" | "completed" | "failed" | "cancelled";

export interface DiscoveryJobRow {
  id: string;
  tenantId: number;
  idempotencyKey: string;
  requestHash?: string;
  requestedAreaJson: string | null;
  areaJson: string | null;
  bboxJson: string | null;
  townName: string | null;
  state: string;
  status: DiscoveryJobStatus;
  phase: string;
  sourceConfigJson: string;
  totalTiles: number;
  completedTiles: number;
  partialTiles: number;
  failedTiles: number;
  addressesObserved: number;
  addressesInferred: number;
  addressesQualified: number;
  qualificationChecked: number;
  qualificationFailed: number;
  qualificationDispatchCompletedAt: string | null;
  freshFound: number;
  noServiceFound: number;
  handoffCollisions: number;
  cacheHits: number;
  cacheMisses: number;
  errorSummary: string | null;
  createdBy: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface DiscoveryTileRow {
  id: string;
  jobId: string;
  tileKey: string;
  sequence: number;
  geometryJson: string;
  bboxJson: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  sourceCheckpointJson: string;
  sourceErrorsJson: string;
  observedCount: number;
  inferredCount: number;
  duplicateCount: number;
  coverageRatio: number | null;
  coverageClass: string;
  error: string | null;
}

const jobSelect = `SELECT id,tenant_id AS tenantId,idempotency_key AS idempotencyKey,
  requested_area_json AS requestedAreaJson,area_json AS areaJson,bbox_json AS bboxJson,town_name AS townName,state,
  status,phase,source_config_json AS sourceConfigJson,total_tiles AS totalTiles,completed_tiles AS completedTiles,
  partial_tiles AS partialTiles,failed_tiles AS failedTiles,addresses_observed AS addressesObserved,
  addresses_inferred AS addressesInferred,addresses_qualified AS addressesQualified,
  qualification_checked AS qualificationChecked,qualification_failed AS qualificationFailed,
  qualification_dispatch_completed_at AS qualificationDispatchCompletedAt,
  fresh_found AS freshFound,no_service_found AS noServiceFound,handoff_collisions AS handoffCollisions,
  cache_hits AS cacheHits,cache_misses AS cacheMisses,error_summary AS errorSummary,created_by AS createdBy,
  created_at AS createdAt,started_at AS startedAt,completed_at AS completedAt,updated_at AS updatedAt
  FROM discovery_jobs`;

const tileSelect = `SELECT id,job_id AS jobId,tile_key AS tileKey,sequence,geometry_json AS geometryJson,
  bbox_json AS bboxJson,status,attempt_count AS attemptCount,max_attempts AS maxAttempts,
  source_checkpoint_json AS sourceCheckpointJson,source_errors_json AS sourceErrorsJson,
  observed_count AS observedCount,inferred_count AS inferredCount,duplicate_count AS duplicateCount,
  coverage_ratio AS coverageRatio,coverage_class AS coverageClass,error FROM discovery_tiles`;

export function createDiscoveryJob(input: {
  tenantId: number;
  idempotencyKey: string;
  requestHash: string;
  geometry?: DiscoveryGeometry | null;
  bbox?: DiscoveryBBox | null;
  townName?: string | null;
  state: string;
  createdBy: number;
  sourceConfig?: Record<string, unknown>;
}): { job: DiscoveryJobRow; replayed: boolean } {
  const existing = rawDb
    .prepare(`${jobSelect} WHERE tenant_id=? AND idempotency_key=?`)
    .get(input.tenantId, input.idempotencyKey) as DiscoveryJobRow | undefined;
  if (existing) {
    if (existing.createdBy !== input.createdBy)
      throw new Error(
        "IDEMPOTENCY_OWNER_MISMATCH: key belongs to another user",
      );
    const storedHash = (
      rawDb
        .prepare(
          `SELECT request_hash AS requestHash FROM discovery_jobs WHERE id=?`,
        )
        .get(existing.id) as any
    )?.requestHash;
    if (storedHash && storedHash !== input.requestHash)
      throw new Error(
        "IDEMPOTENCY_CONFLICT: key was already used for a different request",
      );
    return { job: existing, replayed: true };
  }
  const id = crypto.randomUUID();
  rawDb
    .prepare(
      `INSERT INTO discovery_jobs
      (id,tenant_id,idempotency_key,request_hash,requested_area_json,area_json,bbox_json,town_name,state,status,phase,source_config_json,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      input.tenantId,
      input.idempotencyKey,
      input.requestHash,
      input.geometry ? JSON.stringify(input.geometry) : null,
      input.geometry ? JSON.stringify(input.geometry) : null,
      input.bbox ? JSON.stringify(input.bbox) : null,
      input.townName ?? null,
      input.state.toUpperCase(),
      "queued",
      input.geometry ? "locality" : "boundary",
      JSON.stringify(input.sourceConfig ?? {}),
      input.createdBy,
    );
  const job = getDiscoveryJob(input.tenantId, id)!;
  appendDiscoveryEvent(input.tenantId, id, "job.accepted", {
    status: job.status,
    phase: job.phase,
    idempotencyKey: input.idempotencyKey,
  });
  return { job, replayed: false };
}

export function getDiscoveryJob(
  tenantId: number,
  id: string,
): DiscoveryJobRow | undefined {
  return rawDb
    .prepare(`${jobSelect} WHERE tenant_id=? AND id=?`)
    .get(tenantId, id) as DiscoveryJobRow | undefined;
}

export function listDiscoveryJobs(
  tenantId: number,
  opts: { createdBy?: number; activeOnly?: boolean; limit?: number } = {},
): DiscoveryJobRow[] {
  const where = ["tenant_id=?"];
  const args: unknown[] = [tenantId];
  if (opts.createdBy != null) {
    where.push("created_by=?");
    args.push(opts.createdBy);
  }
  if (opts.activeOnly) where.push("status IN ('queued','running')");
  args.push(Math.max(1, Math.min(200, opts.limit ?? 50)));
  return rawDb
    .prepare(
      `${jobSelect} WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...args) as DiscoveryJobRow[];
}

export function setResolvedBoundary(
  jobId: string,
  geometry: DiscoveryGeometry,
  bbox: DiscoveryBBox,
): void {
  rawDb
    .prepare(
      `UPDATE discovery_jobs SET area_json=?,bbox_json=?,phase='discovery',status='queued',
    error_summary=NULL,updated_at=datetime('now') WHERE id=? AND status NOT IN ('cancelled','completed')`,
    )
    .run(JSON.stringify(geometry), JSON.stringify(bbox), jobId);
}

export function setResolvedLocality(
  jobId: string,
  city: string,
  state: string,
): void {
  rawDb
    .prepare(
      `UPDATE discovery_jobs SET town_name=?,state=?,phase='discovery',status='queued',boundary_next_attempt_at=NULL,
    error_summary=NULL,updated_at=datetime('now') WHERE id=? AND status NOT IN ('cancelled','completed')`,
    )
    .run(city, state.toUpperCase(), jobId);
}

export function planDiscoveryTiles(
  jobId: string,
  tiles: Array<{
    key: string;
    geometry: DiscoveryGeometry;
    bbox: DiscoveryBBox;
  }>,
): number {
  const insert = rawDb.prepare(`INSERT OR IGNORE INTO discovery_tiles
    (id,job_id,tile_key,sequence,geometry_json,bbox_json,status,max_attempts) VALUES (?,?,?,?,?,?,'queued',?)`);
  const maxAttempts = Math.max(
    1,
    Math.min(8, Number(process.env.DISCOVERY_TILE_MAX_ATTEMPTS) || 3),
  );
  const tx = rawDb.transaction(() => {
    tiles.forEach((tile, sequence) =>
      insert.run(
        crypto.randomUUID(),
        jobId,
        tile.key,
        sequence,
        JSON.stringify(tile.geometry),
        JSON.stringify(tile.bbox),
        maxAttempts,
      ),
    );
    rawDb
      .prepare(
        `UPDATE discovery_jobs SET total_tiles=(SELECT COUNT(*) FROM discovery_tiles WHERE job_id=?),
      phase='discovery',status='queued',updated_at=datetime('now') WHERE id=?`,
      )
      .run(jobId, jobId);
  });
  tx();
  return Number(
    (
      rawDb
        .prepare(`SELECT COUNT(*) AS count FROM discovery_tiles WHERE job_id=?`)
        .get(jobId) as any
    ).count,
  );
}

export function claimBoundaryJob(
  workerId: string,
): DiscoveryJobRow | undefined {
  const tx = rawDb.transaction(() => {
    const row = rawDb
      .prepare(
        `${jobSelect} WHERE status='queued' AND phase IN ('boundary','locality')
      AND (boundary_next_attempt_at IS NULL OR julianday(boundary_next_attempt_at)<=julianday('now'))
      ORDER BY COALESCE(last_scheduled_at,'1970-01-01'),created_at LIMIT 1`,
      )
      .get() as DiscoveryJobRow | undefined;
    if (!row) return undefined;
    const changed = rawDb
      .prepare(
        `UPDATE discovery_jobs SET status='running',started_at=COALESCE(started_at,datetime('now')),
      heartbeat_at=datetime('now'),last_scheduled_at=datetime('now'),updated_at=datetime('now')
      WHERE id=? AND status='queued' AND phase IN ('boundary','locality')`,
      )
      .run(row.id).changes;
    if (!changed) return undefined;
    appendDiscoveryEvent(row.tenantId, row.id, "boundary.started", {
      workerId,
    });
    return getDiscoveryJob(row.tenantId, row.id);
  });
  return tx();
}

export function markBoundaryRetry(job: DiscoveryJobRow, error: string): void {
  const config = parseJson<Record<string, any>>(job.sourceConfigJson, {});
  const attempts = Number(config.boundaryAttempts ?? 0) + 1;
  config.boundaryAttempts = attempts;
  const terminal =
    attempts >= Math.max(1, Number(process.env.BOUNDARY_MAX_ATTEMPTS) || 3);
  const backoffSeconds = Math.min(
    900,
    Math.round(
      2 ** Math.max(0, attempts - 1) * 15 * (0.8 + Math.random() * 0.4),
    ),
  );
  rawDb
    .prepare(
      `UPDATE discovery_jobs SET status=?,phase=?,source_config_json=?,error_summary=?,boundary_next_attempt_at=?,
    heartbeat_at=datetime('now'),completed_at=CASE WHEN ? THEN datetime('now') ELSE completed_at END,updated_at=datetime('now') WHERE id=?`,
    )
    .run(
      terminal ? "failed" : "queued",
      job.phase,
      JSON.stringify(config),
      error.slice(0, 500),
      terminal
        ? null
        : new Date(Date.now() + backoffSeconds * 1000).toISOString(),
      terminal ? 1 : 0,
      job.id,
    );
  appendDiscoveryEvent(
    job.tenantId,
    job.id,
    terminal ? "boundary.failed" : "boundary.retry_scheduled",
    { attempts, backoffSeconds, error: error.slice(0, 300) },
  );
}

export function claimNextTile(
  workerId: string,
  leaseSeconds = 120,
): { job: DiscoveryJobRow; tile: DiscoveryTileRow } | undefined {
  const tx = rawDb.transaction(() => {
    rawDb
      .prepare(
        `UPDATE discovery_tiles SET status='queued',lease_owner=NULL,lease_expires_at=NULL,
      error='Recovered expired worker lease',updated_at=datetime('now')
      WHERE status='running' AND lease_expires_at < datetime('now')`,
      )
      .run();
    const row = rawDb
      .prepare(
        `SELECT t.id,t.job_id AS jobId,t.tile_key AS tileKey,t.sequence,t.geometry_json AS geometryJson,
      t.bbox_json AS bboxJson,t.status,t.attempt_count AS attemptCount,t.max_attempts AS maxAttempts,
      t.source_checkpoint_json AS sourceCheckpointJson,t.source_errors_json AS sourceErrorsJson,
      t.observed_count AS observedCount,t.inferred_count AS inferredCount,t.duplicate_count AS duplicateCount,
      t.coverage_ratio AS coverageRatio,t.coverage_class AS coverageClass,t.error
      FROM discovery_tiles t JOIN discovery_jobs j ON j.id=t.job_id
      WHERE t.status='queued' AND j.status IN ('queued','running') AND j.phase='discovery'
        AND (t.next_attempt_at IS NULL OR julianday(t.next_attempt_at) <= julianday('now'))
      ORDER BY COALESCE(j.last_scheduled_at,'1970-01-01'),j.created_at,t.sequence LIMIT 1`,
      )
      .get() as DiscoveryTileRow | undefined;
    if (!row) return undefined;
    const changed = rawDb
      .prepare(
        `UPDATE discovery_tiles SET status='running',attempt_count=attempt_count+1,
      lease_owner=?,lease_expires_at=datetime('now',?),started_at=COALESCE(started_at,datetime('now')),updated_at=datetime('now')
      WHERE id=? AND status='queued'`,
      )
      .run(workerId, `+${leaseSeconds} seconds`, row.id).changes;
    if (!changed) return undefined;
    rawDb
      .prepare(
        `UPDATE discovery_jobs SET status='running',started_at=COALESCE(started_at,datetime('now')),
      heartbeat_at=datetime('now'),last_scheduled_at=datetime('now'),updated_at=datetime('now') WHERE id=?`,
      )
      .run(row.jobId);
    const job = rawDb
      .prepare(`${jobSelect} WHERE id=?`)
      .get(row.jobId) as DiscoveryJobRow;
    const tile = rawDb
      .prepare(`${tileSelect} WHERE id=?`)
      .get(row.id) as DiscoveryTileRow;
    appendDiscoveryEvent(job.tenantId, job.id, "tile.started", {
      tileId: tile.id,
      tileKey: tile.tileKey,
      attempt: tile.attemptCount,
    });
    return { job, tile };
  });
  return tx();
}

export function updateTileCheckpoint(
  tileId: string,
  sourceId: string,
  checkpoint: Record<string, unknown>,
  error?: string | null,
): void {
  const row = rawDb
    .prepare(
      `SELECT source_checkpoint_json AS checkpointJson,source_errors_json AS errorsJson FROM discovery_tiles WHERE id=?`,
    )
    .get(tileId) as any;
  if (!row) return;
  const checks = parseJson<Record<string, unknown>>(row.checkpointJson, {});
  const errors = parseJson<Record<string, unknown>>(row.errorsJson, {});
  checks[sourceId] = checkpoint;
  if (error) errors[sourceId] = error.slice(0, 300);
  else delete errors[sourceId];
  rawDb
    .prepare(
      `UPDATE discovery_tiles SET source_checkpoint_json=?,source_errors_json=?,lease_expires_at=datetime('now','+120 seconds'),updated_at=datetime('now') WHERE id=?`,
    )
    .run(JSON.stringify(checks), JSON.stringify(errors), tileId);
}

function canonicalText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/\b(apartment|apt|unit|suite|ste)\b/g, " # ")
    .replace(/[.,]/g, " ")
    .replace(/\s*#\s*/g, " #")
    .replace(/\b(street|str)\b/g, "st")
    .replace(/\b(road)\b/g, "rd")
    .replace(/\b(avenue)\b/g, "ave")
    .replace(/\b(boulevard)\b/g, "blvd")
    .replace(/\b(drive)\b/g, "dr")
    .replace(/\b(lane)\b/g, "ln")
    .replace(/\b(court)\b/g, "ct")
    .replace(/\b(parkway)\b/g, "pkwy")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRecord(
  record: SourceAddressRecord,
  defaults: { city: string | null; state: string },
): {
  canonicalKey: string;
  fullAddress: string;
  houseNumber: string | null;
  street: string | null;
  unit: string | null;
  city: string;
  state: string;
  postalCode: string | null;
  inferred: boolean;
  providerVariants: string[];
} | null {
  const quality = (
    {
      rooftop: "ROOFTOP",
      entrance: "ENTRANCE",
      parcel: "PARCEL",
      building_centroid: "CENTROID",
      interpolated: "INTERPOLATED",
      unknown: "UNKNOWN",
    } as const
  )[record.coordinateQuality ?? "unknown"];
  const candidate = normalizeAddress({
    source: "discovery",
    sourceId: record.sourceRecordId,
    rawAddress: record.fullAddress,
    houseNumber: record.houseNumber ?? undefined,
    street: record.street ?? undefined,
    unit: record.unit ?? undefined,
    city: record.city ?? defaults.city ?? undefined,
    state: record.state ?? defaults.state,
    postalCode: record.postalCode ?? undefined,
    country: "US",
    lat: record.lat ?? undefined,
    lng: record.lng ?? undefined,
    coordinateQuality: quality,
    observationType: record.inferred ? "INTERPOLATED" : "OBSERVED",
    confidence: record.confidence,
    validationRequired: record.inferred,
  });
  if (
    !candidate.rawAddress ||
    !candidate.normalizedHouseNumber ||
    !candidate.normalizedStreet ||
    !candidate.normalizedCity ||
    !/^[A-Z]{2}$/.test(candidate.normalizedState)
  )
    return null;
  return {
    canonicalKey: candidate.canonicalKey,
    fullAddress: record.fullAddress
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim(),
    houseNumber: candidate.normalizedHouseNumber || null,
    street: candidate.normalizedStreet || null,
    unit: candidate.normalizedUnit || null,
    city: candidate.normalizedCity,
    state: candidate.normalizedState,
    postalCode: candidate.normalizedPostalCode || null,
    inferred:
      record.inferred === true ||
      candidate.validationRequired ||
      candidate.observationType !== "OBSERVED",
    providerVariants: candidate.providerVariants,
  };
}

const coordinateRanks: Record<string, number> = {
  rooftop: 6,
  entrance: 5,
  parcel: 4,
  building_centroid: 3,
  unknown: 2,
  interpolated: 1,
};

function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad,
    dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 12_742_017.6 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function mergeAddressEvidence(input: {
  tenantId: number;
  jobId: string;
  tileId: string;
  sourceId: string;
  authoritative: boolean;
  evidenceOnly: boolean;
  licenseName: string | null;
  licenseUrl: string | null;
  city: string | null;
  state: string;
  record: SourceAddressRecord;
}): {
  canonicalAddressId: number | null;
  created: boolean;
  duplicate: boolean;
  inferred: boolean;
  rejected?: string;
} {
  if (input.evidenceOnly) {
    const content = JSON.stringify(input.record.raw ?? input.record);
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const info = rawDb
      .prepare(
        `INSERT OR IGNORE INTO coverage_evidence
      (id,tenant_id,job_id,tile_id,source_id,source_record_id,evidence_kind,lat,lng,confidence,license_name,license_url,raw_json,content_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        crypto.randomUUID(),
        input.tenantId,
        input.jobId,
        input.tileId,
        input.sourceId,
        input.record.sourceRecordId,
        input.record.evidenceKind ?? "coverage",
        input.record.lat ?? null,
        input.record.lng ?? null,
        Math.max(0, Math.min(1, input.record.confidence ?? 0.5)),
        input.record.licenseName ?? input.licenseName,
        input.record.licenseUrl ?? input.licenseUrl,
        content,
        hash,
      );
    return {
      canonicalAddressId: null,
      created: info.changes === 1,
      duplicate: info.changes === 0,
      inferred: Boolean(input.record.inferred),
      rejected: "evidence_only",
    };
  }
  const normalized = normalizeRecord(input.record, input);
  if (!normalized)
    return {
      canonicalAddressId: null,
      created: false,
      duplicate: false,
      inferred: Boolean(input.record.inferred),
      rejected: "invalid_address",
    };
  if (input.state !== "US" && normalized.state !== input.state.toUpperCase()) {
    return {
      canonicalAddressId: null,
      created: false,
      duplicate: false,
      inferred: normalized.inferred,
      rejected: "state_mismatch",
    };
  }
  if (
    input.record.lat != null &&
    input.record.lng != null &&
    (!Number.isFinite(input.record.lat) ||
      !Number.isFinite(input.record.lng) ||
      input.record.lat < -90 ||
      input.record.lat > 90 ||
      input.record.lng < -180 ||
      input.record.lng > 180)
  ) {
    return {
      canonicalAddressId: null,
      created: false,
      duplicate: false,
      inferred: Boolean(input.record.inferred),
      rejected: "invalid_coordinate",
    };
  }
  const now =
    input.record.observedAt &&
    Number.isFinite(Date.parse(input.record.observedAt))
      ? input.record.observedAt
      : new Date().toISOString();
  const content = JSON.stringify(input.record.raw ?? input.record);
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");
  const evidenceId = crypto
    .createHash("sha256")
    .update(
      `${input.tenantId}|${input.sourceId}|${input.record.sourceRecordId}|${contentHash}`,
    )
    .digest("hex");
  const authoritative = input.record.authoritative ?? input.authoritative;
  const result = rawDb.transaction(() => {
    let before = rawDb
      .prepare(
        `SELECT id,canonical_key AS canonicalKey,coordinate_quality AS coordinateQuality,inferred_only AS inferredOnly FROM canonical_addresses
      WHERE tenant_id=? AND canonical_key=?`,
      )
      .get(input.tenantId, normalized.canonicalKey) as any;
    // Conservative spatial stage: geocoders often jitter the same rooftop and
    // ZIP-less canonical keys include coordinates. Match only identical parsed
    // house/street/unit + city/state, compatible ZIP, and <=30 m. Units are an
    // exact boundary and are never spatially collapsed.
    if (!before && input.record.lat != null && input.record.lng != null) {
      const nearby = rawDb
        .prepare(
          `SELECT id,canonical_key AS canonicalKey,coordinate_quality AS coordinateQuality,
          inferred_only AS inferredOnly,lat,lng FROM canonical_addresses
        WHERE tenant_id=? AND house_number=? AND street=? AND COALESCE(unit,'')=COALESCE(?,'')
          AND city=? AND state=? AND (postal_code IS NULL OR ? IS NULL OR substr(postal_code,1,5)=substr(?,1,5))
          AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
        )
        .all(
          input.tenantId,
          normalized.houseNumber,
          normalized.street,
          normalized.unit,
          normalized.city,
          normalized.state,
          normalized.postalCode,
          normalized.postalCode,
          input.record.lat - 0.0004,
          input.record.lat + 0.0004,
          input.record.lng - 0.0005,
          input.record.lng + 0.0005,
        ) as any[];
      before = nearby.find(
        (row) =>
          distanceMeters(
            input.record.lat!,
            input.record.lng!,
            Number(row.lat),
            Number(row.lng),
          ) <= 30,
      );
    }
    const canonicalKey = before?.canonicalKey ?? normalized.canonicalKey;
    rawDb
      .prepare(
        `INSERT INTO canonical_addresses
        (tenant_id,canonical_key,full_address,house_number,street,unit,city,state,postal_code,lat,lng,coordinate_quality,
         validation_status,confidence,inferred_only,authoritative_sources,independent_sources,first_observed_at,last_observed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(tenant_id,canonical_key) DO UPDATE SET
          full_address=CASE WHEN length(excluded.full_address)>length(canonical_addresses.full_address) THEN excluded.full_address ELSE canonical_addresses.full_address END,
          house_number=COALESCE(canonical_addresses.house_number,excluded.house_number),street=COALESCE(canonical_addresses.street,excluded.street),
          unit=COALESCE(canonical_addresses.unit,excluded.unit),postal_code=COALESCE(canonical_addresses.postal_code,excluded.postal_code),
          last_observed_at=excluded.last_observed_at,confidence=MAX(canonical_addresses.confidence,excluded.confidence),updated_at=datetime('now')`,
      )
      .run(
        input.tenantId,
        canonicalKey,
        normalized.fullAddress,
        normalized.houseNumber,
        normalized.street,
        normalized.unit,
        normalized.city,
        normalized.state,
        normalized.postalCode,
        input.record.lat ?? null,
        input.record.lng ?? null,
        input.record.coordinateQuality ?? "unknown",
        normalized.inferred ? "inferred_pending" : "observed",
        Math.max(0, Math.min(1, input.record.confidence ?? 0.5)),
        normalized.inferred ? 1 : 0,
        authoritative ? 1 : 0,
        1,
        now,
        now,
      );
    const canonical = rawDb
      .prepare(
        `SELECT id,coordinate_quality AS coordinateQuality FROM canonical_addresses WHERE tenant_id=? AND canonical_key=?`,
      )
      .get(input.tenantId, canonicalKey) as any;
    const evidenceInserted = rawDb
      .prepare(
        `INSERT OR IGNORE INTO address_evidence
        (id,tenant_id,canonical_address_id,source_id,source_record_id,evidence_kind,authoritative,observed,inferred,
         confidence,license_name,license_url,raw_json,content_hash,observed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        evidenceId,
        input.tenantId,
        canonical.id,
        input.sourceId,
        input.record.sourceRecordId,
        input.record.evidenceKind ?? "address_point",
        authoritative ? 1 : 0,
        normalized.inferred ? 0 : 1,
        normalized.inferred ? 1 : 0,
        Math.max(0, Math.min(1, input.record.confidence ?? 0.5)),
        input.record.licenseName ?? input.licenseName,
        input.record.licenseUrl ?? input.licenseUrl,
        content,
        contentHash,
        now,
      ).changes;
    rawDb
      .prepare(
        `INSERT OR IGNORE INTO address_aliases (tenant_id,canonical_address_id,alias_key,alias_text,source_id)
      VALUES (?,?,?,?,?)`,
      )
      .run(
        input.tenantId,
        canonical.id,
        canonicalText(normalized.fullAddress),
        normalized.fullAddress,
        input.sourceId,
      );
    for (const variant of normalized.providerVariants) {
      rawDb
        .prepare(
          `INSERT OR IGNORE INTO address_aliases (tenant_id,canonical_address_id,alias_key,alias_text,source_id)
        VALUES (?,?,?,?,?)`,
        )
        .run(
          input.tenantId,
          canonical.id,
          canonicalText(variant),
          variant,
          "provider_variant",
        );
    }
    if (normalized.unit)
      rawDb
        .prepare(
          `INSERT OR IGNORE INTO address_units
      (tenant_id,canonical_address_id,unit_key,unit_label,source_id,observed_at) VALUES (?,?,?,?,?,?)`,
        )
        .run(
          input.tenantId,
          canonical.id,
          canonicalText(normalized.unit),
          normalized.unit,
          input.sourceId,
          now,
        );
    if (input.record.lat != null && input.record.lng != null) {
      rawDb
        .prepare(
          `INSERT OR IGNORE INTO address_coordinates
        (id,tenant_id,canonical_address_id,source_id,lat,lng,quality,confidence,observed_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          crypto.randomUUID(),
          input.tenantId,
          canonical.id,
          input.sourceId,
          input.record.lat,
          input.record.lng,
          input.record.coordinateQuality ?? "unknown",
          Math.max(0, Math.min(1, input.record.confidence ?? 0.5)),
          now,
        );
      if (
        (coordinateRanks[input.record.coordinateQuality ?? "unknown"] ?? 0) >
        (coordinateRanks[canonical.coordinateQuality] ?? 0)
      ) {
        rawDb
          .prepare(
            `UPDATE canonical_addresses SET lat=?,lng=?,coordinate_quality=?,updated_at=datetime('now') WHERE id=?`,
          )
          .run(
            input.record.lat,
            input.record.lng,
            input.record.coordinateQuality ?? "unknown",
            canonical.id,
          );
      }
    }
    rawDb
      .prepare(
        `INSERT OR IGNORE INTO discovery_job_addresses(job_id,canonical_address_id,first_tile_id) VALUES (?,?,?)`,
      )
      .run(input.jobId, canonical.id, input.tileId);
    const evidenceStats = rawDb
      .prepare(
        `SELECT COUNT(DISTINCT source_id) AS sources,
      COUNT(DISTINCT CASE WHEN authoritative=1 THEN source_id END) AS authoritative,
      SUM(CASE WHEN observed=1 THEN 1 ELSE 0 END) AS observed FROM address_evidence WHERE canonical_address_id=?`,
      )
      .get(canonical.id) as any;
    const observed = Number(evidenceStats.observed) > 0;
    rawDb
      .prepare(
        `UPDATE canonical_addresses SET independent_sources=?,authoritative_sources=?,
      inferred_only=?,validation_status=?,updated_at=datetime('now') WHERE id=?`,
      )
      .run(
        Number(evidenceStats.sources),
        Number(evidenceStats.authoritative),
        observed ? 0 : 1,
        observed
          ? Number(evidenceStats.sources) > 1 ||
            Number(evidenceStats.authoritative) > 0
            ? "validated"
            : "observed"
          : "inferred_pending",
        canonical.id,
      );
    return {
      canonicalAddressId: Number(canonical.id),
      created: !before,
      duplicate: evidenceInserted === 0,
      inferred: normalized.inferred,
    };
  })();
  return result;
}

export function completeTile(input: {
  tenantId: number;
  jobId: string;
  tileId: string;
  observed: number;
  inferred: number;
  duplicates: number;
  partial: boolean;
  errors: Record<string, string>;
  cacheHits: number;
  cacheMisses: number;
  authoritativeCount: number;
  unionCount: number;
  primaryCount: number;
  buildingEvidenceCount?: number;
}): void {
  const tile = rawDb
    .prepare(`${tileSelect} WHERE id=? AND job_id=?`)
    .get(input.tileId, input.jobId) as DiscoveryTileRow | undefined;
  if (!tile) return;
  const hasErrors = Object.keys(input.errors).length > 0;
  const retry = hasErrors && tile.attemptCount < tile.maxAttempts;
  const terminalStatus = retry
    ? "queued"
    : hasErrors || input.partial
      ? "partial"
      : "completed";
  const benchmark = Math.max(
    input.authoritativeCount,
    input.buildingEvidenceCount ?? 0,
  );
  const ratio =
    benchmark > 0
      ? Math.max(0, Math.min(1, input.unionCount / benchmark))
      : null;
  const coverageClass =
    benchmark === 0
      ? input.unionCount === 0 && hasErrors
        ? "source_unavailable"
        : "verification_required"
      : ratio! >= 0.9
        ? "high_coverage"
        : ratio! >= 0.55
          ? "partial_coverage"
          : "sparse_source_data";
  const backoff = Math.min(300, 2 ** Math.max(0, tile.attemptCount - 1) * 5);
  rawDb
    .prepare(
      `UPDATE discovery_tiles SET status=?,next_attempt_at=?,lease_owner=NULL,lease_expires_at=NULL,
    observed_count=?,inferred_count=?,duplicate_count=?,coverage_ratio=?,coverage_class=?,error=?,
    completed_at=CASE WHEN ? IN ('completed','partial') THEN datetime('now') ELSE completed_at END,updated_at=datetime('now') WHERE id=?`,
    )
    .run(
      terminalStatus,
      retry ? new Date(Date.now() + backoff * 1000).toISOString() : null,
      input.observed,
      input.inferred,
      input.duplicates,
      ratio,
      coverageClass,
      hasErrors ? Object.values(input.errors).join("; ").slice(0, 500) : null,
      terminalStatus,
      input.tileId,
    );
  rawDb
    .prepare(
      `UPDATE discovery_jobs SET cache_hits=cache_hits+?,cache_misses=cache_misses+?,heartbeat_at=datetime('now'),updated_at=datetime('now') WHERE id=?`,
    )
    .run(input.cacheHits, input.cacheMisses, input.jobId);
  recomputeDiscoveryProgress(input.jobId);
  appendDiscoveryEvent(
    input.tenantId,
    input.jobId,
    retry ? "tile.retry_scheduled" : "tile.completed",
    {
      tileId: input.tileId,
      status: terminalStatus,
      observed: input.observed,
      inferred: input.inferred,
      duplicates: input.duplicates,
      coverageRatio: ratio,
      coverageClass,
      errors: input.errors,
    },
  );
}

export function failTile(
  tenantId: number,
  jobId: string,
  tileId: string,
  error: string,
): void {
  const tile = rawDb.prepare(`${tileSelect} WHERE id=?`).get(tileId) as
    DiscoveryTileRow | undefined;
  if (!tile) return;
  const retry = tile.attemptCount < tile.maxAttempts;
  const backoff = Math.min(300, 2 ** Math.max(0, tile.attemptCount - 1) * 5);
  rawDb
    .prepare(
      `UPDATE discovery_tiles SET status=?,next_attempt_at=?,lease_owner=NULL,lease_expires_at=NULL,error=?,
    completed_at=CASE WHEN ? THEN completed_at ELSE datetime('now') END,updated_at=datetime('now') WHERE id=?`,
    )
    .run(
      retry ? "queued" : "failed",
      retry ? new Date(Date.now() + backoff * 1000).toISOString() : null,
      error.slice(0, 500),
      retry ? 1 : 0,
      tileId,
    );
  recomputeDiscoveryProgress(jobId);
  appendDiscoveryEvent(
    tenantId,
    jobId,
    retry ? "tile.retry_scheduled" : "tile.dead_lettered",
    { tileId, error: error.slice(0, 300) },
  );
}

export function recomputeDiscoveryProgress(jobId: string): void {
  const counts = rawDb
    .prepare(
      `SELECT COUNT(*) AS total,
    SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN status='partial' THEN 1 ELSE 0 END) AS partial,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
    SUM(observed_count) AS observed,SUM(inferred_count) AS inferred FROM discovery_tiles WHERE job_id=?`,
    )
    .get(jobId) as any;
  const distinct = rawDb
    .prepare(
      `SELECT
    SUM(CASE WHEN c.inferred_only=0 THEN 1 ELSE 0 END) AS observed,
    SUM(CASE WHEN c.inferred_only=1 THEN 1 ELSE 0 END) AS inferred
    FROM discovery_job_addresses d JOIN canonical_addresses c ON c.id=d.canonical_address_id WHERE d.job_id=?`,
    )
    .get(jobId) as any;
  rawDb
    .prepare(
      `UPDATE discovery_jobs SET total_tiles=?,completed_tiles=?,partial_tiles=?,failed_tiles=?,
    addresses_observed=?,addresses_inferred=?,updated_at=datetime('now') WHERE id=?`,
    )
    .run(
      Number(counts.total || 0),
      Number(counts.completed || 0),
      Number(counts.partial || 0),
      Number(counts.failed || 0),
      Number(distinct.observed || 0),
      Number(distinct.inferred || 0),
      jobId,
    );
}

export function discoveryReadyForQualification(jobId: string): boolean {
  const row = rawDb
    .prepare(
      `SELECT status,phase,total_tiles,completed_tiles,partial_tiles,failed_tiles FROM discovery_jobs WHERE id=?`,
    )
    .get(jobId) as any;
  return (
    row &&
    row.status !== "cancelled" &&
    row.phase === "discovery" &&
    row.total_tiles > 0 &&
    row.total_tiles ===
      row.completed_tiles + row.partial_tiles + row.failed_tiles
  );
}

export function jobsReadyForQualification(limit = 10): DiscoveryJobRow[] {
  return rawDb
    .prepare(
      `${jobSelect} WHERE status IN ('queued','running') AND phase='discovery' AND total_tiles>0
    AND total_tiles=completed_tiles+partial_tiles+failed_tiles ORDER BY created_at LIMIT ?`,
    )
    .all(limit) as DiscoveryJobRow[];
}

/** Discovery-phase jobs with tiles already completed — candidates for a
 *  STREAMING qualification pass while remaining tiles are still enumerating. */
export function streamingDiscoveryJobs(limit = 10): DiscoveryJobRow[] {
  return rawDb
    .prepare(
      `${jobSelect} WHERE status IN ('queued','running') AND phase='discovery'
    AND completed_tiles+partial_tiles > 0
    AND total_tiles > completed_tiles+partial_tiles+failed_tiles ORDER BY created_at LIMIT ?`,
    )
    .all(limit) as DiscoveryJobRow[];
}

export function setJobQualification(jobId: string): boolean {
  return (
    rawDb
      .prepare(
        `UPDATE discovery_jobs SET phase='qualification',status='running',heartbeat_at=datetime('now'),updated_at=datetime('now')
    WHERE id=? AND phase='discovery' AND status IN ('queued','running')`,
      )
      .run(jobId).changes === 1
  );
}

export function touchTileLease(tileId: string, leaseSeconds = 180): void {
  rawDb
    .prepare(
      `UPDATE discovery_tiles SET lease_expires_at=datetime('now',?),updated_at=datetime('now') WHERE id=? AND status='running'`,
    )
    .run(`+${Math.max(30, leaseSeconds)} seconds`, tileId);
}

export function qualificationCandidates(jobId: string): any[] {
  return rawDb
    .prepare(
      `SELECT c.id,c.canonical_key AS canonicalKey,c.full_address AS fullAddress,c.house_number AS houseNumber,
    c.street,c.unit,c.city,c.state,c.postal_code AS postalCode,c.lat,c.lng,c.inferred_only AS inferredOnly,
    c.validation_status AS validationStatus,c.independent_sources AS independentSources,c.authoritative_sources AS authoritativeSources
    FROM discovery_job_addresses d JOIN canonical_addresses c ON c.id=d.canonical_address_id
    WHERE d.job_id=? AND c.inferred_only=0 AND c.validation_status IN ('observed','validated')`,
    )
    .all(jobId) as any[];
}

export function attachScanTarget(
  jobId: string,
  canonicalAddressId: number,
  targetId: number,
): void {
  rawDb
    .prepare(
      `UPDATE discovery_job_addresses SET scan_target_id=? WHERE job_id=? AND canonical_address_id=?`,
    )
    .run(targetId, jobId, canonicalAddressId);
}

export function recordHandoffCollision(
  tenantId: number,
  jobId: string,
  address: any,
  existing: any,
): void {
  rawDb
    .prepare(
      `UPDATE discovery_jobs SET handoff_collisions=handoff_collisions+1,error_summary='One or more legacy scan-target address collisions require review',updated_at=datetime('now') WHERE id=?`,
    )
    .run(jobId);
  appendDiscoveryEvent(tenantId, jobId, "qualification.handoff_collision", {
    canonicalAddressId: address.id,
    canonicalKey: address.canonicalKey,
    requested: {
      address: address.fullAddress,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
    },
    existing: existing
      ? {
          id: existing.id,
          city: existing.city,
          state: existing.state,
          zip: existing.zip,
        }
      : null,
  });
}

export function createQualificationCheck(input: {
  tenantId: number;
  jobId: string;
  canonicalAddressId: number;
  targetId?: number | null;
  runId?: string | null;
  cacheReused?: boolean;
  state?: string;
  result?: string | null;
}): void {
  rawDb
    .prepare(
      `INSERT INTO qualification_checks
    (id,tenant_id,job_id,canonical_address_id,scan_target_id,run_id,state,result,cache_reused,checked_at)
    VALUES (?,?,?,?,?,?,?,?,?,CASE WHEN ? IN ('verified','failed','cached') THEN datetime('now') ELSE NULL END)
    ON CONFLICT(job_id,canonical_address_id) DO UPDATE SET scan_target_id=excluded.scan_target_id,
      run_id=COALESCE(excluded.run_id,qualification_checks.run_id),state=excluded.state,result=excluded.result,
      cache_reused=excluded.cache_reused,checked_at=excluded.checked_at,updated_at=datetime('now')`,
    )
    .run(
      crypto.randomUUID(),
      input.tenantId,
      input.jobId,
      input.canonicalAddressId,
      input.targetId ?? null,
      input.runId ?? null,
      input.state ?? "queued",
      input.result ?? null,
      input.cacheReused ? 1 : 0,
      input.state ?? "queued",
    );
}

export function markQualificationDispatchComplete(jobId: string): void {
  rawDb
    .prepare(
      `UPDATE discovery_jobs SET qualification_dispatch_completed_at=datetime('now'),heartbeat_at=datetime('now'),updated_at=datetime('now') WHERE id=?`,
    )
    .run(jobId);
}

const MAP_EVENT_BATCH_SIZE = 200;

/** Mark qualification candidates as processed without sending rooftop inventory
 * to field clients. Only `lead.published` is rep-visible; candidate locations and
 * provider outcomes remain in the authenticated admin data model. */
export function publishQualificationMapCandidates(
  job: DiscoveryJobRow,
): number {
  const rows = rawDb
    .prepare(
      `SELECT q.id AS checkId
    FROM qualification_checks q JOIN canonical_addresses c ON c.id=q.canonical_address_id
    WHERE q.job_id=? AND q.map_announced_at IS NULL AND c.lat IS NOT NULL AND c.lng IS NOT NULL
    ORDER BY q.canonical_address_id LIMIT ?`,
    )
    .all(job.id, MAP_EVENT_BATCH_SIZE) as any[];
  if (!rows.length) return 0;
  const placeholders = rows.map(() => "?").join(",");
  rawDb
    .prepare(
      `UPDATE qualification_checks SET map_announced_at=datetime('now') WHERE id IN (${placeholders})`,
    )
    .run(...rows.map((row) => row.checkId));
  return rows.length;
}

/** Mark resolved checks as reported without streaming positive candidates,
 * negatives or diagnostics to reps. The cross-verified `lead.published` event
 * below is the sole field-map publication path. */
export function publishQualificationMapResults(job: DiscoveryJobRow): number {
  const rows = rawDb
    .prepare(
      `SELECT q.id AS checkId
    FROM qualification_checks q
    JOIN canonical_addresses c ON c.id=q.canonical_address_id
    WHERE q.job_id=? AND q.map_result_reported_at IS NULL
      AND q.state IN ('verified','cached','failed','collision','skipped')
      AND c.lat IS NOT NULL AND c.lng IS NOT NULL
    ORDER BY q.canonical_address_id LIMIT ?`,
    )
    .all(job.id, MAP_EVENT_BATCH_SIZE) as any[];
  if (!rows.length) return 0;
  const placeholders = rows.map(() => "?").join(",");
  rawDb
    .prepare(
      `UPDATE qualification_checks SET map_result_reported_at=datetime('now') WHERE id IN (${placeholders})`,
    )
    .run(...rows.map((row) => row.checkId));
  return rows.length;
}

export function mapDiscoveryRun(
  jobId: string,
  runId: string,
  sequence: number,
): void {
  rawDb
    .prepare(
      `INSERT OR IGNORE INTO discovery_job_runs(job_id,run_id,sequence) VALUES (?,?,?)`,
    )
    .run(jobId, runId, sequence);
  rawDb
    .prepare(
      `UPDATE qualification_checks SET run_id=? WHERE job_id=? AND run_id IS NULL AND scan_target_id IN
    (SELECT target_id FROM scan_run_targets WHERE run_id=?)`,
    )
    .run(runId, jobId, runId);
}

export function reconcileQualificationJob(job: DiscoveryJobRow): {
  terminal: boolean;
  status: string;
} {
  const runCounts = rawDb
    .prepare(
      `SELECT COUNT(*) AS total,
    SUM(CASE WHEN r.status IN ('done','error','cancelled') THEN 1 ELSE 0 END) AS terminal,
    SUM(r.verified) AS verified,SUM(r.failed) AS failed,SUM(r.new_fiber) AS fresh
    FROM discovery_job_runs d JOIN scan_runs r ON r.id=d.run_id WHERE d.job_id=?`,
    )
    .get(job.id) as any;
  rawDb
    .prepare(
      `UPDATE qualification_checks SET
    state=COALESCE((SELECT s.state FROM scan_run_targets s WHERE s.run_id=qualification_checks.run_id AND s.target_id=qualification_checks.scan_target_id),state),
    result=COALESCE((SELECT s.result FROM scan_run_targets s WHERE s.run_id=qualification_checks.run_id AND s.target_id=qualification_checks.scan_target_id),result),
    checked_at=CASE WHEN state IN ('verified','failed','cached') THEN COALESCE(checked_at,datetime('now')) ELSE checked_at END,
    updated_at=datetime('now') WHERE job_id=?`,
    )
    .run(job.id);
  const checkCounts = rawDb
    .prepare(
      `SELECT COUNT(*) AS total,
    SUM(CASE WHEN state IN ('verified','cached') THEN 1 ELSE 0 END) AS checked,
    SUM(CASE WHEN state IN ('failed','collision') THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN state NOT IN ('verified','cached','collision','skipped') THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN state IN ('verified','cached') AND result='new_fiber' THEN 1 ELSE 0 END) AS fresh,
    SUM(CASE WHEN result='no_service' THEN 1 ELSE 0 END) AS noService FROM qualification_checks WHERE job_id=?`,
    )
    .get(job.id) as any;
  // PUBLICATION RETRY: any provider-verified Fresh answer (NEW FIBER + billing N
  // = result 'new_fiber') that has no Lead yet gets re-published every reconcile
  // tick until the upsert sticks. A failed Lead write can delay publication —
  // it can never relabel the successful provider result.
  const unpublished = rawDb
    .prepare(
      `SELECT DISTINCT q.scan_target_id AS id FROM qualification_checks q
    LEFT JOIN leads l ON l.source_scan_target_id=q.scan_target_id AND l.tenant_id=q.tenant_id AND l.lead_tag='fresh_fiber_confirmed'
    WHERE q.job_id=? AND q.state IN ('verified','cached') AND q.result='new_fiber' AND q.scan_target_id IS NOT NULL AND l.id IS NULL`,
    )
    .all(job.id) as any[];
  if (unpublished.length) {
    try {
      projectConfirmedFreshLeads(job.tenantId, unpublished.map((row) => Number(row.id)));
    } catch (error: any) {
      structuredLog("discovery.lead_publication_retry_failed", {
        jobId: job.id, tenantId: job.tenantId, targets: unpublished.length,
        error: String(error?.message ?? error).slice(0, 200),
      }, "warn");
    }
  }
  // Any confirmed fresh lead counts — cross_verified (independent corroboration)
  // AND kinetic_new_fiber (the authoritative NEW FIBER + billing N publish rule).
  const projectedLeads = rawDb
    .prepare(
      `SELECT l.id,l.lat,l.lng,l.lead_status AS status,l.address,l.city,l.state,l.zip,
    l.fresh_confidence AS freshConfidence,
    q.id AS checkId,q.lead_id AS priorLeadId,q.canonical_address_id AS canonicalAddressId
    FROM qualification_checks q JOIN leads l ON l.source_scan_target_id=q.scan_target_id AND l.tenant_id=q.tenant_id
    WHERE q.job_id=? AND l.lead_tag='fresh_fiber_confirmed'`,
    )
    .all(job.id) as any[];
  for (const lead of projectedLeads) {
    if (lead.priorLeadId === lead.id) continue;
    rawDb
      .prepare(
        `UPDATE qualification_checks SET lead_id=?,updated_at=datetime('now') WHERE id=?`,
      )
      .run(lead.id, lead.checkId);
    appendDiscoveryEvent(job.tenantId, job.id, "lead.published", {
      lead: {
        leadId: lead.id,
        id: lead.id,
        canonicalAddressId: lead.canonicalAddressId,
        address: lead.address,
        city: lead.city,
        state: lead.state,
        zip: lead.zip,
        lat: lead.lat,
        lng: lead.lng,
        status: lead.status,
        leadTag: "fresh_fiber_confirmed",
        freshConfidence: lead.freshConfidence,
        isFreshFiber: true,
        qualified: true,
      },
      feature: {
        type: "Feature",
        id: lead.id,
        geometry: { type: "Point", coordinates: [lead.lng, lead.lat] },
        properties: {
          id: lead.id,
          address: lead.address,
          city: lead.city,
          state: lead.state,
          zip: lead.zip,
          status: lead.status,
          leadTag: "fresh_fiber_confirmed",
          freshConfidence: lead.freshConfidence,
          isFreshFiber: true,
          qualified: true,
        },
      },
    });
  }
  const totalRuns = Number(runCounts.total || 0);
  const terminalRuns = Number(runCounts.terminal || 0);
  // Awaiting-publication: provider said Fresh, Lead row not written yet (the
  // retry above republishes each tick). The job may NOT complete while any
  // discovered address is unattempted, pending retry, or awaiting its Lead.
  const awaitingPublication = Number(
    (rawDb
      .prepare(
        `SELECT COUNT(DISTINCT q.scan_target_id) AS n FROM qualification_checks q
      LEFT JOIN leads l ON l.source_scan_target_id=q.scan_target_id AND l.tenant_id=q.tenant_id AND l.lead_tag='fresh_fiber_confirmed'
      WHERE q.job_id=? AND q.state IN ('verified','cached') AND q.result='new_fiber' AND q.scan_target_id IS NOT NULL AND l.id IS NULL`,
      )
      .get(job.id) as any)?.n ?? 0,
  );
  const terminal =
    Boolean(job.qualificationDispatchCompletedAt) &&
    (totalRuns === 0 || terminalRuns === totalRuns) &&
    Number(checkCounts.pending || 0) === 0 &&
    awaitingPublication === 0;
  const tileProblems =
    job.partialTiles + job.failedTiles + job.handoffCollisions;
  const status = terminal
    ? tileProblems ||
      Number(runCounts.failed || 0) ||
      Number(checkCounts.failed || 0)
      ? "partial"
      : "completed"
    : "running";
  rawDb
    .prepare(
      `UPDATE discovery_jobs SET addresses_qualified=?,qualification_checked=?,qualification_failed=?,fresh_found=?,no_service_found=?,
    status=?,completed_at=CASE WHEN ? THEN datetime('now') ELSE completed_at END,heartbeat_at=datetime('now'),updated_at=datetime('now') WHERE id=?`,
    )
    .run(
      Number(checkCounts.total || 0),
      Number(checkCounts.checked || 0),
      Number(checkCounts.failed || 0),
      // Rule: fresh_found counts PROVIDER results (state verified + result
      // new_fiber = NEW FIBER + billing N), not the Lead join. Publication is
      // tracked separately (lead_id stamps / awaitingPublication).
      Number(checkCounts.fresh || 0),
      Number(checkCounts.noService || 0),
      status,
      terminal ? 1 : 0,
      job.id,
    );
  if (terminal)
    appendDiscoveryEvent(job.tenantId, job.id, "job.completed", {
      status,
      checked: Number(checkCounts.checked || 0),
      failed: Number(checkCounts.failed || 0),
      freshFound: Number(checkCounts.fresh || 0),
      leadsPublished: projectedLeads.length,
      noServiceFound: Number(checkCounts.noService || 0),
      partialTiles: job.partialTiles,
      failedTiles: job.failedTiles,
      handoffCollisions: job.handoffCollisions,
    });
  return { terminal, status };
}

export function activeQualificationJobs(): DiscoveryJobRow[] {
  return rawDb
    .prepare(
      `${jobSelect} WHERE status='running' AND phase='qualification' ORDER BY created_at LIMIT 100`,
    )
    .all() as DiscoveryJobRow[];
}

export function cancelDiscoveryJob(tenantId: number, jobId: string): boolean {
  const changed = rawDb
    .prepare(
      `UPDATE discovery_jobs SET status='cancelled',cancelled_at=datetime('now'),completed_at=datetime('now'),updated_at=datetime('now')
    WHERE tenant_id=? AND id=? AND status IN ('queued','running')`,
    )
    .run(tenantId, jobId).changes;
  if (!changed) return false;
  rawDb
    .prepare(
      `UPDATE discovery_tiles SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,completed_at=datetime('now'),updated_at=datetime('now')
    WHERE job_id=? AND status IN ('queued','running')`,
    )
    .run(jobId);
  rawDb
    .prepare(
      `UPDATE scan_runs SET status='cancelled',completed_at=datetime('now') WHERE id IN (SELECT run_id FROM discovery_job_runs WHERE job_id=?) AND status IN ('running','paused')`,
    )
    .run(jobId);
  appendDiscoveryEvent(tenantId, jobId, "job.cancelled", {});
  return true;
}

/**
 * Boot/crash reconciler for operator-ELECTED area scans.
 *
 * An elected box scan (drawn on the field map) belongs to exactly one operator
 * session; when the process that was running it dies, the job is a zombie. The
 * old behaviour RESUMED any stuck job on boot, so a crash-orphaned elected scan
 * would silently restart server-side AND keep surfacing through `?active=true` —
 * one of the two causes of "Scanning fiber" appearing on every launch. A stale
 * running state is NEVER permission to restart an elected scan: we terminalize
 * it (status `failed`) so the scheduler will not re-drive it and the active
 * feed will not return it.
 *
 * This deliberately does NOT touch background market/frontier/town harvests —
 * those are the continuous engine and are meant to resume. `isElectedAreaJob`
 * is the single, shared signal (same one the client uses) for "the operator
 * elected this box". Only jobs whose heartbeat is stale are terminalized, so an
 * elected scan actively processed by a still-alive worker in a multi-core
 * cluster is never wrongly killed.
 *
 * Returns the number of jobs terminalized.
 */
export function terminalizeOrphanedElectedJobs(options?: {
  staleMinutes?: number;
}): number {
  const staleMinutes = Math.max(1, Math.floor(options?.staleMinutes ?? 5));
  // Cheap SQL pre-filter (indexable status), then the canonical JS classifier
  // decides "elected" so this stays byte-for-byte consistent with the client.
  const candidates = rawDb
    .prepare(
      `${jobSelect} WHERE status IN ('queued','running')
        AND (heartbeat_at IS NULL OR heartbeat_at < datetime('now', ?))`,
    )
    .all(`-${staleMinutes} minutes`) as DiscoveryJobRow[];
  let terminalized = 0;
  for (const job of candidates) {
    if (!isElectedAreaJob(job)) continue;
    const changed = rawDb
      .prepare(
        `UPDATE discovery_jobs SET status='failed',
          error_summary=COALESCE(error_summary,'interrupted: server restarted; elected area scans are not auto-resumed'),
          completed_at=datetime('now'),heartbeat_at=datetime('now'),updated_at=datetime('now')
        WHERE id=? AND status IN ('queued','running')`,
      )
      .run(job.id).changes;
    if (!changed) continue; // another worker terminalized it first
    rawDb
      .prepare(
        `UPDATE discovery_tiles SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,completed_at=datetime('now'),updated_at=datetime('now')
        WHERE job_id=? AND status IN ('queued','running')`,
      )
      .run(job.id);
    rawDb
      .prepare(
        `UPDATE scan_runs SET status='cancelled',completed_at=datetime('now') WHERE id IN (SELECT run_id FROM discovery_job_runs WHERE job_id=?) AND status IN ('running','paused')`,
      )
      .run(job.id);
    appendDiscoveryEvent(job.tenantId, job.id, "job.interrupted", {
      reason: "server_restart",
      phase: job.phase,
      note: "elected area scans are not auto-resumed",
    });
    terminalized += 1;
  }
  if (terminalized > 0) {
    structuredLog("address_discovery.orphaned_elected_terminalized", {
      count: terminalized,
      staleMinutes,
    });
  }
  return terminalized;
}

export function retryDiscoveryTiles(
  tenantId: number,
  jobId: string,
  tileIds?: string[],
): number {
  const job = getDiscoveryJob(tenantId, jobId);
  if (!job || job.status === "cancelled" || job.phase !== "discovery") return 0;
  const ids = (tileIds ?? []).filter(Boolean);
  const sql = ids.length
    ? `UPDATE discovery_tiles SET status='queued',attempt_count=0,next_attempt_at=NULL,error=NULL,source_errors_json='{}',lease_owner=NULL,lease_expires_at=NULL,completed_at=NULL,updated_at=datetime('now') WHERE job_id=? AND status IN ('partial','failed') AND id IN (${ids.map(() => "?").join(",")})`
    : `UPDATE discovery_tiles SET status='queued',attempt_count=0,next_attempt_at=NULL,error=NULL,source_errors_json='{}',lease_owner=NULL,lease_expires_at=NULL,completed_at=NULL,updated_at=datetime('now') WHERE job_id=? AND status IN ('partial','failed')`;
  const changed = rawDb.prepare(sql).run(jobId, ...ids).changes;
  if (changed) {
    rawDb
      .prepare(
        `UPDATE discovery_jobs SET status='queued',phase='discovery',completed_at=NULL,error_summary=NULL,updated_at=datetime('now') WHERE id=?`,
      )
      .run(jobId);
    recomputeDiscoveryProgress(jobId);
    appendDiscoveryEvent(tenantId, jobId, "tiles.retried", {
      tileIds: ids.length ? ids : null,
      count: changed,
    });
  }
  return changed;
}

export function appendDiscoveryEvent(
  tenantId: number,
  jobId: string,
  eventType: string,
  payload: unknown,
): number {
  const info = rawDb
    .prepare(
      `INSERT INTO discovery_events(tenant_id,job_id,event_type,payload_json) VALUES (?,?,?,?)`,
    )
    .run(tenantId, jobId, eventType, JSON.stringify(payload ?? {}));
  return Number(info.lastInsertRowid);
}

export function readDiscoveryEvents(input: {
  tenantId: number;
  after: number;
  jobId?: string;
  createdBy?: number;
  limit?: number;
}): any[] {
  const where = ["e.tenant_id=?", "e.sequence>?"];
  const args: unknown[] = [input.tenantId, input.after];
  if (input.jobId) {
    where.push("e.job_id=?");
    args.push(input.jobId);
  }
  if (input.createdBy != null) {
    where.push("j.created_by=?");
    args.push(input.createdBy);
  }
  args.push(Math.max(1, Math.min(500, input.limit ?? 100)));
  return (
    rawDb
      .prepare(
        `SELECT e.sequence,e.job_id AS jobId,e.event_type AS eventType,e.payload_json AS payloadJson,e.created_at AS createdAt
    FROM discovery_events e JOIN discovery_jobs j ON j.id=e.job_id WHERE ${where.join(" AND ")} ORDER BY e.sequence LIMIT ?`,
      )
      .all(...args) as any[]
  ).map((row) => ({
    ...row,
    payload: parseJson(row.payloadJson, {}),
    payloadJson: undefined,
  }));
}

export function getCoverageGeoJson(
  tenantId: number,
  jobId: string,
): any | undefined {
  const job = getDiscoveryJob(tenantId, jobId);
  if (!job) return undefined;
  const tiles = rawDb
    .prepare(`${tileSelect} WHERE job_id=? ORDER BY sequence`)
    .all(jobId) as DiscoveryTileRow[];
  return {
    type: "FeatureCollection",
    features: tiles.map((tile) => ({
      type: "Feature",
      id: tile.id,
      geometry: parseJson(tile.geometryJson, null),
      properties: {
        tileId: tile.id,
        status: tile.status,
        coverageRatio: tile.coverageRatio,
        coverageClass: tile.coverageClass,
        observed: tile.observedCount,
        inferred: tile.inferredCount,
        duplicates: tile.duplicateCount,
        errors: parseJson(tile.sourceErrorsJson, {}),
      },
    })),
  };
}

export function getAddressExplanation(
  tenantId: number,
  canonicalAddressId: number,
): any | undefined {
  const address = rawDb
    .prepare(`SELECT * FROM canonical_addresses WHERE tenant_id=? AND id=?`)
    .get(tenantId, canonicalAddressId) as any;
  if (!address) return undefined;
  const evidence = rawDb
    .prepare(
      `SELECT id,source_id AS sourceId,source_record_id AS sourceRecordId,evidence_kind AS evidenceKind,
    authoritative,observed,inferred,confidence,license_name AS licenseName,license_url AS licenseUrl,content_hash AS contentHash,
    observed_at AS observedAt,created_at AS createdAt FROM address_evidence WHERE tenant_id=? AND canonical_address_id=? ORDER BY authoritative DESC,confidence DESC`,
    )
    .all(tenantId, canonicalAddressId);
  const coordinates = rawDb
    .prepare(
      `SELECT source_id AS sourceId,lat,lng,quality,confidence,observed_at AS observedAt FROM address_coordinates
    WHERE tenant_id=? AND canonical_address_id=? ORDER BY confidence DESC`,
    )
    .all(tenantId, canonicalAddressId);
  const memberships = rawDb
    .prepare(
      `SELECT d.job_id AS jobId,d.first_seen_at AS firstSeenAt,d.scan_target_id AS scanTargetId,q.state,q.result,q.cache_reused AS cacheReused,q.lead_id AS leadId
    FROM discovery_job_addresses d JOIN discovery_jobs j ON j.id=d.job_id
    LEFT JOIN qualification_checks q ON q.job_id=d.job_id AND q.canonical_address_id=d.canonical_address_id
    WHERE j.tenant_id=? AND d.canonical_address_id=? ORDER BY d.first_seen_at DESC`,
    )
    .all(tenantId, canonicalAddressId);
  return { address, evidence, coordinates, memberships };
}

export function updateSourceHealth(input: {
  tenantId: number;
  sourceId: string;
  ok: boolean;
  records?: number;
  error?: string;
}): void {
  const failuresBeforeOpen = Math.max(
    2,
    Number(process.env.DISCOVERY_CIRCUIT_FAILURES) || 4,
  );
  rawDb
    .prepare(
      `INSERT INTO address_source_health
      (tenant_id,source_id,health_status,consecutive_failures,last_success_at,last_failure_at,last_error,requests,records)
      VALUES (?,?,?, ?,CASE WHEN ? THEN datetime('now') ELSE NULL END,CASE WHEN ? THEN NULL ELSE datetime('now') END,?,1,?)
      ON CONFLICT(tenant_id,source_id) DO UPDATE SET
        health_status=excluded.health_status,
        consecutive_failures=CASE WHEN excluded.health_status='healthy' THEN 0 ELSE address_source_health.consecutive_failures+1 END,
        last_success_at=CASE WHEN excluded.health_status='healthy' THEN datetime('now') ELSE address_source_health.last_success_at END,
        last_failure_at=CASE WHEN excluded.health_status='healthy' THEN address_source_health.last_failure_at ELSE datetime('now') END,
        last_error=excluded.last_error,requests=address_source_health.requests+1,records=address_source_health.records+excluded.records,
        circuit_open_until=CASE WHEN excluded.health_status!='healthy' AND address_source_health.consecutive_failures+1>=?
          THEN datetime('now','+5 minutes') ELSE NULL END,updated_at=datetime('now')`,
    )
    .run(
      input.tenantId,
      input.sourceId,
      input.ok ? "healthy" : "degraded",
      input.ok ? 0 : 1,
      input.ok ? 1 : 0,
      input.ok ? 1 : 0,
      input.error?.slice(0, 300) ?? null,
      input.records ?? 0,
      failuresBeforeOpen,
    );
}

export function sourceHealth(tenantId: number): any[] {
  return rawDb
    .prepare(
      `SELECT source_id AS sourceId,enabled,priority,health_status AS healthStatus,
    consecutive_failures AS consecutiveFailures,last_success_at AS lastSuccessAt,last_failure_at AS lastFailureAt,
    last_error AS lastError,circuit_open_until AS circuitOpenUntil,requests,records,updated_at AS updatedAt
    FROM address_source_health WHERE tenant_id=? ORDER BY priority,source_id`,
    )
    .all(tenantId) as any[];
}

export function configureSource(
  tenantId: number,
  sourceId: string,
  enabled: boolean,
  priority: number,
): void {
  rawDb
    .prepare(
      `INSERT INTO address_source_health(tenant_id,source_id,enabled,priority) VALUES (?,?,?,?)
    ON CONFLICT(tenant_id,source_id) DO UPDATE SET enabled=excluded.enabled,priority=excluded.priority,updated_at=datetime('now')`,
    )
    .run(tenantId, sourceId, enabled ? 1 : 0, priority);
}

export function cacheGet(
  tenantId: number,
  sourceId: string,
  cacheKey: string,
): { payload: unknown; partial: boolean } | undefined {
  const row = rawDb
    .prepare(
      `SELECT payload_json AS payloadJson,partial FROM address_source_cache
    WHERE tenant_id=? AND source_id=? AND cache_key=? AND expires_at>datetime('now')`,
    )
    .get(tenantId, sourceId, cacheKey) as any;
  return row
    ? {
        payload: parseJson(row.payloadJson, null),
        partial: Boolean(row.partial),
      }
    : undefined;
}

export function cachePut(
  tenantId: number,
  sourceId: string,
  cacheKey: string,
  payload: unknown,
  partial: boolean,
  ttlHours: number,
): void {
  rawDb
    .prepare(
      `INSERT INTO address_source_cache(tenant_id,source_id,cache_key,payload_json,partial,created_at,expires_at)
    VALUES (?,?,?,?,?,datetime('now'),datetime('now',?)) ON CONFLICT(tenant_id,source_id,cache_key) DO UPDATE SET
      payload_json=excluded.payload_json,partial=excluded.partial,created_at=excluded.created_at,expires_at=excluded.expires_at`,
    )
    .run(
      tenantId,
      sourceId,
      cacheKey,
      JSON.stringify(payload),
      partial ? 1 : 0,
      `+${Math.max(1, ttlHours)} hours`,
    );
}
