// ── Scan event store (durable timeline + live snapshot + accounting) ───────────
// Subscribes to the scanStageBus, persists a BOUNDED per-address event timeline
// (survives page refresh AND server restart), derives each address's current
// stage + the live counters, and re-broadcasts events in-process for SSE.
//
// Volume guard: the statewide sweep can emit thousands of events/min, so the log
// is capped (SCAN_EVENTS_MAX, default 4000 newest) and pruned periodically. That
// keeps a rich recent timeline (~400 addresses × ~8 stages) without unbounded
// growth. Persistence failures are swallowed — telemetry never breaks a scan.
import { rawDb } from "./db";
import { isSqliteContention, withoutSqliteBusyWait } from "./interactiveDb";
import { onStage, type ScanStageEvent, type ScanStage } from "./scanStageBus";
import { EventEmitter } from "node:events";

const MAX_EVENTS = Math.max(500, Number(process.env.SCAN_EVENTS_MAX ?? 4000));
const PRUNE_EVERY = 200;
// ── Write-amplification control ──────────────────────────────────────────────
// scan_events was one synchronous INSERT per pipeline stage — 7+ per address, so
// at ~200 addr/min the telemetry alone fired ~1,400 write transactions/min, each
// taking the WAL write lock and blocking the worker's event loop. That is a top
// contributor to DB-lock contention + single-core peg. We now BUFFER events and
// flush them in ONE bounded bulk transaction on a short timer (or when the buffer
// fills). The live SSE relay still emits every event IMMEDIATELY (real-time view
// unaffected); only the DB persist is batched. scan_events is diagnostic + already
// bounded/pruned, so a handful of un-flushed rows lost on a hard crash is
// acceptable. Kill-switch SCAN_EVENTS_BATCH=off → per-event persist (old path).
const BATCH_ENABLED = process.env.SCAN_EVENTS_BATCH !== "off";
const FLUSH_MS = Math.max(100, Number(process.env.SCAN_EVENTS_FLUSH_MS ?? 750) || 750);
const FLUSH_MAX = Math.max(50, Number(process.env.SCAN_EVENTS_FLUSH_MAX ?? 500) || 500);
const BUF_CAP = Math.max(FLUSH_MAX * 4, Number(process.env.SCAN_EVENTS_BUF_CAP ?? 5000) || 5000);
const _buf: ScanStageEvent[] = [];
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _retryFlushAfter = 0;
let _bulkInsert: ((rows: ScanStageEvent[]) => void) | null = null;

const relay = new EventEmitter();
relay.setMaxListeners(100);

let _ready = false;
let _sincePrune = 0;
let _insert: any = null;

function ensureSchema(): void {
  if (_ready) return;
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS scan_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address_key TEXT NOT NULL,
      address TEXT, city TEXT, state TEXT, zip TEXT,
      run_id TEXT, source TEXT,
      stage TEXT NOT NULL, status TEXT,
      attempt INTEGER DEFAULT 1,
      http_status INTEGER, latency_ms INTEGER,
      session_id TEXT, token_suffix TEXT,
      retry_reason TEXT, classification TEXT, detail TEXT,
      ts_epoch INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scan_events_ts ON scan_events(ts_epoch);
    CREATE INDEX IF NOT EXISTS idx_scan_events_addr ON scan_events(address_key, ts_epoch);
  `);
  _insert = rawDb.prepare(`
    INSERT INTO scan_events
      (address_key, address, city, state, zip, run_id, source, stage, status,
       attempt, http_status, latency_ms, session_id, token_suffix, retry_reason,
       classification, detail, ts_epoch)
    VALUES
      (@addressKey, @address, @city, @state, @zip, @runId, @source, @stage, @status,
       @attempt, @httpStatus, @latencyMs, @sessionId, @tokenSuffix, @retryReason,
       @classification, @detail, @tsEpoch)
  `);
  // One prepared statement, reused inside a single transaction for the whole batch.
  const bind = (evt: ScanStageEvent) => ({
    addressKey: evt.addressKey,
    address: evt.address ?? null, city: evt.city ?? null, state: evt.state ?? null, zip: evt.zip ?? null,
    runId: evt.runId ?? null, source: evt.source ?? null,
    stage: evt.stage, status: evt.status ?? null,
    attempt: evt.attempt ?? 1,
    httpStatus: evt.httpStatus ?? null, latencyMs: evt.latencyMs ?? null,
    sessionId: evt.sessionId ?? null, tokenSuffix: evt.tokenSuffix ?? null,
    retryReason: evt.retryReason ?? null, classification: evt.classification ?? null,
    detail: evt.detail ?? null, tsEpoch: evt.tsEpoch,
  });
  _bulkInsert = rawDb.transaction((rows: ScanStageEvent[]) => {
    for (const evt of rows) _insert.run(bind(evt));
  });
  _ready = true;
}

/** Drain the event buffer into ONE bulk transaction. Bounded per call (FLUSH_MAX)
 *  so a burst never holds the write lock too long; the timer picks up the rest on
 *  the next tick. Best-effort — telemetry never breaks a scan. */
export function flushScanEvents(): number {
  return withoutSqliteBusyWait(rawDb, flushScanEventsNow);
}

function flushScanEventsNow(): number {
  if (!_buf.length) return 0;
  try { ensureSchema(); } catch { return 0; }
  const batch = _buf.splice(0, FLUSH_MAX);
  try {
    _bulkInsert!(batch);
  } catch (error) {
    if (isSqliteContention(error)) {
      // Preserve pending telemetry through temporary contention, bounded by the
      // same oldest-first overflow policy as normal ingress.
      _buf.unshift(...batch);
      if (_buf.length > BUF_CAP) _buf.splice(0, _buf.length - BUF_CAP);
      _retryFlushAfter = Date.now() + FLUSH_MS;
      return 0;
    }
    // Malformed diagnostic rows retain the existing lossy failure policy.
  }
  _retryFlushAfter = 0;
  // Prune occasionally (amortized), not per-row.
  _sincePrune += batch.length;
  if (_sincePrune >= PRUNE_EVERY) {
    _sincePrune = 0;
    try {
      rawDb.prepare(`DELETE FROM scan_events WHERE id <= (
        SELECT id FROM scan_events ORDER BY id DESC LIMIT 1 OFFSET ?
      )`).run(MAX_EVENTS);
    } catch { /* prune best-effort */ }
  }
  return batch.length;
}

function persist(evt: ScanStageEvent): number | null {
  ensureSchema();
  const info = _insert.run({
    addressKey: evt.addressKey,
    address: evt.address ?? null, city: evt.city ?? null, state: evt.state ?? null, zip: evt.zip ?? null,
    runId: evt.runId ?? null, source: evt.source ?? null,
    stage: evt.stage, status: evt.status ?? null,
    attempt: evt.attempt ?? 1,
    httpStatus: evt.httpStatus ?? null, latencyMs: evt.latencyMs ?? null,
    sessionId: evt.sessionId ?? null, tokenSuffix: evt.tokenSuffix ?? null,
    retryReason: evt.retryReason ?? null, classification: evt.classification ?? null,
    detail: evt.detail ?? null, tsEpoch: evt.tsEpoch,
  });
  if (++_sincePrune >= PRUNE_EVERY) {
    _sincePrune = 0;
    try {
      rawDb.prepare(`DELETE FROM scan_events WHERE id <= (
        SELECT id FROM scan_events ORDER BY id DESC LIMIT 1 OFFSET ?
      )`).run(MAX_EVENTS);
    } catch { /* prune best-effort */ }
  }
  return Number(info.lastInsertRowid);
}

let _started = false;
/** Begin persisting + relaying bus events. Idempotent; call once at boot. */
export function startScanEvents(): void {
  if (_started) return;
  _started = true;
  try { ensureSchema(); } catch { /* schema will retry on first event */ }
  onStage((evt) => {
    // LIVE path is always immediate — the SSE inspector stays real-time. Only DB
    // persistence is batched (below), so the live view never waits on a write.
    if (BATCH_ENABLED) {
      _buf.push(evt);
      // Backpressure: if the flusher can't keep up (buffer past cap), drop the
      // OLDEST buffered diagnostics rather than grow memory unbounded or flush a
      // giant lock-holding transaction. The live relay already showed them.
      if (_buf.length > BUF_CAP) _buf.splice(0, _buf.length - BUF_CAP);
      // Flush eagerly when a full batch has accumulated (keeps the buffer small
      // under bursts without waiting the whole timer interval).
      if (_buf.length >= FLUSH_MAX && Date.now() >= _retryFlushAfter) flushScanEvents();
      relay.emit("event", { id: null, ...evt });
    } else {
      let id: number | null = null;
      try { id = withoutSqliteBusyWait(rawDb, () => persist(evt)); } catch { /* swallow — never break a scan */ }
      relay.emit("event", { id, ...evt });
    }
  });
  if (BATCH_ENABLED && !_flushTimer) {
    _flushTimer = setInterval(() => { try { flushScanEvents(); } catch { /* next tick */ } }, FLUSH_MS);
    if (typeof (_flushTimer as any).unref === "function") (_flushTimer as any).unref();
  }
}

/** In-process subscription for the SSE endpoints. Returns an unsubscribe fn. */
export function onScanEvent(cb: (evt: ScanStageEvent & { id: number | null }) => void): () => void {
  relay.on("event", cb);
  return () => relay.off("event", cb);
}

/** How many SSE relays are currently attached. Every long-lived stream MUST
 *  unsubscribe on disconnect — a relay listener leak silently grows the fan-out
 *  cost of every scan event on the hot path (and eventually trips the emitter's
 *  max-listeners warning). Exposed so tests can assert the count returns to its
 *  baseline after a client hangs up. */
export function scanEventListenerCount(): number {
  return relay.listenerCount("event");
}

// ── Snapshot / accounting ────────────────────────────────────────────────────
// The inspector's live rows + counters are DERIVED from the latest event per
// address in the recent window, so they survive refresh/restart from the log.

const CHECKING_STAGES: ScanStage[] = ["minting", "token_ready", "searching", "parsing", "saving"];

export interface InspectorRow {
  addressKey: string;
  address: string; city: string; state: string; zip: string;
  runId: string | null; source: string | null;
  stage: ScanStage; status: string;
  attempt: number;
  httpStatus: number | null; latencyMs: number | null;
  sessionId: string | null; tokenSuffix: string | null;
  retryReason: string | null; classification: string | null; detail: string | null;
  startedAt: number; updatedAt: number;
}

export interface InspectorCounters {
  found: number;
  checked: number; queued: number; checking: number; retrying: number; unresolved: number;
  // Fresh-lead-facing tallies for the compact header.
  newNow: number; newlyLit: number; stillFresh: number; comingSoon: number;
}

function bucketOf(stage: ScanStage): keyof Omit<InspectorCounters, "found" | "newNow" | "newlyLit" | "stillFresh" | "comingSoon"> {
  if (stage === "classified") return "checked";
  if (stage === "queued" || stage === "discovered") return "queued";
  if (stage === "retry") return "retrying";
  if (stage === "blocked" || stage === "bad_request" || stage === "error") return "unresolved";
  if (CHECKING_STAGES.includes(stage)) return "checking";
  return "queued";
}

export interface InspectorScope {
  /** Set by authenticated callers; absence is reserved for platform operations. */
  tenantId?: number;
  runId?: string | null;
  city?: string | null;
  state?: string | null;
}

function inspectorWhere(scope: InspectorScope, alias = ""): { sql: string; params: Record<string, string | number | null> } {
  const prefix = alias ? `${alias}.` : "";
  const clauses: string[] = [];
  if (scope.tenantId !== undefined) clauses.push(`EXISTS (SELECT 1 FROM scan_runs sr WHERE sr.id = ${prefix || "scan_events."}run_id AND sr.tenant_id = @tenantId)`);
  if (scope.runId) clauses.push(`${prefix}run_id = @runId`);
  if (scope.city) clauses.push(`lower(trim(${prefix}city)) = lower(trim(@city))`);
  if (scope.state) clauses.push(`upper(trim(${prefix}state)) = upper(trim(@state))`);
  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params: {
      tenantId: scope.tenantId ?? null,
      runId: scope.runId ?? null,
      city: scope.city ?? null,
      state: scope.state ?? null,
    },
  };
}

export function getInspectorSnapshot(opts: { limit?: number } & InspectorScope = {}): {
  rows: InspectorRow[]; counters: InspectorCounters; sessionRotations: number | null;
} {
  ensureSchema();
  // Include any buffered-but-not-yet-flushed events so the inspector is accurate to
  // the moment it's read (the timer flush is up to FLUSH_MS behind).
  if (BATCH_ENABLED && _buf.length) { try { flushScanEvents(); } catch { /* best-effort */ } }
  const limit = Math.min(500, Math.max(10, opts.limit ?? 200));
  // Latest event per address, optionally scoped to one run or market. Market
  // filtering happens in SQL (and again on the live SSE relay) so an operator
  // looking at Concord never receives or counts rows from another city.
  const where = inspectorWhere(opts);
  const latest = rawDb.prepare(`
    SELECT e.*, m.first_seen FROM scan_events e
    JOIN (
      SELECT address_key, MAX(id) AS mid, MIN(ts_epoch) AS first_seen FROM scan_events ${where.sql} GROUP BY address_key
    ) m ON m.mid = e.id
    ORDER BY e.id DESC
    LIMIT @limit
  `).all({ limit, ...where.params }) as any[];

  // The same scoped aggregate supplies first-seen time. This removes one query
  // per returned address and prevents another tenant's matching key leaking time.
  const rows: InspectorRow[] = latest.map((e) => {
    return {
      addressKey: e.address_key,
      address: e.address, city: e.city, state: e.state, zip: e.zip,
      runId: e.run_id, source: e.source,
      stage: e.stage, status: e.status,
      attempt: e.attempt, httpStatus: e.http_status, latencyMs: e.latency_ms,
      sessionId: e.session_id, tokenSuffix: e.token_suffix,
      retryReason: e.retry_reason, classification: e.classification, detail: e.detail,
      startedAt: e.first_seen ?? e.ts_epoch, updatedAt: e.ts_epoch,
    };
  });

  const counters: InspectorCounters = {
    found: rows.length, checked: 0, queued: 0, checking: 0, retrying: 0, unresolved: 0,
    newNow: 0, newlyLit: 0, stillFresh: 0, comingSoon: 0,
  };
  for (const r of rows) {
    counters[bucketOf(r.stage)]++;
    const c = (r.classification ?? "").toLowerCase();
    if (c === "fresh_fiber" || c === "new") counters.newNow++;
    else if (c === "newly_lit") counters.newlyLit++;
    else if (c === "still_fresh") counters.stillFresh++;
    else if (c === "coming_soon") counters.comingSoon++;
  }
  return { rows, counters, sessionRotations: null };
}

export function getAddressTimeline(addressKey: string, limit = 60, scope: InspectorScope = {}): Array<ScanStageEvent & { id: number }> {
  ensureSchema();
  // Match getInspectorSnapshot's freshness guarantee. An operator commonly
  // expands a row immediately after its terminal SSE event; without this flush,
  // the timeline endpoint can omit the last buffered Saving/Classified stages
  // for up to FLUSH_MS and appear to contradict the live row.
  if (BATCH_ENABLED && _buf.length) { try { flushScanEvents(); } catch { /* best-effort */ } }
  const where = inspectorWhere(scope);
  const rows = rawDb.prepare(
    `SELECT * FROM scan_events ${where.sql}${where.sql ? " AND" : " WHERE"} address_key = @addressKey ORDER BY id ASC LIMIT @limit`,
  ).all({ ...where.params, addressKey, limit: Math.max(1, Math.min(200, limit)) }) as any[];
  return rows.map((e) => ({
    id: e.id, addressKey: e.address_key, address: e.address, city: e.city, state: e.state, zip: e.zip,
    runId: e.run_id, source: e.source, stage: e.stage, status: e.status, attempt: e.attempt,
    httpStatus: e.http_status, latencyMs: e.latency_ms, sessionId: e.session_id, tokenSuffix: e.token_suffix,
    retryReason: e.retry_reason, classification: e.classification, detail: e.detail, tsEpoch: e.ts_epoch,
  }));
}
