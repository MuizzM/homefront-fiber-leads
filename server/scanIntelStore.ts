// ── Scan-intelligence data access ─────────────────────────────────────────────
// All the DB reads/writes for the market-intelligence + budgeted-scan system.
// Kept out of the 1,500-line storage.ts, using the same raw better-sqlite3 handle
// and the same tenant-scoping discipline. NOTHING here touches the proxy — these
// are pure DB operations over data the product already accumulated.
import { rawDb } from "./db";
import type { MarketAggregate } from "@shared/marketIntel";

const g = <T = any>(sql: string, ...args: any[]): T => rawDb.prepare(sql).get(...args) as T;
const all = <T = any>(sql: string, ...args: any[]): T[] => rawDb.prepare(sql).all(...args) as T[];

// ── Market aggregates ─────────────────────────────────────────────────────────
// One pass over the pool + leads + knocks + field outcomes → per-city rollups.
// Everything is tenant-scoped. Pool rows may have tenant_id NULL (platform
// harvest), so pool aggregates are NOT tenant-filtered (the address inventory is
// shared), but leads/knocks/outcomes — the operational data — ARE.
export function getMarketAggregates(tenantId: number): MarketAggregate[] {
  // Pool coverage per city (shared inventory; not tenant-scoped).
  const pool = all<{ city: string; state: string; poolSize: number; verified: number; verifiedNewFiber: number; newlyLive: number; lastVerifiedAt: string | null }>(
    `SELECT city, state,
            COUNT(*) AS poolSize,
            SUM(CASE WHEN scan_count > 0 THEN 1 ELSE 0 END) AS verified,
            SUM(CASE WHEN last_is_new_fiber = 1 AND last_billing_status = 'N' THEN 1 ELSE 0 END) AS verifiedNewFiber,
            SUM(CASE WHEN first_seen_live_at IS NOT NULL AND first_seen_live_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS newlyLive,
            MAX(last_scanned_at) AS lastVerifiedAt
       FROM scan_targets
      GROUP BY lower(city), lower(state)`,
  );

  // Lead operational rollup per city (tenant-scoped).
  const leadAgg = all<{ city: string; state: string; leads: number; worked: number; unworked: number; sold: number }>(
    `SELECT l.city AS city, l.state AS state,
            COUNT(*) AS leads,
            SUM(CASE WHEN k.c > 0 THEN 1 ELSE 0 END) AS worked,
            SUM(CASE WHEN k.c IS NULL OR k.c = 0 THEN 1 ELSE 0 END) AS unworked,
            SUM(CASE WHEN l.lead_status = 'sold' THEN 1 ELSE 0 END) AS sold
       FROM leads l
       LEFT JOIN (SELECT lead_id, COUNT(*) c FROM knock_log GROUP BY lead_id) k ON k.lead_id = l.id
      WHERE l.tenant_id = ? AND l.city IS NOT NULL
      GROUP BY lower(l.city), lower(l.state)`,
    tenantId,
  );
  const leadByCity = new Map(leadAgg.map(r => [key(r.city, r.state), r]));

  // Field-outcome memory per city (tenant-scoped).
  const outcomes = all<{ city: string; state: string; knocks: number; contacts: number; sales: number; lastDeployedAt: string | null }>(
    `SELECT city, state, knocks, contacts, sales, last_deployed_at AS lastDeployedAt
       FROM market_outcomes WHERE tenant_id = ?`,
    tenantId,
  );
  const outcomeByCity = new Map(outcomes.map(r => [key(r.city, r.state), r]));

  return pool.map(p => {
    const lo = leadByCity.get(key(p.city, p.state));
    const oc = outcomeByCity.get(key(p.city, p.state));
    return {
      city: p.city, state: p.state,
      poolSize: p.poolSize, verified: p.verified ?? 0,
      verifiedNewFiber: p.verifiedNewFiber ?? 0, newlyLive: p.newlyLive ?? 0,
      leads: lo?.leads ?? 0, unworkedLeads: lo?.unworked ?? 0, workedLeads: lo?.worked ?? 0, soldLeads: lo?.sold ?? 0,
      lastVerifiedAtMs: p.lastVerifiedAt ? Date.parse(p.lastVerifiedAt + "Z") || Date.parse(p.lastVerifiedAt) : null,
      outcome: oc ? {
        knocks: oc.knocks, contacts: oc.contacts, sales: oc.sales,
        lastDeployedAtMs: oc.lastDeployedAt ? Date.parse(oc.lastDeployedAt + "Z") || Date.parse(oc.lastDeployedAt) : null,
      } : null,
    };
  });
}

// Known new-fiber points (verified pool + existing leads) for a city — the
// "proximity to known opportunity" signal that drives budgeted target ranking.
export function getKnownNewFiberPoints(tenantId: number, city?: string, state = "NC"): Array<{ lat: number; lng: number }> {
  const rows = city
    ? all<{ lat: number; lng: number }>(
        `SELECT lat, lng FROM scan_targets WHERE last_is_new_fiber = 1 AND lat IS NOT NULL AND lower(city)=lower(?) AND lower(state)=lower(?)
         UNION ALL
         SELECT lat, lng FROM leads WHERE tenant_id=? AND is_new_fiber=1 AND lat IS NOT NULL AND lower(city)=lower(?)`,
        city, state, tenantId, city,
      )
    : all<{ lat: number; lng: number }>(
        `SELECT lat, lng FROM leads WHERE tenant_id=? AND is_new_fiber=1 AND lat IS NOT NULL`, tenantId);
  return rows.filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

// Unverified (or oldest-verified) pool targets for a city, as ranking input.
// Bounded so a huge city can't blow memory — we only ever need `cap` candidates
// to select a `budget` from, and cap >> any realistic single-run budget.
export function getPoolTargetsForCity(city: string, state: string, cap = 20_000): Array<{ id: number; lat: number | null; lng: number | null; lastScannedAtMs: number | null; lastIsNewFiber: boolean; opportunityScore: number | null }> {
  const rows = all<any>(
    `SELECT id, lat, lng, last_scanned_at AS lastScannedAt, last_is_new_fiber AS lastIsNewFiber, opportunity_score AS opportunityScore
       FROM scan_targets
      WHERE lower(city)=lower(?) AND lower(state)=lower(?) AND lat IS NOT NULL
      ORDER BY (last_scanned_at IS NOT NULL), last_scanned_at ASC
      LIMIT ?`,
    city, state, cap,
  );
  return rows.map(r => ({
    id: r.id, lat: r.lat, lng: r.lng,
    lastScannedAtMs: r.lastScannedAt ? Date.parse(r.lastScannedAt + "Z") || Date.parse(r.lastScannedAt) : null,
    lastIsNewFiber: !!r.lastIsNewFiber,
    opportunityScore: r.opportunityScore ?? null,
  }));
}

// Verified opportunity points for the map/clustering: verified new-fiber pool
// rows + tenant leads, unified into OppPoint-shaped rows with signal fields.
export function getOpportunityPoints(tenantId: number, bbox?: { minLat: number; maxLat: number; minLng: number; maxLng: number }): Array<any> {
  const box = bbox ? `AND lat BETWEEN ${num(bbox.minLat)} AND ${num(bbox.maxLat)} AND lng BETWEEN ${num(bbox.minLng)} AND ${num(bbox.maxLng)}` : "";
  // Leads carry the richest signal (worked/sold via knocks, competitor, score).
  return all<any>(
    `SELECT l.id AS id, l.lat AS lat, l.lng AS lng, 1 AS isNewFiber,
            CASE WHEN k.c > 0 THEN 1 ELSE 0 END AS worked,
            CASE WHEN l.lead_status='sold' THEN 1 ELSE 0 END AS sold,
            l.lead_score AS leadScore, l.competitor_name AS competitor,
            0 AS newlyLive, NULL AS verifiedAtMs
       FROM leads l
       LEFT JOIN (SELECT lead_id, COUNT(*) c FROM knock_log GROUP BY lead_id) k ON k.lead_id = l.id
      WHERE l.tenant_id=? AND l.is_new_fiber=1 AND l.lat IS NOT NULL ${box}`,
    tenantId,
  );
}

// ── scan_runs lifecycle (resumable persisted jobs) ────────────────────────────
export interface ScanRunRow {
  id: string; tenantId: number; kind: string; label: string;
  city: string | null; state: string | null; bbox: string | null;
  budget: number; verified: number; newFiber: number; newlyLive: number; failed: number;
  status: string; error: string | null; estBytes: number; createdBy: number | null;
  startedAt: string; heartbeatAt: string | null; completedAt: string | null;
}

export function createScanRun(r: {
  id: string; tenantId: number; kind: string; label: string; city?: string | null; state?: string | null;
  bbox?: string | null; budget: number; createdBy?: number | null;
}): void {
  rawDb.prepare(
    `INSERT INTO scan_runs (id, tenant_id, kind, label, city, state, bbox, budget, status, heartbeat_at, created_by)
     VALUES (@id,@tenantId,@kind,@label,@city,@state,@bbox,@budget,'running',datetime('now'),@createdBy)`,
  ).run({ id: r.id, tenantId: r.tenantId, kind: r.kind, label: r.label, city: r.city ?? null, state: r.state ?? null, bbox: r.bbox ?? null, budget: r.budget, createdBy: r.createdBy ?? null });
}

export function enqueueRunTargets(runId: string, ranked: Array<{ id: number; seq: number }>): void {
  const stmt = rawDb.prepare(`INSERT OR IGNORE INTO scan_run_targets (run_id, target_id, seq, state) VALUES (?,?,?,'queued')`);
  const tx = rawDb.transaction((rows: Array<{ id: number; seq: number }>) => {
    for (const row of rows) stmt.run(runId, row.id, row.seq);
  });
  tx(ranked);
}

// Next batch of queued targets for a run, in priority order — the resume queue.
export function getQueuedRunTargets(runId: string, limit: number): Array<{ targetId: number; seq: number; address: string; city: string; state: string; zip: string; lat: number | null; lng: number | null }> {
  return all<any>(
    `SELECT t.target_id AS targetId, t.seq AS seq, st.address, st.city, st.state, st.zip, st.lat, st.lng
       FROM scan_run_targets t JOIN scan_targets st ON st.id = t.target_id
      WHERE t.run_id=? AND t.state='queued' ORDER BY t.seq ASC LIMIT ?`,
    runId, limit,
  );
}

export function markRunTarget(runId: string, targetId: number, state: "verified" | "failed" | "skipped", result: string | null): void {
  rawDb.prepare(`UPDATE scan_run_targets SET state=?, result=? WHERE run_id=? AND target_id=?`).run(state, result, runId, targetId);
}

// Atomic per-check counter bump on the run (progress evidence).
export function bumpRun(runId: string, delta: { verified?: number; newFiber?: number; newlyLive?: number; failed?: number; estBytes?: number }): void {
  rawDb.prepare(
    `UPDATE scan_runs SET
        verified = verified + @verified, new_fiber = new_fiber + @newFiber,
        newly_live = newly_live + @newlyLive, failed = failed + @failed,
        est_bytes = est_bytes + @estBytes, heartbeat_at = datetime('now')
      WHERE id = @runId`,
  ).run({ runId, verified: delta.verified ?? 0, newFiber: delta.newFiber ?? 0, newlyLive: delta.newlyLive ?? 0, failed: delta.failed ?? 0, estBytes: delta.estBytes ?? 0 });
}

export function setRunStatus(runId: string, status: string, error?: string | null): void {
  const done = status === "done" || status === "error" || status === "cancelled";
  rawDb.prepare(
    `UPDATE scan_runs SET status=?, error=?, heartbeat_at=datetime('now'), completed_at=${done ? "datetime('now')" : "completed_at"} WHERE id=?`,
  ).run(status, error ?? null, runId);
}

export function getRun(runId: string, tenantId: number): ScanRunRow | undefined {
  return g<ScanRunRow>(
    `SELECT id, tenant_id AS tenantId, kind, label, city, state, bbox, budget, verified, new_fiber AS newFiber,
            newly_live AS newlyLive, failed, status, error, est_bytes AS estBytes, created_by AS createdBy,
            started_at AS startedAt, heartbeat_at AS heartbeatAt, completed_at AS completedAt
       FROM scan_runs WHERE id=? AND tenant_id=?`,
    runId, tenantId,
  );
}

export function listRuns(tenantId: number, limit = 20): ScanRunRow[] {
  return all<ScanRunRow>(
    `SELECT id, tenant_id AS tenantId, kind, label, city, state, bbox, budget, verified, new_fiber AS newFiber,
            newly_live AS newlyLive, failed, status, error, est_bytes AS estBytes, created_by AS createdBy,
            started_at AS startedAt, heartbeat_at AS heartbeatAt, completed_at AS completedAt
       FROM scan_runs WHERE tenant_id=? ORDER BY started_at DESC LIMIT ?`,
    tenantId, limit,
  );
}

// Runs that were 'running' when the process died — the resume set. Only runs
// whose heartbeat is stale (no live worker) to avoid double-dispatch.
export function getResumableRuns(staleSeconds = 30): ScanRunRow[] {
  return all<ScanRunRow>(
    `SELECT id, tenant_id AS tenantId, kind, label, city, state, bbox, budget, verified, new_fiber AS newFiber,
            newly_live AS newlyLive, failed, status, error, est_bytes AS estBytes, created_by AS createdBy,
            started_at AS startedAt, heartbeat_at AS heartbeatAt, completed_at AS completedAt
       FROM scan_runs
      WHERE status='running' AND (heartbeat_at IS NULL OR heartbeat_at <= datetime('now', ?))`,
    `-${staleSeconds} seconds`,
  );
}

export function countQueued(runId: string): number {
  return g<{ c: number }>(`SELECT COUNT(*) c FROM scan_run_targets WHERE run_id=? AND state='queued'`, runId).c;
}

// ── Per-target scan memory (used by the live engine) ──────────────────────────
export function getTargetSnapshot(id: number): { everScanned: boolean; wasLive: boolean } {
  const r = g<any>(`SELECT last_scanned_at AS s, last_is_new_fiber AS nf, last_billing_status AS bs FROM scan_targets WHERE id=?`, id);
  if (!r) return { everScanned: false, wasLive: false };
  return { everScanned: !!r.s, wasLive: !!r.nf && r.bs === "N" };
}

// ── Market outcome memory (learning loop write path) ──────────────────────────
export function accumulateMarketOutcome(tenantId: number, city: string, state: string, d: { doors: number; knocks: number; contacts: number; sales: number }): void {
  rawDb.prepare(
    `INSERT INTO market_outcomes (tenant_id, city, state, territories_worked, doors, knocks, contacts, sales, last_deployed_at, updated_at)
     VALUES (@t,@c,@s,1,@doors,@knocks,@contacts,@sales,datetime('now'),datetime('now'))
     ON CONFLICT(tenant_id, city, state) DO UPDATE SET
       territories_worked = territories_worked + 1,
       doors = doors + @doors, knocks = knocks + @knocks,
       contacts = contacts + @contacts, sales = sales + @sales,
       last_deployed_at = datetime('now'), updated_at = datetime('now')`,
  ).run({ t: tenantId, c: city, s: state, doors: d.doors, knocks: d.knocks, contacts: d.contacts, sales: d.sales });
}

function key(city: string, state: string): string { return `${(city || "").toLowerCase()}|${(state || "").toLowerCase()}`; }
function num(n: number): number { return Number.isFinite(n) ? n : 0; }
