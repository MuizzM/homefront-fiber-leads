import crypto from "node:crypto";
import { rawDb } from "./db";

export type FiberEventType =
  | "job.started" | "job.progress" | "job.paused" | "job.resumed" | "job.cancelled"
  | "job.completed" | "job.failed" | "address.completed" | "address.failed" | "address.requeued"
  | "address.not_found_terminal" | "worker.heartbeat" | "dead_letter.retried";

export function correlationId(runId: string): string {
  const row = rawDb.prepare(`SELECT correlation_id AS correlationId FROM scan_runs WHERE id=?`).get(runId) as any;
  if (row?.correlationId) return String(row.correlationId);
  const value = crypto.randomUUID();
  rawDb.prepare(`UPDATE scan_runs SET correlation_id=?, updated_at=datetime('now') WHERE id=?`).run(value, runId);
  return value;
}

export function appendFiberEvent(input: {
  tenantId: number; runId: string; eventType: FiberEventType; targetId?: number | null;
  payload?: Record<string, unknown>; correlationId?: string;
}): number {
  const cid = input.correlationId ?? correlationId(input.runId);
  const result = rawDb.prepare(`INSERT INTO fiber_job_events
    (tenant_id,run_id,event_type,target_id,correlation_id,payload_json)
    VALUES (?,?,?,?,?,?)`).run(
      input.tenantId, input.runId, input.eventType, input.targetId ?? null, cid,
      JSON.stringify(input.payload ?? {}),
    );
  const sequence = Number(result.lastInsertRowid);
  rawDb.prepare(`INSERT INTO fiber_job_checkpoints
    (run_id,tenant_id,last_sequence,completed_targets,checkpoint_json,updated_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(run_id) DO UPDATE SET last_sequence=excluded.last_sequence,
      completed_targets=CASE WHEN excluded.completed_targets > completed_targets THEN excluded.completed_targets ELSE completed_targets END,
      checkpoint_json=excluded.checkpoint_json,updated_at=datetime('now')`).run(
        input.runId, input.tenantId, sequence,
        Number(input.payload?.completedTargets ?? 0), JSON.stringify(input.payload ?? {}),
      );
  return sequence;
}

export function beginFiberWorker(tenantId: number, runId: string): void {
  const existing = rawDb.prepare(`SELECT 1 FROM fiber_job_events WHERE tenant_id=? AND run_id=? LIMIT 1`).get(tenantId, runId);
  appendFiberEvent({ tenantId, runId, eventType: existing ? "job.resumed" : "job.started", payload: {} });
}

export function targetAttempt(runId: string, targetId: number): number {
  return Number((rawDb.prepare(`SELECT attempt_count AS attempts FROM scan_run_targets WHERE run_id=? AND target_id=?`)
    .get(runId, targetId) as any)?.attempts ?? 1);
}

export function persistFreshness(input: {
  tenantId: number; targetId: number; score: number; verificationState: string;
  formulaVersion: string; factors: unknown; explanation: string[];
}): void {
  rawDb.prepare(`INSERT INTO fiber_freshness_scores
    (tenant_id,scan_target_id,score,verification_state,formula_version,factors_json,explanation_json,calculated_at)
    VALUES (?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(tenant_id,scan_target_id) DO UPDATE SET
      score=excluded.score,verification_state=excluded.verification_state,formula_version=excluded.formula_version,
      factors_json=excluded.factors_json,explanation_json=excluded.explanation_json,calculated_at=datetime('now')`).run(
        input.tenantId, input.targetId, input.score, input.verificationState, input.formulaVersion,
        JSON.stringify(input.factors), JSON.stringify(input.explanation),
      );
}

export function listFiberEvents(tenantId: number, runId: string, after: number, limit = 250) {
  return (rawDb.prepare(`SELECT sequence,event_type AS eventType,target_id AS targetId,
      correlation_id AS correlationId,payload_json AS payloadJson,created_at AS createdAt
    FROM fiber_job_events WHERE tenant_id=? AND run_id=? AND sequence>?
    ORDER BY sequence ASC LIMIT ?`).all(tenantId, runId, after, limit) as any[]).map((row) => ({
      ...row, payload: safeJson(row.payloadJson), payloadJson: undefined,
    }));
}

export function heartbeatWorker(input: {
  workerId: string; tenantId: number; runId: string; status: string; concurrency: number;
  lastError?: string | null; metadata?: Record<string, unknown>;
}): void {
  rawDb.prepare(`INSERT INTO fiber_worker_heartbeats
    (worker_id,tenant_id,run_id,status,concurrency,last_error,metadata_json,started_at,heartbeat_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))
    ON CONFLICT(worker_id) DO UPDATE SET tenant_id=excluded.tenant_id,run_id=excluded.run_id,
      status=excluded.status,concurrency=excluded.concurrency,last_error=excluded.last_error,
      metadata_json=excluded.metadata_json,heartbeat_at=datetime('now')`).run(
        input.workerId, input.tenantId, input.runId, input.status, input.concurrency,
        input.lastError ?? null, JSON.stringify(input.metadata ?? {}),
      );
}

export function recordFiberFailure(input: {
  tenantId: number; runId: string; targetId: number; category: string; message: string;
  attempt: number; retryable: boolean;
}): void {
  const cid = correlationId(input.runId);
  rawDb.prepare(`INSERT INTO fiber_job_failures
    (tenant_id,run_id,target_id,category,message,attempt,retryable,correlation_id)
    VALUES (?,?,?,?,?,?,?,?)`).run(input.tenantId, input.runId, input.targetId, input.category,
      input.message.slice(0, 500), input.attempt, input.retryable ? 1 : 0, cid);
  rawDb.prepare(`UPDATE scan_run_targets SET attempt_count=MAX(attempt_count,?),
    last_error_category=?,last_error_message=? WHERE run_id=? AND target_id=?`).run(
      input.attempt, input.category, input.message.slice(0, 500), input.runId, input.targetId);
  // scanAddress already performs the bounded provider retry/backoff. Once the
  // budgeted target attempt is terminal, park it visibly instead of silently
  // spending beyond the operator-approved check budget. An explicit retry is a
  // new admitted unit of spend and expands the run budget by exactly one.
  rawDb.prepare(`INSERT INTO fiber_dead_letters
      (tenant_id,run_id,target_id,category,message,attempts,payload_json)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(run_id,target_id) DO UPDATE SET
        category=excluded.category,message=excluded.message,attempts=excluded.attempts,
        payload_json=excluded.payload_json,resolved_at=NULL,resolved_by=NULL`).run(
          input.tenantId, input.runId, input.targetId, input.category, input.message.slice(0, 500),
          input.attempt, JSON.stringify({ correlationId: cid }),
        );
}

export function retryDeadLetter(tenantId: number, id: number, userId: number): { runId: string; targetId: number } | null {
  const row = rawDb.prepare(`SELECT run_id AS runId,target_id AS targetId FROM fiber_dead_letters
    WHERE id=? AND tenant_id=? AND resolved_at IS NULL`).get(id, tenantId) as any;
  if (!row) return null;
  const tx = rawDb.transaction(() => {
    rawDb.prepare(`UPDATE scan_run_targets SET state='queued',result=NULL,next_attempt_at=NULL WHERE run_id=? AND target_id=?`).run(row.runId, row.targetId);
    rawDb.prepare(`UPDATE fiber_dead_letters SET resolved_at=datetime('now'),resolved_by=? WHERE id=?`).run(userId, id);
    rawDb.prepare(`UPDATE scan_runs SET status='running',budget=budget+1,completed_at=NULL,error=NULL,updated_at=datetime('now') WHERE id=? AND tenant_id=?`).run(row.runId, tenantId);
  });
  tx();
  appendFiberEvent({ tenantId, runId: row.runId, eventType: "dead_letter.retried", targetId: row.targetId, payload: { deadLetterId: id } });
  return row;
}

export function operationsDashboard(tenantId: number) {
  const runs = rawDb.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status='paused' THEN 1 ELSE 0 END) AS paused,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errored,
      COALESCE(SUM(verified),0) AS verified,
      COALESCE(SUM(new_fiber),0) AS primaryMatches,
      COALESCE(SUM(newly_live),0) AS newlyLive,
      COALESCE(SUM(failed),0) AS failed
    FROM scan_runs WHERE tenant_id=?`).get(tenantId) as any;
  const workers = rawDb.prepare(`SELECT worker_id AS workerId,run_id AS runId,status,concurrency,
      last_error AS lastError,heartbeat_at AS heartbeatAt,
      CASE WHEN heartbeat_at >= datetime('now','-90 seconds') THEN 1 ELSE 0 END AS healthy
    FROM fiber_worker_heartbeats WHERE tenant_id=? ORDER BY heartbeat_at DESC LIMIT 50`).all(tenantId);
  const openDeadLetters = (rawDb.prepare(`SELECT COUNT(*) AS count FROM fiber_dead_letters WHERE tenant_id=? AND resolved_at IS NULL`).get(tenantId) as any)?.count ?? 0;
  return { runs, workers, openDeadLetters };
}

export function listFiberAddresses(tenantId: number, input: {
  limit: number; cursor?: number; city?: string; state?: string; result?: string;
}) {
  const conditions = ["r.tenant_id=?"];
  const args: unknown[] = [tenantId];
  if (input.cursor) { conditions.push("t.target_id>?"); args.push(input.cursor); }
  if (input.city) { conditions.push("lower(s.city)=lower(?)"); args.push(input.city); }
  if (input.state) { conditions.push("lower(s.state)=lower(?)"); args.push(input.state); }
  if (input.result) { conditions.push("t.result=?"); args.push(input.result); }
  args.push(input.limit + 1);
  const rows = rawDb.prepare(`SELECT t.target_id AS id,s.address,s.city,s.state,s.zip,s.lat,s.lng,
      t.state,t.result,t.attempt_count AS attemptCount,t.last_error_category AS errorCategory,
      s.last_scanned_at AS lastCheckedAt,s.first_seen_live_at AS firstSeenLiveAt,
      COALESCE(f.score,0) AS freshnessScore,f.verification_state AS verificationState
    FROM scan_run_targets t JOIN scan_runs r ON r.id=t.run_id
    JOIN scan_targets s ON s.id=t.target_id
    LEFT JOIN fiber_freshness_scores f ON f.tenant_id=r.tenant_id AND f.scan_target_id=t.target_id
    WHERE ${conditions.join(" AND ")} GROUP BY t.target_id ORDER BY t.target_id ASC LIMIT ?`).all(...args) as any[];
  const hasMore = rows.length > input.limit;
  const items = rows.slice(0, input.limit);
  return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
}

export function listFiberFailures(tenantId: number, runId?: string, limit = 100) {
  const rows = runId
    ? rawDb.prepare(`SELECT * FROM fiber_job_failures WHERE tenant_id=? AND run_id=? ORDER BY id DESC LIMIT ?`).all(tenantId, runId, limit)
    : rawDb.prepare(`SELECT * FROM fiber_job_failures WHERE tenant_id=? ORDER BY id DESC LIMIT ?`).all(tenantId, limit);
  return rows;
}

export function listDeadLetters(tenantId: number, limit = 100) {
  return rawDb.prepare(`SELECT * FROM fiber_dead_letters WHERE tenant_id=? AND resolved_at IS NULL ORDER BY id DESC LIMIT ?`).all(tenantId, limit);
}

export function providerConfigs(tenantId: number) {
  const kineticEnabled = process.env.RADAR_LIVE !== "off"; // live radar on by default
  rawDb.prepare(`INSERT OR IGNORE INTO provider_adapter_configs
    (tenant_id,provider,enabled,display_name,mode,rate_limit_per_minute)
    VALUES (?,?,?,?,?,?)`).run(tenantId, "kinetic", kineticEnabled ? 1 : 0, "Kinetic", "authorized_http", 30);
  rawDb.prepare(`UPDATE provider_adapter_configs SET enabled=?,updated_at=datetime('now') WHERE tenant_id=? AND provider='kinetic'`)
    .run(kineticEnabled ? 1 : 0, tenantId);
  return rawDb.prepare(`SELECT provider,enabled,display_name AS displayName,mode,rate_limit_per_minute AS rateLimitPerMinute,
    health_status AS healthStatus,consecutive_failures AS consecutiveFailures,last_success_at AS lastSuccessAt,
    last_failure_at AS lastFailureAt,last_error AS lastError,updated_at AS updatedAt
    FROM provider_adapter_configs WHERE tenant_id=? ORDER BY provider`).all(tenantId);
}

export function recordProviderOutcome(tenantId: number, success: boolean, error?: string | null): void {
  const enabled = process.env.RADAR_LIVE !== "off" ? 1 : 0; // live radar on by default
  rawDb.prepare(`INSERT INTO provider_adapter_configs
    (tenant_id,provider,enabled,display_name,mode,rate_limit_per_minute,health_status,consecutive_failures,last_success_at,last_failure_at,last_error,updated_at)
    VALUES (?,'kinetic',?,'Kinetic','authorized_http',30,?,?,?,?,?,datetime('now'))
    ON CONFLICT(tenant_id,provider) DO UPDATE SET enabled=excluded.enabled,
      health_status=excluded.health_status,
      consecutive_failures=CASE WHEN excluded.health_status='healthy' THEN 0 ELSE consecutive_failures+1 END,
      last_success_at=COALESCE(excluded.last_success_at,last_success_at),
      last_failure_at=COALESCE(excluded.last_failure_at,last_failure_at),
      last_error=CASE WHEN excluded.health_status='healthy' THEN NULL ELSE excluded.last_error END,
      updated_at=datetime('now')`).run(
        tenantId, enabled, success ? "healthy" : "degraded", success ? 0 : 1,
        success ? new Date().toISOString() : null, success ? null : new Date().toISOString(),
        success ? null : String(error ?? "Provider check failed").slice(0, 500),
      );
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return {}; }
}
