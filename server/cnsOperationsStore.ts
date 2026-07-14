import crypto from "node:crypto";
import { rawDb } from "./db";
import type { CnsJob, CnsResult } from "./cns-scanner";

export interface PersistedCnsJob {
  id: string; tenantId: number; label: string; env: string; startCns: number; endCns: number;
  currentCns: number; status: CnsJob["status"]; scanned: number; hits: number;
  newFiberHits: number; confirmedLeads: number; skipped: number; errors: number;
  retries: number; ratePerMin: number; startedAt: string; completedAt?: string;
  heartbeatAt?: string; lastError?: string; createdBy?: number;
}

export function createPersistedCnsJob(job: CnsJob, createdBy?: number): void {
  if (!job.tenantId) throw new Error("CNS job requires an organization");
  rawDb.prepare(`INSERT INTO cns_scan_jobs
    (id,tenant_id,label,environment,start_cns,end_cns,end_inclusive,candidate_count,current_cns,
     status,created_by,created_at,started_at,heartbeat_at,updated_at)
    VALUES (?,?,?,?,?,?,1,?,?,?,?,datetime('now'),?,datetime('now'),datetime('now'))`).run(
      job.id, job.tenantId, `CNS ${job.env} ${job.startCns.toLocaleString()}–${job.endCns.toLocaleString()}`,
      job.env, job.startCns, job.endCns, job.endCns - job.startCns + 1, job.currentCns,
      job.status, createdBy ?? null, job.startedAt,
    );
  appendCnsEvent(job.tenantId, job.id, "job.started", { startCns: job.startCns, endCns: job.endCns });
}

export function persistCnsProgress(job: CnsJob, eventType?: string): void {
  if (!job.tenantId) return;
  rawDb.prepare(`UPDATE cns_scan_jobs SET current_cns=?,checked_count=?,match_count=?,primary_match_count=?,
      confirmed_lead_count=?,rate_per_minute=?,status=?,completed_at=?,heartbeat_at=datetime('now'),
      last_error=?,updated_at=datetime('now') WHERE id=? AND tenant_id=?`).run(
        job.currentCns, job.scanned, job.hits, job.newFiberHits, job.confirmedLeads, job.ratePerMin,
        job.status, job.completedAt ?? null, job.lastError ?? null, job.id, job.tenantId,
      );
  if (eventType) appendCnsEvent(job.tenantId, job.id, eventType, {
    currentCns: job.currentCns, checked: job.scanned, matches: job.hits,
    primaryMatches: job.newFiberHits, confirmedLeads: job.confirmedLeads,
    ratePerMin: job.ratePerMin, status: job.status,
  });
}

export function persistCnsObservation(job: CnsJob, result: CnsResult): void {
  if (!job.tenantId) return;
  const target = rawDb.prepare(`SELECT id,last_availability_status AS availabilityStatus
    FROM scan_targets WHERE df_address_id=? ORDER BY id DESC LIMIT 1`).get(result.dfAddressId) as any;
  const raw = JSON.stringify(result);
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const availabilityStatus = String(target?.availabilityStatus ?? "");
  const changed = ["newly_live", "went_stale", "freshly_available", "went_unavailable"].includes(availabilityStatus);
  const confirmation = changed ? "historical_change_detected" : result.isNewFiber ? "insufficient_history" : "primary_match";
  rawDb.prepare(`INSERT OR IGNORE INTO cns_scan_observations
    (tenant_id,job_id,environment,control_number,formatted_cns,scan_target_id,provider_address_id,
     classification,available,technology,max_qualification,response_hash,raw_response_json,
     change_detected,confirmation_status,observed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      job.tenantId, job.id, result.env, result.cns, result.dfAddressId, target?.id ?? null,
      result.dfAddressId, result.isNewFiber ? "primary_fiber_match" : "provider_address",
      result.isNewFiber ? 1 : null, result.techType, result.maxDownloadMbps, hash, raw,
      changed ? 1 : 0, confirmation, result.discoveredAt,
    );
  appendCnsEvent(job.tenantId, job.id, result.isNewFiber ? "address.primary_match" : "address.found", {
    controlNumber: result.cns, formattedCns: result.dfAddressId, scanTargetId: target?.id ?? null,
    classification: result.isNewFiber ? "primary_fiber_match" : "provider_address",
  });
}

export function appendCnsEvent(tenantId: number, jobId: string, eventType: string, payload: unknown): number {
  return Number(rawDb.prepare(`INSERT INTO cns_job_events (tenant_id,job_id,event_type,payload_json) VALUES (?,?,?,?)`)
    .run(tenantId, jobId, eventType, JSON.stringify(payload ?? {})).lastInsertRowid);
}

export function readCnsEvents(tenantId: number, jobId: string, after: number, limit = 250) {
  return (rawDb.prepare(`SELECT sequence,event_type AS eventType,payload_json AS payloadJson,created_at AS createdAt
    FROM cns_job_events WHERE tenant_id=? AND job_id=? AND sequence>? ORDER BY sequence LIMIT ?`)
    .all(tenantId, jobId, after, limit) as any[]).map(row => ({
      sequence: row.sequence, eventType: row.eventType, payload: parseJson(row.payloadJson), createdAt: row.createdAt,
    }));
}

export function loadPersistedCnsJobs(): PersistedCnsJob[] {
  try { return (rawDb.prepare(`SELECT id,tenant_id AS tenantId,label,environment AS env,start_cns AS startCns,
      end_cns AS endCns,current_cns AS currentCns,status,checked_count AS scanned,match_count AS hits,
      primary_match_count AS newFiberHits,confirmed_lead_count AS confirmedLeads,skipped_count AS skipped,
      error_count AS errors,retry_count AS retries,rate_per_minute AS ratePerMin,started_at AS startedAt,
      completed_at AS completedAt,heartbeat_at AS heartbeatAt,last_error AS lastError,created_by AS createdBy
    FROM cns_scan_jobs WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT 500`).all() as any[]).map(row => ({
      ...row,
      status: (["running", "queued", "starting", "rechecking", "stopping"] as string[]).includes(row.status) ? "paused" : row.status,
      lastError: (["running", "queued", "starting", "rechecking", "stopping"] as string[]).includes(row.status)
        ? "Recovered after restart. Resume from the persisted checkpoint when ready." : row.lastError,
    })); } catch (error: any) {
    // Some pure unit tests import the provider probe before boot migrations.
    // Runtime startup always migrates first; an absent ledger simply means
    // there is nothing to recover in that isolated pre-migration context.
    if (String(error?.message ?? error).includes("no such table")) return [];
    throw error;
  }
}

export function loadCnsResults(jobId: string): CnsResult[] {
  return (rawDb.prepare(`SELECT raw_response_json AS rawJson FROM cns_scan_observations WHERE job_id=? ORDER BY id`).all(jobId) as any[])
    .map(row => parseJson(row.rawJson)).filter((value): value is CnsResult => !!value && typeof value === "object") as CnsResult[];
}

export function cnsJobBelongsToTenant(jobId: string, tenantId: number): boolean {
  return !!rawDb.prepare(`SELECT 1 FROM cns_scan_jobs WHERE id=? AND tenant_id=?`).get(jobId, tenantId);
}

export function archivePersistedCnsJob(jobId: string, tenantId: number): boolean {
  return rawDb.prepare(`UPDATE cns_scan_jobs SET archived_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND tenant_id=?`).run(jobId,tenantId).changes === 1;
}

export function scannerSettings(tenantId: number) {
  rawDb.prepare(`INSERT OR IGNORE INTO cns_scanner_settings (tenant_id) VALUES (?)`).run(tenantId);
  return rawDb.prepare(`SELECT default_environment AS defaultEnvironment,requests_per_minute AS requestsPerMinute,
    concurrency,max_in_flight AS maxInFlight,job_size_limit AS jobSizeLimit,recheck_interval_hours AS recheckIntervalHours,
    retry_count AS retryCount,request_timeout_ms AS requestTimeoutMs,heartbeat_interval_seconds AS heartbeatIntervalSeconds,
    stale_heartbeat_seconds AS staleHeartbeatSeconds,page_size AS pageSize,dashboard_refresh_seconds AS dashboardRefreshSeconds,
    updated_at AS updatedAt FROM cns_scanner_settings WHERE tenant_id=?`).get(tenantId) as any;
}

export function seedClassificationRule(tenantId: number): void {
  rawDb.prepare(`INSERT OR IGNORE INTO cns_classification_rules
    (tenant_id,source_field,operator,expected_value,classification,availability_result,fiber_indicator,priority,active)
    VALUES (?,'householdSegmentType','equals','NEW FIBER','Primary Fiber Match','Available',1,100,1)`).run(tenantId);
}

function parseJson(value: string): unknown { try { return JSON.parse(value); } catch { return {}; } }
