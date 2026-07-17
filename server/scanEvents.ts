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
import { onStage, type ScanStageEvent, type ScanStage } from "./scanStageBus";
import { EventEmitter } from "node:events";

const MAX_EVENTS = Math.max(500, Number(process.env.SCAN_EVENTS_MAX ?? 4000));
const PRUNE_EVERY = 200;

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
  _ready = true;
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
    let id: number | null = null;
    try { id = persist(evt); } catch { /* swallow — never break a scan */ }
    relay.emit("event", { id, ...evt });
  });
}

/** In-process subscription for the SSE endpoint. Returns an unsubscribe fn. */
export function onScanEvent(cb: (evt: ScanStageEvent & { id: number | null }) => void): () => void {
  relay.on("event", cb);
  return () => relay.off("event", cb);
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

export function getInspectorSnapshot(opts: { limit?: number; runId?: string | null } = {}): {
  rows: InspectorRow[]; counters: InspectorCounters; sessionRotations: number | null;
} {
  ensureSchema();
  const limit = Math.min(500, Math.max(10, opts.limit ?? 200));
  // Latest event per address (optionally scoped to a run), newest first.
  const where = opts.runId ? `WHERE run_id = @runId` : ``;
  const latest = rawDb.prepare(`
    SELECT e.* FROM scan_events e
    JOIN (
      SELECT address_key, MAX(id) AS mid FROM scan_events ${where} GROUP BY address_key
    ) m ON m.mid = e.id
    ORDER BY e.id DESC
    LIMIT @limit
  `).all({ limit, runId: opts.runId ?? null }) as any[];

  // First-seen ts per address (for "started at" + duration).
  const rows: InspectorRow[] = latest.map((e) => {
    const first = rawDb.prepare(
      `SELECT MIN(ts_epoch) f FROM scan_events WHERE address_key = ?`,
    ).get(e.address_key) as { f: number };
    return {
      addressKey: e.address_key,
      address: e.address, city: e.city, state: e.state, zip: e.zip,
      runId: e.run_id, source: e.source,
      stage: e.stage, status: e.status,
      attempt: e.attempt, httpStatus: e.http_status, latencyMs: e.latency_ms,
      sessionId: e.session_id, tokenSuffix: e.token_suffix,
      retryReason: e.retry_reason, classification: e.classification, detail: e.detail,
      startedAt: first?.f ?? e.ts_epoch, updatedAt: e.ts_epoch,
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

export function getAddressTimeline(addressKey: string, limit = 60): Array<ScanStageEvent & { id: number }> {
  ensureSchema();
  const rows = rawDb.prepare(
    `SELECT * FROM scan_events WHERE address_key = ? ORDER BY id ASC LIMIT ?`,
  ).all(addressKey, Math.min(200, limit)) as any[];
  return rows.map((e) => ({
    id: e.id, addressKey: e.address_key, address: e.address, city: e.city, state: e.state, zip: e.zip,
    runId: e.run_id, source: e.source, stage: e.stage, status: e.status, attempt: e.attempt,
    httpStatus: e.http_status, latencyMs: e.latency_ms, sessionId: e.session_id, tokenSuffix: e.token_suffix,
    retryReason: e.retry_reason, classification: e.classification, detail: e.detail, tsEpoch: e.ts_epoch,
  }));
}
