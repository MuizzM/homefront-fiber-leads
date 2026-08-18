// ── Scan Intelligence service ─────────────────────────────────────────────────
// Orchestrates the market-intelligence surface and the budgeted-scan lifecycle.
// Pure-logic modules (marketIntel/opportunity/scanPriority/scanEconomics) do the
// thinking; scanIntelStore does the DB; this glues them and owns the ONE place a
// run is created + dispatched. No proxy calls here — the engine spends money,
// and only after a run row exists.
import { scoreMarket, type MarketCard } from "@shared/marketIntel";
import { clusterOpportunities, type OppCluster } from "@shared/opportunity";
import { rankTargets } from "@shared/scanPriority";
import { estimateScanCost, bytesToUsd, MAX_CHECKS_PER_RUN, budgetTiers, type CostRate } from "@shared/scanEconomics";
import {
  getMarketAggregates, getKnownNewFiberPoints, getPoolTargetsForCity, getOpportunityPoints,
  createScanRun, enqueueRunTargets, setScanRunBudget, getRun, listRuns, setRunStatus, countQueued,
  computeTerritoryOutcome, accumulateMarketOutcome, type ScanRunRow,
} from "./scanIntelStore";
import { runScanWorker, isRunActive } from "./scanEngine";
import { readPressure } from "./resourcePressure";
import { structuredLog } from "./structuredLog";

// Cost rate from env, computed once per call (cheap). Operators configure their
// real Decodo plan via SCAN_USD_PER_GB; the byte estimate rarely needs tuning.
function costRate(): CostRate {
  const usd = Number(process.env.SCAN_USD_PER_GB);
  const bytes = Number(process.env.SCAN_BYTES_PER_CHECK);
  return {
    usdPerGb: Number.isFinite(usd) && usd > 0 ? usd : undefined,
    bytesPerCheck: Number.isFinite(bytes) && bytes > 0 ? bytes : undefined,
  };
}

// ── Markets view ──────────────────────────────────────────────────────────────
export function getMarkets(tenantId: number): { markets: MarketCard[]; rate: CostRate & { usdPerGb: number; bytesPerCheck: number } } {
  const now = Date.now();
  const cards = getMarketAggregates(tenantId)
    // Drop noise: a "market" needs a real pool to scan (>=25 addresses) OR real
    // doors on the board. 1-5-address rows are mis-parsed harvest, not markets.
    .filter(m => m.poolSize >= 25 || m.leads > 0)
    .map(m => scoreMarket(m, now))
    .sort((a, b) => b.priority - a.priority);
  const est = estimateScanCost(1, costRate());
  return { markets: cards, rate: { ...costRate(), usdPerGb: est.usdPerGb, bytesPerCheck: est.bytesPerCheck } };
}

// One market's detail + suggested budget tiers scoped to what's left to verify.
export function getMarketDetail(tenantId: number, city: string, state: string) {
  const now = Date.now();
  const agg = getMarketAggregates(tenantId).find(m => eqCity(m.city, city) && eqCity(m.state, state));
  if (!agg) return null;
  const card = scoreMarket(agg, now);
  const remaining = Math.max(0, agg.poolSize - agg.verified);
  const tiers = budgetTiers(remaining).map(t => ({ ...t, cost: estimateScanCost(t.checks, costRate()) }));
  return { card, remaining, tiers, rate: costRate() };
}

// ── Opportunity clusters ─────────────────────────────────────────────────────
export function getClusters(tenantId: number, bbox?: { minLat: number; maxLat: number; minLng: number; maxLng: number }, opts?: { minPoints?: number; cellDeg?: number; city?: string; state?: string }): { clusters: OppCluster[]; points: number } {
  const raw = getOpportunityPoints(tenantId, bbox, opts?.city, opts?.state);
  const pts = raw.map(r => ({
    id: r.id, lat: r.lat, lng: r.lng,
    isNewFiber: !!r.isNewFiber, newlyLive: !!r.newlyLive,
    worked: !!r.worked, sold: !!r.sold, leadScore: r.leadScore ?? 0,
    competitor: r.competitor, verifiedAtMs: r.verifiedAtMs ?? null,
  }));
  const clusters = clusterOpportunities(pts, { nowMs: Date.now(), minPoints: opts?.minPoints ?? 5, cellDeg: opts?.cellDeg });
  return { clusters, points: pts.length };
}

// ── Run lifecycle ─────────────────────────────────────────────────────────────
export interface StartRunResult {
  runId: string;
  queued: number;
  budget: number;
  estimate: ReturnType<typeof estimateScanCost>;
  city: string; state: string;
}

// Create + dispatch a budgeted market scan. Ranks the city's pool by expected
// value, enqueues the top `budget`, persists the run, and kicks the worker.
// Returns immediately — the run drives itself and is resumable.
export function startMarketRun(opts: { tenantId: number; city: string; state: string; budget: number; createdBy?: number | null; rescan?: boolean; runKind?: string; label?: string }): StartRunResult {
  const { tenantId, city, state, createdBy } = opts;
  const budget = clampBudget(opts.budget);

  const targets = getPoolTargetsForCity(city, state);
  if (targets.length === 0) throw new Error("NO_POOL: no harvested addresses for this market yet");

  const known = getKnownNewFiberPoints(tenantId, city, state);
  const ranked = rankTargets(targets, known, { nowMs: Date.now(), rescan: opts.rescan });
  const selected = ranked.slice(0, Math.min(budget, ranked.length)).filter(r => r.ev > 0);
  if (selected.length === 0) throw new Error("NOTHING_TO_VERIFY: every address here was recently checked");

  const runId = `run_${tenantId}_${Date.now().toString(36)}`;
  createScanRun({
    id: runId, tenantId, kind: opts.runKind ?? (opts.rescan ? "rescan" : "market"),
    label: opts.label ?? `${opts.rescan ? "Rescan" : "Scan"} ${city}, ${state}`,
    city, state, budget: selected.length, createdBy,
  });
  const queued = enqueueRunTargets(runId, selected.map(s => ({ id: s.id, seq: s.seq })));
  setScanRunBudget(runId, queued);

  // Fire-and-forget worker. Never awaited — the HTTP response returns now and
  // the operator watches progress via the run endpoint.
  void runScanWorker(runId, tenantId);

  return { runId, queued, budget: queued, estimate: estimateScanCost(queued, costRate()), city, state };
}

export function startTargetRun(opts: { tenantId: number; city: string; state: string; targetIds: number[]; createdBy?: number | null; runKind?: string; label?: string }): StartRunResult {
  // EMERGENCY resource pressure (disk nearly full / WAL runaway — see
  // resourcePressure.ts): stop QUEUE GROWTH too, not just admissions. Every
  // producer funnels enqueues through here, so this one refusal bounds the
  // backlog while the sentinel recovers the disk. Fails open on a stale row.
  if (readPressure().level === "emergency") {
    structuredLog("scan.enqueue_refused", { reason: "resource_pressure_emergency", city: opts.city, state: opts.state, targets: opts.targetIds.length }, "warn");
    throw new Error("RESOURCE_EMERGENCY: scanning paused while disk/WAL pressure recovers");
  }
  const ids = [...new Set(opts.targetIds.map(Number).filter(Number.isInteger))].slice(0, MAX_CHECKS_PER_RUN);
  if (!ids.length) throw new Error("NO_TARGETS: sweep batch is empty");
  const runId = `run_${opts.tenantId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  createScanRun({
    id: runId, tenantId: opts.tenantId, kind: opts.runKind ?? "sweep",
    label: opts.label ?? `Sweep ${opts.city}, ${opts.state}`, city: opts.city, state: opts.state,
    budget: ids.length, createdBy: opts.createdBy,
  });
  const queued = enqueueRunTargets(runId, ids.map((id, seq) => ({ id, seq })));
  setScanRunBudget(runId, queued);
  void runScanWorker(runId, opts.tenantId);
  return { runId, queued, budget: queued, estimate: estimateScanCost(queued, costRate()), city: opts.city, state: opts.state };
}

// Preview a run's cost WITHOUT spending anything — how many high-EV targets
// exist and what verifying `budget` of them would cost. Estimate-first, always.
export function previewMarketRun(opts: { tenantId: number; city: string; state: string; budget: number; rescan?: boolean }) {
  const budget = clampBudget(opts.budget);
  const targets = getPoolTargetsForCity(opts.city, opts.state);
  const known = getKnownNewFiberPoints(opts.tenantId, opts.city, opts.state);
  const ranked = rankTargets(targets, known, { nowMs: Date.now(), rescan: opts.rescan });
  const available = ranked.filter(r => r.ev > 0).length;   // addresses we can verify
  // "High-value" = the meaningfully-above-baseline targets (near known fiber /
  // on the build frontier / field signal), not merely "novel". An isolated
  // never-scanned target scores exactly 0.55 (base 0.45 + full spread 0.10), so
  // the bar sits above that — the honest count of the strong bets.
  const highValue = ranked.filter(r => r.ev >= 0.6).length;
  const willVerify = Math.min(budget, available);
  return {
    poolAvailable: targets.length,
    available,
    highValue,
    willVerify,
    estimate: estimateScanCost(willVerify, costRate()),
    maxPerRun: MAX_CHECKS_PER_RUN,
  };
}

// Run status for polling — includes live cost (from measured bytes) + progress.
export function getRunStatus(runId: string, tenantId: number) {
  const run = getRun(runId, tenantId);
  if (!run) return null;
  return {
    ...run,
    queued: countQueued(runId),
    pct: run.budget > 0 ? Math.round(((run.verified + run.failed) / run.budget) * 100) : 0,
    costUsd: bytesToUsd(run.estBytes, costRate()),
    active: isRunActive(runId),
  };
}

export function getRuns(
  tenantId: number,
  scope: { city?: string | null; state?: string | null; limit?: number } = {},
): Array<ReturnType<typeof decorateRun>> {
  return listRuns(tenantId, scope.limit ?? 20, scope).map(decorateRun);
}
function decorateRun(run: ScanRunRow) {
  return { ...run, costUsd: bytesToUsd(run.estBytes, costRate()), active: isRunActive(run.id), pct: run.budget > 0 ? Math.round(((run.verified + run.failed) / run.budget) * 100) : 0 };
}

// Pause / resume / cancel — operator control over a spending job.
export function controlRun(runId: string, tenantId: number, action: "pause" | "resume" | "cancel"): boolean {
  const run = getRun(runId, tenantId);
  if (!run) return false;
  if (action === "cancel") { setRunStatus(runId, "cancelled"); return true; }
  if (action === "pause") { if (run.status === "running") setRunStatus(runId, "paused"); return true; }
  if (action === "resume") {
    if (run.status === "paused") {
      setRunStatus(runId, "running");
      void runScanWorker(runId, tenantId); // re-dispatch from the queue
    }
    return true;
  }
  return false;
}

// ── Learning loop ─────────────────────────────────────────────────────────────
// Roll a finished territory's field outcome up into its market's memory. Called
// on complete / archive / delete so EVERY worked area teaches the next scan —
// the old hard-delete erased the lesson. Returns the outcome snapshot to store
// on the territory (so the retrospective survives on the row too). Best-effort:
// a territory with no leads (or no city) simply has nothing to teach.
export function recordTerritoryOutcome(tenantId: number, territoryId: number, createdAt: string | null): ReturnType<typeof computeTerritoryOutcome> {
  const outcome = computeTerritoryOutcome(territoryId, createdAt);
  if (!outcome) return null;
  accumulateMarketOutcome(tenantId, outcome.city, outcome.state, {
    doors: outcome.doors, knocks: outcome.knocks, contacts: outcome.contacts, sales: outcome.sales,
  });
  return outcome;
}

// Unassign a deleted territory's leads from it (keep their rep) — fixes the
// orphan bug where deleting a territory left leads pointing at a ghost.
export { clearTerritoryFromLeads as detachTerritoryLeads } from "./scanIntelStore";

// The full delete-time release: drops the area link AND, for the doors the area
// itself granted, the rep with it. See @shared/territory (areaGrantedRepIds,
// areaDeleteClearsRep) for which doors those are and why.
export { releaseTerritoryLeads, type TerritoryReleaseResult } from "./scanIntelStore";

function clampBudget(n: number): number {
  const b = Math.floor(Number(n));
  if (!Number.isFinite(b) || b <= 0) return 0;
  return Math.min(b, MAX_CHECKS_PER_RUN);
}
function eqCity(a: string, b: string): boolean { return (a || "").toLowerCase() === (b || "").toLowerCase(); }
