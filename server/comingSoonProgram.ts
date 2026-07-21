// ── Coming Soon Program — opportunity metadata + promotion surface ────────────
// Every COMING_SOON signal the Kinetic search path returns (NEW FIBER segment
// with billing still active) lands here with coordinates, first/last seen,
// source, expected completion date (when known), confidence, and an
// OPPORTUNITY SCORE (ETA proximity + nearby fresh-lead cluster heat) that
// orders the /api/coming-soon/program board.
//
// SCHEDULING LIVES ELSEWHERE: the comingSoonWatchlist engine is the sole
// dispatcher of coming-soon rechecks (governor-paced, urgency cadences, queued-
// target dedup). This worker used to dispatch its own recheck runs off a
// private next_check_at clock the rest of the system never updated — every
// dispatch was a potential duplicate of a watchlist-tick check. It now only:
//   1. BRIDGES any watching row missing from the canonical coming_soon_watchlist
//      (rows predating the watchlist, or whose target was never re-observed)
//      so every watch is scheduled by exactly one engine, and
//   2. Detects PROMOTIONS (watch address became a confirmed fresh lead — the
//      lead/pin/expansion already happened in the scan pipeline) and refreshes
//      opportunity scores for the board.
import crypto from "node:crypto";
import { rawDb } from "./db";
import { storage } from "./storage";
import { structuredLog } from "./structuredLog";
import { normalizeKineticAddressKey } from "./addressKey";

export type WatchStatus = "watching" | "promoted" | "retired";

export interface ComingSoonWatchRow {
  id: number;
  address: string;
  city: string;
  state: string;
  zip: string;
  lat: number | null;
  lng: number | null;
  source: string;
  firstSeenAt: string;
  lastSeenAt: string;
  expectedCompletionAt: string | null;
  confidence: string;
  opportunityScore: number;
  nextCheckAt: string;
  status: WatchStatus;
  promotedLeadId: number | null;
  checks: number;
}

let schemaReady = false;
export function ensureComingSoonSchema(): void {
  if (schemaReady) return;
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS coming_soon_watch (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      watch_key TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      zip TEXT NOT NULL DEFAULT '',
      lat REAL, lng REAL,
      source TEXT NOT NULL DEFAULT 'kinetic-search',
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      expected_completion_at TEXT,
      confidence TEXT NOT NULL DEFAULT 'provider',
      opportunity_score INTEGER NOT NULL DEFAULT 50,
      next_check_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'watching',
      promoted_lead_id INTEGER,
      promoted_at TEXT,
      checks INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, watch_key)
    );
    CREATE INDEX IF NOT EXISTS idx_csw_due ON coming_soon_watch(status, next_check_at);
    CREATE INDEX IF NOT EXISTS idx_csw_geo ON coming_soon_watch(tenant_id, state, city);
  `);
  schemaReady = true;
}

function watchKey(address: string, city: string, state: string, zip: string): string {
  return crypto.createHash("sha256")
    .update(`${address}|${city}|${state}|${zip}`.toLowerCase().replace(/\s+/g, " ").trim())
    .digest("hex").slice(0, 32);
}

// Opportunity weight: how soon this address is likely to light up.
//  • expected completion ≤ 7d (or overdue) → 100, recheck every 6h
//  • ≤ 30d → 85, daily
//  • ≤ 90d → 65, every 3 days
//  • no date / later → 50, weekly
export function opportunityFor(expectedCompletionAt: string | null, nearbyFresh: number): { score: number; cadenceHours: number } {
  let score = 50, cadenceHours = 168;
  if (expectedCompletionAt) {
    const days = (Date.parse(expectedCompletionAt) - Date.now()) / 86_400_000;
    if (days <= 7) { score = 100; cadenceHours = 6; }
    else if (days <= 30) { score = 85; cadenceHours = 24; }
    else if (days <= 90) { score = 65; cadenceHours = 72; }
  }
  // Cluster heat: fresh leads already lighting nearby pull the watch forward.
  if (nearbyFresh > 0) {
    score = Math.min(100, score + Math.min(15, nearbyFresh * 3));
    cadenceHours = Math.max(6, Math.floor(cadenceHours / 2));
  }
  return { score, cadenceHours };
}

function countNearbyFresh(tenantId: number, lat: number | null, lng: number | null): number {
  if (lat == null || lng == null) return 0;
  try {
    return Number((rawDb.prepare(
      `SELECT COUNT(*) n FROM scan_targets
       WHERE tenant_id=? AND first_seen_fiber_at >= datetime('now','-30 days')
         AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
    ).get(tenantId, lat - 0.02, lat + 0.02, lng - 0.02, lng + 0.02) as any)?.n ?? 0);
  } catch { return 0; }
}

/** Add (or refresh) a COMING_SOON address on the durable watchlist. Idempotent. */
export function watchComingSoon(tenantId: number, input: {
  address: string; city: string; state: string; zip: string;
  lat?: number | null; lng?: number | null;
  source?: string; expectedCompletionAt?: string | null; confidence?: string;
}): void {
  ensureComingSoonSchema();
  const key = watchKey(input.address, input.city, input.state, input.zip);
  const nearby = countNearbyFresh(tenantId, input.lat ?? null, input.lng ?? null);
  const { score, cadenceHours } = opportunityFor(input.expectedCompletionAt ?? null, nearby);
  rawDb.prepare(`INSERT INTO coming_soon_watch
    (tenant_id,watch_key,address,city,state,zip,lat,lng,source,expected_completion_at,confidence,opportunity_score,next_check_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now', ?))
    ON CONFLICT(tenant_id,watch_key) DO UPDATE SET
      last_seen_at=datetime('now'),
      expected_completion_at=COALESCE(excluded.expected_completion_at, coming_soon_watch.expected_completion_at),
      lat=COALESCE(excluded.lat, coming_soon_watch.lat), lng=COALESCE(excluded.lng, coming_soon_watch.lng),
      opportunity_score=excluded.opportunity_score,
      next_check_at=CASE WHEN coming_soon_watch.status='watching' THEN excluded.next_check_at ELSE coming_soon_watch.next_check_at END,
      updated_at=datetime('now')`)
    .run(tenantId, key, input.address, input.city, input.state, input.zip ?? "",
      input.lat ?? null, input.lng ?? null, input.source ?? "kinetic-search",
      input.expectedCompletionAt ?? null, input.confidence ?? "provider", score,
      `+${cadenceHours} hours`);
}

// Legacy first_seen_at is TEXT `datetime('now')` (UTC, no zone marker).
function epochOf(value: string | null | undefined): number {
  if (!value) return Date.now();
  const t = Date.parse(String(value).includes("T") ? String(value) : `${String(value).replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : Date.now();
}

/** Bridge watching rows into the canonical coming_soon_watchlist so the
 * watchlist engine schedules them. Idempotent and self-quenching: once a row's
 * target has a watchlist entry it no longer matches. last_checked_at is NULL so
 * a bridged watch is immediately due for its first engine-owned recheck. */
export function bridgeLegacyWatches(tenantId: number, limit = 500): number {
  // The canonical watchlist is created by recordAvailabilitySnapshot's schema
  // pass; in a DB with no conclusive scan yet there is nothing to bridge into.
  if (!rawDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='coming_soon_watchlist'`).get()) return 0;
  const unbridged = rawDb.prepare(
    `SELECT w.* FROM coming_soon_watch w
      WHERE w.tenant_id=? AND w.status='watching'
        AND NOT EXISTS (
          SELECT 1 FROM scan_targets t
            JOIN coming_soon_watchlist cw ON cw.scan_target_id = t.id
           WHERE t.tenant_id = w.tenant_id AND lower(t.address)=lower(w.address)
             AND lower(t.city)=lower(w.city) AND t.state=w.state)
      LIMIT ?`,
  ).all(tenantId, limit) as any[];
  if (!unbridged.length) return 0;
  storage.upsertScanTargets(unbridged.map((row) => ({
    tenantId, address: row.address, city: row.city, state: row.state, zip: row.zip,
    lat: row.lat, lng: row.lng, source: "coming-soon-watch",
  } as any)));
  const lookup = rawDb.prepare(
    `SELECT id FROM scan_targets WHERE tenant_id=? AND lower(address)=lower(?) AND lower(city)=lower(?) AND state=? LIMIT 1`,
  );
  const insert = rawDb.prepare(
    `INSERT OR IGNORE INTO coming_soon_watchlist
       (tenant_id, scan_target_id, address_key, first_seen_at, last_checked_at,
        estimated_completion, source, confidence, cluster_id, status, created_at, updated_at)
     VALUES (?,?,?,?,NULL,?,?,?,NULL,'active',?,?)`,
  );
  let bridged = 0;
  rawDb.transaction(() => {
    const now = Date.now();
    for (const row of unbridged) {
      const t = lookup.get(tenantId, row.address, row.city, row.state) as any;
      if (!t?.id) continue;
      bridged += insert.run(
        tenantId, Number(t.id),
        normalizeKineticAddressKey(row.address, row.city, row.state, row.zip ?? ""),
        epochOf(row.first_seen_at), row.expected_completion_at ?? null,
        row.source ?? "coming-soon-program", row.confidence ?? "medium",
        now, now,
      ).changes;
    }
  })();
  return bridged;
}

/** The built-in worker sweep: bridge un-bridged watches to the scheduling
 * engine, detect promotions, and refresh opportunity scores for the board.
 * No provider dispatch happens here — the watchlist engine owns rechecks. */
export async function runComingSoonSweep(tenantId: number): Promise<{ due: number; dispatched: number; promoted: number; bridged: number }> {
  ensureComingSoonSchema();
  const bridged = bridgeLegacyWatches(tenantId);
  // Refresh opportunity scores/cadences for rows past their rescore time
  // (dates move, clusters heat up) — board ordering stays truthful.
  const due = rawDb.prepare(
    `SELECT * FROM coming_soon_watch WHERE tenant_id=? AND status='watching' AND next_check_at <= datetime('now')
     ORDER BY opportunity_score DESC, first_seen_at ASC LIMIT 2_000`,
  ).all(tenantId) as any[];
  // Promotion detector: a watch address whose target lit up as a confirmed fresh
  // lead is marked promoted (the lead + green pin + expansion already happened in
  // the scan pipeline).
  const promotedRows = rawDb.prepare(
    `SELECT w.id watchId, l.id leadId FROM coming_soon_watch w
     JOIN scan_targets t ON t.tenant_id=w.tenant_id AND lower(t.address)=lower(w.address) AND lower(t.city)=lower(w.city) AND t.state=w.state
     JOIN leads l ON l.tenant_id=w.tenant_id AND l.source_scan_target_id=t.id AND l.lead_tag='fresh_fiber_confirmed'
     WHERE w.tenant_id=? AND w.status='watching'`,
  ).all(tenantId) as any[];
  for (const row of promotedRows) {
    rawDb.prepare(`UPDATE coming_soon_watch SET status='promoted', promoted_lead_id=?, promoted_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
      .run(row.leadId, row.watchId);
  }
  // Rescore + set the next RESCORE time (next_check_at is the board-refresh
  // clock now, not a provider-recheck clock). One transaction, no N+1 fsyncs.
  if (due.length) {
    const reschedule = rawDb.prepare(`UPDATE coming_soon_watch SET opportunity_score=?, next_check_at=datetime('now', ?), updated_at=datetime('now') WHERE id=? AND status='watching'`);
    rawDb.transaction(() => {
      for (const row of due) {
        const { score, cadenceHours } = opportunityFor(row.expected_completion_at, countNearbyFresh(tenantId, row.lat, row.lng));
        reschedule.run(score, `+${cadenceHours} hours`, row.id);
      }
    })();
  }
  if (due.length || promotedRows.length || bridged) {
    structuredLog("coming_soon.sweep", { tenantId, due: due.length, dispatched: 0, promoted: promotedRows.length, bridged });
  }
  return { due: due.length, dispatched: 0, promoted: promotedRows.length, bridged };
}

export function getComingSoonWatchlist(tenantId: number): {
  watching: number; promoted: number; dueNow: number; rows: ComingSoonWatchRow[];
} {
  ensureComingSoonSchema();
  const rows = rawDb.prepare(
    `SELECT id,address,city,state,zip,lat,lng,source,first_seen_at firstSeenAt,last_seen_at lastSeenAt,
            expected_completion_at expectedCompletionAt,confidence,opportunity_score opportunityScore,
            next_check_at nextCheckAt,status,promoted_lead_id promotedLeadId,checks
     FROM coming_soon_watch WHERE tenant_id=?
     ORDER BY CASE status WHEN 'watching' THEN 0 ELSE 1 END, opportunity_score DESC, next_check_at ASC LIMIT 500`,
  ).all(tenantId) as any[];
  const one = (sql: string) => Number((rawDb.prepare(sql).get(tenantId) as any)?.n ?? 0);
  return {
    watching: one(`SELECT COUNT(*) n FROM coming_soon_watch WHERE tenant_id=? AND status='watching'`),
    promoted: one(`SELECT COUNT(*) n FROM coming_soon_watch WHERE tenant_id=? AND status='promoted'`),
    dueNow: one(`SELECT COUNT(*) n FROM coming_soon_watch WHERE tenant_id=? AND status='watching' AND next_check_at <= datetime('now')`),
    rows: rows as ComingSoonWatchRow[],
  };
}

// Built-in worker: bridge + promotion detection + board rescore, every 10
// minutes. DB-only — provider rechecks are dispatched exclusively by the
// comingSoonWatchlist engine.
let timer: ReturnType<typeof setInterval> | null = null;
export function startComingSoonProgram(getTenantId: () => number | null, intervalMs = 10 * 60_000): void {
  if (timer) return;
  const tick = () => {
    const tenantId = getTenantId();
    if (tenantId == null) return;
    void runComingSoonSweep(tenantId).catch((e: any) =>
      structuredLog("coming_soon.sweep_failed", { tenantId, error: String(e?.message ?? e) }, "warn"));
  };
  setTimeout(tick, 20_000); // let the token pool warm first
  timer = setInterval(tick, intervalMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
}
