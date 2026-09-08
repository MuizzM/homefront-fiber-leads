import { canAdoptLegacyWork, currentWorkLease, isCurrentWorkLease, sameWorkOwner, subscribeWorkAuthority, workOwnerKey, type WorkOwner, type WorkLease } from "./workAuthority";
// Offline-first drill-card review outbox — framework-free (no React, no
// react-query), cloned from knockQueue.ts's proven structure. Every grade a
// rep gives a drill card is durably appended here BEFORE the UI moves on, so
// a 20-card dead-zone session never loses a review; delivery is a background
// event the rep never sees. Persistence is localStorage when available and an
// in-memory mirror otherwise (sandboxed iframes throw on ANY storage access;
// Safari private mode throws on setItem) — a blocked environment still works
// for the session.
//
// Delivery is a single batched POST /api/training/reviews carrying every
// pending entry. The server upserts idempotently on (cardId, reviewedAt), so
// a retry after a flaky save can never double-count, and a review taken at
// 2 PM offline is scheduled from the CLIENT clock (reviewedAt), never pushed
// by the 6 PM sync.

import type { Grade } from "@shared/trainingSchedule";

/** One graded review, exactly the CE-1 POST /api/training/reviews entry shape. */
export interface QueuedReview {
  cardId: string;
  grade: Grade;
  /** CLIENT clock ISO string — the moment of the grade, not the flush. */
  reviewedAt: string;
  /** The ladder rung the client believed the card was on when graded. */
  rungBefore?: number;
}

interface PendingReview extends QueuedReview {
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
}

export interface ReviewQueueSnapshot {
  pendingCount: number;
  online: boolean;
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface ReviewQueueOpts {
  owner?: WorkOwner;
  /** Owner key (teamMemberId, or user id when unlinked) — partitions storage. */
  ownerKey: number | string;
  post: (url: string, body: unknown, lease?: WorkLease | null) => Promise<any>; // parsed JSON; throws Error("<status>: <text>")
  storage?: StorageLike;
  now?: () => number;
  isOnline?: () => boolean;
  /** Fired once per successful batch delivery — the parent hook invalidates. */
  onSynced?: (delivered: number) => void;
}

export interface TrainingReviewQueue {
  /** Durably append one review; dedupes an identical (cardId, reviewedAt)
   *  already pending so a double-tap can never queue the same grade twice. */
  enqueue(review: QueuedReview): { deduped: boolean };
  /** Attempt delivery of everything pending now (no-op offline). */
  flush(): Promise<void>;
  subscribe(cb: () => void): () => void;
  /** Referentially stable until state changes (useSyncExternalStore-safe). */
  getSnapshot(): ReviewQueueSnapshot;
  /** Current pending entries (defensive copy) — tests + optimistic ladder. */
  pending(): QueuedReview[];
  canCapture(): boolean;
  suspend(): void;
  resume(): void;
  destroy(): void;
}

const INTERVAL_MS = 30_000;
const MAX_ATTEMPTS = 8;

function retryDelayMs(attempts: number): number {
  // Capped exponential backoff, same cadence as the knock queue.
  return Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));
}

// Every storage touch is try/caught: sandboxed iframes throw on the
// window.localStorage getter itself, Safari private mode throws on setItem.
// First failure degrades permanently to the in-memory mirror (which every
// write already updates), so reads never return values staler than mem.
function safeStorage(inner?: StorageLike): StorageLike {
  const mem = new Map<string, string>();
  let degraded = false;
  const real = (): StorageLike | undefined =>
    inner ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  return {
    getItem(k) {
      if (!degraded) {
        try { return real()?.getItem(k) ?? mem.get(k) ?? null; } catch { degraded = true; }
      }
      return mem.get(k) ?? null;
    },
    setItem(k, v) {
      mem.set(k, v);
      if (!degraded) { try { real()?.setItem(k, v); } catch { degraded = true; } }
    },
    removeItem(k) {
      mem.delete(k);
      if (!degraded) { try { real()?.removeItem(k); } catch { degraded = true; } }
    },
  };
}

function loadItems(storage: StorageLike, key: string, owner?: WorkOwner): PendingReview[] {
  const raw = storage.getItem(key);
  if (!raw) return [];
  try {
    const env = JSON.parse(raw);
    if (!env || env.v !== 1 || !Array.isArray(env.items) || (env.owner && owner && !sameWorkOwner(env.owner, owner))) {
      console.warn(`[trainingReviewQueue] discarding unrecognized envelope at ${key}`);
      return [];
    }
    return (env.items as PendingReview[]).filter(
      (it) => it && typeof it.cardId === "string" && typeof it.reviewedAt === "string",
    );
  } catch {
    console.warn(`[trainingReviewQueue] discarding corrupt envelope at ${key}`);
    return [];
  }
}

export function createTrainingReviewQueue(opts: ReviewQueueOpts): TrainingReviewQueue {
  const now = opts.now ?? Date.now;
  const isOnline = opts.isOnline ??
    (() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  const storage = safeStorage(opts.storage);
  const registryKey = opts.owner ? workOwnerKey(opts.owner) : String(opts.ownerKey);
  const pendingKey = opts.owner ? `hf.trainingReviews.v2.${registryKey}` : `hf.trainingReviews.v1.${opts.ownerKey}`;
  if (opts.owner && canAdoptLegacyWork(opts.owner)) {
    const legacy = `hf.trainingReviews.v1.${opts.ownerKey}`;
    if (!storage.getItem(pendingKey) && storage.getItem(legacy)) storage.setItem(pendingKey, storage.getItem(legacy)!);
    storage.removeItem(legacy);
  }

  const pending: PendingReview[] = loadItems(storage, pendingKey, opts.owner).map((it) => ({
    ...it,
    attempts: it.attempts ?? 0,
    nextAttemptAt: it.nextAttemptAt ?? 0,
    lastError: it.lastError ?? null,
  }));
  const listeners = new Set<() => void>();

  let snapshot: ReviewQueueSnapshot = { pendingCount: pending.length, online: isOnline() };
  let inflight = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let suspended = !!opts.owner && !currentWorkLease(opts.owner);
  let runVersion = 0;
  let unsubscribeAuthority = () => {};
  const canCapture = () => !destroyed && !suspended && (!opts.owner || !!currentWorkLease(opts.owner));
  const currentRun = (version: number, lease: WorkLease | null) => canCapture() && version === runVersion
    && (!opts.owner || isCurrentWorkLease(lease));

  const persist = (): void => {
    if (pending.length) storage.setItem(pendingKey, JSON.stringify({ v: 1, owner: opts.owner, items: pending }));
    else storage.removeItem(pendingKey);
  };

  // The ONLY place the snapshot object is rebuilt — getSnapshot returns the
  // cached reference otherwise (useSyncExternalStore tears on fresh objects).
  const markChanged = (): void => {
    snapshot = { pendingCount: pending.length, online: isOnline() };
    listeners.forEach((cb) => cb());
  };

  // Heartbeat runs ONLY while something is pending — an idle queue costs nothing.
  const syncInterval = (): void => {
    if (!canCapture()) return;
    if (pending.length > 0 && interval == null) {
      interval = setInterval(() => { void flush(); }, INTERVAL_MS);
    } else if (pending.length === 0 && interval != null) {
      clearInterval(interval);
      interval = null;
    }
  };

  const armRetryTimer = (): void => {
    if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; }
    if (!canCapture() || !pending.length) return;
    const t = now();
    let earliest = Infinity;
    for (const it of pending) {
      if (it.nextAttemptAt > t && it.nextAttemptAt < earliest) earliest = it.nextAttemptAt;
    }
    if (earliest === Infinity) return;
    retryTimer = setTimeout(() => { retryTimer = null; void flush(); }, Math.max(0, earliest - now()));
  };

  async function flush(): Promise<void> {
    if (inflight || !canCapture()) return;
    if (!isOnline()) return;
    if (!pending.length) return;
    inflight = true;
    const version = runVersion;
    const lease = opts.owner ? currentWorkLease(opts.owner) : null;
    try {
      // The batch loop re-reads `pending` each pass: reviews graded mid-flight
      // (inflight was already true for their own flush call) ride the next pass.
      for (;;) {
        if (!currentRun(version, lease)) return;
        const due = pending.filter((it) => it.nextAttemptAt <= now());
        if (!due.length) break;
        try {
          // ONE batched request per pass: the server contract accepts a
          // reviews array, so a backlog costs one round-trip, not N.
          await opts.post("/api/training/reviews", {
            reviews: due.map(({ cardId, grade, reviewedAt, rungBefore }) => ({
              cardId,
              grade,
              reviewedAt,
              ...(rungBefore != null ? { rungBefore } : {}),
            })),
          }, lease);
          if (!currentRun(version, lease)) return;
          const delivered = due.length;
          for (const it of due) {
            const idx = pending.indexOf(it);
            if (idx >= 0) pending.splice(idx, 1);
          }
          persist();
          markChanged();
          opts.onSynced?.(delivered);
        } catch (err) {
          if (!currentRun(version, lease)) return;
          const message = err instanceof Error ? err.message : String(err);
          const status = /^(\d{3}):/.exec(message)?.[1];
          // A 4xx batch is a shape problem (unknown card id, bad payload): drop
          // the batch with a support log rather than retrying the same rejection
          // forever. Reviews already applied optimistically stay applied — the
          // ladder is self-correcting on the next deck fetch.
          if (status && status.startsWith("4") && status !== "401" && status !== "408" && status !== "425" && status !== "429") {
            console.error(
              `[trainingReviewQueue] dropped undeliverable batch of ${due.length} reviews: ${message}`,
            );
            for (const it of due) {
              const idx = pending.indexOf(it);
              if (idx >= 0) pending.splice(idx, 1);
            }
            persist();
            markChanged();
            return;
          }
          // Auth / transient: stay pending with backoff — the heartbeat, the
          // online listener, and re-auth all redeliver without the rep seeing a thing.
          const nextAt = now() + retryDelayMs(Math.max(...due.map((d) => d.attempts), 0));
          for (const it of due) {
            it.attempts = Math.min(it.attempts + 1, MAX_ATTEMPTS);
            it.nextAttemptAt = nextAt;
            it.lastError = message;
          }
          persist();
          markChanged();
          break; // stop the pass — the connection is likely down for the rest too.
        }
      }
    } finally {
      if (version !== runVersion) return;
      inflight = false;
      syncInterval();
      armRetryTimer();
    }
  }

  // Recovery signals: connectivity returning and the app coming back to the
  // foreground each attempt a delivery. Cooldown is unnecessary here — unlike
  // the knock dead lane there is no per-item retry budget to burn.
  const onOnline = (): void => { if (!canCapture()) return; markChanged(); void flush(); };
  const onVisible = (): void => {
    if (!canCapture()) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    void flush();
  };
  if (typeof window !== "undefined") window.addEventListener("online", onOnline);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);

  const queue: TrainingReviewQueue = {
    enqueue(review) {
      if (!canCapture()) throw new Error("Sign in before recording more work");
      // Dedupe an identical (cardId, reviewedAt) already pending — a
      // double-tap on a grade button before the deck advances can never
      // queue the same review twice.
      if (pending.some((it) => it.cardId === review.cardId && it.reviewedAt === review.reviewedAt)) {
        return { deduped: true };
      }
      pending.push({
        ...review,
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
      });
      persist();
      syncInterval();
      markChanged();
      // Microtask-deferred flush: a burst of synchronous grades (a rep blazing
      // through a deck) coalesces into ONE batch request, and items enqueued
      // mid-flight ride the flush loop's next pass.
      queueMicrotask(() => { void flush(); });
      return { deduped: false };
    },

    flush,

    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },

    getSnapshot: () => snapshot,

    pending: () => pending.map(({ cardId, grade, reviewedAt, rungBefore }) => ({
      cardId,
      grade,
      reviewedAt,
      ...(rungBefore != null ? { rungBefore } : {}),
    })),

    canCapture,
    suspend() {
      suspended = true; runVersion++; inflight = false;
      if (interval != null) { clearInterval(interval); interval = null; }
      if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; }
    },
    resume() {
      if (destroyed || (opts.owner && !currentWorkLease(opts.owner))) return;
      suspended = false; runVersion++; inflight = false;
      syncInterval(); armRetryTimer();
      queueMicrotask(() => { void flush(); });
    },
    destroy() {
      queue.suspend();
      destroyed = true;
      unsubscribeAuthority();
      pending.length = 0;

      if (interval != null) { clearInterval(interval); interval = null; }
      if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; }
      listeners.clear();
      if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      if (registry.get(registryKey) === queue) registry.delete(registryKey);
    },
  };

  if (opts.owner) unsubscribeAuthority = subscribeWorkAuthority(event => {
    if (event === "purge") {
      storage.removeItem(pendingKey);
      queue.destroy();
    } else if (event === "discard") queue.destroy();
    else if (event === "suspend") queue.suspend();
    else if (currentWorkLease(opts.owner)) queue.resume();
  });

  // Reload recovery: persisted reviews resurface and the first flush fires as
  // soon as the caller has the queue object in hand.
  persist();
  syncInterval();
  markChanged();
  queueMicrotask(() => { void flush(); });

  return queue;
}

// One live queue per rep — Coach, Today (WarmupStrip), and the deck runner
// share state and timers. destroy() deregisters, so tests can create fresh
// instances per case.
const registry = new Map<string, TrainingReviewQueue>();

export function getTrainingReviewQueue(opts: ReviewQueueOpts): TrainingReviewQueue {
  const key = opts.owner ? workOwnerKey(opts.owner) : String(opts.ownerKey);
  const existing = registry.get(key);
  if (existing) return existing;
  const q = createTrainingReviewQueue(opts);
  registry.set(key, q);
  return q;
}
