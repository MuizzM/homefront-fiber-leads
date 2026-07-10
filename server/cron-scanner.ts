/**
 * Nightly CNS Cron + Coming Soon Auto-Promote
 *
 * Runs two background jobs at server boot:
 *
 * 1. NIGHTLY CNS SCAN (2 AM EST)
 *    - Scans the top 50,000 CNS numbers for the MS ENV (covers NC/SC/IN/MI)
 *    - Any NEW FIBER hit with billingStatus=N → instant email alert + create lead
 *    - Persists last scanned CNS in DB via settings table
 *
 * 2. COMING SOON AUTO-PROMOTE (2 AM EST, after CNS scan)
 *    - Re-checks all addresses in coming_soon_addresses table
 *    - If householdSegmentType changed to NEW FIBER → promote to lead + email
 */

import { mailTransport, mailFrom, adminInbox } from "./mail";
import { storage } from "./storage";
import { getAuthToken, scanAddress } from "./scanner";
import { KINETIC_ENVS, probeKineticDfId, type CnsProbe } from "./cns-scanner";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Address-match guard: only promote if Kinetic's answer is for the SAME address we
// watched (zip match, or normalized street match) — a re-keyed/recycled dfAddressId
// must never turn a watched row into a lead based on ANOTHER premise's status.
function sameWatchedAddress(cs: any, r: { address?: string | null; zip?: string | null }): boolean {
  if (r.zip && cs.zip && String(r.zip) === String(cs.zip)) return true;
  const n = (s: any) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return !!r.address && n(r.address) === n(cs.address);
}
import { classifyAvailabilityTransition, snapshotFromTarget } from "@shared/fiberDetect";
import {
  buildInventoryIndex, qualifyDetection, normalizeAddressKey, summarizeExclusions,
  type ExclusionReason,
} from "@shared/leadQualify";

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

// ── CNS Nightly Scan ──────────────────────────────────────────────────────────
// Cron state (in-memory, not persisted)
export interface CronStatus {
  lastRunAt: string | null;
  lastRunResult: string | null;
  nextRunAt: string | null;
  isRunning: boolean;
  totalNewFiberFound: number;
  totalRunCount: number;
}

const cronStatus: CronStatus = {
  lastRunAt: null,
  lastRunResult: null,
  nextRunAt: null,
  isRunning: false,
  totalNewFiberFound: 0,
  totalRunCount: 0,
};

export function getCronStatus(): CronStatus {
  return { ...cronStatus };
}


/**
 * Run the nightly CNS scan for MS ENV (NC/SC/IN/MI)
 * Scans from (upperLimit - 50000) to upperLimit to catch newest addresses
 */
async function runNightlyCnsScan(): Promise<void> {
  console.log("[cron] Starting nightly CNS scan...");
  cronStatus.isRunning = true;
  cronStatus.lastRunAt = new Date().toISOString();

  const ENV = process.env.NIGHTLY_SCAN_ENV || "MS";
  const envInfo = KINETIC_ENVS.find(e => e.code === ENV);
  const SCAN_COUNT = Number(process.env.NIGHTLY_SCAN_COUNT ?? 50_000);
  // ADVANCING FRONTIER: sweep a window that STRADDLES the observed frontier, not a
  // frozen constant. Re-check a recent overlap (catch flips) then probe NEW
  // territory just above the frontier (where Kinetic numbers its newest builds).
  // The frontier grows itself — harvest-as-you-scan records every hit into the
  // negative cache, so getMaxHitCns advances night over night. Recent misses are
  // skipped so we don't re-buy unassigned numbers.
  const observedMax = storage.getMaxHitCns(ENV) ?? 0;
  const frontier = Math.max(envInfo?.upperLimit ?? 0, observedMax);
  const overlap = Math.min(Math.floor(SCAN_COUNT / 2), 10_000);
  const startCns = Math.max(1, frontier - overlap);
  const endCns = frontier + (SCAN_COUNT - overlap);
  const recentMiss = new Set(storage.getProbedCns(ENV, 30));  // skip recently-probed unassigned numbers

  const newFiberAddresses: string[] = [];
  const probeOutcomes: Array<{ cns: number; result: "hit" | "miss" }> = [];
  const flushProbes = () => { if (probeOutcomes.length) { try { storage.recordCnsProbes(ENV, probeOutcomes.splice(0)); } catch { /* best-effort */ } } };
  let token: string;

  try {
    token = await getAuthToken();
  } catch (err: any) {
    cronStatus.isRunning = false;
    cronStatus.lastRunResult = `Failed to get auth token: ${err.message}`;
    console.warn("[cron] Cannot start — no auth token:", err.message);
    return;
  }
  console.log(`[cron] Nightly sweep ENV=${ENV} window ${startCns}–${endCns} (frontier ${frontier})`);

  let consecutiveErrors = 0;

  for (let cns = startCns; cns <= endCns; cns++) {
    // Skip a control number we conclusively probed in the last 30 days if it was a
    // MISS still below the frontier (re-checking a known hit for flips is fine, so
    // only skip numbers ABOVE the frontier that recently missed = still unassigned).
    if (cns > frontier && recentMiss.has(cns)) continue;

    // Re-fetch token every ~1000 checks
    if (cns % 1000 === 0) {
      try { token = await getAuthToken(); consecutiveErrors = 0; } catch { /* keep existing */ }
    }

    const probe = await probeKineticDfId(`${ENV}${String(cns).padStart(7, "0")}`, token);

    if (probe.kind === "fail") {
      if (probe.reason === "token_expired") { console.warn("[cron] Token expired mid-scan — stopping for tonight"); break; }
      consecutiveErrors++;
      if (consecutiveErrors >= 20) { console.warn("[cron] Too many consecutive errors — aborting scan"); break; }
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    consecutiveErrors = 0;
    probeOutcomes.push({ cns, result: probe.kind === "hit" ? "hit" : "miss" });
    if (probeOutcomes.length >= 500) flushProbes();

    if (probe.kind === "hit") {
      const result = probe.result;
      // HARVEST-AS-YOU-SCAN: persist EVERY discovery into the shared pool (Kinetic
      // gave us the full address + coords + df id for free). Zero Mapbox.
      try {
        storage.upsertScanTargets([{
          address: result.address, city: result.city, state: result.state, zip: result.zip,
          lat: result.lat, lng: result.lng, source: "kinetic-cns", tenantId: null,
          dfAddressId: result.dfAddressId, scannedNow: true,
          fiberStatus: result.isNewFiber ? "new_fiber" : "other",
          isNewFiber: result.isNewFiber, billingStatus: result.billingStatus,
        }]);
      } catch { /* pool write is best-effort */ }

      if (result.isNewFiber && result.billingStatus === "N") {
        // HOT LEAD — no existing subscriber. Deduped by address (upsert), so the
        // fixed-overlap re-check never spawns a duplicate lead per night.
        const fullAddress = `${result.address}, ${result.city}, ${result.state} ${result.zip}`;
        try {
          const up = storage.upsertLeadByAddress({
            address: result.address, city: result.city, state: result.state, zip: result.zip,
            lat: result.lat ?? undefined, lng: result.lng ?? undefined,
            fiberStatus: "new_fiber", isNewFiber: true, isTenured: false,
            billingStatus: result.billingStatus, householdSegmentType: result.householdSegmentType,
            techType: result.techType, speedTier: result.speedTier, maxDownloadMbps: result.maxDownloadMbps,
            competitorName: result.competitorName, addressCatalogDate: result.addressCatalogDate,
            dfAddressId: result.dfAddressId, leadStatus: "prospect",
            deploymentNotes: `Nightly CNS scan: ENV=${ENV} CNS=${cns}. Hot Lead — NEW FIBER, no subscriber.`,
          } as any);
          if (up?.created) {
            newFiberAddresses.push(fullAddress);
            cronStatus.totalNewFiberFound++;
            if (newFiberAddresses.length === 1) {
              sendAlertEmail("🔥 NEW FIBER Lead Found — HomeFront Fiber Nightly Scan", newFiberAlertHtml(1, newFiberAddresses))
                .catch(err => console.warn("[cron] Email alert failed:", err.message));
            }
          }
        } catch { /* dedup/constraint — skip */ }
      }
    }

    await new Promise(r => setTimeout(r, 80)); // ~750/min — respectful
  }
  flushProbes();

  // Summary email if we found multiple
  if (newFiberAddresses.length > 1) {
    sendAlertEmail(
      `🔥 ${newFiberAddresses.length} NEW FIBER Leads — HomeFront Fiber Nightly Scan`,
      newFiberAlertHtml(newFiberAddresses.length, newFiberAddresses)
    ).catch(err => console.warn("[cron] Summary email failed:", err.message));
  }

  cronStatus.isRunning = false;
  cronStatus.lastRunResult = newFiberAddresses.length > 0
    ? `Found ${newFiberAddresses.length} new fiber leads`
    : "No new fiber leads found tonight";
  cronStatus.totalRunCount++;
  console.log(`[cron] Nightly scan complete: ${cronStatus.lastRunResult}`);
}

// ── Coming Soon Auto-Promote ──────────────────────────────────────────────────
// Promote a watchlist address to a lead the moment its fiber goes live, dedup by
// address, mark the watchlist row converted, and alert. Returns true if a NEW lead
// was created (so we only alert on genuine, first-time go-lives).
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

export interface ComingSoonRecheckDeps {
  getToken?: () => Promise<string>;
  probe?: (dfId: string, token: string) => Promise<CnsProbe>;
  scan?: (address: string, city: string, state: string, zip: string) => Promise<any>;
  perNightBudget?: number; // hard cap on proxy probes per night
  paceMs?: number;         // inter-probe pace (default 120)
  blockPaceMs?: number;    // back-off pause on a 403 block (default 800)
}

export async function runComingSoonCheck(deps: ComingSoonRecheckDeps = {}): Promise<void> {
  console.log("[cron] Rechecking Coming Soon watchlist…");
  const getToken = deps.getToken ?? getAuthToken;
  const probe = deps.probe ?? probeKineticDfId;
  const scan = deps.scan ?? scanAddress;
  const BUDGET = Math.max(1, deps.perNightBudget ?? 20_000);
  const PACE = deps.paceMs ?? 120, BLOCK_PACE = deps.blockPaceMs ?? 800;
  const MAX_FAIL = 20; // abort the night after this many CONSECUTIVE non-answers

  // Fast lane: addresses that carry Kinetic's dfAddressId → recheck by EXACT key.
  let watch: any[] = [], legacy: any[] = [];
  try { watch = storage.getComingSoonWithDfId(BUDGET); } catch { /* pre-migration */ }
  try { legacy = storage.getComingSoonAddresses().filter((c: any) => !c.dfAddressId && !c.fiberAvailable).slice(0, Math.max(0, BUDGET - watch.length)); } catch { /* ignore */ }
  if (!watch.length && !legacy.length) { console.log("[cron] Coming Soon watchlist empty"); return; }

  let token: string;
  try { token = await getToken(); }
  catch (err: any) { console.warn("[cron] Cannot recheck Coming Soon — no auth token:", err.message); return; }

  const promoted: string[] = [];
  let consecFail = 0;

  // ── Phase A: exact dfAddressId recheck (the fast, reliable path) ─────────────
  for (const cs of watch) {
    if (consecFail >= MAX_FAIL) { console.warn(`[cron] ${consecFail} consecutive failures — pausing recheck for tonight`); break; }
    let p: CnsProbe;
    try { p = await probe(cs.dfAddressId, token); } catch { consecFail++; await sleep(400); continue; }
    if (p.kind === "fail") {
      // A non-answer NEVER demotes a watched address. Count it, pace, back off on a
      // 403 block, and try a token refresh on 401 — then recheck next night.
      consecFail++;
      if (p.reason === "token_expired") { try { token = await getToken(); } catch { /* keep old */ } }
      await sleep(p.reason === "blocked" ? BLOCK_PACE : PACE);
      continue;
    }
    consecFail = 0;
    try { storage.markComingSoonChecked(cs.id); } catch { /* ignore */ }
    if (p.kind === "hit" && p.result.isNewFiber && p.result.billingStatus === "N" && sameWatchedAddress(cs, p.result)) {
      promoteComingSoon(cs, p.result.billingStatus, p.result.householdSegmentType, promoted);
    }
    await sleep(PACE);
  }

  // ── Phase B: legacy rows without a dfAddressId — recheck by address, and
  // BACKFILL the dfAddressId so next night uses the fast lane. ─────────────────
  for (const cs of legacy) {
    if (consecFail >= MAX_FAIL) break;
    let r: any;
    try { r = await scan(cs.address, cs.city, cs.state, cs.zip); } catch { consecFail++; await sleep(400); continue; }
    if (r.apiSource === "failed") { consecFail++; await sleep(/blocked \(403\)/.test(r.notes ?? "") ? BLOCK_PACE : PACE); continue; }
    consecFail = 0;
    try { storage.markComingSoonChecked(cs.id); } catch { /* ignore */ }
    if (r.dfAddressId) {
      // Backfill Kinetic's key onto this watchlist row.
      try { storage.upsertComingSoonByDfAddressId({ address: cs.address, city: cs.city, state: cs.state, zip: cs.zip, tenantId: cs.tenantId ?? null, reason: cs.reason, lat: cs.lat, lng: cs.lng, dfAddressId: r.dfAddressId, householdSegmentType: r.householdSegmentType } as any); } catch { /* ignore */ }
    }
    if (r.isNewFiber && r.billingStatus === "N" && sameWatchedAddress(cs, r)) promoteComingSoon(cs, r.billingStatus, r.householdSegmentType, promoted);
    await sleep(PACE);
  }

  if (promoted.length > 0) {
    console.log(`[cron] Coming Soon promoted ${promoted.length} addresses to leads`);
    if (promoted.length > 1) {
      sendAlertEmail(
        `🟡 ${promoted.length} Coming Soon Addresses Now LIVE — HomeFront Fiber`,
        comingSoonPromotedHtml(promoted.length, promoted)
      ).catch(() => {});
    }
  } else {
    console.log("[cron] Coming Soon check complete — no changes");
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
function msUntilNext2AM(): number {
  const now = new Date();
  // 2 AM Eastern = 7 AM UTC (EST) or 6 AM UTC (EDT)
  // Use a simple approach: next 2 AM in the server's local time
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

let cronScheduled = false;

// ── Nightly pool re-scan ──────────────────────────────────────────────────────
// Re-scans the persistent address pool for newly-lit fiber. Zero geocoding
// (addresses are already stored), dedups against existing leads, and records the
// result on each target. This is the cheap, repeatable "detect new fiber over
// time" engine — the FiberFocus model.
async function runNightlyPoolRescan(): Promise<void> {
  const targets = storage.getScanTargetsToRescan(100000);
  if (!targets.length) { console.log("[cron] Address pool empty — skipping pool re-scan"); return; }
  console.log(`[cron] Pool re-scan starting: ${targets.length} stored addresses`);

  // Net-new qualification: one O(n) inventory index per batch, O(1) checks,
  // and a NAMED exclusion reason for every detection that doesn't convert.
  const inventory = buildInventoryIndex(storage.getLeads() as any[]);
  const exclusionReasons: ExclusionReason[] = [];
  const newFiberAddrs: string[] = [];
  const BATCH = 25;

  let consecBlockedBatches = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    let blockedInBatch = 0;
    await Promise.all(batch.map(async (t: any) => {
      try {
        const r = await scanAddress(t.address, t.city, t.state, t.zip);
        // 403 = the proxy egress is blocked. Count it so we can stop hammering a
        // blocked proxy (a non-answer, so it changes no state either way).
        if (r.apiSource === "failed" && /blocked \(403\)/.test(r.notes ?? "")) { blockedInBatch++; return; }
        // Transition detection: compare the stored snapshot against this fresh
        // scan to tell a genuine unavailable→live FLIP (newly_live) from a
        // first-ever scan of an already-live address. CRITICAL: the failed-check
        // guard keys on `checkFailed`, which the scanner does NOT set — it signals
        // failure via apiSource="failed". Map it here or a timeout/401/429 would
        // be misclassified as a real transition and overwrite fiber state (a
        // non-answer must never change status).
        const rr = { ...r, checkFailed: r.apiSource === "failed" };
        const outcome = classifyAvailabilityTransition(snapshotFromTarget(t), rr);
        let leadId: number | null = null;
        const qual = outcome.shouldCreateLead ? qualifyDetection(t.address, inventory) : null;
        if (qual) exclusionReasons.push(qual.reason);
        if (qual?.qualified) {
          try {
            const lead = storage.createLead({
              // scan_targets rows are raw SELECT * (snake_case) — inherit the target's org
              tenantId: (t as any).tenant_id ?? (t as any).tenantId ?? undefined,
              address: r.address, city: r.city, state: r.state, zip: r.zip,
              lat: r.lat ?? t.lat ?? undefined, lng: r.lng ?? t.lng ?? undefined,
              fiberStatus: "new_fiber", isNewFiber: true, isTenured: false,
              billingStatus: r.billingStatus, householdSegmentType: r.householdSegmentType,
              techType: r.techType, speedTier: r.speedTier, maxDownloadMbps: r.maxDownloadMbps,
              competitorName: r.competitorName, dfAddressId: r.dfAddressId,
              leadStatus: "prospect",
              deploymentNotes: outcome.isNewlyLive
                ? "Nightly re-scan — NEWLY LIVE fiber (flipped from unavailable). First observed by HomeFront."
                : "Nightly re-scan — live fiber (first observation).",
            });
            leadId = lead.id;
          } catch { /* duplicate — skip */ }
          inventory.set(normalizeAddressKey(t.address), { leadStatus: "prospect", assignedRepId: null });
          newFiberAddrs.push(t.address);
          cronStatus.totalNewFiberFound++;
        }
        // Only persist the snapshot when the check produced a real signal — a
        // failed check must not erase the last known state (recordSnapshot=false).
        if (outcome.recordSnapshot) {
          storage.recordScanTargetResult(t.id, {
            fiberStatus: r.fiberStatus, isNewFiber: r.isNewFiber, billingStatus: r.billingStatus,
            dfAddressId: r.dfAddressId, convertedToLeadId: leadId,
            availabilityStatus: outcome.status, newlyLive: outcome.isNewlyLive,
          });
        }
      } catch { /* token expiry / timeout — skip this address, keep going */ }
    }));
    // If most of a batch is 403-blocked for several batches running, the proxy IP
    // is blocked — stop for tonight rather than burn the whole pool on blocks.
    if (blockedInBatch >= BATCH * 0.6) { if (++consecBlockedBatches >= 3) { console.warn("[cron] Pool re-scan: proxy blocked — stopping for tonight"); break; } }
    else consecBlockedBatches = 0;
    await new Promise(res => setTimeout(res, 60));
  }

  const exclusionSummary = summarizeExclusions(exclusionReasons);
  console.log(`[cron] Pool re-scan done: ${newFiberAddrs.length} new fiber lead(s) from ${targets.length} addresses · qualification: ${JSON.stringify(exclusionSummary)}`);
  // Auditable scan-batch record: why detections did or didn't convert.
  try {
    storage.logActivity(null, "scan.pool_rescan_completed", "scan_batch", undefined,
      { targets: targets.length, created: newFiberAddrs.length, exclusions: exclusionSummary });
  } catch { /* audit best-effort */ }
  if (newFiberAddrs.length > 0) {
    await sendAlertEmail(
      `🔥 ${newFiberAddrs.length} NEW FIBER lead(s) — HomeFront pool re-scan`,
      newFiberAlertHtml(newFiberAddrs.length, newFiberAddrs),
    ).catch(err => console.warn("[cron] Pool re-scan email failed:", err.message));
  }
}

export function startNightlyCron() {
  if (cronScheduled) return;

  // COST GUARD: the nightly scan pushes ~50,000 Kinetic address checks through
  // the Decodo residential proxy EVERY night — that is billed per GB and is the
  // main ongoing proxy cost. It stays OFF unless explicitly enabled so an idle
  // deployment never silently burns proxy bandwidth. Turn on with
  // ENABLE_NIGHTLY_SCAN=true once you actually want automated overnight scans.
  if (process.env.ENABLE_NIGHTLY_SCAN !== "true") {
    cronStatus.nextRunAt = null;
    cronStatus.lastRunResult = "Nightly auto-scan disabled (set ENABLE_NIGHTLY_SCAN=true to enable)";
    console.log("[cron] Nightly auto-scan DISABLED — no proxy bandwidth used until ENABLE_NIGHTLY_SCAN=true");
    return;
  }
  cronScheduled = true;

  // How many CNS records to sweep per night. Default 50k; lower it to cut the
  // per-night proxy bandwidth (NIGHTLY_SCAN_COUNT env).
  const nightlyCount = Number(process.env.NIGHTLY_SCAN_COUNT ?? 50_000);

  function scheduleNext() {
    const ms = msUntilNext2AM();
    const nextRun = new Date(Date.now() + ms);
    cronStatus.nextRunAt = nextRun.toISOString();
    console.log(`[cron] Next nightly scan scheduled at ${nextRun.toLocaleString()} (${nightlyCount.toLocaleString()} records)`);

    setTimeout(async () => {
      try {
        await runNightlyCnsScan();
        await runComingSoonCheck();
        await runNightlyPoolRescan();   // re-scan the stored address pool for new fiber
      } catch (err: any) {
        console.error("[cron] Nightly run failed:", err.message);
      }
      scheduleNext(); // Schedule next night
    }, ms);
  }

  scheduleNext();
}

// ── Manual trigger (for admin testing) ───────────────────────────────────────
export async function triggerManualScan(): Promise<void> {
  if (cronStatus.isRunning) throw new Error("Cron scan already running");
  runNightlyCnsScan().catch(err => console.error("[cron] Manual scan failed:", err.message));
  runComingSoonCheck().catch(() => {});
  runNightlyPoolRescan().catch(err => console.error("[cron] Pool re-scan failed:", err.message));
}
