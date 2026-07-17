// ── Coming Soon Program — the overarching, always-on watch system ─────────────
// ONE durable watchlist + ONE built-in worker loop. Every COMING_SOON signal the
// Kinetic search path returns (NEW FIBER segment with billing still active, or an
// explicit coming-soon flag) lands here with coordinates, first/last seen, source,
// expected completion date (when the provider returns one), confidence and the
// next scheduled check. The worker rechecks due addresses on an OPPORTUNITY-
// WEIGHTED cadence — the closer the expected completion date (or the hotter the
// surrounding fresh-lead cluster), the more frequently the address is re-verified.
//
// PROMOTION: a watch address that comes back NEW FIBER + billing inactive + fiber
// qualified is promoted instantly — the normal scan-run pipeline publishes the
// deduplicated green assignable Field Map lead and seeds the nearby expansion
// scan (same street → subdivision → nearby roads → ZIP corridor → neighboring
// markets). The watch row is then marked promoted with its lead id. Nothing is
// ever lost: a failed recheck simply reschedules.
import crypto from "node:crypto";
import { rawDb } from "./db";
import { storage } from "./storage";
import * as scanService from "./scanService";
import { structuredLog } from "./structuredLog";

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

/** The built-in worker sweep: recheck every due watch address, highest-opportunity
 * first, through the normal durable scan-run pipeline (which publishes the green
 * lead + seeds nearby expansion the moment one promotes). */
export async function runComingSoonSweep(tenantId: number): Promise<{ due: number; dispatched: number; promoted: number }> {
  ensureComingSoonSchema();
  // Refresh opportunity scores/cadences before picking (dates move, clusters heat up).
  const due = rawDb.prepare(
    `SELECT * FROM coming_soon_watch WHERE tenant_id=? AND status='watching' AND next_check_at <= datetime('now')
     ORDER BY opportunity_score DESC, first_seen_at ASC LIMIT 2_000`,
  ).all(tenantId) as any[];
  let dispatched = 0;
  if (due.length) {
    // Ensure every watch address exists as a scan target, then check them in one
    // durable run so a deploy never loses the batch.
    const ids: number[] = [];
    for (const row of due) {
      storage.upsertScanTargets([{ tenantId, address: row.address, city: row.city, state: row.state, zip: row.zip, lat: row.lat, lng: row.lng, source: "coming-soon-watch" } as any]);
      const t = rawDb.prepare(
        `SELECT id FROM scan_targets WHERE tenant_id=? AND lower(address)=lower(?) AND lower(city)=lower(?) AND state=? LIMIT 1`,
      ).get(tenantId, row.address, row.city, row.state) as any;
      if (t?.id) ids.push(Number(t.id));
    }
    for (let i = 0; i < ids.length; i += 1_000) {
      const batch = ids.slice(i, i + 1_000);
      scanService.startTargetRun({
        tenantId, city: "(watchlist)", state: "", targetIds: batch,
        runKind: "coming_soon", label: `Coming Soon watchlist recheck (${batch.length})`,
      });
      dispatched += batch.length;
    }
  }
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
  // Reschedule everything that was checked (whether due this sweep or not).
  rawDb.prepare(`UPDATE coming_soon_watch SET checks=checks+1, updated_at=datetime('now') WHERE tenant_id=? AND status='watching' AND id IN (${due.map(() => "?").join(",") || "NULL"})`)
    .run(tenantId, ...due.map((r) => r.id));
  for (const row of due) {
    const { score, cadenceHours } = opportunityFor(row.expected_completion_at, countNearbyFresh(tenantId, row.lat, row.lng));
    rawDb.prepare(`UPDATE coming_soon_watch SET opportunity_score=?, next_check_at=datetime('now', ?), updated_at=datetime('now') WHERE id=? AND status='watching'`)
      .run(score, `+${cadenceHours} hours`, row.id);
  }
  if (due.length || promotedRows.length) {
    structuredLog("coming_soon.sweep", { tenantId, due: due.length, dispatched, promoted: promotedRows.length });
  }
  return { due: due.length, dispatched, promoted: promotedRows.length };
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

// Built-in worker: sweeps on boot and every 15 minutes forever. Unlimited budget —
// the watchlist can never starve: the coordinator's NEW_BUILD admission class
// (coming_soon priority) outranks statewide/expansion bulk.
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
