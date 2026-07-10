/**
 * CNS (Control Number Scanner) — HomeFront Fiber
 *
 * Kinetic assigns every address in its network:
 *   ENV  — a region code (e.g. "MS" = IN/MI/NC/SC, "PA" = Pennsylvania)
 *   CNS  — a sequential integer control number (their internal address ID)
 *
 * By iterating CNS values for an ENV we can discover addresses that Kinetic
 * just added to its fabric — NEW FIBER builds — before any FCC map, ISP
 * database, or door-to-door operation knows they exist.
 *
 * Endpoint used:
 *   POST https://buy.gokinetic.com/api/v2/address/search
 *   Body: { dfAddressId: "<ENV><CNS_ZERO_PADDED>" }
 *
 * When a CNS returns addressCatalogDt within the last 90 days AND
 * householdSegmentType = "NEW FIBER" → this is a brand-new build.
 */

import { storage } from "./storage";
import { proxyFetch } from "./proxy-fetch";
import { KFS_SCAN_URL, KFS_REFERER, KFS_ORIGIN } from "./kfs-config";
import { canonicalizeAddress } from "@shared/cnsIndex";

// ── ENV Registry — all known Kinetic ENV codes from FiberFocus bundle ─────────
export interface KineticEnv {
  code: string;        // e.g. "MS"
  label: string;       // human-readable
  states: string;      // states covered
  upperLimit: number;  // highest known control number
  prefix: string;      // CNS prefix format  
}

export const KINETIC_ENVS: KineticEnv[] = [
  { code: "MS", label: "Carolinas / Midwest", states: "IN, MI, NC, SC", upperLimit: 3_062_552, prefix: "MS" },
  { code: "PA", label: "Pennsylvania",        states: "PA",              upperLimit: 573_208,   prefix: "PA" },
  { code: "NW", label: "Northwest California",states: "CA",              upperLimit: 14_936,    prefix: "NW" },
  { code: "AL", label: "Alabama / Southeast", states: "AL, GA, FL, MS",  upperLimit: 800_000,   prefix: "AL" },
  { code: "OH", label: "Ohio / Kentucky",     states: "OH, KY",          upperLimit: 500_000,   prefix: "OH" },
  { code: "TX", label: "Texas",               states: "TX, OK, NM",      upperLimit: 600_000,   prefix: "TX" },
  { code: "MO", label: "Missouri / Iowa",     states: "MO, IA, NE, MN",  upperLimit: 700_000,   prefix: "MO" },
  { code: "NY", label: "New York",            states: "NY",              upperLimit: 400_000,   prefix: "NY" },
  { code: "AR", label: "Arkansas",            states: "AR",              upperLimit: 300_000,   prefix: "AR" },
];

// ── CNS Scanner State ─────────────────────────────────────────────────────────
export interface CnsJob {
  tenantId?: number;
  id: string;
  env: string;
  envLabel: string;
  startCns: number;
  endCns: number;
  currentCns: number;
  status: "running" | "paused" | "done" | "stopped" | "error";
  found: CnsResult[];
  scanned: number;
  hits: number;           // addresses found in Kinetic fabric
  newFiberHits: number;   // NEW FIBER specifically
  startedAt: string;
  completedAt?: string;
  estimatedMinutes?: number;
  lastError?: string;
  ratePerMin: number;     // addresses/min (rolling average)
}

export interface CnsResult {
  env: string;
  cns: number;
  dfAddressId: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  lat: number | null;
  lng: number | null;
  householdSegmentType: string | null;
  isNewFiber: boolean;
  techType: string | null;
  speedTier: string | null;
  maxDownloadMbps: number | null;
  billingStatus: string | null;
  addressCatalogDate: string | null;
  competitorName: string | null;
  discoveredAt: string;
}

// In-memory job store
const cnsJobs = new Map<string, CnsJob>();
const stopFlags = new Set<string>(); // jobs that should stop
const pauseFlags = new Set<string>(); // jobs that should pause

export function getCnsJobs(): CnsJob[] {
  return Array.from(cnsJobs.values());
}

export function getCnsJob(id: string): CnsJob | undefined {
  return cnsJobs.get(id);
}

export function stopCnsJob(id: string) {
  stopFlags.add(id);
}

export function pauseCnsJob(id: string) {
  pauseFlags.add(id);
}

export function resumeCnsJob(id: string) {
  pauseFlags.delete(id);
}

// ── Canonical Kinetic df-id probe ─────────────────────────────────────────────
// A single probe of one control number. Distinguishes a conclusive MISS (address
// genuinely not in Kinetic's fabric) from a transient FAIL (timeout / 401 / non-200
// / unparseable / soft success:false) — a non-answer is NEVER treated as "no
// address here" (it must not poison discovery). Shared by the interactive scanner
// and the city-discovery engine.
export type CnsProbe =
  | { kind: "hit"; result: CnsResult }
  | { kind: "miss" }
  | { kind: "fail"; reason: "token_expired" | "blocked" | "http" | "network" | "malformed" };

export async function probeKineticDfId(dfAddressId: string, token: string, timeoutMs = 8000): Promise<CnsProbe> {
  const parsed = /^([A-Za-z]+)(\d+)$/.exec(dfAddressId);
  const env = parsed ? parsed[1].toUpperCase() : "";
  const cns = parsed ? parseInt(parsed[2], 10) : 0;

  let res: Response;
  try {
    res = await proxyFetch(KFS_SCAN_URL, {
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
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "fail", reason: "network" };
  }

  if (!res.ok) {
    // 401 = expired token (refreshable). 403 = the egress IP is WAF/geo-BLOCKED —
    // refreshing the token won't help, so it's a distinct reason the caller must
    // NOT paper over by resetting its failure counter (else a blocked proxy burns
    // the whole budget). Everything else is a generic transient http failure.
    if (res.status === 401) return { kind: "fail", reason: "token_expired" };
    if (res.status === 403) return { kind: "fail", reason: "blocked" };
    return { kind: "fail", reason: "http" };
  }

  let data: any;
  try { data = await res.json(); } catch { return { kind: "fail", reason: "malformed" }; }

  // Explicit "not in fabric" is a conclusive miss. A soft success:false WITHOUT
  // an explicit AddressNotFound is a NON-ANSWER (provider hiccup), not a miss.
  if (data?.validationResult === "AddressNotFound") return { kind: "miss" };
  if (!data?.success) return { kind: "fail", reason: "http" };
  if (!data?.address) return { kind: "miss" };

  const addr = data.address;
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
  const segment = addr.householdSegmentType ?? "";
  const result: CnsResult = {
    env, cns, dfAddressId,
    // Canonicalize to Title Case so CNS-discovered rows dedupe against scanner rows.
    address: canonicalizeAddress(addr.addressLine1),
    city: canonicalizeAddress(addr.city),
    state: addr.stateProvinceCd ?? "",
    zip: addr.postalCd ?? "",
    lat: addr.geoLat ? parseFloat(addr.geoLat) : null,
    lng: addr.geoLong ? parseFloat(addr.geoLong) : null,
    householdSegmentType: segment || null,
    isNewFiber: segment === "NEW FIBER",
    techType: data.techType ?? addr.maxQualTechnologyType ?? null,
    speedTier,
    maxDownloadMbps: mbps,
    billingStatus: addr.billingStatus ?? null,
    addressCatalogDate: addr.addressCatalogDt ?? null,
    competitorName: addr.competitorCompanyName ?? null,
    discoveredAt: new Date().toISOString(),
  };
  return { kind: "hit", result };
}

// ── CNS lookup via dfAddressId field (thin wrapper over the canonical probe) ──
async function lookupCns(env: string, cns: number, token: string): Promise<{ found: boolean; result?: CnsResult }> {
  const probe = await probeKineticDfId(`${env}${String(cns).padStart(7, "0")}`, token);
  if (probe.kind === "fail" && probe.reason === "token_expired") throw new Error("TOKEN_EXPIRED: 401");
  if (probe.kind === "hit") return { found: true, result: probe.result };
  return { found: false };
}

// ── Main scanner loop ─────────────────────────────────────────────────────────
export async function runCnsScan(
  jobId: string,
  env: string,
  startCns: number,
  endCns: number,
  getToken: () => Promise<string>
) {
  const job = cnsJobs.get(jobId)!;
  const rateWindow: number[] = []; // timestamps for rate calculation

  let consecutiveErrors = 0;

  for (let cns = startCns; cns <= endCns; cns++) {
    // Stop check
    if (stopFlags.has(jobId)) {
      job.status = "stopped";
      job.completedAt = new Date().toISOString();
      stopFlags.delete(jobId);
      return;
    }

    // Pause check — wait until resumed
    while (pauseFlags.has(jobId)) {
      job.status = "paused";
      await new Promise(r => setTimeout(r, 1000));
    }
    if (job.status === "paused") job.status = "running";

    job.currentCns = cns;
    job.scanned++;

    try {
      const token = await getToken();
      const { found, result } = await lookupCns(env, cns, token);

      rateWindow.push(Date.now());
      // Keep only last 60 timestamps for rolling rate
      if (rateWindow.length > 60) rateWindow.shift();
      if (rateWindow.length >= 2) {
        const span = (rateWindow[rateWindow.length - 1] - rateWindow[0]) / 60000; // minutes
        job.ratePerMin = Math.round(rateWindow.length / span);
      }

      if (found && result) {
        job.hits++;
        job.found.push(result);

        // HARVEST-AS-YOU-SCAN: Kinetic just handed us the full canonical address,
        // coords, and its df id for free — persist EVERY discovery into the pool
        // (not just NEW FIBER). This is what makes the pool self-growing from
        // Kinetic itself, so a city we've CNS-scanned never needs a Mapbox harvest.
        try {
          storage.upsertScanTargets([{
            address: result.address, city: result.city, state: result.state, zip: result.zip,
            lat: result.lat, lng: result.lng, source: "kinetic-cns", tenantId: job.tenantId ?? null,
            dfAddressId: result.dfAddressId, scannedNow: true,
            fiberStatus: result.isNewFiber ? "new_fiber" : "other",
            isNewFiber: result.isNewFiber, billingStatus: result.billingStatus,
          }]);
        } catch { /* pool write is best-effort — never fail the scan on it */ }

        // A NEW FIBER address with NO current subscriber (billing "N") is the
        // door-knock target. upsertLeadByAddress DEDUPES by normalized address, so
        // re-scanning an overlapping range never spawns duplicate leads.
        if (result.isNewFiber && result.billingStatus === "N") {
          job.newFiberHits++;
          try {
            storage.upsertLeadByAddress({
              tenantId: job.tenantId ?? undefined,
              address: result.address, city: result.city, state: result.state, zip: result.zip,
              lat: result.lat ?? undefined, lng: result.lng ?? undefined,
              fiberStatus: "new_fiber", isNewFiber: true, isTenured: false,
              billingStatus: result.billingStatus, householdSegmentType: result.householdSegmentType,
              techType: result.techType, speedTier: result.speedTier, maxDownloadMbps: result.maxDownloadMbps,
              competitorName: result.competitorName, addressCatalogDate: result.addressCatalogDate,
              dfAddressId: result.dfAddressId, leadStatus: "prospect",
              deploymentNotes: `CNS scan: ENV=${env} CNS=${cns}. Discovered ${result.discoveredAt}.`,
            } as any);
          } catch { /* dedup/constraint — skip */ }
        } else if (result.isNewFiber) {
          job.newFiberHits++; // counted, but an existing subscriber isn't a lead
        }

        // Brief pause after a hit (live address found — be respectful)
        await new Promise(r => setTimeout(r, 200));
        consecutiveErrors = 0;
      } else {
        // Miss — fast skip
        await new Promise(r => setTimeout(r, 40));
        consecutiveErrors = 0;
      }

      // Update ETA
      const remaining = endCns - cns;
      if (job.ratePerMin > 0) {
        job.estimatedMinutes = Math.round(remaining / job.ratePerMin);
      }

    } catch (err: any) {
      consecutiveErrors++;
      job.lastError = err.message;

      if (err.message?.startsWith("TOKEN_EXPIRED")) {
        // Token expired — pause and wait for manual refresh
        job.status = "paused";
        pauseFlags.add(jobId);
        job.lastError = "Token expired. Paste a new token in Token Setup, then resume.";
        while (pauseFlags.has(jobId)) {
          await new Promise(r => setTimeout(r, 2000));
        }
        job.status = "running";
        continue;
      }

      if (consecutiveErrors >= 10) {
        job.status = "error";
        job.lastError = `Too many consecutive errors: ${err.message}`;
        job.completedAt = new Date().toISOString();
        return;
      }

      await new Promise(r => setTimeout(r, 300));
    }
  }

  job.status = "done";
  job.completedAt = new Date().toISOString();
}

// ── Public API ────────────────────────────────────────────────────────────────
export function createCnsJob(
  env: string,
  startCns: number,
  endCns: number,
  getToken: () => Promise<string>,
  tenantId?: number,
): CnsJob {
  const envInfo = KINETIC_ENVS.find(e => e.code === env);
  const jobId = `cns_${env}_${Date.now()}`;

  const job: CnsJob = {
    tenantId,
    id: jobId,
    env,
    envLabel: envInfo?.label ?? env,
    startCns,
    endCns,
    currentCns: startCns,
    status: "running",
    found: [],
    scanned: 0,
    hits: 0,
    newFiberHits: 0,
    startedAt: new Date().toISOString(),
    ratePerMin: 0,
  };

  cnsJobs.set(jobId, job);

  // Run in background — non-blocking
  runCnsScan(jobId, env, startCns, endCns, getToken).catch(err => {
    const j = cnsJobs.get(jobId);
    if (j) {
      j.status = "error";
      j.lastError = err.message;
      j.completedAt = new Date().toISOString();
    }
  });

  return job;
}
