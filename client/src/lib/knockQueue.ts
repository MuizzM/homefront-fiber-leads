import { canAdoptLegacyWork, currentWorkLease, isCurrentWorkLease, sameWorkOwner, subscribeWorkAuthority, workOwnerKey, type WorkOwner, type WorkLease } from "./workAuthority";
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
import {
  classifyKnockFailure,
  isAutoRetryableDeadKnock,
  isKnockableLeadId,
  isLikelyRestartBurst403,
  summarizeDeadKnock,
  terminalKnockReason,
  triageRehydratedKnock,
  type DeadKnockSummary,
} from "@/features/knocking/knockFailurePolicy";

export type LeadSaveState = "idle" | "saving" | "saved" | "queued" | "error" | "superseded";

export interface QueueSnapshot {
  pendingCount: number;
  deadCount: number;
  // Dead-lane detail in queue order (oldest first) — the FieldStatusBar shows
  // the oldest item's door + reason, with Retry only when it can plausibly work.
  deadItems: DeadKnockSummary[];
  byLead: Record<number, LeadSaveState>; // no entry = "idle"
  online: boolean;
  /** leadId → the outcome this rep logged that has NOT reached the server yet.
   *
   *  This is what lets an optimistic pin survive a refetch. The recolor used to
   *  be a one-shot patch into the react-query cache, so ANY refetch landing
   *  before the queue flushed — a poll, the map-changed stream firing on a
   *  teammate's knock, a tab refocus — replaced it with server data that did
   *  not have the knock yet, and the pin visibly reverted. Exposing the pending
   *  outcomes means the overlay can be REBUILT from durable queue state after
   *  every server read instead of being lost by it. */
  pendingOutcomes: Record<number, { outcome: string; at: string }>;
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface KnockQueueOpts {
  owner?: WorkOwner;
  repId: number;
  post: (url: string, body: unknown, lease?: WorkLease | null) => Promise<any>; // parsed JSON; throws Error("<status>: <text>")
  patch: (url: string, body: unknown, lease?: WorkLease | null) => Promise<any>;
  storage?: StorageLike;
  now?: () => number;
  isOnline?: () => boolean;
  // parent hook invalidates react-query here. `campaignAwards` is whatever SPIFF
  // campaigns this knock just cleared — the server only returns freshly-booked
  // ones, so a dedupe replay carries none and cannot re-celebrate.
  onSaved?: (leadId: number, outcome?: string, superseded?: boolean, campaignAwards?: any[]) => void;
  // A knock the server can NEVER accept was auto-resolved (dropped from the
  // queue) — the parent hook toasts the door + reason once and re-syncs the
  // optimistic map state back to server truth. Fired at most once per item.
  onResolved?: (item: QueuedKnock, reason: string) => void;
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
  // Persist an accepted field action before optional GPS/network work.
  stage(k: EnqueueInput): { clientId: string };
  enrich(
    clientId: string,
    evidence: Pick<
      EnqueueInput,
      | "repLat"
      | "repLng"
      | "gpsAccuracy"
      | "deviceTs"
      | "mockLocation"
      | "netState"
      | "appVersion"
    >,
  ): boolean;
  // Resolves after the IMMEDIATE flush attempt (offline: resolves at once,
  // item queued) — callers may fire-and-forget, tests may await determinism.
  enqueue(k: EnqueueInput): Promise<{ clientId: string }>;
  flush(): Promise<void>;
  updateNote(leadId: number, notes: string): Promise<"merged" | "patched" | "not-found">;
  retryDead(clientId?: string): void; // no arg = retry ALL dead items
  retryLead(leadId: number): void; // sheet's error chip: retry every dead item for a lead
  // Recovery signal from OUTSIDE the queue (e.g. the query client's first
  // successful fetch after a failure period): runs one cooldown-gated silent
  // retry sweep of the RETRYABLE dead items. Safe to call any time.
  notifyRecovery(): void;
  subscribe(cb: () => void): () => void;
  getSnapshot(): QueueSnapshot; // referentially stable until state changes
  canCapture(): boolean;
  suspend(): void;
  resume(): void;
  destroy(): void;
}

// Failure routing lives in @/features/knocking/knockFailurePolicy (pure,
// test-pinned). In short: 401 pauses the line for re-auth; network/5xx/timeout
// stay PENDING with capped backoff forever (never a permanent dead-letter);
// 403 gets bounded retries then parks in the dead lane (retry works after
// re-auth); every other 4xx is terminal and AUTO-RESOLVES — dropped with a
// one-time explanation instead of nagging forever. The dead lane SELF-HEALS:
// a 403 during a restart burst is classified transient (budget untouched),
// and recovery signals (online, foreground, a successful response, app load)
// silently auto-retry the retryable dead items — see autoSweep below.
const SAVED_FLASH_MS = 2000;
const INTERVAL_MS = 30_000;
const RECENT_SAVES_CAP = 50;
// The dead lane self-heals on recovery signals, but at most one silent sweep
// per this window — a genuinely broken server can never be hot-looped.
const AUTO_RETRY_COOLDOWN_MS = 60_000;

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

function loadItems(storage: StorageLike, key: string, owner?: WorkOwner): QueuedKnock[] {
  const raw = storage.getItem(key);
  if (!raw) return [];
  try {
    const env = JSON.parse(raw);
    if (!env || env.v !== 1 || !Array.isArray(env.items) || (env.owner && owner && !sameWorkOwner(env.owner, owner))) {
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
  const registryKey = opts.owner ? workOwnerKey(opts.owner) : String(opts.repId);
  const pendingKey = opts.owner ? `hf.knockQueue.v2.${registryKey}` : `hf.knockQueue.v1.${opts.repId}`;
  const deadKey = opts.owner ? `hf.knockDead.v2.${registryKey}` : `hf.knockDead.v1.${opts.repId}`;
  if (opts.owner && canAdoptLegacyWork(opts.owner)) {
    for (const [legacy, current] of [[`hf.knockQueue.v1.${opts.repId}`, pendingKey], [`hf.knockDead.v1.${opts.repId}`, deadKey]]) {
      if (!storage.getItem(current) && storage.getItem(legacy)) storage.setItem(current, storage.getItem(legacy)!);
      storage.removeItem(legacy);
    }
  }

  // Rehydration triage: persisted items are migrated/repaired, undeliverable
  // ones (temp lead ids, outcomes the server no longer accepts, dead items
  // whose last failure was terminal) are DROPPED with a reason, and dead items
  // the OLD policy parked for transient failures go back into delivery.
  const pending: QueuedKnock[] = [];
  const dead: QueuedKnock[] = [];
  const droppedOnLoad: Array<{ item: QueuedKnock; reason: string }> = [];
  for (const raw of loadItems(storage, pendingKey, opts.owner)) {
    const t = triageRehydratedKnock(raw, "pending");
    if (!t) continue;
    if (t.action === "drop") droppedOnLoad.push({ item: t.item, reason: t.reason });
    else pending.push(t.item);
  }
  for (const raw of loadItems(storage, deadKey, opts.owner)) {
    const t = triageRehydratedKnock(raw, "dead");
    if (!t) continue;
    if (t.action === "drop") droppedOnLoad.push({ item: t.item, reason: t.reason });
    else if (t.action === "dead") dead.push(t.item);
    else pending.push(t.item);
  }
  const byLead: Record<number, LeadSaveState> = {};
  // leadId → last successful save, so a note edited after the save can still
  // PATCH the created row without a cache lookup. Capped FIFO — a shift is ~50 doors/hour.
  const recentSaves = new Map<number, { clientId: string; knockId: number }>();
  const listeners = new Set<() => void>();

  let snapshot: QueueSnapshot = { pendingCount: 0, deadCount: 0, deadItems: [], byLead: {}, online: true, pendingOutcomes: {} };
  let inflight = false;
  // Restart-burst detection: epoch ms of the last GENUINELY transient failure
  // (network/timeout/5xx/429) on this queue. A 403 landing inside the burst
  // window after it is treated as a proxy artifact of the outage, not CSRF.
  let lastTransientFailureAt = 0;
  // Self-healing dead lane: epoch ms of the last automatic retry sweep.
  let lastAutoSweepAt = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const idleTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let destroyed = false;
  let suspended = !!opts.owner && !currentWorkLease(opts.owner);
  let runVersion = 0;
  let unsubscribeAuthority = () => {};
  const canCapture = () => !destroyed && !suspended && (!opts.owner || !!currentWorkLease(opts.owner));
  const currentRun = (version: number, lease: WorkLease | null) => canCapture() && version === runVersion
    && (!opts.owner || isCurrentWorkLease(lease));

  const persist = (key: string, items: QueuedKnock[]): void => {
    if (items.length) storage.setItem(key, JSON.stringify({ v: 1, owner: opts.owner, items }));
    else storage.removeItem(key);
  };
  const persistPending = () => persist(pendingKey, pending);
  const persistDead = () => persist(deadKey, dead);

  // The ONLY place the snapshot object is rebuilt — getSnapshot returns the
  // cached reference otherwise (useSyncExternalStore tears on fresh objects).
  const markChanged = (): void => {
    // Newest queued outcome wins per door: two taps on one house before a flush
    // must overlay as the SECOND one, matching what the server will settle on.
    const pendingOutcomes: Record<number, { outcome: string; at: string }> = {};
    for (const it of pending) {
      const at = it.deviceTs ?? "";
      const prev = pendingOutcomes[it.leadId];
      if (!prev || at >= prev.at) pendingOutcomes[it.leadId] = { outcome: it.outcome, at };
    }
    snapshot = {
      pendingCount: pending.length,
      deadCount: dead.length,
      deadItems: dead.map(summarizeDeadKnock),
      byLead: { ...byLead },
      online: isOnline(),
      pendingOutcomes,
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
      if (!canCapture()) return;
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
    if (!canCapture()) return;
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
    if (!canCapture()) return;
    const t = now();
    let earliest = Infinity;
    for (const it of pending) {
      if (it.nextAttemptAt > t && it.nextAttemptAt < earliest) earliest = it.nextAttemptAt;
    }
    if (earliest === Infinity) return;
    retryTimer = setTimeout(() => { retryTimer = null; void flush(); }, Math.max(0, earliest - now()));
  };

  // Park a knock for a HUMAN (403 after bounded retries — retry plausibly
  // works once the rep re-authenticates). Never used for terminal failures.
  const deadLetter = (idx: number, item: QueuedKnock): void => {
    pending.splice(idx, 1);
    dead.push(item);
    persistPending();
    persistDead();
    setLeadState(item.leadId, "error");
    markChanged();
  };

  // AUTO-RESOLVE a knock the server can never accept: drop it, log it for
  // support, and let the parent hook explain it to the rep ONCE. The
  // alternative — a dead-letter the rep can "Retry" into the same rejection
  // forever — is a permanent nag that helps nobody (owner report).
  const resolveTerminal = (idx: number, item: QueuedKnock, reason: string): void => {
    pending.splice(idx, 1);
    persistPending();
    setLeadState(item.leadId, "idle");
    console.error(
      `[knockQueue] dropped undeliverable knock ${item.clientId} (lead ${item.leadId}, ${item.outcome}): ${reason}`,
      item.lastError ?? "",
    );
    markChanged();
    opts.onResolved?.(item, reason);
  };

  // ── Self-healing dead lane (owner report: "needs attention" after every ─────
  // server restart, cleared only by a manual tap). A RECOVERY SIGNAL — the
  // browser coming back online, the app returning to the foreground, ANY
  // successful delivery on this queue, the query client's first successful
  // fetch after a failure period (signalKnockRecovery), or app load itself —
  // runs ONE silent retry sweep of the RETRYABLE dead items (the 403 class).
  // Each swept item gets a SINGLE attempt (attempts = bound − 1): success
  // clears the pill with zero human action; another clean-air 403 re-parks it
  // immediately instead of hiding the pill through a whole fresh retry budget.
  // The cooldown guarantees a genuinely broken server sees at most one sweep
  // per minute — this can never hot-loop.
  const autoSweep = (): void => {
    if (!canCapture() || !isOnline()) return;
    const t = now();
    if (t - lastAutoSweepAt < AUTO_RETRY_COOLDOWN_MS) return;
    const targets: QueuedKnock[] = [];
    for (let i = 0; i < dead.length; ) {
      // Non-retryable leftovers (legacy terminal shapes) are NEVER touched —
      // re-posting them would be the same lie as offering their Retry.
      if (isAutoRetryableDeadKnock(dead[i])) targets.push(...dead.splice(i, 1));
      else i++;
    }
    if (!targets.length) return; // nothing to heal — don't consume the cooldown
    lastAutoSweepAt = t;
    for (const item of targets) {
      item.attempts = KNOCK_QUEUE_MAX_ATTEMPTS - 1; // one silent shot
      item.nextAttemptAt = 0;
      pending.push(item);
      setLeadState(item.leadId, "queued");
    }
    persistPending();
    persistDead();
    syncInterval();
    markChanged();
    // No-op when a flush is already running (it re-checks pending each pass
    // and delivers the swept items itself); otherwise starts the delivery.
    void flush();
  };

  async function flush(): Promise<void> {
    if (inflight || !canCapture()) return;
    if (!isOnline()) return;
    inflight = true;
    const version = runVersion;
    const lease = opts.owner ? currentWorkLease(opts.owner) : null;
    try {
      let idx = 0;
      // pending.length re-checked each pass — items enqueued mid-flush get sent too.
      while (idx < pending.length) {
        if (!currentRun(version, lease)) return;
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
          }, lease);
          if (!currentRun(version, lease)) return;
          // Created and clientId-deduped replays look the same here: done.
          pending.splice(idx, 1);
          persistPending();
          rememberSave(item.leadId, item.clientId, resp?.id);
          // REVIEWER GATE (HIGH ×3): the server now marks stale knocks with
          // `superseded` — the queue must know the difference between "applied"
          // and "recorded but discarded as stale" so the UI can tell the truth.
          setLeadState(item.leadId, resp?.superseded ? "superseded" : "saved");
          scheduleIdle(item.leadId);
          markChanged();
          opts.onSaved?.(
            item.leadId, item.outcome, resp?.superseded === true,
            Array.isArray(resp?.campaignAwards) ? resp.campaignAwards : undefined,
          );
          // A successful authenticated response IS a recovery signal: if an
          // outage parked retryable knocks in the dead lane, heal them now —
          // they ride this same flush pass (cooldown-gated, cheap no-op
          // whenever the dead lane is empty).
          autoSweep();
        } catch (err) {
          if (!currentRun(version, lease)) return;
          const message = err instanceof Error ? err.message : String(err);
          item.lastError = message; // apiRequest throws Error("<status>: <text>")
          const kind = classifyKnockFailure(message);
          if (kind === "auth") {
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
          if (kind === "terminal") {
            // The server will never accept this one — resolve it honestly and
            // keep the line moving.
            resolveTerminal(idx, item, terminalKnockReason(item));
            continue;
          }
          // RESTART-BURST 403: a 403 inside the burst window of a genuine
          // transient failure on this queue is most likely the reverse proxy
          // answering for a restarting server, not a real CSRF/authz
          // rejection. Treat it as transient — stays pending with backoff,
          // bounded-retry budget UNTOUCHED. Only real transient failures
          // open/refresh the window (checked before the update below), so a
          // genuine 403 storm can never keep itself classified as transient.
          const burst403 = isLikelyRestartBurst403(kind, lastTransientFailureAt, now());
          if (kind === "retryable") lastTransientFailureAt = now();
          if (!burst403) item.attempts += 1;
          if (kind === "forbidden" && !burst403 && item.attempts >= KNOCK_QUEUE_MAX_ATTEMPTS) {
            // 403 is ambiguous: a stale CSRF token heals on re-login (retry
            // works), a real authz rejection never will. After the bounded
            // retries, park it where the rep can SEE it, with Retry offered.
            deadLetter(idx, item);
            continue;
          }
          // Transient (network/5xx/timeout/429 — and 403 still within bounds
          // or inside a restart burst): stay pending and back off (capped at
          // 60s). NEVER dead-letter a transient failure permanently — the
          // heartbeat, the online listener, and re-auth all redeliver it
          // without the rep doing anything. Stop the pass: the connection is
          // likely down for the items behind too.
          item.nextAttemptAt = now() + retryDelayMs(item.attempts);
          persistPending();
          setLeadState(item.leadId, "queued");
          markChanged();
          break;
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
  // foreground each run one silent dead-lane sweep (cooldown-gated) before the
  // normal flush, so the "needs attention" pill heals itself after an outage.
  const onOnline = (): void => { if (!canCapture()) return; markChanged(); autoSweep(); void flush(); };
  const onVisible = (): void => {
    if (!canCapture()) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    autoSweep();
    void flush();
  };
  if (typeof window !== "undefined") window.addEventListener("online", onOnline);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);

  const stage = (k: EnqueueInput): { clientId: string } => {
    if (!canCapture()) throw new Error("Sign in before recording more work");
    // A temp optimistic pin (negative id) or garbage id must NEVER enter the
    // queue — it can only ever 404 and rot. Callers (useKnockLogger) block
    // this with a friendly toast first; throwing here is the last line.
    if (!isKnockableLeadId(k.leadId)) {
      throw new Error(`knockQueue: refusing to enqueue knock for non-positive leadId ${k.leadId}`);
    }
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
      // Evidence can be enriched after this durable write. Reload recovery may
      // send without it, which is preferable to losing the disposition.
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
    return { clientId: item.clientId };
  };

  const queue: KnockQueue = {
    stage,

    enrich(clientId, evidence) {
      if (!canCapture()) return false;
      const item = pending.find((candidate) => candidate.clientId === clientId);
      if (!item) return false;
      item.repLat = evidence.repLat ?? null;
      item.repLng = evidence.repLng ?? null;
      item.gpsAccuracy = evidence.gpsAccuracy ?? null;
      item.deviceTs = evidence.deviceTs ?? null;
      item.mockLocation = evidence.mockLocation ?? null;
      item.netState = evidence.netState ?? null;
      item.appVersion = evidence.appVersion ?? null;
      persistPending();
      return true;
    },

    enqueue(k) {
      const staged = stage(k);
      // Await the immediate attempt so `await enqueue()` is deterministic;
      // fire-and-forget callers just ignore the promise.
      return flush().then(() => staged);
    },

    flush,

    // Note edits ride along with an unsent knock when possible (one request,
    // works offline); otherwise PATCH the already-created row.
    async updateNote(leadId, notes) {
      if (!canCapture()) return "not-found";
      const version = runVersion;
      const lease = opts.owner ? currentWorkLease(opts.owner) : null;
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
          await opts.patch(`/api/knocks/${saved.knockId}`, { notes }, lease);
          if (!currentRun(version, lease)) return "not-found";
          return "patched";
        } catch {
          return "not-found";
        }
      }
      return "not-found";
    },

    retryDead(clientId) {
      if (!canCapture()) return;
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

    notifyRecovery() {
      autoSweep();
    },

    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },

    getSnapshot: () => snapshot,

    canCapture,
    suspend() {
      suspended = true; runVersion++; inflight = false;
      if (interval != null) { clearInterval(interval); interval = null; }
      if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; }
      idleTimers.forEach(clearTimeout); idleTimers.clear();
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
      dead.length = 0; recentSaves.clear();

      if (interval != null) { clearInterval(interval); interval = null; }
      if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; }
      idleTimers.forEach((t) => clearTimeout(t));
      idleTimers.clear();
      listeners.clear();
      if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      if (registry.get(registryKey) === queue) registry.delete(registryKey);
    },
  };

  if (opts.owner) unsubscribeAuthority = subscribeWorkAuthority(event => {
    if (event === "purge") {
      storage.removeItem(pendingKey);
      storage.removeItem(deadKey);
      queue.destroy();
    } else if (event === "discard") queue.destroy();
    else if (event === "suspend") queue.suspend();
    else if (currentWorkLease(opts.owner)) queue.resume();
  });

  // Reload recovery: persisted items resurface as queued/error chips, and the
  // first flush fires as soon as the caller has the queue object in hand.
  // Triage may have moved/dropped items — persist BOTH lanes so a dropped
  // poison item can never resurrect on the next reload.
  persistPending();
  persistDead();
  for (const it of pending) setLeadState(it.leadId, "queued");
  for (const it of dead) if (byLead[it.leadId] == null) setLeadState(it.leadId, "error");
  syncInterval();
  markChanged();
  // Undeliverable items found at load resolve exactly like an in-flight
  // terminal failure: support log + one explanation to the rep. Deferred a
  // microtask so the caller holds the queue (and its toast plumbing) first.
  if (droppedOnLoad.length) {
    queueMicrotask(() => {
      if (!canCapture()) return;
      for (const d of droppedOnLoad) {
        console.error(
          `[knockQueue] dropped undeliverable knock ${d.item.clientId} (lead ${d.item.leadId}, ${d.item.outcome}): ${d.reason}`,
          d.item.lastError ?? "",
        );
        opts.onResolved?.(d.item, d.reason);
      }
    });
  }
  // REHYDRATION HEAL: retryable dead items that survived the reload get one
  // silent retry attempt right away (autoSweep) instead of waiting for a human
  // tap — after a server restart the pill vanishes on its own; if the server
  // is still broken the single attempt re-parks them and the pill stays honest.
  queueMicrotask(() => { autoSweep(); void flush(); });

  return queue;
}

// One live queue per rep — MapView and the lead sheet share state and timers.
// destroy() deregisters, so tests can create fresh instances per case.
const registry = new Map<string, KnockQueue>();

export function getKnockQueue(opts: KnockQueueOpts): KnockQueue {
  const registryKey = opts.owner ? workOwnerKey(opts.owner) : String(opts.repId);
  const existing = registry.get(registryKey);
  if (existing) return existing;
  const q = createKnockQueue(opts);
  registry.set(registryKey, q);
  return q;
}

// Recovery broadcast for signals observed OUTSIDE any queue — the query
// client's first successful fetch after a failure period (see queryClient.ts).
// Every live queue runs one cooldown-gated silent sweep of its dead lane.
export function signalKnockRecovery(): void {
  registry.forEach((q) => q.notifyRecovery());
}
