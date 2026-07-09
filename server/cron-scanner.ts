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
import { proxyFetch } from "./proxy-fetch";
import { KFS_SCAN_URL, KFS_REFERER, KFS_ORIGIN } from "./kfs-config";
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

async function lookupCnsDirect(env: string, cns: number, token: string): Promise<{
  found: boolean;
  isNewFiber: boolean;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  lat?: number | null;
  lng?: number | null;
  billingStatus?: string | null;
  householdSegmentType?: string | null;
  techType?: string | null;
  speedTier?: string | null;
  maxDownloadMbps?: number | null;
  competitorName?: string | null;
  addressCatalogDate?: string | null;
  dfAddressId?: string;
}> {
  const dfAddressId = `${env}${String(cns).padStart(7, "0")}`;

  try {
    const res = await proxyFetch(KFS_SCAN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "device-id": "698ca1e5-f077-4a62-a1e7-e97f484c7231",
        "Referer": KFS_REFERER,
        "Origin": KFS_ORIGIN,
      },
      body: JSON.stringify({ dfAddressId }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error("TOKEN_EXPIRED");
      return { found: false, isNewFiber: false };
    }

    const data = await res.json();
    if (!data.success || data.validationResult === "AddressNotFound" || !data.address) {
      return { found: false, isNewFiber: false };
    }

    const addr = data.address;
    const segment = addr.householdSegmentType ?? "";
    const isNewFiber = segment === "NEW FIBER";
    const kbps = data.broadbandService?.finalQualSpeed;
    const mbps = kbps ? Math.round(parseInt(kbps) / 1000) : null;
    let speedTier: string | null = null;
    if (mbps) {
      if (mbps >= 2000) speedTier = "2gig";
      else if (mbps >= 1000) speedTier = "1gig";
      else if (mbps >= 500) speedTier = "500mbps";
      else if (mbps >= 300) speedTier = "300mbps";
      else if (mbps >= 100) speedTier = "100mbps";
      else speedTier = "sub100mbps";
    }

    return {
      found: true,
      isNewFiber,
      address: addr.addressLine1,
      city: addr.city ?? "",
      state: addr.stateProvinceCd ?? "",
      zip: addr.postalCd ?? "",
      lat: addr.geoLat ? parseFloat(addr.geoLat) : null,
      lng: addr.geoLong ? parseFloat(addr.geoLong) : null,
      billingStatus: addr.billingStatus ?? null,
      householdSegmentType: segment || null,
      techType: data.techType ?? addr.maxQualTechnologyType ?? null,
      speedTier,
      maxDownloadMbps: mbps,
      competitorName: addr.competitorCompanyName ?? null,
      addressCatalogDate: addr.addressCatalogDt ?? null,
      dfAddressId,
    };
  } catch (err: any) {
    if (err.message === "TOKEN_EXPIRED") throw err;
    return { found: false, isNewFiber: false };
  }
}

/**
 * Run the nightly CNS scan for MS ENV (NC/SC/IN/MI)
 * Scans from (upperLimit - 50000) to upperLimit to catch newest addresses
 */
async function runNightlyCnsScan(): Promise<void> {
  console.log("[cron] Starting nightly CNS scan...");
  cronStatus.isRunning = true;
  cronStatus.lastRunAt = new Date().toISOString();

  const ENV = "MS";
  const UPPER_LIMIT = 3_062_552;
  const SCAN_COUNT = Number(process.env.NIGHTLY_SCAN_COUNT ?? 50_000);
  const startCns = UPPER_LIMIT - SCAN_COUNT;

  const newFiberAddresses: string[] = [];
  let token: string;

  try {
    token = await getAuthToken();
  } catch (err: any) {
    cronStatus.isRunning = false;
    cronStatus.lastRunResult = `Failed to get auth token: ${err.message}`;
    console.warn("[cron] Cannot start — no auth token:", err.message);
    return;
  }

  let consecutiveErrors = 0;

  for (let cns = startCns; cns <= UPPER_LIMIT; cns++) {
    // Re-fetch token every 25 min
    if (cns % 1000 === 0) {
      try { token = await getAuthToken(); consecutiveErrors = 0; } catch { /* keep existing */ }
    }

    try {
      const result = await lookupCnsDirect(ENV, cns, token);

      if (result.found && result.isNewFiber && result.billingStatus === "N") {
        // HOT LEAD — billingStatus N = no existing subscriber
        const fullAddress = `${result.address}, ${result.city}, ${result.state} ${result.zip}`;
        newFiberAddresses.push(fullAddress);
        cronStatus.totalNewFiberFound++;

        // Save as lead immediately
        try {
          storage.createLead({
            address: result.address!,
            city: result.city!,
            state: result.state!,
            zip: result.zip!,
            lat: result.lat ?? undefined,
            lng: result.lng ?? undefined,
            fiberStatus: "new_fiber",
            isNewFiber: true,
            isTenured: false,
            billingStatus: result.billingStatus,
            householdSegmentType: result.householdSegmentType,
            techType: result.techType,
            speedTier: result.speedTier,
            maxDownloadMbps: result.maxDownloadMbps,
            competitorName: result.competitorName,
            addressCatalogDate: result.addressCatalogDate,
            dfAddressId: result.dfAddressId,
            leadStatus: "prospect",
            deploymentNotes: `Nightly CNS scan: ENV=MS CNS=${cns}. Hot Lead — NEW FIBER, no subscriber.`,
          });
        } catch { /* duplicate — skip */ }

        // Send immediate email alert for first hit
        if (newFiberAddresses.length === 1) {
          sendAlertEmail(
            "🔥 NEW FIBER Lead Found — HomeFront Fiber Nightly Scan",
            newFiberAlertHtml(1, newFiberAddresses)
          ).catch(err => console.warn("[cron] Email alert failed:", err.message));
        }
      }

      consecutiveErrors = 0;
      // Rate limit: 80ms between requests (750/min — respectful)
      await new Promise(r => setTimeout(r, 80));

    } catch (err: any) {
      if (err.message === "TOKEN_EXPIRED") {
        console.warn("[cron] Token expired mid-scan — stopping for tonight");
        break;
      }
      consecutiveErrors++;
      if (consecutiveErrors >= 20) {
        console.warn("[cron] Too many consecutive errors — aborting scan");
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

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
async function runComingSoonCheck(): Promise<void> {
  console.log("[cron] Checking Coming Soon addresses...");

  let addresses: any[];
  try {
    addresses = storage.getComingSoonAddresses();
  } catch {
    console.warn("[cron] getComingSoonAddresses failed — Coming Soon table may not exist yet");
    return;
  }

  if (addresses.length === 0) {
    console.log("[cron] No Coming Soon addresses to check");
    return;
  }

  let token: string;
  try {
    token = await getAuthToken();
  } catch (err: any) {
    console.warn("[cron] Cannot check Coming Soon — no auth token:", err.message);
    return;
  }

  const promoted: string[] = [];

  for (const cs of addresses) {
    try {
      // Re-check via address search
      const { proxyFetch: pf } = await import("./proxy-fetch");
      const res = await pf(KFS_SCAN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": `Bearer ${token}`,
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          "device-id": "698ca1e5-f077-4a62-a1e7-e97f484c7231",
          "Referer": KFS_REFERER,
          "Origin": KFS_ORIGIN,
        },
        body: JSON.stringify({
          addressLine1: cs.address,
          addressLine2: "",
          city: cs.city,
          state: cs.state,
          postalCode: cs.zip,
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) { await new Promise(r => setTimeout(r, 500)); continue; }

      const data = await res.json();
      if (!data.success || !data.address) { await new Promise(r => setTimeout(r, 300)); continue; }

      const segment = data.address?.householdSegmentType ?? "";
      const isNewFiber = segment === "NEW FIBER";

      // Update last checked
      try { storage.markComingSoonChecked(cs.id); } catch { /* ignore */ }

      if (isNewFiber) {
        // Fiber went live! Promote to lead.
        const fullAddress = `${cs.address}, ${cs.city}, ${cs.state} ${cs.zip}`;
        promoted.push(fullAddress);

        try {
          const lead = storage.createLead({
            address: cs.address,
            city: cs.city,
            state: cs.state,
            zip: cs.zip,
            lat: cs.lat ?? undefined,
            lng: cs.lng ?? undefined,
            fiberStatus: "new_fiber",
            isNewFiber: true,
            isTenured: false,
            billingStatus: data.address?.billingStatus ?? null,
            householdSegmentType: segment,
            techType: data.techType ?? data.address?.maxQualTechnologyType ?? null,
            leadStatus: "prospect",
            deploymentNotes: `Coming Soon promoted: fiber went live. Previously in pipeline since ${cs.createdAt}.`,
          });
          try { storage.markComingSoonAvailable(cs.id, lead.id); } catch { /* ignore */ }
        } catch { /* duplicate — still mark available */ }

        // Immediate alert
        sendAlertEmail(
          `🟡 Coming Soon → LIVE: ${cs.address}`,
          comingSoonPromotedHtml(1, [fullAddress])
        ).catch(() => {});
      }

      await new Promise(r => setTimeout(r, 200));
    } catch { /* skip this address */ }
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

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    await Promise.all(batch.map(async (t: any) => {
      try {
        const r = await scanAddress(t.address, t.city, t.state, t.zip);
        // Transition detection: compare the stored snapshot against this fresh
        // scan to tell a genuine unavailable→live FLIP (newly_live, first-to-
        // market) from a first-ever scan of an already-live address.
        const outcome = classifyAvailabilityTransition(snapshotFromTarget(t), r);
        let leadId: number | null = null;
        const qual = outcome.shouldCreateLead ? qualifyDetection(t.address, inventory) : null;
        if (qual) exclusionReasons.push(qual.reason);
        if (qual?.qualified) {
          try {
            const lead = storage.createLead({
              address: r.address, city: r.city, state: r.state, zip: r.zip,
              lat: r.lat ?? t.lat ?? undefined, lng: r.lng ?? t.lng ?? undefined,
              fiberStatus: "new_fiber", isNewFiber: true, isTenured: false,
              billingStatus: r.billingStatus, householdSegmentType: r.householdSegmentType,
              techType: r.techType, speedTier: r.speedTier, maxDownloadMbps: r.maxDownloadMbps,
              competitorName: r.competitorName, dfAddressId: r.dfAddressId,
              leadStatus: "prospect",
              deploymentNotes: outcome.isNewlyLive
                ? "Nightly re-scan — NEWLY LIVE fiber (flipped from unavailable). First to market."
                : "Nightly re-scan — live fiber (first observation).",
            });
            leadId = lead.id;
          } catch { /* duplicate — skip */ }
          inventory.set(normalizeAddressKey(t.address), { leadStatus: "prospect", assignedRepId: null });
          newFiberAddrs.push(t.address);
          cronStatus.totalNewFiberFound++;
        }
        storage.recordScanTargetResult(t.id, {
          fiberStatus: r.fiberStatus, isNewFiber: r.isNewFiber, billingStatus: r.billingStatus,
          dfAddressId: r.dfAddressId, convertedToLeadId: leadId,
          availabilityStatus: outcome.status, newlyLive: outcome.isNewlyLive,
        });
      } catch { /* token expiry / timeout — skip this address, keep going */ }
    }));
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
