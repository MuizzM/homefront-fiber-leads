import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createKnockQueue } from "@/lib/knockQueue";
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
 *     other 4xx        → TERMINAL: the server can never accept it. AUTO-RESOLVES
 *                        (dropped, onResolved(item, reason) fired once, logged) —
 *                        never a "needs attention" nag, never blocks the line.
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
    // The FieldStatusBar can say which door, why, and that Retry may work.
    expect(snap.deadItems).toHaveLength(1);
    expect(snap.deadItems[0]).toMatchObject({ leadId: 7, retryable: true });
    expect(snap.deadItems[0].reason).toContain("authorized");

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

  it("a 403 dead item survives reload in the dead lane and retryDead still redelivers it", async () => {
    const storage = fakeStorage();
    seed(storage, "hf.knockDead.v1.9", [baseItem({ lastError: "403: forbidden", attempts: 8 })]);

    const { q, post } = mkQueue({ storage });
    await vi.advanceTimersByTimeAsync(0); // settle load-time microtasks
    expect(q.getSnapshot().deadCount).toBe(1);
    expect(q.getSnapshot().deadItems[0]).toMatchObject({ leadId: 7, retryable: true });
    expect(leadState(q, 7)).toBe("error");

    q.retryDead();
    await q.flush();
    expect(post).toHaveBeenCalledTimes(1);
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
