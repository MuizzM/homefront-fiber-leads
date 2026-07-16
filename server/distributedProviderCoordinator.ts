import crypto from "node:crypto";
import { rawDb } from "./db";
import type { ProviderRequestPriority } from "./providerRequestQueue";

const priorityValue: Record<ProviderRequestPriority, number> = {
  manual: 500,
  lasso: 400,
  coming_soon: 350,
  recheck: 300,
  market: 275,
  nightly: 250,
  city: 200,
};

export interface DistributedProviderSnapshot {
  active: number;
  queued: number;
  startsLastMinute: number;
  maxConcurrency: number;
  maxRequestsPerMinute: number;
  instanceId: string;
}

interface Options {
  maxConcurrency: number;
  maxRequestsPerMinute: number;
  resultCacheTtlMs: number;
  leaseMs?: number;
  pollMs?: number;
  /** Test-only clock window override. Production always uses the default minute. */
  rateWindowMs?: number;
  now?: () => number;
}

/**
 * SQLite-backed admission coordinator. All app instances sharing DATA_DIR use
 * the same durable priority queue, semaphore, rolling requests-per-minute
 * ledger, pause/halt
 * state, address locks, and short result cache. No bearer/proxy secrets are
 * persisted here.
 */
export class DistributedProviderCoordinator<T> {
  private readonly maxConcurrency: number;
  private readonly maxRequestsPerMinute: number;
  private readonly resultCacheTtlMs: number;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly rateWindowMs: number;
  private readonly minimumStartSpacingMs: number;
  private readonly rollingAdmissionLimit: number;
  private readonly now: () => number;
  private readonly instanceId = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

  constructor(options: Options) {
    this.maxConcurrency = bounded(options.maxConcurrency, 1, 50, 45);
    this.maxRequestsPerMinute = bounded(options.maxRequestsPerMinute, 1, 60_000, 100);
    this.resultCacheTtlMs = Math.max(0, Math.floor(options.resultCacheTtlMs));
    this.leaseMs = Math.max(10_000, Math.floor(options.leaseMs ?? 30_000));
    this.pollMs = Math.max(10, Math.floor(options.pollMs ?? 30));
    this.rateWindowMs = bounded(options.rateWindowMs ?? 60_000, 100, 60_000, 60_000);
    // Pace slightly inside the theoretical interval so DB/polling overhead does
    // not reduce useful throughput. The strict rolling-window count below is
    // still authoritative and makes it impossible to exceed the minute quota.
    this.minimumStartSpacingMs = Math.max(
      1,
      Math.floor((this.rateWindowMs / this.maxRequestsPerMinute) * 0.9),
    );
    // Leave one admission of guard-band for the sub-millisecond gap between a
    // committed DB lease and the actual outbound fetch. This keeps observed
    // provider starts at or below the configured quota at rolling boundaries.
    const boundaryGuard = Math.max(1, Math.ceil(this.maxRequestsPerMinute * 0.03));
    this.rollingAdmissionLimit = this.maxRequestsPerMinute === 1
      ? 1
      : Math.max(1, this.maxRequestsPerMinute - boundaryGuard);
    this.now = options.now ?? Date.now;
    ensureSchema();
  }

  async execute(
    key: string,
    source: ProviderRequestPriority,
    task: () => Promise<T>,
    options: { cacheable: (value: T) => boolean; serialize: (value: T) => string; deserialize: (value: string) => T },
  ): Promise<T> {
    const cached = this.readResult(key, options.deserialize);
    if (cached !== undefined) return cached;
    const lockOwner = `${this.instanceId}:${crypto.randomUUID()}`;
    for (;;) {
      if (this.tryAddressLock(key, lockOwner)) break;
      const shared = this.readResult(key, options.deserialize);
      if (shared !== undefined) return shared;
      await sleep(this.pollMs);
    }

    const secondCheck = this.readResult(key, options.deserialize);
    if (secondCheck !== undefined) {
      this.releaseAddressLock(key, lockOwner);
      return secondCheck;
    }

    const workId = crypto.randomUUID();
    rawDb.prepare(`INSERT INTO provider_admission_queue
      (id,dedupe_key,source,priority,instance_id,state,enqueued_at,updated_at)
      VALUES (?,?,?,?,?,'queued',?,?)`)
      .run(workId, key, source, priorityValue[source], this.instanceId, this.now(), this.now());
    try {
      await this.awaitAdmission(workId);
      const heartbeat = setInterval(() => {
        try {
          rawDb.prepare(`UPDATE provider_admission_queue SET lease_expires_at=?,updated_at=? WHERE id=? AND state='active'`)
            .run(this.now() + this.leaseMs, this.now(), workId);
          rawDb.prepare(`UPDATE provider_address_locks SET expires_at=? WHERE dedupe_key=? AND owner_id=?`)
            .run(this.now() + this.leaseMs, key, lockOwner);
        } catch { /* the owning request will fail closed if its DB work later fails */ }
      }, Math.max(2_000, Math.floor(this.leaseMs / 3)));
      if (typeof (heartbeat as any).unref === "function") (heartbeat as any).unref();
      try {
        const value = await task();
        if (this.resultCacheTtlMs > 0 && options.cacheable(value)) {
          const payload = options.serialize(value);
          rawDb.prepare(`INSERT INTO provider_shared_result_cache (dedupe_key,payload,expires_at,updated_at)
            VALUES (?,?,?,?) ON CONFLICT(dedupe_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
            .run(key, payload, this.now() + this.resultCacheTtlMs, this.now());
        }
        this.complete(workId, "completed", null);
        return value;
      } catch (error) {
        this.complete(workId, "failed", String((error as any)?.message ?? error).slice(0, 180));
        throw error;
      } finally {
        clearInterval(heartbeat);
      }
    } finally {
      this.releaseAddressLock(key, lockOwner);
    }
  }

  snapshot(): DistributedProviderSnapshot {
    this.cleanup();
    const now = this.now();
    const counts = rawDb.prepare(`SELECT
      SUM(CASE WHEN state='active' THEN 1 ELSE 0 END) active,
      SUM(CASE WHEN state='queued' THEN 1 ELSE 0 END) queued
      FROM provider_admission_queue WHERE state IN ('active','queued')`).get() as any;
    const starts = Number((rawDb.prepare(`SELECT COUNT(*) count FROM provider_rate_events WHERE started_at>?`).get(now - this.rateWindowMs) as any)?.count ?? 0);
    return {
      active: Number(counts?.active ?? 0), queued: Number(counts?.queued ?? 0), startsLastMinute: starts,
      maxConcurrency: this.maxConcurrency, maxRequestsPerMinute: this.maxRequestsPerMinute,
      instanceId: this.instanceId,
    };
  }

  private async awaitAdmission(workId: string): Promise<void> {
    for (;;) {
      const decision = rawDb.transaction(() => {
        this.cleanup();
        const now = this.now();
        const control = this.control();
        const nextStartAt = Number(control.next_start_at ?? 0);
        if (nextStartAt > now) return { admitted: false, waitMs: Math.max(this.pollMs, nextStartAt - now) };
        const head = rawDb.prepare(`SELECT id FROM provider_admission_queue WHERE state='queued'
          ORDER BY priority DESC,enqueued_at ASC,id ASC LIMIT 1`).get() as any;
        if (!head || head.id !== workId) return { admitted: false, waitMs: this.pollMs };
        const active = Number((rawDb.prepare(`SELECT COUNT(*) count FROM provider_admission_queue WHERE state='active'`).get() as any).count);
        const starts = Number((rawDb.prepare(`SELECT COUNT(*) count FROM provider_rate_events WHERE started_at>?`).get(now - this.rateWindowMs) as any).count);
        if (active >= this.maxConcurrency || starts >= this.rollingAdmissionLimit) {
          const oldest = rawDb.prepare(`SELECT MIN(started_at) startedAt FROM provider_rate_events WHERE started_at>?`).get(now - this.rateWindowMs) as any;
          return { admitted: false, waitMs: starts >= this.rollingAdmissionLimit && oldest?.startedAt
            ? Math.max(this.pollMs, Number(oldest.startedAt) + this.rateWindowMs - now) : this.pollMs };
        }
        rawDb.prepare(`UPDATE provider_admission_queue SET state='active',started_at=?,lease_expires_at=?,updated_at=? WHERE id=? AND state='queued'`)
          .run(now, now + this.leaseMs, now, workId);
        rawDb.prepare(`INSERT INTO provider_rate_events (work_id,started_at) VALUES (?,?)`).run(workId, now);
        rawDb.prepare(`UPDATE provider_global_control SET next_start_at=?,updated_at=? WHERE id=1`)
          .run(now + this.minimumStartSpacingMs, now);
        return { admitted: true, waitMs: 0 };
      }).immediate();
      if (decision.admitted) return;
      await sleep(decision.waitMs);
    }
  }

  private cleanup(): void {
    const now = this.now();
    rawDb.prepare(`DELETE FROM provider_rate_events WHERE started_at<=?`).run(now - this.rateWindowMs - 1_000);
    rawDb.prepare(`UPDATE provider_admission_queue SET state='expired',updated_at=? WHERE state='active' AND lease_expires_at<=?`).run(now, now);
    rawDb.prepare(`DELETE FROM provider_address_locks WHERE expires_at<=?`).run(now);
    rawDb.prepare(`DELETE FROM provider_shared_result_cache WHERE expires_at<=?`).run(now);
    rawDb.prepare(`DELETE FROM provider_admission_queue WHERE state IN ('completed','failed','expired') AND updated_at<=?`).run(now - 60 * 60_000);
  }

  private tryAddressLock(key: string, owner: string): boolean {
    const now = this.now();
    return rawDb.transaction(() => {
      rawDb.prepare(`DELETE FROM provider_address_locks WHERE dedupe_key=? AND expires_at<=?`).run(key, now);
      return rawDb.prepare(`INSERT OR IGNORE INTO provider_address_locks (dedupe_key,owner_id,expires_at,created_at) VALUES (?,?,?,?)`)
        .run(key, owner, now + this.leaseMs, now).changes === 1;
    }).immediate();
  }

  private releaseAddressLock(key: string, owner: string): void {
    rawDb.prepare(`DELETE FROM provider_address_locks WHERE dedupe_key=? AND owner_id=?`).run(key, owner);
  }

  private readResult(key: string, deserialize: (value: string) => T): T | undefined {
    const row = rawDb.prepare(`SELECT payload FROM provider_shared_result_cache WHERE dedupe_key=? AND expires_at>?`).get(key, this.now()) as any;
    if (!row?.payload) return undefined;
    try { return deserialize(row.payload); }
    catch {
      rawDb.prepare(`DELETE FROM provider_shared_result_cache WHERE dedupe_key=?`).run(key);
      return undefined;
    }
  }

  private complete(id: string, state: "completed" | "failed", error: string | null): void {
    rawDb.prepare(`UPDATE provider_admission_queue SET state=?,last_error=?,lease_expires_at=NULL,completed_at=?,updated_at=? WHERE id=?`)
      .run(state, error, this.now(), this.now(), id);
  }

  private control(): any {
    return rawDb.prepare(`SELECT next_start_at FROM provider_global_control WHERE id=1`).get() as any;
  }
}

export function ensureSchema(): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS provider_admission_queue (
      id TEXT PRIMARY KEY,dedupe_key TEXT NOT NULL,source TEXT NOT NULL,priority INTEGER NOT NULL,
      instance_id TEXT NOT NULL,state TEXT NOT NULL,enqueued_at INTEGER NOT NULL,started_at INTEGER,
      lease_expires_at INTEGER,completed_at INTEGER,last_error TEXT,updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_provider_admission_order ON provider_admission_queue(state,priority DESC,enqueued_at,id);
    CREATE INDEX IF NOT EXISTS idx_provider_admission_lease ON provider_admission_queue(state,lease_expires_at);
    CREATE TABLE IF NOT EXISTS provider_rate_events (id INTEGER PRIMARY KEY AUTOINCREMENT,work_id TEXT NOT NULL,started_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_provider_rate_started ON provider_rate_events(started_at);
    CREATE TABLE IF NOT EXISTS provider_address_locks (dedupe_key TEXT PRIMARY KEY,owner_id TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS provider_shared_result_cache (dedupe_key TEXT PRIMARY KEY,payload TEXT NOT NULL,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_provider_shared_cache_expiry ON provider_shared_result_cache(expires_at);
    CREATE TABLE IF NOT EXISTS provider_global_control (id INTEGER PRIMARY KEY CHECK(id=1),next_start_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
    INSERT OR IGNORE INTO provider_global_control (id,updated_at) VALUES (1,0);
  `);
  // ── Migration: the scanner has NO persistent halt/pause state. Ensure
  //    next_start_at exists on older DBs, then DROP the legacy halt/pause columns
  //    so a prior 403 can never survive a restart and wedge scanning at 0 checked.
  const controlColumns = new Set(
    (rawDb.prepare(`PRAGMA table_info(provider_global_control)`).all() as Array<{ name: string }>).map(c => c.name),
  );
  if (!controlColumns.has("next_start_at")) {
    rawDb.exec(`ALTER TABLE provider_global_control ADD COLUMN next_start_at INTEGER NOT NULL DEFAULT 0`);
  }
  for (const legacy of ["halted", "halt_reason", "paused_until"]) {
    if (controlColumns.has(legacy)) {
      try { rawDb.exec(`ALTER TABLE provider_global_control DROP COLUMN ${legacy}`); }
      catch { /* SQLite too old for DROP COLUMN — column is simply left unused */ }
    }
  }
  // ── Clean stale admission state on boot. Admission tickets, address locks, and
  //    rate events are per-process and in-flight only; nothing here survives a
  //    restart, so leftover rows are stale and would otherwise pin the admission
  //    head. Scan progress lives in scan_runs/run_targets, not here — never lost.
  //    (Single app instance in production; revisit the blanket delete if scaled out.)
  rawDb.exec(`
    DELETE FROM provider_admission_queue;
    DELETE FROM provider_address_locks;
    DELETE FROM provider_rate_events;
    UPDATE provider_global_control SET next_start_at=0 WHERE id=1;
  `);
}

function bounded(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(1, Math.ceil(ms))));
