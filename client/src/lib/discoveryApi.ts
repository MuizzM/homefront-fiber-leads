import { apiRequest } from "@/lib/queryClient";

export type DiscoveryJobStatus =
  | "queued"
  | "resolving_boundary"
  | "discovering"
  | "qualifying"
  | "partial"
  | "completed"
  | "failed"
  | "cancelled";

// Values the server's coverageStatus(job) actually emits (routes.ts).
export type CoverageStatus =
  | "high_coverage"
  | "partial_coverage"
  | "sparse_source_data"
  | "source_unavailable"
  | "still_processing"
  | "processing"
  | "verification_required"
  | string;

export interface DiscoveryPolygon {
  type: "Polygon";
  coordinates: number[][][];
}

export interface DiscoveryMultiPolygon {
  type: "MultiPolygon";
  coordinates: number[][][][];
}

export type DiscoveryGeometry = DiscoveryPolygon | DiscoveryMultiPolygon;

export interface DiscoveryJob {
  id: string;
  organizationId?: number | null;
  userId?: number | null;
  city?: string | null;
  state?: string | null;
  geometry?: DiscoveryGeometry | null;
  boundarySource?: string | null;
  status: DiscoveryJobStatus;
  idempotencyKey?: string | null;
  discoveredCount: number;
  uniqueCandidateCount: number;
  validatedCount: number;
  checkedCount: number;
  qualifiedCount: number;
  newLeadsCount: number;
  stillFreshCount: number;
  serviceActiveCount: number;
  comingSoonCount: number;
  /** Failed attempts at addresses with NO confirmed lead (true unknowns). */
  unresolvedCount: number;
  failedCount: number;
  cachedCount: number;
  coverageStatus: CoverageStatus | null;
  sourceWarnings?: string[];
  sources?: Array<{
    name: string;
    status: string;
    records?: number;
    errorCode?: string | null;
    license?: string | null;
  }>;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  error?: string | null;
}

export interface DiscoverySource {
  id: string;
  label: string;
  coverageClass: "authoritative" | "primary" | "supplemental" | "evidence_only" | string;
  authoritative: boolean;
  evidenceOnly: boolean;
  licenseName: string;
  licenseUrl: string | null;
  defaultPriority: number;
  enabled: boolean;
  priority: number;
  available: boolean;
  healthStatus: string;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  circuitOpenUntil: string | null;
  requests: number;
  records: number;
}

export interface DiscoveryCoverageProperties {
  tileId?: string;
  status?: string;
  coverageRatio?: number | null;
  coverageClass?: string;
  observed?: number;
  inferred?: number;
  duplicates?: number;
  errors?: Record<string, unknown>;
}

export interface DiscoveryCoverageFeature {
  type: "Feature";
  id?: string | number;
  geometry: DiscoveryGeometry;
  properties: DiscoveryCoverageProperties;
}

export interface DiscoveryCoverage {
  type: "FeatureCollection";
  features: DiscoveryCoverageFeature[];
}

export interface DiscoveryUpload {
  id: string;
  filename: string;
  format: string;
  sourceId?: string;
  licenseName?: string | null;
  licenseUrl?: string | null;
  authoritative?: boolean;
  recordCount: number;
  rejectedCount: number;
  createdAt?: string | null;
  replayed?: boolean;
}

export interface DiscoveryAddressExplanation {
  address: Record<string, any>;
  evidence: Array<Record<string, any>>;
  coordinates: Array<Record<string, any>>;
  memberships: Array<Record<string, any>>;
}

export interface DiscoveryEvent {
  id: string | number;
  eventType: string;
  jobId: string;
  payload: Record<string, any>;
}

export const ACTIVE_DISCOVERY_STATUSES = new Set<DiscoveryJobStatus>([
  "queued",
  "resolving_boundary",
  "discovering",
  "qualifying",
]);

export function isActiveDiscoveryJob(job: DiscoveryJob): boolean {
  return ACTIVE_DISCOVERY_STATUSES.has(job.status);
}

export function isTerminalDiscoveryJob(job: DiscoveryJob): boolean {
  return !isActiveDiscoveryJob(job);
}

/**
 * Server-initiated market harvests — the recurring hot-market / frontier town
 * jobs and any other town-based (no drawn area) refresh. They run around the
 * clock, so the field map must never bind its scan sheet to them: a rep only
 * cares about the box THEY drew. A field scan always carries the drawn
 * geometry; background jobs are town-keyed with none.
 */
export function isBackgroundDiscoveryJob(job: DiscoveryJob): boolean {
  const key = String(job.idempotencyKey ?? "");
  if (key.startsWith("hot:") || key.startsWith("frontier:")) return true;
  return job.geometry == null;
}

function finiteCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

function normalizeSource(input: Record<string, any>): DiscoverySource {
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : input;
  const id = String(input.sourceId ?? metadata.id ?? "");
  const priority = finiteCount(input.priority ?? metadata.defaultPriority ?? 100);
  return {
    ...metadata,
    ...input,
    id,
    label: String(metadata.label ?? id),
    coverageClass: String(metadata.coverageClass ?? "supplemental"),
    authoritative: Boolean(metadata.authoritative),
    evidenceOnly: Boolean(metadata.evidenceOnly),
    licenseName: String(metadata.licenseName ?? "License not reported"),
    licenseUrl: metadata.licenseUrl ? String(metadata.licenseUrl) : null,
    defaultPriority: finiteCount(metadata.defaultPriority ?? priority),
    enabled: input.enabled !== false && input.enabled !== 0,
    priority,
    available: input.available !== false,
    healthStatus: String(input.healthStatus ?? "unknown"),
    consecutiveFailures: finiteCount(input.consecutiveFailures),
    lastSuccessAt: input.lastSuccessAt ? String(input.lastSuccessAt) : null,
    lastFailureAt: input.lastFailureAt ? String(input.lastFailureAt) : null,
    lastError: input.lastError || input.healthMessage ? String(input.lastError ?? input.healthMessage) : null,
    circuitOpenUntil: input.circuitOpenUntil ? String(input.circuitOpenUntil) : null,
    requests: finiteCount(input.requests),
    records: finiteCount(input.records),
  };
}

/**
 * The event stream is intentionally tolerant of partial job snapshots. Every
 * counter is normalized here so a malformed source event cannot put NaN into a
 * progress bar or make the map render an impossible negative count.
 */
export function normalizeDiscoveryJob(input: Partial<DiscoveryJob> & { id: string }): DiscoveryJob {
  return {
    ...input,
    id: String(input.id),
    status: input.status ?? "queued",
    discoveredCount: finiteCount(input.discoveredCount),
    uniqueCandidateCount: finiteCount(input.uniqueCandidateCount),
    validatedCount: finiteCount(input.validatedCount),
    checkedCount: finiteCount(input.checkedCount),
    qualifiedCount: finiteCount(input.qualifiedCount),
    newLeadsCount: finiteCount(input.newLeadsCount),
    stillFreshCount: finiteCount(input.stillFreshCount),
    serviceActiveCount: finiteCount(input.serviceActiveCount),
    comingSoonCount: finiteCount(input.comingSoonCount),
    // Older server payloads had no unresolvedCount — fall back to failedCount
    // so the tile stays populated rather than silently reading 0.
    unresolvedCount: finiteCount(input.unresolvedCount ?? input.failedCount),
    failedCount: finiteCount(input.failedCount),
    cachedCount: finiteCount(input.cachedCount),
    coverageStatus: input.coverageStatus ?? "processing",
    sourceWarnings: Array.isArray(input.sourceWarnings)
      ? input.sourceWarnings.map(String).slice(0, 20)
      : [],
  };
}

export function bboxPolygon(bbox: {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}): DiscoveryPolygon {
  return {
    type: "Polygon",
    coordinates: [[
      [bbox.minLng, bbox.minLat],
      [bbox.maxLng, bbox.minLat],
      [bbox.maxLng, bbox.maxLat],
      [bbox.minLng, bbox.maxLat],
      [bbox.minLng, bbox.minLat],
    ]],
  };
}

function canonicalCoordinate(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Scan geometry contains an invalid coordinate");
  return value.toFixed(6);
}

/**
 * Request-replay key: the hash makes geometry visible in diagnostics while the
 * per-submission nonce permits an intentional later rescan of the same area.
 * Callers must retain the nonce across retries of one draw submission.
 */
export function discoveryIdempotencyKey(
  geometry: DiscoveryGeometry,
  organizationId?: number | null,
  submissionNonce = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
): string {
  const normalized = JSON.stringify(geometry.coordinates, (_key, value) =>
    typeof value === "number" ? canonicalCoordinate(value) : value,
  );
  const text = `v1|${organizationId ?? "unknown"}|${geometry.type}|${normalized}`;
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return `discovery-${hash.toString(16).padStart(16, "0")}-${submissionNonce}`;
}

export const discoveryApi = {
  async create(input: {
    geometry: DiscoveryGeometry;
    city?: string;
    state?: string;
    idempotencyKey: string;
    // Force a fresh fiber/billing check on every discovered address, including
    // existing leads (bypasses the server's conclusive-result cache).
    rescan?: boolean;
  }): Promise<DiscoveryJob> {
    const response = await apiRequest("POST", "/api/discovery/jobs", input);
    const body = await response.json();
    return normalizeDiscoveryJob(body.job);
  },

  async list(active?: boolean): Promise<DiscoveryJob[]> {
    const response = await apiRequest("GET", active ? "/api/discovery/jobs?active=true" : "/api/discovery/jobs");
    const body = await response.json();
    return Array.isArray(body.jobs) ? body.jobs.map(normalizeDiscoveryJob) : [];
  },

  async active(): Promise<DiscoveryJob[]> {
    return this.list(true);
  },

  async get(id: string): Promise<DiscoveryJob> {
    const response = await apiRequest("GET", `/api/discovery/jobs/${encodeURIComponent(id)}`);
    const body = await response.json();
    return normalizeDiscoveryJob(body.job ?? body);
  },

  async cancel(id: string): Promise<DiscoveryJob> {
    const response = await apiRequest("POST", `/api/discovery/jobs/${encodeURIComponent(id)}/cancel`);
    const body = await response.json();
    return normalizeDiscoveryJob(body.job ?? { id, status: "cancelled" });
  },

  async sources(): Promise<DiscoverySource[]> {
    const response = await apiRequest("GET", "/api/discovery/sources");
    const body = await response.json();
    return Array.isArray(body.sources) ? body.sources.map(normalizeSource) : [];
  },

  async configureSource(id: string, input: { enabled: boolean; priority: number }): Promise<DiscoverySource> {
    const response = await apiRequest("PATCH", `/api/discovery/sources/${encodeURIComponent(id)}`, input);
    const body = await response.json();
    return normalizeSource(body.source ?? { id, ...input });
  },

  async upload(input: {
    file: File;
    licenseName?: string;
    licenseUrl?: string;
    authoritative: boolean;
  }): Promise<DiscoveryUpload> {
    const lower = input.file.name.toLowerCase();
    const format = lower.endsWith(".csv") ? "csv" : lower.endsWith(".geojson") ? "geojson" : "json";
    const response = await apiRequest("POST", "/api/discovery/uploads", {
      filename: input.file.name,
      format,
      content: await input.file.text(),
      licenseName: input.licenseName || undefined,
      licenseUrl: input.licenseUrl || undefined,
      authoritative: input.authoritative,
    });
    const body = await response.json();
    const upload = body.upload ?? body;
    return {
      ...upload,
      id: String(upload.id),
      filename: String(upload.filename ?? input.file.name),
      format: String(upload.format ?? format),
      recordCount: finiteCount(upload.recordCount ?? upload.accepted),
      rejectedCount: finiteCount(upload.rejectedCount ?? upload.rejected),
      authoritative: Boolean(upload.authoritative ?? input.authoritative),
      replayed: Boolean(body.replayed ?? upload.replayed),
    };
  },

  async coverage(id: string): Promise<DiscoveryCoverage> {
    const response = await apiRequest("GET", `/api/discovery/jobs/${encodeURIComponent(id)}/coverage`);
    const body = await response.json();
    const collection = body.coverage ?? body;
    return collection?.type === "FeatureCollection" && Array.isArray(collection.features)
      ? collection as DiscoveryCoverage
      : { type: "FeatureCollection", features: [] };
  },

  async retryTiles(id: string, tileIds?: string[]): Promise<DiscoveryJob> {
    const response = await apiRequest("POST", `/api/discovery/jobs/${encodeURIComponent(id)}/retry`, tileIds?.length ? { tileIds } : {});
    const body = await response.json();
    return normalizeDiscoveryJob(body.job ?? { id, status: "queued" });
  },

  async explainAddress(id: string | number): Promise<DiscoveryAddressExplanation> {
    const response = await apiRequest("GET", `/api/discovery/addresses/${encodeURIComponent(String(id))}`);
    const body = await response.json();
    const explanation = body.explanation ?? body;
    return {
      address: explanation.address ?? {},
      evidence: Array.isArray(explanation.evidence) ? explanation.evidence : [],
      coordinates: Array.isArray(explanation.coordinates) ? explanation.coordinates : [],
      memberships: Array.isArray(explanation.memberships) ? explanation.memberships : [],
    };
  },
};
