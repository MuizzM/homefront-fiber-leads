import crypto from "node:crypto";
import { rawDb } from "./db";
import { storage } from "./storage";
import { getCityAddresses, pullAddressesFromOverpass } from "./overpass";
import * as scanService from "./scanService";
import { clusterFreshFiber, type FreshFiberPoint } from "@shared/freshFiberClusters";
import { opportunityRank } from "@shared/opportunitySegment";
import { toCsv } from "./stateMonitorStore";
import { structuredLog } from "./structuredLog";
import { flushFreshOpportunityAlerts } from "./stateMonitorScheduler";

const active = new Set<string>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// No cap — a sweep checks every discovered address in the market. Outbound
// provider rate stays governed by the scheduler + 403/429 backoff (correctness).
const MAX_SWEEP_CHECKS = () => Number.MAX_SAFE_INTEGER;

export interface StartSweepInput { tenantId: number; city: string; state: "NC" | "SC"; maxChecks?: number; createdBy?: number | null; }
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
  const state = String(hit.address?.state_code ?? isoState.split("-").pop() ?? "").toUpperCase()
    || (stateName === "north carolina" ? "NC" : stateName === "south carolina" ? "SC" : "");
  if (!(["NC", "SC"].includes(state))) throw new Error("OUTSIDE_SUPPORTED_STATES");
  const city = hit.address?.city ?? hit.address?.town ?? hit.address?.village ?? hit.address?.municipality ?? "";
  const latDelta = input.radiusMeters / 111_320;
  const lngDelta = input.radiusMeters / (111_320 * Math.cos(lat * Math.PI / 180));
  const addresses = await pullAddressesFromOverpass({ south: lat - latDelta, north: lat + latDelta, west: lng - lngDelta, east: lng + lngDelta }, city, state);
  const inserted = storage.upsertScanTargets(addresses.map((a) => ({ ...a, tenantId: input.tenantId, source: "osm-address-radius" })));
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
  for (const job of jobs) void runSweep(job.id).catch((error) => failSweep(job.id, error));
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

export interface StartStateSweepInput { tenantId: number; state: "NC" | "SC"; createdBy?: number | null; maxChecksPerCity?: number; }

/** Every scan-eligible market in the state's catalog, de-duped case-insensitively. */
function stateCities(state: "NC" | "SC"): string[] {
  const rows = rawDb.prepare(
    `SELECT city FROM state_fiber_markets WHERE state=? AND auto_scan_eligible=1 ORDER BY city`,
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

async function runStateSweep(id: string) {
  if (activeState.has(id)) return; activeState.add(id);
  try {
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
          break;
        }
        await sleep(2_000);
      }
    }
  } finally { activeState.delete(id); }
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
// account (billing_status='Y') — a planned/soon build to watch, stored separately
// in kinetic_addresses (is_coming_soon) by the scan engine and rechecked nightly.
function comingSoonCount(sweepId: string): number {
  const row = rawDb.prepare(
    `SELECT COUNT(*) n FROM sweep_job_targets j JOIN scan_targets s ON s.id=j.target_id
     JOIN availability_snapshots a ON a.id=(SELECT a2.id FROM availability_snapshots a2 WHERE a2.scan_target_id=s.id ORDER BY a2.checked_at_epoch DESC, a2.id DESC LIMIT 1)
     WHERE j.sweep_job_id=? AND upper(COALESCE(a.household_segment_type,'')) LIKE '%NEW FIBER%' AND COALESCE(a.billing_status,'')='Y'`,
  ).get(sweepId) as any;
  return Number(row?.n ?? 0);
}

function finishStateSweep(id: string) {
  aggregateState(id);
  const parent = rawDb.prepare(`SELECT * FROM state_sweeps WHERE id=?`).get(id) as any;
  if (!parent) return;
  const report = buildStateReport(id);
  rawDb.prepare(
    `UPDATE state_sweeps SET status='done',phase='complete',report_json=?,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='running'`,
  ).run(JSON.stringify(report), id);
  structuredLog("state_sweep.completed", { stateSweepId: id, state: parent.state, ...report.totals });
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
    retried = Number((rawDb.prepare(
      `SELECT COUNT(*) AS n FROM fiber_job_failures WHERE run_id IN (
         SELECT current_run_id FROM sweep_jobs WHERE id IN (${ph}) AND current_run_id IS NOT NULL)`,
    ).get(...jobIds) as any)?.n ?? 0);
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

async function runSweep(id: string) {
  if (active.has(id)) return; active.add(id);
  try {
    let job = rawDb.prepare(`SELECT * FROM sweep_jobs WHERE id=?`).get(id) as any;
    if (!job || job.status !== "running") return;
    if (["queued", "harvesting"].includes(job.phase)) {
      updateJob(id, { phase: "harvesting", heartbeat_at: now() });
      let harvested: { addresses: any[]; inserted: number };
      let targets: Array<{ id: number }>;
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
        const inserted = storage.upsertScanTargets(cityHarvest.addresses.map((a) => ({ ...a, tenantId: job.tenant_id, source: "osm-city-sweep" })));
        harvested = { addresses: cityHarvest.addresses, inserted };
        targets = rawDb.prepare(`SELECT id FROM scan_targets WHERE lower(city)=lower(?) AND state=? ORDER BY (last_scanned_at IS NOT NULL),last_scanned_at LIMIT ?`).all(job.city, job.state, job.max_checks) as Array<{ id: number }>;
      }
      const add = rawDb.prepare(`INSERT OR IGNORE INTO sweep_job_targets (sweep_job_id,target_id,seq) VALUES (?,?,?)`);
      rawDb.transaction(() => targets.forEach((t, seq) => add.run(id, t.id, seq)))();
      updateJob(id, { phase: "checking", source: job.kind === "address" ? "osm_overpass_radius" : "osm_overpass", harvested: harvested.addresses.length, queued: targets.length, heartbeat_at: now() });
      structuredLog("sweep.harvested", { sweepId: id, kind: job.kind, query: job.query, city: job.city, state: job.state, harvested: harvested.addresses.length, inserted: harvested.inserted, queued: targets.length });
    }
    for (;;) {
      job = rawDb.prepare(`SELECT * FROM sweep_jobs WHERE id=?`).get(id) as any;
      if (!job || job.status !== "running") return;
      const inRun = rawDb.prepare(`SELECT run_id FROM sweep_job_targets WHERE sweep_job_id=? AND state='in_run' AND run_id IS NOT NULL LIMIT 1`).get(id) as any;
      if (inRun?.run_id) {
        const run = scanService.getRunStatus(inRun.run_id, job.tenant_id);
        if (run && ["running", "paused"].includes(run.status)) { updateProgress(id); await sleep(2_000); continue; }
        rawDb.prepare(`UPDATE sweep_job_targets SET state=? WHERE sweep_job_id=? AND run_id=?`).run(run?.status === "done" ? "done" : "failed", id, inRun.run_id);
        updateProgress(id); continue;
      }
      const batch = rawDb.prepare(`SELECT target_id FROM sweep_job_targets WHERE sweep_job_id=? AND state='queued' ORDER BY seq LIMIT 5000`).all(id) as Array<{ target_id: number }>;
      if (!batch.length) {
        updateProgress(id);
        updateJob(id, { phase: "complete", status: "done", completed_at: now(), heartbeat_at: now() });
        const alerts = await flushFreshOpportunityAlerts(job.tenant_id);
        const completed = rawDb.prepare(`SELECT * FROM sweep_jobs WHERE id=?`).get(id) as any;
        structuredLog("sweep.completed", { sweepId: id, kind: job.kind, query: job.query, checked: completed.checked, freshFound: completed.fresh_found, opportunitiesFound: completed.opportunities_found, alerts: JSON.stringify(alerts) });
        return;
      }
      const run = scanService.startTargetRun({ tenantId: job.tenant_id, city: job.city, state: job.state, targetIds: batch.map((r) => r.target_id), createdBy: job.created_by, runKind: "city-sweep", label: `City sweep · ${job.city}, ${job.state}` });
      const marks = batch.map(() => "?").join(",");
      rawDb.prepare(`UPDATE sweep_job_targets SET state='in_run',run_id=? WHERE sweep_job_id=? AND target_id IN (${marks})`).run(run.runId, id, ...batch.map((r) => r.target_id));
      updateJob(id, { current_run_id: run.runId, heartbeat_at: now() });
    }
  } finally { active.delete(id); }
}

function updateProgress(id: string) {
  const job = rawDb.prepare(`SELECT * FROM sweep_jobs WHERE id=?`).get(id) as any; if (!job) return;
  const state = rawDb.prepare(`SELECT SUM(state='done') done,SUM(state='failed') failed FROM sweep_job_targets WHERE sweep_job_id=?`).get(id) as any;
  const opportunity = rawDb.prepare(`SELECT COUNT(*) n FROM sweep_job_targets j JOIN scan_targets s ON s.id=j.target_id WHERE j.sweep_job_id=? AND s.first_seen_fiber_at>=? AND s.last_customer_segment='new_opportunity'`).get(id, job.started_at) as any;
  const fresh = rawDb.prepare(`SELECT COUNT(*) n FROM sweep_job_targets j JOIN scan_targets s ON s.id=j.target_id WHERE j.sweep_job_id=? AND s.first_seen_fiber_at>=?`).get(id, job.started_at) as any;
  updateJob(id, { checked: Number(state.done ?? 0) + Number(state.failed ?? 0), failed: Number(state.failed ?? 0), fresh_found: fresh.n, opportunities_found: opportunity.n, heartbeat_at: now() });
}

function updateJob(id: string, values: Record<string, unknown>) {
  const allowed = ["city","state","phase","status","source","harvested","queued","checked","failed","fresh_found","opportunities_found","current_run_id","error","heartbeat_at","completed_at"];
  const entries = Object.entries(values).filter(([key]) => allowed.includes(key)); if (!entries.length) return;
  rawDb.prepare(`UPDATE sweep_jobs SET ${entries.map(([key]) => `${key}=?`).join(",")},updated_at=datetime('now') WHERE id=?`).run(...entries.map(([, value]) => value), id);
}
function failSweep(id: string, error: any) { updateJob(id, { status: "error", phase: "error", error: String(error?.message ?? error).slice(0, 500), completed_at: now() }); structuredLog("sweep.failed", { sweepId: id, error: String(error?.message ?? error) }); }
function mapJob(r: any) { return { id: r.id, tenantId: r.tenant_id, kind: r.kind, query: r.query, city: r.city, state: r.state, radiusMeters: r.radius_meters, phase: r.phase, status: r.status, source: r.source, harvested: r.harvested, queued: r.queued, checked: r.checked, failed: r.failed, freshFound: r.fresh_found, opportunitiesFound: r.opportunities_found, maxChecks: r.max_checks, currentRunId: r.current_run_id, error: r.error, startedAt: r.started_at, heartbeatAt: r.heartbeat_at, completedAt: r.completed_at }; }
function now() { return new Date().toISOString(); }
function iso(value: string) { return new Date(String(value).includes("T") ? value : String(value).replace(" ", "T") + "Z").toISOString(); }
function safeJson(value: string | null, fallback: any) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
