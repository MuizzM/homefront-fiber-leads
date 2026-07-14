export type QueueEvent =
  | { type: "queued"; key: string; queued: number; active: number }
  | { type: "started"; key: string; queued: number; active: number; waitMs: number }
  | { type: "completed"; key: string; queued: number; active: number; waitMs: number; durationMs: number; cached: boolean }
  | { type: "failed"; key: string; queued: number; active: number; waitMs: number; durationMs: number }
  | { type: "cache_hit"; key: string; queued: number; active: number }
  | { type: "deduped"; key: string; queued: number; active: number };

export interface ProviderQueueSnapshot {
  active: number;
  queued: number;
  maxConcurrency: number;
  completed: number;
  failed: number;
  cacheHits: number;
  deduped: number;
  averageWaitMs: number;
  averageDurationMs: number;
  lastActivityAt: number;
}

interface QueueOptions<T> {
  maxConcurrency: number;
  cacheTtlMs: number;
  maxCacheEntries?: number;
  cacheable?: (value: T) => boolean;
  clone?: (value: T) => T;
  now?: () => number;
  onEvent?: (event: QueueEvent) => void;
}

interface Pending<T> {
  key: string;
  task: () => Promise<T>;
  enqueuedAt: number;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/**
 * One bounded FIFO for a shared upstream identity.
 *
 * Multiple scan jobs can enqueue freely, but their combined live requests never
 * exceed the provider-safe concurrency. Identical addresses share one in-flight
 * promise and recent conclusive answers are served from the short cache. This is
 * throughput control, not user admission control: there is no scans/hour quota.
 */
export class ProviderRequestQueue<T> {
  private readonly maxConcurrency: number;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly cacheable: (value: T) => boolean;
  private readonly clone: (value: T) => T;
  private readonly now: () => number;
  private readonly onEvent?: (event: QueueEvent) => void;
  private readonly pending: Pending<T>[] = [];
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly cache = new Map<string, { value: T; expiresAt: number }>();
  private active = 0;
  private completed = 0;
  private failed = 0;
  private cacheHits = 0;
  private deduped = 0;
  private totalWaitMs = 0;
  private totalDurationMs = 0;
  private lastActivityAt = 0;

  constructor(options: QueueOptions<T>) {
    const concurrency = Number(options.maxConcurrency);
    const cacheTtlMs = Number(options.cacheTtlMs);
    const cacheEntries = Number(options.maxCacheEntries ?? 20_000);
    this.maxConcurrency = Number.isFinite(concurrency) ? Math.max(1, Math.min(64, Math.floor(concurrency))) : 8;
    this.cacheTtlMs = Number.isFinite(cacheTtlMs) ? Math.max(0, Math.floor(cacheTtlMs)) : 0;
    this.maxCacheEntries = Number.isFinite(cacheEntries) ? Math.max(1, Math.floor(cacheEntries)) : 20_000;
    this.cacheable = options.cacheable ?? (() => true);
    this.clone = options.clone ?? ((value) => value);
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;
  }

  request(key: string, task: () => Promise<T>): Promise<T> {
    const normalizedKey = key.trim().toLowerCase();
    const cached = this.readCache(normalizedKey);
    if (cached !== undefined) {
      this.cacheHits++;
      this.emit({ type: "cache_hit", key: normalizedKey, queued: this.pending.length, active: this.active });
      return Promise.resolve(this.clone(cached));
    }

    const existing = this.inFlight.get(normalizedKey);
    if (existing) {
      this.deduped++;
      this.emit({ type: "deduped", key: normalizedKey, queued: this.pending.length, active: this.active });
      return existing.then(value => this.clone(value));
    }

    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
    this.inFlight.set(normalizedKey, promise);
    this.pending.push({ key: normalizedKey, task, enqueuedAt: this.now(), resolve, reject });
    this.emit({ type: "queued", key: normalizedKey, queued: this.pending.length, active: this.active });
    this.pump();
    return promise.then(value => this.clone(value));
  }

  snapshot(): ProviderQueueSnapshot {
    const attempts = this.completed + this.failed;
    return {
      active: this.active,
      queued: this.pending.length,
      maxConcurrency: this.maxConcurrency,
      completed: this.completed,
      failed: this.failed,
      cacheHits: this.cacheHits,
      deduped: this.deduped,
      averageWaitMs: attempts ? Math.round(this.totalWaitMs / attempts) : 0,
      averageDurationMs: attempts ? Math.round(this.totalDurationMs / attempts) : 0,
      lastActivityAt: this.lastActivityAt,
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  private pump(): void {
    while (this.active < this.maxConcurrency && this.pending.length > 0) {
      const item = this.pending.shift()!;
      this.active++;
      const startedAt = this.now();
      const waitMs = Math.max(0, startedAt - item.enqueuedAt);
      this.emit({ type: "started", key: item.key, queued: this.pending.length, active: this.active, waitMs });

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
        this.emit({ type: "completed", key: item.key, queued: this.pending.length, active: this.active - 1, waitMs, durationMs, cached });
      }, error => {
        const durationMs = Math.max(0, this.now() - startedAt);
        this.failed++;
        this.totalWaitMs += waitMs;
        this.totalDurationMs += durationMs;
        item.reject(error);
        this.emit({ type: "failed", key: item.key, queued: this.pending.length, active: this.active - 1, waitMs, durationMs });
      }).finally(() => {
        this.inFlight.delete(item.key);
        this.active--;
        this.pump();
      });
    }
  }

  private readCache(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return undefined;
    }
    // Refresh insertion order so eviction approximates LRU without another data structure.
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
