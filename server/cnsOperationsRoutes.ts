import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Capability } from "@shared/capabilities";
import { rawDb } from "./db";
import { getDefaultTenantId, storage } from "./storage";
import { KINETIC_ENVS } from "./cns-scanner";
import { scannerSettings, seedClassificationRule } from "./cnsOperationsStore";
import { listNationalCnsFrontiers } from "./nationalCnsStore";
import { KINETIC_FOOTPRINT_STATES } from "@shared/kineticFootprint";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;
export interface CnsOperationsRouteDeps { requireCapability: (capability: Capability) => Middleware }

const addressQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(160).optional(), env: z.string().trim().max(8).optional(),
  state: z.string().trim().length(2).optional(), city: z.string().trim().max(120).optional(),
  technology: z.string().trim().max(80).optional(), classification: z.string().trim().max(80).optional(),
  primaryOnly: z.enum(["true", "false"]).optional(), changedOnly: z.enum(["true", "false"]).optional(),
});
const settingsPatch = z.object({
  defaultEnvironment: z.string().trim().min(2).max(8).optional(),
  requestsPerMinute: z.number().int().min(1).max(600).optional(), concurrency: z.number().int().min(1).max(32).optional(),
  maxInFlight: z.number().int().min(1).max(64).optional(), jobSizeLimit: z.number().int().min(100).max(100_000).optional(),
  recheckIntervalHours: z.number().int().min(1).max(720).optional(), retryCount: z.number().int().min(0).max(10).optional(),
  requestTimeoutMs: z.number().int().min(1_000).max(60_000).optional(), heartbeatIntervalSeconds: z.number().int().min(1).max(60).optional(),
  staleHeartbeatSeconds: z.number().int().min(30).max(900).optional(), pageSize: z.number().int().min(10).max(100).optional(),
  dashboardRefreshSeconds: z.number().int().min(3).max(300).optional(),
}).strict();
const ruleSchema = z.object({
  sourceField: z.string().trim().min(1).max(100), operator: z.enum(["equals", "not_equals", "contains", "exists"]),
  expectedValue: z.string().trim().max(200), classification: z.string().trim().min(1).max(100),
  availabilityResult: z.string().trim().min(1).max(60), fiberIndicator: z.boolean(), priority: z.number().int().min(0).max(1_000), active: z.boolean(),
});

function tenantId(req: Request): number | null {
  const value = Number((req as any).user?.tenantId ?? getDefaultTenantId());
  return Number.isInteger(value) && value > 0 ? value : null;
}
function json(value: string | null): unknown { try { return value ? JSON.parse(value) : null; } catch { return null; } }
function csvCell(value: unknown): string { return `"${String(value ?? "").replaceAll('"', '""')}"`; }

export function registerCnsOperationsRoutes(app: Express, deps: CnsOperationsRouteDeps): void {
  const auth = deps.requireCapability("scan.manage");

  app.get("/api/cns/ops/dashboard", auth, (req, res) => {
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    const totals = rawDb.prepare(`SELECT COUNT(DISTINCT o.scan_target_id) AS totalAddresses,
      COUNT(DISTINCT CASE WHEN o.classification='primary_fiber_match' THEN o.scan_target_id END) AS primaryMatches,
      COUNT(DISTINCT CASE WHEN s.last_fiber_available=1 THEN o.scan_target_id END) AS liveFiber,
      COUNT(DISTINCT CASE WHEN o.change_detected=1 THEN o.scan_target_id END) AS changedAddresses,
      COUNT(DISTINCT CASE WHEN o.change_detected=1 AND lower(COALESCE(o.technology,'')) LIKE '%fiber%' THEN o.scan_target_id END) AS copperUpgrades
      FROM cns_scan_observations o LEFT JOIN scan_targets s ON s.id=o.scan_target_id WHERE o.tenant_id=?`).get(tid) as any;
    const today = rawDb.prepare(`SELECT COALESCE(SUM(checked_count),0) AS checkedToday,COALESCE(SUM(primary_match_count),0) AS newMatches,
      COALESCE(SUM(error_count),0) AS errors FROM cns_scan_jobs WHERE tenant_id=? AND created_at>=date('now')`).get(tid) as any;
    const leadFunnel = rawDb.prepare(`SELECT
      SUM(CASE WHEN confirmation_status IN ('insufficient_history','primary_match') THEN 1 ELSE 0 END) AS awaitingConfirmation,
      SUM(CASE WHEN confirmation_status IN ('historical_change_detected','confirmed','publishable') THEN 1 ELSE 0 END) AS publishableLeads
      FROM cns_scan_observations WHERE tenant_id=?`).get(tid) as any;
    const activeJob = rawDb.prepare(`SELECT id,environment AS env,current_cns AS currentCns,start_cns AS startCns,end_cns AS endCns,
      checked_count AS checked,match_count AS found,primary_match_count AS primaryMatches,confirmed_lead_count AS published,
      skipped_count AS skipped,error_count AS errors,rate_per_minute AS ratePerMinute,status,heartbeat_at AS heartbeatAt,
      last_error AS lastError,started_at AS startedAt FROM cns_scan_jobs WHERE tenant_id=? AND status IN ('running','paused') ORDER BY updated_at DESC LIMIT 1`).get(tid) as any;
    const velocity = rawDb.prepare(`SELECT substr(created_at,12,5) AS bucket,SUM(checked_count) AS checked,SUM(primary_match_count) AS matches
      FROM cns_scan_jobs WHERE tenant_id=? AND created_at>=datetime('now','-24 hours') GROUP BY strftime('%Y-%m-%d %H',created_at) ORDER BY created_at`).all(tid);
    res.json({ totals: { ...totals, ...today, ...leadFunnel }, activeJob: activeJob ?? null, velocity });
  });

  app.get("/api/cns/ops/addresses", auth, (req, res) => {
    const parsed = addressQuery.safeParse(req.query); if (!parsed.success) return res.status(400).json({ error: "Invalid filters", issues: parsed.error.flatten() });
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    const q = parsed.data, where = ["o.tenant_id=?"], args: unknown[] = [tid];
    if (q.search) { where.push("(lower(s.address) LIKE lower(?) OR lower(s.city) LIKE lower(?) OR s.zip LIKE ? OR lower(o.formatted_cns) LIKE lower(?) OR lower(COALESCE(o.provider_address_id,'')) LIKE lower(?))"); const term = `%${q.search}%`; args.push(term,term,term,term,term); }
    if (q.env) { where.push("o.environment=?"); args.push(q.env.toUpperCase()); }
    if (q.state) { where.push("lower(s.state)=lower(?)"); args.push(q.state); }
    if (q.city) { where.push("lower(s.city)=lower(?)"); args.push(q.city); }
    if (q.technology) { where.push("lower(COALESCE(o.technology,''))=lower(?)"); args.push(q.technology); }
    if (q.classification) { where.push("o.classification=?"); args.push(q.classification); }
    if (q.primaryOnly === "true") where.push("o.classification='primary_fiber_match'");
    if (q.changedOnly === "true") where.push("o.change_detected=1");
    const clause = where.join(" AND ");
    const total = Number((rawDb.prepare(`SELECT COUNT(*) AS count FROM cns_scan_observations o LEFT JOIN scan_targets s ON s.id=o.scan_target_id WHERE ${clause}`).get(...args) as any)?.count ?? 0);
    const offset = (q.page - 1) * q.pageSize;
    const items = rawDb.prepare(`SELECT o.id,o.scan_target_id AS scanTargetId,o.environment AS env,o.control_number AS cns,
      o.formatted_cns AS formattedCns,s.address,s.city,s.state,s.zip,s.lat,s.lng,o.technology,
      o.max_qualification AS maxQualification,o.classification,o.confirmation_status AS evidenceState,
      o.change_detected AS changeDetected,o.observed_at AS lastChecked,s.first_seen_live_at AS lastChanged,
      s.last_customer_segment AS householdSegment,s.last_fiber_available AS live,s.converted_to_lead_id AS leadId
      FROM cns_scan_observations o LEFT JOIN scan_targets s ON s.id=o.scan_target_id
      WHERE ${clause} ORDER BY o.observed_at DESC,o.id DESC LIMIT ? OFFSET ?`).all(...args,q.pageSize,offset);
    res.json({ items, page: q.page, pageSize: q.pageSize, total, pages: Math.max(1, Math.ceil(total/q.pageSize)) });
  });

  app.get("/api/cns/ops/map", auth, (req, res) => {
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    const rows = rawDb.prepare(`SELECT o.id,s.lng,s.lat,s.address,s.city,s.state,o.formatted_cns AS formattedCns,
      o.classification,o.confirmation_status AS evidenceState,o.change_detected AS changeDetected,
      s.last_fiber_available AS live,o.technology FROM cns_scan_observations o JOIN scan_targets s ON s.id=o.scan_target_id
      WHERE o.tenant_id=? AND s.lat IS NOT NULL AND s.lng IS NOT NULL ORDER BY o.observed_at DESC LIMIT 5000`).all(tid) as any[];
    res.json({ type: "FeatureCollection", features: rows.map(row => ({ type: "Feature", id: row.id, geometry: { type: "Point", coordinates: [row.lng,row.lat] }, properties: { ...row, lat: undefined, lng: undefined } })) });
  });

  app.get("/api/cns/ops/hotspots", auth, (req, res) => {
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    const minimum = Math.min(100,Math.max(1,Number(req.query.minimum)||3));
    const rows = rawDb.prepare(`SELECT s.city,s.state,s.zip,COUNT(*) AS addressCount,
      SUM(CASE WHEN o.classification='primary_fiber_match' THEN 1 ELSE 0 END) AS primaryMatches,
      SUM(CASE WHEN s.last_fiber_available=1 THEN 1 ELSE 0 END) AS liveAddresses,
      SUM(CASE WHEN o.change_detected=1 THEN 1 ELSE 0 END) AS newlyLive,
      SUM(CASE WHEN o.confirmation_status IN ('historical_change_detected','confirmed','publishable') THEN 1 ELSE 0 END) AS publishableLeads,
      AVG(s.lat) AS lat,AVG(s.lng) AS lng,MAX(o.observed_at) AS lastActivity
      FROM cns_scan_observations o JOIN scan_targets s ON s.id=o.scan_target_id WHERE o.tenant_id=?
      GROUP BY lower(s.city),lower(s.state),s.zip HAVING COUNT(*)>=? ORDER BY publishableLeads DESC,addressCount DESC LIMIT 200`).all(tid,minimum);
    res.json({ hotspots: rows });
  });

  app.get("/api/cns/ops/changes", auth, (req, res) => {
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    const limit = Math.min(500,Math.max(1,Number(req.query.limit)||100));
    const items = rawDb.prepare(`SELECT a.id,a.scan_target_id AS scanTargetId,s.address,s.city,s.state,s.df_address_id AS formattedCns,
      a.transition_status AS changeType,a.fiber_available AS available,a.fiber_status AS technology,
      a.fresh,a.checked_at AS changedAt,a.evidence_hash AS evidenceHash
      FROM availability_snapshots a JOIN scan_targets s ON s.id=a.scan_target_id
      WHERE a.tenant_id=? AND a.transition_status IN ('freshly_available','went_unavailable')
      ORDER BY a.checked_at DESC LIMIT ?`).all(tid,limit);
    res.json({ items });
  });

  app.get("/api/cns/ops/evidence/:targetId", auth, (req, res) => {
    const tid = tenantId(req), targetId = Number(req.params.targetId); if (!tid) return res.status(403).json({ error: "Organization required" });
    if (!Number.isInteger(targetId)) return res.status(400).json({ error: "Invalid target" });
    const address = rawDb.prepare(`SELECT id,address,city,state,zip,lat,lng,df_address_id AS formattedCns,last_fiber_status AS fiberStatus,
      last_fiber_available AS available,last_customer_segment AS householdSegment,last_scanned_at AS lastChecked,
      first_seen_live_at AS firstSeenLiveAt,converted_to_lead_id AS leadId FROM scan_targets WHERE id=?`).get(targetId) as any;
    if (!address || !rawDb.prepare(`SELECT 1 FROM cns_scan_observations WHERE tenant_id=? AND scan_target_id=?`).get(tid,targetId)) return res.status(404).json({ error: "Address not found" });
    const observations = (rawDb.prepare(`SELECT id,job_id AS jobId,formatted_cns AS formattedCns,classification,available,technology,
      max_qualification AS maxQualification,change_detected AS changeDetected,confirmation_status AS confirmationStatus,
      response_hash AS responseHash,raw_response_json AS rawJson,observed_at AS observedAt
      FROM cns_scan_observations WHERE tenant_id=? AND scan_target_id=? ORDER BY observed_at DESC`).all(tid,targetId) as any[])
      .map(row => ({ ...row, rawResponse: json(row.rawJson), rawJson: undefined }));
    res.json({ address, observations });
  });

  app.get("/api/cns/ops/leads", auth, (req, res) => {
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    const items = rawDb.prepare(`SELECT o.id,o.scan_target_id AS scanTargetId,s.address,s.city,s.state,o.formatted_cns AS formattedCns,
      o.classification,o.confirmation_status AS evidenceState,o.technology,o.max_qualification AS maxQualification,
      o.observed_at AS firstFound,s.first_seen_live_at AS lastChanged,s.converted_to_lead_id AS leadId,
      COALESCE(f.score,0) AS confidenceScore FROM cns_scan_observations o JOIN scan_targets s ON s.id=o.scan_target_id
      LEFT JOIN fiber_freshness_scores f ON f.tenant_id=o.tenant_id AND f.scan_target_id=o.scan_target_id
      WHERE o.tenant_id=? AND o.classification='primary_fiber_match' ORDER BY confidenceScore DESC,o.observed_at DESC LIMIT 500`).all(tid);
    res.json({ items });
  });

  app.get("/api/cns/ops/settings", auth, (req, res) => {
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    seedClassificationRule(tid);
    const rules = rawDb.prepare(`SELECT id,source_field AS sourceField,operator,expected_value AS expectedValue,
      classification,availability_result AS availabilityResult,fiber_indicator AS fiberIndicator,priority,active
      FROM cns_classification_rules WHERE tenant_id=? ORDER BY priority DESC,id`).all(tid);
    res.json({ settings: scannerSettings(tid), environments: KINETIC_ENVS, nationalFrontiers: listNationalCnsFrontiers(), footprintStates: KINETIC_FOOTPRINT_STATES, rules });
  });

  app.get("/api/cns/ops/national", auth, (_req, res) => {
    const frontiers = listNationalCnsFrontiers();
    res.json({
      enabled: process.env.ENABLE_NIGHTLY_SCAN === "true",
      schedule: "02:00 server local time",
      dailyBudget: Math.max(frontiers.length, Number(process.env.NATIONAL_CNS_DAILY_BUDGET ?? process.env.NIGHTLY_SCAN_COUNT ?? 50_000)),
      overlapPerEnvironment: Math.max(0, Number(process.env.NATIONAL_CNS_OVERLAP_PER_ENV ?? 1_000)),
      states: KINETIC_FOOTPRINT_STATES,
      environments: frontiers,
    });
  });

  app.patch("/api/cns/ops/settings", auth, (req, res) => {
    const parsed = settingsPatch.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Invalid settings", issues: parsed.error.flatten() });
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    scannerSettings(tid);
    const columns: Record<string,string> = { defaultEnvironment:"default_environment",requestsPerMinute:"requests_per_minute",concurrency:"concurrency",maxInFlight:"max_in_flight",jobSizeLimit:"job_size_limit",recheckIntervalHours:"recheck_interval_hours",retryCount:"retry_count",requestTimeoutMs:"request_timeout_ms",heartbeatIntervalSeconds:"heartbeat_interval_seconds",staleHeartbeatSeconds:"stale_heartbeat_seconds",pageSize:"page_size",dashboardRefreshSeconds:"dashboard_refresh_seconds" };
    const entries = Object.entries(parsed.data); if (entries.length) {
      const set = entries.map(([key]) => `${columns[key]}=?`).join(",");
      rawDb.prepare(`UPDATE cns_scanner_settings SET ${set},updated_by=?,updated_at=datetime('now') WHERE tenant_id=?`).run(...entries.map(([,value])=>value),Number((req as any).user?.id),tid);
    }
    storage.logActivity(Number((req as any).user?.id),"cns.settings.updated","cns_settings",undefined,parsed.data,req.ip,tid);
    res.json({ settings: scannerSettings(tid) });
  });

  app.post("/api/cns/ops/rules", auth, (req, res) => {
    const parsed = ruleSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Invalid rule", issues: parsed.error.flatten() });
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    const v = parsed.data;
    const result = rawDb.prepare(`INSERT INTO cns_classification_rules (tenant_id,source_field,operator,expected_value,classification,availability_result,fiber_indicator,priority,active)
      VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`).get(tid,v.sourceField,v.operator,v.expectedValue,v.classification,v.availabilityResult,v.fiberIndicator?1:0,v.priority,v.active?1:0) as any;
    res.status(201).json({ id: result.id });
  });

  app.get("/api/cns/ops/export", auth, (req, res) => {
    const tid = tenantId(req); if (!tid) return res.status(403).end();
    const rows = rawDb.prepare(`SELECT o.formatted_cns AS cns,s.address,s.city,s.state,s.zip,o.classification,o.technology,
      o.max_qualification AS maxQualification,o.confirmation_status AS evidenceState,o.observed_at AS observedAt
      FROM cns_scan_observations o LEFT JOIN scan_targets s ON s.id=o.scan_target_id WHERE o.tenant_id=? ORDER BY o.observed_at DESC`).all(tid) as any[];
    const header = ["CNS","Address","City","State","ZIP","Classification","Technology","Max Qualification","Evidence State","Observed At"];
    const body = [header.map(csvCell).join(","),...rows.map(row => [row.cns,row.address,row.city,row.state,row.zip,row.classification,row.technology,row.maxQualification,row.evidenceState,row.observedAt].map(csvCell).join(","))].join("\n");
    const stamp = new Date().toISOString().replaceAll(/[:.]/g,"-");
    res.setHeader("Content-Type","text/csv; charset=utf-8"); res.setHeader("Content-Disposition",`attachment; filename="cns-addresses-${stamp}.csv"`); res.send(body);
  });
}
