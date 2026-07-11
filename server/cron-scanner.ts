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

import { mailTransport, mailFrom, adminInbox } from "./mail";
import { storage } from "./storage";
import { KINETIC_ENVS } from "./cns-scanner";
import { KineticScheduler, type ProbeTask } from "./kineticScheduler";
import { StreamSource, arrayPuller, cnsRangePuller, dfTasksFromRows, addrTasksFromTargets } from "./scanSources";
import type { ProbeOutcome, ProbeKey } from "./kineticProbe";
import { classifyAvailabilityTransition, snapshotFromTarget } from "@shared/fiberDetect";
import {
  buildInventoryIndex, qualifyDetection, normalizeAddressKey, summarizeExclusions,
  type ExclusionReason,
} from "@shared/leadQualify";

// Address-match guard: only promote if Kinetic's answer is for the SAME address we
// watched (zip match, or normalized street match) — a re-keyed/recycled dfAddressId
// must never turn a watched row into a lead based on ANOTHER premise's status.
function sameWatchedAddress(cs: any, r: { address?: string | null; zip?: string | null }): boolean {
  if (r.zip && cs.zip && String(r.zip) === String(cs.zip)) return true;
  const n = (s: any) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return !!r.address && n(r.address) === n(cs.address);
}

// ── Email (shared transport — see server/mail.ts; Resend/SMTP via env) ──
async function sendAlertEmail(subject: string, html: string) {
  const to = adminInbox();
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS || !to) {
    console.log(`[cron-alert] EMAIL: ${subject}`);
    return;
  }
  await mailTransport().sendMail({ from: mailFrom(), to, subject, html });
}

const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function newFiberAlertHtml(count: number, addresses: string[]): string {
  const rows = addresses.slice(0, 20).map(a => `<li style="margin:4px 0;color:#3EA394;">${esc(a)}</li>`).join("");
  return `
  <div style="font-family:sans-serif;max-width:500px;margin:auto;padding:36px;background:#0F2A44;color:#fff;border-radius:12px;">
    <h2 style="color:#3EA394;margin:0 0 4px;font-size:20px">HomeFront Fiber</h2>
    <p style="color:#CBD4DD;font-size:12px;margin:0 0 20px">Nightly CNS Scan Alert</p>
    <div style="background:#061624;border:1px solid rgba(62,163,148,0.3);border-radius:8px;padding:20px;margin-bottom:16px;">
      <p style="margin:0;font-size:28px;font-weight:700;color:#3EA394">${count} NEW FIBER lead${count === 1 ? "" : "s"} found</p>
      <p style="margin:4px 0 0;color:#CBD4DD;font-size:13px;">Addresses automatically created as Hot Leads</p>
    </div>
    <ul style="padding-left:20px;margin:0;">${rows}</ul>
    ${addresses.length > 20 ? `<p style="color:#CBD4DD;font-size:12px;margin-top:8px;">...and ${addresses.length - 20} more. Log in to view all.</p>` : ""}
  </div>`;
}

function comingSoonPromotedHtml(count: number, addresses: string[]): string {
  const rows = addresses.slice(0, 10).map(a => `<li style="margin:4px 0;color:#f59e0b;">${esc(a)}</li>`).join("");
  return `
  <div style="font-family:sans-serif;max-width:500px;margin:auto;padding:36px;background:#0F2A44;color:#fff;border-radius:12px;">
    <h2 style="color:#3EA394;margin:0 0 4px;font-size:20px">HomeFront Fiber</h2>
    <p style="color:#CBD4DD;font-size:12px;margin:0 0 20px">Coming Soon → Live Alert</p>
    <div style="background:#061624;border:1px solid rgba(245,158,11,0.3);border-radius:8px;padding:20px;margin-bottom:16px;">
      <p style="margin:0;font-size:24px;font-weight:700;color:#f59e0b;">${count} address${count === 1 ? "" : "es"} now have fiber!</p>
      <p style="margin:4px 0 0;color:#CBD4DD;font-size:13px;">Previously "Coming Soon" — now promoted to Hot Lead</p>
    </div>
    <ul style="padding-left:20px;margin:0;">${rows}</ul>
  </div>`;
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
// probe NEW territory just above the frontier. Every hit harvests into the pool; a
// NEW FIBER + billing-N hit becomes a lead. Records hit/miss into the negative cache.
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

  const newFiber: string[] = [];
  const probeOutcomes: Array<{ cns: number; result: "hit" | "miss" }> = [];
  const flush = () => { if (probeOutcomes.length) { try { storage.recordCnsProbes(ENV, probeOutcomes.splice(0)); } catch { /* best-effort */ } } };

  const handler = (task: ProbeTask, o: ProbeOutcome) => {
    const cns = task.ctx?.cns as number;
    if (o.kind === "no_service") { probeOutcomes.push({ cns, result: "miss" }); if (probeOutcomes.length >= 500) flush(); return; }
    if (o.kind !== "answered") return; // inconclusive → don't record; re-probe another sweep
    const r = o.result;
    probeOutcomes.push({ cns, result: "hit" }); if (probeOutcomes.length >= 500) flush();
    try {
      storage.upsertScanTargets([{
        address: r.address, city: r.city, state: r.state, zip: r.zip, lat: r.lat, lng: r.lng,
        source: "kinetic-cns", tenantId: null, dfAddressId: r.dfAddressId, scannedNow: true,
        fiberStatus: r.isNewFiber ? "new_fiber" : "other", isNewFiber: r.isNewFiber, billingStatus: r.billingStatus,
      }]);
    } catch { /* pool best-effort */ }
    if (r.isNewFiber && r.billingStatus === "N") {
      const full = `${r.address}, ${r.city}, ${r.state} ${r.zip}`;
      try {
        const up = storage.upsertLeadByAddress({
          address: r.address, city: r.city, state: r.state, zip: r.zip, lat: r.lat ?? undefined, lng: r.lng ?? undefined,
          fiberStatus: "new_fiber", isNewFiber: true, isTenured: false, billingStatus: r.billingStatus,
          householdSegmentType: r.householdSegmentType, techType: r.techType, speedTier: r.speedTier,
          maxDownloadMbps: r.maxDownloadMbps, competitorName: r.competitorName, addressCatalogDate: r.addressCatalogDate,
          dfAddressId: r.dfAddressId, leadStatus: "prospect", deploymentNotes: `Nightly CNS sweep ENV=${ENV}. Hot Lead — NEW FIBER, no subscriber.`,
        } as any);
        if (up?.created) {
          newFiber.push(full); cronStatus.totalNewFiberFound++;
          if (newFiber.length === 1) sendAlertEmail("🔥 NEW FIBER Lead Found — HomeFront Fiber Nightly Scan", newFiberAlertHtml(1, newFiber)).catch(() => {});
        }
      } catch { /* dedup — skip */ }
    }
  };

  console.log(`[cron] CNS frontier source ENV=${ENV} window ${startCns}–${endCns} (frontier ${frontier})`);
  const source = new StreamSource("cns-frontier", "cns", cnsRangePuller(ENV, startCns, endCns, recentMiss, frontier), handler, 0, () => Math.max(0, endCns - startCns));
  const finalize = () => {
    flush();
    if (newFiber.length > 1) sendAlertEmail(`🔥 ${newFiber.length} NEW FIBER Leads — HomeFront Fiber Nightly Scan`, newFiberAlertHtml(newFiber.length, newFiber)).catch(() => {});
  };
  return { source, finalize };
}

// ── Coming Soon Auto-Promote ──────────────────────────────────────────────────
// Promote a watchlist address to a lead the moment its fiber goes live, dedup by
// address, mark the watchlist row converted, and alert only on a genuine first go-live.
function promoteComingSoon(cs: any, billing: string | null, segment: string | null, promoted: string[]): void {
  const fullAddress = `${cs.address}, ${cs.city}, ${cs.state} ${cs.zip}`;
  try {
    const up = storage.upsertLeadByAddress({
      tenantId: cs.tenantId ?? undefined,
      address: cs.address, city: cs.city, state: cs.state, zip: cs.zip,
      lat: cs.lat ?? undefined, lng: cs.lng ?? undefined,
      fiberStatus: "new_fiber", isNewFiber: true, isTenured: false,
      billingStatus: billing, householdSegmentType: segment,
      dfAddressId: cs.dfAddressId ?? undefined, leadStatus: "prospect",
      deploymentNotes: `Coming Soon → LIVE: fiber went live (watched since ${cs.createdAt}).`,
    } as any);
    try { storage.markComingSoonAvailable(cs.id, up.lead.id); } catch { /* ignore */ }
    if (up.created) {
      promoted.push(fullAddress);
      sendAlertEmail(`🔥 FIBER WENT LIVE: ${cs.address}`, comingSoonPromotedHtml(1, [fullAddress])).catch(() => {});
    }
  } catch { /* dedup/constraint — skip */ }
}

// The watchlist recheck, as a WorkSource. A non-answer NEVER demotes; only a NEW
// FIBER + billing-N hit for the SAME watched address promotes (exactly once).
function buildWatchlistSource(rows: any[], promoted: string[]): StreamSource {
  const handler = (task: ProbeTask, o: ProbeOutcome) => {
    const cs = task.ctx;
    if (o.kind === "inconclusive") return; // non-answer: never demote, recheck next night
    try { storage.markComingSoonChecked(cs.id); } catch { /* ignore */ }
    if (o.kind === "answered" && o.result.isNewFiber && o.result.billingStatus === "N" && sameWatchedAddress(cs, o.result)) {
      promoteComingSoon(cs, o.result.billingStatus, o.result.householdSegmentType, promoted);
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
    if (o.kind === "inconclusive") return;
    try { storage.markComingSoonChecked(cs.id); } catch { /* ignore */ }
    const r = o.kind === "answered" || o.kind === "no_service" ? o.result : null;
    if (r?.dfAddressId) {
      try { storage.upsertComingSoonByDfAddressId({ address: cs.address, city: cs.city, state: cs.state, zip: cs.zip, tenantId: cs.tenantId ?? null, reason: cs.reason, lat: cs.lat, lng: cs.lng, dfAddressId: r.dfAddressId, householdSegmentType: r.householdSegmentType } as any); } catch { /* ignore */ }
    }
    if (o.kind === "answered" && r && r.isNewFiber && r.billingStatus === "N" && sameWatchedAddress(cs, r)) {
      promoteComingSoon(cs, r.billingStatus, r.householdSegmentType, promoted);
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
    console.log(`[cron] Coming Soon promoted ${promoted.length} addresses to leads`);
    if (promoted.length > 1) sendAlertEmail(`🟡 ${promoted.length} Coming Soon Addresses Now LIVE — HomeFront Fiber`, comingSoonPromotedHtml(promoted.length, promoted)).catch(() => {});
  } else {
    console.log("[cron] Coming Soon check complete — no changes");
  }
}

// ── Pool re-scan, as a WorkSource ─────────────────────────────────────────────
// Re-scans the stored address pool for newly-lit fiber; transition detection tells a
// genuine unavailable→live FLIP from a first-ever scan of an already-live address.
function buildPoolRescanSource(): { source: StreamSource; finalize: () => void } {
  const targets = storage.getScanTargetsToRescan(100000);
  const inventory = buildInventoryIndex(storage.getLeads() as any[]);
  const exclusionReasons: ExclusionReason[] = [];
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
    // A real signal (answered or conclusive no_service) → run transition detection.
    const outcome = classifyAvailabilityTransition(snapshotFromTarget(t), { ...r, checkFailed: false } as any);
    let leadId: number | null = null;
    const qual = outcome.shouldCreateLead ? qualifyDetection(t.address, inventory) : null;
    if (qual) exclusionReasons.push(qual.reason);
    if (qual?.qualified) {
      try {
        const lead = storage.createLead({
          tenantId: t.tenant_id ?? t.tenantId ?? undefined,
          address: r.address, city: r.city, state: r.state, zip: r.zip,
          lat: r.lat ?? t.lat ?? undefined, lng: r.lng ?? t.lng ?? undefined,
          fiberStatus: "new_fiber", isNewFiber: true, isTenured: false,
          billingStatus: r.billingStatus, householdSegmentType: r.householdSegmentType,
          techType: r.techType, speedTier: r.speedTier, maxDownloadMbps: r.maxDownloadMbps,
          competitorName: r.competitorName, dfAddressId: r.dfAddressId, leadStatus: "prospect",
          deploymentNotes: outcome.isNewlyLive
            ? "Nightly re-scan — NEWLY LIVE fiber (flipped from unavailable). First observed by HomeFront."
            : "Nightly re-scan — live fiber (first observation).",
        });
        leadId = lead.id;
      } catch { /* duplicate — skip */ }
      inventory.set(normalizeAddressKey(t.address), { leadStatus: "prospect", assignedRepId: null });
      newFiberAddrs.push(t.address); cronStatus.totalNewFiberFound++;
    }
    if (outcome.recordSnapshot) {
      try {
        storage.recordScanTargetResult(t.id, {
          fiberStatus: r.fiberStatus, isNewFiber: r.isNewFiber, billingStatus: r.billingStatus,
          dfAddressId: r.dfAddressId, convertedToLeadId: leadId,
          availabilityStatus: outcome.status, newlyLive: outcome.isNewlyLive,
        });
      } catch { /* best-effort */ }
    }
  };

  const source = new StreamSource("pool-rescan", "rescan", arrayPuller(addrTasksFromTargets(targets)), handler, 3, () => targets.length);
  const finalize = () => {
    const summary = summarizeExclusions(exclusionReasons);
    console.log(`[cron] Pool re-scan done: ${newFiberAddrs.length} new fiber from ${targets.length} · qualification: ${JSON.stringify(summary)}`);
    try { storage.logActivity(null, "scan.pool_rescan_completed", "scan_batch", undefined, { targets: targets.length, created: newFiberAddrs.length, exclusions: summary }); } catch { /* audit best-effort */ }
    if (newFiberAddrs.length > 0) sendAlertEmail(`🔥 ${newFiberAddrs.length} NEW FIBER lead(s) — HomeFront pool re-scan`, newFiberAlertHtml(newFiberAddrs.length, newFiberAddrs)).catch(() => {});
  };
  return { source, finalize };
}

// ── The nightly batch — all three sources on ONE shared window ────────────────
async function runNightlyBatch(): Promise<void> {
  cronStatus.isRunning = true;
  cronStatus.lastRunAt = new Date().toISOString();
  const budgetMin = Number(process.env.NIGHTLY_BUDGET_MIN ?? 240);
  const scheduler = new KineticScheduler({ timeBudgetMs: budgetMin * 60_000 });
  activeScheduler = scheduler;
  const before = cronStatus.totalNewFiberFound;
  try {
    const cns = buildCnsFrontierSource();
    const pool = buildPoolRescanSource();
    const promoted: string[] = [];
    let watchRows: any[] = [];
    try { watchRows = storage.getComingSoonWithDfId(20_000); } catch { /* pre-migration */ }
    const watch = buildWatchlistSource(watchRows, promoted);
    // Fair round-robin: the moat recheck shares the window, never starved behind the sweep.
    const sum = await scheduler.run([watch, cns.source, pool.source]);
    cns.finalize(); pool.finalize();
    if (promoted.length > 1) sendAlertEmail(`🟡 ${promoted.length} Coming Soon Addresses Now LIVE — HomeFront Fiber`, comingSoonPromotedHtml(promoted.length, promoted)).catch(() => {});
    const created = cronStatus.totalNewFiberFound - before;
    cronStatus.lastRunResult = `${created} new fiber this run · ${sum.totalOk} checks · block ${(sum.blockRate * 100).toFixed(1)}% · ${sum.sessionRefreshes} refresh`;
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
