// ── Coming-Soon watchlist engine + routes ─────────────────────────────────────
// The dedicated watcher for addresses the provider says are PRE-LAUNCH (the
// existing detection: kineticResponseParser.isComingSoon segment markers, or
// NEW FIBER + active billing — scanner.ts's 'coming_soon' classification).
//
// WRITE PATH (not here): rows are upserted/promoted by the ONE conclusive-result
// choke point, recordAvailabilitySnapshot (server/availabilitySnapshot.ts) —
// see applyConclusiveLifecycle there. This module only SCHEDULES rechecks and
// SERVES the list; it never classifies, never creates leads (the projector +
// cluster expansion already own that), and never talks to the provider directly.
//
// SCHEDULING: a periodic tick selects due active rows by urgency cadence and
// enqueues them through the SAME scanService.startTargetRun pipeline under
// runKind 'coming_soon_watch' — which providerPriorityForRun maps to the
// 'coming_soon' source → NEW_BUILD admission class (reserved capacity, cannot
// be starved by expansion/sweeps), and whose "watch" kind always re-verifies
// (dedupSkipSecondsForRun → 0).
//
// Cadence (hours between rechecks per row):
//   hot   — estimated_completion known and near/past → COMING_SOON_HOT_HOURS (6)
//   soon  — construction/new-build provenance        → COMING_SOON_CONSTRUCTION_HOURS (12)
//   watch — no date, generic provenance              → COMING_SOON_WATCH_HOURS (24)
// FLIP WINDOW: switch-ons cluster in the first ~2 weeks after an address is
// first observed coming-soon. Watches aged COMING_SOON_FLIP_WINDOW_FROM_DAYS–
// _TO_DAYS (2–14) escalate one urgency band (watch→soon, soon→hot) so the flip
// is caught within hours, then relax back to their base cadence.
//
// SPEND CONTROL: this engine is the SOLE scheduler of coming-soon rechecks
// (fresh-harvest Tier A and the legacy program worker no longer dispatch).
// Every tick is paced by the bandwidth governor — the batch shrinks when the
// Decodo pool runs ahead of pace (floor 25%: flip-watching is top-yield work
// and never starves) and dispatch suspends entirely while the proxy circuit
// breaker is open.
//
// AGED lifecycle: applied here as a cheap periodic pass (one indexed UPDATE per
// tick) rather than computed lazily at read time — the durable column stays
// truthful for EVERY reader (map filters, ad-hoc SQL, future routes), not just
// one endpoint that happens to know the lazy rule.
import type { Express, Request, Response } from "express";
import type { Middleware } from "./middlewareTypes";
import { rawDb } from "./db";
import { getDefaultTenantId } from "./storage";
import { startTargetRun } from "./scanService";
import { structuredLog } from "./structuredLog";
import { bandwidthBudgetScale, isProxyCircuitOpen } from "./bandwidthGovernor";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function bounded(v: string | undefined, dflt: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}

const CFG = {
  enabled: () => process.env.COMING_SOON_WATCHLIST !== "off", // kill switch
  tickMs: () => bounded(process.env.COMING_SOON_TICK_MS, 5 * 60_000, 30_000, 6 * HOUR_MS),
  hotHours: () => bounded(process.env.COMING_SOON_HOT_HOURS, 6, 1, 168),
  constructionHours: () => bounded(process.env.COMING_SOON_CONSTRUCTION_HOURS, 12, 1, 336),
  watchHours: () => bounded(process.env.COMING_SOON_WATCH_HOURS, 24, 1, 720),
  // "near estimated_completion" = within this many days before the date (or any
  // time past it): the launch window where a flip can happen any day.
  hotWindowDays: () => bounded(process.env.COMING_SOON_HOT_WINDOW_DAYS, 14, 1, 120),
  batch: () => Math.floor(bounded(process.env.COMING_SOON_BATCH, 200, 1, 200)), // hard cap 200/tick
  // An active watch never re-affirmed coming-soon for this long has gone cold
  // (project cancelled / mis-signal) — expired, visible, never silently deleted.
  expireDays: () => bounded(process.env.COMING_SOON_EXPIRE_DAYS, 90, 7, 3650),
  agedDays: () => bounded(process.env.LIFECYCLE_AGED_DAYS, 30, 1, 3650),
  // The post-observation window in which fiber switch-ons cluster: watches this
  // old escalate one urgency band so the flip is caught within hours.
  flipWindowFromDays: () => bounded(process.env.COMING_SOON_FLIP_WINDOW_FROM_DAYS, 2, 0, 120),
  flipWindowToDays: () => bounded(process.env.COMING_SOON_FLIP_WINDOW_TO_DAYS, 14, 1, 365),
};

export type WatchUrgency = "hot" | "soon" | "watch";

const CONSTRUCTION_SOURCE_RE = /new[-_ ]?build|radar|permit|construction/i;

function parseDateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s;
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : null;
}

// Cities with a FUNDED/announced expansion (e.g. the SW-Chatham CAB build) run
// at the hot cadence even without a per-address ETA — a switch-on there is a
// when, not an if. Spec: COMING_SOON_HOT_CITIES="bear creek:nc,goldston:nc"
// (state defaults to NC). Parse once per tick and pass the set to urgencyOf.
export function hotCitySet(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>();
  for (const entry of String(env.COMING_SOON_HOT_CITIES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    out.add(entry.includes(":") ? entry : `${entry}:nc`);
  }
  return out;
}

/** Urgency of one watch row — shared by the tick's due-selection and the API. */
export function urgencyOf(
  row: {
    estimated_completion?: string | null; source?: string | null;
    city?: string | null; state?: string | null; first_seen_at?: number | null;
  },
  now = Date.now(),
  hotCities?: Set<string>,
): WatchUrgency {
  if (hotCities?.size && row.city
      && hotCities.has(`${String(row.city).trim().toLowerCase()}:${String(row.state ?? "nc").trim().toLowerCase()}`)) return "hot";
  const eta = parseDateMs(row.estimated_completion);
  if (eta != null && eta <= now + CFG.hotWindowDays() * DAY_MS) return "hot";
  let urgency: WatchUrgency = CONSTRUCTION_SOURCE_RE.test(String(row.source ?? "")) ? "soon" : "watch";
  // Flip window: escalate one band while the watch is in the age range where
  // switch-ons actually cluster (default days 2–14 after first observation).
  const first = row.first_seen_at;
  if (first != null && Number.isFinite(first)) {
    const ageMs = now - Number(first);
    if (ageMs >= CFG.flipWindowFromDays() * DAY_MS && ageMs <= CFG.flipWindowToDays() * DAY_MS) {
      urgency = urgency === "watch" ? "soon" : "hot";
    }
  }
  return urgency;
}

function cadenceMs(urgency: WatchUrgency): number {
  return (urgency === "hot" ? CFG.hotHours() : urgency === "soon" ? CFG.constructionHours() : CFG.watchHours()) * HOUR_MS;
}

const URGENCY_RANK: Record<WatchUrgency, number> = { hot: 0, soon: 1, watch: 2 };

// ── Lifecycle AGED pass ───────────────────────────────────────────────────────
// FRESH_LEAD / STILL_FRESH not re-affirmed by a conclusive check within
// LIFECYCLE_AGED_DAYS goes AGED (lifecycle_changed_at = when it aged). A later
// conclusive fresh re-confirmation revives it to STILL_FRESH (state machine in
// availabilitySnapshot.ts).
export function applyAgedTransition(now = Date.now()): number {
  const cutoff = now - CFG.agedDays() * DAY_MS;
  return rawDb.prepare(
    `UPDATE scan_targets SET lifecycle_state='AGED', lifecycle_changed_at=?
      WHERE lifecycle_state IN ('FRESH_LEAD','STILL_FRESH')
        AND lifecycle_changed_at IS NOT NULL AND lifecycle_changed_at < ?`,
  ).run(now, cutoff).changes;
}

// Watches that have not been re-affirmed coming-soon (updated_at) in a long
// time are marked expired — kept for the record, dropped from scheduling.
function applyExpiredPass(now: number): number {
  const cutoff = now - CFG.expireDays() * DAY_MS;
  return rawDb.prepare(
    `UPDATE coming_soon_watchlist SET status='expired', updated_at=?
      WHERE status='active' AND updated_at < ?`,
  ).run(now, cutoff).changes;
}

// ── estimated_completion backfill ─────────────────────────────────────────────
// The Search response carries no completion date, but the Kinetic monitoring
// inventory (kinetic_addresses, fed by the scanner + New Build Radar) sometimes
// does (estimated_completion_date). Backfill active rows that lack one, bounded
// per tick, via an expression index created lazily (the table belongs to
// kineticScannerStore and may not exist yet in a fresh/replay DB).
let _backfillIndexReady = false;
function kineticAddressesReady(): boolean {
  const t = rawDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='kinetic_addresses'`).get();
  if (!t) return false;
  if (!_backfillIndexReady) {
    try {
      rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_kinetic_addresses_addr ON kinetic_addresses(tenant_id, lower(address))`);
    } catch { /* index is an optimization only */ }
    _backfillIndexReady = true;
  }
  return true;
}

function backfillEstimatedCompletion(limit = 100): number {
  if (!kineticAddressesReady()) return 0;
  const candidates = rawDb.prepare(
    `SELECT w.id, w.tenant_id AS tenantId, s.address, s.city, s.state
       FROM coming_soon_watchlist w JOIN scan_targets s ON s.id = w.scan_target_id
      WHERE w.status='active' AND w.estimated_completion IS NULL
      ORDER BY w.updated_at DESC LIMIT ?`,
  ).all(limit) as Array<{ id: number; tenantId: number; address: string; city: string; state: string }>;
  if (!candidates.length) return 0;
  const lookup = rawDb.prepare(
    `SELECT estimated_completion_date AS eta FROM kinetic_addresses
      WHERE tenant_id=? AND lower(address)=lower(?) AND lower(city)=lower(?) AND upper(state)=upper(?)
        AND estimated_completion_date IS NOT NULL AND estimated_completion_date != ''
      LIMIT 1`,
  );
  const write = rawDb.prepare(`UPDATE coming_soon_watchlist SET estimated_completion=? WHERE id=? AND estimated_completion IS NULL`);
  let filled = 0;
  for (const c of candidates) {
    const hit = lookup.get(c.tenantId, c.address, c.city, c.state) as { eta: string } | undefined;
    if (hit?.eta) filled += write.run(hit.eta, c.id).changes;
  }
  return filled;
}

// ── Due selection + enqueue ───────────────────────────────────────────────────
interface DueRow {
  id: number; tenant_id: number; scan_target_id: number;
  last_checked_at: number | null; first_seen_at: number | null;
  estimated_completion: string | null; source: string | null;
  city: string; state: string;
}

// Active rows possibly due (superset: older than the SHORTEST cadence), oldest
// first, excluding targets already queued/inflight in a running watch run so a
// slow provider window can't stack duplicate checks tick after tick.
function selectDue(now: number, limit: number): DueRow[] {
  const rows = rawDb.prepare(
    `SELECT w.id, w.tenant_id, w.scan_target_id, w.last_checked_at, w.first_seen_at,
            w.estimated_completion, w.source, s.city, s.state
       FROM coming_soon_watchlist w JOIN scan_targets s ON s.id = w.scan_target_id
      WHERE w.status='active'
        AND (w.last_checked_at IS NULL OR w.last_checked_at <= ?)
        AND NOT EXISTS (
          SELECT 1 FROM scan_run_targets t JOIN scan_runs r ON r.id = t.run_id
           WHERE t.target_id = w.scan_target_id AND r.kind='coming_soon_watch'
             AND r.status='running' AND t.state IN ('queued','inflight'))
      ORDER BY w.last_checked_at ASC
      LIMIT 2000`,
  ).all(now - cadenceMs("hot")) as DueRow[];
  const hot = hotCitySet();
  const due = rows.filter((r) => r.last_checked_at == null || now - r.last_checked_at >= cadenceMs(urgencyOf(r, now, hot)));
  // Hot-first within the batch cap, oldest-checked first inside each band.
  due.sort((a, b) =>
    URGENCY_RANK[urgencyOf(a, now, hot)] - URGENCY_RANK[urgencyOf(b, now, hot)] ||
    (a.last_checked_at ?? 0) - (b.last_checked_at ?? 0));
  return due.slice(0, limit);
}

export interface ComingSoonTickResult {
  disabled?: boolean;
  circuitOpen?: boolean;
  aged: number; expired: number; backfilled: number;
  due: number; enqueued: number; runs: string[];
}

/** Per-tick dispatch cap, paced by the bandwidth governor. Floor 25%: coming-
 * soon flips are the highest-yield checks, so scarcity slows them last. */
export function governedBatch(cap: number, scale: number): number {
  return Math.max(1, Math.round(cap * Math.min(1, Math.max(0.25, scale))));
}

export function runComingSoonTick(now = Date.now()): ComingSoonTickResult {
  const result: ComingSoonTickResult = { aged: 0, expired: 0, backfilled: 0, due: 0, enqueued: 0, runs: [] };
  if (!CFG.enabled()) return { ...result, disabled: true };
  result.aged = applyAgedTransition(now);
  result.expired = applyExpiredPass(now);
  result.backfilled = backfillEstimatedCompletion();

  // Housekeeping above is DB-only and always runs; provider dispatch below is
  // proxy spend and suspends while the circuit breaker is open.
  if (isProxyCircuitOpen()) return { ...result, circuitOpen: true };

  const due = selectDue(now, governedBatch(CFG.batch(), bandwidthBudgetScale()));
  result.due = due.length;
  if (!due.length) return result;

  // startTargetRun is per (tenant, city, state) — group and enqueue each bucket.
  const groups = new Map<string, DueRow[]>();
  for (const row of due) {
    const key = `${row.tenant_id}|${(row.city || "").toLowerCase()}|${(row.state || "").toUpperCase()}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(row);
  }
  for (const rows of groups.values()) {
    const { tenant_id, city, state } = rows[0];
    try {
      const run = startTargetRun({
        tenantId: tenant_id, city, state,
        targetIds: rows.map((r) => r.scan_target_id),
        runKind: "coming_soon_watch",
        label: `Coming Soon watch - ${city}, ${state}`,
      });
      result.enqueued += run.queued;
      result.runs.push(run.runId);
    } catch (error: any) {
      structuredLog("coming_soon.enqueue_failed", {
        tenantId: tenant_id, city, state, targets: rows.length,
        error: String(error?.message ?? error).slice(0, 160),
      }, "warn");
    }
  }
  if (result.enqueued > 0 || result.aged > 0 || result.expired > 0) {
    structuredLog("coming_soon.tick", result as any, "info");
  }
  return result;
}

// ── Service lifecycle ─────────────────────────────────────────────────────────
let timer: NodeJS.Timeout | null = null;

/** Wire from the orchestrator on boot. Idempotent; COMING_SOON_WATCHLIST=off disables. */
export function startComingSoonWatchlist(): NodeJS.Timeout | null {
  if (!CFG.enabled()) {
    structuredLog("coming_soon.disabled", { reason: "COMING_SOON_WATCHLIST=off" }, "info");
    return null;
  }
  if (timer) return timer;
  timer = setInterval(() => {
    try { runComingSoonTick(); }
    catch (error: any) {
      structuredLog("coming_soon.tick_failed", { error: String(error?.message ?? error).slice(0, 200) }, "warn");
    }
  }, CFG.tickMs());
  timer.unref();
  return timer;
}

/** Test/shutdown hook. */

// ── Routes ────────────────────────────────────────────────────────────────────
export interface ComingSoonRouteDeps {
  requireAuth: Middleware;
  requireManager: Middleware;
}

function tenantOf(req: Request): number | null {
  const value = Number((req as any).user?.tenantId ?? getDefaultTenantId());
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Wire from the orchestrator (same deps-injection pattern as the other route modules). */
export function registerComingSoonRoutes(app: Express, deps: ComingSoonRouteDeps): void {
  // The construction pipeline board: every watched address with its urgency,
  // hot-first. Manager+ (operational intel, not rep-facing).
  app.get("/api/coming-soon/watchlist", deps.requireManager, (req: Request, res: Response) => {
    const tid = tenantOf(req);
    if (!tid) return res.status(403).json({ error: "Organization required" });
    const statusFilter = ["active", "promoted", "expired"].includes(String(req.query.status))
      ? String(req.query.status) : null;
    const now = Date.now();
    const hotCities = hotCitySet();
    const rows = rawDb.prepare(
      `SELECT w.id, w.scan_target_id AS scanTargetId, w.first_seen_at AS firstSeenAt,
              w.last_checked_at AS lastCheckedAt, w.estimated_completion, w.source,
              w.confidence, w.cluster_id AS clusterId, w.status,
              s.address, s.city, s.state, s.zip, s.lat, s.lng
         FROM coming_soon_watchlist w JOIN scan_targets s ON s.id = w.scan_target_id
        WHERE w.tenant_id = ? ${statusFilter ? "AND w.status = ?" : ""}
        LIMIT 1000`,
    ).all(...(statusFilter ? [tid, statusFilter] : [tid])) as any[];
    const items = rows.map((r) => ({
      id: r.id,
      address: r.address, city: r.city, state: r.state, zip: r.zip,
      lat: r.lat, lng: r.lng,
      firstSeenAt: r.firstSeenAt, lastCheckedAt: r.lastCheckedAt,
      estimatedCompletion: r.estimated_completion,
      source: r.source, confidence: r.confidence, clusterId: r.clusterId,
      status: r.status,
      urgency: urgencyOf({
        estimated_completion: r.estimated_completion,
        source: r.source,
        city: r.city,
        state: r.state,
        first_seen_at: r.firstSeenAt,
      }, now, hotCities),
    }));
    // Active first, then hot > soon > watch, then nearest completion, then oldest watch.
    const statusRank: Record<string, number> = { active: 0, promoted: 1, expired: 2 };
    items.sort((a, b) =>
      (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3) ||
      URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] ||
      (parseDateMs(a.estimatedCompletion) ?? Number.MAX_SAFE_INTEGER) - (parseDateMs(b.estimatedCompletion) ?? Number.MAX_SAFE_INTEGER) ||
      (a.firstSeenAt ?? 0) - (b.firstSeenAt ?? 0));
    // The 1000-row LIMIT is a payload cap, not the population. Without the
    // true total the client renders the cap as an exact count ("Coming soon
    // 1000") and understates every derived figure.
    const total = Number((rawDb.prepare(
      `SELECT COUNT(*) AS n FROM coming_soon_watchlist w WHERE w.tenant_id = ? ${statusFilter ? "AND w.status = ?" : ""}`,
    ).get(...(statusFilter ? [tid, statusFilter] : [tid])) as any)?.n ?? items.length);
    res.json({ items, total, truncated: total > items.length });
  });
}
