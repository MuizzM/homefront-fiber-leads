// ── Sales-intelligence lead ranking ───────────────────────────────────────────
// One read-only endpoint — GET /api/leads/ranked — that orders the tenant's
// assignable confirmed-fresh leads by a composite "knock this door first" score.
// Every input is computed from EXISTING tables (leads, scan_new_builds,
// availability_snapshots, lead_expansions/expansion_members); nothing here
// writes, scans, or spends. The scoring function is pure + deterministic
// (nowMs injected) so it is unit-testable with fixtures.
//
// Score anatomy (weights are the named constants below):
//   • recency          — minutes since fresh_confirmed_at, exponential decay
//                        (a lead lit 40 minutes ago outranks one from Tuesday)
//   • newly lit        — the moat: a prior CONCLUSIVE coming-soon/unavailable
//                        snapshot for the same target proves we watched it flip
//   • new build        — the source target is a tracked scan_new_builds address
//   • green density    — confirmed-fresh neighbors within DENSITY_RADIUS_M
//   • cluster yield    — the target belongs to a lead_expansions cluster; the
//                        cluster's fresh_found is evidence the street is hot
//   • territory fit    — already routed (rep or territory) = actionable now
import type { Express, NextFunction, Request, Response } from "express";
import { rawDb } from "./db";
import { getDefaultTenantId, storage } from "./storage";
import { haversineMeters } from "@shared/freshFiberClusters";

// ── Tunables (named so the weights read as product decisions, not magic) ──────
export const RANK_WEIGHTS = {
  /** Max points for a just-lit lead; decays exponentially with age. */
  RECENCY_MAX: 40,
  /** Recency half-life in minutes — a day later the recency points halve. */
  RECENCY_HALF_LIFE_MIN: 24 * 60,
  /** Bonus for a proven not-serviceable → live flip (NEWLY_LIT — the moat). */
  NEWLY_LIT_BONUS: 20,
  /** Max bonus when the source target is a tracked new-build address. */
  NEW_BUILD_MAX: 15,
  /** Max points for confirmed-fresh neighbors within DENSITY_RADIUS_M. */
  DENSITY_MAX: 15,
  /** Neighbor count at which density points saturate. */
  DENSITY_NEIGHBOR_CAP: 10,
  /** Max points for the yield of the lead's expansion cluster. */
  CLUSTER_YIELD_MAX: 10,
  /** fresh_found at which cluster-yield points saturate. */
  CLUSTER_YIELD_CAP: 10,
  /** Small "actionable now" bonus when already routed to a rep/territory. */
  TERRITORY_FIT_BONUS: 5,
} as const;

/** new-build confidence → fraction of NEW_BUILD_MAX awarded. */
export const NEW_BUILD_CONFIDENCE_FACTOR: Record<string, number> = {
  authoritative: 1,    // county/state GIS said so
  observed: 0.6,       // OSM/heuristic observation
};
const NEW_BUILD_DEFAULT_FACTOR = 0.6;

/** Radius for the nearby-green-density signal (meters). */
export const DENSITY_RADIUS_M = 800;
/** Proximity-cluster cell (~500 m) used when a lead has no expansion cluster. */
export const PROXIMITY_CELL_DEG = 0.005;
/** In-memory scoring pool cap — freshest leads first (well above prod counts). */
export const RANKING_POOL_MAX = 3000;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

// ── Pure scoring ──────────────────────────────────────────────────────────────
export interface LeadRankSignals {
  /** leads.fresh_confirmed_at — ISO or SQLite "YYYY-MM-DD HH:MM:SS" (UTC). */
  freshConfirmedAt: string | null;
  /** Fallback recency anchor when fresh_confirmed_at is absent. */
  createdAt?: string | null;
  /** Source target tracked in scan_new_builds. */
  newBuild?: { buildStage: string | null; confidence: string | null } | null;
  /** Proven prior conclusive non-serviceable state for the source target. */
  newlyLit?: { priorState: "coming_soon" | "unavailable" } | null;
  /** Confirmed-fresh leads within DENSITY_RADIUS_M (excluding this one). */
  nearbyFreshCount?: number;
  /** fresh_found of the expansion cluster this target belongs to (null = none). */
  clusterFreshFound?: number | null;
  assignedRepId?: number | null;
  assignedTerritoryId?: number | null;
}

// Both timestamp formats live in these tables (ISO "…T…Z" and SQLite
// "YYYY-MM-DD HH:MM:SS", both UTC) — same normalization the client's fmtTime uses.
export function parseDbTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function formatAge(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

/** Pure composite score + human-readable reasons for one lead. */
export function scoreLead(signals: LeadRankSignals, nowMs: number): { score: number; reasons: string[] } {
  const W = RANK_WEIGHTS;
  let score = 0;
  const reasons: string[] = [];

  // Recency — exponential decay from the confirmed-fresh moment.
  const litMs = parseDbTime(signals.freshConfirmedAt);
  const anchorMs = litMs ?? parseDbTime(signals.createdAt);
  if (anchorMs != null) {
    const ageMin = Math.max(0, (nowMs - anchorMs) / 60_000);
    score += W.RECENCY_MAX * Math.pow(2, -ageMin / W.RECENCY_HALF_LIFE_MIN);
    const age = formatAge(ageMin);
    reasons.push(litMs != null
      ? (age === "just now" ? "lit just now" : `lit ${age}`)
      : (age === "just now" ? "added just now" : `added ${age}`));
  }

  // Newly lit — the proven coming-soon/unavailable → live flip.
  if (signals.newlyLit) {
    score += W.NEWLY_LIT_BONUS;
    reasons.push(`newly lit — was ${signals.newlyLit.priorState === "coming_soon" ? "coming soon" : "unavailable"}`);
  }

  // New-build confidence.
  if (signals.newBuild) {
    const confidence = signals.newBuild.confidence?.toLowerCase() ?? null;
    const factor = (confidence != null ? NEW_BUILD_CONFIDENCE_FACTOR[confidence] : undefined) ?? NEW_BUILD_DEFAULT_FACTOR;
    score += W.NEW_BUILD_MAX * factor;
    reasons.push(confidence ? `new build (${confidence})` : "new build");
  }

  // Nearby green density.
  const nearby = signals.nearbyFreshCount ?? 0;
  if (nearby > 0) {
    score += W.DENSITY_MAX * Math.min(nearby, W.DENSITY_NEIGHBOR_CAP) / W.DENSITY_NEIGHBOR_CAP;
    reasons.push(`${nearby} fresh lead${nearby === 1 ? "" : "s"} within ${DENSITY_RADIUS_M}m`);
  }

  // Expansion-cluster yield.
  const clusterYield = signals.clusterFreshFound;
  if (clusterYield != null && clusterYield > 0) {
    score += W.CLUSTER_YIELD_MAX * Math.min(clusterYield, W.CLUSTER_YIELD_CAP) / W.CLUSTER_YIELD_CAP;
    reasons.push(`cluster yielded ${clusterYield} lead${clusterYield === 1 ? "" : "s"}`);
  }

  // Territory fit — already routed, a rep can act on it right now.
  if (signals.assignedRepId != null || signals.assignedTerritoryId != null) {
    score += W.TERRITORY_FIT_BONUS;
    reasons.push(signals.assignedRepId != null ? "assigned — actionable now" : "inside an assigned territory");
  }

  return { score: Math.round(score * 10) / 10, reasons };
}

// ── DB plumbing ───────────────────────────────────────────────────────────────
interface PoolLead {
  id: number; address: string; city: string; state: string; zip: string | null;
  lat: number | null; lng: number | null;
  tenant_id: number | null; source_scan_target_id: number | null;
  fresh_confirmed_at: string | null; fresh_confidence: string | null;
  assigned_rep_id: number | null; assigned_territory_id: number | null;
  created_at: string | null;
}

const CHUNK = 500;
function chunked<T>(ids: number[], run: (slice: number[]) => T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...run(ids.slice(i, i + CHUNK)));
  return out;
}

// Optional-table guard: scan_new_builds / lead_expansions are created lazily by
// their own subsystems, so a DB that never ran the radar/expansion simply lacks
// them. Missing table = signal absent, never a 500.
function guarded<T>(run: () => T[]): T[] {
  try { return run(); }
  catch (e: any) {
    if (String(e?.message ?? e).includes("no such table")) return [];
    throw e;
  }
}

let _indexReady = false;
function ensureIndexes(): void {
  if (_indexReady) return;
  // Partial index: the ranked pool is exactly "confirmed-fresh, newest first".
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_leads_fresh_confirmed
    ON leads(fresh_confirmed_at DESC) WHERE fresh_confirmed_at IS NOT NULL`);
  // The pool query's actual shape: tenant equality + ORDER BY the replace()
  // expression (mixed 'T'/' ' timestamp formats sort wrong as raw text). The
  // index expression must match the query's ORDER BY byte-for-byte or SQLite
  // will not stream the sort off it — without this the query walked the whole
  // tenant and temp-b-tree-sorted every fresh-confirmed lead per request.
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_leads_fresh_ranked
    ON leads(tenant_id, replace(fresh_confirmed_at, 'T', ' ') DESC) WHERE fresh_confirmed_at IS NOT NULL`);
  _indexReady = true;
}

/** Source targets tracked as new builds. */
function newBuildByTarget(targetIds: number[]): Map<number, { buildStage: string | null; confidence: string | null }> {
  const map = new Map<number, { buildStage: string | null; confidence: string | null }>();
  const rows = chunked(targetIds, (slice) => guarded(() =>
    rawDb.prepare(`SELECT scan_target_id AS tid, build_stage AS buildStage, confidence
      FROM scan_new_builds WHERE scan_target_id IN (${slice.map(() => "?").join(",")})`).all(...slice) as any[]));
  for (const r of rows) if (r.tid != null) map.set(Number(r.tid), { buildStage: r.buildStage ?? null, confidence: r.confidence ?? null });
  return map;
}

/** Targets with a prior CONCLUSIVE coming-soon/unavailable snapshot (the flip proof). */
function priorDarkByTarget(targetIds: number[]): Map<number, { firstBadEpoch: number | null; sawComingSoon: boolean }> {
  const map = new Map<number, { firstBadEpoch: number | null; sawComingSoon: boolean }>();
  const rows = chunked(targetIds, (slice) => guarded(() =>
    rawDb.prepare(`SELECT scan_target_id AS tid,
        MIN(checked_at_epoch) AS firstBadEpoch,
        MAX(CASE WHEN fiber_status='coming_soon' THEN 1 ELSE 0 END) AS sawComingSoon
      FROM availability_snapshots
      WHERE scan_target_id IN (${slice.map(() => "?").join(",")})
        AND conclusive=1
        AND (COALESCE(fiber_available,1)=0 OR fiber_status IN ('coming_soon','no_service') OR transition_status='unavailable')
      GROUP BY scan_target_id`).all(...slice) as any[]));
  for (const r of rows) if (r.tid != null) {
    map.set(Number(r.tid), { firstBadEpoch: r.firstBadEpoch != null ? Number(r.firstBadEpoch) : null, sawComingSoon: Number(r.sawComingSoon) === 1 });
  }
  return map;
}

/** Expansion-cluster membership (origin OR member) → cluster id + fresh_found. */
function expansionByTarget(targetIds: number[]): Map<number, { expansionId: string; freshFound: number }> {
  const map = new Map<number, { expansionId: string; freshFound: number }>();
  const attach = (rows: any[]) => {
    for (const r of rows) {
      if (r.tid == null) continue;
      const tid = Number(r.tid);
      const next = { expansionId: String(r.expansionId), freshFound: Number(r.freshFound) || 0 };
      const prev = map.get(tid);
      if (!prev || next.freshFound > prev.freshFound) map.set(tid, next); // best cluster wins
    }
  };
  attach(chunked(targetIds, (slice) => guarded(() =>
    rawDb.prepare(`SELECT origin_target_id AS tid, id AS expansionId, fresh_found AS freshFound
      FROM lead_expansions WHERE origin_target_id IN (${slice.map(() => "?").join(",")})`).all(...slice) as any[])));
  attach(chunked(targetIds, (slice) => guarded(() =>
    rawDb.prepare(`SELECT em.target_id AS tid, le.id AS expansionId, le.fresh_found AS freshFound
      FROM expansion_members em JOIN lead_expansions le ON le.id = em.expansion_id
      WHERE em.target_id IN (${slice.map(() => "?").join(",")})`).all(...slice) as any[])));
  return map;
}

// Grid-bucketed neighbor count — one pass over the pool, 3×3 cell lookups,
// exact haversine only inside candidate cells. O(n · bucket) instead of O(n²).
function nearbyFreshCounts(pool: PoolLead[]): Map<number, number> {
  const counts = new Map<number, number>();
  const cellLat = DENSITY_RADIUS_M / 111_320; // ≈ radius in degrees latitude
  const buckets = new Map<string, PoolLead[]>();
  const keyOf = (lead: PoolLead) => {
    const lngScale = Math.max(0.2, Math.cos((lead.lat! * Math.PI) / 180));
    return { r: Math.floor(lead.lat! / cellLat), c: Math.floor(lead.lng! / (cellLat / lngScale)) };
  };
  const located = pool.filter((l) => l.lat != null && l.lng != null);
  for (const lead of located) {
    const { r, c } = keyOf(lead);
    const key = `${r}:${c}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(lead);
  }
  for (const lead of located) {
    const { r, c } = keyOf(lead);
    let n = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      for (const other of buckets.get(`${r + dr}:${c + dc}`) ?? []) {
        if (other.id !== lead.id &&
            haversineMeters({ lat: lead.lat!, lng: lead.lng! }, { lat: other.lat!, lng: other.lng! }) <= DENSITY_RADIUS_M) n++;
      }
    }
    counts.set(lead.id, n);
  }
  return counts;
}

export interface RankedLead {
  id: number; address: string; city: string; state: string; zip: string | null;
  lat: number | null; lng: number | null;
  score: number; reasons: string[];
  assignedRepId: number | null; assignedTerritoryId: number | null;
  createdAt: string | null; freshConfirmedAt: string | null; freshConfidence: string | null;
  /** Expansion-cluster id, or a ~500 m proximity cell — for the client's badge. */
  clusterId: string | null;
  /** Ranked leads sharing clusterId (including this one). */
  clusterSize: number;
}

/** Rank the tenant's assignable confirmed-fresh leads. Read-only, one pool pass. */
export function rankLeads(
  tenantId: number | undefined,
  limit: number,
  nowMs: number = Date.now(),
  scope?: number | number[],
): RankedLead[] {
  ensureIndexes();
  // 'now_active' = the address already signed with Kinetic (billing active) — never
  // point a rep at a door that already converted.
  const clauses = ["fresh_confirmed_at IS NOT NULL", "lead_status NOT IN ('sold','not_interested','now_active')"];
  const params: unknown[] = [];
  if (tenantId != null) { clauses.push("tenant_id = ?"); params.push(tenantId); } // getLeadsForMap scoping idiom
  // Visibility scope — the SAME idiom /api/leads composes:
  // a scoped caller (rep → self, team_lead → their team) sees only leads whose
  // assigned rep is in scope. An empty scope matches nothing (fail-closed).
  if (Array.isArray(scope)) {
    clauses.push(scope.length ? `assigned_rep_id IN (${scope.map(() => "?").join(",")})` : "assigned_rep_id = -1");
    params.push(...scope.map((n) => Number(n) | 0));
  } else if (scope != null) {
    clauses.push("assigned_rep_id = ?");
    params.push(Number(scope) | 0);
  }
  const pool = rawDb.prepare(`
    SELECT id, address, city, state, zip, lat, lng, tenant_id, source_scan_target_id,
           fresh_confirmed_at, fresh_confidence, assigned_rep_id, assigned_territory_id, created_at
    FROM leads
    WHERE ${clauses.join(" AND ")}
    ORDER BY replace(fresh_confirmed_at, 'T', ' ') DESC
    LIMIT ?`).all(...params, RANKING_POOL_MAX) as PoolLead[];
  if (!pool.length) return [];

  const targetIds = [...new Set(pool.map((l) => l.source_scan_target_id).filter((v): v is number => v != null))];
  const newBuilds = newBuildByTarget(targetIds);
  const priorDark = priorDarkByTarget(targetIds);
  const expansions = expansionByTarget(targetIds);
  const density = nearbyFreshCounts(pool);

  // Cluster identity: expansion cluster when known, else a ~500 m proximity cell.
  const clusterIdOf = (lead: PoolLead): string | null => {
    const tid = lead.source_scan_target_id;
    const expansion = tid != null ? expansions.get(tid) : undefined;
    if (expansion) return `exp:${expansion.expansionId}`;
    if (lead.lat == null || lead.lng == null) return null;
    return `geo:${Math.round(lead.lat / PROXIMITY_CELL_DEG)}:${Math.round(lead.lng / PROXIMITY_CELL_DEG)}`;
  };
  const clusterSizes = new Map<string, number>();
  const clusterIds = new Map<number, string | null>();
  for (const lead of pool) {
    const cid = clusterIdOf(lead);
    clusterIds.set(lead.id, cid);
    if (cid) clusterSizes.set(cid, (clusterSizes.get(cid) ?? 0) + 1);
  }

  const scored = pool.map((lead) => {
    const tid = lead.source_scan_target_id;
    const dark = tid != null ? priorDark.get(tid) : undefined;
    const freshEpoch = parseDbTime(lead.fresh_confirmed_at);
    // "Newly lit" requires the dark observation to PRECEDE the confirmed-fresh
    // moment — a later regression is not a flip we watched happen.
    const newlyLit = dark && (dark.firstBadEpoch == null || freshEpoch == null || dark.firstBadEpoch < freshEpoch)
      ? { priorState: (dark.sawComingSoon ? "coming_soon" : "unavailable") as "coming_soon" | "unavailable" }
      : null;
    const expansion = tid != null ? expansions.get(tid) : undefined;
    const { score, reasons } = scoreLead({
      freshConfirmedAt: lead.fresh_confirmed_at,
      createdAt: lead.created_at,
      newBuild: tid != null ? newBuilds.get(tid) ?? null : null,
      newlyLit,
      nearbyFreshCount: density.get(lead.id) ?? 0,
      clusterFreshFound: expansion ? expansion.freshFound : null,
      assignedRepId: lead.assigned_rep_id,
      assignedTerritoryId: lead.assigned_territory_id,
    }, nowMs);
    const clusterId = clusterIds.get(lead.id) ?? null;
    return {
      id: lead.id, address: lead.address, city: lead.city, state: lead.state, zip: lead.zip,
      lat: lead.lat, lng: lead.lng, score, reasons,
      assignedRepId: lead.assigned_rep_id, assignedTerritoryId: lead.assigned_territory_id,
      createdAt: lead.created_at, freshConfirmedAt: lead.fresh_confirmed_at, freshConfidence: lead.fresh_confidence,
      clusterId, clusterSize: clusterId ? clusterSizes.get(clusterId) ?? 1 : 1,
    };
  });

  scored.sort((a, b) => b.score - a.score
    || (parseDbTime(b.freshConfirmedAt) ?? 0) - (parseDbTime(a.freshConfirmedAt) ?? 0)
    || a.id - b.id);
  return scored.slice(0, limit);
}

// ── Route ─────────────────────────────────────────────────────────────────────
type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;
export interface LeadRankingRouteDeps {
  requireAuth?: Middleware;
  // The shared leadVisibilityScope from routes.ts (admin/manager → undefined =
  // whole tenant; team_lead → their team; rep → self). Injected so this module
  // can never drift from the list endpoints' scoping; the local fallback below
  // encodes the identical rule for direct registration.
  visibilityScope?: (user: any) => number | number[] | undefined;
}

// Fail-closed local copy of routes.ts leadVisibilityScope — used only when the
// shared one isn't injected (tests registering this module standalone).
function localVisibilityScope(user: any): number | number[] | undefined {
  const role = user?.role;
  if (role === "admin" || role === "manager" || role === "super_admin") return undefined;
  if (role === "team_lead") {
    const selfTm = user?.teamMemberId ?? null;
    const reports = selfTm != null
      ? storage.getTeamMembers(user?.tenantId ?? undefined).filter((m: any) => m.reportsToId === selfTm).map((m: any) => m.id)
      : [];
    const ids = selfTm != null ? [selfTm, ...reports] : [];
    return ids.length ? [...new Set(ids)] : [-1];
  }
  return [user?.teamMemberId ?? -1];
}

// Same session-header auth as routes.ts (x-session-id → session → active user);
// local fallback because this module registers without touching routes.ts.
function localRequireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers["x-session-id"] as string;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const session = storage.getSession(token);
  if (!session) return res.status(401).json({ error: "Session expired" });
  const user = storage.getUserById(session.userId);
  if (!user || !user.active) return res.status(401).json({ error: "User not found" });
  (req as any).user = user;
  next();
}

export function registerLeadRankingRoutes(app: Express, deps: LeadRankingRouteDeps = {}): void {
  const requireAuth = deps.requireAuth ?? localRequireAuth;
  const visibilityScope = deps.visibilityScope ?? localVisibilityScope;

  // GET /api/leads/ranked?limit=100 — rep-facing: any authenticated field user.
  // Tenant-scoped read; no diagnostics, tokens, or proxy internals in the payload.
  app.get("/api/leads/ranked", requireAuth, (req: any, res: Response) => {
    try {
      const rawLimit = Number(req.query.limit);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), MAX_LIMIT) : DEFAULT_LIMIT;
      const tenantId = req.user?.tenantId ?? getDefaultTenantId() ?? undefined;
      // Same visibility scope as every other list endpoint: a rep ranks only
      // their own book, a team_lead only their team's — never the whole org.
      const scope = visibilityScope(req.user);
      const leads = rankLeads(tenantId ?? undefined, limit, Date.now(), scope);
      res.json({ count: leads.length, limit, generatedAt: new Date().toISOString(), leads });
    } catch (e: any) {
      // Error hygiene: SQL/detail stays in the server log, never on the wire.
      console.error("[leads/ranked] failed:", e instanceof Error ? e.message : e);
      res.status(500).json({ error: "Lead ranking failed" });
    }
  });
}
