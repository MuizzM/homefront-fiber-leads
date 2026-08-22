// ── Buyer score job: score every open door, bounded, tenant by tenant ────────
// The pure model lives in shared/buyerScore.ts. This file owns the I/O around
// it: which rows to score, the two aggregates the model cannot compute from a
// lead row alone (knock history, sold neighbours within 150 m), the write, and
// the bounds that keep a 180k-lead tenant from stalling the HTTP loop.
//
// BOUNDS. Batches of BUYER_SCORE_BATCH rows, a setImmediate yield between
// batches, and at most BUYER_SCORE_RUN_CAP rows per tenant per run. The run
// walks the STALEST rows first (never scored, then oldest stamp), so a tenant
// bigger than the cap converges over consecutive nightly runs instead of
// re-scoring the same prefix forever.
//
// TENANCY. Every read and write carries tenant_id. The sold-neighbour index is
// built per tenant from that tenant's sales only, so a sale next door in
// another org can never lift a score here.
//
// WRITES. Only the three buyer columns. updated_at is NOT bumped: scoring is
// not activity, and the Leads list's "Last activity" and staleness read it.

import { structuredLog } from "./structuredLog";
import { rawDb } from "./db";
import {
  NEIGHBOR_DAYS, NEIGHBOR_RADIUS_M, scoreBuyer,
  type BuyerKnockSummary, type BuyerScoreResult,
} from "@shared/buyerScore";
import { haversineMeters } from "@shared/knock";

export const BUYER_SCORE_BATCH = 200;
/** Rows per tenant per pass. A 180k-lead tenant converges in three passes. */
export const BUYER_SCORE_RUN_CAP = 60_000;
/** The background timer's cadence (server/index.ts). */
export const BUYER_SCORE_INTERVAL_MS = 6 * 60 * 60_000;
/** A background pass skips rows scored more recently than this, so the
 *  6-hour tick re-scores each door about daily and spends the rest of its cap
 *  on doors it has never reached. The manager's on-demand run passes 0. */
export const BUYER_SCORE_MAX_AGE_MS = 20 * 60 * 60_000;

interface LeadScoreRow {
  id: number;
  tenant_id: number | null;
  lead_status: string;
  last_outcome: string | null;
  do_not_knock: number | null;
  household_segment_type: string | null;
  billing_status: string | null;
  fiber_status: string | null;
  is_new_fiber: number | null;
  tech_type: string | null;
  max_download_mbps: number | null;
  fresh_confirmed_at: string | null;
  competitor_name: string | null;
  competitor_tech: string | null;
  is_homeowner: number | null;
  years_at_address: number | null;
  lat: number | null;
  lng: number | null;
}

const LEAD_COLS = `id, tenant_id, lead_status, last_outcome, do_not_knock, household_segment_type, billing_status,
  fiber_status, is_new_fiber, tech_type, max_download_mbps, fresh_confirmed_at, competitor_name, competitor_tech,
  is_homeowner, years_at_address, lat, lng`;

// ── Sold-neighbour index ──────────────────────────────────────────────────────
// ~0.002° cells (about 220 m of latitude), so a 150 m radius never needs more
// than the 3x3 neighbourhood of the door's own cell.
const CELL_DEG = 0.002;
type SoldIndex = Map<string, Array<{ lat: number; lng: number }>>;

function cellKey(lat: number, lng: number): string {
  return `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / CELL_DEG)}`;
}

function buildSoldIndex(tenantId: number, nowMs: number): SoldIndex {
  const since = new Date(nowMs - NEIGHBOR_DAYS * 86_400_000).toISOString();
  const rows = rawDb.prepare(`
    SELECT id, lat, lng FROM leads
     WHERE tenant_id = ? AND lead_status = 'sold' AND lat IS NOT NULL AND lng IS NOT NULL
       AND COALESCE(last_outcome_at, updated_at) >= ?
  `).all(tenantId, since) as Array<{ id: number; lat: number; lng: number }>;
  const idx: SoldIndex = new Map();
  for (const r of rows) {
    const k = cellKey(r.lat, r.lng);
    let bucket = idx.get(k);
    if (!bucket) { bucket = []; idx.set(k, bucket); }
    bucket.push({ lat: r.lat, lng: r.lng });
  }
  return idx;
}

function neighborSales(idx: SoldIndex, lat: number | null, lng: number | null, selfLat?: number | null, selfLng?: number | null): number {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return 0;
  const cx = Math.floor(lat / CELL_DEG), cy = Math.floor(lng / CELL_DEG);
  let n = 0;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const bucket = idx.get(`${cx + dx}:${cy + dy}`);
      if (!bucket) continue;
      for (const p of bucket) {
        // A sold door at the exact same point is this door's own prior
        // sale (or a duplicate pin), not a neighbour.
        if (p.lat === selfLat && p.lng === selfLng) continue;
        if (haversineMeters({ lat, lng }, p) <= NEIGHBOR_RADIUS_M) n += 1;
      }
    }
  }
  return n;
}

// ── Knock history per lead, one query per batch ───────────────────────────────
function knockSummaries(ids: number[]): Map<number, BuyerKnockSummary> {
  const out = new Map<number, BuyerKnockSummary>();
  if (!ids.length) return out;
  const rows = rawDb.prepare(`
    SELECT lead_id AS leadId,
           SUM(CASE WHEN outcome = 'not_home' THEN 1 ELSE 0 END) AS notHome,
           SUM(CASE WHEN outcome = 'interested' THEN 1 ELSE 0 END) AS interested,
           SUM(CASE WHEN outcome IN ('callback', 'go_back', 'follow_up') THEN 1 ELSE 0 END) AS followUp,
           COUNT(*) AS total
      FROM knock_log
     WHERE COALESCE(superseded, 0) = 0 AND lead_id IN (SELECT value FROM json_each(?))
     GROUP BY lead_id
  `).all(JSON.stringify(ids)) as Array<{ leadId: number; notHome: number; interested: number; followUp: number; total: number }>;
  for (const r of rows) out.set(r.leadId, { notHome: r.notHome, interested: r.interested, followUp: r.followUp, total: r.total });
  return out;
}

function toInput(row: LeadScoreRow, knocks: BuyerKnockSummary | null, neighbors: number, nowMs: number) {
  return {
    leadStatus: row.lead_status,
    lastOutcome: row.last_outcome,
    doNotKnock: row.do_not_knock,
    householdSegmentType: row.household_segment_type,
    billingStatus: row.billing_status,
    fiberStatus: row.fiber_status,
    isNewFiber: row.is_new_fiber,
    techType: row.tech_type,
    maxDownloadMbps: row.max_download_mbps,
    freshConfirmedAt: row.fresh_confirmed_at,
    competitorName: row.competitor_name,
    competitorTech: row.competitor_tech,
    isHomeowner: row.is_homeowner,
    yearsAtAddress: row.years_at_address,
    knocks,
    neighborSales: neighbors,
    nowMs,
  };
}

const writeStmt = () => rawDb.prepare(
  `UPDATE leads SET buyer_score = ?, buyer_score_reasons = ?, buyer_scored_at = ? WHERE id = ? AND tenant_id IS ?`,
);

function persist(row: LeadScoreRow, result: BuyerScoreResult, stampIso: string, stmt: ReturnType<typeof writeStmt>) {
  stmt.run(result.score, result.score == null ? null : JSON.stringify(result.reasons), stampIso, row.id, row.tenant_id);
}

function bustPins(tenantId: number | null | undefined) {
  const bust = (globalThis as any).__bustMapCache;
  if (typeof bust === "function") bust(tenantId ?? undefined);
}

export interface BuyerScoreRunSummary {
  tenantId: number;
  scored: number;
  removed: number;
  tookMs: number;
  /** True when the tenant had more stale rows than the run cap; the next run continues. */
  capped: boolean;
  ranAt: string;
}

const lastRuns = new Map<number, BuyerScoreRunSummary>();
const running = new Set<number>();

export function buyerScoreLastRun(tenantId: number): BuyerScoreRunSummary | null {
  return lastRuns.get(tenantId) ?? null;
}
export function buyerScoreRunning(tenantId: number): boolean {
  return running.has(tenantId);
}

/**
 * Score the stalest rows of one tenant, bounded. Resolves with what it did.
 * Safe to call while a previous run is in flight for ANOTHER tenant; a second
 * call for the same tenant returns null instead of racing the first.
 */
export async function rescoreTenant(
  tenantId: number,
  opts: { nowMs?: number; cap?: number; batch?: number; yieldBetweenBatches?: boolean; maxAgeMs?: number } = {},
): Promise<BuyerScoreRunSummary | null> {
  if (running.has(tenantId)) return null;
  running.add(tenantId);
  const started = performance.now();
  const nowMs = opts.nowMs ?? Date.now();
  const cap = Math.max(1, Math.floor(opts.cap ?? BUYER_SCORE_RUN_CAP));
  const batch = Math.max(1, Math.floor(opts.batch ?? BUYER_SCORE_BATCH));
  const maxAgeMs = Math.max(0, opts.maxAgeMs ?? 0);
  const stampIso = new Date(nowMs).toISOString();
  let scored = 0, removed = 0;
  try {
    // Never scored first, then the stalest stamps; rows fresher than maxAgeMs
    // are left alone so a bounded pass spends its cap where it matters.
    const staleBefore = new Date(nowMs - maxAgeMs).toISOString();
    const ids = (rawDb.prepare(`
      SELECT id FROM leads
       WHERE tenant_id = ? AND (buyer_scored_at IS NULL OR buyer_scored_at < ?)
       ORDER BY (buyer_scored_at IS NULL) DESC, buyer_scored_at ASC, id ASC
       LIMIT ?
    `).all(tenantId, staleBefore, cap + 1) as Array<{ id: number }>).map((r) => r.id);
    const capped = ids.length > cap;
    if (capped) ids.length = cap;
    const soldIdx = buildSoldIndex(tenantId, nowMs);
    const select = rawDb.prepare(`SELECT ${LEAD_COLS} FROM leads WHERE tenant_id = ? AND id IN (SELECT value FROM json_each(?))`);
    const stmt = writeStmt();
    const writeBatch = rawDb.transaction((rows: LeadScoreRow[], knocks: Map<number, BuyerKnockSummary>) => {
      for (const row of rows) {
        const result = scoreBuyer(toInput(row, knocks.get(row.id) ?? null, neighborSales(soldIdx, row.lat, row.lng, row.lat, row.lng), nowMs));
        persist(row, result, stampIso, stmt);
        if (result.score == null) removed += 1; else scored += 1;
      }
    });
    for (let i = 0; i < ids.length; i += batch) {
      const slice = ids.slice(i, i + batch);
      const rows = select.all(tenantId, JSON.stringify(slice)) as LeadScoreRow[];
      writeBatch(rows, knockSummaries(slice));
      if (opts.yieldBetweenBatches !== false && i + batch < ids.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    const summary: BuyerScoreRunSummary = {
      tenantId, scored, removed, tookMs: Math.round(performance.now() - started), capped, ranAt: stampIso,
    };
    lastRuns.set(tenantId, summary);
    if (scored + removed > 0) bustPins(tenantId);
    return summary;
  } finally {
    running.delete(tenantId);
  }
}

/**
 * Re-score ONE door synchronously, for the knock path: the rep just learned
 * something about this house and the number should say so on the next poll.
 * Best-effort by contract; callers wrap it so the hot path never fails on it.
 */
export function rescoreLead(leadId: number, nowMs = Date.now()): BuyerScoreResult | null {
  const row = rawDb.prepare(`SELECT ${LEAD_COLS} FROM leads WHERE id = ?`).get(leadId) as LeadScoreRow | undefined;
  if (!row || row.tenant_id == null) return null;
  // One door: a bounded box query instead of the whole tenant index.
  let neighbors = 0;
  if (row.lat != null && row.lng != null) {
    const dLat = NEIGHBOR_RADIUS_M / 111_320;
    const dLng = NEIGHBOR_RADIUS_M / (111_320 * Math.max(0.2, Math.cos((row.lat * Math.PI) / 180)));
    const since = new Date(nowMs - NEIGHBOR_DAYS * 86_400_000).toISOString();
    const near = rawDb.prepare(`
      SELECT lat, lng FROM leads
       WHERE tenant_id = ? AND lead_status = 'sold' AND id != ?
         AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
         AND COALESCE(last_outcome_at, updated_at) >= ?
    `).all(row.tenant_id, row.id, row.lat - dLat, row.lat + dLat, row.lng - dLng, row.lng + dLng, since) as Array<{ lat: number; lng: number }>;
    for (const p of near) if (haversineMeters({ lat: row.lat, lng: row.lng }, p) <= NEIGHBOR_RADIUS_M) neighbors += 1;
  }
  const result = scoreBuyer(toInput(row, knockSummaries([row.id]).get(row.id) ?? null, neighbors, nowMs));
  persist(row, result, new Date(nowMs).toISOString(), writeStmt());
  bustPins(row.tenant_id);
  return result;
}

/** The background pass: every tenant, one after another, each bounded. */
export async function runBuyerScoreForAllTenants(log: (msg: string) => void = () => {}): Promise<BuyerScoreRunSummary[]> {
  const tenants = rawDb.prepare(`SELECT id FROM tenants ORDER BY id`).all() as Array<{ id: number }>;
  const out: BuyerScoreRunSummary[] = [];
  for (const t of tenants) {
    try {
      const s = await rescoreTenant(t.id, { maxAgeMs: BUYER_SCORE_MAX_AGE_MS });
      if (s) {
        out.push(s);
        log(`[buyer-score] tenant ${t.id}: scored ${s.scored}, removed ${s.removed}, ${s.tookMs}ms${s.capped ? " (capped, continues next run)" : ""}`);
        // Counts and a duration only, so the perf report can set a pass beside
        // the loop-lag minute it ran in.
        structuredLog("buyer_score.pass", { pid: process.pid, tenantId: t.id, scored: s.scored, removed: s.removed, tookMs: s.tookMs, capped: s.capped });
      }
    } catch (e: any) {
      log(`[buyer-score] tenant ${t.id} failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  return out;
}

/** Band counts for the status endpoint: one indexed-free COUNT per tenant. */
export function buyerScoreBands(tenantId: number): { scored: number; likely: number; possible: number; unlikely: number } {
  const r = rawDb.prepare(`
    SELECT COUNT(buyer_score) AS scored,
           SUM(CASE WHEN buyer_score >= 8 THEN 1 ELSE 0 END) AS likely,
           SUM(CASE WHEN buyer_score >= 5 AND buyer_score < 8 THEN 1 ELSE 0 END) AS possible,
           SUM(CASE WHEN buyer_score < 5 THEN 1 ELSE 0 END) AS unlikely
      FROM leads WHERE tenant_id = ?
  `).get(tenantId) as { scored: number; likely: number | null; possible: number | null; unlikely: number | null };
  return { scored: r.scored ?? 0, likely: r.likely ?? 0, possible: r.possible ?? 0, unlikely: r.unlikely ?? 0 };
}
