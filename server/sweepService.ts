import crypto from "node:crypto";
import { rawDb } from "./db";
import { storage } from "./storage";
import { getCityAddresses, pullAddressesFromOverpass } from "./overpass";
import * as scanService from "./scanService";
import { clusterFreshFiber, type FreshFiberPoint } from "@shared/freshFiberClusters";
import { opportunityRank } from "@shared/opportunitySegment";
import { toCsv, syncMarketState } from "./stateMonitorStore";
import { structuredLog } from "./structuredLog";
import { flushFreshOpportunityAlerts } from "./stateMonitorScheduler";
import { KINETIC_MONITORED_STATES, type KineticMonitoredState } from "./kineticMarketCatalog";
// The probe/flood ordering is the neighbourhood sweep's, reused rather than
// re-derived: pure, deterministic, and already covered by its own tests.
import { selectProbe, orderFlood, houseNumberOf } from "@shared/neighborhoodSweep";

const active = new Set<string>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Upsert a large harvest WITHOUT blocking the event loop. upsertScanTargets runs
// one synchronous better-sqlite3 transaction, so a big-city OSM harvest (observed:
// 37,924 addresses) blocks the single thread for many seconds — long enough that
// /api/health times out and the deploy health-gate rolls the release back. Split
// into bounded transactions and yield to the loop between them so health always
// answers. SWEEP_UPSERT_CHUNK addresses per transaction (default 2000).
async function upsertHarvestChunked(rows: Array<Parameters<typeof storage.upsertScanTargets>[0][number]>): Promise<number> {
  const chunk = Math.max(200, Number(process.env.SWEEP_UPSERT_CHUNK ?? 2000) || 2000);
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    inserted += storage.upsertScanTargets(rows.slice(i, i + chunk));
    if (i + chunk < rows.length) await new Promise((r) => setImmediate(r)); // yield between chunks
  }
  return inserted;
}

// Normalize a large OSM harvest into upsert rows WITHOUT one blocking loop. A
// big-city harvest can be 30k+ addresses; mapping them all in a single synchronous
// pass (tenantId/source spread per row) adds to the loop-block budget that starves
// /api on boot. Chunk the map and yield every SWEEP_NORMALIZE_CHUNK rows (default
// 500) so health always answers even mid-normalization. Order is preserved.
async function normalizeHarvestRows<T extends object>(
  addresses: readonly T[], tenantId: number, source: string,
): Promise<Array<T & { tenantId: number; source: string }>> {
  const yieldEvery = Math.max(100, Number(process.env.SWEEP_NORMALIZE_CHUNK ?? 500) || 500);
  const rows: Array<T & { tenantId: number; source: string }> = [];
  for (let i = 0; i < addresses.length; i++) {
    rows.push({ ...addresses[i], tenantId, source });
    if ((i + 1) % yieldEvery === 0 && i + 1 < addresses.length) await new Promise((r) => setImmediate(r));
  }
  return rows;
}
// No cap — a sweep checks every discovered address in the market. Outbound
// provider rate stays governed by the scheduler + 403/429 backoff (correctness).
const MAX_SWEEP_CHECKS = () => Number.MAX_SAFE_INTEGER;

export interface StartSweepInput { tenantId: number; city: string; state: KineticMonitoredState; maxChecks?: number; createdBy?: number | null; }
export interface StartAddressSweepInput { tenantId: number; query: string; radiusMeters: number; maxChecks?: number; createdBy?: number | null; }

export function startCitySweep(input: StartSweepInput) {
  const id = `sweep_${input.tenantId}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  const maxChecks = Math.min(MAX_SWEEP_CHECKS(), Math.max(1, Math.floor(input.maxChecks ?? MAX_SWEEP_CHECKS())));
  rawDb.prepare(`INSERT INTO sweep_jobs (id,tenant_id,kind,query,city,state,max_checks,created_by,phase,status,heartbeat_at)
    VALUES (?,?,?,?,?,?,?,?,'queued','running',datetime('now'))`).run(
      id, input.tenantId, "city", `${input.city}, ${input.state}`, input.city, input.state, maxChecks, input.createdBy ?? null,
    );
  void runSweep(id).catch((error) => failSweep(id, error));
  return getSweep(id, input.tenantId)!;
}

export function startAddressSweep(input: StartAddressSweepInput) {
  const id = `sweep_${input.tenantId}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  const maxChecks = Math.min(MAX_SWEEP_CHECKS(), Math.max(1, Math.floor(input.maxChecks ?? 5_000)));
  rawDb.prepare(`INSERT INTO sweep_jobs (id,tenant_id,kind,query,radius_meters,max_checks,created_by,phase,status,heartbeat_at)
    VALUES (?,?, 'address',?,?,?,?, 'queued','running',datetime('now'))`).run(
      id, input.tenantId, input.query, input.radiusMeters, maxChecks, input.createdBy ?? null,
    );
  void runSweep(id).catch((error) => failSweep(id, error));
  return getSweep(id, input.tenantId)!;
}

export function getSweep(id: string, tenantId: number): any | null {
  const row = rawDb.prepare(`SELECT * FROM sweep_jobs WHERE id=? AND tenant_id=?`).get(id, tenantId) as any;
  return row ? mapJob(row) : null;
}

export function listSweeps(tenantId: number, limit = 30): any[] {
  return (rawDb.prepare(`SELECT * FROM sweep_jobs WHERE tenant_id=? ORDER BY started_at DESC LIMIT ?`).all(tenantId, Math.min(100, limit)) as any[]).map(mapJob);
}

export function cancelSweep(id: string, tenantId: number): boolean {
  const job = getSweep(id, tenantId);
  if (!job) return false;
  if (job.currentRunId) scanService.controlRun(job.currentRunId, tenantId, "cancel");
  return rawDb.prepare(`UPDATE sweep_jobs SET status='cancelled',phase='cancelled',completed_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND tenant_id=? AND status='running'`).run(id, tenantId).changes > 0;
}

export async function searchAddressArea(input: { tenantId: number; query: string; radiusMeters: number }) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", input.query); url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1"); url.searchParams.set("limit", "1"); url.searchParams.set("countrycodes", "us");
  const response = await fetch(url, { headers: { "user-agent": "HomeFrontFiber-AddressSearch/1.0 (operations@homefrontsolutions.com)", accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Nominatim returned ${response.status}`);
  const matches = await response.json() as any[];
  if (!matches.length) throw new Error("ADDRESS_NOT_FOUND");
  const hit = matches[0], lat = Number(hit.lat), lng = Number(hit.lon);
  const isoState = String(hit.address?.["ISO3166-2-lvl4"] ?? hit.address?.["ISO3166-2-lvl3"] ?? "");
  const stateName = String(hit.address?.state ?? "").toLowerCase();
  const fallbackState = ({
    florida: "FL", georgia: "GA", iowa: "IA", kentucky: "KY",
    "north carolina": "NC", "south carolina": "SC",
  } as Record<string, KineticMonitoredState>)[stateName] ?? "";
  const state = String(hit.address?.state_code ?? isoState.split("-").pop() ?? "").toUpperCase() || fallbackState;
  if (!(KINETIC_MONITORED_STATES as readonly string[]).includes(state)) throw new Error("OUTSIDE_SUPPORTED_STATES");
  const city = hit.address?.city ?? hit.address?.town ?? hit.address?.village ?? hit.address?.municipality ?? "";
  const latDelta = input.radiusMeters / 111_320;
  const lngDelta = input.radiusMeters / (111_320 * Math.cos(lat * Math.PI / 180));
  const addresses = await pullAddressesFromOverpass({ south: lat - latDelta, north: lat + latDelta, west: lng - lngDelta, east: lng + lngDelta }, city, state);
  const inserted = await upsertHarvestChunked(await normalizeHarvestRows(addresses, input.tenantId, "osm-address-radius"));
  return { match: { displayName: hit.display_name, lat, lng, city, state, zip: hit.address?.postcode ?? "" }, radiusMeters: input.radiusMeters, addresses, inserted };
}

export function getSweepResults(id: string, tenantId: number, filters: { stage?: string; customer?: string; limit?: number; offset?: number } = {}) {
  const job = getSweep(id, tenantId); if (!job) return null;
  const where = ["j.sweep_job_id=?"];
  const args: any[] = [id];
  if (filters.stage === "fresh") where.push("s.first_seen_fiber_at >= ?"), args.push(job.startedAt);
  if (filters.stage === "available") where.push("s.last_fiber_available=1");
  if (filters.stage === "unavailable") where.push("s.last_fiber_available=0");
  if (filters.customer) where.push("s.last_customer_segment=?"), args.push(filters.customer);
  const total = (rawDb.prepare(`SELECT COUNT(*) n FROM sweep_job_targets j JOIN scan_targets s ON s.id=j.target_id WHERE ${where.join(" AND ")}`).get(...args) as any).n;
  const limit = Math.max(1, Math.min(5_000, filters.limit ?? 500)), offset = Math.max(0, filters.offset ?? 0);
  const rows = rawDb.prepare(`SELECT s.id,s.address,s.city,s.state,s.zip,s.lat,s.lng,s.last_fiber_status AS fiberStatus,
      s.last_fiber_available AS fiberAvailable,s.first_seen_fiber_at AS firstSeenFiberAt,
      s.last_customer_segment AS customerSegment,s.last_customer_confidence AS customerConfidence,
      s.last_customer_signals AS customerSignals,s.last_scanned_at AS checkedAt,COALESCE(a.transition_status,s.last_availability_status) AS transitionStatus,
      a.max_download_mbps AS maxDownloadMbps,a.household_segment_type AS householdSegmentType,a.billing_status AS billingStatus,
      a.conclusive,a.error,
      EXISTS(SELECT 1 FROM availability_corroboration c
        WHERE c.scan_target_id=s.id AND c.tenant_id=? AND c.availability='available'
          AND (lower(COALESCE(c.technology,'')) LIKE '%fiber%' OR lower(COALESCE(c.technology,'')) IN ('fttp','ftth'))
          AND datetime(c.observed_at)>=datetime(s.first_seen_fiber_at,'-7 days')
          AND datetime(c.observed_at)<=datetime(s.first_seen_fiber_at,'+31 days')
          AND datetime(c.observed_at)<=datetime('now','+5 minutes')) AS crossVerified
    FROM sweep_job_targets j JOIN scan_targets s ON s.id=j.target_id
    LEFT JOIN availability_snapshots a ON a.id=(SELECT MAX(a2.id) FROM availability_snapshots a2 WHERE a2.scan_target_id=s.id)
    WHERE ${where.join(" AND ")} ORDER BY (s.first_seen_fiber_at IS NOT NULL) DESC,s.first_seen_fiber_at DESC,s.address LIMIT ? OFFSET ?`).all(tenantId, ...args, limit, offset) as any[];
  return { job, total, limit, offset, results: rows.map((r) => ({ ...r, fiberAvailable: r.fiberAvailable == null ? null : !!r.fiberAvailable, crossVerified: !!r.crossVerified, customerSignals: safeJson(r.customerSignals, []) })) };
}

export function getSweepKnockList(id: string, tenantId: number) {
  const result = getSweepResults(id, tenantId, { stage: "fresh", customer: "new_opportunity", limit: 5_000 });
  if (!result) return null;
  const points: FreshFiberPoint[] = result.results.filter((r: any) => r.crossVerified && Number.isFinite(r.lat) && Number.isFinite(r.lng)).map((r: any) => ({
    id: r.id, address: r.address, city: r.city, state: r.state, zip: r.zip, lat: r.lat, lng: r.lng,
    firstSeenLiveAt: iso(r.firstSeenFiberAt), confidence: "cross_verified",
    sources: ["kinetic", "independent_address_fiber_evidence"],
    customerSegment: r.customerSegment, customerConfidence: r.customerConfidence,
  }));
  const clusters = clusterFreshFiber(points);
  const rows = clusters.flatMap((cluster, clusterIndex) => cluster.addresses.map((point) => {
    const ageHours = Math.max(0, (Date.now() - Date.parse(point.firstSeenLiveAt)) / 3_600_000);
    return {
      rank: clusterIndex + 1, opportunity_score: opportunityRank({ fresh: true, customerSegment: "new_opportunity", crossVerified: point.confidence === "cross_verified", clusterDensity: cluster.density, ageHours }),
      cluster_id: cluster.id, cluster_density: cluster.density, fresh_confidence: point.confidence,
      customer_segment: "new_opportunity", customer_confidence: point.customerConfidence ?? "medium",
      address: point.address, city: point.city, state: point.state, zip: point.zip ?? "", lat: point.lat, lng: point.lng,
      first_seen_fiber_at: point.firstSeenLiveAt, map_url: cluster.mapUrl,
    };
  })).sort((a, b) => b.opportunity_score - a.opportunity_score || b.cluster_density - a.cluster_density);
  return { job: result.job, count: rows.length, clusters, rows, csv: toCsv(rows) };
}

export function resumeSweepJobs() {
  const jobs = rawDb.prepare(`SELECT id FROM sweep_jobs WHERE status='running'`).all() as Array<{ id: string }>;
  // STAGGER the resumes. Driving every running city sweep at once on a cold boot
  // pile-drives the single event-loop thread — one Triangle-city OSM harvest can
  // be 30k+ addresses, and several concurrent harvest+upsert transactions block
  // the loop long enough that /api/health times out and the deploy health-gate
  // fails (observed: prod wedged on boot, deploy rolled back). One resume every
  // SWEEP_RESUME_STAGGER_MS; unref'd so it never holds the process open.
  const stagger = Math.max(0, Number(process.env.SWEEP_RESUME_STAGGER_MS ?? 5000) || 5000);
  jobs.forEach((job, i) => {
    const t = setTimeout(() => { void runSweep(job.id).catch((error) => failSweep(job.id, error)); }, i * stagger);
    if (typeof (t as any).unref === "function") (t as any).unref();
  });
}

// ── Statewide sweep ──────────────────────────────────────────────────────────
// Runs NOW, as the active priority job — never deferred/scheduled/nightly. It
// drives ONE city sweep at a time across every scan-eligible market in the state
// until every discoverable address is checked, aggregating live progress and
// producing a final report. A single-city failure never stops the state sweep;
// the underlying scan engine mints fresh tokens and retries per address, and this
// loop simply moves on. Checkpoints (state_sweeps/state_sweep_cities) exist ONLY
// for crash recovery — resumeStateSweeps() picks a running sweep back up on boot.
const activeState = new Set<string>();

// ── Continuous, self-re-arming cadence ─────────────────────────────────────────
// A completed pass does NOT terminate the sweep forever. Instead it schedules the
// next cycle after a configurable pause, so verified NC/SC markets keep cycling.
// Each new cycle recomputes the opportunity order (stateCities) from the freshly
// advanced cadence model, so due/expanding markets naturally lead the next pass.
//
// Guardrails:
//  • Kill-switch: STATEWIDE_SCAN_ON_DEPLOY=off disables re-arming (same switch that
//    gates the deploy auto-start in index.ts).
//  • One pending re-arm per (tenant,state) — never stack cycles or firehoses.
//  • startStateSweep() itself is idempotent per (tenant,state); the fired timer
//    reuses a running sweep rather than starting a duplicate.
export const DEFAULT_STATEWIDE_CYCLE_PAUSE_MS = 15 * 60_000; // 15 min between full cycles

export interface ReArmPlan { rearm: boolean; pauseMs: number; reason: "scheduled" | "kill_switch_off"; }

/** Pure decision: should a finished pass re-arm, and after how long a pause? */
export function planStateSweepReArm(env: NodeJS.ProcessEnv = process.env): ReArmPlan {
  if (env.STATEWIDE_SCAN_ON_DEPLOY === "off") return { rearm: false, pauseMs: 0, reason: "kill_switch_off" };
  const raw = Number(env.STATEWIDE_CYCLE_PAUSE_MS);
  const pauseMs = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_STATEWIDE_CYCLE_PAUSE_MS;
  return { rearm: true, pauseMs, reason: "scheduled" };
}

// Pending re-arm timers keyed by `${tenantId}:${state}` — the single-cycle guard.
const reArmTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule the next statewide cycle after a completed pass. Honors the kill-switch
 * and dedupes per (tenant,state). `start` is injectable for tests; production uses
 * the idempotent startStateSweep. Returns the plan so callers/tests can assert it.
 */
export function scheduleStateSweepReArm(
  parent: { tenant_id: number; state: KineticMonitoredState; created_by: number | null; max_checks_per_city: number | null },
  start: (input: StartStateSweepInput) => unknown = startStateSweep,
): ReArmPlan {
  const plan = planStateSweepReArm();
  const key = `${parent.tenant_id}:${parent.state}`;
  if (!plan.rearm) {
    structuredLog("state_sweep.rearm_skipped", { tenant: parent.tenant_id, state: parent.state, reason: plan.reason });
    return plan;
  }
  if (reArmTimers.has(key)) return plan; // a cycle is already queued for this (tenant,state)
  const timer = setTimeout(() => {
    reArmTimers.delete(key);
    if (!planStateSweepReArm().rearm) return; // kill-switch may have flipped during the pause
    try {
      start({ tenantId: parent.tenant_id, state: parent.state, createdBy: parent.created_by, maxChecksPerCity: parent.max_checks_per_city ?? undefined });
      structuredLog("state_sweep.rearm_fired", { tenant: parent.tenant_id, state: parent.state });
    } catch (error: any) {
      structuredLog("state_sweep.rearm_failed", { tenant: parent.tenant_id, state: parent.state, error: String(error?.message ?? error) });
    }
  }, plan.pauseMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref(); // never keep the process alive on the pause
  reArmTimers.set(key, timer);
  structuredLog("state_sweep.rearm_scheduled", { tenant: parent.tenant_id, state: parent.state, pauseMs: plan.pauseMs });
  return plan;
}

/** Test-only: clear any pending re-arm timers so cycles don't leak across tests. */
export function __clearReArmTimers() {
  for (const timer of reArmTimers.values()) clearTimeout(timer);
  reArmTimers.clear();
}

export interface StartStateSweepInput { tenantId: number; state: KineticMonitoredState; createdBy?: number | null; maxChecksPerCity?: number; }

/**
 * Every scan-eligible market in the state's catalog, de-duped case-insensitively
 * and ordered by OPPORTUNITY (not alphabet). The order drives which cities a full
 * pass reaches first; a fresh order is recomputed each cycle from the live cadence
 * model in `state_fiber_markets`, so Coming-Soon / new-build / expanding markets
 * (24h cadence, priority_score 100) cycle to the front the moment they come due
 * while stable markets (168h / 336h cadence) wait their turn.
 *
 * Ordering keys (each a fallback for the previous):
 *   1. DUE first          — next_scan_at <= now (the cadence model's "check me now")
 *   2. priority_score DESC — higher-opportunity markets ahead (expanding=100 …)
 *   3. cadence_hours ASC   — faster-cycling markets ahead on a priority tie
 *   4. never-scanned first — markets with no last_scanned_at outrank scanned ones
 *   5. last_scanned_at ASC — oldest-checked first (the "no cadence signal" fallback)
 *   6. city ASC            — stable alphabetical tiebreak (fully deterministic)
 * This mirrors the idx_state_markets_due / idx_state_markets_state_priority indexes.
 */
export function stateCities(state: KineticMonitoredState): string[] {
  const rows = rawDb.prepare(
    `SELECT city FROM state_fiber_markets
      WHERE state=? AND auto_scan_eligible=1
      ORDER BY
        (next_scan_at IS NOT NULL AND next_scan_at <= datetime('now')) DESC,
        priority_score DESC,
        cadence_hours ASC,
        (last_scanned_at IS NULL) DESC,
        last_scanned_at ASC,
        city ASC`,
  ).all(state) as Array<{ city: string }>;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const key = String(r.city ?? "").trim().toLowerCase();
    if (key && !seen.has(key)) { seen.add(key); out.push(String(r.city).trim()); }
  }
  return out;
}

export function startStateSweep(input: StartStateSweepInput) {
  // One active statewide sweep per (tenant,state) — reuse the running one rather
  // than stacking duplicate firehoses at the provider.
  const existing = rawDb.prepare(
    `SELECT id FROM state_sweeps WHERE tenant_id=? AND state=? AND status='running' ORDER BY started_at DESC LIMIT 1`,
  ).get(input.tenantId, input.state) as { id: string } | undefined;
  if (existing) return getStateSweep(existing.id, input.tenantId)!;

  const cities = stateCities(input.state);
  const id = `statesweep_${input.tenantId}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  rawDb.prepare(
    `INSERT INTO state_sweeps (id,tenant_id,state,status,phase,cities_total,max_checks_per_city,created_by,heartbeat_at)
     VALUES (?,?,?,'running','running',?,?,?,datetime('now'))`,
  ).run(id, input.tenantId, input.state, cities.length, input.maxChecksPerCity ?? null, input.createdBy ?? null);
  const addCity = rawDb.prepare(`INSERT OR IGNORE INTO state_sweep_cities (state_sweep_id,city,state,seq) VALUES (?,?,?,?)`);
  rawDb.transaction(() => cities.forEach((city, seq) => addCity.run(id, city, input.state, seq)))();
  // Fire immediately — active priority, NOT queued/deferred.
  void runStateSweep(id).catch((error) => failStateSweep(id, error));
  structuredLog("state_sweep.started", { stateSweepId: id, state: input.state, cities: cities.length });
  return getStateSweep(id, input.tenantId)!;
}

// ── Single-lane gate: one statewide city-loop at a time ───────────────────────
// A deploy starts all monitored states at once (index.ts) — one driver per state,
// its own city loop. Run concurrently that is 3× the OSM harvest + scan load on
// the single event-loop thread the deploy health-gate is probing on boot — exactly
// the burst that starved /api and rolled the release back. Serialize the drivers:
// each waits its turn on this one-lane queue, so only ONE city loop does heavy work
// at any instant. The sweeps are idempotent + checkpoint-resumed, so serialized
// ordering loses no coverage — NC finishes its pass, then SC, then GA, and each
// re-arms its own next cycle independently.
let stateSweepLane: Promise<unknown> = Promise.resolve();
export function enqueueStateSweepLane<T>(task: () => Promise<T>): Promise<T> {
  const run = stateSweepLane.then(task, task);
  // Chain the NEXT waiter off a settled tail so one task's rejection can never
  // poison the lane (a failed state sweep must not block the others forever).
  stateSweepLane = run.then(() => {}, () => {});
  return run;
}
/** Test-only: reset the lane so a pending/failed task can't bleed across tests. */
export function __resetStateSweepLane() { stateSweepLane = Promise.resolve(); }

async function runStateSweep(id: string) {
  // Dedup a driver for THIS sweep, then queue behind the single lane so a boot
// that started every state never runs multiple heavy city loops simultaneously.
  if (activeState.has(id)) return; activeState.add(id);
  return enqueueStateSweepLane(() => driveStateSweep(id)).finally(() => activeState.delete(id));
}

// Drive ONE statewide sweep's city loop to completion. Serialized by the lane in
// runStateSweep so only one of these does heavy OSM harvest + scan work at a time.
async function driveStateSweep(id: string) {
  {
    for (;;) {
      const parent = rawDb.prepare(`SELECT * FROM state_sweeps WHERE id=?`).get(id) as any;
      if (!parent || parent.status !== "running") return;
      const next = rawDb.prepare(
        `SELECT * FROM state_sweep_cities WHERE state_sweep_id=? AND status='pending' ORDER BY seq LIMIT 1`,
      ).get(id) as any;
      if (!next) {
        // TEMPORARY city failures (OSM harvest timeout, transient enumeration
        // errors) are retried before the state is declared complete — a skipped
        // city is silently-lost coverage. Bounded at 3 passes per city so one
        // permanently broken town can never spin the sweep forever; a city that
        // exhausts its retries stays 'failed' with its recorded error (a
        // terminal data error, visible in the report).
        const revived = rawDb.prepare(
          `UPDATE state_sweep_cities SET status='pending', error=NULL, attempts=attempts+1, sweep_job_id=NULL
           WHERE state_sweep_id=? AND status='failed' AND attempts < 3`,
        ).run(id).changes;
        if (revived) {
          bumpCityDone(id); // recount completed now that failed cities re-queued
          structuredLog("state_sweep.retrying_failed_cities", { stateSweepId: id, revived });
          continue;
        }
        finishStateSweep(id); return;
      }

      updateState(id, { current_city: next.city, heartbeat_at: now() });
      updateCity(id, next.city, { status: "running", started_at: now() });

      // Start this city's sweep immediately, then drive it to completion before
      // the next city. A city that errors is logged and skipped — never fatal.
      let child: any = null;
      try {
        child = startCitySweep({
          tenantId: parent.tenant_id, city: next.city, state: parent.state,
          createdBy: parent.created_by, maxChecks: parent.max_checks_per_city ?? undefined,
        });
        updateCity(id, next.city, { sweep_job_id: child.id });
      } catch (error) {
        updateCity(id, next.city, { status: "failed", error: String((error as any)?.message ?? error).slice(0, 300), completed_at: now() });
        bumpCityDone(id);
        continue;
      }

      for (;;) {
        const p = rawDb.prepare(`SELECT status FROM state_sweeps WHERE id=?`).get(id) as any;
        if (!p || p.status !== "running") { cancelSweep(child.id, parent.tenant_id); return; }
        const c = getSweep(child.id, parent.tenant_id);
        aggregateState(id);
        if (!c || ["done", "error", "cancelled"].includes(c.status)) {
          updateCity(id, next.city, {
            status: c?.status === "done" ? "done" : "failed",
            checked: c?.checked ?? 0, fresh: c?.opportunitiesFound ?? 0,
            coming_soon: comingSoonCount(child.id), failed: c?.failed ?? 0,
            error: c?.error ?? null, completed_at: now(),
          });
          bumpCityDone(id);
          advanceMarketCadence(); // this city was just swept — advance its cadence bookkeeping
          break;
        }
        await sleep(400); // fast poll — city turnover must never idle
      }
    }
  }
}

// After a city is swept, its addresses' last_scanned_at advanced, so recompute the
// cadence model's next_scan_at across markets (fully-scanned markets defer to
// oldest-checked + cadence_hours; markets with unscanned inventory stay due). This
// is the ONE shared cadence helper (stateMonitorStore.syncMarketState) — no parallel
// bookkeeping. A cadence-sync failure must never abort the statewide sweep.
function advanceMarketCadence() {
  try { syncMarketState(); }
  catch (error: any) { structuredLog("state_sweep.cadence_sync_failed", { error: String(error?.message ?? error) }); }
}

function bumpCityDone(id: string) {
  rawDb.prepare(
    `UPDATE state_sweeps SET cities_completed=(SELECT COUNT(*) FROM state_sweep_cities WHERE state_sweep_id=? AND status IN ('done','failed')),updated_at=datetime('now') WHERE id=?`,
  ).run(id, id);
  aggregateState(id);
}

// Live statewide counts: completed cities' stored totals + the running city's
// in-flight progress, so every number moves in real time.
function aggregateState(id: string) {
  const parent = rawDb.prepare(`SELECT tenant_id FROM state_sweeps WHERE id=?`).get(id) as any;
  if (!parent) return;
  const done = rawDb.prepare(
    `SELECT COALESCE(SUM(checked),0) checked, COALESCE(SUM(fresh),0) fresh, COALESCE(SUM(coming_soon),0) coming_soon, COALESCE(SUM(failed),0) failed
     FROM state_sweep_cities WHERE state_sweep_id=? AND status IN ('done','failed')`,
  ).get(id) as any;
  const running = rawDb.prepare(
    `SELECT sweep_job_id FROM state_sweep_cities WHERE state_sweep_id=? AND status='running' AND sweep_job_id IS NOT NULL LIMIT 1`,
  ).get(id) as any;
  let liveChecked = 0, liveFresh = 0, liveComing = 0, liveFailed = 0, retrying = 0;
  if (running?.sweep_job_id) {
    const c = getSweep(running.sweep_job_id, parent.tenant_id);
    if (c) {
      liveChecked = c.checked ?? 0; liveFresh = c.opportunitiesFound ?? 0; liveFailed = c.failed ?? 0;
      liveComing = comingSoonCount(running.sweep_job_id);
      retrying = Math.max(0, (c.queued ?? 0) - (c.checked ?? 0)); // still being worked/retried
    }
  }
  updateState(id, {
    checked: Number(done.checked) + liveChecked, fresh_found: Number(done.fresh) + liveFresh,
    coming_soon: Number(done.coming_soon) + liveComing, unresolved: Number(done.failed) + liveFailed,
    retrying, heartbeat_at: now(),
  });
}

// Coming Soon = Kinetic reports NEW FIBER at an address that already has an active
// account — a planned/soon build to watch, stored separately in kinetic_addresses
// (is_coming_soon) by the scan engine and rechecked nightly. The provider's active
// value is 'A' (never 'Y' in 5,778 recorded responses); this counter matched only
// 'Y' and so read 0 forever. Accept BOTH via the canonical predicate's values.
function comingSoonCount(sweepId: string): number {
  const row = rawDb.prepare(
    `SELECT COUNT(*) n FROM sweep_job_targets j JOIN scan_targets s ON s.id=j.target_id
     JOIN availability_snapshots a ON a.id=(SELECT a2.id FROM availability_snapshots a2 WHERE a2.scan_target_id=s.id ORDER BY a2.checked_at_epoch DESC, a2.id DESC LIMIT 1)
     WHERE j.sweep_job_id=? AND upper(COALESCE(a.household_segment_type,'')) LIKE '%NEW FIBER%' AND upper(COALESCE(a.billing_status,'')) IN ('A','Y')`,
  ).get(sweepId) as any;
  return Number(row?.n ?? 0);
}

function finishStateSweep(id: string) {
  aggregateState(id);
  const parent = rawDb.prepare(`SELECT * FROM state_sweeps WHERE id=?`).get(id) as any;
  if (!parent) return;
  const report = buildStateReport(id);
  const closed = rawDb.prepare(
    `UPDATE state_sweeps SET status='done',phase='complete',report_json=?,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='running'`,
  ).run(JSON.stringify(report), id).changes;
  structuredLog("state_sweep.completed", { stateSweepId: id, state: parent.state, ...report.totals });
  // Continuous cadence: schedule the next opportunity-weighted cycle. Only when we
  // actually closed a running pass (never on a cancelled/already-finished row), so
  // a re-arm is armed exactly once per completed pass. Kill-switch + single-cycle
  // dedupe live in scheduleStateSweepReArm.
  if (closed) scheduleStateSweepReArm(parent);
}

function buildStateReport(id: string) {
  const parent = rawDb.prepare(`SELECT * FROM state_sweeps WHERE id=?`).get(id) as any;
  const cities = rawDb.prepare(
    `SELECT city,status,checked,fresh,coming_soon,failed,error FROM state_sweep_cities WHERE state_sweep_id=? ORDER BY seq`,
  ).all(id) as any[];
  const totals = cities.reduce(
    (t, c) => ({ checked: t.checked + c.checked, fresh: t.fresh + c.fresh, comingSoon: t.comingSoon + c.coming_soon, unresolved: t.unresolved + c.failed }),
    { checked: 0, fresh: 0, comingSoon: 0, unresolved: 0 },
  );
  return {
    state: parent.state, citiesTotal: parent.cities_total,
    citiesCompleted: cities.filter((c) => c.status === "done").length,
    citiesFailed: cities.filter((c) => c.status === "failed").length,
    totals,
    cities: cities.map((c) => ({ city: c.city, status: c.status, checked: c.checked, freshLeads: c.fresh, comingSoon: c.coming_soon, unresolved: c.failed, error: c.error })),
  };
}

export function getStateSweep(id: string, tenantId: number): any | null {
  const row = rawDb.prepare(`SELECT * FROM state_sweeps WHERE id=? AND tenant_id=?`).get(id, tenantId) as any;
  if (!row) return null;
  const cities = rawDb.prepare(
    `SELECT city,status,checked,fresh,coming_soon,failed FROM state_sweep_cities WHERE state_sweep_id=? ORDER BY seq`,
  ).all(id) as any[];
  return mapStateSweep(row, cities);
}

export function listStateSweeps(tenantId: number, limit = 10): any[] {
  return (rawDb.prepare(`SELECT * FROM state_sweeps WHERE tenant_id=? ORDER BY started_at DESC LIMIT ?`).all(tenantId, Math.min(50, limit)) as any[])
    .map((r) => mapStateSweep(r, []));
}

export function cancelStateSweep(id: string, tenantId: number): boolean {
  const parent = getStateSweep(id, tenantId);
  if (!parent) return false;
  const running = rawDb.prepare(
    `SELECT sweep_job_id FROM state_sweep_cities WHERE state_sweep_id=? AND status='running' AND sweep_job_id IS NOT NULL`,
  ).get(id) as any;
  if (running?.sweep_job_id) cancelSweep(running.sweep_job_id, tenantId);
  return rawDb.prepare(
    `UPDATE state_sweeps SET status='cancelled',phase='cancelled',completed_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND tenant_id=? AND status='running'`,
  ).run(id, tenantId).changes > 0;
}

export function resumeStateSweeps() {
  const rows = rawDb.prepare(`SELECT id FROM state_sweeps WHERE status='running'`).all() as Array<{ id: string }>;
  for (const r of rows) void runStateSweep(r.id).catch((error) => failStateSweep(r.id, error));
}

function updateState(id: string, values: Record<string, unknown>) {
  const allowed = ["status","phase","cities_completed","current_city","checked","fresh_found","coming_soon","retrying","unresolved","report_json","error","heartbeat_at","completed_at"];
  const entries = Object.entries(values).filter(([key]) => allowed.includes(key));
  if (!entries.length) return;
  rawDb.prepare(`UPDATE state_sweeps SET ${entries.map(([key]) => `${key}=?`).join(",")},updated_at=datetime('now') WHERE id=?`).run(...entries.map(([, value]) => value), id);
}
function updateCity(id: string, city: string, values: Record<string, unknown>) {
  const allowed = ["status","sweep_job_id","checked","fresh","coming_soon","failed","error","started_at","completed_at"];
  const entries = Object.entries(values).filter(([key]) => allowed.includes(key));
  if (!entries.length) return;
  rawDb.prepare(`UPDATE state_sweep_cities SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE state_sweep_id=? AND city=?`).run(...entries.map(([, value]) => value), id, city);
}
function failStateSweep(id: string, error: any) {
  updateState(id, { status: "error", phase: "error", error: String(error?.message ?? error).slice(0, 500), completed_at: now() });
  structuredLog("state_sweep.failed", { stateSweepId: id, error: String(error?.message ?? error) });
}
function mapStateSweep(r: any, cities: any[]) {
  // The compact live board: Cities complete · Addresses discovered · Checked ·
  // New Leads · Still Fresh · Coming Soon · Pending · Retried · Unresolved.
  // The four derived numbers are read-path aggregates over this sweep's city
  // jobs, so the write path (checkpointing) stays untouched.
  const jobIds = rawDb.prepare(
    `SELECT sweep_job_id AS id FROM state_sweep_cities WHERE state_sweep_id=? AND sweep_job_id IS NOT NULL`,
  ).all(r.id).map((row: any) => String(row.id));
  const ph = jobIds.map(() => "?").join(",");
  let discovered = 0, pending = 0, retried = 0, newLeads = 0, stillFresh = 0;
  if (jobIds.length) {
    const agg = rawDb.prepare(
      `SELECT COALESCE(SUM(harvested),0) AS discovered,
              COALESCE(SUM(CASE WHEN status='running' THEN MAX(0, queued - checked - failed) ELSE 0 END),0) AS pending
       FROM sweep_jobs WHERE id IN (${ph})`,
    ).get(...jobIds) as any;
    discovered = Number(agg?.discovered ?? 0);
    pending = Number(agg?.pending ?? 0);
    // Cumulative retry attempts (transient failures re-queued for another try).
    // Keyed on the sweep's tenant so idx_fiber_failures_run (tenant_id,
    // run_id, ...) can seek; filtering on run_id alone scanned the whole
    // index (823k rows on the production-shaped copy, 1.6 s cold) for every
    // row of the sweeps list.
    retried = Number((rawDb.prepare(
      `SELECT COUNT(*) AS n FROM fiber_job_failures WHERE tenant_id=? AND run_id IN (
         SELECT current_run_id FROM sweep_jobs WHERE id IN (${ph}) AND current_run_id IS NOT NULL)`,
    ).get(r.tenant_id, ...jobIds) as any)?.n ?? 0);
    // Confirmed fresh leads at addresses this sweep touched, split by whether
    // the Lead was created during this sweep (New) or already existed (Still Fresh).
    const leadSplit = rawDb.prepare(
      `SELECT SUM(CASE WHEN datetime(l.created_at) >= datetime(?) THEN 1 ELSE 0 END) AS newLeads,
              SUM(CASE WHEN datetime(l.created_at) <  datetime(?) THEN 1 ELSE 0 END) AS stillFresh
       FROM (SELECT DISTINCT t.target_id FROM sweep_job_targets t WHERE t.sweep_job_id IN (${ph})) st
       JOIN leads l ON l.source_scan_target_id=st.target_id AND l.tenant_id=? AND l.lead_tag='fresh_fiber_confirmed'`,
    ).get(r.started_at, r.started_at, ...jobIds, r.tenant_id) as any;
    newLeads = Number(leadSplit?.newLeads ?? 0);
    stillFresh = Number(leadSplit?.stillFresh ?? 0);
  }
  return {
    id: r.id, tenantId: r.tenant_id, state: r.state, status: r.status, phase: r.phase,
    citiesTotal: r.cities_total, citiesCompleted: r.cities_completed, currentCity: r.current_city,
    discovered, checked: r.checked, freshLeads: r.fresh_found, newLeads, stillFresh,
    comingSoon: r.coming_soon, pending, retried, retrying: r.retrying, unresolved: r.unresolved,
    maxChecksPerCity: r.max_checks_per_city, report: r.report_json ? safeJson(r.report_json, null) : null,
    error: r.error, startedAt: r.started_at, heartbeatAt: r.heartbeat_at, completedAt: r.completed_at,
    cities: cities.map((c) => ({ city: c.city, status: c.status, checked: c.checked, freshLeads: c.fresh, comingSoon: c.coming_soon, unresolved: c.failed })),
  };
}

// How many answers a street gets before it is judged. One is enough to be
// suggestive and cheap; two is enough to be confident on a street where the
// first address is a bad OSM record. Never zero - that would park a street
// nothing has ever asked about.
const PROBES_PER_STREET = () => Math.max(1, Math.min(5, Number(process.env.SWEEP_PROBES_PER_STREET ?? 2)));
// Off-switch for the whole prune: SWEEP_PARK_DEAD_STREETS=off checks every door,
// which is the old behaviour.
const PARK_DEAD_STREETS = () => process.env.SWEEP_PARK_DEAD_STREETS !== "off";

/**
 * Park the remainder of every street whose probes came back with no fiber.
 *
 * A street is DEAD when it has at least PROBES_PER_STREET answered doors and not
 * one of them is serviceable, coming soon, or tenured fiber - that covers both
 * failure shapes seen live: Kinetic not recognising the address at all (an OSM
 * grid over a city it does not serve) and recognising it with no service.
 *
 * Parked doors are marked 'skipped', never 'done': they carry no verdict, they
 * are not evidence, and a later sweep may pick them up when the street lights.
 */
export function parkDeadStreets(id: string): void {
  if (!PARK_DEAD_STREETS()) return;
  // EVIDENCE, not merely state='done'.
  //
  // A door only counts toward condemning its street if the provider actually
  // answered it - proved by an availability_snapshots row. 'done' alone is not
  // that: a run that enqueues nothing still finishes, and the sweep marks its
  // targets done regardless. Observed live 2026-08-24 on this exact code: 106
  // Broadway doors marked done with zero scan stamps and zero snapshots, and
  // this query condemned 31 streets on the strength of them. An unanswered door
  // is not evidence of no fiber; it is evidence of nothing.
  //
  // Note this cannot lean on last_scanned_at: an unmatched address deliberately
  // leaves it NULL so the door stays scannable, and that is a REAL answer.
  const dead = rawDb.prepare(`
    SELECT s.street_key AS streetKey FROM sweep_job_targets j
      JOIN scan_targets s ON s.id=j.target_id
     WHERE j.sweep_job_id=? AND j.state='done' AND s.street_key IS NOT NULL AND s.street_key<>''
       AND EXISTS (SELECT 1 FROM availability_snapshots a WHERE a.scan_target_id=s.id)
     GROUP BY s.street_key
    HAVING COUNT(*) >= ?
       AND SUM(CASE WHEN s.last_fiber_available=1
                      OR s.last_fiber_status IN ('new_fiber','tenured_fiber','coming_soon')
                    THEN 1 ELSE 0 END) = 0`).all(id, PROBES_PER_STREET()) as Array<{ streetKey: string }>;
  if (!dead.length) return;
  const park = rawDb.prepare(`UPDATE sweep_job_targets SET state='skipped'
     WHERE sweep_job_id=? AND state='queued'
       AND target_id IN (SELECT id FROM scan_targets WHERE street_key=?)`);
  let skipped = 0, parked = 0;
  rawDb.transaction(() => {
    for (const row of dead) {
      const changed = park.run(id, row.streetKey).changes;
      if (changed > 0) { skipped += changed; parked++; }
    }
  })();
  if (!skipped) return;
  rawDb.prepare(`UPDATE sweep_jobs SET streets_parked=streets_parked+?, doors_skipped=doors_skipped+?,
     updated_at=datetime('now') WHERE id=?`).run(parked, skipped, id);
  structuredLog("sweep.streets_parked", { sweepId: id, streets: parked, doorsSkipped: skipped }, "info");
}

async function runSweep(id: string) {
  if (active.has(id)) return; active.add(id);
  try {
    let job = rawDb.prepare(`SELECT * FROM sweep_jobs WHERE id=?`).get(id) as any;
    if (!job || job.status !== "running") return;
    if (["queued", "harvesting"].includes(job.phase)) {
      updateJob(id, { phase: "harvesting", heartbeat_at: now() });
      let harvested: { addresses: any[]; inserted: number };
      let targets: Array<{ id: number }>;
      // Probes occupy the leading seq range; 0 for a radius sweep, which has no
      // street ordering and floods straight away.
      let probeCount = 0;
      if (job.kind === "address") {
        const area = await searchAddressArea({ tenantId: job.tenant_id, query: job.query, radiusMeters: job.radius_meters });
        const lookup = rawDb.prepare(`SELECT id FROM scan_targets WHERE address=? AND lower(city)=lower(?) AND state=?`);
        const seen = new Set<number>();
        targets = [];
        for (const address of area.addresses) {
          const target = lookup.get(address.address, address.city, address.state) as { id: number } | undefined;
          if (target && !seen.has(target.id)) { seen.add(target.id); targets.push(target); }
          if (targets.length >= job.max_checks) break;
        }
        harvested = { addresses: area.addresses, inserted: area.inserted };
        job.city = area.match.city || job.query;
        job.state = area.match.state;
        updateJob(id, { city: job.city, state: job.state });
      } else {
        const cityHarvest = await getCityAddresses(job.city, job.state);
        const inserted = await upsertHarvestChunked(await normalizeHarvestRows(cityHarvest.addresses, job.tenant_id, "osm-city-sweep"));
        harvested = { addresses: cityHarvest.addresses, inserted };
        // PROBE FIRST, FLOOD SECOND. Streets are lit together, so one answer per
        // street is the cheapest way to learn whether the rest of it is worth
        // checking. selectProbe takes the middle house of the largest streets
        // first; everything else follows in flood order and is pruned as the
        // probes come back (see parkDeadStreets below).
        //
        // Measured 2026-08-24 on a blind city run: 250 Charlotte doors, 250
        // unmatched, zero answers. Ordering the same queue probe-first turns
        // that into ~1 wasted check per street instead of a whole city.
        // DO NOT PAY TO RE-LEARN A DEAD STREET.
        //
        // Parking mid-run still costs one probe per street, every run, forever.
        // A street this tenant has ALREADY answered - repeatedly, with no fiber
        // on any of it - does not deserve even that. Measured on this data:
        // Statesville answered 1,775 doors "no service" and Wingate returned 52
        // unmatched, all on streets whose verdicts were already on file.
        //
        // RESOLVED ONCE, NOT PER ROW. The first version expressed this as
        // `street_key NOT IN (SELECT ... WHERE m.tenant_id=s.tenant_id ...)`,
        // correlated to the outer row, so SQLite re-ran the whole GROUP BY /
        // HAVING aggregation for every candidate it scanned. That aggregation
        // takes ~3.6s on this database: a Lexington sweep sat in 'harvesting'
        // for 14 minutes at 98% CPU and never queued a single door. The set is
        // ~1,600 streets, so it is fetched once and applied in memory.
        //
        // Same evidence rule as the mid-run prune: only a door with a snapshot
        // counts, because an unasked door is evidence of nothing.
        // SWEEP_SKIP_KNOWN_DEAD=off queues them anyway.
        const deadEvidence = Math.max(1, Math.min(20, Number(process.env.SWEEP_DEAD_STREET_EVIDENCE ?? 3)));
        const deadStreets = process.env.SWEEP_SKIP_KNOWN_DEAD === "off" ? new Set<string>() : new Set(
          (rawDb.prepare(`
             SELECT m.street_key AS streetKey FROM scan_targets m
              WHERE m.tenant_id=? AND m.state=? AND m.street_key IS NOT NULL AND m.street_key<>''
                AND EXISTS (SELECT 1 FROM availability_snapshots a WHERE a.scan_target_id=m.id)
              GROUP BY m.street_key
             HAVING COUNT(*) >= ?
                AND SUM(CASE WHEN m.last_fiber_available=1
                               OR m.last_fiber_status IN ('new_fiber','tenured_fiber','coming_soon')
                             THEN 1 ELSE 0 END) = 0`)
            .all(job.tenant_id, job.state, deadEvidence) as Array<{ streetKey: string }>).map(r => r.streetKey));
        const rawPool = rawDb.prepare(`SELECT id, street_key AS streetKey, address FROM scan_targets
           WHERE lower(city)=lower(?) AND state=? ORDER BY (last_scanned_at IS NOT NULL),last_scanned_at LIMIT ?`)
          .all(job.city, job.state, job.max_checks) as Array<{ id: number; streetKey: string | null; address: string }>;
        const pool = rawPool.filter(r => !r.streetKey || !deadStreets.has(r.streetKey));
        if (rawPool.length !== pool.length) {
          structuredLog("sweep.known_dead_skipped", {
            sweepId: id, city: job.city, state: job.state,
            doors: rawPool.length - pool.length, deadStreets: deadStreets.size }, "info");
        }
        const candidates = pool.map((r) => ({ id: r.id, streetKey: r.streetKey ?? "", houseNumber: houseNumberOf(r.address) }));
        const streetCount = new Set(candidates.map((c) => c.streetKey || `__nostreet_${c.id}`)).size;
        const probeIds = new Set(selectProbe(candidates, Math.min(pool.length, streetCount * PROBES_PER_STREET())));
        const flood = orderFlood(candidates.filter((c) => !probeIds.has(c.id)));
        const probes = candidates.filter((c) => probeIds.has(c.id));
        probeCount = probes.length;
        targets = [...probes, ...flood].map((c) => ({ id: c.id }));
      }
      const add = rawDb.prepare(`INSERT OR IGNORE INTO sweep_job_targets (sweep_job_id,target_id,seq) VALUES (?,?,?)`);
      rawDb.transaction(() => targets.forEach((t, seq) => add.run(id, t.id, seq)))();
      updateJob(id, { phase: "checking", source: job.kind === "address" ? "osm_overpass_radius" : "osm_overpass", harvested: harvested.addresses.length, queued: targets.length, probe_count: probeCount, heartbeat_at: now() });
      structuredLog("sweep.harvested", { sweepId: id, kind: job.kind, query: job.query, city: job.city, state: job.state, harvested: harvested.addresses.length, inserted: harvested.inserted, queued: targets.length });
    }
    for (;;) {
      job = rawDb.prepare(`SELECT * FROM sweep_jobs WHERE id=?`).get(id) as any;
      if (!job || job.status !== "running") return;
      const inRun = rawDb.prepare(`SELECT run_id FROM sweep_job_targets WHERE sweep_job_id=? AND state='in_run' AND run_id IS NOT NULL LIMIT 1`).get(id) as any;
      if (inRun?.run_id) {
        const run = scanService.getRunStatus(inRun.run_id, job.tenant_id);
        if (run && ["running", "paused"].includes(run.status)) { updateProgress(id); await sleep(400); continue; } // fast poll
        rawDb.prepare(`UPDATE sweep_job_targets SET state=? WHERE sweep_job_id=? AND run_id=?`).run(run?.status === "done" ? "done" : "failed", id, inRun.run_id);
        updateProgress(id); continue;
      }
      // Everything the probes have already answered decides what still deserves a
      // check. Runs BEFORE the next batch is picked, so a parked street never
      // reaches the provider at all.
      parkDeadStreets(id);
      // THE PROBE BATCH RUNS ALONE. Measured live 2026-08-24: a 300-door Broadway
      // run put every door in ONE batch, so parkDeadStreets had nothing answered
      // to judge and parked nothing - 300 checks across 53 streets, all 300
      // unmatched, where 106 probes would have condemned every street. Probes
      // only ever share a batch with other probes; the flood waits for them to
      // land and for the prune above to run.
      const probeLimit = Number(job.probe_count ?? 0);
      const probeBatch = probeLimit > 0
        ? rawDb.prepare(`SELECT target_id FROM sweep_job_targets WHERE sweep_job_id=? AND state='queued' AND seq < ? ORDER BY seq LIMIT 5000`).all(id, probeLimit) as Array<{ target_id: number }>
        : [];
      const batch = probeBatch.length
        ? probeBatch
        : rawDb.prepare(`SELECT target_id FROM sweep_job_targets WHERE sweep_job_id=? AND state='queued' ORDER BY seq LIMIT 5000`).all(id) as Array<{ target_id: number }>;
      if (!batch.length) {
        updateProgress(id);
        updateJob(id, { phase: "complete", status: "done", completed_at: now(), heartbeat_at: now() });
        // Tenured sellables are published by persistKineticObservation as each
        // door is answered (server/kineticObservation.ts), so a sweep does not
        // publish them again here. An earlier revision on this branch ran the
        // projector per finished city; that seam is strictly worse - it waits
        // for the whole city and re-queries every door - and it is redundant now
        // that the per-door caller exists on the default branch.
        const alerts = await flushFreshOpportunityAlerts(job.tenant_id);
        const completed = rawDb.prepare(`SELECT * FROM sweep_jobs WHERE id=?`).get(id) as any;
        structuredLog("sweep.completed", { sweepId: id, kind: job.kind, query: job.query, checked: completed.checked, freshFound: completed.fresh_found, opportunitiesFound: completed.opportunities_found, alerts: JSON.stringify(alerts) });
        return;
      }
      const run = scanService.startTargetRun({ tenantId: job.tenant_id, city: job.city, state: job.state, targetIds: batch.map((r) => r.target_id), createdBy: job.created_by, runKind: "city-sweep", label: `City sweep · ${job.city}, ${job.state}` });
      // ASSERT THE RUN ACTUALLY TOOK THE WORK. startTargetRun reports how many
      // targets it enqueued, and it can be ZERO - a target already held by
      // another (often long-abandoned) running run is not re-enqueued. The run
      // then finishes immediately, the sweep marks its batch done, and the whole
      // job reports "checked" for doors nothing ever asked about. Observed live:
      // 300 Broadway doors and 84 Rockwell doors "checked" with no provider call
      // behind any of them, because 715 stale running runs held 772k targets.
      if (!run.queued) {
        failSweep(id, new Error(
          `NO_TARGETS_ENQUEUED: the run took 0 of ${batch.length} targets. They are held by other running runs - clear stale runs before sweeping.`));
        return;
      }
      const marks = batch.map(() => "?").join(",");
      rawDb.prepare(`UPDATE sweep_job_targets SET state='in_run',run_id=? WHERE sweep_job_id=? AND target_id IN (${marks})`).run(run.runId, id, ...batch.map((r) => r.target_id));
      updateJob(id, { current_run_id: run.runId, heartbeat_at: now() });
    }
  } finally { active.delete(id); }
}

function updateProgress(id: string) {
  const job = rawDb.prepare(`SELECT * FROM sweep_jobs WHERE id=?`).get(id) as any; if (!job) return;
  const state = rawDb.prepare(`SELECT SUM(state='done') done,SUM(state='failed') failed FROM sweep_job_targets WHERE sweep_job_id=?`).get(id) as any;
  // SELLABLE MEANS "a rep can knock it": fiber at the address and nobody paying
  // for it. It does NOT mean the door flipped during this sweep - that is what
  // fresh_found counts, and the two are different questions.
  //
  // This used to require first_seen_fiber_at >= started_at, so a tenured door
  // that has had fiber for months could never qualify. Measured live: Lexington
  // reported SELLABLE 0 while 101 of its doors came back tenured fiber with
  // billing N, and Wingate reported 11 while holding another 106. The tile
  // promised "fiber, nobody on it" and counted something else.
  // THE STANDING TOTAL: every door among this sweep's targets that is sellable
  // right now, whenever it was answered. Useful, but it is not what this run
  // found, and a city with history shows a large number before a single check
  // completes - which is exactly how a Broadway run displayed 675 at the moment
  // it started checking.
  const opportunity = rawDb.prepare(`SELECT COUNT(*) n
     FROM sweep_job_targets j JOIN scan_targets s ON s.id=j.target_id
    WHERE j.sweep_job_id=? AND s.last_billing_status='N'
      AND (s.last_fiber_available=1 OR s.last_fiber_status IN ('new_fiber','tenured_fiber'))`).get(id) as any;
  // WHAT THIS SWEEP ACTUALLY ASKED. A snapshot carries the run that produced it,
  // and this sweep owns its run ids, so the join is exact. DISTINCT because a
  // retried door writes more than one snapshot in the same run.
  const answered = rawDb.prepare(`SELECT COUNT(DISTINCT a.scan_target_id) n
     FROM sweep_job_targets j
     JOIN availability_snapshots a ON a.scan_target_id=j.target_id AND a.run_id=j.run_id
    WHERE j.sweep_job_id=? AND j.run_id IS NOT NULL`).get(id) as any;
  // ...and what those answers found: sellable ON THIS RUN'S OWN EVIDENCE.
  const sellableFound = rawDb.prepare(`SELECT COUNT(DISTINCT a.scan_target_id) n
     FROM sweep_job_targets j
     JOIN availability_snapshots a ON a.scan_target_id=j.target_id AND a.run_id=j.run_id
    WHERE j.sweep_job_id=? AND j.run_id IS NOT NULL AND a.conclusive=1
      AND upper(COALESCE(a.billing_status,''))='N'
      AND (a.fiber_available=1
           OR upper(COALESCE(a.household_segment_type,'')) IN ('NEW FIBER','TENURED'))`).get(id) as any;
  const fresh = rawDb.prepare(`SELECT COUNT(*) n FROM sweep_job_targets j JOIN scan_targets s ON s.id=j.target_id WHERE j.sweep_job_id=? AND s.first_seen_fiber_at>=?`).get(id, job.started_at) as any;
  updateJob(id, {
    checked: Number(state.done ?? 0) + Number(state.failed ?? 0),
    failed: Number(state.failed ?? 0),
    answered: answered.n, sellable_found: sellableFound.n,
    fresh_found: fresh.n, opportunities_found: opportunity.n, heartbeat_at: now(),
  });
}

function updateJob(id: string, values: Record<string, unknown>) {
  const allowed = ["city","state","phase","status","source","harvested","queued","checked","failed","answered","sellable_found","fresh_found","opportunities_found","probe_count","current_run_id","error","heartbeat_at","completed_at"];
  // A key that is not on the list used to be dropped in SILENCE. probe_count was
  // written here, never stored, and the probe batch it gates read back as 0 - so
  // a live Broadway run checked all 300 doors across 53 dead streets and parked
  // nothing, twice, with no error anywhere. An unknown column is a programmer
  // error, so it fails loudly now; every caller in this file passes known keys.
  const unknown = Object.keys(values).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`updateJob: unknown sweep_jobs column(s): ${unknown.join(", ")}`);
  const entries = Object.entries(values); if (!entries.length) return;
  rawDb.prepare(`UPDATE sweep_jobs SET ${entries.map(([key]) => `${key}=?`).join(",")},updated_at=datetime('now') WHERE id=?`).run(...entries.map(([, value]) => value), id);
}
function failSweep(id: string, error: any) { updateJob(id, { status: "error", phase: "error", error: String(error?.message ?? error).slice(0, 500), completed_at: now() }); structuredLog("sweep.failed", { sweepId: id, error: String(error?.message ?? error) }); }
function mapJob(r: any) { return { id: r.id, tenantId: r.tenant_id, kind: r.kind, query: r.query, city: r.city, state: r.state, radiusMeters: r.radius_meters, phase: r.phase, status: r.status, source: r.source, harvested: r.harvested, queued: r.queued, checked: r.checked, failed: r.failed, freshFound: r.fresh_found, opportunitiesFound: r.opportunities_found,
  answered: r.answered ?? 0, sellableFound: r.sellable_found ?? 0, streetsParked: r.streets_parked ?? 0, doorsSkipped: r.doors_skipped ?? 0, probeCount: r.probe_count ?? 0, maxChecks: r.max_checks, currentRunId: r.current_run_id, error: r.error, startedAt: r.started_at, heartbeatAt: r.heartbeat_at, completedAt: r.completed_at }; }
function now() { return new Date().toISOString(); }
function iso(value: string) { return new Date(String(value).includes("T") ? value : String(value).replace(" ", "T") + "Z").toISOString(); }
function safeJson(value: string | null, fallback: any) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
