import { rawDb } from "./db";
import {
  getKineticEvidenceGateway,
  KineticEvidenceUnavailableError,
} from "./kineticProviderAdapter";
import {
  createKineticJob,
  event,
  job,
  upsertKineticAddress,
} from "./kineticScannerStore";

interface Runtime {
  stopped: boolean;
  controller: AbortController;
}
const runtimes = new Map<string, Runtime>();
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const minDelay = () =>
  Math.max(
    500,
    Math.min(
      60_000,
      Number(process.env.KINETIC_EVIDENCE_MIN_DELAY_MS) || 1_000,
    ),
  );

function heartbeat(id: string, updates: Record<string, unknown> = {}): void {
  const keys = Object.keys(updates),
    set = keys.map((key) => `${key}=?`).join(",");
  rawDb
    .prepare(
      `UPDATE kinetic_scan_jobs SET ${set ? `${set},` : ""} last_heartbeat=datetime('now'),updated_at=datetime('now') WHERE id=?`,
    )
    .run(...keys.map((key) => updates[key]), id);
}

async function runRecheck(id: string): Promise<void> {
  const runtime: Runtime = {
    stopped: false,
    controller: new AbortController(),
  };
  runtimes.set(id, runtime);
  const record = job(id);
  if (!record) {
    runtimes.delete(id);
    return;
  }
  const gateway = getKineticEvidenceGateway();
  if (!gateway.supportsLiveQualification()) {
    rawDb
      .prepare(
        `UPDATE kinetic_scan_jobs SET status='failed',last_error='No permitted live evidence source is registered',completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`,
      )
      .run(id);
    event(record.tenant_id, id, "recheck", "failed", { reason: "offline" });
    runtimes.delete(id);
    return;
  }
  rawDb
    .prepare(
      `UPDATE kinetic_scan_jobs SET status='running',started_at=COALESCE(started_at,datetime('now')),last_heartbeat=datetime('now') WHERE id=?`,
    )
    .run(id);
  event(record.tenant_id, id, "recheck", "started", {
    source: gateway.status().source,
    mode: gateway.status().mode,
  });
  const rows = rawDb
    .prepare(
      `SELECT a.id,a.address,a.city,a.state,a.zip FROM kinetic_addresses a LEFT JOIN kinetic_address_state s ON s.address_id=a.id
    WHERE a.tenant_id=? AND a.address IS NOT NULL AND a.city IS NOT NULL AND a.state IS NOT NULL AND a.zip IS NOT NULL
    ORDER BY CASE s.discovery_state WHEN 'CANDIDATE_FRESH' THEN 0 WHEN 'REGRESSED' THEN 1 WHEN 'NON_FIBER' THEN 2 WHEN 'BASELINE_FIBER' THEN 3 ELSE 4 END,a.last_checked_at ASC`,
    )
    .all(record.tenant_id) as any[];
  try {
    for (const row of rows) {
      if (runtime.stopped) break;
      const tick = Date.now();
      let live = 0,
        errors = 0;
      const itemKey = `address:${row.id}`;
      rawDb
        .prepare(
          `INSERT INTO kinetic_scan_job_items (tenant_id,job_id,item_key,status,attempts,lease_owner,lease_expires_at)
        VALUES (?,?,?,'leased',1,?,datetime('now','+2 minutes')) ON CONFLICT(job_id,item_key) DO UPDATE SET status='leased',attempts=attempts+1,lease_owner=excluded.lease_owner,lease_expires_at=excluded.lease_expires_at,updated_at=datetime('now')`,
        )
        .run(record.tenant_id, id, itemKey, `process:${process.pid}`);
      try {
        const response = await gateway.qualifyAddress(
          {
            address: row.address,
            city: row.city,
            state: row.state,
            zip: row.zip,
            unit: null,
          },
          runtime.controller.signal,
        );
        if (response.outcome === "ok" && response.record) {
          upsertKineticAddress(record.tenant_id, id, response.record);
          live = response.record.isLive === true ? 1 : 0;
        }
        rawDb
          .prepare(
            `UPDATE kinetic_scan_job_items SET status='completed',completed_at=datetime('now'),lease_owner=NULL,lease_expires_at=NULL,updated_at=datetime('now') WHERE job_id=? AND item_key=?`,
          )
          .run(id, itemKey);
      } catch (error) {
        if (runtime.stopped) break;
        errors = 1;
        const message = error instanceof Error ? error.message : String(error);
        rawDb
          .prepare(
            `UPDATE kinetic_scan_job_items SET status=?,last_error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=datetime('now') WHERE job_id=? AND item_key=?`,
          )
          .run(
            error instanceof KineticEvidenceUnavailableError &&
              ["ACCESS_DENIED", "CHALLENGE", "CIRCUIT_OPEN"].includes(
                error.code,
              )
              ? "dead_letter"
              : "failed",
            message,
            id,
            itemKey,
          );
        heartbeat(id, { last_error: message });
        if (
          error instanceof KineticEvidenceUnavailableError &&
          (["ACCESS_DENIED", "CHALLENGE", "CIRCUIT_OPEN", "OFFLINE"].includes(
            error.code,
          ) ||
            gateway.status().circuitOpen)
        )
          throw error;
      }
      rawDb
        .prepare(
          `UPDATE kinetic_scan_jobs SET checked=checked+1,live=live+?,errors=errors+?,last_heartbeat=datetime('now'),updated_at=datetime('now') WHERE id=?`,
        )
        .run(live, errors, id);
      const remaining = minDelay() - (Date.now() - tick);
      if (remaining > 0) await delay(remaining);
    }
    const status = runtime.stopped ? "stopped" : "completed";
    rawDb
      .prepare(
        `UPDATE kinetic_scan_jobs SET status=?,completed_at=CASE WHEN ?='completed' THEN datetime('now') ELSE completed_at END,last_heartbeat=datetime('now'),updated_at=datetime('now') WHERE id=?`,
      )
      .run(status, status, id);
    event(record.tenant_id, id, "recheck", status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    rawDb
      .prepare(
        `UPDATE kinetic_scan_jobs SET status='failed',last_error=?,completed_at=datetime('now'),last_heartbeat=datetime('now'),updated_at=datetime('now') WHERE id=?`,
      )
      .run(message, id);
    event(record.tenant_id, id, "recheck", "failed", {
      message,
      circuit: gateway.status(),
    });
  } finally {
    runtimes.delete(id);
  }
}

function active(tenantId: number): any {
  return rawDb
    .prepare(
      `SELECT id FROM kinetic_scan_jobs WHERE tenant_id=? AND worker_type='recheck' AND status IN ('queued','running','paused') LIMIT 1`,
    )
    .get(tenantId);
}

export function startKineticScan(): never {
  throw new Error(
    "Sequential range scanning is unavailable because no permitted enumeration contract exists.",
  );
}
export function startKineticRecheck(input: {
  tenantId: number;
  createdBy?: number | null;
}): string {
  if (!getKineticEvidenceGateway().supportsLiveQualification())
    throw new Error(
      "Live rechecks are offline until a permitted evidence source is registered.",
    );
  if (active(input.tenantId))
    throw new Error("A recheck worker is already active");
  const id = createKineticJob({
    tenantId: input.tenantId,
    workerType: "recheck",
    createdBy: input.createdBy,
  });
  void runRecheck(id);
  return id;
}
export function pauseKineticScan(): boolean {
  return false;
}
export function resumeKineticScan(): boolean {
  return false;
}
export function stopKineticWorker(
  tenantId: number,
  type: "scan" | "recheck",
): boolean {
  if (type === "scan") return false;
  const current = active(tenantId);
  if (!current) return false;
  const runtime = runtimes.get(current.id);
  if (runtime) {
    runtime.stopped = true;
    runtime.controller.abort();
  }
  rawDb
    .prepare(
      `UPDATE kinetic_scan_jobs SET status='stopped',updated_at=datetime('now') WHERE id=?`,
    )
    .run(current.id);
  event(tenantId, current.id, type, "stop_requested");
  return true;
}
export function resumeKineticWorkersAfterRestart(): void {
  rawDb
    .prepare(
      `UPDATE kinetic_scan_jobs SET status='failed',last_error='Stopped after restart: no permitted Sequential ID enumeration contract exists',completed_at=datetime('now'),updated_at=datetime('now') WHERE worker_type='scan' AND status IN ('queued','running','paused')`,
    )
    .run();
  const interrupted = rawDb
    .prepare(
      `SELECT id FROM kinetic_scan_jobs WHERE worker_type='recheck' AND status IN ('queued','running')`,
    )
    .all() as any[];
  for (const row of interrupted) setTimeout(() => void runRecheck(row.id), 25);
}
