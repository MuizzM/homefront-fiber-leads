import crypto from "node:crypto";
import { rawDb } from "./db";
import type { ProviderRequestPriority } from "./providerRequestQueue";

const priorityValue: Record<ProviderRequestPriority, number> = {
  manual: 500,
  lasso: 400,
  new_build: 380,
  coming_soon: 375,
  discovery: 370,
  expansion: 365, // lead-cluster expansion — above bulk, below immediate, share-capped
  recheck: 300,
  market: 275,
  nightly: 250,
  city: 200,
};

// Five weighted-fair admission CLASSES. Revenue classes (IMMEDIATE/NEW_BUILD/DISCOVERY)
// are guaranteed capacity because the non-revenue classes (EXPANSION/MAINTENANCE) are
// SHARE-CAPPED below full concurrency — a burst of expansion or bulk maintenance can
// never occupy every slot, and priority ordering + aging decide the rest.
export type AdmissionClass = "IMMEDIATE" | "NEW_BUILD" | "DISCOVERY" | "EXPANSION" | "MAINTENANCE";
export function admissionClassOf(source: ProviderRequestPriority): AdmissionClass {
  switch (source) {
    case "manual": case "lasso": return "IMMEDIATE";
    case "new_build": case "coming_soon": return "NEW_BUILD";
    case "discovery": return "DISCOVERY";
    case "expansion": return "EXPANSION";
    default: return "MAINTENANCE"; // recheck/market/nightly/city
  }
}
// SQL source lists per share-capped class (used to count active + exclude from head).
const EXPANSION_SOURCES = "'expansion'";
const MAINTENANCE_SOURCES = "'recheck','market','nightly','city'";
// Revenue classes: guaranteed capacity + fast-resumed on boot (they produce leads).
export function isRevenueAdmissionClass(source: ProviderRequestPriority): boolean {
  const c = admissionClassOf(source);
  return c === "IMMEDIATE" || c === "NEW_BUILD" || c === "DISCOVERY";
}

// CRITICAL tier = immediate checks that must never be starved by bulk scanning:
// new builds, Field Map / lasso, manual, and admin-triggered checks. Everything
// below (coming_soon/recheck/market/nightly/city — statewide + county sweeps) is
// NORMAL. Priority ordering alone isn't enough under sustained NORMAL pressure:
// a CRITICAL head still waits for a NORMAL in-flight slot to free. So NORMAL is
// held below the concurrency + per-window rate ceilings, leaving reserved capacity
// only CRITICAL can occupy — bulk work can never consume the last slots.
export const CRITICAL_PRIORITY_CUTOFF = priorityValue.new_build; // 380
export function isCriticalPriority(source: ProviderRequestPriority): boolean {
  return priorityValue[source] >= CRITICAL_PRIORITY_CUTOFF;
}

/**
 * Thrown when a request waits past the admission deadline without being admitted.
 * NOT a provider/no-service answer — the scan worker treats it as a transient
 * miss and requeues the address. Its purpose is to guarantee a worker's
 * `await execute()` ALWAYS returns in bounded time, so a saturated coordinator
 * can never leave a target 'inflight' forever (which deadlocked whole runs:
 * the reaper skips a run whose worker is still "alive" but permanently blocked).
 */
export class AdmissionTimeoutError extends Error {
  readonly transient = true;
  constructor(waitedMs: number) {
    super(`admission not granted within ${waitedMs}ms (requeue + retry)`);
    this.name = "AdmissionTimeoutError";
  }
}

export interface DistributedProviderSnapshot {
  active: number;
  queued: number;
  activeCritical: number;
  queuedCritical: number;
  startsLastMinute: number;
  maxConcurrency: number;
  maxRequestsPerMinute: number;
  criticalReservedConcurrency: number;
  /** Live per-class active + queued admissions (weighted-fair shares, for ops/report). */
  byClass: Record<AdmissionClass, { active: number; queued: number }>;
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
  /** Concurrency slots held in reserve for CRITICAL work (never usable by NORMAL). */
  criticalReservedConcurrency?: number;
  /** Per-window admission starts held in reserve for CRITICAL work. */
  criticalReservedRate?: number;
  /** Max time a request may wait for admission before it gives up (requeue). */
  admissionMaxWaitMs?: number;
  /** Priority points a queued item gains per second of waiting (anti-starvation). */
  agingRatePerSec?: number;
  /** Cap on the aging boost, so NORMAL climbs into — not far above — CRITICAL. */
  agingMaxBoost?: number;
  /** Fraction of concurrency the EXPANSION class may hold at once (0 = uncapped). */
  expansionShareFraction?: number;
  /** Fraction of concurrency the MAINTENANCE class may hold at once (0 = uncapped). */
  maintenanceShareFraction?: number;
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
  private readonly criticalReservedConcurrency: number;
  private readonly criticalReservedRate: number;
  private readonly admissionMaxWaitMs: number;
  private readonly agingRatePerSec: number;
  private readonly agingMaxBoost: number;
  private readonly expansionMaxActive: number;
  private readonly maintenanceMaxActive: number;
  private readonly now: () => number;
  private readonly instanceId = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

  constructor(options: Options) {
    this.maxConcurrency = bounded(options.maxConcurrency, 1, 500, 45);
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
    // Reserve capacity for CRITICAL. Opt-in (default 0 = no reservation), set
    // explicitly in production. Bounded so NORMAL always keeps at least one usable
    // slot (a reservation that starves NORMAL entirely would deadlock it).
    this.criticalReservedConcurrency = bounded(options.criticalReservedConcurrency ?? 0, 0, Math.max(0, this.maxConcurrency - 1), 0);
    this.criticalReservedRate = bounded(options.criticalReservedRate ?? 0, 0, Math.max(0, this.rollingAdmissionLimit - 1), 0);
    // A request may not wait for admission forever. When the coordinator is
    // saturated (e.g. a sustained CRITICAL flood), a NORMAL request gives up after
    // this deadline and the scan worker requeues its address — the worker keeps
    // looping (heartbeating) instead of hanging, so runs never deadlock.
    this.admissionMaxWaitMs = Math.max(100, Math.floor(options.admissionMaxWaitMs ?? 120_000));
    // Aging: a queued item earns priority the longer it waits, guaranteeing that
    // even under a permanent CRITICAL flood a NORMAL item eventually crosses the
    // CRITICAL cutoff — for BOTH ordering and the reserved-slot ceiling — and runs.
    // Bounded so aging lifts NORMAL into the CRITICAL band without burying fresh
    // CRITICAL work indefinitely. Sub-second unit tests see ~0 boost (no behavior
    // change); starvation only matters over tens of seconds of real backlog.
    this.agingRatePerSec = Math.max(0, Math.floor(options.agingRatePerSec ?? 4));
    // NORMAL items age (uncapped points, clamped to the cutoff) so bulk reaches the
    // CRITICAL band and never starves. This bound applies ONLY to the CRITICAL branch:
    // it is kept SMALL so an aged CRITICAL item stays just above aged-NORMAL (cutoff)
    // WITHOUT crossing the next tier boundary — e.g. an aged new_build (380) tops out
    // at 380+15=395, still below a fresh lasso (400)/manual (500). A large value here
    // caused a tier inversion (aged new_build outranking fresh manual).
    this.agingMaxBoost = Math.max(0, Math.floor(options.agingMaxBoost ?? 15));
    // Weighted-fair caps: EXPANSION and MAINTENANCE may each hold at most a fraction of
    // concurrency, so a burst of either can never crowd out the revenue classes
    // (IMMEDIATE/NEW_BUILD/DISCOVERY) — their combined headroom IS the revenue reserve.
    // Bounded to [1, maxConcurrency-1] so a capped class always gets SOME progress but
    // never all. Default 0 (uncapped) keeps existing unit tests — which use neither the
    // expansion source nor these fractions — behaviorally identical.
    const capSlots = (frac: number | undefined) => {
      const f = Math.max(0, Math.min(1, frac ?? 0));
      return f > 0 ? Math.max(1, Math.min(this.maxConcurrency - 1, Math.floor(this.maxConcurrency * f))) : this.maxConcurrency;
    };
    this.expansionMaxActive = capSlots(options.expansionShareFraction);
    this.maintenanceMaxActive = capSlots(options.maintenanceShareFraction);
    this.now = options.now ?? Date.now;
    ensureSchema();
  }

  async execute(
    key: string,
    source: ProviderRequestPriority,
    task: () => Promise<T>,
    options: {
      cacheable: (value: T) => boolean;
      serialize: (value: T) => string;
      deserialize: (value: string) => T;
      /** Optional cancellation predicate — polled WHILE waiting for admission. When it
       * returns true (e.g. the run was cancelled/paused), the request abandons the
       * wait immediately and the caller requeues the address instead of blocking for
       * up to admissionMaxWaitMs. */
      abort?: () => boolean;
    },
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
    // Heartbeat the address lock for this request's ENTIRE lifetime — crucially
    // INCLUDING the admission wait — so a long wait can never let the lock lease lapse
    // and admit a duplicate check of the same address on another worker/instance. Once
    // the row is 'active' the same tick also refreshes its admission lease.
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
      await this.awaitAdmission(workId, options.abort);
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
      this.releaseAddressLock(key, lockOwner);
    }
  }

  snapshot(): DistributedProviderSnapshot {
    this.cleanup();
    const now = this.now();
    const counts = rawDb.prepare(`SELECT
      SUM(CASE WHEN state='active' THEN 1 ELSE 0 END) active,
      SUM(CASE WHEN state='queued' THEN 1 ELSE 0 END) queued,
      SUM(CASE WHEN state='active' AND priority>=? THEN 1 ELSE 0 END) activeCritical,
      SUM(CASE WHEN state='queued' AND priority>=? THEN 1 ELSE 0 END) queuedCritical
      FROM provider_admission_queue WHERE state IN ('active','queued')`).get(CRITICAL_PRIORITY_CUTOFF, CRITICAL_PRIORITY_CUTOFF) as any;
    const starts = Number((rawDb.prepare(`SELECT COUNT(*) count FROM provider_rate_events WHERE started_at>?`).get(now - this.rateWindowMs) as any)?.count ?? 0);
    const byClass: Record<AdmissionClass, { active: number; queued: number }> = {
      IMMEDIATE: { active: 0, queued: 0 }, NEW_BUILD: { active: 0, queued: 0 },
      DISCOVERY: { active: 0, queued: 0 }, EXPANSION: { active: 0, queued: 0 }, MAINTENANCE: { active: 0, queued: 0 },
    };
    for (const row of rawDb.prepare(`SELECT source, state, COUNT(*) c FROM provider_admission_queue
      WHERE state IN ('active','queued') GROUP BY source, state`).all() as any[]) {
      const cls = admissionClassOf(row.source as ProviderRequestPriority);
      if (row.state === "active") byClass[cls].active += Number(row.c);
      else byClass[cls].queued += Number(row.c);
    }
    return {
      active: Number(counts?.active ?? 0), queued: Number(counts?.queued ?? 0),
      activeCritical: Number(counts?.activeCritical ?? 0), queuedCritical: Number(counts?.queuedCritical ?? 0),
      startsLastMinute: starts,
      maxConcurrency: this.maxConcurrency, maxRequestsPerMinute: this.maxRequestsPerMinute,
      criticalReservedConcurrency: this.criticalReservedConcurrency,
      byClass,
      instanceId: this.instanceId,
    };
  }

  private async awaitAdmission(workId: string, abort?: () => boolean): Promise<void> {
    const waitStartedAt = this.now();
    for (;;) {
      // Cancellation: if the owning run was cancelled/paused mid-wait, abandon the
      // wait at once (don't block up to admissionMaxWaitMs) — retire the queue row and
      // throw the same transient error so the caller requeues, never mis-classifies.
      if (abort && (() => { try { return abort(); } catch { return false; } })()) {
        rawDb.prepare(`UPDATE provider_admission_queue SET state='expired',last_error=?,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='queued'`)
          .run("admission aborted (run cancelled)", this.now(), workId);
        throw new AdmissionTimeoutError(this.now() - waitStartedAt);
      }
      // Bounded wait: never hang a scan worker forever. On deadline the request
      // gives up, its queue row is retired, and the caller requeues the address.
      if (this.now() - waitStartedAt >= this.admissionMaxWaitMs) {
        rawDb.prepare(`UPDATE provider_admission_queue SET state='expired',last_error=?,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='queued'`)
          .run("admission wait timeout", this.now(), workId);
        throw new AdmissionTimeoutError(this.now() - waitStartedAt);
      }
      const decision = rawDb.transaction(() => {
        this.cleanup();
        const now = this.now();
        const control = this.control();
        const nextStartAt = Number(control.next_start_at ?? 0);
        if (nextStartAt > now) return { admitted: false, waitMs: Math.max(this.pollMs, nextStartAt - now) };
        // Admission head = the highest EFFECTIVE-priority queued item. Effective
        // priority ages a waiting item upward, but asymmetrically so anti-starvation
        // never defeats CRITICAL-first:
        //   • NORMAL (base < cutoff) ages only UP TO the cutoff — enough to escape
        //     starvation and earn CRITICAL-band ceiling access, but it can never
        //     SURPASS real CRITICAL, so a bulk NORMAL backlog can't bury fresh
        //     CRITICAL work by all aging past it at once.
        //   • CRITICAL (base >= cutoff) ages ABOVE the cutoff, so genuinely urgent
        //     work still out-sorts any aged-NORMAL that reached the cutoff.
        // WEIGHTED-FAIR CAPS: if a share-capped class (EXPANSION or MAINTENANCE) already
        // holds its maximum concurrent slots, EXCLUDE it from head selection this round so
        // a revenue-class item (IMMEDIATE/NEW_BUILD/DISCOVERY) is chosen instead. The
        // capped classes never exceed their share and can never crowd out revenue work —
        // while still making steady progress up to the cap. (No-op when the fractions are
        // 0/unused, so existing tests are unaffected.)
        const expansionActive = Number((rawDb.prepare(
          `SELECT COUNT(*) count FROM provider_admission_queue WHERE state='active' AND source IN (${EXPANSION_SOURCES})`).get() as any).count);
        const maintenanceActive = Number((rawDb.prepare(
          `SELECT COUNT(*) count FROM provider_admission_queue WHERE state='active' AND source IN (${MAINTENANCE_SOURCES})`).get() as any).count);
        const expansionBlocked = expansionActive >= this.expansionMaxActive ? 1 : 0;
        const maintenanceBlocked = maintenanceActive >= this.maintenanceMaxActive ? 1 : 0;
        const agedExpr = `CASE WHEN priority >= ${CRITICAL_PRIORITY_CUTOFF}
            THEN priority + MIN(@maxBoost, CAST((@now - enqueued_at) * @rate / 1000 AS INTEGER))
            ELSE MIN(${CRITICAL_PRIORITY_CUTOFF}, priority + CAST((@now - enqueued_at) * @rate / 1000 AS INTEGER)) END`;
        const head = rawDb.prepare(`SELECT id,priority,enqueued_at FROM provider_admission_queue WHERE state='queued'
          AND (@expBlocked = 0 OR source NOT IN (${EXPANSION_SOURCES}))
          AND (@maintBlocked = 0 OR source NOT IN (${MAINTENANCE_SOURCES}))
          ORDER BY (${agedExpr}) DESC, enqueued_at ASC, id ASC LIMIT 1`)
          .get({ maxBoost: this.agingMaxBoost, now, rate: this.agingRatePerSec, expBlocked: expansionBlocked, maintBlocked: maintenanceBlocked }) as any;
        if (!head || head.id !== workId) {
          // If THIS request is a capped-out expansion item, tell it to wait a beat.
          return { admitted: false, waitMs: this.pollMs };
        }
        const agedPoints = this.agingRatePerSec > 0
          ? Math.floor((now - Number(head.enqueued_at)) * this.agingRatePerSec / 1000) : 0;
        const base = Number(head.priority);
        const effectivePriority = base >= CRITICAL_PRIORITY_CUTOFF
          ? base + Math.min(this.agingMaxBoost, agedPoints)
          : Math.min(CRITICAL_PRIORITY_CUTOFF, base + agedPoints);
        const headIsCritical = effectivePriority >= CRITICAL_PRIORITY_CUTOFF;
        const active = Number((rawDb.prepare(`SELECT COUNT(*) count FROM provider_admission_queue WHERE state='active'`).get() as any).count);
        const starts = Number((rawDb.prepare(`SELECT COUNT(*) count FROM provider_rate_events WHERE started_at>?`).get(now - this.rateWindowMs) as any).count);
        // CRITICAL (incl. aged-into-CRITICAL) may use every slot; NORMAL is held below
        // the reserved band so the reserved concurrency + per-window rate stays
        // available for CRITICAL only.
        const concurrencyCeiling = headIsCritical ? this.maxConcurrency : this.maxConcurrency - this.criticalReservedConcurrency;
        const rateCeiling = headIsCritical ? this.rollingAdmissionLimit : this.rollingAdmissionLimit - this.criticalReservedRate;
        if (active >= concurrencyCeiling || starts >= rateCeiling) {
          const oldest = rawDb.prepare(`SELECT MIN(started_at) startedAt FROM provider_rate_events WHERE started_at>?`).get(now - this.rateWindowMs) as any;
          return { admitted: false, waitMs: starts >= rateCeiling && oldest?.startedAt
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
    // HARD active-age cap: the lifetime heartbeat keeps a HUNG task's lease fresh
    // forever, so lease expiry alone can never reclaim its slot. No legitimate check
    // exceeds a few tens of seconds (5s search cap + parse + save); anything active
    // past the task deadline is wedged upstream — expire it so the slot frees (its
    // eventual completion is a harmless no-op UPDATE). Observed live: 16 slots hung
    // 435s+ on a black-holed egress collapsed throughput while 300k targets waited.
    rawDb.prepare(`UPDATE provider_admission_queue SET state='expired',last_error='task deadline exceeded',updated_at=? WHERE state='active' AND started_at<=?`)
      .run(now, now - Math.max(60_000, Number(process.env.PROVIDER_TASK_MAX_MS ?? 180_000)));
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
  // NOTE: the blanket wipe of leftover admission/lock/rate state moved to
  // coordinatorBootClean() — it must run EXACTLY ONCE per box (the primary),
  // never in each cluster worker, or a worker's boot would erase its siblings'
  // LIVE address locks (→ double Decodo spend) and rate ledger (→ over-admission
  // → 403 storms). ensureSchema() stays purely idempotent DDL, safe in every
  // process. See index.ts cluster boot.
}

// Clear stale admission/lock/rate rows left by the PREVIOUS container. Call ONCE
// on the primary (or the single process when SCAN_WORKERS=0), BEFORE forking
// workers — never from a worker. Scan progress lives in scan_runs/run_targets,
// not here, so nothing real is lost.
export function coordinatorBootClean(): void {
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
