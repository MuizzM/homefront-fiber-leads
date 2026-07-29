// ── Lead event bus (tenant-scoped, in-process) ────────────────────────────────
// Live lead changes — outcome flips, note edits, assignment moves, status
// changes — so the map/board can patch a pin instead of re-polling the whole
// scope. Modelled on scanStageBus + scanEvents, with one structural difference
// that drives the entire file: scan telemetry is process-global and every
// consumer is already gated to a single run or to admin, whereas leads are
// TENANT-OWNED and row-scoped per rep. So the tenant is part of the event, part
// of the read path, and the read path has no "give me everything" mode at all.
//
// Zero DB, zero transport — the lead write path stays synchronous and unit
// testable, and emit is best-effort: a live-update failure must never fail a
// knock. The durable record of a lead change is the leads table itself; this is
// only the notification edge.
//
// Durability: none, deliberately. The ring is a RECONNECT WINDOW (the last
// RING_MAX events this process emitted), not a log. Anything older is recovered
// the way it already is today — the client refetches through the role-scoped
// map endpoint, which re-applies row-level access per lead. That is why a gap is
// REPORTED rather than papered over; see eventsSince().
import { EventEmitter } from "node:events";
import { scrubSecretText } from "./secretScrub";

/** What changed. The client branches on this to decide how loud the update is
 *  (an outcome flip repaints a pin; a note edit only refreshes an open card). */
export type LeadEventType = "outcome" | "notes" | "assignment" | "status";

/**
 * The lead projection carried on the wire — an ALLOWLIST, not a denylist, for
 * the same reason as the field scan feed: a projection that starts from the row
 * and removes fields silently starts shipping every column somebody adds later.
 *
 * Two exclusions are load-bearing:
 *  • contactName/contactPhone/contactEmail and the notes BODY are absent. The
 *    map pin never showed them (see MapPinRow in storage.ts) — the card fetches
 *    them lazily from /api/leads/:id, which re-checks access for that one lead.
 *    A broadcast bus is the worst possible place to ship PII, and free text a
 *    rep typed is exactly where a customer's phone number ends up.
 *  • knockCount / lastKnockedAt / freshConfidence / carrier are absent because
 *    they are JOINED by the map query, not columns the write path holds. Sending
 *    them half-populated would make null ambiguous between "zero" and "unknown";
 *    the client keeps its own joined values and the ETag poll reconciles them.
 *
 * assignedRepId + assignedTerritoryId are here as a SECURITY INPUT, not for
 * display: they are precisely the two fields repCanAccessLead() needs (direct
 * assignment, or the area — areas are many-to-many via territories.assignee_ids).
 * Without them a subscriber could only apply the tenant wall, and every rep in
 * the tenant would see every door in it.
 */
export interface LeadEventPin {
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

export interface LeadEvent {
  epoch: string;              // boot identity of the seq space — see _epoch
  seq: number;                // monotonic per process; the ordering + dedup key
  ts: string;                 // ISO, DISPLAY ONLY — ordering is seq, never ts
  tenantId: number;
  leadId: number;
  type: LeadEventType;
  actorId: number | null;
  actorName: string | null;   // "Marcus updated this lead" — a display name only
  lead: LeadEventPin | null;  // null when the caller had no row (e.g. a delete)
}

export interface LeadEventInput {
  tenantId: number;
  leadId: number;
  type: LeadEventType;
  actorId?: number | null;
  actorName?: string | null;
  /** Any lead-shaped row; only the allowlisted fields above are read off it. */
  lead?: Record<string, unknown> | null;
}

export interface LeadEventReplay {
  epoch: string;
  events: LeadEvent[];
  /** True when events this caller may have needed were already evicted from the
   *  ring. The caller MUST fall back to a full refetch — see eventsSince(). */
  gapped: boolean;
  /** Cursor to send on the next call. Tenant-local, never the global counter. */
  nextSeq: number;
}

// Ring size is the reconnect window, not a retention policy: 500 events covers
// a phone that drops off LTE for a minute in a busy tenant. Past that the client
// refetches, which is correct and cheap — so growing this buys nothing.
const RING_MAX = Math.max(100, Number(process.env.LEAD_EVENTS_MAX ?? 500) || 500);
// One replay call is bounded like the discovery pump: the caller advances its
// cursor and asks again, so a big backlog costs several small frames instead of
// one frame big enough to stall a slow socket.
const REPLAY_MAX = 200;
const EVENT = "lead";

const bus = new EventEmitter();
// Every field phone holding the live map pins one listener, so the realistic
// ceiling here is rep-count-shaped rather than admin-count-shaped (the scan
// relay's 100 would warn on an ordinary Friday). Raised, not disabled — 0 would
// mean "unlimited", which is exactly how a listener leak hides.
bus.setMaxListeners(500);

const _ring: LeadEvent[] = [];
let _seq = 0;

function newEpoch(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
// seq restarts at 1 on every boot, so a client reconnecting to a restarted (or
// load-balanced-to-a-different) process would otherwise treat its stale cursor
// as valid and skip straight past the renumbered events. Same trick as the
// /api/leads/map ETag boot stamp: epoch mismatch ⇒ the cursor means nothing,
// refetch. The random suffix covers two nodes booting in the same millisecond.
let _epoch = newEpoch();

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function toPin(lead: unknown): LeadEventPin | null {
  if (!lead || typeof lead !== "object") return null;
  const row = lead as Record<string, unknown>;
  const id = num(row.id) ?? Number(row.id);
  if (!Number.isFinite(id)) return null;
  return Object.freeze({
    id,
    // Address text arrives from provider address catalogs on the scan-import
    // path, so the only genuinely upstream-authored strings go through the
    // shared scrubber — this module has to be safe when a route consuming it is
    // mounted without the global response sanitizer in server/index.ts (tests
    // and embedded harnesses are). The rest are enums, ids or coordinates.
    address: scrubSecretText(str(row.address)),
    city: scrubSecretText(str(row.city)),
    state: str(row.state),
    zip: str(row.zip),
    lat: num(row.lat),
    lng: num(row.lng),
    leadStatus: str(row.leadStatus),
    fiberStatus: str(row.fiberStatus),
    leadTag: str(row.leadTag),
    leadScore: num(row.leadScore),
    assignMark: str(row.assignMark),
    // Drizzle hands back a boolean, rawDb hands back 0/1, and this flag is a
    // permanent compliance block — the one field where guessing wrong sends a
    // rep to a door they were told never to return to.
    doNotKnock: row.doNotKnock === true || row.doNotKnock === 1,
    lastOutcome: str(row.lastOutcome),
    lastOutcomeAt: str(row.lastOutcomeAt),
    assignedRepId: num(row.assignedRepId),
    assignedTerritoryId: num(row.assignedTerritoryId),
  });
}

/**
 * Record + broadcast one lead change. Never throws. Returns the stored event, or
 * null when the input could not be walled (see below) and was therefore dropped.
 */
export function emitLeadEvent(input: LeadEventInput): LeadEvent | null {
  const tenantId = Number(input?.tenantId);
  const leadId = Number(input?.leadId);
  // An event we cannot attribute to a tenant is DROPPED, never emitted under a
  // placeholder and never treated as "applies to everyone". Every read path here
  // is an exact tenant match, so a tenant-less event is undeliverable anyway —
  // keeping it would only consume ring space a real event needs, while leaving a
  // record that a future "convenience" filter could accidentally widen.
  if (!Number.isInteger(tenantId) || tenantId <= 0) return null;
  if (!Number.isInteger(leadId) || leadId <= 0) return null;

  // Frozen because the ring hands this SAME object reference to every listener
  // AND to every later replay: one listener mutating it in place would silently
  // rewrite history for everyone who reconnects afterwards.
  const evt: LeadEvent = Object.freeze({
    epoch: _epoch,
    seq: ++_seq,
    ts: new Date().toISOString(),
    tenantId,
    leadId,
    type: input.type,
    actorId: num(input.actorId),
    actorName: scrubSecretText(str(input.actorName)),
    lead: toPin(input.lead),
  });

  // Ring BEFORE listeners: a subscriber that throws must not cost the reconnect
  // window the event it would have replayed.
  _ring.push(evt);
  if (_ring.length > RING_MAX) _ring.splice(0, _ring.length - RING_MAX);
  try {
    bus.emit(EVENT, evt);
  } catch {
    /* swallow — a live update must never fail a lead write */
  }
  return evt;
}

/** In-process subscription for the SSE endpoints. Returns an unsubscribe fn.
 *  Subscribers receive EVERY tenant's events and MUST re-apply both the tenant
 *  wall and repCanAccessLead per event — the bus is process-wide, exactly like
 *  the scan relay. */
export function onLeadEvent(listener: (evt: LeadEvent) => void): () => void {
  bus.on(EVENT, listener);
  return () => bus.off(EVENT, listener);
}

// No hasLeadEventSubscribers() twin to scanStageBus's: that helper exists so an
// emitter can skip building a payload when nobody is listening, which would be
// actively wrong here — the ring has to be filled even with zero listeners, or a
// client reconnecting into a quiet moment replays a hole it can't detect.

/**
 * Replay this tenant's events after `seq`, oldest-first and capped.
 *
 * `gapped` is the whole point of the return shape. A bare array cannot tell
 * "nothing changed" apart from "you missed 900 events", and that ambiguity is
 * precisely the failure the buffer exists to prevent — a sold door silently
 * missing from a map until the next poll. Callers treat gapped as "drop the
 * cursor and refetch the scope".
 */
export function eventsSince(tenantId: number, seq: number): LeadEventReplay {
  const tid = Number(tenantId);
  const raw = Number(seq);
  const cursor = Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
  // Hard stop, not a filter default. The one bug this module must never have is
  // a read path where "no tenant" degrades into "every tenant".
  if (!Number.isInteger(tid) || tid <= 0) {
    return { epoch: _epoch, events: [], gapped: false, nextSeq: cursor };
  }

  // Gap is measured against the GLOBAL ring's oldest entry, not this tenant's
  // slice: eviction is global, so a tenant-local view genuinely cannot tell "you
  // missed events" from "you had none". Conservative by design — a false gap
  // costs one refetch the client already knows how to do, a missed gap costs a
  // stale map nobody notices.
  const oldest = _ring[0];
  const gapped = cursor > 0 && oldest != null && oldest.seq > cursor + 1;

  const events: LeadEvent[] = [];
  let nextSeq = cursor;
  for (const evt of _ring) {
    if (evt.seq <= cursor || evt.tenantId !== tid) continue;
    events.push(evt);
    nextSeq = evt.seq;
    if (events.length >= REPLAY_MAX) break;   // caller advances the cursor and asks again
  }
  return { epoch: _epoch, events, gapped, nextSeq };
}

/** This tenant's newest seq — the starting cursor for a FRESH connection, which
 *  should tail rather than replay a window it just fetched in full.
 *
 *  Deliberately tenant-scoped rather than exposing the global counter: `_seq`
 *  counts every tenant's writes, so handing it out would leak cross-tenant
 *  activity volume to any rep with a browser — the same reason the run-stage
 *  feed exposes no offset at all. */
export function leadEventsCursor(tenantId: number): number {
  const tid = Number(tenantId);
  if (!Number.isInteger(tid) || tid <= 0) return 0;
  for (let i = _ring.length - 1; i >= 0; i--) if (_ring[i].tenantId === tid) return _ring[i].seq;
  return 0;
}

/** Boot identity of the current seq space, for the initial SSE frame — a client
 *  with no events yet still needs to know which epoch its cursor belongs to. */
export function leadEventsEpoch(): string {
  return _epoch;
}

/** How many subscribers are attached. Every long-lived stream MUST unsubscribe
 *  on disconnect — a listener leak silently grows the fan-out cost of every lead
 *  write and eventually trips the emitter's max-listeners warning. Exposed so
 *  tests can assert the count returns to baseline after a client hangs up. */
export function leadEventListenerCount(): number {
  return bus.listenerCount(EVENT);
}

/** Full reset between tests. Listeners are dropped too: a stream leaked by an
 *  earlier test would otherwise keep firing into the next one's assertions, and
 *  the leak checks above are only meaningful from a known-zero baseline. The
 *  epoch is regenerated with the seq space so a cursor captured before the reset
 *  is correctly rejected rather than silently re-validated by the new numbering. */
export function __resetLeadEventsForTests(): void {
  _ring.length = 0;
  _seq = 0;
  _epoch = newEpoch();
  bus.removeAllListeners(EVENT);
}
