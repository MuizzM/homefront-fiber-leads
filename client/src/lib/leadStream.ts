// ── Lead push channel — client half ──────────────────────────────────────────
// The server halves are server/leadEvents.ts (tenant-scoped ring + in-process
// bus) and GET /api/leads/stream in server/routes.ts. This module turns that
// wire into an ORDERED, DEDUPED, RESUMABLE feed and leaves the caller exactly
// one job: merge a pin. Every way a live map can quietly start lying is handled
// here instead of in each screen that consumes it:
//   • a replayed frame landing after a newer one (reconnect window overlaps live)
//   • the same frame applied twice (replay and live hand out the same seq)
//   • a push repainting a knock the rep has not finished saving
//   • a server restart renumbering seq from 1 under a client holding seq 900
//   • a socket that died without telling anyone, which is the worst of the set:
//     a stream that looks alive is more dangerous than no stream at all, because
//     the screen stops distrusting what it is showing.
//
// Framework-free on purpose (no React, no react-query) for the same reason as
// knockQueue.ts: the ordering rules are the part that has to be provable, and a
// unit test should be able to drive them by hand. The transport is injected so
// tests can deliver frames on demand rather than race a real socket.
//
// AUTH: this app's session is an `x-session-id` HEADER (requireAuth in
// server/routes.ts), and the browser's native EventSource cannot send headers —
// against this deployment it would 401 forever. createFetchEventSource() below
// is the transport the app actually uses; the native constructor stays supported
// for a cookie-authed deployment and for tests. A session token is never placed
// in the URL: query strings survive in access logs, proxies and referrers.
//
// NOT this module's job: what a pin means. It hands the caller server-authored
// events in order; the merge into the query cache (and the field-level
// precedence against an optimistic write) belongs to the cache owner.

// ── Wire types ───────────────────────────────────────────────────────────────
// Mirrors server/leadEvents.ts (LeadEvent / LeadEventPin). Redeclared rather
// than imported because client code cannot reach server/ — keep the two in sync;
// the parser below is the enforcement point, so a field the server stops sending
// shows up here as null, never as a silent `undefined` that a spread would skip.

/** What changed. The caller branches on this to decide how loud the update is —
 *  an outcome flip repaints a pin, a note edit only refreshes an open card.
 *  The parser passes UNKNOWN types through unchanged: a server that grows a
 *  fifth kind must not have its events dropped by an old bundle, so callers need
 *  a default branch rather than an exhaustive switch. */
export type LeadStreamEventType = "outcome" | "notes" | "assignment" | "status";

/**
 * The lead projection the channel carries. Deliberately NARROWER than the map's
 * MapPin, and that gap is load-bearing in two directions:
 *  • No contact PII and no note bodies — a broadcast channel is the worst place
 *    to ship either, and the card already fetches them from /api/leads/:id,
 *    which re-checks access for that one lead.
 *  • No knockCount / lastKnockedAt / freshConfidence / carrier — those are
 *    JOINED by the map query, not columns the write path holds. The server omits
 *    them rather than send them half-populated.
 * So this can never be merged wholesale over a map pin: `{...pin, ...event.lead}`
 * would erase the joined fields. Merge the fields listed here, explicitly.
 *
 * assignedRepId + assignedTerritoryId are present because the SERVER needed them
 * to answer repCanAccessLead before sending the frame — treat them as data the
 * client displays, never as a client-side access decision.
 */
export interface LeadStreamPin {
  id: number;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  leadStatus: string | null;
  fiberStatus: string | null;
  leadTag: string | null;
  leadScore: number | null;
  assignMark: string | null;
  doNotKnock: boolean;
  lastOutcome: string | null;
  lastOutcomeAt: string | null;
  assignedRepId: number | null;
  assignedTerritoryId: number | null;
}

export interface LeadStreamEvent {
  /** Boot identity of the seq space. seq restarts at 1 on every server boot, so
   *  a cursor without this is a number that names different events on different
   *  processes — see the epoch reset in the gate. */
  epoch: string;
  /** Monotonic per process. The ONLY ordering and dedup key. */
  seq: number;
  /** ISO. Display only — never order by it. Clocks are not the authority here. */
  ts: string;
  tenantId: number;
  leadId: number;
  type: LeadStreamEventType;
  actorId: number | null;
  actorName: string | null;
  /** null when the writer had no row to project (a delete). */
  lead: LeadStreamPin | null;
}

/** The stream's opening frame. `since` is the resume token to send back if this
 *  connection dies before any lead frame does; `resync` is the server saying the
 *  cursor did not survive (gap or foreign epoch) and the scope must be refetched. */
export interface LeadStreamReady {
  epoch: string;
  since: string;
  resync: boolean;
}

// ── Consumer-facing types ────────────────────────────────────────────────────

export type LeadStreamStatus = "connecting" | "live" | "reconnecting" | "closed";

/** Why the caller must refetch the whole scope instead of patching a pin.
 *  "server" = the stream told us our cursor is gone (evicted from the reconnect
 *  ring, or minted in another process). "epoch" = we detected the renumbering
 *  ourselves from a frame. Either way the events between then and now are
 *  unrecoverable, and a hole nothing downstream can detect is exactly what this
 *  channel exists to prevent. */
export type LeadStreamResyncReason = "server" | "epoch";

export interface LeadStreamEventMeta {
  /** True when this event was withheld while the lead was locally in flight and
   *  is only being applied now. It is authoritative-but-late: the server has
   *  already run its own last-write-wins CAS, so mirror that verdict. */
  deferred: boolean;
  /** True when the hold expired instead of being released — the caller's settle
   *  path is leaking holds. Correct data, broken bookkeeping. */
  holdExpired: boolean;
}

export interface LeadStreamFallbackInfo {
  reason: "unreachable" | "unauthorized" | "forbidden" | "unsupported" | "recovered";
  attempts: number;
  /** HTTP status when the transport could report one (the fetch source does; the
   *  native EventSource cannot). */
  status: number | null;
  /** False once the stream is trusted again — stop polling. */
  active: boolean;
}

export interface LeadStreamStatusInfo {
  attempt: number;
  delayMs: number | null;
  status: number | null;
}

/** Minimal structural view of EventSource — everything this module needs and
 *  nothing it does not, so a test double is a dozen lines. */
export interface LeadStreamSource {
  addEventListener(type: string, listener: (ev: any) => void): void;
  close(): void;
  readonly readyState?: number;
}

export interface LeadStreamSourceInit {
  withCredentials?: boolean;
  /** Honoured by createFetchEventSource (sent as the Last-Event-ID header, which
   *  the server prefers over ?since=). The native EventSource ignores it. */
  lastEventId?: string;
}

export type LeadStreamSourceCtor = new (url: string, init?: LeadStreamSourceInit) => LeadStreamSource;

export interface LeadStreamHandle {
  /** Stop the stream and release every timer/listener. Idempotent. */
  close(): void;
  /** Mark a lead as locally in flight — see the reconciliation rule on hold().
   *  Returns an idempotent release fn; refcounted, so two queued knocks on one
   *  door take two holds and the pin unfreezes when the second settles. */
  hold(leadId: number): () => void;
  /** Release every hold on a lead at once and deliver the newest withheld event.
   *  For a caller that tracks per-lead save state rather than per-mutation. */
  release(leadId: number): void;
  isHeld(leadId: number): boolean;
  /** Resume token (`epoch.seq`) — what the next reconnect will ask for. */
  since(): string | null;
  status(): LeadStreamStatus;
}

/** A team announcement as it arrives on the wire. Mirrors StoredAnnouncement on
 *  the server; carries no lead id and no customer data by construction. */
export interface StreamAnnouncement {
  id: number;
  kind: "sale" | "hot_streak";
  actorRepId: number;
  actorName: string;
  headline: string;
  body: string;
  amountCents?: number;
  createdAtMs: number;
}

export interface SubscribeLeadStreamOptions {
  url?: string;
  onEvent: (evt: LeadStreamEvent, meta: LeadStreamEventMeta) => void;
  /** A teammate won something. Already filtered server-side — a rep is never
   *  sent their own win. */
  onAnnouncement?: (a: StreamAnnouncement) => void;
  /** Cursor is unrecoverable — refetch the scope through /api/leads/map. */
  onResync?: (reason: LeadStreamResyncReason) => void;
  /** The control signal. true → the stream is not delivering, start polling.
   *  false → it is trusted again, stop. Never inferred from silence by the
   *  caller; this channel says it out loud. */
  onFallback?: (info: LeadStreamFallbackInfo) => void;
  /** Observability only — noisy and safe to ignore. Connection lifecycle. */
  onStatus?: (status: LeadStreamStatus, info: LeadStreamStatusInfo) => void;
  EventSourceImpl?: LeadStreamSourceCtor;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Consecutive failed attempts before the caller is told to fall back. */
  fallbackAfterAttempts?: number;
  /** How long a connection must survive before it counts as proven healthy. */
  healthyAfterMs?: number;
  holdTtlMs?: number;
  now?: () => number;
  random?: () => number;
}

export const LEAD_STREAM_URL = "/api/leads/stream";

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_FALLBACK_AFTER = 3;
// A connection has to survive this long before its predecessor's failures are
// forgiven. Without it, a server that accepts, writes the ready frame and dies
// resets the backoff on every cycle — a polite-looking reconnect storm.
const DEFAULT_HEALTHY_AFTER_MS = 10_000;
// A hold that is never released makes a pin permanently deaf to the street, so
// it expires. Not paranoia: knockQueue's dead-letter path (knockQueue.ts
// deadLetter) has no success callback, so a caller wiring release() to onSaved
// leaks a hold on every poisoned knock. Worst-case legitimate hold is one knock
// walking all 8 attempts of retryDelayMs (~4 min), so 5 min clears the leak
// without ever cutting a live retry short.
const HOLD_TTL_MS = 5 * 60_000;
const HOLD_SWEEP_MS = 30_000;

// ── Pure helpers ─────────────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function toPin(raw: unknown): LeadStreamPin | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = num(row.id);
  if (id == null) return null;
  // An allowlist, exactly like the server's projection, and for the same reason:
  // a shape that starts from the wire object and removes fields silently adopts
  // whatever a future server adds — straight into the query cache.
  return {
    id,
    address: str(row.address),
    city: str(row.city),
    state: str(row.state),
    zip: str(row.zip),
    lat: num(row.lat),
    lng: num(row.lng),
    leadStatus: str(row.leadStatus),
    fiberStatus: str(row.fiberStatus),
    leadTag: str(row.leadTag),
    leadScore: num(row.leadScore),
    assignMark: str(row.assignMark),
    // A permanent compliance block — the one field where guessing wrong sends a
    // rep back to a door they were told never to return to. Anything that is not
    // an explicit true is false.
    doNotKnock: row.doNotKnock === true,
    lastOutcome: str(row.lastOutcome),
    lastOutcomeAt: str(row.lastOutcomeAt),
    assignedRepId: num(row.assignedRepId),
    assignedTerritoryId: num(row.assignedTerritoryId),
  };
}

/** Parse a `lead` frame body. Returns null for anything unusable — a malformed
 *  frame is skipped, never guessed at, and never allowed to move the cursor. */
export function parseLeadEventFrame(data: string): LeadStreamEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const seq = num(row.seq);
  const epoch = str(row.epoch);
  const leadId = num(row.leadId);
  // seq and epoch together ARE the identity of the event; without both there is
  // no way to order it or to know which seq space it belongs to.
  if (epoch == null || seq == null || !Number.isSafeInteger(seq) || seq <= 0) return null;
  if (leadId == null || !Number.isSafeInteger(leadId)) return null;
  const type = str(row.type);
  if (type == null) return null;
  return {
    epoch,
    seq,
    ts: str(row.ts) ?? "",
    tenantId: num(row.tenantId) ?? 0,
    leadId,
    // Cast, not validate: an unmodelled type from a newer server is still a real
    // change to a real door. Dropping it would be a silently stale pin.
    type: type as LeadStreamEventType,
    actorId: num(row.actorId),
    actorName: str(row.actorName),
    lead: toPin(row.lead),
  };
}

/** Parse the opening `ready` frame. */
export function parseReadyFrame(data: string): LeadStreamReady | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const epoch = str(row.epoch);
  if (epoch == null) return null;
  return { epoch, since: str(row.since) ?? "", resync: row.resync === true };
}

/** Split a resume token. The server mints frame ids as `<epoch>.<seq>` and the
 *  epoch is base36 + "-", so the LAST dot is unambiguous. */
export function parseSinceToken(token: string): { epoch: string; seq: number } | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const seq = Number(token.slice(dot + 1));
  if (!Number.isSafeInteger(seq) || seq < 0) return null;
  return { epoch: token.slice(0, dot), seq };
}

/** Attach the resume cursor, replacing any `since` the caller's URL already had —
 *  Express turns a repeated query param into an array, which parses as NaN and
 *  silently degrades the reconnect into a tail (i.e. a hole). */
export function withSince(url: string, since: string | null): string {
  const hashAt = url.indexOf("#");
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const qAt = base.indexOf("?");
  const path = qAt >= 0 ? base.slice(0, qAt) : base;
  const params = (qAt >= 0 ? base.slice(qAt + 1) : "")
    .split("&")
    .filter((p) => p.length > 0 && !p.startsWith("since="));
  if (since) params.push(`since=${encodeURIComponent(since)}`);
  return `${path}${params.length ? `?${params.join("&")}` : ""}${hash}`;
}

/** Exponential backoff with jitter, capped. */
export function backoffDelayMs(
  attempt: number,
  opts: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const baseMs = opts.baseMs ?? DEFAULT_BASE_DELAY_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_DELAY_MS;
  const random = opts.random ?? Math.random;
  const step = Math.max(0, Math.min(attempt, 16)); // clamped so 2**n stays finite
  const capped = Math.min(maxMs, baseMs * 2 ** step);
  // Jitter is not decoration. A server restart drops every phone in the tenant
  // on the same millisecond; undithered, they all come back on the same tick and
  // trip the endpoint's 200-connection cap in a herd — which the clients read as
  // a continuing outage and retry into. Half-to-full spread is enough to break
  // the lockstep without making the worst case meaningfully slower.
  return Math.round(capped * (0.5 + random() * 0.5));
}

// ── Ordering / dedup / optimistic-hold gate ──────────────────────────────────
// Pure and synchronous: no transport, no timers, no globals. This is the part
// that has to be right, so it is the part a test can drive event by event.

export type LeadStreamDecision =
  | { action: "apply"; event: LeadStreamEvent; resync: boolean }
  | { action: "defer"; event: LeadStreamEvent; resync: boolean }
  | { action: "drop"; reason: "duplicate" | "stale" };

/** A hold that outlived the TTL. `event` is the withheld push it was sitting on,
 *  which the caller MUST still apply — a stranded event is a stale pin. A null
 *  event is a pure bookkeeping leak: nothing to repaint, but the caller's settle
 *  path is not releasing what it holds. */
export interface LeadStreamExpiredHold {
  leadId: number;
  event: LeadStreamEvent | null;
}

export interface LeadStreamGate {
  /** Ordering + dedup + hold decision for one event. Advances the cursor for
   *  anything it does not drop — including deferred events, so a reconnect never
   *  re-requests a frame that is already sitting in the hold buffer. */
  accept(evt: LeadStreamEvent): LeadStreamDecision;
  /** Fold the opening frame's cursor in. Returns whether the caller must refetch. */
  syncReady(ready: LeadStreamReady): { resync: boolean };
  hold(leadId: number): () => void;
  /** Drops all holds on the lead; returns the newest withheld event, if any. */
  release(leadId: number): LeadStreamEvent | null;
  /** Pure predicate — an expired hold reads as not-held but is NOT evicted here.
   *  Eviction lives only in sweepHolds(), which is also the only path that drains
   *  the withheld payload; deleting the hold anywhere else would orphan that
   *  payload where nothing can ever find it again. */
  isHeld(leadId: number): boolean;
  /** Evict holds older than the TTL and hand them back, oldest seq first. */
  sweepHolds(): LeadStreamExpiredHold[];
  holdCount(): number;
  cursor(): number;
  epoch(): string | null;
  since(): string | null;
}

export function createLeadStreamGate(
  opts: { now?: () => number; holdTtlMs?: number } = {},
): LeadStreamGate {
  const now = opts.now ?? Date.now;
  const holdTtlMs = opts.holdTtlMs ?? HOLD_TTL_MS;

  let epoch: string | null = null;
  let cursor = 0;
  const holds = new Map<number, { count: number; since: number }>();
  const withheld = new Map<number, LeadStreamEvent>();

  // Adopting a new seq space: the old cursor names events that no longer exist,
  // and every withheld event describes a state from a process that is gone.
  const adopt = (nextEpoch: string, nextCursor: number): void => {
    epoch = nextEpoch;
    cursor = nextCursor;
    withheld.clear();
  };

  const gate: LeadStreamGate = {
    accept(evt) {
      let resync = false;
      if (epoch == null) {
        epoch = evt.epoch;
      } else if (evt.epoch !== epoch) {
        // The server renumbered under us (restart, or a different node behind the
        // balancer) and the ready frame did not catch it. Without this the guard
        // below would reject seq 1..N against a stale high-water mark and the
        // stream would look perfectly connected while delivering nothing — the
        // exact failure this module exists to make impossible.
        adopt(evt.epoch, 0);
        resync = true;
      }
      if (evt.seq === cursor) return { action: "drop", reason: "duplicate" };
      if (evt.seq < cursor) return { action: "drop", reason: "stale" };
      cursor = evt.seq;

      // ── OPTIMISTIC RECONCILIATION — the rule, in full ────────────────────
      // 1. The caller holds a lead BEFORE staging its own mutation and releases
      //    it when that mutation SETTLES — saved, superseded, or dead-lettered.
      //    Every terminal state, or the pin stays deaf to the street.
      // 2. While held, pushes for that lead are withheld. Applying one would
      //    repaint the pin the rep just tapped back to the state the server held
      //    before the tap arrived — the user watching their own change get
      //    undone by their own network.
      // 3. Ordering still advances (cursor moved above). The seq is consumed, so
      //    a reconnect asks for what comes after it, not for it again.
      // 4. Only the NEWEST withheld event per lead survives. Two reps working the
      //    same door produce two pushes; the older one describes a state that no
      //    longer exists server-side, so replaying it on release would be
      //    strictly worse than dropping it. Newest seq wins — the same rule the
      //    server already enforces with its own recency CAS, mirrored rather
      //    than reinvented so the two can never disagree about who won.
      // 5. On release the survivor is delivered with meta.deferred = true. It is
      //    authoritative but late: the caller merges it as the server's verdict
      //    on the race, not as a competing opinion.
      if (gate.isHeld(evt.leadId)) {
        withheld.set(evt.leadId, evt);
        return { action: "defer", event: evt, resync };
      }
      // Not (or no longer) held: anything withheld for this lead is by
      // definition older than the event about to be applied, so it dies here
      // rather than being replayed over the top by a later sweep. Rule 4 again —
      // newest seq wins, including against the buffer's own contents.
      withheld.delete(evt.leadId);
      return { action: "apply", event: evt, resync };
    },

    syncReady(ready) {
      const parsed = parseSinceToken(ready.since);
      const tip = parsed?.seq ?? 0;
      // Two independent resync triggers: the server told us (gap, or a cursor
      // from another seq space), or we can see the epoch moved. A first-ever
      // connection is neither — it has nothing to have lost.
      const changedEpoch = epoch != null && ready.epoch !== epoch;
      const resync = ready.resync || changedEpoch;
      if (resync) {
        // The caller refetches the whole scope after this, which is strictly
        // newer than anything withheld — hence adopt(), which clears the buffer.
        // Holds themselves survive: the local mutation is still in flight, and a
        // refetch is exactly the write that must not clobber it.
        adopt(ready.epoch, tip);
      } else {
        epoch = ready.epoch;
        // max(), never assignment: the server reports the cursor it is replaying
        // FROM. Taking it blindly would rewind us over events already applied.
        cursor = Math.max(cursor, tip);
      }
      return { resync };
    },

    hold(leadId) {
      const existing = holds.get(leadId);
      if (existing) existing.count += 1;
      else holds.set(leadId, { count: 1, since: now() });
      let released = false;
      return () => {
        if (released) return; // idempotent — a settle path may fire twice
        released = true;
        const h = holds.get(leadId);
        if (!h) return;
        h.count -= 1;
        if (h.count <= 0) holds.delete(leadId);
      };
    },

    release(leadId) {
      holds.delete(leadId);
      const evt = withheld.get(leadId) ?? null;
      withheld.delete(leadId);
      return evt;
    },

    // TTL is evaluated on read, so the gate owns no timer and stays drivable by
    // an injected clock. Read-only by design — see the interface note.
    isHeld: (leadId) => {
      const h = holds.get(leadId);
      return h != null && now() - h.since < holdTtlMs;
    },

    sweepHolds() {
      if (holds.size === 0) return [];
      const t = now();
      const expired: LeadStreamExpiredHold[] = [];
      for (const [leadId, h] of holds) {
        if (t - h.since < holdTtlMs) continue;
        holds.delete(leadId);
        const evt = withheld.get(leadId) ?? null;
        withheld.delete(leadId);
        expired.push({ leadId, event: evt });
      }
      return expired.sort((a, b) => (a.event?.seq ?? 0) - (b.event?.seq ?? 0));
    },

    holdCount: () => holds.size,
    cursor: () => cursor,
    epoch: () => epoch,
    // Emitted even at cursor 0: it still carries the epoch, which is what lets
    // the server answer "your seq space is gone, resync" instead of accepting a
    // bare number that means something different on every process.
    since: () => (epoch == null ? null : `${epoch}.${cursor}`),
  };

  return gate;
}

// ── Subscription ─────────────────────────────────────────────────────────────

function resolveSourceCtor(explicit?: LeadStreamSourceCtor): LeadStreamSourceCtor | null {
  if (explicit) return explicit;
  const native = (globalThis as any).EventSource;
  return typeof native === "function" ? (native as LeadStreamSourceCtor) : null;
}

/**
 * Open the lead stream. Returns a handle; call close() on unmount.
 *
 * Reconnection is owned entirely here — every error closes the source rather
 * than letting the browser's built-in retry run underneath us. One retry policy
 * with jitter and a fallback signal beats two policies interleaving, and it
 * closes the hole where a source stuck in CONNECTING retries on a fixed 3s
 * timer forever while this module believes it is connected.
 */
export function subscribeLeadStream(opts: SubscribeLeadStreamOptions): LeadStreamHandle {
  const url = opts.url ?? LEAD_STREAM_URL;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const baseMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const fallbackAfter = Math.max(1, opts.fallbackAfterAttempts ?? DEFAULT_FALLBACK_AFTER);
  const healthyAfterMs = opts.healthyAfterMs ?? DEFAULT_HEALTHY_AFTER_MS;
  const gate = createLeadStreamGate({ now, holdTtlMs: opts.holdTtlMs });

  let closed = false;
  let source: LeadStreamSource | null = null;
  let attempt = 0;
  let degraded = false;
  let status: LeadStreamStatus = "connecting";
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let healthyTimer: ReturnType<typeof setTimeout> | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  const setStatus = (next: LeadStreamStatus, info: Partial<LeadStreamStatusInfo> = {}): void => {
    status = next;
    opts.onStatus?.(next, { attempt, delayMs: info.delayMs ?? null, status: info.status ?? null });
  };

  const signalFallback = (
    active: boolean,
    reason: LeadStreamFallbackInfo["reason"],
    httpStatus: number | null,
  ): void => {
    if (degraded === active) return; // edge-triggered: start polling once, stop once
    degraded = active;
    opts.onFallback?.({ reason, attempts: attempt, status: httpStatus, active });
  };

  const deliver = (evt: LeadStreamEvent, meta: LeadStreamEventMeta): void => {
    try {
      opts.onEvent(evt, meta);
    } catch (err) {
      // A throwing consumer must not kill the stream — the next event is still
      // deliverable, and the cursor has already moved past this one either way.
      console.warn("[leadStream] consumer threw on lead event", err);
    }
  };

  // Runs only while something is held, mirroring knockQueue's heartbeat: an idle
  // stream costs nothing. Without it, a hold leaked by a broken settle path is
  // only noticed the next time that same door changes — possibly never.
  const syncSweepTimer = (): void => {
    if (closed) return;
    if (gate.holdCount() > 0 && sweepTimer == null) {
      sweepTimer = setInterval(() => {
        for (const expired of gate.sweepHolds()) {
          console.warn(`[leadStream] hold on lead ${expired.leadId} expired un-released`);
          if (expired.event) deliver(expired.event, { deferred: true, holdExpired: true });
        }
        syncSweepTimer();
      }, HOLD_SWEEP_MS);
    } else if (gate.holdCount() === 0 && sweepTimer != null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  };

  const teardownSource = (): void => {
    if (healthyTimer != null) {
      clearTimeout(healthyTimer);
      healthyTimer = null;
    }
    const src = source;
    source = null;
    // Listeners were attached to this instance only, so closing it drops them.
    try {
      src?.close();
    } catch {
      /* a half-constructed source may not close cleanly; nothing left to do */
    }
  };

  const scheduleReconnect = (httpStatus: number | null): void => {
    if (closed) return;
    attempt += 1;
    if (attempt >= fallbackAfter) signalFallback(true, "unreachable", httpStatus);
    const delayMs = backoffDelayMs(attempt - 1, { baseMs, maxMs, random });
    setStatus("reconnecting", { delayMs, status: httpStatus });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
  };

  const onReady = (ev: any): void => {
    if (closed) return;
    const ready = parseReadyFrame(String(ev?.data ?? ""));
    if (!ready) return;
    const { resync } = gate.syncReady(ready);
    setStatus("live");
    // Proven-healthy is a LATER moment than "connected", and the fallback signal
    // waits for it: a caller told to stop polling by a socket that dies three
    // seconds later has been told a lie. Status is the cheap noisy signal;
    // fallback is the expensive one, so only fallback is debounced.
    if (healthyTimer != null) clearTimeout(healthyTimer);
    healthyTimer = setTimeout(() => {
      healthyTimer = null;
      attempt = 0;
      signalFallback(false, "recovered", null);
    }, healthyAfterMs);
    if (resync) opts.onResync?.(ready.resync ? "server" : "epoch");
  };

  const onLead = (ev: any): void => {
    if (closed) return;
    const evt = parseLeadEventFrame(String(ev?.data ?? ""));
    if (!evt) return;
    const decision = gate.accept(evt);
    if (decision.action === "drop") return;
    if (decision.resync) opts.onResync?.("epoch");
    if (decision.action === "apply") deliver(evt, { deferred: false, holdExpired: false });
    // "defer" needs nothing here — the event is buffered and released later.
  };

  /**
   * Team announcements share this socket. (Server-side reasoning: a second SSE
   * stream is a second TLS session and a second 15s keepalive on a phone that is
   * on LTE all day.)
   *
   * They bypass the gate entirely, and that is deliberate rather than lazy. The
   * gate exists to order and deduplicate LEAD patches against a cursor, because
   * a missed pin update is silently wrong. An announcement has no cursor, no
   * ordering requirement, and a durable home in /api/announcements — the worst
   * case for a dropped frame is that it appears on the next refetch. Feeding it
   * through the gate would make it answerable to a sequence it is not part of,
   * and a resync would then discard it for no reason.
   */
  const onAnnouncementFrame = (ev: any): void => {
    if (closed || !opts.onAnnouncement) return;
    try {
      const parsed = JSON.parse(String(ev?.data ?? ""));
      if (parsed && typeof parsed === "object" && typeof parsed.id === "number") {
        opts.onAnnouncement(parsed as StreamAnnouncement);
      }
    } catch { /* a malformed frame must never take down the stream */ }
  };

  const onError = (ev: any): void => {
    if (closed) return;
    const httpStatus = typeof ev?.status === "number" ? ev.status : null;
    teardownSource();
    // 401/403 will not change while this session lives: the session is gone, or
    // this identity has no org / no field capability. Retrying is pure radio
    // burn. Stop — but say so first, loudly, because going quiet without a
    // signal is the failure mode this module refuses to have.
    if (httpStatus === 401 || httpStatus === 403) {
      signalFallback(true, httpStatus === 401 ? "unauthorized" : "forbidden", httpStatus);
      setStatus("closed", { status: httpStatus });
      return;
    }
    scheduleReconnect(httpStatus);
  };

  const connect = (): void => {
    if (closed) return;
    const Ctor = resolveSourceCtor(opts.EventSourceImpl);
    if (!Ctor) {
      // No transport at all (SSR, or a runtime without EventSource). One signal,
      // no retry loop — polling is the only path from here.
      signalFallback(true, "unsupported", null);
      setStatus("closed");
      return;
    }
    setStatus("connecting");
    const since = gate.since();
    try {
      // The resume cursor goes out BOTH ways for the same reason the server reads
      // both: ?since= works on any transport, and lastEventId becomes the
      // Last-Event-ID header on the fetch source, which the server prefers. They
      // carry the same value here, so the preference can never pick the wrong one.
      source = new Ctor(withSince(url, since), since ? { lastEventId: since } : undefined);
    } catch (err) {
      console.warn("[leadStream] could not open stream", err);
      scheduleReconnect(null);
      return;
    }
    source.addEventListener("ready", onReady);
    source.addEventListener("lead", onLead);
    source.addEventListener("announcement", onAnnouncementFrame);
    source.addEventListener("error", onError);
  };

  connect();

  return {
    close() {
      if (closed) return;
      closed = true;
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      if (sweepTimer != null) clearInterval(sweepTimer);
      reconnectTimer = null;
      sweepTimer = null;
      teardownSource();
      setStatus("closed");
    },
    hold(leadId) {
      const release = gate.hold(leadId);
      syncSweepTimer();
      return () => {
        release();
        if (!gate.isHeld(leadId)) {
          const pending = gate.release(leadId);
          if (pending) deliver(pending, { deferred: true, holdExpired: false });
        }
        syncSweepTimer();
      };
    },
    release(leadId) {
      const pending = gate.release(leadId);
      if (pending) deliver(pending, { deferred: true, holdExpired: false });
      syncSweepTimer();
    },
    isHeld: (leadId) => gate.isHeld(leadId),
    since: () => gate.since(),
    status: () => status,
  };
}

// ── fetch-based EventSource ──────────────────────────────────────────────────
// Exists because this app authenticates with an x-session-id HEADER, which the
// native EventSource cannot send. It is deliberately a THIN source, not a second
// EventSource: no internal retry (subscribeLeadStream owns exactly one retry
// policy) and no `retry:` handling, so the two can never fight over when to
// reconnect.
//
// It also closes a hole the native one cannot: the server's keepalive is an SSE
// comment (`: ping` every 15s), and comments are invisible to EventSource. A
// black-holed TCP connection — routine on mobile — therefore looks identical to
// a quiet street forever. Reading the body ourselves means we see the bytes, so
// a stalled socket becomes a real error, a real reconnect, and (if it persists)
// a real fallback signal.

export interface FetchEventSourceOptions {
  /** Evaluated per connect, so a refreshed session token is picked up on the
   *  next reconnect rather than being frozen at subscribe time. */
  headers?: () => Record<string, string>;
  fetchImpl?: typeof fetch;
  /** No bytes at all for this long ⇒ the socket is gone. Three missed 15s
   *  keepalives; tight enough to matter on a shift, loose enough to survive a
   *  tunnel. */
  stallTimeoutMs?: number;
}

export function createFetchEventSource(opts: FetchEventSourceOptions = {}): LeadStreamSourceCtor {
  const stallTimeoutMs = opts.stallTimeoutMs ?? 45_000;

  return class FetchEventSource implements LeadStreamSource {
    readyState = 0; // 0 CONNECTING, 1 OPEN, 2 CLOSED — mirrors EventSource
    private readonly listeners = new Map<string, Set<(ev: any) => void>>();
    private readonly controller = new AbortController();
    private stallTimer: ReturnType<typeof setTimeout> | null = null;
    private done = false;

    constructor(url: string, init?: LeadStreamSourceInit) {
      // Listeners are attached synchronously by the caller right after
      // construction, so the read loop is started on a microtask — otherwise a
      // response that fails instantly would emit "error" before anyone is
      // listening and the stream would hang forever with nobody to reconnect it.
      queueMicrotask(() => void this.run(url, init));
    }

    addEventListener(type: string, listener: (ev: any) => void): void {
      const set = this.listeners.get(type) ?? new Set();
      set.add(listener);
      this.listeners.set(type, set);
    }

    close(): void {
      this.finish(false);
    }

    private emit(type: string, ev: any): void {
      for (const fn of this.listeners.get(type) ?? []) {
        try {
          fn(ev);
        } catch (err) {
          console.warn(`[leadStream] listener threw on "${type}"`, err);
        }
      }
    }

    /** Single exit point. `notify` is false only for an explicit close(): the
     *  consumer asked for this, so raising an error would make its own teardown
     *  look like an outage and trigger a reconnect it does not want. */
    private finish(notify: boolean, detail?: { status?: number; reason?: string }): void {
      if (this.done) return;
      this.done = true;
      this.readyState = 2;
      if (this.stallTimer != null) {
        clearTimeout(this.stallTimer);
        this.stallTimer = null;
      }
      try {
        this.controller.abort();
      } catch {
        /* already aborted */
      }
      if (notify) this.emit("error", { type: "error", ...detail });
    }

    private armStall(): void {
      if (this.stallTimer != null) clearTimeout(this.stallTimer);
      this.stallTimer = setTimeout(() => {
        this.finish(true, { reason: "stall" });
      }, stallTimeoutMs);
    }

    private async run(url: string, init?: LeadStreamSourceInit): Promise<void> {
      const doFetch = opts.fetchImpl ?? fetch;
      try {
        const headers: Record<string, string> = {
          Accept: "text/event-stream",
          ...(opts.headers?.() ?? {}),
        };
        // The server reads this BEFORE ?since= — same value, so the preference is
        // harmless, and it is the only cursor a transport-level retry could carry.
        if (init?.lastEventId) headers["Last-Event-ID"] = init.lastEventId;
        const res = await doFetch(url, {
          headers,
          cache: "no-store",
          credentials: init?.withCredentials ? "include" : "same-origin",
          signal: this.controller.signal,
        });
        // Status is surfaced on the error event because the retry policy needs
        // it: 503 (connection cap) is worth backing off into, 401/403 is not.
        if (!res.ok || !res.body) {
          this.finish(true, { status: res.status, reason: "http" });
          return;
        }
        this.readyState = 1;
        this.emit("open", { type: "open" });
        this.armStall();

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let lastEventId = init?.lastEventId ?? "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            // The server ended the stream: an outage, a deploy, or the cap being
            // reclaimed. Always an error to us — never a clean, silent stop.
            this.finish(true, { reason: "eof" });
            return;
          }
          // ANY bytes count as liveness, including the keepalive comment — that
          // is the whole reason for reading the body by hand.
          this.armStall();
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          for (;;) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary < 0) break;
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            let type = "message";
            const dataLines: string[] = [];
            for (const line of frame.split("\n")) {
              if (line.length === 0 || line.startsWith(":")) continue; // keepalive
              const colon = line.indexOf(":");
              const field = colon < 0 ? line : line.slice(0, colon);
              // Per the SSE grammar exactly ONE leading space is stripped —
              // trim() would corrupt any payload where whitespace matters.
              let val = colon < 0 ? "" : line.slice(colon + 1);
              if (val.startsWith(" ")) val = val.slice(1);
              if (field === "event") type = val;
              else if (field === "data") dataLines.push(val);
              else if (field === "id") lastEventId = val;
              // `retry` is ignored on purpose — subscribeLeadStream owns backoff.
            }
            if (dataLines.length === 0) continue;
            this.emit(type, { type, data: dataLines.join("\n"), lastEventId });
          }
        }
      } catch (err) {
        // An abort is our own close() unwinding; anything else is a real drop.
        if ((err as any)?.name === "AbortError") {
          this.finish(false);
          return;
        }
        this.finish(true, { reason: "network" });
      }
    }
  };
}
