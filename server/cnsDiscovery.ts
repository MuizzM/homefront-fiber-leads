// ── Zero-Mapbox city discovery ────────────────────────────────────────────────
// Collect primary provider evidence for city X WITHOUT geocoding an address. We
// know where a city lives in Kinetic's control-number space (from every address
// Kinetic handed us for free on past probes — see shared/cnsIndex.ts). This engine
// turns that into a targeted probe plan: check the FRONTIER of the city's CNS bands
// (where Kinetic numbers its newest builds) and unprobed GAPS inside them, straight
// against the authorized Kinetic API. Every hit is persisted into the pool (growing
// the Kinetic-native address book); only cross-verified flips become leads.
//
// Cost discipline: ZERO Mapbox. Bounded by an explicit `budget` of control-number
// probes, and it stops early (a) when the same-city hit-rate collapses (we've
// walked out of the city's locality) or (b) after a run of consecutive provider
// failures (a non-answer never counts as "no address"). Proxy spend = at most
// `budget` Kinetic checks — the same per-GB cost as any scan, capped up front.
import { storage } from "./storage";
import {
  buildCityCoverage, planCityProbe, parseDfAddressId, dfIdFor,
} from "@shared/cnsIndex";
import { probeKineticDfId, type CnsProbe } from "./cns-scanner";
import { persistKineticObservation } from "./kineticObservation";
import { structuredLog } from "./structuredLog";

export interface DiscoveryPlan {
  city: string; state: string; env: string | null;
  hasCoverage: boolean; needsAnchor: boolean;
  knownCount: number; bands: number; frontierCount: number; gapCount: number;
  probeDfIds: string[];
  reason: string;
}

// Build the probe plan for a city from accumulated CNS evidence. Pure read (no
// proxy). `needsAnchor` = the city has no CNS history yet, so it must be seeded
// (nightly sweep, a prior scan, or a bounded micro-anchor) before we can target it.
export function planCityDiscovery(city: string, state: string, budget: number): DiscoveryPlan {
  const cN = city.trim().toLowerCase(), sN = state.trim().toLowerCase();
  const rows = storage.getCnsCoverageRows();
  const coverages = buildCityCoverage(rows);
  const matches = coverages.filter(c => c.city === cN && (!sN || c.state === sN));
  if (!matches.length) {
    return {
      city, state, env: null, hasCoverage: false, needsAnchor: true,
      knownCount: 0, bands: 0, frontierCount: 0, gapCount: 0, probeDfIds: [],
      reason: `No CNS history for "${city}, ${state}" yet. Run the nightly sweep or an ordinary scan there first (both feed the index for free), then discovery can target it.`,
    };
  }
  const primary = matches.sort((a, b) => b.knownCount - a.knownCount)[0];
  // `known` = every control number we should NOT re-probe: pooled hits (any city
  // in this env) PLUS recent misses from the negative cache (so we never re-buy a
  // miss — older misses fall out of the window and get retried, since Kinetic may
  // have assigned them since). This makes discovery walk OUTWARD each run instead
  // of re-proposing the same dead frontier.
  const known = new Set<number>();
  let envMax = primary.maxCns;
  for (const r of rows) {
    const p = parseDfAddressId(r.dfAddressId);
    if (p && p.env === primary.env) { known.add(p.cns); if (p.cns > envMax) envMax = p.cns; }
  }
  for (const cns of storage.getProbedCns(primary.env)) known.add(cns);
  const hitMax = storage.getMaxHitCns(primary.env);
  if (hitMax != null && hitMax > envMax) envMax = hitMax;
  const plan = planCityProbe(primary, known, { budget: Math.max(0, Math.floor(budget)), envMaxCns: envMax });
  return {
    city, state, env: primary.env, hasCoverage: true, needsAnchor: false,
    knownCount: primary.knownCount, bands: primary.bands.length,
    frontierCount: plan.frontier.length, gapCount: plan.gaps.length,
    probeDfIds: plan.probes.map(cns => dfIdFor(primary.env, cns, primary.pad)),
    reason: plan.reason,
  };
}

export interface DiscoveryProgress {
  city: string; state: string; env: string | null;
  planned: number; probed: number; hits: number; sameCityHits: number;
  newFiber: number; failures: number; poolAdded: number; leadsCreated: number;
  stoppedEarly: boolean; done: boolean; reason: string;
}

export interface RunCityDiscoveryOpts {
  city: string; state: string; budget: number; tenantId?: number;
  probe?: (dfId: string, token: string) => Promise<CnsProbe>;   // injectable for tests
  getToken?: () => Promise<string>;
  onProgress?: (p: DiscoveryProgress) => void;
  // Tunables (defaults are conservative).
  window?: number; minSameCityRate?: number; warmup?: number; maxConsecFail?: number;
}

// Execute the probe plan. Sequential + budget-bounded + adaptive. Never throws on
// a provider failure (a non-answer is skipped, not recorded as a miss). Returns the
// final tally; also emits progress if `onProgress` is provided.
export async function runCityDiscovery(opts: RunCityDiscoveryOpts): Promise<DiscoveryProgress> {
  const probe = opts.probe ?? probeKineticDfId;
  const getToken = opts.getToken ?? (async () => (await import("./scanner")).getAuthToken());
  const WARMUP = Math.max(0, opts.warmup ?? 50);
  // Dry-streak stop: stop after this many CONSECUTIVE conclusive probes with no
  // same-city hit (any same-city hit resets it). Robust to interleaved bands — as
  // long as SOME band is still producing this city, it keeps going.
  const MAX_DRY = Math.max(5, opts.window ?? 80);
  const MAX_CONSEC_FAIL = Math.max(1, opts.maxConsecFail ?? 15);
  const budget = Math.min(Math.max(1, Math.floor(opts.budget)), MAX_DISCOVERY_BUDGET);

  const plan = planCityDiscovery(opts.city, opts.state, budget);
  const p: DiscoveryProgress = {
    city: opts.city, state: opts.state, env: plan.env,
    planned: plan.probeDfIds.length, probed: 0, hits: 0, sameCityHits: 0,
    newFiber: 0, failures: 0, poolAdded: 0, leadsCreated: 0,
    stoppedEarly: false, done: false, reason: plan.reason,
  };
  if (plan.needsAnchor || !plan.probeDfIds.length) { p.done = true; opts.onProgress?.(p); return p; }

  const cityN = opts.city.trim().toLowerCase();
  const stateN = opts.state.trim().toLowerCase();
  const env = plan.env!;
  const outcomes: Array<{ cns: number; result: "hit" | "miss" }> = []; // negative-cache batch
  const flush = () => { if (outcomes.length) { try { storage.recordCnsProbes(env, outcomes.splice(0)); } catch { /* best-effort */ } } };

  let dryStreak = 0, consecFail = 0;
  let token: string;
  try { token = await getToken(); } catch { p.done = true; p.reason = "Could not obtain a Kinetic token."; opts.onProgress?.(p); return p; }

  for (const dfId of plan.probeDfIds) {
    if (consecFail >= MAX_CONSEC_FAIL) { p.stoppedEarly = true; p.reason = "Stopped: too many consecutive provider failures (a non-answer is never a negative)."; break; }
    let probe1: CnsProbe;
    try { probe1 = await probe(dfId, token); }
    catch { p.failures++; consecFail++; continue; }
    p.probed++;

    if (probe1.kind === "fail") {
      p.failures++; consecFail++;
      // A 401 is a refreshable token; a 403 means the egress IP is BLOCKED and a
      // refresh won't help — do NOT reset the failure counter, or a blocked proxy
      // would burn the entire budget. Only a real token refresh resets it.
      if (probe1.reason === "token_expired") { try { token = await getToken(); consecFail = 0; } catch { /* keep old */ } }
      // A 403 means the token-bucket is drained — back off (bounded, exponential) so a
      // blocked run doesn't spin through the plan hammering the proxy before it aborts.
      else if (probe1.reason === "blocked") { await new Promise(r => setTimeout(r, Math.min(15_000, 500 * 2 ** Math.min(consecFail, 5)))); }
      continue;
    }
    consecFail = 0;
    const parsed = parseDfAddressId(dfId);
    if (parsed) outcomes.push({ cns: parsed.cns, result: probe1.kind === "hit" ? "hit" : "miss" });
    if (outcomes.length >= 200) flush();

    if (probe1.kind === "miss") { dryStreak++; }
    else {
      const r = probe1.result;
      const isSameCity = r.city.trim().toLowerCase() === cityN && r.state.trim().toLowerCase() === stateN;
      p.hits++;
      if (isSameCity) { p.sameCityHits++; dryStreak = 0; } else dryStreak++;
      if (r.isNewFiber) p.newFiber++;
      // Persist EVERY hit (even other cities — free address-book growth). A CNS
      // NEW FIBER hit remains a raw hit unless the durable evidence projector
      // independently confirms a real unavailable→available transition.
      try {
        const persisted = persistKineticObservation({
          tenantId: opts.tenantId,
          source: "cns-discovery",
          observation: {
            ...r,
            fiberStatus: r.isNewFiber ? "new_fiber" : "other",
          },
        });
        if (persisted.targetCreated) p.poolAdded++;
        p.leadsCreated += persisted.projection.published;
      } catch (error: any) {
        structuredLog("cns_discovery.observation_failed", {
          tenantId: opts.tenantId ?? null,
          dfAddressId: r.dfAddressId,
          error: String(error?.message ?? error),
        }, "warn");
      }
    }

    if (opts.onProgress && p.probed % 25 === 0) opts.onProgress({ ...p });

    // Adaptive early-stop: a long run of conclusive probes with NO same-city hit
    // means we've numbered our way out of this city's locality — stop.
    if (p.probed >= WARMUP && dryStreak >= MAX_DRY) {
      p.stoppedEarly = true;
      p.reason = `Stopped early: ${dryStreak} consecutive probes with no ${opts.city} hit — walked out of its locality (pool still grew by ${p.poolAdded}).`;
      break;
    }
  }

  flush();
  p.done = true;
  if (!p.stoppedEarly) p.reason = `Discovery complete: ${p.probed} probed, ${p.sameCityHits} in ${opts.city}, ${p.newFiber} primary new-fiber match(es), ${p.leadsCreated} independently confirmed lead(s), pool +${p.poolAdded}. Zero Mapbox.`;
  opts.onProgress?.(p);
  return p;
}

// ── Background job registry (in-memory, pollable) ─────────────────────────────
// Discovery is a minutes-long sequential run, so the route launches it in the
// background and the UI polls progress — same pattern as the CNS jobs.
export const MAX_DISCOVERY_BUDGET = 5000; // hard cap on proxy probes per run

export interface DiscoveryJob extends DiscoveryProgress { id: string; budget: number; startedAt: string; tenantId?: number }
const discoveryJobs = new Map<string, DiscoveryJob>();

export function getDiscoveryJob(id: string): DiscoveryJob | undefined { return discoveryJobs.get(id); }
export function getDiscoveryJobs(tenantId?: number): DiscoveryJob[] {
  const all = Array.from(discoveryJobs.values());
  return tenantId == null ? all : all.filter(j => j.tenantId === tenantId);
}

export function startCityDiscovery(opts: {
  city: string; state: string; budget: number; tenantId?: number;
  probe?: (dfId: string, token: string) => Promise<CnsProbe>; getToken?: () => Promise<string>;
}): DiscoveryJob {
  const budget = Math.min(Math.max(1, Math.floor(opts.budget)), MAX_DISCOVERY_BUDGET);
  const id = `disc_${opts.state}_${opts.city.replace(/\W+/g, "").slice(0, 12)}_${Date.now()}`;
  const job: DiscoveryJob = {
    id, budget, startedAt: new Date().toISOString(), tenantId: opts.tenantId,
    city: opts.city, state: opts.state, env: null, planned: 0, probed: 0, hits: 0,
    sameCityHits: 0, newFiber: 0, failures: 0, poolAdded: 0, leadsCreated: 0,
    stoppedEarly: false, done: false, reason: "Planning…",
  };
  discoveryJobs.set(id, job);
  // Evict oldest finished jobs so the in-memory registry can't grow unbounded.
  if (discoveryJobs.size > 60) {
    const old = Array.from(discoveryJobs.values()).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const j of old.slice(0, discoveryJobs.size - 60)) if (j.done) discoveryJobs.delete(j.id);
  }
  runCityDiscovery({
    city: opts.city, state: opts.state, budget, tenantId: opts.tenantId,
    probe: opts.probe, getToken: opts.getToken,
    onProgress: (pr) => { const j = discoveryJobs.get(id); if (j) Object.assign(j, pr); },
  }).catch((err) => { const j = discoveryJobs.get(id); if (j) { j.done = true; j.reason = `Discovery failed: ${err?.message ?? err}`; } });
  return job;
}
