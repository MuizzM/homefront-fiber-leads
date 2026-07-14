/**
 * Nightly scan jobs — now driven by the ONE closed-loop scheduler.
 *
 * The three overnight jobs (CNS frontier sweep, Coming-Soon watchlist recheck, pool
 * re-scan) used to be three self-pacing loops with their own hand-tuned sleeps and
 * consecutive-fail circuit breakers, all hitting the SAME Kinetic token-bucket at
 * different aggressiveness — which is what caused the block storms. They are now
 * three WorkSources submitted to ONE KineticScheduler, so their COMBINED probe rate
 * is governed by a single AIMD congestion window. No pacing constant lives here.
 */

import { storage } from "./storage";
import { rawDb } from "./db";
import { KINETIC_ENVS } from "./cns-scanner";
import { KineticScheduler, type ProbeTask } from "./kineticScheduler";
import { StreamSource, arrayPuller, cnsRangePuller, dfTasksFromRows, addrTasksFromTargets } from "./scanSources";
import type { ProbeOutcome, ProbeKey } from "./kineticProbe";
import { geocodeCity, tileBbox, getCityAddresses } from "./overpass";
import { harvestBboxAddresses, bboxGridSize } from "./mapbox-addresses";
import { pastDueGraceExpired, setBillingState } from "./billingStore";
import { persistKineticObservation } from "./kineticObservation";
import { structuredLog } from "./structuredLog";

// Address-match guard: normalized street identity must match, and a returned ZIP
// must also match. A re-keyed/recycled dfAddressId must never attach another
// premise's status to the watched door.
function sameWatchedAddress(cs: any, r: { address?: string | null; zip?: string | null }): boolean {
  const n = (s: any) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (r.zip && cs.zip && n(r.zip) !== n(cs.zip)) return false;
  return !!r.address && n(r.address) === n(cs.address);
}

// ── Cron state (in-memory, not persisted) ─────────────────────────────────────
export interface CronStatus {
  lastRunAt: string | null;
  lastRunResult: string | null;
  nextRunAt: string | null;
  isRunning: boolean;
  totalNewFiberFound: number;
  totalRunCount: number;
}

const cronStatus: CronStatus = {
  lastRunAt: null, lastRunResult: null, nextRunAt: null,
  isRunning: false, totalNewFiberFound: 0, totalRunCount: 0,
};

export function getCronStatus(): CronStatus { return { ...cronStatus }; }

// The scheduler currently draining the nightly/manual batch (for GET engine-status).
let activeScheduler: KineticScheduler | null = null;
export function getEngineStatus(): any {
  return activeScheduler ? { ...activeScheduler.snapshot(), cronRunning: cronStatus.isRunning } : { running: false, cronRunning: cronStatus.isRunning };
}

// ── CNS frontier sweep, as a WorkSource ───────────────────────────────────────
// Advancing-frontier sweep of df-ids: re-check a recent overlap (catch flips) then
// probe NEW territory just above the frontier. Every hit becomes durable evidence;
// only the independent-evidence projector may publish it. Records hit/miss into the
// negative cache.
function buildCnsFrontierSource(): { source: StreamSource; finalize: () => void } {
  const ENV = process.env.NIGHTLY_SCAN_ENV || "MS";
  const envInfo = KINETIC_ENVS.find(e => e.code === ENV);
  const SCAN_COUNT = Number(process.env.NIGHTLY_SCAN_COUNT ?? 50_000);
  const observedMax = storage.getMaxHitCns(ENV) ?? 0;
  const frontier = Math.max(envInfo?.upperLimit ?? 0, observedMax);
  const overlap = Math.min(Math.floor(SCAN_COUNT / 2), 10_000);
  const startCns = Math.max(1, frontier - overlap);
  const endCns = frontier + (SCAN_COUNT - overlap);
  const recentMiss = new Set(storage.getProbedCns(ENV, 30));

  const confirmedFresh: string[] = [];
  const probeOutcomes: Array<{ cns: number; result: "hit" | "miss" }> = [];
  const flush = () => { if (probeOutcomes.length) { try { storage.recordCnsProbes(ENV, probeOutcomes.splice(0)); } catch { /* best-effort */ } } };

  const handler = (task: ProbeTask, o: ProbeOutcome) => {
    const cns = task.ctx?.cns as number;
    if (o.kind === "no_service") { probeOutcomes.push({ cns, result: "miss" }); if (probeOutcomes.length >= 500) flush(); return; }
    if (o.kind !== "answered") return; // inconclusive → don't record; re-probe another sweep
    const r = o.result;
    probeOutcomes.push({ cns, result: "hit" }); if (probeOutcomes.length >= 500) flush();
    try {
      const persisted = persistKineticObservation({
        source: "nightly-cns-frontier",
        observation: { ...r, fiberStatus: r.isNewFiber ? "new_fiber" : r.fiberStatus },
        latencyMs: o.latencyMs,
      });
      if (persisted.projection.published > 0) {
        confirmedFresh.push(`${r.address}, ${r.city}, ${r.state} ${r.zip}`);
        cronStatus.totalNewFiberFound += persisted.projection.published;
      }
    } catch (error: any) {
      structuredLog("nightly_cns.observation_failed", {
        dfAddressId: r.dfAddressId,
        error: String(error?.message ?? error),
      }, "warn");
    }
  };

  console.log(`[cron] CNS frontier source ENV=${ENV} window ${startCns}–${endCns} (frontier ${frontier})`);
  const source = new StreamSource("cns-frontier", "cns", cnsRangePuller(ENV, startCns, endCns, recentMiss, frontier), handler, 0, () => Math.max(0, endCns - startCns));
  const finalize = () => {
    flush();
    console.log(`[cron] CNS frontier confirmed ${confirmedFresh.length} fresh lead(s); raw provider hits remain provisional`);
  };
  return { source, finalize };
}

// ── Coming Soon Auto-Promote ──────────────────────────────────────────────────
// A watch row is historical provider evidence, not permission to publish. The
// shared projector remains the only lead writer and the watch closes only after
// that projector attaches a cross-verified lead to this exact scan target.
type ConclusiveProbeOutcome = Extract<ProbeOutcome, { kind: "answered" | "no_service" }>;

function sqliteTimeMs(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function trustedWatchBaseline(cs: any, observedAt: string) {
  const reason = String(cs.reason ?? "").trim().toLowerCase();
  if (!["no_service", "copper_only", "coming_soon"].includes(reason)) return undefined;
  // last_checked is mutable and may itself be a later live/inconclusive result.
  // created_at is the only durable timestamp for the watch's original status.
  const baselineMs = sqliteTimeMs(cs.createdAt);
  const observedMs = sqliteTimeMs(observedAt);
  if (baselineMs == null || observedMs == null || baselineMs >= observedMs) return undefined;
  return {
    observedAt: new Date(baselineMs).toISOString(),
    source: `coming-soon-watchlist:${reason}`,
    evidenceId: `coming-soon-${cs.id}`,
  };
}

function persistComingSoonObservation(cs: any, o: ConclusiveProbeOutcome, promoted: string[]): "persisted" | "closed" | null {
  const r = o.result;
  if (o.kind === "answered" && !sameWatchedAddress(cs, r)) {
    structuredLog("coming_soon.address_mismatch", {
      watchId: cs.id,
      watchedAddress: cs.address,
      returnedAddress: r.address,
      dfAddressId: cs.dfAddressId ?? null,
    }, "warn");
    return null;
  }

  const observedAt = new Date().toISOString();
  try {
    const persisted = persistKineticObservation({
      tenantId: cs.tenantId ?? null,
      source: "nightly-coming-soon",
      observation: {
        ...r,
        // A df-id miss carries no premise fields. The scheduled watch is the
        // exact identity that was probed, so persist against that watched door.
        address: cs.address,
        city: cs.city,
        state: cs.state,
        zip: cs.zip,
        lat: r.lat ?? cs.lat ?? null,
        lng: r.lng ?? cs.lng ?? null,
        fiberStatus: o.kind === "no_service" ? "no_service" : r.fiberStatus,
        fiberAvailable: o.kind === "no_service" ? false : (r as any).fiberAvailable,
        discoveredAt: observedAt,
        apiSource: o.kind === "no_service" ? "kinetic_df_no_service" : "kinetic_df_recheck",
        rawResponse: r,
      },
      legacyPriorUnavailableEvidence: trustedWatchBaseline(cs, observedAt),
      latencyMs: o.latencyMs,
    });

    const linked = rawDb.prepare(`SELECT s.converted_to_lead_id AS leadId
      FROM scan_targets s
      JOIN leads l ON l.id=s.converted_to_lead_id AND l.tenant_id=?
     WHERE s.id=? AND l.fresh_confidence='cross_verified'
       AND l.lead_tag='fresh_fiber_confirmed'`).get(persisted.tenantId, persisted.targetId) as { leadId: number } | undefined;
    if (!linked) return "persisted";

    storage.markComingSoonAvailable(cs.id, linked.leadId);
    if (persisted.projection.published > 0) {
      promoted.push(`${cs.address}, ${cs.city}, ${cs.state} ${cs.zip}`);
      cronStatus.totalNewFiberFound += persisted.projection.published;
    }
    return "closed";
  } catch (error: any) {
    structuredLog("coming_soon.observation_failed", {
      watchId: cs.id,
      error: String(error?.message ?? error),
    }, "warn");
    return null;
  }
}

// The watchlist recheck, as a WorkSource. A non-answer NEVER demotes. A matching
// provider hit is evidence only; cross-verification is required before promotion.
function buildWatchlistSource(rows: any[], promoted: string[]): StreamSource {
  const handler = (task: ProbeTask, o: ProbeOutcome) => {
    const cs = task.ctx;
    if (o.kind === "inconclusive" || o.kind === "blocked") return;
    if (persistComingSoonObservation(cs, o, promoted) === "persisted") {
      try { storage.markComingSoonChecked(cs.id); } catch { /* ignore */ }
    }
  };
  const tasks = dfTasksFromRows(rows);
  return new StreamSource("watchlist", "watchlist", arrayPuller(tasks), handler, 3, () => tasks.length);
}

// Legacy watchlist rows without a dfAddressId — recheck by address AND backfill the
// dfAddressId so next night uses the fast exact-key lane.
function buildLegacyWatchlistSource(promoted: string[], budget: number): StreamSource {
  let rows: any[] = [];
  try { rows = storage.getComingSoonAddresses().filter((c: any) => !c.dfAddressId && !c.fiberAvailable).slice(0, Math.max(0, budget)); } catch { /* ignore */ }
  const tasks = rows.map((cs) => ({ key: { kind: "addr", address: cs.address, city: cs.city, state: cs.state, zip: cs.zip } as ProbeKey, ctx: cs }));
  const handler = (task: ProbeTask, o: ProbeOutcome) => {
    const cs = task.ctx;
    if (o.kind === "inconclusive" || o.kind === "blocked") return;
    const r = o.kind === "answered" || o.kind === "no_service" ? o.result : null;
    if (r?.dfAddressId && (o.kind === "no_service" || sameWatchedAddress(cs, r))) {
      try { storage.upsertComingSoonByDfAddressId({ address: cs.address, city: cs.city, state: cs.state, zip: cs.zip, tenantId: cs.tenantId ?? null, reason: cs.reason, lat: cs.lat, lng: cs.lng, dfAddressId: r.dfAddressId, householdSegmentType: r.householdSegmentType } as any); } catch { /* ignore */ }
    }
    if (persistComingSoonObservation(cs, o, promoted) === "persisted") {
      try { storage.markComingSoonChecked(cs.id); } catch { /* ignore */ }
    }
  };
  return new StreamSource("watchlist-legacy", "watchlist", arrayPuller(tasks), handler, 3, () => tasks.length);
}

export interface ComingSoonRecheckDeps {
  probe?: (key: ProbeKey) => Promise<ProbeOutcome>; // injected for tests (zero proxy)
  budget?: number;
  scheduler?: KineticScheduler;
}

// Standalone watchlist recheck (also runs inside the nightly batch). Kept injectable
// so the moat's promote loop stays testable without any network.
export async function runComingSoonCheck(deps: ComingSoonRecheckDeps = {}): Promise<void> {
  console.log("[cron] Rechecking Coming Soon watchlist…");
  const budget = Math.max(1, deps.budget ?? 20_000);
  let watch: any[] = [];
  try { watch = storage.getComingSoonWithDfId(budget); } catch { /* pre-migration */ }
  const promoted: string[] = [];
  const legacy = buildLegacyWatchlistSource(promoted, Math.max(0, budget - watch.length));
  if (!watch.length && legacy.remaining() === 0) { console.log("[cron] Coming Soon watchlist empty"); return; }

  const scheduler = deps.scheduler ?? new KineticScheduler(
    deps.probe ? { probe: deps.probe, refreshSession: async () => false, sleep: async () => {}, maxRounds: 100_000 } : {},
  );
  await scheduler.run([buildWatchlistSource(watch, promoted), legacy]);

  if (promoted.length > 0) {
    console.log(`[cron] Coming Soon cross-verified and promoted ${promoted.length} address(es)`);
  } else {
    console.log("[cron] Coming Soon check complete — no changes");
  }

  // Age-out sweep — retire watchlist addresses that have been rechecked for
  // months and never went live (junk), keeping them as archived history so the
  // active list stays clean. Env-tunable.
  try {
    const aged = storage.ageOutComingSoon(
      Number(process.env.COMING_SOON_MAX_CHECKS ?? 45),
      Number(process.env.COMING_SOON_MAX_AGE_DAYS ?? 120),
    );
    if (aged > 0) console.log(`[cron] Coming Soon aged out ${aged} stale addresses → archived history`);
  } catch { /* pre-migration DB — skip */ }
}

// ── Pool re-scan, as a WorkSource ─────────────────────────────────────────────
// Re-scans the stored address pool for newly-lit fiber; transition detection tells a
// genuine unavailable→live FLIP from a first-ever scan of an already-live address.
function buildPoolRescanSource(): { source: StreamSource; finalize: () => void } {
  const targets = storage.getScanTargetsToRescan(100000);
  const newFiberAddrs: string[] = [];
  if (!targets.length) console.log("[cron] Address pool empty — skipping pool re-scan");

  const handler = (task: ProbeTask, o: ProbeOutcome) => {
    const t = task.ctx;
    if (o.kind === "inconclusive") {
      // No availability signal (typically Kinetic doesn't recognize this address).
      // Count it against the never-scanned row so it eventually parks and the nightly
      // stops re-buying an answerless probe on it forever. No-op once conclusively
      // scanned. A 403/blocked is transient throttle — deliberately NOT counted.
      if (t?.id != null) { try { storage.bumpScanTargetInconclusive({ id: t.id }); } catch { /* best-effort */ } }
      return;
    }
    if (o.kind !== "answered" && o.kind !== "no_service") return; // blocked → transient, never changes fiber state
    const r = o.result;
    try {
      const persisted = persistKineticObservation({
        tenantId: t.tenant_id ?? t.tenantId ?? null,
        source: "nightly-pool-rescan",
        observation: {
          ...r,
          address: r.address || t.address,
          city: r.city || t.city,
          state: r.state || t.state,
          zip: r.zip || t.zip,
          lat: r.lat ?? t.lat ?? null,
          lng: r.lng ?? t.lng ?? null,
          fiberStatus: o.kind === "no_service" ? "no_service" : r.fiberStatus,
          fiberAvailable: o.kind === "no_service" ? false : (r as any).fiberAvailable,
          apiSource: o.kind === "no_service" ? "kinetic_no_service" : "kinetic_live",
          rawResponse: r,
        },
        latencyMs: o.latencyMs,
      });
      if (persisted.projection.published > 0) {
        newFiberAddrs.push(t.address);
        cronStatus.totalNewFiberFound += persisted.projection.published;
      }
    } catch (error: any) {
      structuredLog("nightly_pool.observation_failed", {
        targetId: t.id,
        error: String(error?.message ?? error),
      }, "warn");
    }
  };

  const source = new StreamSource("pool-rescan", "rescan", arrayPuller(addrTasksFromTargets(targets)), handler, 3, () => targets.length);
  const finalize = () => {
    console.log(`[cron] Pool re-scan done: ${newFiberAddrs.length} cross-verified fresh lead(s) from ${targets.length}`);
    try { storage.logActivity(null, "scan.pool_rescan_completed", "scan_batch", undefined, { targets: targets.length, confirmedPublished: newFiberAddrs.length }); } catch { /* audit best-effort */ }
  };
  return { source, finalize };
}

// ── The nightly batch — all three sources on ONE shared window ────────────────
// ── Deep-seed priority cities into the pool (Mapbox grid, once per city) ──────
// New Kinetic fiber lands on brand-new streets OSM doesn't have (proven: Lexington
// had 7,887 addresses OSM missed, ~87% fiber-served). A normal scan captures ~3%.
// So ONCE per configured town, run the deep Mapbox grid to enumerate every address
// into the pool — then the nightly pool re-scan qualifies them through Kinetic for
// free every night. Idempotent (skips an already-seeded city) and capped, so
// Mapbox spend is a one-time, bounded cost per town — never a recurring bill.
async function deepSeedPriorityCities(): Promise<void> {
  const list = (process.env.NIGHTLY_DEEP_SEED_CITIES ?? "").split(";").map((s) => s.trim()).filter(Boolean);
  if (!list.length) return;
  const token = process.env.MAPBOX_TOKEN ?? process.env.MAPBOX_PUBLIC_TOKEN ?? "";
  if (!token) { console.log("[cron] deep-seed skipped — no Mapbox token"); return; }
  const maxMapbox = Number(process.env.NIGHTLY_DEEP_SEED_MAX_MAPBOX ?? 12000); // per-night Mapbox ceiling
  const step = 0.0012; // ~133m
  let spent = 0;

  for (const entry of list) {
    const [cityRaw, stateRaw] = entry.split(",").map((s) => s.trim());
    const city = cityRaw, state = (stateRaw || "NC").toUpperCase();
    if (!city) continue;
    // Idempotent via a PERSISTENT marker — a town is deep-gridded ONCE, ever. (A
    // pool-row-count heuristic is unreliable: rows already pooled under another
    // source wouldn't count, so the town would re-grid nightly = runaway Mapbox.)
    if (storage.wasDeepSeeded(city, state)) { console.log(`[cron] deep-seed ${city}, ${state}: already seeded — skip`); continue; }
    if (spent >= maxMapbox) { console.log(`[cron] deep-seed: nightly Mapbox budget reached — deferring ${city} to a later night`); break; }
    try {
      const geo = await geocodeCity(city, state);
      if (!geo) { console.warn(`[cron] deep-seed ${city}: geocode failed — will retry next night`); continue; } // not marked → retry
      const tiles = tileBbox({ south: geo.bbox.south, north: geo.bbox.north, west: geo.bbox.west, east: geo.bbox.east }, 0.04);
      const seen = new Set<string>();
      const addrs: any[] = [];
      let completed = true;
      for (const t of tiles) {
        if (spent >= maxMapbox) { completed = false; break; } // budget cut mid-city → resume next night
        try {
          const a = await harvestBboxAddresses(t as any, state, token, undefined, step);
          spent += bboxGridSize(t as any, step);
          for (const x of a) { const k = x.address.toLowerCase(); if (!seen.has(k)) { seen.add(k); addrs.push(x); } }
        } catch (e: any) { console.warn(`[cron] deep-seed ${city} tile: ${e.message}`); }
      }
      if (addrs.length) {
        storage.upsertScanTargets(addrs.map((a) => ({ address: a.address, city, state, zip: a.zip ?? "", lat: a.lat ?? null, lng: a.lng ?? null, source: "mapbox-deep-seed" })));
      }
      // Mark done ONLY if the whole city's grid finished — a budget-cut city stays
      // unmarked so it resumes (and completes) on a later night, never re-billing
      // a town we already finished.
      if (completed) {
        storage.markDeepSeeded(city, state, addrs.length);
        console.log(`[cron] deep-seed ${city}, ${state}: +${addrs.length} addresses to pool (Mapbox ~${spent}) — marked seeded`);
      } else {
        console.log(`[cron] deep-seed ${city}, ${state}: +${addrs.length} so far (budget cut) — resumes next night`);
      }
    } catch (e: any) { console.warn(`[cron] deep-seed ${city} failed: ${e.message}`); } // not marked → retry
  }
  console.log(`[cron] deep-seed complete — ~${spent} Mapbox calls this run`);
}

// FREE OSM sweep: enumerate every configured town's addresses via Overpass ($0 —
// getCityAddresses is pool-first + OSM, with only one cheap Mapbox bbox lookup per
// town) and upsert them into the scan-target pool. The nightly pool re-scan below
// then qualifies them through Kinetic via Decodo, so fiber/coming-soon leads land
// for the user's whole SC + NC town list without the paid Mapbox address grid.
// Idempotent (upsertScanTargets dedupes on normalized address); safe to re-run.
async function osmSweepCities(): Promise<void> {
  const list = (process.env.NIGHTLY_OSM_SWEEP_CITIES ?? "").split(";").map((s) => s.trim()).filter(Boolean);
  if (!list.length) return;
  // Time-boxed so a big town's Overpass tiling can't devour the night and starve the
  // paced qualification below. Whatever isn't swept resumes next night (idempotent
  // upsert). Rotate the start each night so towns near the end aren't perpetually
  // skipped: offset by the day-of-year so coverage is fair over a week.
  const budgetMs = Number(process.env.NIGHTLY_OSM_SWEEP_MAX_MS ?? 25 * 60_000);
  const started = Date.now();
  const offset = Math.floor(started / 86_400_000) % list.length;
  const rotated = list.slice(offset).concat(list.slice(0, offset));
  let total = 0, towns = 0;
  for (const entry of rotated) {
    if (Date.now() - started > budgetMs) { console.log(`[cron] osm-sweep time budget reached — remaining towns resume next night`); break; }
    const [cityRaw, stateRaw] = entry.split(",").map((s) => s.trim());
    const city = cityRaw, state = (stateRaw || "NC").toUpperCase();
    if (!city) continue;
    try {
      const { addresses } = await getCityAddresses(city, state);
      if (addresses.length) {
        storage.upsertScanTargets(addresses.map((a) => ({
          address: a.address, city, state, zip: a.zip ?? "", lat: a.lat ?? null, lng: a.lng ?? null, source: "osm-sweep",
        })));
        total += addresses.length; towns++;
      }
      console.log(`[cron] osm-sweep ${city}, ${state}: +${addresses.length} OSM addresses to pool (free)`);
    } catch (e: any) { console.warn(`[cron] osm-sweep ${city}, ${state} failed: ${e.message}`); } // skip → retry next night
  }
  console.log(`[cron] osm-sweep complete — ${total} OSM addresses across ${towns} towns pooled (free), qualified by the pool re-scan`);
}

// Dunning: a past_due tenant whose grace window has elapsed is suspended (paywall).
// Stripe drives past_due via invoice.payment_failed; this is the timeout that
// escalates it. Idempotent — already-suspended tenants aren't re-touched.
function runBillingDunning(): void {
  const expired = pastDueGraceExpired(new Date().toISOString());
  for (const tid of expired) {
    const r = setBillingState(tid, "suspended", "cron:dunning");
    if (r.ok) console.log(`[cron] dunning: tenant ${tid} past_due grace expired → suspended`);
  }
}

async function runNightlyBatch(): Promise<void> {
  cronStatus.isRunning = true;
  cronStatus.lastRunAt = new Date().toISOString();
  const budgetMin = Number(process.env.NIGHTLY_BUDGET_MIN ?? 240);
  const scheduler = new KineticScheduler({ timeBudgetMs: budgetMin * 60_000 });
  activeScheduler = scheduler;
  const before = cronStatus.totalNewFiberFound;
  try {
    // Billing dunning: suspend tenants whose past_due grace window has expired.
    // No-op when no tenant is on billing (dark) — safe for the live single-tenant org.
    try { runBillingDunning(); } catch (e: any) { console.warn("[cron] dunning error:", e.message); }
    // Seed the priority towns' new builds into the pool FIRST (Mapbox grid, once
    // per town) so the pool re-scan below qualifies them this same run.
    try { await deepSeedPriorityCities(); } catch (e: any) { console.warn("[cron] deep-seed error:", e.message); }
    // FREE OSM sweep of the full SC + NC town list into the pool (Overpass, $0),
    // so the pool re-scan below qualifies them through Kinetic/Decodo this same run.
    try { await osmSweepCities(); } catch (e: any) { console.warn("[cron] osm-sweep error:", e.message); }
    const cns = buildCnsFrontierSource();
    const pool = buildPoolRescanSource();
    const promoted: string[] = [];
    let watchRows: any[] = [];
    try { watchRows = storage.getComingSoonWithDfId(20_000); } catch { /* pre-migration */ }
    const watch = buildWatchlistSource(watchRows, promoted);
    // Fair round-robin: the moat recheck shares the window, never starved behind the sweep.
    const sum = await scheduler.run([watch, cns.source, pool.source]);
    cns.finalize(); pool.finalize();
    const created = cronStatus.totalNewFiberFound - before;
    cronStatus.lastRunResult = `${created} confirmed fresh leads this run · ${sum.totalOk} checks · block ${(sum.blockRate * 100).toFixed(1)}% · ${sum.sessionRefreshes} refresh`;
    cronStatus.totalRunCount++;
    console.log(`[cron] Nightly batch complete: ${cronStatus.lastRunResult}`);
  } catch (err: any) {
    cronStatus.lastRunResult = `Nightly run failed: ${err.message}`;
    console.error("[cron] Nightly run failed:", err.message);
  } finally {
    cronStatus.isRunning = false;
    activeScheduler = null;
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
function msUntilNext2AM(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

let cronScheduled = false;

export function startNightlyCron() {
  if (cronScheduled) return;
  // COST GUARD: the nightly scan pushes tens of thousands of Kinetic checks through
  // the Decodo residential proxy — billed per GB. It stays OFF unless explicitly
  // enabled so an idle deployment never silently burns proxy bandwidth.
  if (process.env.ENABLE_NIGHTLY_SCAN !== "true") {
    cronStatus.nextRunAt = null;
    cronStatus.lastRunResult = "Nightly auto-scan disabled (set ENABLE_NIGHTLY_SCAN=true to enable)";
    console.log("[cron] Nightly auto-scan DISABLED — no proxy bandwidth used until ENABLE_NIGHTLY_SCAN=true");
    return;
  }
  cronScheduled = true;

  function scheduleNext() {
    const ms = msUntilNext2AM();
    const nextRun = new Date(Date.now() + ms);
    cronStatus.nextRunAt = nextRun.toISOString();
    console.log(`[cron] Next nightly scan scheduled at ${nextRun.toLocaleString()}`);
    setTimeout(async () => {
      try { await runNightlyBatch(); } catch (err: any) { console.error("[cron] Nightly run failed:", err.message); }
      scheduleNext();
    }, ms);
  }
  scheduleNext();
}

// ── Manual trigger (for admin testing) ───────────────────────────────────────
export async function triggerManualScan(): Promise<void> {
  if (cronStatus.isRunning) throw new Error("Cron scan already running");
  runNightlyBatch().catch(err => console.error("[cron] Manual scan failed:", err.message));
}
