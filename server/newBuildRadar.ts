// ── New Build Radar ───────────────────────────────────────────────────────────
// Continuously watches free NC/SC sources (NC OneMap authoritative address points
// + SC county E911/GIS address layers + OSM Overpass newer:) for newly-appearing
// addresses and buildings, dedups them
// against a durable inventory (preserving every source + detection date), monitors
// ADDRESSLESS new buildings until an address appears, detects construction
// clusters, and — the revenue path — the moment a valid new address appears it is
// enqueued into the EXISTING Fiber Intelligence scan pipeline (upsertScanTargets +
// startTargetRun) so Kinetic checks it immediately and the shared projector
// publishes a Lead on NEW FIBER + billingStatus=N. Per-county source coverage
// (incl. remaining gaps like the missing SC statewide feed) is tracked and exposed.
//
// This does NOT rebuild discovery/queue/leads — it reuses them. It never touches
// Mapbox (billing history) or the Decodo proxy (Kinetic-only); gov/OSM are direct.
import { rawDb } from "./db";
import { getDefaultTenantId } from "./storage";
import { storage } from "./storage";
import { startTargetRun } from "./scanService";
import { normalizeKineticAddressKey } from "./scanner";
import { structuredLog } from "./structuredLog";
import {
  pollNcOneMapCounty, pollOverpassArea, fetchNcOneMapRecent, pollScCountyAddresses,
  SC_COUNTY_SOURCES, SC_COUNTY_SOURCE_ID,
  type NewBuildCandidate, type OverpassArea, type SourcePollResult, type ScCountySource,
} from "./newBuildSources";

// ── Scopes ────────────────────────────────────────────────────────────────────
// Every NC county (NC OneMap is county-queryable → "all NC" authoritative), the
// verified SC county E911/GIS address layers (Kinetic SC markets), plus Overpass
// tiles covering NC+SC for observed new builds / addressless monitoring. What
// still has no live authoritative feed is registered as a GAP.
const NC_COUNTIES = [
  "ALAMANCE","ALEXANDER","ALLEGHANY","ANSON","ASHE","AVERY","BEAUFORT","BERTIE","BLADEN","BRUNSWICK",
  "BUNCOMBE","BURKE","CABARRUS","CALDWELL","CAMDEN","CARTERET","CASWELL","CATAWBA","CHATHAM","CHEROKEE",
  "CHOWAN","CLAY","CLEVELAND","COLUMBUS","CRAVEN","CUMBERLAND","CURRITUCK","DARE","DAVIDSON","DAVIE",
  "DUPLIN","DURHAM","EDGECOMBE","FORSYTH","FRANKLIN","GASTON","GATES","GRAHAM","GRANVILLE","GREENE",
  "GUILFORD","HALIFAX","HARNETT","HAYWOOD","HENDERSON","HERTFORD","HOKE","HYDE","IREDELL","JACKSON",
  "JOHNSTON","JONES","LEE","LENOIR","LINCOLN","MACON","MADISON","MARTIN","MCDOWELL","MECKLENBURG",
  "MITCHELL","MONTGOMERY","MOORE","NASH","NEW HANOVER","NORTHAMPTON","ONSLOW","ORANGE","PAMLICO","PASQUOTANK",
  "PENDER","PERQUIMANS","PERSON","PITT","POLK","RANDOLPH","RICHMOND","ROBESON","ROCKINGHAM","ROWAN",
  "RUTHERFORD","SAMPSON","SCOTLAND","STANLY","STOKES","SURRY","SWAIN","TRANSYLVANIA","TYRRELL","UNION",
  "VANCE","WAKE","WARREN","WASHINGTON","WATAUGA","WAYNE","WILKES","WILSON","YADKIN","YANCEY",
];

// Coarse Overpass tiles [s,w,n,e] covering NC (west→east) and SC. Used for OSM
// observed new builds + addressless monitoring, and for SC (no authoritative feed).
const OVERPASS_TILES: OverpassArea[] = [
  { key: "nc-w", state: "NC", county: null, bbox: [35.0, -84.4, 36.6, -81.0] },
  { key: "nc-c", state: "NC", county: null, bbox: [34.8, -81.0, 36.6, -79.0] },
  { key: "nc-e", state: "NC", county: null, bbox: [33.8, -79.0, 36.6, -75.4] },
  { key: "sc-up", state: "SC", county: null, bbox: [34.0, -83.4, 35.2, -81.0] },
  { key: "sc-mid", state: "SC", county: null, bbox: [33.0, -81.6, 34.6, -79.6] },
  { key: "sc-low", state: "SC", county: null, bbox: [32.0, -81.4, 33.6, -78.9] },
];

// Known coverage GAPS to surface honestly (requirement: expose missing datasets).
// Verified 2026-07-17: SC publishes NO statewide address FeatureServer (AGOL
// search 0 public results; scarng-gis.sc.gov hosts only county boundaries; RFA
// 911 address data is not open REST) — authoritative SC coverage is per-county
// (see SC_COUNTY_SOURCES). Cherokee and Union counties expose no public ArcGIS
// REST at all, so their Kinetic markets (e.g. Gaffney, Union) stay OSM-only.
const KNOWN_GAPS: Array<{ state: string; source: string; scope: string; note: string }> = [
  { state: "SC", source: "sc_rfa_gis", scope: "SC statewide", note: "No public SC statewide address FeatureServer exists (RFA 911 data not published as open REST; AGOL search 0 results) - authoritative SC coverage is per-county via sc_county_addr; counties without open GIS fall back to OSM Overpass" },
  { state: "SC", source: "sc_cherokee_gis", scope: "Cherokee county", note: "Cherokee County (Gaffney) publishes parcels only via qPublic/Schneider (no public ArcGIS REST) - OSM Overpass only until an open endpoint appears" },
  { state: "SC", source: "sc_union_gis", scope: "Union county", note: "Union County SC publishes maps only via WTH GIS viewer (no public ArcGIS REST) - OSM Overpass only until an open endpoint appears" },
  { state: "NC", source: "county_permits", scope: "residential permits", note: "County residential-permit feeds (NC and SC) are fragmented and not uniformly published as open APIs - not wired; new construction is detected via authoritative new address points + OSM new buildings instead" },
];

let _ready = false;
function ensureSchema(): void {
  if (_ready) return;
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS scan_new_builds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address_key TEXT NOT NULL UNIQUE,
      address TEXT, city TEXT, state TEXT, zip TEXT, county TEXT,
      lat REAL, lng REAL,
      source TEXT, sources TEXT, source_record_id TEXT,
      build_stage TEXT, confidence TEXT,
      monitored INTEGER DEFAULT 0,
      cluster_id TEXT,
      scan_target_id INTEGER,
      detected_at INTEGER NOT NULL,
      last_source_seen_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_newbuild_detected ON scan_new_builds(detected_at);
    CREATE INDEX IF NOT EXISTS idx_newbuild_stage ON scan_new_builds(build_stage, detected_at);
    CREATE INDEX IF NOT EXISTS idx_newbuild_cluster ON scan_new_builds(cluster_id);
    CREATE TABLE IF NOT EXISTS scan_source_coverage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state TEXT, county TEXT, source TEXT, scope TEXT,
      cursor TEXT, status TEXT,
      records_seen INTEGER DEFAULT 0,
      new_found INTEGER DEFAULT 0,
      last_poll_at INTEGER, note TEXT,
      UNIQUE(source, scope)
    );
  `);
  // Seed known gaps (idempotent) and keep still-missing gap notes current on
  // existing DBs (e.g. the SC statewide note now points at the county feeds).
  const gapStmt = rawDb.prepare(`
    INSERT INTO scan_source_coverage (state, county, source, scope, cursor, status, note, last_poll_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(source, scope) DO UPDATE SET note=excluded.note WHERE scan_source_coverage.status='missing'
  `);
  for (const g of KNOWN_GAPS) gapStmt.run(g.state, null, g.source, g.scope, null, "missing", g.note, null);
  _ready = true;
}

function clusterIdFor(state: string, lat: number | null, lng: number | null): string | null {
  if (lat == null || lng == null) return null;
  // ~0.005° ≈ 500m cell — a subdivision-sized construction cluster.
  return `${state}:${lat.toFixed(3)}:${lng.toFixed(3)}`;
}

interface IngestOutcome { fresh: NewBuildCandidate[]; addressedFresh: NewBuildCandidate[]; total: number; }

/** Dedup candidates into the durable inventory, preserving source + detected_at. */
function ingestCandidates(cands: NewBuildCandidate[]): IngestOutcome {
  ensureSchema();
  const now = Date.now();
  const fresh: NewBuildCandidate[] = [];
  const addressedFresh: NewBuildCandidate[] = [];
  const selectStmt = rawDb.prepare(`SELECT id, sources FROM scan_new_builds WHERE address_key = ?`);
  const insertStmt = rawDb.prepare(`
    INSERT INTO scan_new_builds (address_key, address, city, state, zip, county, lat, lng, source, sources, source_record_id, build_stage, confidence, monitored, cluster_id, detected_at, last_source_seen_at)
    VALUES (@addressKey,@address,@city,@state,@zip,@county,@lat,@lng,@source,@sources,@sourceRecordId,@buildStage,@confidence,@monitored,@clusterId,@detectedAt,@lastSeen)
  `);
  const touchStmt = rawDb.prepare(`UPDATE scan_new_builds SET last_source_seen_at=?, sources=? WHERE id=?`);
  const promoteStmt = rawDb.prepare(`UPDATE scan_new_builds SET address=@address, build_stage='addressed', monitored=0, city=COALESCE(@city,city), zip=COALESCE(@zip,zip), last_source_seen_at=@lastSeen WHERE id=@id AND (address IS NULL OR address='')`);
  // When a real address appears in a cell, stop monitoring any addressless building
  // there — the "monitored until an address becomes available" contract is met.
  const resolveStmt = rawDb.prepare(`UPDATE scan_new_builds SET monitored=0 WHERE monitored=1 AND address IS NULL AND cluster_id=?`);

  const tx = rawDb.transaction((rows: NewBuildCandidate[]) => {
    for (const c of rows) {
      // Dedup key: normalized address when addressed, else a stable source/geo key
      // for addressless buildings (so the same footprint isn't re-counted).
      const key = c.address
        ? normalizeKineticAddressKey(c.address, c.city ?? "", c.state, c.zip ?? "")
        : `addressless|${c.source}|${c.sourceRecordId}`;
      const existing = selectStmt.get(key) as { id: number; sources: string } | undefined;
      if (existing) {
        // Preserve provenance: add this source if new; if an addressless building now
        // has an address, PROMOTE it and enqueue it.
        let srcs: string[] = [];
        try { srcs = JSON.parse(existing.sources || "[]"); } catch { srcs = []; }
        if (!srcs.includes(c.source)) srcs.push(c.source);
        touchStmt.run(now, JSON.stringify(srcs), existing.id);
        if (c.address) {
          const info = promoteStmt.run({ id: existing.id, address: c.address, city: c.city, zip: c.zip, lastSeen: now });
          if (info.changes > 0) { fresh.push(c); addressedFresh.push(c); }
        }
        continue;
      }
      const clusterId = clusterIdFor(c.state, c.lat, c.lng);
      insertStmt.run({
        addressKey: key, address: c.address, city: c.city, state: c.state, zip: c.zip, county: c.county,
        lat: c.lat, lng: c.lng, source: c.source, sources: JSON.stringify([c.source]), sourceRecordId: c.sourceRecordId,
        buildStage: c.buildStage, confidence: c.confidence,
        monitored: c.address ? 0 : 1,
        clusterId,
        detectedAt: c.detectedAt || now, lastSeen: now,
      });
      // A newly-addressed build resolves any addressless building watched in its cell.
      if (c.address && clusterId) resolveStmt.run(clusterId);
      fresh.push(c);
      if (c.address) addressedFresh.push(c);
    }
  });
  tx.immediate(cands);
  return { fresh, addressedFresh, total: cands.length };
}

/** Immediately enqueue newly-addressed builds into the EXISTING scan pipeline. */
function enqueueAddressed(cands: NewBuildCandidate[], scopeLabel: string): { runId: string | null; queued: number } {
  const tenantId = getDefaultTenantId();
  if (tenantId == null || cands.length === 0) return { runId: null, queued: 0 };
  // Persist to the canonical scan_targets pool (dedup on address UNIQUE, source
  // 'new_build', created_at = detected_at), then resolve ids for the run.
  storage.upsertScanTargets(cands.map((c) => ({
    address: c.address!, city: c.city ?? c.county ?? "", state: c.state, zip: c.zip ?? "",
    lat: c.lat, lng: c.lng, source: "new_build", tenantId,
    canonicalKey: normalizeKineticAddressKey(c.address!, c.city ?? "", c.state, c.zip ?? ""),
  })));
  const ids: number[] = [];
  // lower(TRIM(...)) so this matches idx_scan_targets_addr_city_state - without
  // the trim() SQLite cannot use the expression index and full-SCANs
  // scan_targets (919,688 rows in production) once per candidate below.
  const idStmt = rawDb.prepare(`SELECT id FROM scan_targets WHERE lower(trim(address))=lower(trim(?)) LIMIT 1`);
  const linkStmt = rawDb.prepare(`UPDATE scan_new_builds SET scan_target_id=? WHERE address_key=?`);
  for (const c of cands) {
    const row = idStmt.get(c.address!) as { id: number } | undefined;
    if (row?.id) {
      ids.push(row.id);
      linkStmt.run(row.id, normalizeKineticAddressKey(c.address!, c.city ?? "", c.state, c.zip ?? ""));
    }
  }
  if (!ids.length) return { runId: null, queued: 0 };
  try {
    const state = cands[0].state;
    const run = startTargetRun({ tenantId, city: scopeLabel, state, targetIds: ids, runKind: "new_build", label: `New Builds · ${scopeLabel}` });
    return { runId: run.runId, queued: run.queued };
  } catch (e: any) {
    structuredLog("newbuild.enqueue_failed", { scope: scopeLabel, error: String(e?.message ?? e).slice(0, 120) }, "warn");
    return { runId: null, queued: 0 };
  }
}

function updateCoverage(r: SourcePollResult, state: string, county: string | null, newFound: number): void {
  ensureSchema();
  const status = r.ok ? (r.seeded ? "seeded" : "ok") : "error";
  rawDb.prepare(`
    INSERT INTO scan_source_coverage (state, county, source, scope, cursor, status, records_seen, new_found, last_poll_at, note)
    VALUES (@state,@county,@source,@scope,@cursor,@status,@records,@new,@ts,@note)
    ON CONFLICT(source, scope) DO UPDATE SET
      cursor=excluded.cursor, status=excluded.status,
      records_seen=scan_source_coverage.records_seen+excluded.records_seen,
      new_found=scan_source_coverage.new_found+excluded.new_found,
      last_poll_at=excluded.last_poll_at, note=excluded.note, state=excluded.state, county=excluded.county
  `).run({ state, county, source: r.source, scope: r.scope, cursor: r.cursor, status, records: r.recordsSeen, new: newFound, ts: Date.now(), note: r.note });
}

function getCursor(source: string, scope: string): string {
  ensureSchema();
  const row = rawDb.prepare(`SELECT cursor FROM scan_source_coverage WHERE source=? AND scope=?`).get(source, scope) as { cursor: string } | undefined;
  return row?.cursor ?? (source === "nc_onemap" || source === SC_COUNTY_SOURCE_ID ? "0" : "");
}

// ── Tick / continuous loop ────────────────────────────────────────────────────
// One scope per tick, round-robin across every NC county (NC OneMap) + Overpass
// tiles (NC+SC). Fast, durable and retried against the free endpoints; a full NC cycle completes
// over time. Injectable pollers make this fully testable without the network.
export interface RadarPollers {
  ncOneMap?: typeof pollNcOneMapCounty;
  overpass?: typeof pollOverpassArea;
  scCounty?: typeof pollScCountyAddresses;
}
const ALL_SCOPES: Array<
  | { kind: "nc_onemap"; county: string }
  | { kind: "sc_county_addr"; src: ScCountySource }
  | { kind: "osm_overpass"; area: OverpassArea }
> = [
  ...NC_COUNTIES.map((county) => ({ kind: "nc_onemap" as const, county })),
  ...SC_COUNTY_SOURCES.map((src) => ({ kind: "sc_county_addr" as const, src })),
  ...OVERPASS_TILES.map((area) => ({ kind: "osm_overpass" as const, area })),
];
let _tickIdx = 0;

export async function runRadarTick(pollers: RadarPollers = {}): Promise<{ scope: string; found: number; enqueued: number }> {
  ensureSchema();
  const scope = ALL_SCOPES[_tickIdx % ALL_SCOPES.length];
  _tickIdx++;
  const ncPoll = pollers.ncOneMap ?? pollNcOneMapCounty;
  const opPoll = pollers.overpass ?? pollOverpassArea;
  const scPoll = pollers.scCounty ?? pollScCountyAddresses;

  let result: SourcePollResult;
  let state: string, county: string | null, label: string;
  if (scope.kind === "nc_onemap") {
    state = "NC"; county = scope.county; label = `${scope.county}, NC`;
    result = await ncPoll(scope.county, getCursor("nc_onemap", scope.county));
  } else if (scope.kind === "sc_county_addr") {
    state = "SC"; county = scope.src.county; label = `${scope.src.county}, SC`;
    result = await scPoll(scope.src, getCursor(SC_COUNTY_SOURCE_ID, scope.src.county));
  } else {
    state = scope.area.state; county = scope.area.county; label = scope.area.key;
    result = await opPoll(scope.area, getCursor("osm_overpass", scope.area.key));
  }

  const ingest = ingestCandidates(result.candidates);
  const enq = enqueueAddressed(ingest.addressedFresh, county ?? label);
  updateCoverage(result, state, county, ingest.fresh.length);
  if (ingest.fresh.length || !result.ok) {
    structuredLog("newbuild.tick", { scope: result.scope, source: result.source, seen: result.recordsSeen, fresh: ingest.fresh.length, addressed: ingest.addressedFresh.length, enqueued: enq.queued, ok: result.ok, note: result.note }, result.ok ? "info" : "warn");
  }
  return { scope: result.scope, found: ingest.fresh.length, enqueued: enq.queued };
}

/**
 * Admin/demo: force-poll ONE NC county for its N most-recently-added authoritative
 * addresses (bounded), ingest + enqueue them into the pipeline immediately. Proves
 * the end-to-end path with real records without waiting for the round-robin or a
 * genuine post-seed addition. Bounded by `lookback` (clamped ≤50).
 */
export async function radarPollCounty(county: string, lookback = 10, pollers: RadarPollers & { recent?: typeof fetchNcOneMapRecent } = {}): Promise<{ scope: string; found: number; enqueued: number; runId: string | null }> {
  ensureSchema();
  const recent = pollers.recent ?? fetchNcOneMapRecent;
  const result = await recent(county, lookback);
  const ingest = ingestCandidates(result.candidates);
  const enq = enqueueAddressed(ingest.addressedFresh, county);
  updateCoverage(result, "NC", county, ingest.fresh.length);
  structuredLog("newbuild.force_poll", { county, seen: result.recordsSeen, fresh: ingest.fresh.length, addressed: ingest.addressedFresh.length, enqueued: enq.queued, ok: result.ok, note: result.note }, "info");
  return { scope: county, found: ingest.fresh.length, enqueued: enq.queued, runId: enq.runId };
}

let _timer: ReturnType<typeof setInterval> | null = null;
/** Start the continuous radar. Gated by env; resumable (cursors persisted). */
export function startNewBuildRadar(): void {
  if (_timer) return;
  if (process.env.NEWBUILD_RADAR === "off") return;
  ensureSchema();
  const intervalMs = Math.max(5000, Number(process.env.NEWBUILD_RADAR_INTERVAL_MS ?? 20000));
  _timer = setInterval(() => { void runRadarTick().catch(() => {}); }, intervalMs);
  if (typeof (_timer as any).unref === "function") (_timer as any).unref();
  structuredLog("newbuild.radar_started", { scopes: ALL_SCOPES.length, intervalMs }, "info");
}

// ── Read paths (feed + coverage + clusters) ──────────────────────────────────
export interface NewBuildRow {
  id: number; address: string | null; city: string | null; state: string; zip: string | null; county: string | null;
  lat: number | null; lng: number | null; source: string; sources: string[]; buildStage: string; confidence: string;
  monitored: boolean; clusterId: string | null; detectedAt: number;
  fiberStatus: string | null; isNewFiber: boolean; billingStatus: string | null; leadId: number | null; checkedAt: string | null; actionable: boolean;
}

export function getNewBuildFeed(opts: { hours?: number; actionableOnly?: boolean; limit?: number } = {}): {
  rows: NewBuildRow[]; counts: { total: number; addressed: number; monitored: number; checked: number; leads: number; clusters: number };
} {
  ensureSchema();
  const since = Date.now() - (opts.hours ?? 72) * 3600_000;
  const limit = Math.min(500, opts.limit ?? 200);
  // Join to scan_targets for fiber status / lead (checked by the shared pipeline).
  const rows = rawDb.prepare(`
    SELECT nb.*, st.last_fiber_status fs, st.last_is_new_fiber nf, st.last_billing_status bs, st.converted_to_lead_id lead, st.last_scanned_at scanned
    FROM scan_new_builds nb
    LEFT JOIN scan_targets st ON st.id = nb.scan_target_id
    WHERE nb.detected_at > ? ORDER BY nb.detected_at DESC LIMIT ?
  `).all(since, limit) as any[];
  const mapped: NewBuildRow[] = rows.map((r) => {
    const actionable = String(r.fs ?? "").includes("new_fiber") && String(r.bs ?? "").toUpperCase() === "N";
    let sources: string[] = []; try { sources = JSON.parse(r.sources || "[]"); } catch { sources = r.source ? [r.source] : []; }
    return {
      id: r.id, address: r.address, city: r.city, state: r.state, zip: r.zip, county: r.county,
      lat: r.lat, lng: r.lng, source: r.source, sources, buildStage: r.build_stage, confidence: r.confidence,
      monitored: !!r.monitored, clusterId: r.cluster_id, detectedAt: r.detected_at,
      fiberStatus: r.fs ?? null, isNewFiber: !!r.nf, billingStatus: r.bs ?? null, leadId: r.lead ?? null,
      checkedAt: r.scanned ?? null, actionable,
    };
  });
  const filtered = opts.actionableOnly ? mapped.filter((r) => r.actionable) : mapped;
  const clusterCount = rawDb.prepare(`SELECT COUNT(*) c FROM (SELECT cluster_id FROM scan_new_builds WHERE cluster_id IS NOT NULL AND detected_at > ? GROUP BY cluster_id HAVING COUNT(*) >= 3)`).get(since) as { c: number };
  return {
    rows: filtered,
    counts: {
      total: mapped.length,
      addressed: mapped.filter((r) => r.buildStage === "addressed").length,
      monitored: mapped.filter((r) => r.monitored).length,
      checked: mapped.filter((r) => r.checkedAt).length,
      leads: mapped.filter((r) => r.leadId).length,
      clusters: clusterCount.c,
    },
  };
}

export function getSourceCoverage(): {
  sources: Array<{ state: string; county: string | null; source: string; scope: string; status: string; recordsSeen: number; newFound: number; lastPollAt: number | null; note: string | null }>;
  summary: { ncCountiesTracked: number; ncCountiesSeeded: number; scCountiesTracked: number; scCountiesSeeded: number; scTilesTracked: number; gaps: number; staleOverMin: number };
} {
  ensureSchema();
  const rows = rawDb.prepare(`SELECT state, county, source, scope, cursor, status, records_seen r, new_found n, last_poll_at ts, note FROM scan_source_coverage ORDER BY state, source, scope`).all() as any[];
  const now = Date.now();
  const STALE_MS = Number(process.env.NEWBUILD_STALE_MS ?? 6 * 3600_000);
  return {
    sources: rows.map((x) => ({ state: x.state, county: x.county, source: x.source, scope: x.scope, status: x.status, recordsSeen: x.r, newFound: x.n, lastPollAt: x.ts, note: x.note })),
    summary: {
      ncCountiesTracked: rows.filter((x) => x.source === "nc_onemap").length,
      ncCountiesSeeded: rows.filter((x) => x.source === "nc_onemap" && x.status !== "missing" && x.cursor !== "0").length,
      scCountiesTracked: rows.filter((x) => x.source === SC_COUNTY_SOURCE_ID).length,
      scCountiesSeeded: rows.filter((x) => x.source === SC_COUNTY_SOURCE_ID && x.status !== "missing" && x.cursor !== "0").length,
      scTilesTracked: rows.filter((x) => x.source === "osm_overpass" && x.state === "SC").length,
      gaps: rows.filter((x) => x.status === "missing").length,
      staleOverMin: rows.filter((x) => x.status !== "missing" && x.ts && now - x.ts > STALE_MS).length,
    },
  };
}

export const _radarInternal = { ingestCandidates, enqueueAddressed, clusterIdFor, ensureSchema, ALL_SCOPES, NC_COUNTIES };
