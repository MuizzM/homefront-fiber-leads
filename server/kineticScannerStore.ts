import crypto from "node:crypto";
import { rawDb } from "./db";
import type { NormalizedKineticAddress } from "./kineticProviderAdapter";

export function ensureKineticScannerSchema(): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS kinetic_scanner_state (
      tenant_id INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      upper_limit INTEGER NOT NULL DEFAULT 0,
      current_sequential_id INTEGER NOT NULL DEFAULT 0,
      concurrency INTEGER NOT NULL DEFAULT 1,
      requests_per_second REAL NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS kinetic_scan_jobs (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      worker_type TEXT NOT NULL CHECK(worker_type IN ('scan','recheck')),
      start_sequential_id INTEGER,
      end_sequential_id INTEGER,
      current_sequential_id INTEGER,
      checked INTEGER NOT NULL DEFAULT 0,
      found INTEGER NOT NULL DEFAULT 0,
      live INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('queued','running','paused','stopped','completed','failed')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      last_heartbeat TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_kinetic_jobs_tenant_status ON kinetic_scan_jobs(tenant_id,status,updated_at DESC);
    CREATE TABLE IF NOT EXISTS kinetic_addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      kinetic_address_id TEXT,
      sequential_id INTEGER,
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      latitude REAL,
      longitude REAL,
      exchange_id TEXT,
      technology_type TEXT,
      maximum_qualification REAL,
      estimated_completion_date TEXT,
      is_live INTEGER,
      is_coming_soon INTEGER,
      is_copper_upgrade_candidate INTEGER,
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      contact_enrichment_status TEXT NOT NULL DEFAULT 'not_requested',
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_status_change_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, kinetic_address_id),
      UNIQUE(tenant_id, sequential_id)
    );
    CREATE INDEX IF NOT EXISTS idx_kinetic_addresses_filters ON kinetic_addresses(tenant_id,state,is_live,is_coming_soon,is_copper_upgrade_candidate);
    CREATE INDEX IF NOT EXISTS idx_kinetic_addresses_location ON kinetic_addresses(tenant_id,latitude,longitude);
    CREATE INDEX IF NOT EXISTS idx_kinetic_addresses_checked ON kinetic_addresses(tenant_id,last_checked_at);
    CREATE TABLE IF NOT EXISTS kinetic_address_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      address_id INTEGER REFERENCES kinetic_addresses(id) ON DELETE CASCADE,
      job_id TEXT REFERENCES kinetic_scan_jobs(id) ON DELETE SET NULL,
      sequential_id INTEGER,
      kinetic_address_id TEXT,
      response_hash TEXT NOT NULL,
      raw_response_json TEXT NOT NULL,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id,response_hash,job_id,sequential_id)
    );
    CREATE INDEX IF NOT EXISTS idx_kinetic_observations_address ON kinetic_address_observations(tenant_id,address_id,observed_at DESC);
    CREATE TABLE IF NOT EXISTS kinetic_address_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      address_id INTEGER NOT NULL REFERENCES kinetic_addresses(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL,
      previous_value TEXT,
      current_value TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_kinetic_changes_recent ON kinetic_address_changes(tenant_id,observed_at DESC);
    CREATE TABLE IF NOT EXISTS kinetic_address_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      address_id INTEGER NOT NULL REFERENCES kinetic_addresses(id) ON DELETE CASCADE,
      name TEXT,
      phone_last4 TEXT,
      provider TEXT,
      confidence REAL,
      refreshed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id,address_id,provider)
    );
    CREATE TABLE IF NOT EXISTS kinetic_worker_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      job_id TEXT REFERENCES kinetic_scan_jobs(id) ON DELETE SET NULL,
      worker_type TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_kinetic_events_recent ON kinetic_worker_events(tenant_id,created_at DESC);

    DROP TABLE IF EXISTS cns_job_events;
    DROP TABLE IF EXISTS cns_scan_observations;
    DROP TABLE IF EXISTS cns_scan_jobs;
    DROP TABLE IF EXISTS cns_national_frontiers;
    DROP TABLE IF EXISTS cns_scanner_settings;
    DROP TABLE IF EXISTS cns_classification_rules;
    DROP TABLE IF EXISTS cns_probes;
    DROP TABLE IF EXISTS cns_city_index;
    DROP TABLE IF EXISTS cns_probes_legacy;
    DROP TABLE IF EXISTS coming_soon_addresses;
  `);
}

function boolDb(value: boolean | null): number | null { return value == null ? null : value ? 1 : 0; }
function changed(previous: unknown, next: unknown): boolean { return previous !== null && next !== null && String(previous) !== String(next); }

export function upsertKineticAddress(tenantId: number, jobId: string | null, result: NormalizedKineticAddress): { id: number; inserted: boolean; changed: boolean } {
  const existing = rawDb.prepare(`SELECT * FROM kinetic_addresses WHERE tenant_id=? AND ((kinetic_address_id IS NOT NULL AND kinetic_address_id=?) OR (sequential_id IS NOT NULL AND sequential_id=?)) LIMIT 1`)
    .get(tenantId,result.kineticAddressId,result.sequentialId) as any;
  const fields: Array<[string, unknown, unknown]> = existing ? [
    ["live_status", existing.is_live, boolDb(result.isLive)],
    ["coming_soon_status", existing.is_coming_soon, boolDb(result.isComingSoon)],
    ["copper_upgrade_candidate", existing.is_copper_upgrade_candidate, boolDb(result.isCopperUpgradeCandidate)],
    ["technology_type", existing.technology_type, result.technologyType],
    ["maximum_qualification", existing.maximum_qualification, result.maximumQualification],
    ["estimated_completion_date", existing.estimated_completion_date, result.estimatedCompletionDate],
  ] : [];
  const statusChanged = fields.some(([,before,after]) => changed(before,after));
  let id: number;
  if (existing) {
    id = existing.id;
    rawDb.prepare(`UPDATE kinetic_addresses SET kinetic_address_id=COALESCE(?,kinetic_address_id),sequential_id=COALESCE(?,sequential_id),
      address=COALESCE(?,address),city=COALESCE(?,city),state=COALESCE(?,state),zip=COALESCE(?,zip),latitude=COALESCE(?,latitude),longitude=COALESCE(?,longitude),
      exchange_id=COALESCE(?,exchange_id),technology_type=COALESCE(?,technology_type),maximum_qualification=COALESCE(?,maximum_qualification),
      estimated_completion_date=COALESCE(?,estimated_completion_date),is_live=COALESCE(?,is_live),is_coming_soon=COALESCE(?,is_coming_soon),
      is_copper_upgrade_candidate=COALESCE(?,is_copper_upgrade_candidate),last_checked_at=datetime('now'),
      last_status_change_at=CASE WHEN ? THEN datetime('now') ELSE last_status_change_at END,updated_at=datetime('now') WHERE id=?`)
      .run(result.kineticAddressId,result.sequentialId,result.address,result.city,result.state,result.zip,result.latitude,result.longitude,result.exchangeId,
        result.technologyType,result.maximumQualification,result.estimatedCompletionDate,boolDb(result.isLive),boolDb(result.isComingSoon),boolDb(result.isCopperUpgradeCandidate),statusChanged?1:0,id);
  } else {
    const info = rawDb.prepare(`INSERT INTO kinetic_addresses (tenant_id,kinetic_address_id,sequential_id,address,city,state,zip,latitude,longitude,exchange_id,
      technology_type,maximum_qualification,estimated_completion_date,is_live,is_coming_soon,is_copper_upgrade_candidate)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(tenantId,result.kineticAddressId,result.sequentialId,result.address,result.city,result.state,result.zip,
        result.latitude,result.longitude,result.exchangeId,result.technologyType,result.maximumQualification,result.estimatedCompletionDate,boolDb(result.isLive),
        boolDb(result.isComingSoon),boolDb(result.isCopperUpgradeCandidate));
    id = Number(info.lastInsertRowid);
  }
  rawDb.prepare(`INSERT OR IGNORE INTO kinetic_address_observations (tenant_id,address_id,job_id,sequential_id,kinetic_address_id,response_hash,raw_response_json)
    VALUES (?,?,?,?,?,?,?)`).run(tenantId,id,jobId,result.sequentialId,result.kineticAddressId,result.responseHash,JSON.stringify(result.rawResponse));
  if (existing) {
    const insertChange = rawDb.prepare(`INSERT INTO kinetic_address_changes (tenant_id,address_id,field_name,previous_value,current_value) VALUES (?,?,?,?,?)`);
    for (const [field,before,after] of fields) if (changed(before,after)) insertChange.run(tenantId,id,field,String(before),String(after));
  }
  return { id, inserted: !existing, changed: statusChanged };
}

export function createKineticJob(input: { tenantId: number; workerType: "scan"|"recheck"; start?: number; end?: number; createdBy?: number|null }): string {
  const id = crypto.randomUUID();
  rawDb.prepare(`INSERT INTO kinetic_scan_jobs (id,tenant_id,worker_type,start_sequential_id,end_sequential_id,current_sequential_id,status,created_by)
    VALUES (?,?,?,?,?,?, 'queued',?)`).run(id,input.tenantId,input.workerType,input.start??null,input.end??null,input.start??null,input.createdBy??null);
  event(input.tenantId,id,input.workerType,"queued",input);
  return id;
}

export function event(tenantId:number,jobId:string|null,workerType:string,eventType:string,payload:unknown={}): void {
  rawDb.prepare(`INSERT INTO kinetic_worker_events (tenant_id,job_id,worker_type,event_type,payload_json) VALUES (?,?,?,?,?)`)
    .run(tenantId,jobId,workerType,eventType,JSON.stringify(payload));
}

export function job(id:string): any { return rawDb.prepare(`SELECT * FROM kinetic_scan_jobs WHERE id=?`).get(id); }

export function scannerState(tenantId:number): any {
  const state = rawDb.prepare(`SELECT upper_limit AS upperLimit,current_sequential_id AS currentSequentialId,concurrency,requests_per_second AS requestsPerSecond FROM kinetic_scanner_state WHERE tenant_id=?`).get(tenantId) as any
    ?? { upperLimit:0,currentSequentialId:0,concurrency:1,requestsPerSecond:1 };
  const jobs = rawDb.prepare(`SELECT id,worker_type AS workerType,start_sequential_id AS startSequentialId,end_sequential_id AS endSequentialId,
    current_sequential_id AS currentSequentialId,checked,found,live,errors,status,last_heartbeat AS lastHeartbeat,last_error AS lastError,
    started_at AS startedAt,completed_at AS completedAt FROM kinetic_scan_jobs WHERE tenant_id=? ORDER BY created_at DESC LIMIT 50`).all(tenantId) as any[];
  return { ...state, scanWorker: jobs.find(j=>j.workerType==="scan")??null, recheckWorker: jobs.find(j=>j.workerType==="recheck")??null, jobs };
}

export function setScannerBounds(tenantId:number,current:number,upper:number): void {
  rawDb.prepare(`INSERT INTO kinetic_scanner_state (tenant_id,current_sequential_id,upper_limit) VALUES (?,?,?)
    ON CONFLICT(tenant_id) DO UPDATE SET current_sequential_id=excluded.current_sequential_id,upper_limit=excluded.upper_limit,updated_at=datetime('now')`).run(tenantId,current,upper);
}

export function stats(tenantId:number): any {
  const totals = rawDb.prepare(`SELECT COUNT(*) AS totalAddresses,SUM(CASE WHEN is_live=1 THEN 1 ELSE 0 END) AS liveFiber,
    SUM(CASE WHEN is_copper_upgrade_candidate=1 THEN 1 ELSE 0 END) AS copperUpgrade FROM kinetic_addresses WHERE tenant_id=?`).get(tenantId) as any;
  const cycle = rawDb.prepare(`SELECT COALESCE(SUM(errors),0) AS errorsThisCycle,COALESCE(SUM(checked),0) AS checked,
    COALESCE(SUM(found),0) AS found,COALESCE(SUM(live),0) AS live FROM kinetic_scan_jobs WHERE tenant_id=? AND created_at>=date('now')`).get(tenantId) as any;
  return { totalAddresses:Number(totals?.totalAddresses??0),liveFiber:Number(totals?.liveFiber??0),copperUpgrade:Number(totals?.copperUpgrade??0),
    errorsThisCycle:Number(cycle?.errorsThisCycle??0),checked:Number(cycle?.checked??0),found:Number(cycle?.found??0),live:Number(cycle?.live??0) };
}

export function clearKineticData(tenantId:number): void {
  rawDb.transaction(()=>{ for(const table of ["kinetic_address_contacts","kinetic_address_changes","kinetic_address_observations","kinetic_worker_events","kinetic_addresses","kinetic_scan_jobs","kinetic_scanner_state"]) rawDb.prepare(`DELETE FROM ${table} WHERE tenant_id=?`).run(tenantId); })();
}
