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
const MAX_SWEEP_CHECKS = () => Math.max(1, Math.min(100_000, Number(process.env.MAX_CITY_SWEEP_CHECKS ?? 50_000)));

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
