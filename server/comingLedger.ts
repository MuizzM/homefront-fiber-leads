// ── The coming ledger: doors the provider says will turn on later ────────────
//
// Under the once-only law (@shared/scanPolicy) an answered address is never
// bought again. This ledger holds the single exception: an address the PROVIDER
// itself said would be serviceable later is re-bought exactly once, at its due
// date. That is not a blind re-scan, it is collecting on a stated promise.
//
// It extends the existing `coming_soon_watchlist` rather than adding a third
// coming-soon table (there are already two: `coming_soon_watch` from the legacy
// program and `coming_soon_watchlist` from the snapshot choke point). What is
// new is that the promise is now READ and STORED with its provenance:
//
//   promised_date   the date the provider stated, YYYY-MM-DD
//   date_source     'provider' when the payload said it; 'inventory' when it
//                   came from kinetic_addresses; never invented
//   date_path       the exact payload path it was read from, e.g.
//                   'futureServiceDate' - so an operator can audit the claim
//   provider_quote  the provider's own words that triggered the verdict
//   signals         machine-readable reasons (build_pending, provider_date, ...)
//
// Measured 2026-08-22 over all 22,242 stored provider bodies
// (fiber_checks.result): BOTH carriers state future service and we discarded
// every word of it. Kinetic sends broadbandService.{futureQual,
// futureTechnologyType, estimatedCompletionDt} - 476 NC doors with a real month
// (Harrisburg FEB-2027, Indian Trail MAR-2027, Monroe NOV-2026, ...) plus 488
// carrying the undated sentinel "Future Fiber Build Planned". Frontier sends
// fiberBuildOutStatus / isFutureFiberEligible / futureServiceDate - 168 pending
// builds, 164 dated. See shared/futureService.ts for the field-by-field proof.
//
// This module owns membership and scheduling only. It never calls the provider,
// never creates a lead (the projector owns that) and never classifies - the
// classification comes from shared/futureService.ts so one vocabulary serves
// the parser, the ledger and the UI.
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";
import { anfParkedSql } from "@shared/scanPolicy";
import { nextRecheckAt, readFutureService, type FutureServiceInput, type FutureServiceRead } from "@shared/futureService";

const HOUR_MS = 3_600_000;

function bounded(v: string | undefined, dflt: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}

export const LEDGER_CFG = {
  /** Cadences mirror the existing watchlist engine so behaviour is unsurprising. */
  hotHours: () => bounded(process.env.COMING_SOON_HOT_HOURS, 6, 1, 168),
  soonHours: () => bounded(process.env.COMING_SOON_CONSTRUCTION_HOURS, 12, 1, 336),
  watchHours: () => bounded(process.env.COMING_SOON_WATCH_HOURS, 24, 1, 720),
  hotWindowDays: () => bounded(process.env.COMING_SOON_HOT_WINDOW_DAYS, 14, 1, 120),
  flipFromDays: () => bounded(process.env.COMING_SOON_FLIP_WINDOW_FROM_DAYS, 2, 0, 120),
  flipToDays: () => bounded(process.env.COMING_SOON_FLIP_WINDOW_TO_DAYS, 14, 1, 365),
  /** A promise nobody honoured this long is cold: parked, never silently dropped. */
  expireDays: () => bounded(process.env.COMING_SOON_EXPIRE_DAYS, 90, 7, 3650),
  /** Re-read cadence for an UNDATED promise ("Future Fiber Build Planned"). */
  undatedDays: () => bounded(process.env.COMING_LEDGER_UNDATED_DAYS, 30, 1, 365),
  /** Collections allowed AFTER a promised date has passed before the promise is
   *  written off. Without a cap a provider that keeps restating a stale month is
   *  re-bought on the hot cadence forever - which is the once-only law's own
   *  exception eating the law. */
  overdueGraceChecks: () => bounded(process.env.COMING_LEDGER_OVERDUE_CHECKS, 4, 1, 100),
  /** Hard cap on how many promises one cycle may collect on. */
  perCycle: () => bounded(process.env.COMING_LEDGER_PER_CYCLE, 300, 0, 20_000),
};

let ready = false;
/** Additive, forward-only columns on the existing watchlist. */
export function ensureComingLedgerSchema(): void {
  if (ready) return;
  const cols = new Set((rawDb.prepare(`PRAGMA table_info(coming_soon_watchlist)`).all() as Array<{ name: string }>).map((c) => c.name));
  if (cols.size === 0) { ready = false; return; } // table not created yet; the snapshot path makes it
  const add = (name: string, decl: string) => {
    if (cols.has(name)) return;
    try { rawDb.exec(`ALTER TABLE coming_soon_watchlist ADD COLUMN ${name} ${decl}`); } catch { /* concurrent boot */ }
  };
  add("promised_date", "TEXT");
  add("date_source", "TEXT");
  add("date_path", "TEXT");
  add("provider_quote", "TEXT");
  add("signals", "TEXT NOT NULL DEFAULT '[]'");
  add("band", "TEXT");
  add("due_at", "INTEGER");
  // Collections made after the promised date passed; drives the write-off.
  add("overdue_checks", "INTEGER NOT NULL DEFAULT 0");
  try { rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_coming_due_at ON coming_soon_watchlist(tenant_id, status, due_at)`); } catch { /* exists */ }
  ready = true;
}

export interface LedgerTarget { id: number; address: string; city: string; state: string; zip?: string | null; source?: string | null }

/**
 * Record what one conclusive answer said about future service.
 *
 * - a future promise opens (or refreshes) an active ledger row with its date;
 * - an answer that is now-active, or live, or simply settled CLOSES any open
 *   row, so a door we lost stops consuming the one re-check lane. This is the
 *   fix for the 294 "coming soon" rows that were really already-sold doors.
 */
export function recordFutureService(
  tenantId: number,
  target: LedgerTarget,
  parsed: FutureServiceInput,
  raw: unknown,
  opts: { fiberAvailable?: boolean | null; nowMs?: number; log?: boolean; observedAt?: number } = {},
): FutureServiceRead {
  ensureComingLedgerSchema();
  const nowMs = opts.nowMs ?? Date.now();
  const read = readFutureService(parsed, raw);

  if (!ready) return read;

  if (!read.isFuture) {
    // Settled, active, or lost: close the promise rather than leaving it to be
    // re-bought forever. `promoted` when fiber actually arrived, else `closed`.
    const status = opts.fiberAvailable === true ? "promoted" : read.isNowActive ? "now_active" : "closed";
    rawDb.prepare(
      `UPDATE coming_soon_watchlist SET status=?, last_checked_at=?, updated_at=?, due_at=NULL
        WHERE tenant_id=? AND scan_target_id=? AND status='active'`,
    ).run(status, nowMs, nowMs, tenantId, target.id);
    return read;
  }

  const prior = rawDb.prepare(
    `SELECT first_seen_at, last_checked_at, overdue_checks FROM coming_soon_watchlist WHERE tenant_id=? AND scan_target_id=?`,
  ).get(tenantId, target.id) as { first_seen_at: number; last_checked_at: number | null; overdue_checks?: number } | undefined;
  // WHEN WE FOUND IT, not when we wrote the row. The backfill replays answers
  // from July, so stamping "now" would claim we discovered every promise today
  // and would put month-old finds inside the 2-14 day flip window.
  const observedMs = opts.observedAt ?? nowMs;
  const firstSeenMs = Math.min(prior?.first_seen_at ?? observedMs, observedMs);

  // A promise whose own date has passed and which the provider keeps restating
  // is not going to be honoured. Count those collections and write the row off
  // at the cap, so the one lane allowed to re-buy an answered door cannot spin
  // on it forever. Undated promises are not counted: they never claimed a date.
  const promisedMs = read.promisedDate ? Date.parse(`${read.promisedDate}T00:00:00Z`) : NaN;
  const isOverdue = Number.isFinite(promisedMs) && promisedMs <= nowMs;
  const overdueChecks = (Number(prior?.overdue_checks ?? 0) || 0) + (isOverdue ? 1 : 0);
  if (isOverdue && overdueChecks > LEDGER_CFG.overdueGraceChecks()) {
    rawDb.prepare(
      `UPDATE coming_soon_watchlist SET status='overdue', updated_at=?, due_at=NULL, overdue_checks=?
        WHERE tenant_id=? AND scan_target_id=?`,
    ).run(nowMs, overdueChecks, tenantId, target.id);
    if (opts.log !== false) {
      structuredLog("coming_ledger.written_off", {
        tenantId, targetId: target.id, promisedDate: read.promisedDate, checksAfterDate: overdueChecks,
      }, "warn");
    }
    return read;
  }
  const sched = nextRecheckAt({
    promisedDate: read.promisedDate, firstSeenMs, lastCheckedMs: observedMs,
    hotHours: LEDGER_CFG.hotHours(), soonHours: LEDGER_CFG.soonHours(), watchHours: LEDGER_CFG.watchHours(),
    hotWindowDays: LEDGER_CFG.hotWindowDays(), flipFromDays: LEDGER_CFG.flipFromDays(), flipToDays: LEDGER_CFG.flipToDays(),
    undatedDays: LEDGER_CFG.undatedDays(),
  }, nowMs);

  rawDb.prepare(
    `INSERT INTO coming_soon_watchlist
       (tenant_id, scan_target_id, address_key, first_seen_at, last_checked_at, estimated_completion,
        source, confidence, cluster_id, status, created_at, updated_at,
        promised_date, date_source, date_path, provider_quote, signals, band, due_at, overdue_checks)
     VALUES (@tenant, @target, @key, @firstSeen, @observed, @date, @source, @confidence, NULL, 'active', @now, @now,
             @date, @dateSource, @datePath, @quote, @signals, @band, @dueAt, @overdueChecks)
     ON CONFLICT(scan_target_id) DO UPDATE SET
       status          = 'active',
       first_seen_at   = MIN(coming_soon_watchlist.first_seen_at, @firstSeen),
       last_checked_at = @observed,
       updated_at      = @now,
       -- a stated date always wins over an absent one; never overwrite a
       -- provider date with a null on a later, vaguer answer
       promised_date        = COALESCE(@date, coming_soon_watchlist.promised_date),
       estimated_completion = COALESCE(@date, coming_soon_watchlist.estimated_completion),
       date_source          = COALESCE(@dateSource, coming_soon_watchlist.date_source),
       date_path            = COALESCE(@datePath, coming_soon_watchlist.date_path),
       provider_quote       = COALESCE(@quote, coming_soon_watchlist.provider_quote),
       signals              = @signals,
       band                 = @band,
       due_at               = @dueAt,
       overdue_checks       = @overdueChecks`,
  ).run({
    tenant: tenantId, target: target.id,
    key: `${String(target.address).trim().toLowerCase()}|${String(target.city).trim().toLowerCase()}|${String(target.state).trim().toUpperCase()}`,
    now: nowMs, firstSeen: firstSeenMs, observed: observedMs,
    date: read.promisedDate, dateSource: read.dateSource, datePath: read.datePath,
    quote: read.quote, signals: JSON.stringify(read.signals), band: sched.band, dueAt: sched.dueAtMs,
    overdueChecks: overdueChecks,
    source: target.source ?? "provider-answer",
    confidence: read.promisedDate ? "dated" : read.signals.includes("build_pending") ? "high" : "medium",
  });

  if (opts.log !== false) structuredLog("coming_ledger.recorded", {
    tenantId, targetId: target.id, city: target.city, promisedDate: read.promisedDate,
    dateSource: read.dateSource, datePath: read.datePath, band: sched.band, reason: sched.reason,
    signals: read.signals.join(","),
  });
  return read;
}

/**
 * One-shot correction for rows written by the old inference: a watch whose
 * target is NEW FIBER with an ACTIVE billing account was never "coming soon",
 * it was a door somebody already bought. Closing them stops the dedup-exempt
 * recheck lane re-buying sold doors. Idempotent and cheap; safe every cycle.
 */
export function reconcileNowActiveWatches(tenantId: number, nowMs = Date.now()): number {
  ensureComingLedgerSchema();
  if (!ready) return 0;
  // A promise is never closed by this rule. server/frontierScanner.ts encodes a
  // Frontier future build as isNewFiber=1 + billing 'Y' - the exact shape of a
  // sold Kinetic door - so closing on billing alone would discard every dated
  // Frontier build (86 doors) along with the mislabelled ones.
  // Driven from the watchlist (about a thousand rows) with a primary-key lookup
  // per target. The `IN (SELECT ... FROM scan_targets WHERE last_is_new_fiber=1
  // ...)` shape scanned all 919k targets on columns with no index: measured
  // 207 ms as a SELECT and 2,476 ms as the UPDATE, every single cycle. Same
  // result in 1 ms.
  const n = rawDb.prepare(
    `UPDATE coming_soon_watchlist SET status='now_active', updated_at=?, due_at=NULL
      WHERE tenant_id=? AND status='active'
        AND promised_date IS NULL
        AND COALESCE(signals,'[]') NOT LIKE '%build_pending%'
        AND COALESCE(signals,'[]') NOT LIKE '%future_qual%'
        AND COALESCE(signals,'[]') NOT LIKE '%provider_future_eligible%'
        AND EXISTS (SELECT 1 FROM scan_targets s
                     WHERE s.id = coming_soon_watchlist.scan_target_id
                       AND s.last_is_new_fiber=1
                       AND upper(COALESCE(s.last_billing_status,'')) IN ('Y','A'))`,
  ).run(nowMs, tenantId).changes;
  if (n) structuredLog("coming_ledger.reconciled_now_active", { tenantId, closed: n }, "warn");
  return n;
}

/** Park promises nobody honoured inside the expiry window. */
export function expireStaleWatches(tenantId: number, nowMs = Date.now()): number {
  ensureComingLedgerSchema();
  if (!ready) return 0;
  const cut = nowMs - LEDGER_CFG.expireDays() * 24 * HOUR_MS;
  const cutDay = new Date(cut).toISOString().slice(0, 10);
  // Staleness is measured against the PROMISE, never against updated_at: the
  // ledger re-stamps updated_at on every collection, so an actively re-checked
  // row could never reach the cut and nothing dated ever expired. Equally, a
  // FEB-2027 build is deliberately left untouched until Jan 2027, so an
  // "untouched for 90 days" rule would have killed it in November.
  //
  //   dated   -> cold once its own date is more than expireDays in the past
  //              (the overdue write-off above usually gets there first)
  //   undated -> cold once we FIRST SAW it that long ago and it never landed
  return rawDb.prepare(
    `UPDATE coming_soon_watchlist SET status='expired', updated_at=?, due_at=NULL
      WHERE tenant_id=? AND status='active'
        AND CASE WHEN promised_date IS NOT NULL THEN promised_date < ?
                 ELSE first_seen_at < ? END`,
  ).run(nowMs, tenantId, cutDay, cut).changes;
}

export interface DueComingRow {
  targetId: number; promisedDate: string | null; band: string | null; city: string; address: string;
  /** When the provider first told us it was coming (epoch ms). */
  firstSeenAt: number | null;
  lastCheckedAt: number | null;
}

/**
 * Promises that have come due. Ordered by the strength of the promise: a date
 * that has already passed first (they said it would be on by now), then the
 * hot band, then everything else oldest-first.
 */
export function dueComingTargets(tenantId: number, state: string, limit: number, nowMs = Date.now()): DueComingRow[] {
  ensureComingLedgerSchema();
  if (!ready || limit <= 0) return [];
  const today = new Date(nowMs).toISOString().slice(0, 10);
  return rawDb.prepare(
    `SELECT w.scan_target_id AS targetId, w.promised_date AS promisedDate, w.band AS band,
            w.first_seen_at AS firstSeenAt, w.last_checked_at AS lastCheckedAt,
            s.city AS city, s.address AS address
       FROM coming_soon_watchlist w JOIN scan_targets s ON s.id = w.scan_target_id
      WHERE w.tenant_id=? AND w.status='active' AND s.state=?
        AND (w.due_at IS NULL OR w.due_at <= ?)
        -- a door Kinetic's fabric keeps rejecting leaves the lane like any other
        AND NOT ${anfParkedSql("s", 14)}
        AND NOT EXISTS (SELECT 1 FROM scan_run_targets t JOIN scan_runs r ON r.id=t.run_id
                         WHERE t.target_id=s.id AND t.state IN ('queued','inflight') AND r.status='running')
      ORDER BY CASE WHEN w.promised_date IS NOT NULL AND w.promised_date <= ? THEN 0
                    WHEN w.band='hot' THEN 1 WHEN w.band='soon' THEN 2 ELSE 3 END ASC,
               w.promised_date ASC, w.due_at ASC
      LIMIT ?`,
  ).all(tenantId, state, nowMs, today, limit) as DueComingRow[];
}

/** Push the next due date out after a collection attempt, so one promise is
 *  never bought twice in a cycle even if the answer stays inconclusive. */
export function markComingChecked(tenantId: number, targetIds: number[], nowMs = Date.now()): void {
  ensureComingLedgerSchema();
  if (!ready || !targetIds.length) return;
  // Re-due each row on ITS OWN band. A flat hot-cadence bump pulled every
  // collected promise - including a 2027 build and a 30-day undated re-read -
  // back into the lane a few hours later.
  const read = rawDb.prepare(
    `SELECT promised_date AS promisedDate, first_seen_at AS firstSeenAt FROM coming_soon_watchlist
      WHERE tenant_id=? AND scan_target_id=?`);
  const stmt = rawDb.prepare(
    `UPDATE coming_soon_watchlist SET last_checked_at=?, due_at=?, band=? WHERE tenant_id=? AND scan_target_id=?`);
  const cfg = {
    hotHours: LEDGER_CFG.hotHours(), soonHours: LEDGER_CFG.soonHours(), watchHours: LEDGER_CFG.watchHours(),
    hotWindowDays: LEDGER_CFG.hotWindowDays(), flipFromDays: LEDGER_CFG.flipFromDays(),
    flipToDays: LEDGER_CFG.flipToDays(), undatedDays: LEDGER_CFG.undatedDays(),
  };
  const tx = rawDb.transaction((ids: number[]) => {
    for (const id of ids) {
      const row = read.get(tenantId, id) as { promisedDate: string | null; firstSeenAt: number | null } | undefined;
      const sched = nextRecheckAt({
        ...cfg, promisedDate: row?.promisedDate ?? null,
        firstSeenMs: row?.firstSeenAt ?? nowMs, lastCheckedMs: nowMs,
      }, nowMs);
      stmt.run(nowMs, sched.dueAtMs, sched.band, tenantId, id);
    }
  });
  tx.immediate(targetIds);
}

/**
 * BACKFILL: mine promises out of evidence we have already paid for.
 *
 * `fiber_checks.result` holds the provider body for every check ever made
 * (22,242 in the production-shaped copy). Because nothing ever read the future
 * fields, ~964 NC doors that the provider told us were coming - 476 with a
 * stated month - are sitting in that table invisible. This turns them into
 * ledger rows for zero provider spend.
 *
 * Bounded, idempotent (the upsert is keyed on scan_target_id), and it only ever
 * considers the LATEST body per address so a stale promise cannot overwrite a
 * newer settled answer.
 */
export function backfillFromStoredEvidence(tenantId: number, limit = 5000, nowMs = Date.now()): { scanned: number; recorded: number; dated: number } {
  ensureComingLedgerSchema();
  if (!ready) return { scanned: 0, recorded: 0, dated: 0 };
  let candidates: Array<{ address: string; result: string; checkedAt: string }>;
  try {
    // A cheap LIKE prefilter first: json_extract over every stored body is far
    // too slow (22,242 rows), while the text scan narrows to ~4,900 in 70 ms.
    // LIMIT is pushed into SQL and the rows are streamed: `.all()` materialised
    // every matching body (14,145 rows, tens of MB of JSON) into one array
    // before the caller's limit could bound anything.
    candidates = [];
    for (const row of (rawDb.prepare(
      `SELECT address, result, checked_at AS checkedAt
         FROM fiber_checks
        WHERE tenant_id=? AND result IS NOT NULL
          AND (result LIKE '%futureQual%' OR result LIKE '%futureServiceDate%'
            OR result LIKE '%estimatedCompletionDt%' OR result LIKE '%fiberBuildOutStatus%')
        ORDER BY checked_at ASC
        LIMIT ?`,
    ) as any).iterate(tenantId, Math.max(1, limit) * 20)) {
      candidates.push(row as any);
    }
  } catch (e: any) {
    structuredLog("coming_ledger.backfill_failed", { tenantId, error: String(e?.message ?? e).slice(0, 160) }, "warn");
    return { scanned: 0, recorded: 0, dated: 0 };
  }

  // Latest body per address wins, so a stale promise cannot overwrite a newer
  // settled answer. Ordered ascending above, so a later row simply replaces.
  const latest = new Map<string, { result: string; address: string; checkedAt: string }>();
  for (const c of candidates) {
    const key = String(c.address ?? "").trim().toLowerCase();
    if (key) latest.set(key, { result: c.result, address: String(c.address ?? ""), checkedAt: c.checkedAt });
  }

  // The (lower(trim(address)), lower(trim(city)), upper(trim(state))) expression
  // index makes this a point lookup per row rather than a scan per row.
  const findTarget = rawDb.prepare(
    `SELECT id, address, city, state, zip, source FROM scan_targets
      WHERE lower(trim(address))=? AND lower(trim(city))=? AND upper(trim(state))=? AND tenant_id=? LIMIT 1`);

  let scanned = 0, recorded = 0, dated = 0;
  for (const [, row] of latest) {
    if (scanned >= limit) break;
    let raw: any;
    try { raw = JSON.parse(row.result); } catch { continue; }
    // fiber_checks.address is the FULL formatted string ("1155 Bell Ridge Ct,
    // Rockwell, NC 28138") while scan_targets.address is just the street line,
    // so match on the provider's echoed addressLine1 first and fall back to the
    // leading segment. Kinetic sometimes corrects the city (a Rockwell-labelled
    // row echoing CHINA GROVE), so try the echoed city and ours.
    const parts = String(row.address).split(",").map((x) => x.trim());
    const state = String(raw?.address?.stateProvinceCd ?? raw?.address?.state ?? "NC").trim().toUpperCase();
    const lines = [String(raw?.address?.addressLine1 ?? "").trim(), parts[0] ?? ""].filter(Boolean);
    const cities = [String(raw?.address?.city ?? "").trim(), parts[1] ?? ""].filter(Boolean);
    let t: any = null;
    for (const line of lines) {
      for (const city of cities) {
        t = findTarget.get(line.toLowerCase(), city.toLowerCase(), state, tenantId);
        if (t) break;
      }
      if (t) break;
    }
    if (!t) continue;
    scanned++;
    const read = recordFutureService(
      tenantId,
      { id: t.id, address: t.address, city: t.city, state: t.state, zip: t.zip, source: t.source },
      { householdSegmentType: raw?.address?.householdSegmentType, billingStatus: raw?.address?.billingStatus },
      raw,
      // observedAt is the date the provider actually said it, so "found on" is
      // truthful and the flip-window maths is not fooled into treating a July
      // answer as today's discovery.
      { nowMs, log: false, observedAt: parseSqlMs(row.checkedAt) ?? nowMs },
    );
    if (read.isFuture) { recorded++; if (read.promisedDate) dated++; }
  }
  structuredLog("coming_ledger.backfilled", { tenantId, scanned, recorded, dated });
  return { scanned, recorded, dated };
}

/** scan/lead timestamps are SQLite-format ("YYYY-MM-DD HH:MM:SS") or ISO. */
function parseSqlMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const s = String(value).trim();
  const t = Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : null;
}

export interface ComingSummary {
  active: number; dated: number; overdue: number; dueNow: number;
  byBand: Record<string, number>; byStatus: Record<string, number>;
  /** Promised turn-on months, soonest first. */
  nextDates: Array<{ date: string; doors: number }>;
  /** WHEN WE FOUND THEM, by day - the other half of the question: a promise
   *  found in July for a November build is a different thing from one found
   *  today, and the operator needs to see both dates. */
  foundOn: Array<{ day: string; doors: number; dated: number }>;
  oldestFoundAt: number | null;
  newestFoundAt: number | null;
}

export function comingSummary(tenantId: number, state: string, nowMs = Date.now()): ComingSummary {
  ensureComingLedgerSchema();
  const empty: ComingSummary = { active: 0, dated: 0, overdue: 0, dueNow: 0, byBand: {}, byStatus: {}, nextDates: [], foundOn: [], oldestFoundAt: null, newestFoundAt: null };
  if (!ready) return empty;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const base = `FROM coming_soon_watchlist w JOIN scan_targets s ON s.id=w.scan_target_id WHERE w.tenant_id=? AND s.state=?`;
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS active,
            SUM(w.promised_date IS NOT NULL) AS dated,
            SUM(w.promised_date IS NOT NULL AND w.promised_date <= ?) AS overdue,
            SUM(w.due_at IS NULL OR w.due_at <= ?) AS dueNow
       ${base} AND w.status='active'`,
  ).get(today, nowMs, tenantId, state) as any;
  const out: ComingSummary = {
    active: Number(row?.active ?? 0), dated: Number(row?.dated ?? 0),
    overdue: Number(row?.overdue ?? 0), dueNow: Number(row?.dueNow ?? 0),
    byBand: {}, byStatus: {}, nextDates: [], foundOn: [], oldestFoundAt: null, newestFoundAt: null,
  };
  for (const r of rawDb.prepare(`SELECT COALESCE(w.band,'none') AS k, COUNT(*) AS n ${base} AND w.status='active' GROUP BY 1`).all(tenantId, state) as any[]) out.byBand[r.k] = r.n;
  for (const r of rawDb.prepare(`SELECT w.status AS k, COUNT(*) AS n ${base} GROUP BY 1`).all(tenantId, state) as any[]) out.byStatus[r.k] = r.n;
  const span = rawDb.prepare(`SELECT MIN(w.first_seen_at) AS oldest, MAX(w.first_seen_at) AS newest ${base} AND w.status='active'`).get(tenantId, state) as any;
  out.oldestFoundAt = span?.oldest ?? null;
  out.newestFoundAt = span?.newest ?? null;
  out.foundOn = (rawDb.prepare(
    `SELECT date(w.first_seen_at/1000, 'unixepoch') AS day, COUNT(*) AS doors,
            SUM(w.promised_date IS NOT NULL) AS dated
       ${base} AND w.status='active' AND w.first_seen_at IS NOT NULL
      GROUP BY 1 ORDER BY 1 DESC LIMIT 14`).all(tenantId, state) as any[])
    .map((r) => ({ day: r.day, doors: r.doors, dated: r.dated ?? 0 }));
  out.nextDates = (rawDb.prepare(
    `SELECT w.promised_date AS date, COUNT(*) AS doors ${base} AND w.status='active' AND w.promised_date IS NOT NULL
      GROUP BY 1 ORDER BY 1 ASC LIMIT 12`).all(tenantId, state) as any[]).map((r) => ({ date: r.date, doors: r.doors }));
  return out;
}
