// Offline-first knock save queue — framework-free (no React, no react-query).
// Every tap enqueues a QueuedKnock keyed by a clientId the server dedupes on,
// so retries after flaky saves can never double-log a knock. Persistence is
// localStorage when available and an in-memory Map otherwise (sandboxed iframes
// throw on ANY storage access), so a page reload mid-shift keeps unsent knocks
// but a blocked environment still works for the session. The parent hook owns
// all react-query cache work (optimistic patch + invalidation via onSaved) —
// this module only saves, retries, and reports per-lead save state.

import {
  KNOCK_QUEUE_MAX_ATTEMPTS,
  makeClientId,
  retryDelayMs,
  type KnockOutcome,
  type QueuedKnock,
} from "@shared/knock";

export type LeadSaveState = "idle" | "saving" | "saved" | "queued" | "error";

export interface QueueSnapshot {
  pendingCount: number;
  deadCount: number;
  byLead: Record<number, LeadSaveState>; // no entry = "idle"
  online: boolean;
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface KnockQueueOpts {
  repId: number;
  post: (url: string, body: unknown) => Promise<any>; // parsed JSON; throws Error("<status>: <text>")
  patch: (url: string, body: unknown) => Promise<any>;
  storage?: StorageLike;
  now?: () => number;
  isOnline?: () => boolean;
  onSaved?: (leadId: number) => void; // parent hook invalidates react-query here
}

export interface EnqueueInput {
  leadId: number;
  outcome: KnockOutcome;
  // Per-item credit override: an admin/manager knocking another rep's lead
  // credits that rep, not themselves. Defaults to opts.repId (the rep's own id).
  repId?: number;
  notes?: string | null;
  callbackDate?: string | null;
  callbackTime?: string | null;
  // Location evidence captured at the tap (see client/src/lib/geoFix.ts).
  repLat?: number | null;
  repLng?: number | null;
  gpsAccuracy?: number | null;
  deviceTs?: string | null;
  mockLocation?: boolean | null;
  netState?: "online" | "offline" | null;
  appVersion?: string | null;
}

export interface KnockQueue {
  // Resolves after the IMMEDIATE flush attempt (offline: resolves at once,
  // item queued) — callers may fire-and-forget, tests may await determinism.
  enqueue(k: EnqueueInput): Promise<{ clientId: string }>;
  flush(): Promise<void>;
  updateNote(leadId: number, notes: string): Promise<"merged" | "patched" | "not-found">;
  retryDead(clientId?: string): void; // no arg = retry ALL dead items
  retryLead(leadId: number): void; // sheet's error chip: retry every dead item for a lead
  subscribe(cb: () => void): () => void;
  getSnapshot(): QueueSnapshot; // referentially stable until state changes
  destroy(): void;
}

// 4xx that a retry can never fix — dead-letter immediately so poison items
// don't block the FIFO behind them. NOTE: 401 is handled separately (session
// expired = valid knock waiting for re-auth, never poison); 403 falls through to
// bounded retry (a CSRF-token 403 resolves once the session refreshes).
const DEAD_STATUSES = new Set([400, 404]);
const SAVED_FLASH_MS = 2000;
const INTERVAL_MS = 30_000;
const RECENT_SAVES_CAP = 50;

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

function loadItems(storage: StorageLike, key: string): QueuedKnock[] {
  const raw = storage.getItem(key);
  if (!raw) return [];
  try {
    const env = JSON.parse(raw);
    if (!env || env.v !== 1 || !Array.isArray(env.items)) {
      console.warn(`[knockQueue] discarding unrecognized envelope at ${key}`);
      return [];
    }
    return env.items as QueuedKnock[];
  } catch {
    console.warn(`[knockQueue] discarding corrupt envelope at ${key}`);
    return [];
  }
}

export function createKnockQueue(opts: KnockQueueOpts): KnockQueue {
  const now = opts.now ?? Date.now;
  const isOnline = opts.isOnline ??
    (() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  const storage = safeStorage(opts.storage);
  const pendingKey = `hf.knockQueue.v1.${opts.repId}`;
  const deadKey = `hf.knockDead.v1.${opts.repId}`;

  const pending: QueuedKnock[] = loadItems(storage, pendingKey);
  const dead: QueuedKnock[] = loadItems(storage, deadKey);
  const byLead: Record<number, LeadSaveState> = {};
  // leadId → last successful save, so a note edited after the save can still
  // PATCH the created row without a cache lookup. Capped FIFO — a shift is ~50 doors/hour.
  const recentSaves = new Map<number, { clientId: string; knockId: number }>();
  const listeners = new Set<() => void>();

  let snapshot: QueueSnapshot = { pendingCount: 0, deadCount: 0, byLead: {}, online: true };
  let inflight = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const idleTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let destroyed = false;

  const persist = (key: string, items: QueuedKnock[]): void => {
    if (items.length) storage.setItem(key, JSON.stringify({ v: 1, items }));
    else storage.removeItem(key);
  };
  const persistPending = () => persist(pendingKey, pending);
  const persistDead = () => persist(deadKey, dead);

  // The ONLY place the snapshot object is rebuilt — getSnapshot returns the
  // cached reference otherwise (useSyncExternalStore tears on fresh objects).
  const markChanged = (): void => {
    snapshot = {
      pendingCount: pending.length,
      deadCount: dead.length,
      byLead: { ...byLead },
      online: isOnline(),
    };
    listeners.forEach((cb) => cb());
  };

  const setLeadState = (leadId: number, state: LeadSaveState): void => {
    const t = idleTimers.get(leadId);
    if (t) { clearTimeout(t); idleTimers.delete(leadId); }
    if (state === "idle") delete byLead[leadId];
    else byLead[leadId] = state;
  };

  // "saved" is a 2s flash, then the entry is dropped (missing = idle).
  const scheduleIdle = (leadId: number): void => {
    idleTimers.set(leadId, setTimeout(() => {
      idleTimers.delete(leadId);
      if (byLead[leadId] === "saved") { delete byLead[leadId]; markChanged(); }
    }, SAVED_FLASH_MS));
  };

  const rememberSave = (leadId: number, clientId: string, knockId: number): void => {
    recentSaves.delete(leadId); // re-insert so the newest save is evicted last
    recentSaves.set(leadId, { clientId, knockId });
    while (recentSaves.size > RECENT_SAVES_CAP) {
      const oldest = recentSaves.keys().next().value;
      if (oldest === undefined) break;
      recentSaves.delete(oldest);
    }
  };

  // Heartbeat runs ONLY while something is pending — an idle queue costs nothing.
  const syncInterval = (): void => {
    if (destroyed) return;
    if (pending.length > 0 && interval == null) {
      interval = setInterval(() => { void flush(); }, INTERVAL_MS);
    } else if (pending.length === 0 && interval != null) {
      clearInterval(interval);
      interval = null;
    }
  };

  // One timer for the EARLIEST backoff deadline; strict FIFO means later items
  // wait on the head anyway, and the 30s heartbeat backstops everything else.
  const armRetryTimer = (): void => {
    if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; }
    if (destroyed) return;
    const t = now();
    let earliest = Infinity;
    for (const it of pending) {
      if (it.nextAttemptAt > t && it.nextAttemptAt < earliest) earliest = it.nextAttemptAt;
    }
    if (earliest === Infinity) return;
    retryTimer = setTimeout(() => { retryTimer = null; void flush(); }, Math.max(0, earliest - now()));
  };

  const deadLetter = (idx: number, item: QueuedKnock): void => {
    pending.splice(idx, 1);
    dead.push(item);
    persistPending();
    persistDead();
    setLeadState(item.leadId, "error");
    markChanged();
  };

  async function flush(): Promise<void> {
    if (inflight || destroyed) return;
    if (!isOnline()) return;
    inflight = true;
    try {
      let idx = 0;
      // pending.length re-checked each pass — items enqueued mid-flush get sent too.
      while (idx < pending.length) {
        const item = pending[idx];
        if (item.nextAttemptAt > now()) { idx++; continue; } // not due yet
        try {
          const resp = await opts.post(`/api/leads/${item.leadId}/knock`, {
            clientId: item.clientId,
            repId: item.repId,
            outcome: item.outcome,
            knockedAt: item.knockedAt,
            notes: item.notes,
            callbackDate: item.callbackDate,
            callbackTime: item.callbackTime,
            // Location evidence — the server computes distance + verdict from
            // these; it never trusts a client-sent verification result.
            repLat: item.repLat ?? null,
            repLng: item.repLng ?? null,
            gpsAccuracy: item.gpsAccuracy ?? null,
            deviceTs: item.deviceTs ?? null,
            mockLocation: item.mockLocation ?? null,
            netState: item.netState ?? null,
            appVersion: item.appVersion ?? null,
            // no wasHome — the server derives it from outcome
          });
          // Created and clientId-deduped replays look the same here: done.
          pending.splice(idx, 1);
          persistPending();
          rememberSave(item.leadId, item.clientId, resp?.id);
          setLeadState(item.leadId, "saved");
          scheduleIdle(item.leadId);
          markChanged();
          opts.onSaved?.(item.leadId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const status = parseInt(message, 10); // apiRequest throws Error("<status>: <text>")
          item.lastError = message;
          if (status === 401) {
            // Session expired — the knock is VALID, it just needs the rep to sign
            // back in. Pause the line WITHOUT consuming an attempt so it survives
            // until re-auth (the global 401 handler routes them to Login); the
            // flush retries on the next heartbeat / online / re-login.
            item.nextAttemptAt = now() + retryDelayMs(1);
            persistPending();
            setLeadState(item.leadId, "queued");
            markChanged();
            break; // everything behind this item needs auth too
          }
          if (DEAD_STATUSES.has(status)) {
            deadLetter(idx, item); // poison — park it and keep the line moving
            continue;
          }
          item.attempts += 1;
          if (item.attempts >= KNOCK_QUEUE_MAX_ATTEMPTS) {
            deadLetter(idx, item);
            continue;
          }
          // Network/5xx/429: back off and stop — the connection is likely down
          // for everything behind this item too.
          item.nextAttemptAt = now() + retryDelayMs(item.attempts);
          persistPending();
          setLeadState(item.leadId, "queued");
          markChanged();
          break;
        }
      }
    } finally {
      inflight = false;
      syncInterval();
      armRetryTimer();
    }
  }

  const onOnline = (): void => { markChanged(); void flush(); };
  if (typeof window !== "undefined") window.addEventListener("online", onOnline);

  const queue: KnockQueue = {
    enqueue(k) {
      const item: QueuedKnock = {
        clientId: makeClientId(),
        leadId: k.leadId,
        repId: k.repId ?? opts.repId,
        outcome: k.outcome,
        knockedAt: new Date().toISOString(), // time of the TAP, not the flush
        notes: k.notes ?? null,
        callbackDate: k.callbackDate ?? null,
        callbackTime: k.callbackTime ?? null,
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        // Location evidence for verification (undefined when the tap had no fix).
        repLat: k.repLat ?? null,
        repLng: k.repLng ?? null,
        gpsAccuracy: k.gpsAccuracy ?? null,
        deviceTs: k.deviceTs ?? null,
        mockLocation: k.mockLocation ?? null,
        netState: k.netState ?? null,
        appVersion: k.appVersion ?? null,
      };
      pending.push(item);
      persistPending();
      setLeadState(k.leadId, isOnline() ? "saving" : "queued");
      syncInterval();
      markChanged();
      // Await the immediate attempt so `await enqueue()` is deterministic;
      // fire-and-forget callers just ignore the promise.
      return flush().then(() => ({ clientId: item.clientId }));
    },

    flush,

    // Note edits ride along with an unsent knock when possible (one request,
    // works offline); otherwise PATCH the already-created row.
    async updateNote(leadId, notes) {
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].leadId === leadId) {
          pending[i].notes = notes;
          persistPending();
          return "merged";
        }
      }
      const saved = recentSaves.get(leadId);
      if (saved && saved.knockId != null) {
        try {
          await opts.patch(`/api/knocks/${saved.knockId}`, { notes });
          return "patched";
        } catch {
          return "not-found";
        }
      }
      return "not-found";
    },

    retryDead(clientId) {
      const targets = clientId == null ? dead.splice(0) : (() => {
        const i = dead.findIndex((d) => d.clientId === clientId);
        return i === -1 ? [] : dead.splice(i, 1);
      })();
      if (!targets.length) return;
      for (const item of targets) {
        item.attempts = 0;
        item.nextAttemptAt = 0;
        item.lastError = null;
        pending.push(item);
        setLeadState(item.leadId, "queued");
      }
      persistPending();
      persistDead();
      syncInterval();
      markChanged();
      void flush();
    },

    // The sheet's "Failed — retry" chip knows the lead, not the clientId.
    retryLead(leadId) {
      const ids = dead.filter((d) => d.leadId === leadId).map((d) => d.clientId);
      for (const id of ids) queue.retryDead(id);
    },

    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },

    getSnapshot: () => snapshot,

    destroy() {
      destroyed = true;
      if (interval != null) { clearInterval(interval); interval = null; }
      if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; }
      idleTimers.forEach((t) => clearTimeout(t));
      idleTimers.clear();
      listeners.clear();
      if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
      if (registry.get(opts.repId) === queue) registry.delete(opts.repId);
    },
  };

  // Reload recovery: persisted items resurface as queued/error chips, and the
  // first flush fires as soon as the caller has the queue object in hand.
  for (const it of pending) setLeadState(it.leadId, "queued");
  for (const it of dead) if (byLead[it.leadId] == null) setLeadState(it.leadId, "error");
  syncInterval();
  markChanged();
  queueMicrotask(() => { void flush(); });

  return queue;
}

// One live queue per rep — MapView and the lead sheet share state and timers.
// destroy() deregisters, so tests can create fresh instances per case.
const registry = new Map<number, KnockQueue>();

export function getKnockQueue(opts: KnockQueueOpts): KnockQueue {
  const existing = registry.get(opts.repId);
  if (existing) return existing;
  const q = createKnockQueue(opts);
  registry.set(opts.repId, q);
  return q;
}
