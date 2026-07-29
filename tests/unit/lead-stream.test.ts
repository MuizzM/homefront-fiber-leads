import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  subscribeLeadStream,
  LEAD_STREAM_URL,
  type LeadStreamEvent,
  type LeadStreamEventMeta,
  type LeadStreamFallbackInfo,
  type LeadStreamPin,
  type LeadStreamResyncReason,
  type LeadStreamSource,
  type LeadStreamSourceCtor,
  type LeadStreamSourceInit,
  type LeadStreamStatus,
  type LeadStreamStatusInfo,
  type SubscribeLeadStreamOptions,
} from "@/lib/leadStream";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * CONTRACT (client/src/lib/leadStream.ts). These tests ARE the spec for the
 * live lead push channel, driven end to end through subscribeLeadStream() with
 * an INJECTED transport — no network, no real EventSource, no wall clock. The
 * gate is exercised through the public subscription rather than directly,
 * because every bug this module exists to prevent is a bug in how ordering,
 * reconnection and optimistic holds INTERACT, not in any one of them alone.
 *
 *   ORDERING   seq is the only authority. Newer applies; `seq <= cursor` is
 *              dropped, so a replayed frame arriving behind a live one can
 *              never repaint a pin backwards.
 *   RESUME     the cursor the client reconnects with is the last seq it
 *              ACCEPTED (applied or deferred) — never the last it displayed,
 *              or a held lead's frames would be replayed forever.
 *   BACKOFF    grows, is capped, and is always strictly positive. A stream
 *              that reconnects on a zero timer is a denial of service the
 *              tenant pays for.
 *   FALLBACK   the caller is TOLD to start polling after N failures and told
 *              to stop once the stream is proven healthy. Silence is never a
 *              signal in either direction.
 *   HOLDS      a lead the rep is mid-save on is frozen against pushes; on
 *              settle exactly the newest withheld frame is delivered, marked
 *              deferred so the caller merges it as the server's verdict.
 * ────────────────────────────────────────────────────────────────────────────
 */

// ── Injected transport ───────────────────────────────────────────────────────
// Records every connect attempt (url + init) so the resume cursor is asserted
// as the caller would actually send it, and hands each test a handle to push
// frames or fail the socket on demand. Frames are delivered SYNCHRONOUSLY: the
// ordering rules are the thing under test, so the test drives the interleaving
// itself rather than racing a scheduler for it.

interface OpenedConnection {
  url: string;
  init?: LeadStreamSourceInit;
}

function fakeTransport() {
  const opened: OpenedConnection[] = [];
  const instances: FakeSource[] = [];

  class FakeSource implements LeadStreamSource {
    readyState = 0;
    closed = false;
    private readonly listeners = new Map<string, Set<(ev: any) => void>>();

    constructor(readonly url: string, readonly init?: LeadStreamSourceInit) {
      opened.push({ url, init });
      instances.push(this);
    }

    addEventListener(type: string, fn: (ev: any) => void): void {
      const set = this.listeners.get(type) ?? new Set();
      set.add(fn);
      this.listeners.set(type, set);
    }

    close(): void {
      this.closed = true;
      this.readyState = 2;
    }

    private emit(type: string, ev: any): void {
      // Copy first: a listener that tears the stream down mid-dispatch must not
      // mutate the set being iterated.
      for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
    }

    ready(epoch: string, seq: number, resync = false): void {
      this.readyState = 1;
      this.emit("ready", {
        type: "ready",
        data: JSON.stringify({ epoch, since: `${epoch}.${seq}`, resync }),
      });
    }

    /** A string body goes out verbatim so a malformed frame can be tested. */
    lead(evt: LeadStreamEvent | string): void {
      this.emit("lead", {
        type: "lead",
        data: typeof evt === "string" ? evt : JSON.stringify(evt),
      });
    }

    /** `status` omitted mirrors the native EventSource, which cannot report one. */
    fail(status?: number): void {
      this.emit("error", status == null ? { type: "error" } : { type: "error", status });
    }
  }

  return {
    Ctor: FakeSource as unknown as LeadStreamSourceCtor,
    opened,
    instances,
    /** The source the subscription is currently attached to. */
    live: () => instances[instances.length - 1],
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function pin(id: number, leadStatus: string | null): LeadStreamPin {
  return {
    id,
    address: `${id} Maple St`,
    city: "Lexington",
    state: "NC",
    zip: "27292",
    lat: 35.8,
    lng: -80.25,
    leadStatus,
    fiberStatus: "available",
    leadTag: null,
    leadScore: 70,
    assignMark: null,
    doNotKnock: false,
    lastOutcome: leadStatus,
    lastOutcomeAt: "2026-07-29T12:00:00.000Z",
    assignedRepId: 5,
    assignedTerritoryId: 12,
  };
}

function leadEvent(o: {
  seq: number;
  leadId?: number;
  epoch?: string;
  leadStatus?: string | null;
  lead?: LeadStreamPin | null;
}): LeadStreamEvent {
  const leadId = o.leadId ?? 42;
  return {
    epoch: o.epoch ?? "e1",
    seq: o.seq,
    // Deliberately DECREASING with seq: nothing may order by ts, and a fixture
    // whose clock agrees with its seq would hide it if something did.
    ts: new Date(1_800_000_000_000 - o.seq * 1_000).toISOString(),
    tenantId: 7,
    leadId,
    type: "outcome",
    actorId: 9,
    actorName: "Marcus",
    lead: o.lead === undefined ? pin(leadId, o.leadStatus ?? "knocked") : o.lead,
  };
}

// ── Harness ──────────────────────────────────────────────────────────────────

function openStream(over: Partial<SubscribeLeadStreamOptions> = {}) {
  const transport = fakeTransport();
  const applied: Array<{ evt: LeadStreamEvent; meta: LeadStreamEventMeta }> = [];
  // The caller's real job, modelled: leadId → the status the screen is showing.
  // Assertions about "does not overwrite newer state" have to be about this map,
  // not about a call count — a call count cannot tell a repaint from a rollback.
  const state = new Map<number, string | null>();
  const resyncs: LeadStreamResyncReason[] = [];
  const fallbacks: LeadStreamFallbackInfo[] = [];
  const statuses: Array<{ status: LeadStreamStatus; info: LeadStreamStatusInfo }> = [];

  const handle = subscribeLeadStream({
    EventSourceImpl: transport.Ctor,
    baseDelayMs: 1_000,
    maxDelayMs: 8_000,
    healthyAfterMs: 10_000,
    // Jitter pinned to its ceiling so growth assertions are about the curve and
    // not about a coin flip. The jitter FLOOR gets its own test below.
    random: () => 1,
    onEvent: (evt, meta) => {
      applied.push({ evt, meta });
      state.set(evt.leadId, evt.lead?.leadStatus ?? null);
    },
    onResync: (reason) => resyncs.push(reason),
    onFallback: (info) => fallbacks.push(info),
    onStatus: (status, info) => statuses.push({ status, info }),
    ...over,
  });

  return {
    ...transport,
    handle,
    applied,
    state,
    resyncs,
    fallbacks,
    statuses,
    seqs: () => applied.map((a) => a.evt.seq),
    /** Every backoff the subscription has scheduled, in order. */
    delays: () => statuses.filter((s) => s.status === "reconnecting").map((s) => s.info.delayMs as number),
  };
}

type Rig = ReturnType<typeof openStream>;

/** Drop the live socket and let its backoff timer fire, so the assertion that
 *  follows sees a genuinely new connection rather than a pending timer. */
function failAndReconnect(rig: Rig): number {
  const before = rig.delays().length;
  rig.live().fail();
  const delay = rig.delays()[before];
  expect(delay).toBeGreaterThan(0); // a reconnect that was never scheduled would silently pass below
  vi.advanceTimersByTime(delay);
  return delay;
}

beforeEach(() => {
  // Date is faked alongside the timers, which matters: hold TTLs are evaluated
  // against now() while the sweep runs on an interval. Two clocks would let a
  // hold expire on one and not the other.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Ordering, dedup, staleness ───────────────────────────────────────────────

describe("leadStream ordering", () => {
  it("applies events in seq order", () => {
    const rig = openStream();
    rig.live().ready("e1", 0);

    rig.live().lead(leadEvent({ seq: 1, leadStatus: "not_home" }));
    rig.live().lead(leadEvent({ seq: 2, leadStatus: "callback" }));
    rig.live().lead(leadEvent({ seq: 3, leadStatus: "sold" }));

    expect(rig.seqs()).toEqual([1, 2, 3]);
    expect(rig.state.get(42)).toBe("sold");
    expect(rig.handle.since()).toBe("e1.3");
  });

  it("drops a STALE event and does not overwrite newer state", () => {
    const rig = openStream();
    rig.live().ready("e1", 0);

    // The reconnect-window overlap in miniature: the live frame lands first and
    // the replayed one arrives behind it describing a door that has since sold.
    rig.live().lead(leadEvent({ seq: 5, leadStatus: "sold" }));
    rig.live().lead(leadEvent({ seq: 4, leadStatus: "not_home" }));

    expect(rig.seqs()).toEqual([5]);
    expect(rig.state.get(42)).toBe("sold");
    // The cursor does not rewind either, or the next reconnect would re-request
    // the very frames that were just rejected.
    expect(rig.handle.since()).toBe("e1.5");
  });

  it("applies a DUPLICATE seq exactly once", () => {
    const rig = openStream();
    rig.live().ready("e1", 0);

    // Replay and the live bus hand out the same frame — by design, since
    // subscribing after the drain is what makes the server race-free.
    const evt = leadEvent({ seq: 7, leadStatus: "sold" });
    rig.live().lead(evt);
    rig.live().lead(evt);
    rig.live().lead(leadEvent({ seq: 7, leadStatus: "not_home" }));

    expect(rig.seqs()).toEqual([7]);
    expect(rig.state.get(42)).toBe("sold");
  });

  it("ignores a malformed frame without moving the cursor", () => {
    const rig = openStream();
    rig.live().ready("e1", 4);

    rig.live().lead("}{ not json");
    rig.live().lead(JSON.stringify({ epoch: "e1", leadId: 42, type: "outcome" })); // no seq
    expect(rig.applied).toHaveLength(0);
    expect(rig.handle.since()).toBe("e1.4");

    rig.live().lead(leadEvent({ seq: 5 }));
    expect(rig.seqs()).toEqual([5]);
  });

  it("adopts a new epoch and tells the caller to refetch", () => {
    const rig = openStream();
    rig.live().ready("e1", 0);
    rig.live().lead(leadEvent({ seq: 900, leadStatus: "sold" }));

    // Server restart: seq renumbers from 1 under a client holding 900. Without
    // the epoch reset the stream would look perfectly connected and deliver
    // nothing — the worst available failure.
    rig.live().lead(leadEvent({ seq: 1, epoch: "e2", leadStatus: "callback" }));

    expect(rig.resyncs).toEqual(["epoch"]);
    expect(rig.seqs()).toEqual([900, 1]);
    expect(rig.state.get(42)).toBe("callback");
    expect(rig.handle.since()).toBe("e2.1");
  });

  it("relays a server-declared resync from the ready frame", () => {
    const rig = openStream();
    rig.live().ready("e1", 120, true);

    expect(rig.resyncs).toEqual(["server"]);
    expect(rig.handle.since()).toBe("e1.120");
  });
});

// ── Resume ───────────────────────────────────────────────────────────────────

describe("leadStream resume", () => {
  it("opens the first connection with no cursor at all", () => {
    const rig = openStream();

    // A bare connect means TAIL: the map was just loaded through the role-scoped
    // endpoint, so replaying the window would re-apply what is already on screen.
    expect(rig.opened).toHaveLength(1);
    expect(rig.opened[0].url).toBe(LEAD_STREAM_URL);
    expect(rig.opened[0].init).toBeUndefined();
  });

  it("reconnects with ?since=<lastAppliedSeq>", () => {
    const rig = openStream();
    rig.live().ready("e1", 0);
    rig.live().lead(leadEvent({ seq: 7 }));
    rig.live().lead(leadEvent({ seq: 9 }));

    failAndReconnect(rig);

    expect(rig.opened).toHaveLength(2);
    expect(rig.opened[1].url).toBe(`${LEAD_STREAM_URL}?since=e1.9`);
    // Same value on both carriers, so the server's header-over-query preference
    // can never pick the wrong one.
    expect(rig.opened[1].init?.lastEventId).toBe("e1.9");
  });

  it("counts a DEFERRED event against the cursor so a reconnect never re-requests it", () => {
    const rig = openStream();
    rig.live().ready("e1", 0);
    rig.handle.hold(42);

    rig.live().lead(leadEvent({ seq: 3, leadId: 42 }));
    rig.live().lead(leadEvent({ seq: 4, leadId: 42 }));
    expect(rig.applied).toHaveLength(0);

    failAndReconnect(rig);

    expect(rig.opened[1].url).toBe(`${LEAD_STREAM_URL}?since=e1.4`);
  });

  it("never rewinds the cursor to the server's replay-from point", () => {
    const rig = openStream();
    rig.live().ready("e1", 0);
    rig.live().lead(leadEvent({ seq: 12 }));
    failAndReconnect(rig);

    // The reconnected stream reports the cursor it is replaying FROM, which is
    // behind us. Taking it blindly would re-deliver applied events.
    rig.live().ready("e1", 8);

    expect(rig.handle.since()).toBe("e1.12");
    expect(rig.resyncs).toEqual([]);
  });
});

// ── Backoff ──────────────────────────────────────────────────────────────────

describe("leadStream backoff", () => {
  it("grows exponentially and is capped", () => {
    const rig = openStream();

    const seen = [failAndReconnect(rig), failAndReconnect(rig), failAndReconnect(rig),
      failAndReconnect(rig), failAndReconnect(rig), failAndReconnect(rig)];

    expect(seen).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(Math.max(...seen)).toBe(8_000);
  });

  it("never schedules a tight loop, even at the jitter floor", () => {
    // Worst case for the client: the RNG bottoms out on every attempt.
    const rig = openStream({ random: () => 0 });

    const seen = [failAndReconnect(rig), failAndReconnect(rig), failAndReconnect(rig),
      failAndReconnect(rig), failAndReconnect(rig)];

    expect(seen).toEqual([500, 1_000, 2_000, 4_000, 4_000]);
    expect(Math.min(...seen)).toBeGreaterThan(0);
  });

  it("does not reconnect before the scheduled delay elapses", () => {
    const rig = openStream();
    rig.live().fail();

    const delay = rig.delays()[0];
    vi.advanceTimersByTime(delay - 1);
    expect(rig.opened).toHaveLength(1); // still waiting — the timer is the only trigger

    vi.advanceTimersByTime(1);
    expect(rig.opened).toHaveLength(2);
  });

  it("resets the backoff only after a connection proves healthy", () => {
    const rig = openStream();
    expect(failAndReconnect(rig)).toBe(1_000);
    expect(failAndReconnect(rig)).toBe(2_000);

    rig.live().ready("e1", 0);
    vi.advanceTimersByTime(9_999);
    // A server that accepts, writes `ready` and dies just short of the healthy
    // mark must not reset the curve — that is a polite-looking reconnect storm.
    // Only surviving the full window does.
    expect(failAndReconnect(rig)).toBe(4_000);
    // The dead connection's pending healthy timer has to die with it. If it
    // survives, a socket that is already gone forgives the failures that came
    // after it and the curve silently restarts mid-outage.
    expect(failAndReconnect(rig)).toBe(8_000);

    rig.live().ready("e1", 0);
    vi.advanceTimersByTime(10_000);
    expect(failAndReconnect(rig)).toBe(1_000);
  });
});

// ── Fallback signalling ──────────────────────────────────────────────────────

describe("leadStream fallback", () => {
  it("signals the caller to fall back after N failed attempts", () => {
    const rig = openStream({ fallbackAfterAttempts: 3 });

    failAndReconnect(rig);
    failAndReconnect(rig);
    expect(rig.fallbacks).toHaveLength(0); // a blip is not an outage

    failAndReconnect(rig);
    expect(rig.fallbacks).toHaveLength(1);
    expect(rig.fallbacks[0]).toMatchObject({ active: true, reason: "unreachable", attempts: 3 });
  });

  it("signals the fallback once, not once per attempt", () => {
    const rig = openStream({ fallbackAfterAttempts: 2 });
    failAndReconnect(rig);
    failAndReconnect(rig);
    expect(rig.fallbacks).toHaveLength(1);

    failAndReconnect(rig);
    failAndReconnect(rig);
    expect(rig.fallbacks).toHaveLength(1); // edge-triggered: start polling once
  });

  it("clears the fallback only once the stream is proven healthy", () => {
    const rig = openStream({ fallbackAfterAttempts: 2 });
    failAndReconnect(rig);
    failAndReconnect(rig);

    rig.live().ready("e1", 0);
    // Connected is not trusted. Telling a caller to stop polling on a socket
    // that dies three seconds later is a lie the map pays for, so the signal is
    // debounced across the whole healthy window and not one millisecond less.
    vi.advanceTimersByTime(9_999);
    expect(rig.fallbacks).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(rig.fallbacks).toHaveLength(2);
    expect(rig.fallbacks[1]).toMatchObject({ active: false, reason: "recovered" });
  });

  it("stops retrying entirely on 401 and says so", () => {
    const rig = openStream();
    rig.live().fail(401);

    expect(rig.fallbacks[0]).toMatchObject({ active: true, reason: "unauthorized", status: 401 });
    // The session is gone; retrying is pure radio burn on a rep's phone.
    vi.advanceTimersByTime(300_000);
    expect(rig.opened).toHaveLength(1);
    expect(rig.handle.status()).toBe("closed");
  });

  it("falls back with no retry when no transport exists at all", () => {
    const rig = openStream({ EventSourceImpl: undefined });

    expect(rig.opened).toHaveLength(0);
    expect(rig.fallbacks[0]).toMatchObject({ active: true, reason: "unsupported", status: null });
    vi.advanceTimersByTime(300_000);
    expect(rig.fallbacks).toHaveLength(1);
  });

  it("close() ends the retry loop and ignores late frames", () => {
    const rig = openStream();
    rig.live().ready("e1", 0);
    const src = rig.live();

    src.fail();
    rig.handle.close();
    vi.advanceTimersByTime(300_000);

    expect(rig.opened).toHaveLength(1);
    expect(src.closed).toBe(true);
    src.lead(leadEvent({ seq: 1 }));
    expect(rig.applied).toHaveLength(0);
    expect(rig.handle.status()).toBe("closed");
  });
});

// ── Optimistic holds ─────────────────────────────────────────────────────────

describe("leadStream optimistic holds", () => {
  it("does not clobber a lead the rep is mid-save on", () => {
    const rig = openStream();
    rig.live().ready("e1", 0);

    // The rep taps "sold"; the caller stages that locally and takes the hold.
    rig.state.set(42, "sold");
    rig.handle.hold(42);

    // A push describing the state the server held BEFORE the tap arrived.
    rig.live().lead(leadEvent({ seq: 3, leadId: 42, leadStatus: "not_home" }));

    expect(rig.applied).toHaveLength(0);
    expect(rig.state.get(42)).toBe("sold"); // the rep never watches their own tap undo itself
    expect(rig.handle.isHeld(42)).toBe(true);
  });

  it("delivers only the newest withheld seq once the save settles", () => {
    const rig = openStream();
    rig.live().ready("e1", 0);
    rig.state.set(42, "sold");
    const settle = rig.handle.hold(42);

    // Two reps working the same door. The older frame describes a state that no
    // longer exists server-side, so replaying it would be strictly worse than
    // dropping it — the server already ran this same recency CAS.
    rig.live().lead(leadEvent({ seq: 3, leadId: 42, leadStatus: "not_home" }));
    rig.live().lead(leadEvent({ seq: 4, leadId: 42, leadStatus: "callback" }));

    settle();

    expect(rig.seqs()).toEqual([4]);
    expect(rig.applied[0].meta).toEqual({ deferred: true, holdExpired: false });
    expect(rig.state.get(42)).toBe("callback");
  });

  it("freezes only the held lead", () => {
    const rig = openStream();
    rig.live().ready("e1", 0);
    rig.handle.hold(42);

    rig.live().lead(leadEvent({ seq: 3, leadId: 42, leadStatus: "not_home" }));
    rig.live().lead(leadEvent({ seq: 4, leadId: 99, leadStatus: "sold" }));

    expect(rig.seqs()).toEqual([4]);
    expect(rig.state.get(99)).toBe("sold");
    expect(rig.handle.isHeld(99)).toBe(false);
  });

  it("resumes normal delivery after the hold clears", () => {
    const rig = openStream();
    rig.live().ready("e1", 0);
    const settle = rig.handle.hold(42);
    rig.live().lead(leadEvent({ seq: 3, leadId: 42, leadStatus: "callback" }));
    settle();

    rig.live().lead(leadEvent({ seq: 5, leadId: 42, leadStatus: "sold" }));

    expect(rig.seqs()).toEqual([3, 5]);
    expect(rig.applied[1].meta).toEqual({ deferred: false, holdExpired: false });
    expect(rig.state.get(42)).toBe("sold");
  });

  it("refcounts holds so two queued knocks on one door unfreeze together", () => {
    const rig = openStream();
    rig.live().ready("e1", 0);
    const first = rig.handle.hold(42);
    const second = rig.handle.hold(42);

    rig.live().lead(leadEvent({ seq: 3, leadId: 42, leadStatus: "callback" }));

    first();
    first(); // idempotent: a settle path that fires twice must not drop the second hold
    expect(rig.applied).toHaveLength(0);
    expect(rig.handle.isHeld(42)).toBe(true);

    second();
    expect(rig.seqs()).toEqual([3]);
  });

  it("release() drops every hold on a lead and flushes the withheld frame", () => {
    const rig = openStream();
    rig.live().ready("e1", 0);
    rig.handle.hold(42);
    rig.handle.hold(42);
    rig.live().lead(leadEvent({ seq: 6, leadId: 42, leadStatus: "sold" }));

    rig.handle.release(42);

    expect(rig.seqs()).toEqual([6]);
    expect(rig.applied[0].meta.deferred).toBe(true);
    expect(rig.handle.isHeld(42)).toBe(false);
  });

  it("expires a leaked hold and still applies the frame it was sitting on", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rig = openStream({ holdTtlMs: 60_000 });
    rig.live().ready("e1", 0);
    rig.handle.hold(42); // never released — knockQueue's dead-letter path has no success callback

    rig.live().lead(leadEvent({ seq: 3, leadId: 42, leadStatus: "sold" }));
    expect(rig.applied).toHaveLength(0);

    vi.advanceTimersByTime(90_000);

    // A stranded event is a permanently stale pin, so the payload survives the
    // eviction even though the bookkeeping is what failed.
    expect(rig.seqs()).toEqual([3]);
    expect(rig.applied[0].meta).toEqual({ deferred: true, holdExpired: true });
    expect(rig.state.get(42)).toBe("sold");
    expect(rig.handle.isHeld(42)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("survives a consumer that throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: number[] = [];
    const rig = openStream({
      onEvent: (evt) => {
        if (evt.seq === 2) throw new Error("render blew up");
        seen.push(evt.seq);
      },
    });
    rig.live().ready("e1", 0);

    rig.live().lead(leadEvent({ seq: 1 }));
    rig.live().lead(leadEvent({ seq: 2 }));
    rig.live().lead(leadEvent({ seq: 3 }));

    expect(seen).toEqual([1, 3]);
    expect(rig.handle.status()).toBe("live");
    expect(warn).toHaveBeenCalled();
  });
});
