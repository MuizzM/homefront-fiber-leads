export type ProviderRequestPriority = "manual" | "lasso" | "new_build" | "coming_soon" | "discovery" | "expansion" | "recheck" | "market" | "nightly" | "city";

// Five weighted-fair admission CLASSES, top to bottom (see admissionClassOf in the
// coordinator). Reserved capacity is guaranteed for the revenue classes (IMMEDIATE,
// NEW_BUILD, DISCOVERY) by CAPPING the share of EXPANSION + MAINTENANCE, and priority
// ordering + aging decide within/across the reserved band.
//   IMMEDIATE   — manual, lasso/field, admin (a rep's tap must never wait)
//   NEW_BUILD   — new addresses/permits + Coming Soon rechecks
//   DISCOVERY   — NC/SC Kinetic-market scans (find fresh leads)
//   EXPANSION   — nearby scans fanned out from a green lead (share-capped)
//   MAINTENANCE — stale + statewide baseline rechecks (share-capped)
export const PROVIDER_PRIORITY: Record<ProviderRequestPriority, number> = {
  manual: 500,   // IMMEDIATE
  lasso: 400,    // IMMEDIATE (Field Map)
  new_build: 380, // NEW_BUILD
  coming_soon: 375, // NEW_BUILD (Coming Soon recheck — high frequency)
  discovery: 370, // DISCOVERY (market scan)
  expansion: 365, // EXPANSION (share-capped)
  recheck: 300,  // MAINTENANCE
  market: 275,   // MAINTENANCE
  nightly: 250,  // MAINTENANCE
  city: 200,     // MAINTENANCE
};

export type QueueEvent =
  | { type: "queued"; key: string; queued: number; active: number; priority: number; source: ProviderRequestPriority }
  | { type: "started"; key: string; queued: number; active: number; waitMs: number; priority: number; source: ProviderRequestPriority }
  | { type: "completed"; key: string; queued: number; active: number; waitMs: number; durationMs: number; cached: boolean; source: ProviderRequestPriority }
  | { type: "failed"; key: string; queued: number; active: number; waitMs: number; durationMs: number; source: ProviderRequestPriority }
  | { type: "cache_hit"; key: string; queued: number; active: number; source: ProviderRequestPriority }
  | { type: "deduped"; key: string; queued: number; active: number; source: ProviderRequestPriority }
  | { type: "paused"; key: string; queued: number; active: number; retryAt: number; source: ProviderRequestPriority };

export interface ProviderQueueSnapshot {
  active: number;
  queued: number;
  maxConcurrency: number;
  maxRequestsPerSecond: number | null;
  startsLastSecond: number;
  completed: number;
  failed: number;
  cacheHits: number;
  deduped: number;
  averageWaitMs: number;
  averageDurationMs: number;
  lastActivityAt: number;
  pausedUntil: number | null;
  queuedBySource: Record<ProviderRequestPriority, number>;
}

interface QueueOptions<T> {
  maxConcurrency: number;
  maxRequestsPerSecond?: number;
  cacheTtlMs: number;
  maxCacheEntries?: number;
  cacheable?: (value: T) => boolean;
  clone?: (value: T) => T;
  now?: () => number;
  onEvent?: (event: QueueEvent) => void;
}

export interface ProviderRequestOptions {
  source?: ProviderRequestPriority;
  priority?: number;
}

interface Pending<T> {
  key: string;
  task: () => Promise<T>;
  enqueuedAt: number;
  sequence: number;
  priority: number;
  source: ProviderRequestPriority;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface InFlight<T> {
  promise: Promise<T>;
  pending: Pending<T> | null;
}

/**
 * Process-wide, priority-aware provider scheduler.
 *
 * All scan producers may enqueue freely. This class enforces one aggregate
 * concurrency ceiling and one strict rolling one-second request-start budget,
 * regardless of how many city, lasso, manual, market, or recheck workers exist.
 * Identical normalized addresses share one promise and conclusive answers use a
 * bounded TTL/LRU cache. A higher-priority duplicate upgrades queued work rather
 * than creating a second provider request.
 */
export class ProviderRequestQueue<T> {
  private readonly maxConcurrency: number;
  private readonly maxRequestsPerSecond: number;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly cacheable: (value: T) => boolean;
  private readonly clone: (value: T) => T;
  private readonly now: () => number;
  private readonly onEvent?: (event: QueueEvent) => void;
  private readonly pending: Pending<T>[] = [];
  private readonly inFlight = new Map<string, InFlight<T>>();
  private readonly cache = new Map<string, { value: T; expiresAt: number }>();
  private readonly requestStarts: number[] = [];
  private active = 0;
  private completed = 0;
  private failed = 0;
  private cacheHits = 0;
  private deduped = 0;
  private totalWaitMs = 0;
  private totalDurationMs = 0;
  private lastActivityAt = 0;
  private pausedUntil = 0;
  private sequence = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: QueueOptions<T>) {
    const concurrency = Number(options.maxConcurrency);
    const maxRps = Number(options.maxRequestsPerSecond);
    const cacheTtlMs = Number(options.cacheTtlMs);
    const cacheEntries = Number(options.maxCacheEntries ?? 20_000);
    this.maxConcurrency = Number.isFinite(concurrency) ? Math.max(1, Math.min(1_000, Math.floor(concurrency))) : 8;
    this.maxRequestsPerSecond = Number.isFinite(maxRps) && maxRps > 0
      ? Math.max(1, Math.min(10_000, Math.floor(maxRps)))
      : Number.POSITIVE_INFINITY;
    this.cacheTtlMs = Number.isFinite(cacheTtlMs) ? Math.max(0, Math.floor(cacheTtlMs)) : 0;
    this.maxCacheEntries = Number.isFinite(cacheEntries) ? Math.max(1, Math.floor(cacheEntries)) : 20_000;
    this.cacheable = options.cacheable ?? (() => true);
    this.clone = options.clone ?? ((value) => value);
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;
  }

  request(key: string, task: () => Promise<T>, options: ProviderRequestOptions = {}): Promise<T> {
    const normalizedKey = key.trim().toLowerCase();
    const source = options.source ?? "market";
    const priority = Number.isFinite(options.priority) ? Number(options.priority) : PROVIDER_PRIORITY[source];
    const cached = this.readCache(normalizedKey);
    if (cached !== undefined) {
      this.cacheHits++;
      this.emit({ type: "cache_hit", key: normalizedKey, queued: this.pending.length, active: this.active, source });
      return Promise.resolve(this.clone(cached));
    }

    const existing = this.inFlight.get(normalizedKey);
    if (existing) {
      this.deduped++;
      if (existing.pending && priority > existing.pending.priority) {
        existing.pending.priority = priority;
        existing.pending.source = source;
        this.pendingDirty = true; // lazy sort at dispatch — never O(n) per enqueue
      }
      this.emit({ type: "deduped", key: normalizedKey, queued: this.pending.length, active: this.active, source });
      return existing.promise.then(value => this.clone(value));
    }

    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
    const item: Pending<T> = {
      key: normalizedKey, task, enqueuedAt: this.now(), sequence: this.sequence++,
      priority, source, resolve, reject,
    };
    this.inFlight.set(normalizedKey, { promise, pending: item });
    this.pending.push(item);
    this.pendingDirty = true; // sorted lazily in pump() — bulk loads stay O(n) total
    this.emit({ type: "queued", key: normalizedKey, queued: this.pending.length, active: this.active, priority, source });
    this.pump();
    return promise.then(value => this.clone(value));
  }

  /** Pause all new request starts. Existing requests finish normally. */
  pauseFor(ms: number, source: ProviderRequestPriority = "market"): number {
    const retryAt = this.now() + Math.max(0, Math.floor(ms));
    this.pausedUntil = Math.max(this.pausedUntil, retryAt);
    this.emit({ type: "paused", key: "global", queued: this.pending.length, active: this.active, retryAt: this.pausedUntil, source });
    this.scheduleWake(Math.max(0, this.pausedUntil - this.now()));
    return this.pausedUntil;
  }

  /** Clear a transient Retry-After pause and resume dispatching immediately. */
  resume(): void {
    this.pausedUntil = 0;
    this.pump();
  }

  snapshot(): ProviderQueueSnapshot {
    const now = this.now();
    this.pruneStarts(now);
    const attempts = this.completed + this.failed;
    const queuedBySource: Record<ProviderRequestPriority, number> = { manual: 0, lasso: 0, new_build: 0, coming_soon: 0, discovery: 0, expansion: 0, recheck: 0, market: 0, nightly: 0, city: 0 };
    for (const item of this.pending) queuedBySource[item.source]++;
    return {
      active: this.active,
      queued: this.pending.length,
      maxConcurrency: this.maxConcurrency,
      maxRequestsPerSecond: Number.isFinite(this.maxRequestsPerSecond) ? this.maxRequestsPerSecond : null,
      startsLastSecond: this.requestStarts.length,
      completed: this.completed,
      failed: this.failed,
      cacheHits: this.cacheHits,
      deduped: this.deduped,
      averageWaitMs: attempts ? Math.round(this.totalWaitMs / attempts) : 0,
      averageDurationMs: attempts ? Math.round(this.totalDurationMs / attempts) : 0,
      lastActivityAt: this.lastActivityAt,
      pausedUntil: this.pausedUntil > now ? this.pausedUntil : null,
      queuedBySource,
    };
  }

  clearCache(): void { this.cache.clear(); }

  private pendingDirty = false;
  private sortPending(): void {
    // Lazy ordering: enqueue only marks dirty, so loading a 20k-target sweep costs
    // one sort at dispatch time instead of 20k full re-sorts (was O(n²) per batch).
    if (!this.pendingDirty) return;
    this.pending.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    this.pendingDirty = false;
  }

  private pump(): void {
    if (this.pending.length === 0) return;
    this.sortPending();
    const now = this.now();
    if (this.pausedUntil > now) {
      this.scheduleWake(this.pausedUntil - now);
      return;
    }
    this.pruneStarts(now);
    while (this.active < this.maxConcurrency && this.pending.length > 0) {
      if (this.requestStarts.length >= this.maxRequestsPerSecond) {
        const delay = Math.max(1, (this.requestStarts[0] + 1_000) - this.now());
        this.scheduleWake(delay);
        return;
      }
      const item = this.pending.shift()!;
      const tracked = this.inFlight.get(item.key);
      if (tracked) tracked.pending = null;
      this.active++;
      const startedAt = this.now();
      this.requestStarts.push(startedAt);
      const waitMs = Math.max(0, startedAt - item.enqueuedAt);
      this.emit({ type: "started", key: item.key, queued: this.pending.length, active: this.active, waitMs, priority: item.priority, source: item.source });

      void item.task().then(value => {
        const durationMs = Math.max(0, this.now() - startedAt);
        this.completed++;
        this.totalWaitMs += waitMs;
        this.totalDurationMs += durationMs;
        let cached = false;
        if (this.cacheTtlMs > 0 && this.cacheable(value)) {
          this.writeCache(item.key, value);
          cached = true;
        }
        item.resolve(value);
        this.emit({ type: "completed", key: item.key, queued: this.pending.length, active: this.active - 1, waitMs, durationMs, cached, source: item.source });
      }, error => {
        const durationMs = Math.max(0, this.now() - startedAt);
        this.failed++;
        this.totalWaitMs += waitMs;
        this.totalDurationMs += durationMs;
        item.reject(error);
        this.emit({ type: "failed", key: item.key, queued: this.pending.length, active: this.active - 1, waitMs, durationMs, source: item.source });
      }).finally(() => {
        this.inFlight.delete(item.key);
        this.active--;
        this.pump();
      });
    }
  }

  private pruneStarts(now: number): void {
    while (this.requestStarts.length > 0 && this.requestStarts[0] <= now - 1_000) this.requestStarts.shift();
  }

  private scheduleWake(delayMs: number): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.pump();
    }, Math.max(1, Math.ceil(delayMs)));
    if (typeof (this.wakeTimer as any).unref === "function") (this.wakeTimer as any).unref();
  }

  private readCache(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) { this.cache.delete(key); return undefined; }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  private writeCache(key: string, value: T): void {
    this.cache.delete(key);
    this.cache.set(key, { value: this.clone(value), expiresAt: this.now() + this.cacheTtlMs });
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private emit(event: QueueEvent): void {
    this.lastActivityAt = this.now();
    try { this.onEvent?.(event); } catch { /* observability must never stop scan work */ }
  }
}
