import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createKnockQueue, getKnockQueue } from "@/lib/knockQueue";
import { noteQueryOutcome } from "@/lib/queryClient";
import { RESTART_BURST_WINDOW_MS } from "@/features/knocking/knockFailurePolicy";
import { KNOCK_QUEUE_MAX_ATTEMPTS } from "@shared/knock";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * CONTRACT (LOGIC agent, client/src/lib/knockQueue.ts). These tests ARE the
 * spec for the offline-first knock queue:
 *
 *   createKnockQueue({ repId, storage, post, patch, isOnline, now, onSaved? })
 *     .enqueue({ leadId, outcome, notes?, callbackDate?, callbackTime? })
 *         → Promise<void>; records the tap; when isOnline(), attempts the POST
 *           before resolving (offline it resolves immediately, item queued)
 *     .flush() → Promise<void>; drains all DUE items; coalesces with any
 *           in-flight flush so a knock is never double-posted
 *     .updateNote(leadId, notes) → Promise<"merged" | "patched" | "not-found">
 *           merged  = folded into a still-pending item (rides the POST)
 *           patched = knock already saved → PATCH /api/knocks/:id
 *     .retryDead() → moves dead-letter items back to pending, immediately due
 *     .getSnapshot() → { pendingCount, deadCount, byLead } — referentially
 *           stable until state changes (useSyncExternalStore-safe); an absent
 *           byLead key reads as "idle"
 *
 *   Wire contract: post(url, body) → parsed row {id, deduped?}; body carries
 *   clientId/repId/outcome/knockedAt(tap time, ISO)/notes/callback fields and
 *   NEVER wasHome (server derives it). Errors are Error("<status>: <text>").
 *
 *   FAILURE LIFECYCLE (the dead-letter contract):
 *     401              → auth pause: stays pending, NO attempt consumed,
 *                        line resumes after re-auth.
 *     network/5xx/429  → RETRYABLE: stays pending with capped backoff FOREVER —
 *                        a transient failure never becomes a permanent
 *                        dead-letter.
 *     403              → bounded retries, then parks in the DEAD lane (a CSRF
 *                        403 heals after re-login, so Retry plausibly works).
 *                        retryDead() resets attempts/backoff and redelivers.
 *                        EXCEPT during a restart burst: a 403 landing within
 *                        RESTART_BURST_WINDOW_MS of a transient failure on the
 *                        same queue is a reverse-proxy artifact of the outage —
 *                        classified TRANSIENT, bounded budget untouched.
 *     other 4xx        → TERMINAL: the server can never accept it. AUTO-RESOLVES
 *                        (dropped, onResolved(item, reason) fired once, logged) —
 *                        never a "needs attention" nag, never blocks the line.
 *
 *   SELF-HEALING DEAD LANE: recovery signals — the browser online event, the
 *   app returning to the foreground (visibilitychange), ANY successful delivery
 *   on the queue, the query client's first successful fetch after a failure
 *   period (noteQueryOutcome → signalKnockRecovery → notifyRecovery), and app
 *   load itself — each run ONE silent retry sweep of the RETRYABLE dead items
 *   (one attempt per item; success clears the pill with zero human action, a
 *   clean-air 403 re-parks immediately). A 60s cooldown between sweeps means a
 *   genuinely broken server is never hot-looped. Non-retryable items are never
 *   swept. The manual Retry contract is unchanged while items are parked.
 *   Enqueueing a non-positive leadId (temp optimistic pin) throws — poison can
 *   never enter the queue. Rehydration triages persisted items: stale shapes
 *   are migrated, undeliverable items (temp ids, unknown outcomes, dead items
 *   whose last failure was terminal) auto-resolve via onResolved, and dead
 *   items parked by the old transient policy return to pending.
 *
 *   Persistence: one storage key per rep, envelope {v:1, items:[QueuedKnock]};
 *   unknown envelope versions are discarded; a throwing storage degrades to
 *   memory-only. byLead "saved" decays to "idle" after 2000ms.
 * ────────────────────────────────────────────────────────────────────────────
 */

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type PostFn = (url: string, body: any) => Promise<any>;

function fakeStorage(opts: { throwOnSet?: boolean } = {}) {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (opts.throwOnSet) throw new Error("QuotaExceededError");
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
    // Key-agnostic peek at whatever the queue persisted.
    dump: () => [...data.values()],
  };
}

// The queue writes a single envelope per rep — grab it without knowing the key.
function readEnvelope(storage: ReturnType<typeof fakeStorage>) {
  const raw = storage.dump();
  expect(raw.length).toBeGreaterThan(0);
  return JSON.parse(raw[raw.length - 1]);
}

const okPost: PostFn = async () => ({ id: 101 });

function mkQueue(opts: {
  post?: PostFn;
  patch?: PostFn;
  storage?: StorageLike;
  online?: boolean;
  repId?: number;
  onSaved?: (leadId: number) => void;
  onResolved?: (item: any, reason: string) => void;
} = {}) {
  const post = vi.fn(opts.post ?? okPost);
  const patch = vi.fn(opts.patch ?? okPost);
  const storage = opts.storage ?? fakeStorage();
  const net = { online: opts.online ?? true };
  const onResolved = vi.fn(opts.onResolved);
  const q = createKnockQueue({
    repId: opts.repId ?? 9,
    storage,
    post,
    patch,
    isOnline: () => net.online,
    now: () => Date.now(), // fake timers make this fully deterministic
    onSaved: opts.onSaved,
    onResolved,
  });
  return { q, post, patch, storage, onResolved, setOnline: (v: boolean) => void (net.online = v) };
}

// Contract: an absent byLead entry means the lead is idle.
const leadState = (q: ReturnType<typeof createKnockQueue>, leadId: number) =>
  q.getSnapshot().byLead[leadId] ?? "idle";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("knockQueue — online happy path", () => {
  it("POSTs once to /api/leads/:id/knock with the wire body (and NO wasHome)", async () => {
    const { q, post } = mkQueue();
    await q.enqueue({ leadId: 7, outcome: "interested" });

    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0];
    expect(url).toBe("/api/leads/7/knock");
    expect(typeof body.clientId).toBe("string");
    expect(body.clientId.length).toBeGreaterThan(0);
    expect(body.repId).toBe(9);
    expect(body.outcome).toBe("interested");
    expect(body.knockedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // wasHome is server-derived; the client must never send it.
    expect("wasHome" in body).toBe(false);
    expect(q.getSnapshot().pendingCount).toBe(0);
  });

  it('byLead transitions "saved" → "idle" after 2000ms', async () => {
    const { q } = mkQueue();
    await q.enqueue({ leadId: 7, outcome: "sold" });

    expect(leadState(q, 7)).toBe("saved");
    await vi.advanceTimersByTimeAsync(2000);
    expect(leadState(q, 7)).toBe("idle");
  });

  it("fires onSaved with the leadId on success", async () => {
    const onSaved = vi.fn();
    const { q } = mkQueue({ onSaved });
    await q.enqueue({ leadId: 7, outcome: "sold" });

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved.mock.calls[0][0]).toBe(7);
  });
});

describe("knockQueue — offline queueing", () => {
  it("durably stages a tap before asynchronous evidence capture or flushing", async () => {
    const storage = fakeStorage();
    const { q, post } = mkQueue({ storage });

    const { clientId } = q.stage({
      leadId: 7,
      outcome: "interested",
      deviceTs: "2026-07-28T12:00:00.000Z",
    });

    expect(post).not.toHaveBeenCalled();
    expect(q.getSnapshot().pendingCount).toBe(1);
    expect(readEnvelope(storage).items[0]).toMatchObject({
      clientId,
      leadId: 7,
      outcome: "interested",
      deviceTs: "2026-07-28T12:00:00.000Z",
    });

    expect(q.enrich(clientId, {
      repLat: 35.2271,
      repLng: -80.8431,
      gpsAccuracy: 8,
      deviceTs: "2026-07-28T12:00:01.000Z",
      mockLocation: false,
      netState: "online",
      appVersion: "test",
    })).toBe(true);
    await q.flush();

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).toMatchObject({
      repLat: 35.2271,
      repLng: -80.8431,
      gpsAccuracy: 8,
      deviceTs: "2026-07-28T12:00:01.000Z",
    });
  });

  it("queues without posting while offline; flipping online + flush drains", async () => {
    const { q, post, setOnline } = mkQueue({ online: false });
    await q.enqueue({ leadId: 7, outcome: "interested" });

    expect(post).not.toHaveBeenCalled();
    expect(leadState(q, 7)).toBe("queued");
    expect(q.getSnapshot().pendingCount).toBe(1);

    setOnline(true);
    vi.advanceTimersByTime(5000); // flush happens later than the tap…
    await q.flush();

    expect(post).toHaveBeenCalledTimes(1);
    expect(q.getSnapshot().pendingCount).toBe(0);
    // …but knockedAt is the TAP time, not the flush time.
    const sentAt = new Date(post.mock.calls[0][1].knockedAt).getTime();
    expect(sentAt).toBe(Date.now() - 5000);
  });

  it("survives a reload: a second queue on the same storage loads and drains the item", async () => {
    const storage = fakeStorage();
    const first = mkQueue({ storage, online: false });
    await first.q.enqueue({ leadId: 7, outcome: "follow_up", notes: "come back Saturday" });
    expect(first.post).not.toHaveBeenCalled();

    // Same storage + repId = the app reloaded.
    const second = mkQueue({ storage });
    expect(second.q.getSnapshot().pendingCount).toBe(1);

    await second.q.flush();
    expect(second.post).toHaveBeenCalledTimes(1);
    const [url, body] = second.post.mock.calls[0];
    expect(url).toBe("/api/leads/7/knock");
    expect(body.notes).toBe("come back Saturday");
    expect(second.q.getSnapshot().pendingCount).toBe(0);
  });
});

describe("knockQueue — failure handling", () => {
  it("keeps a transiently-failed (500) item pending and retries only after the backoff", async () => {
    let failures = 1;
    const { q, post, storage } = mkQueue({
      post: async () => {
        if (failures-- > 0) throw new Error("500: boom");
        return { id: 11 };
      },
    });
    await q.enqueue({ leadId: 7, outcome: "interested" });

    // Loop stopped after the failure — no hot retry storm.
    expect(post).toHaveBeenCalledTimes(1);
    expect(q.getSnapshot().pendingCount).toBe(1);
    expect(leadState(q, 7)).toBe("queued");

    // Persisted envelope records the attempt (v1 is the only readable version).
    const env = readEnvelope(storage);
    expect(env.v).toBe(1);
    expect(env.items[0].attempts).toBe(1);

    await q.flush(); // not due yet → skipped
    expect(post).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000); // past even the max backoff
    await q.flush();
    expect(post).toHaveBeenCalledTimes(2);
    expect(q.getSnapshot().pendingCount).toBe(0);
    expect(leadState(q, 7)).toBe("saved");
  });

  it("auto-resolves a terminal (404) failure — dropped with a reason, never a dead-letter, line keeps moving", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { q, post, onResolved, setOnline } = mkQueue({
      online: false,
      post: async (url: string) => {
        if (url === "/api/leads/7/knock") throw new Error("404: Not found");
        return { id: 55 };
      },
    });
    await q.enqueue({ leadId: 7, outcome: "interested" });
    await q.enqueue({ leadId: 8, outcome: "sold" });

    setOnline(true);
    await q.flush();

    const snap = q.getSnapshot();
    // The server will never accept it: not pending, not dead — RESOLVED.
    expect(snap.deadCount).toBe(0);
    expect(snap.pendingCount).toBe(0);
    expect(leadState(q, 7)).toBe("idle");
    // The rep gets one honest explanation with the door and the reason.
    expect(onResolved).toHaveBeenCalledTimes(1);
    const [item, reason] = onResolved.mock.calls[0];
    expect(item.leadId).toBe(7);
    expect(reason).toContain("no longer exists");
    // Support can trace it.
    expect(console.error).toHaveBeenCalled();
    // The poison item did NOT stop lead 8 from saving.
    expect(leadState(q, 8)).toBe("saved");
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("auto-resolves a 400 the server will never accept, with a validation reason", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { q, onResolved } = mkQueue({
      post: async () => { throw new Error("400: invalid outcome"); },
    });
    await q.enqueue({ leadId: 7, outcome: "sold" });

    expect(q.getSnapshot().pendingCount).toBe(0);
    expect(q.getSnapshot().deadCount).toBe(0);
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved.mock.calls[0][1]).toContain("rejected it as invalid");
  });

  it(`NEVER dead-letters transient failures: still pending past ${KNOCK_QUEUE_MAX_ATTEMPTS} attempts, delivers on recovery`, async () => {
    let healthy = false;
    const { q, post } = mkQueue({
      post: async () => {
        if (!healthy) throw new Error("503: unavailable");
        return { id: 11 };
      },
    });
    await q.enqueue({ leadId: 7, outcome: "interested" });

    // Fail well past the old "8 strikes = dead" limit.
    for (let i = 0; i < KNOCK_QUEUE_MAX_ATTEMPTS + 3; i++) {
      await q.flush();
      vi.advanceTimersByTime(61_000); // clear any backoff before the next pass
    }
    await q.flush(); // settle the last in-flight attempt
    expect(post.mock.calls.length).toBeGreaterThan(KNOCK_QUEUE_MAX_ATTEMPTS);
    expect(q.getSnapshot().deadCount).toBe(0); // transient = never dead
    expect(q.getSnapshot().pendingCount).toBe(1); // still in delivery
    expect(leadState(q, 7)).toBe("queued");

    // The outage ends — the queue's own backoff timer delivers it with no
    // human action ("saved" then decays to idle within the advance window).
    healthy = true;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(q.getSnapshot().pendingCount).toBe(0);
    expect(q.getSnapshot().deadCount).toBe(0);
  });

  it("401 pauses the line without consuming an attempt (valid knock waiting for re-auth)", async () => {
    let authed = false;
    const { q, post } = mkQueue({
      post: async () => {
        if (!authed) throw new Error("401: session expired");
        return { id: 21 };
      },
    });
    await q.enqueue({ leadId: 7, outcome: "interested" });

    expect(q.getSnapshot().pendingCount).toBe(1);
    expect(q.getSnapshot().deadCount).toBe(0);
    expect(leadState(q, 7)).toBe("queued");

    // Attempts were NOT consumed — re-auth then a heartbeat delivers it.
    authed = true;
    vi.advanceTimersByTime(61_000);
    await q.flush();
    expect(q.getSnapshot().pendingCount).toBe(0);
    expect(leadState(q, 7)).toBe("saved");
    expect(post).toHaveBeenCalledTimes(2);
  });

  it(`403 gets ${KNOCK_QUEUE_MAX_ATTEMPTS} bounded retries, then parks in the dead lane with a retryable reason`, async () => {
    const { q, post } = mkQueue({
      post: async () => { throw new Error("403: CSRF validation failed"); },
    });
    await q.enqueue({ leadId: 7, outcome: "sold" });

    for (let i = 0; i < KNOCK_QUEUE_MAX_ATTEMPTS; i++) {
      await q.flush();
      vi.advanceTimersByTime(61_000);
    }
    expect(post).toHaveBeenCalledTimes(KNOCK_QUEUE_MAX_ATTEMPTS);
    const snap = q.getSnapshot();
    expect(snap.deadCount).toBe(1);
    expect(snap.pendingCount).toBe(0);
    expect(leadState(q, 7)).toBe("error");
    // The FieldStatusBar can say which door, why, and that Retry may work —
    // and the copy points at assignment, never a re-auth wild goose.
    expect(snap.deadItems).toHaveLength(1);
    expect(snap.deadItems[0]).toMatchObject({ leadId: 7, retryable: true });
    expect(snap.deadItems[0].reason).toContain("isn't in your assigned area");
    expect(snap.deadItems[0].reason).not.toContain("sign out");

    await q.flush(); // dead items are never auto-retried
    expect(post).toHaveBeenCalledTimes(KNOCK_QUEUE_MAX_ATTEMPTS);
  });

  it("retryDead resets attempts/backoff, moves the item back to pending, and flush redelivers it", async () => {
    let dead = true;
    const { q, post, storage } = mkQueue({
      post: async () => {
        if (dead) throw new Error("403: forbidden");
        return { id: 12 };
      },
    });
    await q.enqueue({ leadId: 7, outcome: "sold" });
    for (let i = 0; i < KNOCK_QUEUE_MAX_ATTEMPTS - 1; i++) {
      vi.advanceTimersByTime(61_000);
      await q.flush();
    }
    expect(q.getSnapshot().deadCount).toBe(1);
    expect(leadState(q, 7)).toBe("error");

    dead = false;
    q.retryDead();
    expect(q.getSnapshot().deadCount).toBe(0);
    expect(q.getSnapshot().pendingCount).toBe(1);
    // Reset semantics: fresh attempt budget, immediately due, error cleared.
    const env = readEnvelope(storage);
    expect(env.items[0]).toMatchObject({ attempts: 0, nextAttemptAt: 0, lastError: null });

    await q.flush(); // no leftover backoff after a manual retry
    expect(post).toHaveBeenCalledTimes(KNOCK_QUEUE_MAX_ATTEMPTS + 1);
    expect(q.getSnapshot().pendingCount).toBe(0);
    expect(leadState(q, 7)).toBe("saved");
  });

  it("refuses to enqueue a knock against a non-positive lead id (temp optimistic pin)", () => {
    const { q, post } = mkQueue();
    expect(() => q.stage({ leadId: -3, outcome: "interested" })).toThrow(/non-positive/);
    expect(() => q.stage({ leadId: 0, outcome: "interested" })).toThrow(/non-positive/);
    expect(q.getSnapshot().pendingCount).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("knockQueue — rehydration triage (reload survival)", () => {
  const baseItem = (over: Record<string, unknown> = {}) => ({
    clientId: `c-${Math.random().toString(36).slice(2)}`,
    leadId: 7,
    repId: 9,
    outcome: "interested",
    knockedAt: "2026-07-30T12:00:00.000Z",
    notes: null,
    callbackDate: null,
    callbackTime: null,
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    ...over,
  });
  const seed = (storage: ReturnType<typeof fakeStorage>, lane: "hf.knockQueue.v1.9" | "hf.knockDead.v1.9", items: unknown[]) =>
    storage.setItem(lane, JSON.stringify({ v: 1, items }));

  it("REHYDRATION HEAL: a rehydrated retryable dead item gets one SILENT retry at load and clears itself", async () => {
    const storage = fakeStorage();
    seed(storage, "hf.knockDead.v1.9", [baseItem({ lastError: "403: forbidden", attempts: 8 })]);

    // The server restarted overnight and is healthy again — the old parked
    // knock delivers on load with ZERO human action, and the pill never shows.
    const { q, post } = mkQueue({ storage });
    await vi.advanceTimersByTimeAsync(0); // settle load-time microtasks
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe("/api/leads/7/knock");
    expect(q.getSnapshot().deadCount).toBe(0);
    expect(q.getSnapshot().pendingCount).toBe(0);
    expect(leadState(q, 7)).toBe("saved");
  });

  it("FIX 3 (open-field): a knock parked by the unassigned-lead 403 bug redelivers on load once the server opens", async () => {
    // Production shape of the bug: the rep's knock on an UNASSIGNED lead parked
    // in the dead lane (403 class) and re-nagged on every app run with a
    // "sign out and back in" reason. After the server opens the field, the
    // load-time silent sweep re-attempts the SAME item and it delivers —
    // no storage migration, no human tap, knock not lost.
    const storage = fakeStorage();
    seed(storage, "hf.knockDead.v1.9", [baseItem({ lastError: "403: Forbidden", attempts: 8 })]);

    const onSaved = vi.fn();
    const { q, post, onResolved } = mkQueue({ storage, onSaved });
    await vi.advanceTimersByTimeAsync(0); // settle load-time autoSweep + flush

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe("/api/leads/7/knock");
    expect(post.mock.calls[0][1].outcome).toBe("interested");
    expect(q.getSnapshot().deadCount).toBe(0);
    expect(q.getSnapshot().pendingCount).toBe(0);
    expect(leadState(q, 7)).toBe("saved");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onResolved).not.toHaveBeenCalled(); // redelivered, NOT dropped

    // While it WAS parked (server still closed), the pill named the real fix —
    // assignment — and never sent the rep on a re-auth wild goose.
    const stillClosed = fakeStorage();
    seed(stillClosed, "hf.knockDead.v1.9", [baseItem({ lastError: "403: Forbidden", attempts: 8 })]);
    const parked = mkQueue({
      storage: stillClosed,
      post: async () => { throw new Error("403: Forbidden"); },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(parked.q.getSnapshot().deadCount).toBe(1);
    const summary = parked.q.getSnapshot().deadItems[0];
    expect(summary.retryable).toBe(true);
    expect(summary.reason).toContain("isn't in your assigned area");
    expect(summary.reason).toContain("your manager can assign it");
    expect(summary.reason).not.toContain("sign out");
    parked.q.destroy();
  });

  it("a rehydrated dead item whose silent retry STILL 403s re-parks after ONE attempt; manual Retry still redelivers", async () => {
    const storage = fakeStorage();
    seed(storage, "hf.knockDead.v1.9", [baseItem({ lastError: "403: forbidden", attempts: 8 })]);

    let broken = true;
    const { q, post } = mkQueue({
      storage,
      post: async () => {
        if (broken) throw new Error("403: forbidden");
        return { id: 12 };
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    // Exactly one silent attempt — the server is genuinely still broken, so the
    // item goes straight back to the dead lane and the pill stays honest.
    expect(post).toHaveBeenCalledTimes(1);
    expect(q.getSnapshot().deadCount).toBe(1);
    expect(q.getSnapshot().deadItems[0]).toMatchObject({ leadId: 7, retryable: true });
    expect(leadState(q, 7)).toBe("error");

    // The FieldStatusBar's manual Retry contract is unchanged while it exists.
    broken = false;
    q.retryDead();
    await q.flush();
    expect(post).toHaveBeenCalledTimes(2);
    expect(q.getSnapshot().deadCount).toBe(0);
    expect(q.getSnapshot().pendingCount).toBe(0);
    expect(leadState(q, 7)).toBe("saved");
  });

  it("a legacy dead item with a TERMINAL lastError auto-resolves at load (no permanent nag)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = fakeStorage();
    seed(storage, "hf.knockDead.v1.9", [baseItem({ lastError: "404: Not found", attempts: 1 })]);

    const { q, post, onResolved } = mkQueue({ storage });
    await vi.advanceTimersByTimeAsync(0);

    expect(q.getSnapshot().deadCount).toBe(0);
    expect(q.getSnapshot().pendingCount).toBe(0);
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved.mock.calls[0][1]).toContain("no longer exists");
    expect(post).not.toHaveBeenCalled(); // never re-posted into the same 404
    // And the drop is durable — a THIRD load reports nothing.
    const again = mkQueue({ storage });
    await vi.advanceTimersByTimeAsync(0);
    expect(again.onResolved).not.toHaveBeenCalled();
    expect(again.q.getSnapshot().deadCount).toBe(0);
  });

  it("a legacy dead item parked by the old transient policy returns to PENDING and delivers", async () => {
    const storage = fakeStorage();
    seed(storage, "hf.knockDead.v1.9", [baseItem({ lastError: "503: unavailable", attempts: 8, nextAttemptAt: 99 })]);

    const { q, post } = mkQueue({ storage });
    await vi.advanceTimersByTimeAsync(0); // load-time flush runs
    expect(q.getSnapshot().deadCount).toBe(0);
    expect(post).toHaveBeenCalledTimes(1); // fresh budget, immediately due
    expect(q.getSnapshot().pendingCount).toBe(0);
  });

  it("a persisted knock against a temp (negative) lead id is dropped at load with a reason", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = fakeStorage();
    seed(storage, "hf.knockQueue.v1.9", [baseItem({ leadId: -4 }), baseItem({ leadId: 8 })]);

    const { q, post, onResolved } = mkQueue({ storage });
    await vi.advanceTimersByTimeAsync(0);

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved.mock.calls[0][0].leadId).toBe(-4);
    expect(onResolved.mock.calls[0][1]).toContain("never finished saving");
    // The healthy sibling still delivered.
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe("/api/leads/8/knock");
    expect(q.getSnapshot().pendingCount).toBe(0);
    expect(q.getSnapshot().deadCount).toBe(0);
  });

  it("migrates a stale-shaped pending item (missing new fields) instead of dropping it", async () => {
    const storage = fakeStorage();
    // An old app version wrote only the original fields.
    seed(storage, "hf.knockQueue.v1.9", [{
      clientId: "old-1", leadId: 7, repId: 9, outcome: "callback",
      knockedAt: "2026-07-30T12:00:00.000Z", notes: "ring twice",
      callbackDate: "2026-08-02", callbackTime: "18:00",
      attempts: 2, nextAttemptAt: 0, lastError: "500: boom",
    }]);

    const { q, post } = mkQueue({ storage });
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0];
    expect(url).toBe("/api/leads/7/knock");
    expect(body).toMatchObject({
      clientId: "old-1", outcome: "callback", notes: "ring twice",
      callbackDate: "2026-08-02", repLat: null, mockLocation: null, appVersion: null,
    });
    expect(q.getSnapshot().pendingCount).toBe(0);
  });
});

describe("knockQueue — restart-burst 403 classification", () => {
  it("a 403 during a restart burst stays PENDING with the retry budget untouched, then delivers on recovery", async () => {
    let mode: "down" | "proxy403" | "ok" = "down";
    const { q, storage } = mkQueue({
      post: async () => {
        if (mode === "down") throw new Error("503: unavailable");
        if (mode === "proxy403") throw new Error("403: Forbidden");
        return { id: 31 };
      },
    });
    await q.enqueue({ leadId: 7, outcome: "interested" }); // 503 opens the burst window
    expect(readEnvelope(storage).items[0].attempts).toBe(1);

    // The reverse proxy answers 403 while the server restarts — hammer well
    // past the bounded budget, all inside the burst window (4s backoff each).
    mode = "proxy403";
    for (let i = 0; i < KNOCK_QUEUE_MAX_ATTEMPTS + 2; i++) {
      await vi.advanceTimersByTimeAsync(4_000);
      await q.flush();
    }
    expect(q.getSnapshot().deadCount).toBe(0); // never parked — the pill never appears
    expect(q.getSnapshot().pendingCount).toBe(1); // still in delivery
    expect(readEnvelope(storage).items[0].attempts).toBe(1); // budget untouched
    expect(leadState(q, 7)).toBe("queued");

    // Restart finishes — the queue's own timer delivers it, no human action.
    mode = "ok";
    await vi.advanceTimersByTimeAsync(4_000);
    await q.flush();
    expect(q.getSnapshot().pendingCount).toBe(0);
    expect(q.getSnapshot().deadCount).toBe(0);
  });

  it("a clean-air 403 AFTER the burst window closes resumes the bounded → dead-lane path", async () => {
    let mode: "down" | "authz403" = "down";
    const { q, setOnline } = mkQueue({
      post: async () => {
        throw new Error(mode === "down" ? "503: unavailable" : "403: not your lead");
      },
    });
    await q.enqueue({ leadId: 7, outcome: "sold" }); // 503 opens the window…
    // …then radio silence until the window has fully expired.
    setOnline(false);
    await vi.advanceTimersByTimeAsync(RESTART_BURST_WINDOW_MS + 1_000);
    setOnline(true);

    mode = "authz403"; // a REAL 403 now — no recent transient failure
    for (let i = 0; i < KNOCK_QUEUE_MAX_ATTEMPTS; i++) {
      await vi.advanceTimersByTimeAsync(61_000);
      await q.flush();
    }
    // The bounded budget was consumed and the knock parked for a human.
    expect(q.getSnapshot().deadCount).toBe(1);
    expect(q.getSnapshot().pendingCount).toBe(0);
    expect(q.getSnapshot().deadItems[0]).toMatchObject({ leadId: 7, retryable: true });
  });
});

describe("knockQueue — self-healing dead lane (recovery signals)", () => {
  // Park one 403 dead item the way production does: bounded retries, then dead.
  const park403 = async (q: ReturnType<typeof createKnockQueue>) => {
    await q.enqueue({ leadId: 7, outcome: "sold" });
    for (let i = 0; i < KNOCK_QUEUE_MAX_ATTEMPTS - 1; i++) {
      vi.advanceTimersByTime(61_000);
      await q.flush();
    }
    expect(q.getSnapshot().deadCount).toBe(1);
  };

  it("the browser online event auto-retries the dead lane ONCE, with the 60s cooldown enforced", async () => {
    let healthy = false;
    const { q, post } = mkQueue({
      post: async () => {
        if (!healthy) throw new Error("403: Forbidden");
        return { id: 61 };
      },
    });
    await park403(q);
    const before = post.mock.calls.length;

    // Server still broken: the sweep spends exactly ONE silent attempt, then
    // re-parks — the pill stays honest while the server is actually down.
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(before + 1);
    expect(q.getSnapshot().deadCount).toBe(1);

    // A second signal inside the cooldown must NOT hot-loop the server.
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(before + 1);
    expect(q.getSnapshot().deadCount).toBe(1);

    // Past the cooldown with the server healthy: the pill clears itself.
    healthy = true;
    vi.advanceTimersByTime(60_000);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(q.getSnapshot().deadCount).toBe(0);
    expect(q.getSnapshot().pendingCount).toBe(0);
    q.destroy();
  });

  it("returning to the foreground (visibilitychange) sweeps the dead lane — pill clears with zero taps", async () => {
    let healthy = false;
    const { q, post } = mkQueue({
      post: async () => {
        if (!healthy) throw new Error("403: Forbidden");
        return { id: 62 };
      },
    });
    await park403(q);
    const before = post.mock.calls.length;

    healthy = true; // the outage ended while the app was backgrounded
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(before + 1);
    expect(q.getSnapshot().deadCount).toBe(0);
    expect(q.getSnapshot().pendingCount).toBe(0);
    expect(leadState(q, 7)).toBe("saved");
    q.destroy();
  });

  it("a successful delivery on the queue is itself a recovery signal — dead items ride the same flush", async () => {
    let broken = true;
    const { q, post } = mkQueue({
      post: async () => {
        if (broken) throw new Error("403: Forbidden");
        return { id: 71 };
      },
    });
    await park403(q);

    // The rep knocks the next door once the server is back — that first
    // successful authenticated response heals the parked knock automatically.
    broken = false;
    await q.enqueue({ leadId: 8, outcome: "interested" });
    expect(q.getSnapshot().deadCount).toBe(0);
    expect(q.getSnapshot().pendingCount).toBe(0);
    const lead7Posts = post.mock.calls.filter(([url]) => url === "/api/leads/7/knock").length;
    expect(lead7Posts).toBe(KNOCK_QUEUE_MAX_ATTEMPTS + 1); // bounded retries + the auto-heal
    expect(leadState(q, 8)).toBe("saved");
    q.destroy();
  });

  it("the query client's first successful fetch after a failure period sweeps registered queues", async () => {
    let healthy = false;
    const post = vi.fn(async () => {
      if (!healthy) throw new Error("403: Forbidden");
      return { id: 81 };
    });
    const q = getKnockQueue({
      repId: 971, // unique so the registry entry can't collide with other tests
      storage: fakeStorage(),
      post,
      patch: vi.fn(async () => ({})),
      isOnline: () => true,
      now: () => Date.now(),
    });
    try {
      await q.enqueue({ leadId: 7, outcome: "sold" });
      for (let i = 0; i < KNOCK_QUEUE_MAX_ATTEMPTS - 1; i++) {
        vi.advanceTimersByTime(61_000);
        await q.flush();
      }
      expect(q.getSnapshot().deadCount).toBe(1);
      healthy = true;

      // A success with NO preceding failure period is not a recovery edge.
      noteQueryOutcome(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(q.getSnapshot().deadCount).toBe(1);

      // Failure period → FIRST success after it = the recovery edge.
      noteQueryOutcome(false);
      noteQueryOutcome(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(q.getSnapshot().deadCount).toBe(0);
      expect(q.getSnapshot().pendingCount).toBe(0);
    } finally {
      q.destroy();
    }
  });

  it("flush alone still never touches the dead lane — only recovery signals sweep it", async () => {
    const { q, post } = mkQueue({
      post: async () => {
        throw new Error("403: Forbidden");
      },
    });
    await park403(q);
    const before = post.mock.calls.length;
    await q.flush(); // no success, no signal → the dead item is not re-posted
    expect(post).toHaveBeenCalledTimes(before);
    expect(q.getSnapshot().deadCount).toBe(1);
    q.destroy();
  });
});

describe("knockQueue — dedup and notes", () => {
  it("treats a deduped replay ({id, deduped:true}) as success and wires recentSaves", async () => {
    const { q, patch } = mkQueue({ post: async () => ({ id: 42, deduped: true }) });
    await q.enqueue({ leadId: 7, outcome: "interested" });

    expect(q.getSnapshot().pendingCount).toBe(0);
    expect(leadState(q, 7)).toBe("saved");

    // The deduped row's id is remembered, so a late note edit PATCHes it.
    await q.updateNote(7, "gate code 4411");
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0][0]).toBe("/api/knocks/42");
    expect(patch.mock.calls[0][1]).toMatchObject({ notes: "gate code 4411" });
  });

  it('merges a note into a still-queued item — the POST carries it, PATCH never fires', async () => {
    const { q, post, patch, setOnline } = mkQueue({ online: false });
    await q.enqueue({ leadId: 7, outcome: "interested" });

    await expect(q.updateNote(7, "left flyer")).resolves.toBe("merged");

    setOnline(true);
    await q.flush();
    expect(post.mock.calls[0][1]).toMatchObject({ notes: "left flyer" });
    expect(patch).not.toHaveBeenCalled();
  });

  it('returns "not-found" when no pending item or recent save is known for the lead', async () => {
    const { q, patch } = mkQueue();
    await expect(q.updateNote(999, "hello?")).resolves.toBe("not-found");
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("knockQueue — persistence resilience", () => {
  it("degrades to memory-only when storage.setItem throws", async () => {
    const { q, post, setOnline } = mkQueue({
      storage: fakeStorage({ throwOnSet: true }),
      online: false,
    });
    await q.enqueue({ leadId: 7, outcome: "interested" });
    expect(q.getSnapshot().pendingCount).toBe(1); // still tracked in memory

    setOnline(true);
    await q.flush();
    expect(post).toHaveBeenCalledTimes(1);
    expect(q.getSnapshot().pendingCount).toBe(0);
  });

  it("discards an unknown envelope version instead of loading garbage", () => {
    const poisoned: StorageLike = {
      getItem: () => JSON.stringify({ v: 2, items: [{ clientId: "future", leadId: 7 }] }),
      setItem: () => {},
      removeItem: () => {},
    };
    const { q } = mkQueue({ storage: poisoned });
    expect(q.getSnapshot().pendingCount).toBe(0);
    expect(q.getSnapshot().deadCount).toBe(0);
  });
});

describe("knockQueue — snapshot semantics", () => {
  it("getSnapshot is referentially stable until state changes (useSyncExternalStore-safe)", async () => {
    const { q } = mkQueue({ online: false });
    const a = q.getSnapshot();
    expect(Object.is(a, q.getSnapshot())).toBe(true);

    await q.enqueue({ leadId: 7, outcome: "interested" });
    const b = q.getSnapshot();
    expect(Object.is(b, a)).toBe(false);
    expect(Object.is(b, q.getSnapshot())).toBe(true);
  });
});
