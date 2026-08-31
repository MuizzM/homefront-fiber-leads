import type { Express, Request, Response } from "express";
import type { Middleware } from "./middlewareTypes";
import { z } from "zod";
import type { Capability } from "@shared/capabilities";
import { rawDb } from "./db";
import { getDefaultTenantId, storage } from "./storage";
import { traceLeadNow } from "./calling/leadTracing";
import {
  getKineticEvidenceGateway,
  kineticEvidenceModes,
  kineticPostalAddressSchema,
} from "./kineticProviderAdapter";
import {
  ingestApprovedImport,
  ingestManualVerification,
  importEnvelopeSchema,
  manualVerificationSchema,
} from "./kineticEvidenceIngest";
import {
  clearKineticData,
  ensureKineticScannerSchema,
  evidenceConfiguration,
  scannerState,
  setEvidenceConfiguration,
  stats,
  upsertKineticAddress,
} from "./kineticScannerStore";
import {
  pauseKineticScan,
  resumeKineticScan,
  resumeKineticWorkersAfterRestart,
  startKineticJobPoller,
  startKineticRecheck,
  startKineticScan,
  stopKineticWorker,
} from "./kineticScannerWorkers";

// SEC-B: export caps — a full-tenant CSV used to be built unbounded in one
// string. 50k rows covers every realistic tenant; the header/trailer note
// tells the operator when the export was cut.
export const KINETIC_EXPORT_MAX_ROWS = 50_000;
export const KINETIC_EXPORT_CHUNK = 5_000;

interface Deps {
  requireCapability: (capability: Capability) => Middleware;
  requireScanningAllowed: Middleware;
  scanAdmission: Middleware;
}
const KINETIC_STATES = [
  "AL",
  "AR",
  "FL",
  "GA",
  "IA",
  "KY",
  "MN",
  "MS",
  "MO",
  "NE",
  "NM",
  "NY",
  "NC",
  "OH",
  "OK",
  "PA",
  "SC",
  "TX",
] as const;
const evidenceConfigSchema = z
  .object({
    mode: z.enum(kineticEvidenceModes),
    sourceName: z.string().trim().min(2).max(100).nullable().optional(),
    contractVersion: z.string().trim().min(1).max(80).nullable().optional(),
    publicUseConfirmed: z.boolean().default(false),
  })
  .strict();
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  search: z.string().trim().max(160).optional(),
  state: z.enum(KINETIC_STATES).optional(),
  discoveryState: z
    .enum([
      "BASELINE_FIBER",
      "NON_FIBER",
      "CANDIDATE_FRESH",
      "VERIFIED_FRESH",
      "REGRESSED",
      "SOURCE_ERROR",
    ])
    .optional(),
  liveOnly: z.enum(["true", "false"]).optional(),
  comingSoonOnly: z.enum(["true", "false"]).optional(),
  copperUpgradeCandidateOnly: z.enum(["true", "false"]).optional(),
});
const idSchema = z.coerce.number().int().positive();
function tenant(req: Request): number | null {
  const n = Number((req as any).user?.tenantId ?? getDefaultTenantId());
  return Number.isInteger(n) && n > 0 ? n : null;
}
function actor(req: Request): number | null {
  const n = Number((req as any).user?.id);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function requireTenant(req: Request, res: Response): number | null {
  const id = tenant(req);
  if (!id) res.status(403).json({ error: "Organization required" });
  return id;
}
function addressRow(tenantId: number, id: number): any {
  return rawDb
    .prepare(
      `SELECT a.id,a.kinetic_address_id AS kineticAddressId,a.sequential_id AS sequentialId,a.address,a.city,a.state,a.zip,a.latitude,a.longitude,
  exchange_id AS exchangeId,technology_type AS technologyType,maximum_qualification AS maximumQualification,estimated_completion_date AS estimatedCompletionDate,
  is_live AS isLive,is_coming_soon AS isComingSoon,is_copper_upgrade_candidate AS isCopperUpgradeCandidate,lead_id AS leadId,
  contact_enrichment_status AS contactEnrichmentStatus,first_seen_at AS firstSeenAt,last_checked_at AS lastChecked,last_status_change_at AS lastStatusChange,
  s.canonical_state AS canonicalState,s.discovery_state AS discoveryState,s.confirmation_count AS confirmationCount,s.last_non_fiber_at AS lastNonFiberAt,s.candidate_first_seen_at AS candidateFirstSeenAt,s.verified_at AS verifiedAt,s.model_version AS modelVersion
  FROM kinetic_addresses a LEFT JOIN kinetic_address_state s ON s.address_id=a.id WHERE a.tenant_id=? AND a.id=?`,
    )
    .get(tenantId, id);
}
function csvCell(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function registerKineticScannerRoutes(app: Express, deps: Deps): void {
  ensureKineticScannerSchema();
  // Both are inert in a process that does not consume scan runs (an HTTP
  // worker under the cluster): the resume only re-drives interrupted jobs
  // where they run, and the poller starts the jobs HTTP workers enqueue.
  resumeKineticWorkersAfterRestart();
  startKineticJobPoller();
  const read = deps.requireCapability("scan.manage"),
    manage = deps.requireCapability("scan.manage");
  app.get("/api/kinetic-scanner/ping", read, async (req, res) => {
    const gateway = getKineticEvidenceGateway(),
      result = await gateway.healthCheck(),
      tid = tenant(req);
    if (tid)
      rawDb
        .prepare(
          `INSERT INTO kinetic_provider_health (tenant_id,provider_name,ok,latency_ms,message) VALUES (?,?,?,?,?)`,
        )
        .run(
          tid,
          gateway.status().source,
          result.ok ? 1 : 0,
          result.latencyMs,
          result.message,
        );
    res.json({ ...result, ...gateway.status() });
  });
  app.get("/api/kinetic-scanner/evidence/config", read, (req, res) => {
    const tid = requireTenant(req, res);
    if (!tid) return;
    res.json({
      configured: evidenceConfiguration(tid),
      runtime: getKineticEvidenceGateway().status(),
    });
  });
  app.put("/api/kinetic-scanner/evidence/config", manage, (req, res) => {
    const tid = requireTenant(req, res);
    if (!tid) return;
    const parsed = evidenceConfigSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({
        error: "Invalid evidence configuration",
        issues: parsed.error.flatten(),
      });
    if (
      parsed.data.mode === "authorized_public_lookup" &&
      !parsed.data.publicUseConfirmed
    )
      return res.status(400).json({
        error:
          "Administrator confirmation of permitted public automation is required",
      });
    const configured = setEvidenceConfiguration({
      tenantId: tid,
      ...parsed.data,
      actorId: actor(req),
    });
    storage.logActivity(
      actor(req),
      "kinetic.evidence_mode.updated",
      "kinetic_scanner",
      undefined,
      {
        mode: configured.mode,
        sourceName: configured.sourceName,
        publicUseConfirmed: Boolean(configured.publicUseConfirmed),
      },
      req.ip,
    );
    res.json({ configured, runtime: getKineticEvidenceGateway().status() });
  });
  app.get("/api/kinetic-scanner/state", read, (req, res) => {
    const tid = requireTenant(req, res);
    if (tid) {
      const state = scannerState(tid),
        memory = process.memoryUsage(),
        worker = state.recheckWorker;
      const elapsed = worker?.startedAt
        ? Math.max(
            1,
            (Date.now() - new Date(worker.startedAt).getTime()) / 1000,
          )
        : 1;
      res.json({
        ...state,
        recheckChecked: Number(state.recheckWorker?.checked ?? 0),
        checksPerSecond: Number(((worker?.checked ?? 0) / elapsed).toFixed(2)),
        memory: {
          heapUsedMb: Math.round(memory.heapUsed / 1048576),
          rssMb: Math.round(memory.rss / 1048576),
        },
      });
    }
  });
  app.get("/api/kinetic-scanner/stats", read, (req, res) => {
    const tid = requireTenant(req, res);
    if (tid) res.json(stats(tid));
  });
  app.post(
    "/api/kinetic-scanner/evidence/qualify",
    manage,
    deps.requireScanningAllowed,
    deps.scanAdmission,
    async (req, res) => {
      const tid = requireTenant(req, res);
      if (!tid) return;
      const parsed = kineticPostalAddressSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({
          error: "Invalid postal address",
          issues: parsed.error.flatten(),
        });
      const configured = evidenceConfiguration(tid),
        gateway = getKineticEvidenceGateway();
      if (
        !["approved_api", "authorized_public_lookup"].includes(
          configured.mode,
        ) ||
        gateway.status().mode !== configured.mode
      )
        return res.status(409).json({
          error: "No matching permitted live evidence adapter is registered",
          configuredMode: configured.mode,
          runtimeMode: gateway.status().mode,
        });
      if (
        configured.mode === "authorized_public_lookup" &&
        !configured.publicUseConfirmed
      )
        return res.status(409).json({
          error:
            "Permitted public automation has not been confirmed by an administrator",
        });
      try {
        const result = await gateway.qualifyAddress(parsed.data);
        if (result.outcome !== "ok" || !result.record)
          return res.status(result.outcome === "not_found" ? 404 : 503).json({
            outcome: result.outcome,
            message: result.message ?? "No conclusive availability evidence",
          });
        const stored = upsertKineticAddress(tid, null, result.record);
        storage.logActivity(
          actor(req),
          "kinetic.evidence.qualified",
          "kinetic_scanner",
          undefined,
          {
            addressId: stored.id,
            source: result.record.evidenceSource,
            mode: result.record.evidenceMode,
          },
          req.ip,
        );
        res.json({
          addressId: stored.id,
          discoveryState: stored.discoveryState,
          fresh: stored.fresh,
        });
      } catch (error) {
        res.status(503).json({
          error: error instanceof Error ? error.message : String(error),
          circuit: gateway.status(),
        });
      }
    },
  );
  app.post("/api/kinetic-scanner/imports", manage, (req, res) => {
    const tid = requireTenant(req, res);
    if (!tid) return;
    const parsed = importEnvelopeSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({
        error: "Invalid approved import",
        issues: parsed.error.flatten(),
      });
    try {
      const summary = ingestApprovedImport({
        tenantId: tid,
        actorId: actor(req),
        payload: parsed.data,
      });
      storage.logActivity(
        actor(req),
        "kinetic.import.completed",
        "kinetic_import_batch",
        undefined,
        summary,
        req.ip,
      );
      res.status(201).json(summary);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/kinetic-scanner/imports/webhook", manage, (req, res) => {
    const tid = requireTenant(req, res);
    if (!tid) return;
    const body = z
      .object({
        sourceName: z.string().trim().min(2).max(100),
        records: z.array(z.unknown()).min(1).max(10000),
      })
      .strict()
      .safeParse(req.body);
    if (!body.success)
      return res.status(400).json({
        error: "Invalid approved webhook import",
        issues: body.error.flatten(),
      });
    try {
      res.status(202).json(
        ingestApprovedImport({
          tenantId: tid,
          actorId: actor(req),
          payload: {
            format: "json",
            sourceName: body.data.sourceName,
            records: body.data.records,
            parserVersion: "kinetic-import-v1",
          },
        }),
      );
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post("/api/kinetic-scanner/manual-verifications", manage, (req, res) => {
    const tid = requireTenant(req, res),
      userId = actor(req);
    if (!tid) return;
    if (!userId)
      return res.status(403).json({ error: "Authenticated reviewer required" });
    const parsed = manualVerificationSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({
        error: "Invalid manual verification",
        issues: parsed.error.flatten(),
      });
    try {
      const result = ingestManualVerification({
        tenantId: tid,
        actorId: userId,
        payload: parsed.data,
      });
      storage.logActivity(
        userId,
        "kinetic.manual_verification.recorded",
        "kinetic_address",
        result.addressId,
        { batchId: result.batchId, discoveryState: result.discoveryState },
        req.ip,
      );
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.get("/api/kinetic-scanner/imports", read, (req, res) => {
    const tid = requireTenant(req, res);
    if (!tid) return;
    res.json({
      items: rawDb
        .prepare(
          `SELECT id,mode,source_name AS sourceName,format,parser_version AS parserVersion,record_count AS recordCount,accepted_count AS acceptedCount,rejected_count AS rejectedCount,created_at AS createdAt,completed_at AS completedAt FROM kinetic_import_batches WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100`,
        )
        .all(tid),
    });
  });

  app.post("/api/kinetic-scanner/start-scan", manage, (_req, res) => {
    try {
      startKineticScan();
    } catch (error) {
      res.status(409).json({
        error: error instanceof Error ? error.message : String(error),
        mode: "offline",
      });
    }
  });
  app.post("/api/kinetic-scanner/stop-scan", manage, (req, res) => {
    const tid = requireTenant(req, res);
    if (tid) res.json({ ok: stopKineticWorker(tid, "scan") });
  });
  app.post("/api/kinetic-scanner/pause-scan", manage, (req, res) => {
    const tid = requireTenant(req, res);
    if (tid) res.json({ ok: pauseKineticScan() });
  });
  app.post("/api/kinetic-scanner/resume-scan", manage, (req, res) => {
    const tid = requireTenant(req, res);
    if (tid) res.json({ ok: resumeKineticScan() });
  });
  app.post(
    "/api/kinetic-scanner/start-recheck",
    manage,
    deps.requireScanningAllowed,
    deps.scanAdmission,
    (req, res) => {
      const tid = requireTenant(req, res);
      if (!tid) return;
      try {
        const jobId = startKineticRecheck({
          tenantId: tid,
          createdBy: actor(req),
        });
        storage.logActivity(
          actor(req),
          "kinetic.recheck.started",
          "kinetic_scan_job",
          undefined,
          { jobId },
          req.ip,
        );
        res.status(202).json({ jobId });
      } catch (error) {
        res.status(409).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
  app.post("/api/kinetic-scanner/stop-recheck", manage, (req, res) => {
    const tid = requireTenant(req, res);
    if (tid) res.json({ ok: stopKineticWorker(tid, "recheck") });
  });

  app.get("/api/kinetic-scanner/addresses", read, (req, res) => {
    const tid = requireTenant(req, res);
    if (!tid) return;
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "Invalid filters", issues: parsed.error.flatten() });
    const q = parsed.data,
      where = ["a.tenant_id=?"],
      args: unknown[] = [tid];
    if (q.search) {
      where.push(
        "(lower(COALESCE(a.address,'')) LIKE lower(?) OR lower(COALESCE(a.city,'')) LIKE lower(?) OR a.zip LIKE ? OR lower(COALESCE(a.kinetic_address_id,'')) LIKE lower(?) OR CAST(a.sequential_id AS TEXT) LIKE ?)",
      );
      const term = `%${q.search}%`;
      args.push(term, term, term, term, term);
    }
    if (q.state) {
      where.push("a.state=?");
      args.push(q.state);
    }
    if (q.discoveryState) {
      where.push("s.discovery_state=?");
      args.push(q.discoveryState);
    }
    if (q.liveOnly === "true") where.push("a.is_live=1");
    if (q.comingSoonOnly === "true") where.push("a.is_coming_soon=1");
    if (q.copperUpgradeCandidateOnly === "true")
      where.push("a.is_copper_upgrade_candidate=1");
    const clause = where.join(" AND "),
      from =
        "kinetic_addresses a LEFT JOIN kinetic_address_state s ON s.address_id=a.id",
      total = Number(
        (
          rawDb
            .prepare(`SELECT COUNT(*) count FROM ${from} WHERE ${clause}`)
            .get(...args) as any
        )?.count ?? 0,
      ),
      offset = (q.page - 1) * q.limit;
    const items = rawDb
      .prepare(
        `SELECT a.id,kinetic_address_id AS kineticAddressId,sequential_id AS sequentialId,address,city,state,zip,latitude,longitude,exchange_id AS exchangeId,
    technology_type AS technologyType,maximum_qualification AS maximumQualification,estimated_completion_date AS estimatedCompletionDate,is_live AS isLive,is_coming_soon AS isComingSoon,
    is_copper_upgrade_candidate AS isCopperUpgradeCandidate,lead_id AS leadId,contact_enrichment_status AS contactEnrichmentStatus,last_checked_at AS lastChecked,last_status_change_at AS lastStatusChange,
    s.canonical_state AS canonicalState,s.discovery_state AS discoveryState,s.confirmation_count AS confirmationCount,s.verified_at AS verifiedAt
    FROM ${from} WHERE ${clause} ORDER BY a.last_checked_at DESC,a.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, q.limit, offset);
    res.json({
      items,
      page: q.page,
      limit: q.limit,
      total,
      pages: Math.max(1, Math.ceil(total / q.limit)),
    });
  });

  app.get("/api/kinetic-scanner/addresses/map", read, (req, res) => {
    const tid = requireTenant(req, res);
    if (!tid) return;
    const rows = rawDb
      .prepare(
        `SELECT a.id,a.latitude,a.longitude,a.is_live AS isLive,a.is_coming_soon AS isComingSoon,a.is_copper_upgrade_candidate AS isCopperUpgradeCandidate,a.address,a.city,a.state,s.discovery_state AS discoveryState FROM kinetic_addresses a LEFT JOIN kinetic_address_state s ON s.address_id=a.id WHERE a.tenant_id=? AND a.latitude IS NOT NULL AND a.longitude IS NOT NULL ORDER BY a.last_checked_at DESC LIMIT 10000`,
      )
      .all(tid) as any[];
    res.setHeader(
      "Cache-Control",
      "private, max-age=2, stale-while-revalidate=5",
    );
    res.json({
      type: "FeatureCollection",
      features: rows.map((row) => ({
        type: "Feature",
        id: row.id,
        geometry: { type: "Point", coordinates: [row.longitude, row.latitude] },
        properties: {
          id: row.id,
          address: row.address,
          city: row.city,
          state: row.state,
          isLive: row.isLive,
          isComingSoon: row.isComingSoon,
          isCopperUpgradeCandidate: row.isCopperUpgradeCandidate,
          discoveryState: row.discoveryState,
        },
      })),
    });
  });
  app.get("/api/kinetic-scanner/addresses/:id", read, (req, res) => {
    const tid = requireTenant(req, res),
      id = idSchema.safeParse(req.params.id);
    if (!tid) return;
    if (!id.success)
      return res.status(400).json({ error: "Invalid address id" });
    const address = addressRow(tid, id.data);
    if (!address) return res.status(404).json({ error: "Address not found" });
    const observations = rawDb
      .prepare(
        `SELECT id,response_hash AS responseHash,observed_at AS observedAt FROM kinetic_address_observations WHERE tenant_id=? AND address_id=? ORDER BY observed_at DESC LIMIT 100`,
      )
      .all(tid, id.data);
    const evidence = rawDb
      .prepare(
        `SELECT id,evidence_mode AS evidenceMode,source_name AS sourceName,evidence_id AS evidenceId,observed_at AS observedAt,parser_version AS parserVersion,response_hash AS responseHash,created_at AS ingestedAt FROM kinetic_evidence_records WHERE tenant_id=? AND address_id=? ORDER BY observed_at DESC,id DESC LIMIT 100`,
      )
      .all(tid, id.data);
    const changes = rawDb
      .prepare(
        `SELECT id,field_name AS fieldName,previous_value AS previousValue,current_value AS currentValue,observed_at AS observedAt FROM kinetic_address_changes WHERE tenant_id=? AND address_id=? ORDER BY observed_at DESC`,
      )
      .all(tid, id.data);
    const episodes = rawDb
      .prepare(
        `SELECT id,episode_sequence AS episodeSequence,status,detection_from AS detectionFrom,detection_to AS detectionTo,confirmation_count AS confirmationCount,model_version AS modelVersion,candidate_at AS candidateAt,verified_at AS verifiedAt,regressed_at AS regressedAt FROM kinetic_transition_episodes WHERE tenant_id=? AND address_id=? ORDER BY episode_sequence DESC`,
      )
      .all(tid, id.data);
    res.json({ address, evidence, observations, changes, episodes });
  });
  app.get("/api/kinetic-scanner/addresses/:id/contacts", read, (req, res) => {
    const tid = requireTenant(req, res),
      id = idSchema.safeParse(req.params.id);
    if (!tid) return;
    if (!id.success)
      return res.status(400).json({ error: "Invalid address id" });
    const contacts = rawDb
      .prepare(
        `SELECT id,name,phone_last4 AS phoneLast4,provider,confidence,refreshed_at AS refreshedAt FROM kinetic_address_contacts WHERE tenant_id=? AND address_id=? ORDER BY refreshed_at DESC`,
      )
      .all(tid, id.data);
    res.json({ contacts });
  });
  app.post(
    "/api/kinetic-scanner/addresses/:id/contacts/refresh",
    manage,
    async (req, res) => {
      const tid = requireTenant(req, res),
        id = idSchema.safeParse(req.params.id);
      if (!tid) return;
      if (!id.success)
        return res.status(400).json({ error: "Invalid address id" });
      try {
        const leadId = convertAddress(tid, id.data);
        rawDb
          .prepare(
            `UPDATE kinetic_addresses SET contact_enrichment_status='running' WHERE tenant_id=? AND id=?`,
          )
          .run(tid, id.data);
        // Tracerfy is the one contact source now: the generic multi-provider
        // enrichment path this used to call is gone, and a converted address
        // gets its numbers the same way every other door does.
        const result = await traceLeadNow({
          tenantId: tid,
          leadId,
          actorUserId: actor(req) ?? null,
        });
        rawDb
          .prepare(
            `UPDATE kinetic_addresses SET contact_enrichment_status='completed',updated_at=datetime('now') WHERE tenant_id=? AND id=?`,
          )
          .run(tid, id.data);
        res.json({
          ok: true,
          leadId,
          phonesFound: result.phonesFound,
          dialable: result.dialable,
        });
      } catch (error) {
        rawDb
          .prepare(
            `UPDATE kinetic_addresses SET contact_enrichment_status='failed' WHERE tenant_id=? AND id=?`,
          )
          .run(tid, id.success ? id.data : -1);
        res.status(409).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
  app.post(
    "/api/kinetic-scanner/addresses/:id/recheck",
    manage,
    async (req, res) => {
      const tid = requireTenant(req, res),
        id = idSchema.safeParse(req.params.id);
      if (!tid) return;
      if (!id.success)
        return res.status(400).json({ error: "Invalid address id" });
      const row = addressRow(tid, id.data),
        configured = evidenceConfiguration(tid),
        gateway = getKineticEvidenceGateway();
      if (!row) return res.status(404).json({ error: "Address not found" });
      if (!row.address || !row.city || !row.state || !row.zip)
        return res
          .status(409)
          .json({ error: "Complete postal address required" });
      if (
        !["approved_api", "authorized_public_lookup"].includes(
          configured.mode,
        ) ||
        gateway.status().mode !== configured.mode
      )
        return res.status(409).json({
          error:
            "Live recheck is offline until a matching permitted evidence adapter is registered",
        });
      if (
        configured.mode === "authorized_public_lookup" &&
        !configured.publicUseConfirmed
      )
        return res.status(409).json({
          error: "Permitted public automation has not been confirmed",
        });
      try {
        const result = await gateway.qualifyAddress({
          address: row.address,
          city: row.city,
          state: row.state,
          zip: row.zip,
          unit: null,
        });
        if (result.outcome !== "ok" || !result.record)
          return res.status(result.outcome === "not_found" ? 404 : 503).json({
            outcome: result.outcome,
            message: result.message ?? "No conclusive evidence",
          });
        const stored = upsertKineticAddress(tid, null, result.record);
        res.json({
          addressId: stored.id,
          discoveryState: stored.discoveryState,
          fresh: stored.fresh,
        });
      } catch (error) {
        res.status(503).json({
          error: error instanceof Error ? error.message : String(error),
          circuit: gateway.status(),
        });
      }
    },
  );
  app.post(
    "/api/kinetic-scanner/addresses/:id/convert-lead",
    manage,
    (req, res) => {
      const tid = requireTenant(req, res),
        id = idSchema.safeParse(req.params.id);
      if (!tid) return;
      if (!id.success)
        return res.status(400).json({ error: "Invalid address id" });
      try {
        res.status(201).json({ leadId: convertAddress(tid, id.data) });
      } catch (error) {
        res.status(409).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.get("/api/kinetic-scanner/changes", read, (req, res) => {
    const tid = requireTenant(req, res);
    if (!tid) return;
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const items = rawDb
      .prepare(
        `SELECT c.id,c.address_id AS addressId,a.kinetic_address_id AS kineticAddressId,a.sequential_id AS sequentialId,a.address,a.city,a.state,c.field_name AS fieldName,c.previous_value AS previousValue,c.current_value AS currentValue,c.observed_at AS changedAt FROM kinetic_address_changes c JOIN kinetic_addresses a ON a.id=c.address_id WHERE c.tenant_id=? ORDER BY c.observed_at DESC LIMIT ?`,
      )
      .all(tid, limit);
    res.json({ items });
  });
  app.get("/api/kinetic-scanner/hotspots", read, (req, res) => {
    const tid = requireTenant(req, res);
    if (!tid) return;
    const hotspots = rawDb
      .prepare(
        `SELECT city,state,zip,COUNT(*) addressCount,SUM(CASE WHEN is_live=1 THEN 1 ELSE 0 END) liveCount,SUM(CASE WHEN is_copper_upgrade_candidate=1 THEN 1 ELSE 0 END) copperUpgradeCount,AVG(latitude) latitude,AVG(longitude) longitude,MAX(last_checked_at) lastChecked FROM kinetic_addresses WHERE tenant_id=? GROUP BY city,state,zip HAVING COUNT(*)>=2 ORDER BY liveCount DESC,addressCount DESC LIMIT 250`,
      )
      .all(tid);
    res.json({ hotspots });
  });
  app.get("/api/kinetic-scanner/export", read, (req, res) => {
    const tid = requireTenant(req, res);
    if (!tid) return;
    // SEC-B: cap the export (was unbounded — one request built the whole
    // table into a single in-memory string) and stream the body in chunks so
    // a max-size export never wedges the event loop or doubles its size in RAM.
    const rows = rawDb
      .prepare(
        `SELECT kinetic_address_id AS kineticAddressId,sequential_id AS sequentialId,address,city,state,zip,latitude,longitude,exchange_id AS exchangeId,technology_type AS technologyType,maximum_qualification AS maximumQualification,estimated_completion_date AS estimatedCompletionDate,is_live AS isLive,is_coming_soon AS isComingSoon,is_copper_upgrade_candidate AS isCopperUpgradeCandidate,last_checked_at AS lastChecked FROM kinetic_addresses WHERE tenant_id=? ORDER BY sequential_id LIMIT ?`,
      )
      .all(tid, KINETIC_EXPORT_MAX_ROWS + 1) as any[];
    const truncated = rows.length > KINETIC_EXPORT_MAX_ROWS;
    if (truncated) rows.length = KINETIC_EXPORT_MAX_ROWS;
    const headers = [
      "kineticAddressId",
      "sequentialId",
      "address",
      "city",
      "state",
      "zip",
      "latitude",
      "longitude",
      "exchangeId",
      "technologyType",
      "maximumQualification",
      "estimatedCompletionDate",
      "isLive",
      "isComingSoon",
      "isCopperUpgradeCandidate",
      "lastChecked",
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="kinetic-addresses-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    if (truncated) res.setHeader("X-Export-Truncated", "true");
    res.write(headers.join(",") + "\n");
    // Chunked build: join + write per slice instead of one giant template.
    for (let i = 0; i < rows.length; i += KINETIC_EXPORT_CHUNK) {
      const slice = rows.slice(i, i + KINETIC_EXPORT_CHUNK);
      res.write(slice.map((row) => headers.map((key) => csvCell(row[key])).join(",")).join("\n") + "\n");
    }
    if (truncated) {
      res.write(`# TRUNCATED: export capped at ${KINETIC_EXPORT_MAX_ROWS} rows. Narrow the dataset or page through the API for the remainder.\n`);
    }
    res.end();
  });
  app.delete("/api/kinetic-scanner/clear", manage, (req, res) => {
    const tid = requireTenant(req, res);
    if (!tid) return;
    if (req.body?.confirm !== "CLEAR KINETIC DATA")
      return res
        .status(400)
        .json({ error: 'Confirmation must equal "CLEAR KINETIC DATA"' });
    clearKineticData(tid);
    storage.logActivity(
      actor(req),
      "kinetic.data.cleared",
      "kinetic_scanner",
      undefined,
      {},
      req.ip,
    );
    res.json({ ok: true });
  });
}

function convertAddress(tenantId: number, addressId: number): number {
  const row = addressRow(tenantId, addressId);
  if (!row) throw new Error("Address not found");
  if (row.leadId) return Number(row.leadId);
  if (!row.address || !row.city || !row.state || !row.zip)
    throw new Error(
      "A complete postal address is required before lead conversion",
    );
  const existing = rawDb
    .prepare(
      `SELECT id FROM leads WHERE tenant_id=? AND lower(address)=lower(?) AND lower(city)=lower(?) AND state=? AND zip=? LIMIT 1`,
    )
    .get(tenantId, row.address, row.city, row.state, row.zip) as any;
  const leadId =
    existing?.id ??
    storage.createLead({
      tenantId,
      address: row.address,
      city: row.city,
      state: row.state,
      zip: row.zip,
      lat: row.latitude,
      lng: row.longitude,
      fiberStatus: row.isLive
        ? "live"
        : row.isComingSoon
          ? "coming_soon"
          : "unknown",
      techType: row.technologyType,
      maxDownloadMbps:
        row.maximumQualification == null
          ? null
          : Math.round(row.maximumQualification),
      exchangeId: row.exchangeId,
      leadStatus: "prospect",
    } as any).id;
  rawDb
    .prepare(
      `UPDATE kinetic_addresses SET lead_id=?,updated_at=datetime('now') WHERE tenant_id=? AND id=?`,
    )
    .run(leadId, tenantId, addressId);
  return Number(leadId);
}
