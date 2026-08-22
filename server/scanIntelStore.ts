// ── Scan-intelligence data access ─────────────────────────────────────────────
// All the DB reads/writes for the market-intelligence + budgeted-scan system.
// Kept out of the 1,500-line storage.ts, using the same raw better-sqlite3 handle
// and the same tenant-scoping discipline. NOTHING here touches the proxy — these
// are pure DB operations over data the product already accumulated.
import { rawDb } from "./db";
import type { MarketAggregate } from "@shared/marketIntel";
import { INCONCLUSIVE_GIVEUP, anfParkedSql } from "@shared/scanPolicy";

// Quiet window for addresses concluded address_not_found (persistent needs-fix
// non-answers with no adoptable suggestion): parked out of BULK claims this
// long, then re-probed. Manual/lasso/recheck kinds pass skipSec=0 → always check.
export const ANF_QUIET_DAYS = Math.max(1, Math.floor(Number(process.env.ADDRESS_NOT_FOUND_QUIET_DAYS ?? 14) || 14));

const g = <T = any>(sql: string, ...args: any[]): T => rawDb.prepare(sql).get(...args) as T;
const all = <T = any>(sql: string, ...args: any[]): T[] => rawDb.prepare(sql).all(...args) as T[];

// ── Market aggregates ─────────────────────────────────────────────────────────
// One pass over the pool + leads + knocks + field outcomes → per-city rollups.
// Everything is tenant-scoped. Pool rows may have tenant_id NULL (platform
// harvest), so pool aggregates are NOT tenant-filtered (the address inventory is
// shared), but leads/knocks/outcomes — the operational data — ARE.
// The pool rollup below is one GROUP BY over every scan_targets row (919k on
// the production-shaped copy: 1.1 to 1.3 s, synchronous on the HTTP worker) and
// Fiber Intelligence polls /api/scan/markets every 30 s. Pool counts move only
// while a scan runs, so a short memo per tenant turns a per-poll stall into one
// every MARKET_AGGREGATES_TTL_MS. Writers that need the next read fresh call
// bustMarketAggregates().
export const MARKET_AGGREGATES_TTL_MS = 120_000;
const marketAggregatesMemo = new Map<number, { at: number; rows: MarketAggregate[] }>();
export function bustMarketAggregates(): void { marketAggregatesMemo.clear(); }

export function getMarketAggregates(tenantId: number, nowMs = Date.now()): MarketAggregate[] {
  const hit = marketAggregatesMemo.get(tenantId);
  if (hit && nowMs - hit.at < MARKET_AGGREGATES_TTL_MS) return hit.rows;
  const rows = computeMarketAggregates(tenantId);
  marketAggregatesMemo.set(tenantId, { at: nowMs, rows });
  return rows;
}

function computeMarketAggregates(tenantId: number): MarketAggregate[] {
  // Pool coverage per city (shared inventory; not tenant-scoped).
  const pool = all<{ city: string; state: string; poolSize: number; verified: number; verifiedNewFiber: number; newlyLive: number; lastVerifiedAt: string | null }>(
    `SELECT s.city, s.state,
            COUNT(*) AS poolSize,
            SUM(CASE WHEN s.scan_count > 0 THEN 1 ELSE 0 END) AS verified,
            SUM(CASE WHEN fl.id IS NOT NULL THEN 1 ELSE 0 END) AS verifiedNewFiber,
            SUM(CASE WHEN fl.fresh_confirmed_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS newlyLive,
            MAX(s.last_scanned_at) AS lastVerifiedAt
       FROM scan_targets s
       LEFT JOIN leads fl ON fl.tenant_id=? AND fl.source_scan_target_id=s.id
         AND fl.lead_tag='fresh_fiber_confirmed'
      GROUP BY lower(s.city), lower(s.state)`,
    tenantId,
  );

  // Lead operational rollup per city (tenant-scoped). Every projector-stamped
  // fresh-fiber lead counts — cross-verified OR authoritative NEW FIBER + billing N.
  const leadAgg = all<{ city: string; state: string; leads: number; worked: number; unworked: number; sold: number; lastLeadAt: string | null }>(
    `SELECT l.city AS city, l.state AS state,
            COUNT(*) AS leads,
            SUM(CASE WHEN k.c > 0 THEN 1 ELSE 0 END) AS worked,
            SUM(CASE WHEN k.c IS NULL OR k.c = 0 THEN 1 ELSE 0 END) AS unworked,
            SUM(CASE WHEN l.lead_status = 'sold' THEN 1 ELSE 0 END) AS sold,
            MAX(l.created_at) AS lastLeadAt
       FROM leads l
       LEFT JOIN (SELECT lead_id, COUNT(*) c FROM knock_log GROUP BY lead_id) k ON k.lead_id = l.id
      WHERE l.tenant_id = ? AND l.city IS NOT NULL
        AND l.lead_tag='fresh_fiber_confirmed'
        AND l.source_scan_target_id IS NOT NULL AND l.fresh_confirmed_at IS NOT NULL
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

  // A market is any city with a pool OR real leads — the UNION, so a city with
  // door-rich leads but no harvested pool (or vice-versa) is never dropped.
  const poolByCity = new Map(pool.map(p => [key(p.city, p.state), p]));
  const allKeys = new Set<string>([...poolByCity.keys(), ...leadByCity.keys()]);

  return [...allKeys].map(k => {
    const p = poolByCity.get(k);
    const lo = leadByCity.get(k);
    const oc = outcomeByCity.get(k);
    const city = p?.city ?? lo!.city;
    const state = p?.state ?? lo!.state;
    return {
      city, state,
      poolSize: p?.poolSize ?? 0, verified: p?.verified ?? 0,
      verifiedNewFiber: p?.verifiedNewFiber ?? 0, newlyLive: p?.newlyLive ?? 0,
      leads: lo?.leads ?? 0, unworkedLeads: lo?.unworked ?? 0, workedLeads: lo?.worked ?? 0, soldLeads: lo?.sold ?? 0,
      lastVerifiedAtMs: p?.lastVerifiedAt ? Date.parse(p.lastVerifiedAt + "Z") || Date.parse(p.lastVerifiedAt) : null,
      lastLeadAtMs: lo?.lastLeadAt ? Date.parse(lo.lastLeadAt + "Z") || Date.parse(lo.lastLeadAt) : null,
      outcome: oc ? {
        knocks: oc.knocks, contacts: oc.contacts, sales: oc.sales,
        lastDeployedAtMs: oc.lastDeployedAt ? Date.parse(oc.lastDeployedAt + "Z") || Date.parse(oc.lastDeployedAt) : null,
      } : null,
    };
  });
}

// Known fiber points for internal target ranking. Current primary-source pool
// signals may guide where the scanner looks next, but only cross-verified lead
// points reach operational map/cluster surfaces below.
export function getKnownNewFiberPoints(tenantId: number, city?: string, state = "NC"): Array<{ lat: number; lng: number }> {
  const rows = city
    ? all<{ lat: number; lng: number }>(
        `SELECT lat, lng FROM scan_targets WHERE last_is_new_fiber = 1 AND last_billing_status='N' AND lat IS NOT NULL AND lower(city)=lower(?) AND lower(state)=lower(?)
         UNION ALL
         SELECT lat, lng FROM leads WHERE tenant_id=? AND lead_tag='fresh_fiber_confirmed'
           AND source_scan_target_id IS NOT NULL
           AND lat IS NOT NULL AND lower(city)=lower(?)`,
        city, state, tenantId, city,
      )
    : all<{ lat: number; lng: number }>(
        `SELECT lat, lng FROM leads WHERE tenant_id=? AND lead_tag='fresh_fiber_confirmed'
           AND source_scan_target_id IS NOT NULL AND lat IS NOT NULL`, tenantId);
  return rows.filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

// Unverified (or oldest-verified) pool targets for a city, as ranking input.
// Cap is a memory backstop, not a coverage limit: it must exceed the largest
// real city so the EV ranker SEES the whole pool and never silently drops the
// tail of a big market (the biggest NC city here is ~36k). rankTargets is O(n),
// so ranking 60k lightweight rows is a few MB and a few ms — cheap insurance.
export function getPoolTargetsForCity(city: string, state: string, cap = 60_000): Array<{ id: number; lat: number | null; lng: number | null; lastScannedAtMs: number | null; lastIsNewFiber: boolean; opportunityScore: number | null }> {
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

// Confirmed fresh-fiber points for the map/clustering (cross-verified or
// authoritative). Source is the projector-stamped leads board; legacy
// unstamped rows are excluded,
// carrying the operational signal (worked/sold via knocks, competitor, score)
// AND real freshness: created_at is when we verified this door as new fiber, so
// cluster freshness is data-driven, not a hardcoded null. Optional city scope
// makes "open a market → its opportunity map" show THAT city, not the state.
export function getOpportunityPoints(
  tenantId: number,
  bbox?: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  city?: string, state?: string,
): Array<any> {
  const box = bbox ? `AND l.lat BETWEEN ${num(bbox.minLat)} AND ${num(bbox.maxLat)} AND l.lng BETWEEN ${num(bbox.minLng)} AND ${num(bbox.maxLng)}` : "";
  const cityFilter = city ? `AND lower(l.city)=lower(?) ${state ? "AND lower(l.state)=lower(?)" : ""}` : "";
  const args: any[] = [tenantId];
  if (city) { args.push(city); if (state) args.push(state); }
  const rows = all<any>(
    `SELECT l.id AS id, l.lat AS lat, l.lng AS lng, 1 AS isNewFiber,
            CASE WHEN k.c > 0 THEN 1 ELSE 0 END AS worked,
            CASE WHEN l.lead_status='sold' THEN 1 ELSE 0 END AS sold,
            l.lead_score AS leadScore, l.competitor_name AS competitor,
            l.created_at AS createdAt
       FROM leads l
       LEFT JOIN (SELECT lead_id, COUNT(*) c FROM knock_log GROUP BY lead_id) k ON k.lead_id = l.id
      WHERE l.tenant_id=? AND l.lead_tag='fresh_fiber_confirmed'
        AND l.source_scan_target_id IS NOT NULL
        AND l.fresh_confirmed_at IS NOT NULL AND l.lat IS NOT NULL ${cityFilter} ${box}`,
    ...args,
  );
  return rows.map(r => {
    const verifiedAtMs = r.createdAt ? Date.parse(r.createdAt + "Z") || Date.parse(r.createdAt) : null;
    // verifiedAtMs drives an HONEST "freshly verified" signal (created_at = when
    // we confirmed this door as new fiber). We do NOT synthesize "newly live"
    // from lead age — "just went live" is a PROVABLE unavailable→live flip we
    // only know from a pool rescan (first_seen_live_at), never from a recent
    // import. Claiming a freshly-imported lead "just went live" would overstate
    // freshness, so newlyLive stays 0 for lead-sourced points.
    return { ...r, verifiedAtMs, newlyLive: 0 };
  });
}

// ── scan_runs lifecycle (resumable persisted jobs) ────────────────────────────
export interface ScanRunRow {
  id: string; tenantId: number; kind: string; label: string;
  city: string | null; state: string | null; bbox: string | null;
  budget: number; verified: number; newFiber: number; newlyLive: number; failed: number;
  status: string; error: string | null; estBytes: number; createdBy: number | null;
  startedAt: string; heartbeatAt: string | null; completedAt: string | null;
  reopenCount: number; // C3: how many times the stranded-tail drain re-opened this run
}

// C3 — the re-open error budget lives IN the row so it survives restarts and is
// shared by every cluster worker's reaper (an in-memory Map would let each of
// the 4 workers re-open the same run 5 times). Lazily migrated: storage.ts owns
// the base DDL, so we ALTER here with a PRAGMA guard (retry until the column
// exists, then never check again).
let reopenColEnsured = false;
function ensureReopenColumn(): void {
  if (reopenColEnsured) return;
  try {
    const cols = rawDb.prepare(`PRAGMA table_info(scan_runs)`).all() as Array<{ name: string }>;
    if (!cols.length) return; // table not created yet — retry on the next call
    if (!cols.some((c) => c.name === "reopen_count")) {
      try { rawDb.exec(`ALTER TABLE scan_runs ADD COLUMN reopen_count INTEGER NOT NULL DEFAULT 0`); }
      catch { /* a sibling process added it first */ }
    }
    reopenColEnsured = true;
  } catch { /* retry on the next call */ }
}

// Count one stranded-tail re-open; returns the new count.
export function bumpRunReopen(runId: string): number {
  ensureReopenColumn();
  try {
    rawDb.prepare(`UPDATE scan_runs SET reopen_count = reopen_count + 1, updated_at=datetime('now') WHERE id=?`).run(runId);
    const row = g<{ n: number }>(`SELECT reopen_count AS n FROM scan_runs WHERE id=?`, runId);
    return Number(row?.n ?? 0);
  } catch { return 0; }
}

const RUN_COLS = `id, tenant_id AS tenantId, kind, label, city, state, bbox, budget, verified, new_fiber AS newFiber,
        newly_live AS newlyLive, failed, status, error, est_bytes AS estBytes, created_by AS createdBy,
        started_at AS startedAt, heartbeat_at AS heartbeatAt, completed_at AS completedAt,
        reopen_count AS reopenCount`;

export function createScanRun(r: {
  id: string; tenantId: number; kind: string; label: string; city?: string | null; state?: string | null;
  bbox?: string | null; budget: number; createdBy?: number | null;
}): void {
  rawDb.prepare(
    `INSERT INTO scan_runs (id, tenant_id, kind, label, city, state, bbox, budget, status, heartbeat_at, created_by)
     VALUES (@id,@tenantId,@kind,@label,@city,@state,@bbox,@budget,'running',datetime('now'),@createdBy)`,
  ).run({ id: r.id, tenantId: r.tenantId, kind: r.kind, label: r.label, city: r.city ?? null, state: r.state ?? null, bbox: r.bbox ?? null, budget: r.budget, createdBy: r.createdBy ?? null });
}

/**
 * Reconcile a newly-created run with the rows enqueue dedup actually accepted.
 * This is called before dispatch, so the persisted budget, API response, cost
 * estimate, and worker completion condition all describe the same work.
 */
export function setScanRunBudget(runId: string, budget: number): void {
  const safe = Math.max(0, Math.floor(Number(budget) || 0));
  rawDb.prepare(`UPDATE scan_runs SET budget=? WHERE id=? AND status='running'`).run(safe, runId);
}

// Queue backpressure is applied at the GENERATION side (clusterExpansion pauses new
// expansion when the backlog is large) — NOT at enqueue. Gating here is unsafe: the run
// is already created, so deferring its targets leaves a zombie run that drains straight
// to 'done' having checked nothing, which downstream treats as "resolved". This function
// only DEDUPLICATES; every enqueued run keeps its full target set.
// GLOBAL DEDUP: a normalized address (scan_targets.id ↔ globally-UNIQUE address) that
// is already queued/inflight in ANOTHER running run is skipped at enqueue — so the same
// address is never queued into many runs at once (the source of the 34,995 cross-run
// duplicates). No unique address is lost: it stays claimable in the run that already
// holds it, and scan_targets is the durable backstop for future cycles. Set
// SCAN_ENQUEUE_DEDUP=off to disable. Requeues (state updates) are unaffected.
const _pendingElsewhere = (ids: number[], excludeRunId: string): Set<number> => {
  const found = new Set<number>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = rawDb.prepare(
      `SELECT DISTINCT t.target_id AS id FROM scan_run_targets t JOIN scan_runs r ON r.id = t.run_id
        WHERE t.target_id IN (${chunk.map(() => "?").join(",")})
          AND t.state IN ('queued','inflight') AND r.status='running' AND t.run_id != ?`,
    ).all(...chunk, excludeRunId) as any[];
    for (const row of rows) found.add(Number(row.id));
  }
  return found;
};
const ENQUEUE_DEDUP = process.env.SCAN_ENQUEUE_DEDUP !== "off";
/**
 * Returns the number of targets ACTUALLY enqueued.
 *
 * It used to return void, and both early returns below (nothing ranked, or
 * everything deduped away) exited silently. The discovery reconciler counted
 * `batch.length` as work regardless, so a pass that enqueued ZERO rows still
 * reported progress and its 1s -> 31s idle backoff could never engage: it ran
 * every second, forever, against the same jobs. INSERT OR IGNORE means even the
 * post-dedup row count overstates, so this counts real `changes`.
 */
export function enqueueRunTargets(runId: string, ranked: Array<{ id: number; seq: number }>): number {
  if (!ranked.length) return 0;
  let rows = ranked;
  if (ENQUEUE_DEDUP) {
    const dupes = _pendingElsewhere(ranked.map((r) => r.id), runId);
    if (dupes.size) rows = ranked.filter((r) => !dupes.has(r.id));
  }
  if (!rows.length) return 0;
  const stmt = rawDb.prepare(`INSERT OR IGNORE INTO scan_run_targets (run_id, target_id, seq, state) VALUES (?,?,?,'queued')`);
  const tx = rawDb.transaction((batch: Array<{ id: number; seq: number }>) => {
    let inserted = 0;
    for (const row of batch) inserted += stmt.run(runId, row.id, row.seq).changes;
    return inserted;
  });
  return tx(rows) as number;
}

// ATOMICALLY claim the next batch of queued targets: mark them 'inflight' and
// return them in ONE transaction, so no two dispatch passes can grab the same
// target and double-spend the paid proxy. A crash after claiming leaves rows
// 'inflight' — resetInflightTargets() (called on resume) returns them to the
// queue. Priority order preserved.
// YIELD-FIRST CLAIM ORDER. The scanner drains a large mixed backlog; scanning it in
// raw enqueue order (seq) spends the cluster's finite check budget equally on
// high-yield fresh addresses and on the low-yield AddressNeedsFix tail (addresses
// Kinetic's fabric doesn't recognize, which retry up to INCONCLUSIVE_GIVEUP times
// before parking — measured live at ~76% of all checks). Ordering by yield front-
// loads the checks most likely to produce a conclusive Kinetic-serviceable answer
// (a green lead) per proxy-dollar, and lets the needs-fix tail drain only when
// nothing fresher is queued. Tiers (each a CASE evaluating to a small integer,
// sorted ASC so 0 = highest priority):
//   1. Kinetic before Frontier — a Kinetic sweep spends its budget on Kinetic
//      addresses first; Frontier targets are their own line (routed to the Frontier
//      scanner, published as red leads) and drain only when Kinetic is exhausted, so
//      no Kinetic proxy session is burned on non-Kinetic territory ahead of a real
//      Kinetic address. Deprioritize, not exclude — Frontier is a real line.
//   2. never-scanned (no answer yet) before any re-check.
//   3. HIGH-VALUE re-check / fresh signal next: a known NEW-FIBER address (may flip
//      billing→inactive = a fresh lead) or a new-build/coming-soon/radar-sourced
//      address, before generic addresses.
//   4. fewer prior needs-fix attempts — the AddressNeedsFix churn tail sinks last.
//   5. fewer run-level retries.
//   6. enqueue order (seq) as the final tiebreak.
// A run of purely fresh targets (manual / lasso / corridor / a new city sweep — all
// same-carrier, never-scanned, 0 attempts, non-new-build source) collapses tiers 1-5
// to constants, so its claim order is byte-identical to the old `seq ASC`. Only mixed
// backlog runs reorder. Cost: a per-run ORDER BY ... LIMIT temp-btree, O(n log k),
// single-digit ms even at 100k queued rows. SCAN_YIELD_ORDER=off → strict seq.
const _yieldOrder = process.env.SCAN_YIELD_ORDER === "off"
  ? "t.seq ASC"
  : `CASE WHEN st.carrier='frontier' THEN 1 ELSE 0 END ASC,
     CASE WHEN st.last_scanned_at IS NULL THEN 0 ELSE 1 END ASC,
     CASE WHEN st.last_is_new_fiber=1 OR st.last_fiber_status='new_fiber' THEN 0
          WHEN st.source LIKE '%new_build%' OR st.source LIKE '%radar%' OR st.source LIKE '%coming%' THEN 1
          ELSE 2 END ASC,
     st.inconclusive_attempts ASC, t.attempt_count ASC, t.seq ASC`;
const _claimSelect = rawDb.prepare(
  `SELECT t.target_id AS targetId, t.seq AS seq, st.address, st.city, st.state, st.zip, st.lat, st.lng, st.carrier AS carrier
     FROM scan_run_targets t JOIN scan_targets st ON st.id = t.target_id
    WHERE t.run_id=? AND t.state='queued' AND (t.next_attempt_at IS NULL OR t.next_attempt_at<=datetime('now'))
    ORDER BY ${_yieldOrder} LIMIT ?`);
const _claimMark = rawDb.prepare(`UPDATE scan_run_targets SET state='inflight',attempt_count=attempt_count+1
  WHERE run_id=? AND target_id=? AND state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=datetime('now'))`);
// DEDUP guard: before claiming, mark as terminal 'skipped' any queued target whose
// ADDRESS was already conclusively checked within the dedup window. scan_targets holds
// the canonical last_scanned_at + result for a globally-UNIQUE address, so the answer
// already exists — re-checking it (across the 34,995 cross-run duplicates, or the same
// address across time) would only re-spend proxy. No unique address is lost: the row is
// resolved from the canonical snapshot, not discarded, and change-detection runs
// (recheck/rescan/nightly) + user-initiated checks pass skipSec=0 so they always verify.
const _skipRecentlyScanned = rawDb.prepare(
  `UPDATE scan_run_targets SET state='skipped', result=?, next_attempt_at=NULL
     WHERE run_id=? AND state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=datetime('now'))
       AND EXISTS (SELECT 1 FROM scan_targets st WHERE st.id=scan_run_targets.target_id
                     AND st.last_scanned_at IS NOT NULL AND st.last_scanned_at > datetime('now', ?))`);
// Parked address_not_found rows: the address string was concluded absent from
// Kinetic's fabric (INCONCLUSIVE_GIVEUP+ needs-fix non-answers, never a
// conclusive answer). Bulk claims skip them during the quiet window instead of
// re-burning proxy checks; after it lapses they are claimable again (re-probe).
// Uses the SHARED escalating-window predicate (@shared/scanPolicy) so the
// claim layer and every selector agree on "parked" by construction.
const _skipParkedNotFound = rawDb.prepare(
  `UPDATE scan_run_targets SET state='skipped', result=?, next_attempt_at=NULL
     WHERE run_id=? AND state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=datetime('now'))
       AND EXISTS (SELECT 1 FROM scan_targets st WHERE st.id=scan_run_targets.target_id
                     AND ${anfParkedSql("st", ANF_QUIET_DAYS)})`);
// IMMEDIATE (not DEFERRED) so the claim takes the WAL write lock up front and
// busy_timeout serializes concurrent claimers cleanly. A DEFERRED claim lets two
// processes read the SAME queued rows, and the loser's first write throws
// SQLITE_BUSY_SNAPSHOT (which busy_timeout does NOT cover) — flapping the run to
// 'error'. And gate each row on _claimMark.changes===1: only rows THIS caller
// actually flipped queued→inflight are returned, so a row that lost the race is
// never scanned twice. Correct at N=1 (deploy-overlap already runs two writers
// briefly) and the prerequisite for multi-process work-stealing.
const _claimTx = rawDb.transaction((runId: string, limit: number, skipRecentlyScannedSec: number) => {
  if (skipRecentlyScannedSec > 0) {
    _skipRecentlyScanned.run("superseded: address conclusively checked within dedup window", runId, `-${Math.floor(skipRecentlyScannedSec)} seconds`);
    _skipParkedNotFound.run(
      "parked: address_not_found quiet window (needs-fix non-answers exhausted)",
      runId,
    );
  }
  const rows = _claimSelect.all(runId, limit) as any[];
  const claimed: any[] = [];
  for (const r of rows) {
    if (_claimMark.run(runId, r.targetId).changes === 1) claimed.push(r);
  }
  return claimed;
});
export function claimRunTargets(runId: string, limit: number, skipRecentlyScannedSec = 0): Array<{ targetId: number; seq: number; address: string; city: string; state: string; zip: string; lat: number | null; lng: number | null }> {
  return (_claimTx as any).immediate(runId, limit, skipRecentlyScannedSec) as any;
}

// Finalize one checked target: set its terminal state AND bump the run counters
// in a SINGLE transaction, so a crash between the two can never leave the run's
// verified/cost totals disagreeing with the per-target ledger.
// COMPARE-AND-SET: only finalize a target that is still 'inflight', and bump the
// run counters ONLY if that flip actually happened (changes===1). Without this a
// double-finalize (a reaper reclaim racing the original worker, a retry) would
// double-count verified/failed/est_bytes and overrun the run budget.
// Guard on NON-TERMINAL state (queued OR inflight): prevents a double-finalize
// from re-counting the run totals, while still allowing both the normal worker
// path (inflight) and the admin backfill path (finalizes exhausted 'queued'
// targets directly). A row already verified/failed/skipped/cancelled is not
// touched again.
const _finTarget = rawDb.prepare(`UPDATE scan_run_targets SET state=?, result=?, next_attempt_at=NULL WHERE run_id=? AND target_id=? AND state IN ('inflight','queued')`);
const _finBump = rawDb.prepare(
  `UPDATE scan_runs SET verified = verified + @verified, new_fiber = new_fiber + @newFiber,
      newly_live = newly_live + @newlyLive, failed = failed + @failed,
      est_bytes = est_bytes + @estBytes, heartbeat_at = datetime('now'), updated_at=datetime('now') WHERE id = @runId`);
const _finalizeTx = rawDb.transaction((runId: string, targetId: number, state: string, result: string | null, delta: any) => {
  const flipped = _finTarget.run(state, result, runId, targetId).changes === 1;
  if (flipped) {
    _finBump.run({ runId, verified: delta.verified ?? 0, newFiber: delta.newFiber ?? 0, newlyLive: delta.newlyLive ?? 0, failed: delta.failed ?? 0, estBytes: delta.estBytes ?? 0 });
  }
});
export function finalizeRunTarget(runId: string, targetId: number, state: "verified" | "failed" | "skipped", result: string | null, delta: { verified?: number; newFiber?: number; newlyLive?: number; failed?: number; estBytes?: number }): void {
  _finalizeTx(runId, targetId, state, result, delta);
}

// Return orphaned 'inflight' rows to the queue (crash recovery on resume).
export function resetInflightTargets(runId: string): number {
  return rawDb.prepare(`UPDATE scan_run_targets SET state='queued' WHERE run_id=? AND state='inflight'`).run(runId).changes;
}

// Terminalize a run's remaining queued/inflight tail (e.g. when the run's
// budget is already exhausted). Without this the tail stays 'queued' forever
// and the stranded-tail drain re-opens the run every tick — an infinite
// re-open livelock that stalls all scanning (observed live, 43 runs).
export function terminalizeQueuedTail(runId: string, reason: string): number {
  return rawDb.prepare(
    `UPDATE scan_run_targets SET state='skipped', result=?, next_attempt_at=NULL
      WHERE run_id=? AND state IN ('queued','inflight')`,
  ).run(reason, runId).changes;
}

// One-shot boot backfill: terminalize the ALREADY-EXHAUSTED needs-fix tail
// (queued targets at attemptCap+ attempts whose last error is the needs-fix
// family) WITHOUT burning one more check each — the recorded history IS the
// evidence the live path would re-gather. Idempotent: finalized rows leave
// 'queued' and never match again.
// ASYNC + inter-chunk yield: this can finalize up to 100k targets (~300k UPDATEs) in
// one call. Running it as one synchronous burst blocks the event loop for its whole
// duration; on the cluster's control worker that stalls the HTTP it serves. Yield to
// the loop between 500-row transactions so /api stays responsive even mid-backfill.
// (Each chunk is still a single atomic transaction — no partial-finalize hazard.)
export async function finalizeAddressNotFoundBacklog(attemptCap: number): Promise<{ targets: number; runs: number }> {
  const rows = rawDb.prepare(
    `SELECT rt.run_id AS runId, rt.target_id AS targetId, rt.attempt_count AS attempts
       FROM scan_run_targets rt
      WHERE rt.state='queued' AND rt.attempt_count >= ?
        AND (rt.last_error_message LIKE '%AddressNeedsFix%' OR rt.last_error_message LIKE '%AddressSuggestions%')
      LIMIT 100000`,
  ).all(attemptCap) as Array<{ runId: string; targetId: number; attempts: number }>;
  if (!rows.length) return { targets: 0, runs: 0 };
  // Each park ADVANCES the generation (MAX(attempts+1, GIVEUP)) so the shared
  // escalating quiet window backs this address off 14 → 28 → 56 → 112 days.
  // The old MAX(attempts, GIVEUP) pinned every address at generation 0, so all
  // 285k parked rows re-entered the rotation together every 14 days.
  const park = rawDb.prepare(
    `UPDATE scan_targets SET inconclusive_attempts = MAX(inconclusive_attempts + 1, ?), last_inconclusive_at = datetime('now')
      WHERE id = ? AND last_scanned_at IS NULL`,
  );
  const runsTouched = new Set<string>();
  const chunk = rawDb.transaction((batch: typeof rows) => {
    for (const r of batch) {
      finalizeRunTarget(r.runId, r.targetId, "failed", `address_not_found: backfill after ${r.attempts} needs-fix attempts`, { failed: 1 });
      park.run(INCONCLUSIVE_GIVEUP, r.targetId);
      runsTouched.add(r.runId);
    }
  });
  for (let i = 0; i < rows.length; i += 500) {
    chunk(rows.slice(i, i + 500));
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { targets: rows.length, runs: runsTouched.size };
}

// Requeue ONE target after a TRANSIENT provider error (token/throttle/network) so
// it is retried later in the SAME run. It is neither verified nor failed — no
// progress is lost, no address is skipped, and there is no retry-count limit. The
// attempt_count already incremented at claim time is kept for observability.
//
// delaySeconds > 0 sets next_attempt_at so the target is not immediately re-claimed.
// Used for NON-CONCLUSIVE answers (brand-new addresses Kinetic returns as
// AddressNeedsFix/AddressSuggestions): retrying them every second is wasteful and
// keeps the run spinning forever, so they back off and get retried on a slower
// cadence — the run drains (finishes) instead of never completing. A pure transient
// (throttle/token/admission timeout) still uses delaySeconds=0 (retry promptly).
const _requeueTarget = rawDb.prepare(`UPDATE scan_run_targets SET state='queued', next_attempt_at=NULL WHERE run_id=? AND target_id=? AND state='inflight'`);
const _requeueTargetDelayed = rawDb.prepare(`UPDATE scan_run_targets SET state='queued', next_attempt_at=datetime('now', ?) WHERE run_id=? AND target_id=? AND state='inflight'`);
export function requeueRunTarget(runId: string, targetId: number, delaySeconds = 0): void {
  if (delaySeconds > 0) _requeueTargetDelayed.run(`+${Math.floor(delaySeconds)} seconds`, runId, targetId);
  else _requeueTarget.run(runId, targetId);
}

// Cost honesty for retried attempts: a transient failure still burned proxy
// bytes for its request. Under-counting cost is never acceptable.
export function addRunBytes(runId: string, bytes: number): void {
  const amount = Math.max(0, Math.floor(Number(bytes) || 0));
  if (!amount) return;
  rawDb.prepare(`UPDATE scan_runs SET est_bytes=est_bytes+?,updated_at=datetime('now') WHERE id=?`).run(amount, runId);
}

// Just move the heartbeat forward (worker liveness) without changing counters.
export function touchRun(runId: string): void {
  rawDb.prepare(`UPDATE scan_runs SET heartbeat_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(runId);
}


export function setRunStatus(runId: string, status: string, error?: string | null): void {
  const done = status === "done" || status === "error" || status === "cancelled";
  rawDb.prepare(
    `UPDATE scan_runs SET status=?, error=?, heartbeat_at=datetime('now'),updated_at=datetime('now'), completed_at=${done ? "datetime('now')" : "completed_at"} WHERE id=?`,
  ).run(status, error ?? null, runId);
}

export function getRun(runId: string, tenantId: number): ScanRunRow | undefined {
  ensureReopenColumn();
  return g<ScanRunRow>(
    `SELECT ${RUN_COLS}
       FROM scan_runs WHERE id=? AND tenant_id=?`,
    runId, tenantId,
  );
}

export function listRuns(
  tenantId: number,
  limit = 20,
  scope: { city?: string | null; state?: string | null } = {},
): ScanRunRow[] {
  ensureReopenColumn();
  const clauses = ["tenant_id=@tenantId"];
  if (scope.city) clauses.push("lower(trim(city))=lower(trim(@city))");
  if (scope.state) clauses.push("upper(trim(state))=upper(trim(@state))");
  return all<ScanRunRow>(
    `SELECT ${RUN_COLS}
       FROM scan_runs WHERE ${clauses.join(" AND ")} ORDER BY started_at DESC LIMIT @limit`,
    { tenantId, city: scope.city ?? null, state: scope.state ?? null, limit: Math.min(200, Math.max(1, limit)) },
  );
}

// Runs that were 'running' when the process died — the resume set. Only runs
// whose heartbeat is stale (no live worker) to avoid double-dispatch.
export function getResumableRuns(staleSeconds = 30): ScanRunRow[] {
  ensureReopenColumn();
  return all<ScanRunRow>(
    `SELECT ${RUN_COLS}
       FROM scan_runs
      WHERE status='running' AND (heartbeat_at IS NULL OR heartbeat_at <= datetime('now', ?))`,
    `-${staleSeconds} seconds`,
  );
}

// Pending = still to process (queued OR mid-flight). "Queue drained" means 0.
export function countQueued(runId: string): number {
  return g<{ c: number }>(`SELECT COUNT(*) c FROM scan_run_targets WHERE run_id=? AND state IN ('queued','inflight')`, runId).c;
}

// ── Fleet heartbeat metrics (C4) — one cheap COUNT each, all failure-safe ───
// Fleet-wide claimable backlog: queued AND due right now (backoff rows excluded).
export function countClaimableQueued(): number {
  try {
    return g<{ c: number }>(`SELECT COUNT(*) c FROM scan_run_targets WHERE state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=datetime('now'))`).c;
  } catch { return 0; }
}

// Runs currently marked running (worker-owned or awaiting the reaper).
export function countActiveRuns(): number {
  try {
    return g<{ c: number }>(`SELECT COUNT(*) c FROM scan_runs WHERE status='running'`).c;
  } catch { return 0; }
}

// Open dead letters (NULL when the table isn't migrated on this DB yet).
export function countOpenDeadLetters(): number | null {
  try {
    return g<{ c: number }>(`SELECT COUNT(*) c FROM fiber_dead_letters WHERE resolved_at IS NULL`).c;
  } catch { return null; }
}

// STRANDED TAILS: runs marked 'done' OR 'error' that still hold CLAIMABLE queued
// targets. 'done': a target requeued in the same instant the batch drained, so the
// worker finished while work remained. 'error': the worker died on a terminal
// exception (e.g. one transient throw during dispatch) but its queued addresses are
// still perfectly claimable — leaving them stranded until the next full sweep loses
// time on real leads (seen live: a PRIORITY market run erroring with 486 queued).
// NOT 'cancelled' — those were deliberately stopped (e.g. shed expansion runs) and
// must not resurrect. Re-opening lets a worker drain the tail; the requeue backoff
// guarantees it converges (finishes) instead of spinning.
//
// ── WHY `id IN (...)` AND NOT `EXISTS (...)` ────────────────────────────────
// This runs every 60s from startScanReaper(), on every worker that also serves
// HTTP, and better-sqlite3 is synchronous — so its cost lands directly on the
// event loop. `scan_runs` holds ~555k terminal rows in production and nothing
// prunes them (pruneTerminalScanRuns exists but is deliberately unwired; see
// dbPrune.ts), so the shape of this one query decides whether the loop stalls.
//
// The correlated EXISTS made the cost O(terminal runs): SQLite walked the
// status index and ran the subquery once PER RUN, ~555k probes, before the
// LIMIT could apply. Inverting it makes the cost O(claimable queued targets) —
// the driving set is now the handful of rows that are actually queued, and the
// runs are looked up by rowid from that list.
//
// MEASURED, on a synthetic table built to the production distribution
// (555,744 done + 2 error, 47 stranded, EXACTLY the production index set,
// nothing added):
//     EXISTS  (before) : 0.144s
//     id IN   (after)  : 0.020s   — same ten rows, in the same order
//
// A `scan_run_targets(state, run_id)` index takes this to ~0.000s, and it is
// deliberately NOT added: scan_run_targets is the largest table in the
// database (5.57 GB of rows plus 4.56 GB of indexes) and the box it runs on
// has ~7.6 GB free, which is already why deploys pass with_backup=false. A 7x
// win for a pure query change beats a 100x win that needs multiple GB the host
// does not have. The partial idx_srt_pending does not help here — SQLite
// declines it for this predicate; verified, do not re-add it expecting a win.
export function getStrandedDoneRuns(limit = 10): ScanRunRow[] {
  return all<ScanRunRow>(
    `SELECT r.id, r.tenant_id AS tenantId, r.kind, r.label, r.city, r.state, r.bbox, r.budget, r.verified,
            r.new_fiber AS newFiber, r.newly_live AS newlyLive, r.failed, r.status, r.error,
            r.est_bytes AS estBytes, r.created_by AS createdBy, r.started_at AS startedAt,
            r.heartbeat_at AS heartbeatAt, r.completed_at AS completedAt,
            r.reopen_count AS reopenCount
       FROM scan_runs r
      WHERE r.status IN ('done','error') AND r.id IN (
        SELECT t.run_id FROM scan_run_targets t WHERE t.state='queued'
          AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= datetime('now')))
      ORDER BY r.completed_at ASC LIMIT ?`,
    limit,
  );
}

// ── Per-target scan memory (used by the live engine) ──────────────────────────
export function getTargetSnapshot(id: number): { everScanned: boolean; wasLive: boolean; fiberAvailable: boolean } {
  const r = g<any>(`SELECT last_scanned_at AS s, last_is_new_fiber AS nf, last_billing_status AS bs,
                           last_fiber_available AS fa, last_fiber_status AS fs
                      FROM scan_targets WHERE id=?`, id);
  if (!r) return { everScanned: false, wasLive: false, fiberAvailable: false };
  const inferredFiber = ["new_fiber", "existing_fiber", "tenured_fiber"].includes(String(r.fs ?? ""));
  return { everScanned: !!r.s, wasLive: !!r.nf && r.bs === "N", fiberAvailable: r.fa == null ? inferredFiber : !!r.fa };
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

// Compute a worked territory's field outcome from its leads + knocks. The
// "dominant city" is where most of its leads live — that's the market the
// lesson belongs to. This is the input to the learning loop: a territory that
// converted well lifts its market's priority; one that didn't, lowers it.
export interface TerritoryOutcome {
  city: string; state: string;
  doors: number;      // leads in the territory
  knocks: number;     // total knock attempts
  contacts: number;   // knocks where someone was home
  sales: number;      // leads that sold
  daysActive: number | null;
}
export function computeTerritoryOutcome(territoryId: number, createdAt: string | null): TerritoryOutcome | null {
  const leads = all<{ id: number; city: string | null; state: string | null; sold: number }>(
    `SELECT id, city, state, CASE WHEN lead_status='sold' THEN 1 ELSE 0 END AS sold
       FROM leads WHERE assigned_territory_id = ?`, territoryId);
  if (leads.length === 0) return null;
  // Dominant city among the territory's leads.
  const cityCount = new Map<string, { city: string; state: string; n: number }>();
  for (const l of leads) {
    if (!l.city) continue;
    const k = key(l.city, l.state ?? "NC");
    const e = cityCount.get(k);
    if (e) e.n++; else cityCount.set(k, { city: l.city, state: l.state ?? "NC", n: 1 });
  }
  const dom = [...cityCount.values()].sort((a, b) => b.n - a.n)[0];
  if (!dom) return null;
  const km = g<{ knocks: number; contacts: number }>(
    `SELECT COUNT(*) AS knocks, SUM(CASE WHEN was_home=1 THEN 1 ELSE 0 END) AS contacts
       FROM knock_log WHERE lead_id IN (SELECT id FROM leads WHERE assigned_territory_id = ?)`, territoryId);
  const sales = leads.reduce((s, l) => s + (l.sold ? 1 : 0), 0);
  const daysActive = createdAt ? Math.max(0, Math.round((Date.now() - (Date.parse(createdAt + "Z") || Date.parse(createdAt))) / 86_400_000)) : null;
  return { city: dom.city, state: dom.state, doors: leads.length, knocks: km?.knocks ?? 0, contacts: km?.contacts ?? 0, sales, daysActive };
}

// ── Releasing an area's doors ────────────────────────────────────────────────
// Called when a territory is deleted. TWO writes, deliberately separate:
//
//   1. the REP — every door in the area loses whoever holds it, one rep or five
//      (`clearReps`, the default; see areaDeleteClearsRep in @shared/territory,
//      the same rule stated once in TypeScript). Skipped entirely when the
//      caller chose "keep", which is what makes the old behaviour reachable.
//   2. the AREA LINK, for every door — unconditional. The old hard-delete did
//      neither and orphaned 2,855 leads pointing at nonexistent territories.
//
// The rep write runs FIRST and is predicated on assigned_territory_id, so it
// must happen while the link still exists. Both run in one transaction: a door
// that lost its area but kept a rep nobody can see is precisely the half-state
// this whole change exists to remove.

export interface TerritoryReleaseResult {
  /** Doors whose area link was cleared. */
  detached: number;
  /** Of those, the ones that also lost their rep. */
  repCleared: number;
  /** Which reps lost doors — the names a manager reads in the toast. Ordered by
   *  lead id, so the list reads the same way twice. */
  repIdsCleared: number[];
  /** Every door touched, captured BEFORE the write: once the link is NULL there
   *  is no way left to ask which doors it was cleared from. */
  leadIds: number[];
}

export function releaseTerritoryLeads(
  territoryId: number,
  opts: { clearReps?: boolean; at?: string } = {},
): TerritoryReleaseResult {
  const at = opts.at ?? new Date().toISOString();
  const clearReps = opts.clearReps === true;

  const apply = rawDb.transaction(() => {
    const before = all<{ id: number; assigned_rep_id: number | null }>(
      `SELECT id, assigned_rep_id FROM leads WHERE assigned_territory_id = ? ORDER BY id`, territoryId);

    let repCleared = 0;
    const repIdsCleared: number[] = [];
    if (clearReps) {
      // assignment_source / assigned_by / assigned_at go with the rep: they
      // describe an assignment that no longer exists, and leaving them behind
      // makes the Leads table print "Territory sync" under an empty owner.
      repCleared = rawDb.prepare(
        `UPDATE leads
            SET assigned_rep_id = NULL, assignment_source = NULL, assigned_by = NULL,
                assigned_at = NULL, unassigned_at = ?, updated_at = ?
          WHERE assigned_territory_id = ? AND assigned_rep_id IS NOT NULL`,
      ).run(at, at, territoryId).changes;
      for (const r of before) {
        if (r.assigned_rep_id != null && !repIdsCleared.includes(r.assigned_rep_id)) {
          repIdsCleared.push(r.assigned_rep_id);
        }
      }
    }

    // updated_at moves with the write — the map's data-version/ETag is derived
    // from MAX(updated_at), so a silent clear must never serve a stale 304.
    const detached = rawDb.prepare(
      `UPDATE leads SET assigned_territory_id = NULL, updated_at = ? WHERE assigned_territory_id = ?`,
    ).run(at, territoryId).changes;

    return { detached, repCleared, repIdsCleared, leadIds: before.map((r) => r.id) };
  });

  return apply.immediate() as TerritoryReleaseResult;
}

// Clear leads' territory ref WITHOUT touching their rep assignment. Kept as the
// narrow form for callers that only ever meant "de-orphan" (the scan engine's
// housekeeping); the delete route goes through releaseTerritoryLeads above.
export function clearTerritoryFromLeads(territoryId: number): number {
  return releaseTerritoryLeads(territoryId).detached;
}

function key(city: string, state: string): string { return `${(city || "").toLowerCase()}|${(state || "").toLowerCase()}`; }
function num(n: number): number { return Number.isFinite(n) ? n : 0; }
