import crypto from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  geometryBbox,
  validateDiscoveryGeometry,
} from "@shared/addressDiscovery";
import { can as hasCapability, type Capability } from "@shared/capabilities";
import { rawDb } from "../db";
import { storage } from "../storage";
import {
  addressSources,
  allSourceMetadata,
  parseUploadedPayload,
  sourceById,
} from "./sources";
import { wakeDiscoveryWorkers } from "./engine";
import {
  cancelDiscoveryJob,
  configureSource,
  createDiscoveryJob,
  getAddressExplanation,
  getCoverageGeoJson,
  getDiscoveryJob,
  listDiscoveryJobs,
  planDiscoveryTiles as persistTiles,
  readDiscoveryEvents,
  retryDiscoveryTiles,
  sourceHealth,
  type DiscoveryJobRow,
} from "./store";
import { bboxPolygon } from "./types";
import { planDiscoveryTiles } from "@shared/addressDiscovery";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

export interface DiscoveryRouteDeps {
  requireAuth: Middleware;
  requireCapability: (capability: Capability) => Middleware;
  requireScanningAllowed: Middleware;
}

const geometrySchema = z
  .object({
    type: z.enum(["Polygon", "MultiPolygon"]),
    coordinates: z.unknown(),
  })
  .passthrough();

const createSchema = z
  .object({
    geometry: geometrySchema.optional(),
    town: z.string().trim().min(1).max(120).optional(),
    townName: z.string().trim().min(1).max(120).optional(),
    city: z.string().trim().min(1).max(120).optional(),
    state: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/)
      .optional(),
    idempotencyKey: z
      .string()
      .trim()
      .min(8)
      .max(200)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
    sources: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    // rescan=true forces a FRESH fiber/billing check on every discovered address
    // — including ones already qualified or already leads — by bypassing the
    // conclusive-result cache. This is how a field re-scan catches a fresh lead
    // that has since bought service, or a coming-soon that just went live.
    rescan: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (!value.geometry && !(value.town || value.townName || value.city)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide geometry or a town name",
      });
    }
    if (!value.geometry && !value.state)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Town discovery requires a two-letter state",
      });
  });

const sourcePatchSchema = z.object({
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(1_000),
});
const retrySchema = z.object({
  tileIds: z.array(z.string().uuid()).max(500).optional(),
});
const uploadSchema = z.object({
  filename: z.string().trim().min(1).max(180),
  format: z.enum(["csv", "geojson", "json"]),
  content: z.string().min(1).max(14_000_000),
  licenseName: z.string().trim().max(200).optional(),
  licenseUrl: z.string().url().max(500).optional(),
  authoritative: z.boolean().default(false),
});

function tenantId(req: Request): number | null {
  const value = Number((req as any).user?.tenantId);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

function canManage(req: Request): boolean {
  return hasCapability((req as any).user?.role, "scan.manage");
}

function allowedJob(req: Request, job: DiscoveryJobRow): boolean {
  const user = (req as any).user;
  return (
    job.tenantId === tenantId(req) &&
    (canManage(req) || job.createdBy === Number(user?.id))
  );
}

function coverageStatus(job: DiscoveryJobRow): string {
  if (
    ["queued", "running"].includes(job.status) &&
    job.phase !== "qualification"
  )
    return "still_processing";
  const rows = rawDb
    .prepare(
      `SELECT coverage_class AS coverageClass FROM discovery_tiles WHERE job_id=?`,
    )
    .all(job.id) as any[];
  const classes = rows.map((row) => row.coverageClass);
  if (classes.includes("source_unavailable")) return "source_unavailable";
  if (classes.includes("verification_required")) return "verification_required";
  if (classes.includes("sparse_source_data")) return "sparse_source_data";
  if (classes.includes("partial_coverage")) return "partial_coverage";
  if (classes.length && classes.every((value) => value === "high_coverage"))
    return "high_coverage";
  return "still_processing";
}

function publicJob(
  job: DiscoveryJobRow,
  includeDiagnostics = false,
): Record<string, unknown> {
  const activeStatus =
    job.status === "running"
      ? job.phase === "boundary"
        ? "resolving_boundary"
        : job.phase === "discovery"
          ? "discovering"
          : "qualifying"
      : job.status;
  const warnings = rawDb
    .prepare(
      `SELECT error FROM discovery_tiles WHERE job_id=? AND error IS NOT NULL ORDER BY sequence LIMIT 20`,
    )
    .all(job.id)
    .map((row: any) => String(row.error));
  if (job.errorSummary && !warnings.includes(job.errorSummary))
    warnings.unshift(job.errorSummary);
  // Transition counts for the rescan summary. Read-only, scoped to this job's
  // checks + latest snapshot per address; admin-only (diagnostics) so the job
  // LIST stays cheap. `new` vs `still fresh` splits confirmed fresh leads by
  // whether the lead was created during this scan; `now active` = a fresh lead
  // whose latest check shows active billing (bought service); `coming soon` =
  // NEW FIBER at an address that already has active billing.
  const startedAt = job.startedAt || job.createdAt;
  // Only run the (indexed) transition-count queries once the job has actually
  // checked something — a job still discovering has all-zero transitions anyway,
  // so a busy job LIST never pays for them.
  const t = includeDiagnostics && (job.qualificationChecked > 0 || job.freshFound > 0)
    ? (() => {
        const latest = `a.id=(SELECT MAX(a2.id) FROM availability_snapshots a2 WHERE a2.scan_target_id=q.scan_target_id)`;
        const coming = rawDb.prepare(
          `SELECT COUNT(*) n FROM qualification_checks q JOIN availability_snapshots a ON ${latest}
           WHERE q.job_id=? AND upper(COALESCE(a.household_segment_type,'')) LIKE '%NEW FIBER%' AND COALESCE(a.billing_status,'')='Y'`,
        ).get(job.id) as any;
        const active = rawDb.prepare(
          `SELECT COUNT(*) n FROM qualification_checks q
           JOIN leads l ON l.source_scan_target_id=q.scan_target_id AND l.tenant_id=q.tenant_id AND l.lead_tag='fresh_fiber_confirmed'
           JOIN availability_snapshots a ON ${latest}
           WHERE q.job_id=? AND COALESCE(a.billing_status,'')='Y'`,
        ).get(job.id) as any;
        const fresh = rawDb.prepare(
          `SELECT SUM(CASE WHEN datetime(l.created_at)>=datetime(?) THEN 1 ELSE 0 END) newLeads,
                  SUM(CASE WHEN datetime(l.created_at)<datetime(?) THEN 1 ELSE 0 END) stillFresh
           FROM qualification_checks q JOIN leads l ON l.source_scan_target_id=q.scan_target_id AND l.tenant_id=q.tenant_id AND l.lead_tag='fresh_fiber_confirmed'
           WHERE q.job_id=?`,
        ).get(startedAt, startedAt, job.id) as any;
        return {
          comingSoonCount: Number(coming?.n ?? 0),
          serviceActiveCount: Number(active?.n ?? 0),
          newLeadsCount: Number(fresh?.newLeads ?? 0),
          stillFreshCount: Number(fresh?.stillFresh ?? 0),
        };
      })()
    : { comingSoonCount: 0, serviceActiveCount: 0, newLeadsCount: 0, stillFreshCount: 0 };
  return {
    id: job.id,
    organizationId: job.tenantId,
    userId: job.createdBy,
    city: job.townName,
    state: job.state,
    geometry: job.areaJson ? JSON.parse(job.areaJson) : null,
    status: activeStatus,
    phase: job.phase,
    idempotencyKey: job.idempotencyKey,
    discoveredCount: job.addressesObserved + job.addressesInferred,
    uniqueCandidateCount: job.addressesObserved,
    validatedCount: job.addressesQualified,
    checkedCount: includeDiagnostics
      ? job.qualificationChecked
      : job.qualificationChecked + job.qualificationFailed + job.failedTiles,
    qualifiedCount: job.freshFound,
    newLeadsCount: t.newLeadsCount,
    stillFreshCount: t.stillFreshCount,
    serviceActiveCount: t.serviceActiveCount,
    comingSoonCount: t.comingSoonCount,
    failedCount: includeDiagnostics ? job.qualificationFailed + job.failedTiles : 0,
    cachedCount: job.cacheHits,
    noServiceCount: includeDiagnostics ? job.noServiceFound : 0,
    totalTiles: job.totalTiles,
    completedTiles: job.completedTiles,
    partialTiles: job.partialTiles,
    failedTiles: job.failedTiles,
    handoffCollisions: job.handoffCollisions,
    coverageStatus: coverageStatus(job),
    sourceWarnings: includeDiagnostics ? warnings : [],
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    cancelledAt: job.status === "cancelled" ? job.completedAt : null,
    error: includeDiagnostics ? job.errorSummary : null,
  };
}

function repEventPayload(eventType: string, payload: Record<string, any>): Record<string, unknown> {
  if (eventType !== "lead.published") return {};
  const lead = payload.lead && typeof payload.lead === "object" ? payload.lead : undefined;
  const feature = payload.feature?.type === "Feature" ? payload.feature : undefined;
  return { ...(lead ? { lead } : {}), ...(feature ? { feature } : {}) };
}

function parseAfter(req: Request, tid: number, createdBy?: number): number {
  const supplied = req.headers["last-event-id"] ?? req.query.after;
  if (supplied == null) {
    const where =
      createdBy == null ? "e.tenant_id=?" : "e.tenant_id=? AND j.created_by=?";
    const args = createdBy == null ? [tid] : [tid, createdBy];
    const row = rawDb
      .prepare(
        `SELECT COALESCE(MAX(e.sequence),0) AS sequence FROM discovery_events e
      JOIN discovery_jobs j ON j.id=e.job_id WHERE ${where}`,
      )
      .get(...args) as any;
    return Number(row?.sequence || 0);
  }
  const value = Number(supplied);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function registerAddressDiscoveryRoutes(
  app: Express,
  deps: DiscoveryRouteDeps,
): void {
  app.post(
    "/api/discovery/jobs",
    deps.requireCapability("scan.submit"),
    deps.requireScanningAllowed,
    (req, res) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success)
        return res
          .status(400)
          .json({
            error: "Invalid discovery request",
            details: parsed.error.flatten(),
          });
      const tid = tenantId(req);
      if (!tid)
        return res
          .status(403)
          .json({ error: "Organization membership required" });
      try {
        const idempotencyKey =
          parsed.data.idempotencyKey ||
          String(req.headers["idempotency-key"] ?? "") ||
          crypto.randomUUID();
        if (idempotencyKey.length < 8 || idempotencyKey.length > 200)
          return res.status(400).json({ error: "Invalid idempotency key" });
        const knownSources = new Set(
          allSourceMetadata().map((source) => source.id),
        );
        if (parsed.data.sources?.some((source) => !knownSources.has(source)))
          return res
            .status(400)
            .json({ error: "Unknown address source requested" });
        const geometry = parsed.data.geometry
          ? validateDiscoveryGeometry(parsed.data.geometry, {
              maxAreaKm2: Math.max(
                1,
                Number(process.env.DISCOVERY_MAX_AREA_KM2) || 10_000,
              ),
              maxVertices: Math.max(
                1_000,
                Number(process.env.DISCOVERY_MAX_BOUNDARY_VERTICES) || 50_000,
              ),
            })
          : null;
        const state = parsed.data.state?.toUpperCase() ?? "US";
        const townName =
          parsed.data.town ?? parsed.data.townName ?? parsed.data.city ?? null;
        // Snapshot every currently usable adapter, including newly introduced
        // sources that do not have a persisted health row yet. Building this
        // from address_source_health alone made a fresh Mapbox/OSM install
        // create jobs with an empty source list until an administrator first
        // saved the source settings.
        const storedSourcePriority = new Map(
          sourceHealth(tid).map((source: any) => [
            String(source.sourceId),
            Number(source.priority),
          ]),
        );
        const sourceSnapshot = addressSources(tid)
          .map((source) => ({
            sourceId: source.metadata.id,
            priority:
              storedSourcePriority.get(source.metadata.id) ??
              source.metadata.defaultPriority,
          }))
          .sort(
            (a: any, b: any) =>
              a.priority - b.priority || a.sourceId.localeCompare(b.sourceId),
          );
        const requestHash = crypto
          .createHash("sha256")
          .update(
            JSON.stringify({
              geometry,
              townName,
              state,
              sources: parsed.data.sources ?? null,
              sourceSnapshot,
            }),
          )
          .digest("hex");
        const result = createDiscoveryJob({
          tenantId: tid,
          idempotencyKey,
          requestHash,
          geometry,
          bbox: geometry ? geometryBbox(geometry) : null,
          townName,
          state,
          createdBy: Number((req as any).user.id),
          sourceConfig: {
            requestedSources: parsed.data.sources ?? null,
            sourceSnapshot,
            rescan: parsed.data.rescan === true,
          },
        });
        if (
          geometry &&
          result.job.phase === "discovery" &&
          !result.replayed &&
          result.job.totalTiles === 0
        ) {
          const tiles = planDiscoveryTiles(geometry, {
            targetTileAreaKm2: Math.max(
              0.05,
              Number(process.env.DISCOVERY_TILE_AREA_KM2) || 5,
            ),
            maxTiles: Math.max(
              1,
              Number(process.env.DISCOVERY_MAX_TILES) || 2_048,
            ),
          });
          persistTiles(
            result.job.id,
            tiles.map((tile) => ({
              key: tile.id,
              bbox: tile.bbox,
              geometry: bboxPolygon(tile.bbox),
            })),
          );
        }
        const job = getDiscoveryJob(tid, result.job.id)!;
        storage.logActivity(
          Number((req as any).user.id),
          result.replayed ? "discovery.job_replayed" : "discovery.job_created",
          "discovery_job",
          undefined,
          {
            jobId: job.id,
            geometryType: geometry?.type ?? null,
            town: job.townName,
          },
          req.ip,
          tid,
        );
        wakeDiscoveryWorkers();
        res
          .status(202)
          .json({ job: publicJob(job, canManage(req)), replayed: result.replayed });
      } catch (error: any) {
        const message = String(error?.message ?? error).slice(0, 300);
        res
          .status(message.startsWith("IDEMPOTENCY_") ? 409 : 400)
          .json({ error: message.replace(/^[A-Z_]+:\s*/, "") });
      }
    },
  );

  app.get(
    "/api/discovery/jobs",
    deps.requireCapability("scan.submit"),
    (req, res) => {
      const tid = tenantId(req);
      if (!tid)
        return res
          .status(403)
          .json({ error: "Organization membership required" });
      const active = req.query.active === "true";
      const jobs = listDiscoveryJobs(tid, {
        createdBy: canManage(req) ? undefined : Number((req as any).user.id),
        activeOnly: active,
        limit: Number(req.query.limit) || 50,
      });
      res.json({ jobs: jobs.map((job) => publicJob(job, canManage(req))) });
    },
  );

  app.get(
    "/api/discovery/jobs/:id",
    deps.requireCapability("scan.submit"),
    (req, res) => {
      const tid = tenantId(req);
      if (!tid)
        return res
          .status(403)
          .json({ error: "Organization membership required" });
      const job = getDiscoveryJob(tid, param(req, "id"));
      if (!job || !allowedJob(req, job))
        return res.status(404).json({ error: "Not found" });
      res.json({ job: publicJob(job, canManage(req)) });
    },
  );

  app.post(
    "/api/discovery/jobs/:id/cancel",
    deps.requireCapability("scan.submit"),
    (req, res) => {
      const tid = tenantId(req);
      if (!tid)
        return res
          .status(403)
          .json({ error: "Organization membership required" });
      const job = getDiscoveryJob(tid, param(req, "id"));
      if (!job || !allowedJob(req, job))
        return res.status(404).json({ error: "Not found" });
      if (
        !cancelDiscoveryJob(tid, job.id) &&
        !["cancelled", "completed", "partial", "failed"].includes(job.status)
      ) {
        return res.status(409).json({ error: "Job could not be cancelled" });
      }
      storage.logActivity(
        Number((req as any).user.id),
        "discovery.job_cancelled",
        "discovery_job",
        undefined,
        { jobId: job.id },
        req.ip,
        tid,
      );
      res.json({ job: publicJob(getDiscoveryJob(tid, job.id)!, canManage(req)) });
    },
  );

  app.post(
    "/api/discovery/jobs/:id/retry",
    deps.requireCapability("scan.manage"),
    (req, res) => {
      const parsed = retrySchema.safeParse(req.body ?? {});
      if (!parsed.success)
        return res.status(400).json({ error: "Invalid retry request" });
      const tid = tenantId(req);
      if (!tid)
        return res
          .status(403)
          .json({ error: "Organization membership required" });
      const jobId = param(req, "id");
      const changed = retryDiscoveryTiles(tid, jobId, parsed.data.tileIds);
      if (!getDiscoveryJob(tid, jobId))
        return res.status(404).json({ error: "Not found" });
      wakeDiscoveryWorkers();
      res.json({
        retried: changed,
        job: publicJob(getDiscoveryJob(tid, jobId)!, true),
      });
    },
  );

  app.get(
    "/api/discovery/jobs/:id/coverage",
    deps.requireCapability("scan.submit"),
    (req, res) => {
      const tid = tenantId(req);
      if (!tid)
        return res
          .status(403)
          .json({ error: "Organization membership required" });
      const job = getDiscoveryJob(tid, param(req, "id"));
      if (!job || !allowedJob(req, job))
        return res.status(404).json({ error: "Not found" });
      res.json(getCoverageGeoJson(tid, job.id));
    },
  );

  app.get(
    "/api/discovery/addresses/:id",
    deps.requireCapability("scan.manage"),
    (req, res) => {
      const id = Number(param(req, "id"));
      const tid = tenantId(req);
      if (!tid || !Number.isSafeInteger(id) || id < 1)
        return res.status(400).json({ error: "Invalid address id" });
      const explanation = getAddressExplanation(tid, id);
      if (!explanation) return res.status(404).json({ error: "Not found" });
      res.json(explanation);
    },
  );

  app.get(
    "/api/discovery/sources",
    deps.requireCapability("scan.manage"),
    async (req, res) => {
      const tid = tenantId(req);
      if (!tid)
        return res
          .status(403)
          .json({ error: "Organization membership required" });
      const health = new Map(
        sourceHealth(tid).map((row) => [row.sourceId, row]),
      );
      const sources = await Promise.all(
        allSourceMetadata().map(async (metadata) => {
          const adapter = sourceById(metadata.id)!;
          const stored = health.get(metadata.id) as any;
          const live = await adapter
            .healthCheck(tid)
            .catch((error: any) => ({
              ok: false,
              message: String(error?.message ?? error),
            }));
          return {
            ...metadata,
            ...stored,
            enabled: stored?.enabled !== 0,
            priority: stored?.priority ?? metadata.defaultPriority,
            available: adapter.available(tid),
            healthStatus: live.ok
              ? (stored?.healthStatus ?? "healthy")
              : "unavailable",
            healthMessage: live.message ?? stored?.lastError ?? null,
          };
        }),
      );
      res.json({ sources });
    },
  );

  app.patch(
    "/api/discovery/sources/:id",
    deps.requireCapability("scan.manage"),
    (req, res) => {
      const parsed = sourcePatchSchema.safeParse(req.body);
      const sourceId = param(req, "id");
      if (!parsed.success || !sourceById(sourceId))
        return res.status(400).json({ error: "Invalid source configuration" });
      const tid = tenantId(req);
      if (!tid)
        return res
          .status(403)
          .json({ error: "Organization membership required" });
      configureSource(tid, sourceId, parsed.data.enabled, parsed.data.priority);
      storage.logActivity(
        Number((req as any).user.id),
        "discovery.source_configured",
        "address_source",
        undefined,
        { sourceId, ...parsed.data },
        req.ip,
        tid,
      );
      res.json({ sourceId, ...parsed.data });
    },
  );

  app.post(
    "/api/discovery/uploads",
    deps.requireCapability("scan.manage"),
    (req, res) => {
      const parsed = uploadSchema.safeParse(req.body);
      if (!parsed.success)
        return res
          .status(400)
          .json({
            error: "Invalid address upload",
            details: parsed.error.flatten(),
          });
      const tid = tenantId(req);
      if (!tid)
        return res
          .status(403)
          .json({ error: "Organization membership required" });
      try {
        const content = parsed.data.content;
        const maxBytes = Math.max(
          64 * 1024,
          Math.min(
            10 * 1024 * 1024,
            Number(process.env.DISCOVERY_UPLOAD_MAX_BYTES) || 10 * 1024 * 1024,
          ),
        );
        if (Buffer.byteLength(content, "utf8") > maxBytes)
          return res
            .status(413)
            .json({ error: "Upload exceeds configured size limit" });
        const records = parseUploadedPayload(parsed.data.format, content);
        const contentHash = crypto
          .createHash("sha256")
          .update(content)
          .digest("hex");
        const existing = rawDb
          .prepare(
            `SELECT id,record_count AS recordCount,rejected_count AS rejectedCount,created_at AS createdAt
        FROM address_source_uploads WHERE tenant_id=? AND content_hash=?`,
          )
          .get(tid, contentHash) as any;
        if (existing)
          return res.status(200).json({ upload: existing, replayed: true });
        const actorRole = String((req as any).user?.role ?? "");
        const authoritativeAllowed =
          parsed.data.authoritative &&
          ["admin", "super_admin"].includes(actorRole) &&
          /(?:government|public domain|e911|county|municipal|state)/i.test(
            parsed.data.licenseName ?? "",
          );
        if (parsed.data.authoritative && !authoritativeAllowed) {
          return res
            .status(400)
            .json({
              error:
                "Authoritative uploads require an explicit local-government, E911, or public-domain license",
            });
        }
        const uploadId = crypto.randomUUID();
        const sourceId = authoritativeAllowed
          ? "local_gis_upload"
          : "manual_upload";
        let accepted = 0,
          rejected = 0;
        rawDb.transaction(() => {
          rawDb
            .prepare(
              `INSERT INTO address_source_uploads
          (id,tenant_id,source_id,filename,format,content_hash,license_name,license_url,authoritative,record_count,rejected_count,created_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              uploadId,
              tid,
              sourceId,
              parsed.data.filename,
              parsed.data.format,
              contentHash,
              parsed.data.licenseName ?? null,
              parsed.data.licenseUrl ?? null,
              authoritativeAllowed ? 1 : 0,
              0,
              0,
              Number((req as any).user.id),
            );
          const insert =
            rawDb.prepare(`INSERT OR IGNORE INTO uploaded_address_records
          (id,upload_id,tenant_id,source_id,source_record_id,authoritative,full_address,city,state,postal_code,lat,lng,raw_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
          for (const record of records) {
            if (
              !record.fullAddress ||
              record.lat == null ||
              record.lng == null ||
              !Number.isFinite(record.lat) ||
              !Number.isFinite(record.lng)
            ) {
              rejected++;
              continue;
            }
            accepted += insert.run(
              crypto.randomUUID(),
              uploadId,
              tid,
              sourceId,
              record.sourceRecordId,
              authoritativeAllowed ? 1 : 0,
              record.fullAddress,
              record.city ?? null,
              record.state ?? null,
              record.postalCode ?? null,
              record.lat,
              record.lng,
              JSON.stringify(record.raw),
            ).changes;
          }
          rawDb
            .prepare(
              `UPDATE address_source_uploads SET record_count=?,rejected_count=? WHERE id=?`,
            )
            .run(accepted, rejected, uploadId);
        })();
        storage.logActivity(
          Number((req as any).user.id),
          "discovery.addresses_uploaded",
          "address_source_upload",
          undefined,
          {
            uploadId,
            filename: parsed.data.filename,
            accepted,
            rejected,
            authoritative: authoritativeAllowed,
          },
          req.ip,
          tid,
        );
        res
          .status(201)
          .json({
            upload: {
              id: uploadId,
              filename: parsed.data.filename,
              sourceId,
              recordCount: accepted,
              rejectedCount: rejected,
              authoritative: authoritativeAllowed,
            },
            replayed: false,
          });
      } catch (error: any) {
        res
          .status(400)
          .json({ error: String(error?.message ?? error).slice(0, 300) });
      }
    },
  );

  const stream = (req: Request, res: Response, jobId?: string) => {
    const tid = tenantId(req);
    if (!tid)
      return res
        .status(403)
        .json({ error: "Organization membership required" });
    if (jobId) {
      const job = getDiscoveryJob(tid, jobId);
      if (!job || !allowedJob(req, job))
        return res.status(404).json({ error: "Not found" });
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const creatorScope = canManage(req)
      ? undefined
      : Number((req as any).user.id);
    let after = parseAfter(req, tid, creatorScope);
    const pump = () => {
      const events = readDiscoveryEvents({
        tenantId: tid,
        after,
        jobId,
        createdBy: creatorScope,
        limit: 200,
      });
      for (const event of events) {
        after = event.sequence;
        const job = getDiscoveryJob(tid, event.jobId);
        if (!job) continue;
        const diagnostics = canManage(req);
        const eventPayload = diagnostics
          ? (event.payload ?? {})
          : repEventPayload(event.eventType, event.payload ?? {});
        const payload = {
          ...eventPayload,
          job: publicJob(job, diagnostics),
        };
        res.write(
          `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(
            {
              id: event.sequence,
              eventType: event.eventType,
              jobId: event.jobId,
              payload,
            },
          )}\n\n`,
        );
      }
      if (!events.length) res.write(`: keepalive ${Date.now()}\n\n`);
      (res as any).flush?.();
    };
    pump();
    const timer = setInterval(pump, 1_000);
    req.on("close", () => clearInterval(timer));
  };

  app.get(
    "/api/discovery/events",
    deps.requireCapability("scan.submit"),
    (req, res) => stream(req, res),
  );
  app.get(
    "/api/discovery/jobs/:id/events",
    deps.requireCapability("scan.submit"),
    (req, res) => stream(req, res, param(req, "id")),
  );
}
