/**
 * CNS (Control Number Scanner) — HomeFront Fiber
 *
 * Kinetic assigns every address in its network:
 *   ENV  — a provider index partition (e.g. "MS" = NC/SC, "PA" = Pennsylvania)
 *   CNS  — a sequential integer control number (their internal address ID)
 *
 * With written authorization, bounded CNS probes can collect primary-provider
 * address observations. A provider NEW FIBER label is evidence, not proof that
 * an address became serviceable recently.
 *
 * Endpoint used:
 *   POST https://buy.gokinetic.com/api/v2/address/search
 *   Body: { dfAddressId: "<ENV><CNS_ZERO_PADDED>" }
 *
 * A CNS NEW FIBER response is a primary-source candidate. It becomes a rep lead
 * only after a persisted unavailable→available transition and independent
 * address-level fiber evidence pass the shared projector.
 */

import { proxyFetch } from "./proxy-fetch";
import { KFS_SCAN_URL, KFS_REFERER, KFS_ORIGIN } from "./kfs-config";
import { canonicalizeAddress } from "@shared/cnsIndex";
import { persistKineticObservation } from "./kineticObservation";
import { structuredLog } from "./structuredLog";
import { assertAutomationAuthorized, providerHeaders } from "./scanner";
import { KINETIC_ENVIRONMENTS, type KineticEnvironment } from "@shared/kineticFootprint";
import {
  createPersistedCnsJob, loadCnsResults, loadPersistedCnsJobs, persistCnsObservation, persistCnsProgress,
  archivePersistedCnsJob,
} from "./cnsOperationsStore";

// One shared, reviewed registry powers manual scans, nightly rotation, and UI.
export type KineticEnv = KineticEnvironment;
export const KINETIC_ENVS = KINETIC_ENVIRONMENTS;

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
  newFiberHits: number;   // raw primary-source NEW FIBER matches
  confirmedLeads: number; // independently confirmed projector publications
  skipped: number;
  errors: number;
  retries: number;
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
const activeWorkers = new Set<string>();

// Rehydrate the operator ledger after a deploy. Active jobs fail safe to paused;
// a manager explicitly resumes from currentCns, preventing surprise proxy spend.
for (const row of loadPersistedCnsJobs()) {
  cnsJobs.set(row.id, {
    tenantId: row.tenantId, id: row.id, env: row.env, envLabel: KINETIC_ENVS.find(e => e.code === row.env)?.label ?? row.env,
    startCns: row.startCns, endCns: row.endCns, currentCns: row.currentCns, status: row.status,
    found: loadCnsResults(row.id), scanned: row.scanned, hits: row.hits, newFiberHits: row.newFiberHits,
    confirmedLeads: row.confirmedLeads, skipped: row.skipped, errors: row.errors, retries: row.retries,
    startedAt: row.startedAt, completedAt: row.completedAt, lastError: row.lastError, ratePerMin: row.ratePerMin,
  });
  if (row.status === "paused") pauseFlags.add(row.id);
}

export function getCnsJobs(): CnsJob[] {
  return Array.from(cnsJobs.values());
}

export function getCnsJob(id: string): CnsJob | undefined {
  return cnsJobs.get(id);
}

export function stopCnsJob(id: string) {
  stopFlags.add(id);
  const job = cnsJobs.get(id);
  if (job) { job.status = "stopped"; job.completedAt = new Date().toISOString(); persistCnsProgress(job, "job.stopped"); }
}

export function pauseCnsJob(id: string) {
  pauseFlags.add(id);
  const job = cnsJobs.get(id);
  if (job) { job.status = "paused"; persistCnsProgress(job, "job.paused"); }
}

export function resumeCnsJob(id: string, getToken?: () => Promise<string>) {
  pauseFlags.delete(id);
  const job = cnsJobs.get(id);
  if (!job) return;
  job.status = "running";
  job.completedAt = undefined;
  job.lastError = undefined;
  job.retries++;
  persistCnsProgress(job, "job.resumed");
  if (!activeWorkers.has(id) && getToken) {
    const resumeAt = Math.max(job.startCns, job.currentCns + (job.scanned > 0 ? 1 : 0));
    void runCnsScan(id, job.env, resumeAt, job.endCns, getToken);
  }
}

export function archiveCnsJob(id: string, tenantId: number): boolean {
  const job = cnsJobs.get(id);
  if (!job || job.tenantId !== tenantId || ["running","paused"].includes(job.status)) return false;
  if (!archivePersistedCnsJob(id,tenantId)) return false;
  cnsJobs.delete(id); stopFlags.delete(id); pauseFlags.delete(id);
  return true;
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
  | { kind: "fail"; reason: "unauthorized" | "token_expired" | "blocked" | "http" | "network" | "malformed" };

export async function probeKineticDfId(dfAddressId: string, token: string, timeoutMs = 8000): Promise<CnsProbe> {
  const parsed = /^([A-Za-z]+)(\d+)$/.exec(dfAddressId);
  const env = parsed ? parsed[1].toUpperCase() : "";
  const cns = parsed ? parseInt(parsed[2], 10) : 0;

  let res: Response;
  try {
    assertAutomationAuthorized();
    res = await proxyFetch(KFS_SCAN_URL, {
      method: "POST",
      headers: providerHeaders({
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
        "Referer": KFS_REFERER,
        "Origin": KFS_ORIGIN,
      }),
      body: JSON.stringify({ dfAddressId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("KFS_AUTOMATION_NOT_AUTHORIZED")) {
      return { kind: "fail", reason: "unauthorized" };
    }
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
async function lookupCns(env: string, cns: number, token: string): Promise<{ status: "hit" | "miss" | "fail"; reason?: string; result?: CnsResult }> {
  const probe = await probeKineticDfId(`${env}${String(cns).padStart(7, "0")}`, token);
  if (probe.kind === "fail" && probe.reason === "token_expired") throw new Error("TOKEN_EXPIRED: 401");
  if (probe.kind === "hit") return { status: "hit", result: probe.result };
  if (probe.kind === "miss") return { status: "miss" };
  // A 403 block / transport failure is NOT "no address here" — surface it so the
  // caller backs off instead of recording a phantom miss and hammering a blocked proxy.
  return { status: "fail", reason: probe.reason };
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
  if (!job || activeWorkers.has(jobId)) return;
  activeWorkers.add(jobId);
  const rateWindow: number[] = []; // timestamps for rate calculation

  let consecutiveErrors = 0;

  for (let cns = startCns; cns <= endCns; cns++) {
    // Stop check
    if (stopFlags.has(jobId)) {
      job.status = "stopped";
      job.completedAt = new Date().toISOString();
      persistCnsProgress(job, "job.stopped");
      stopFlags.delete(jobId);
      activeWorkers.delete(jobId);
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
      const lk = await lookupCns(env, cns, token);
      if (lk.status === "fail") {
        // 403/transport failure — a non-answer, never a miss. Back off (longer on a
        // 403 block) and count it toward the consecutive-error abort. Do NOT advance
        // as if this control number were unassigned.
        consecutiveErrors++;
        job.lastError = `probe ${lk.reason}`;
        job.errors++;
        if (consecutiveErrors >= 10) { job.status = "error"; job.completedAt = new Date().toISOString(); persistCnsProgress(job, "job.failed"); activeWorkers.delete(jobId); return; }
        await new Promise(r => setTimeout(r, lk.reason === "blocked" ? 2000 : 300));
        continue;
      }
      const found = lk.status === "hit";
      const result = lk.result;

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

        // HARVEST-AS-YOU-SCAN: persist every CNS hit into the durable observation
        // model. A raw NEW FIBER hit is not itself a lead: only a proven flip plus
        // independent evidence can be projected to the rep map.
        try {
          const persisted = persistKineticObservation({
            tenantId: job.tenantId,
            source: "cns-range",
            observation: {
              ...result,
              fiberStatus: result.isNewFiber ? "new_fiber" : "other",
            },
          });
          job.confirmedLeads += persisted.projection.published;
        } catch (error: any) {
          structuredLog("cns_range.observation_failed", {
            tenantId: job.tenantId ?? null,
            dfAddressId: result.dfAddressId,
            error: String(error?.message ?? error),
          }, "warn");
        }
        persistCnsObservation(job, result);
        if (result.isNewFiber) job.newFiberHits++; // raw primary-source hit only

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
      if (job.scanned % 25 === 0 || found) persistCnsProgress(job, "job.progress");

    } catch (err: any) {
      consecutiveErrors++;
      job.errors++;
      job.lastError = err.message;

      if (err.message?.startsWith("TOKEN_EXPIRED")) {
        // Token expired — pause and wait for manual refresh
        job.status = "paused";
        pauseFlags.add(jobId);
        job.lastError = "Token expired. Paste a new token in Token Setup, then resume.";
        persistCnsProgress(job, "job.token_expired");
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
        persistCnsProgress(job, "job.failed");
        activeWorkers.delete(jobId);
        return;
      }

      await new Promise(r => setTimeout(r, 300));
    }
  }

  job.status = "done";
  job.completedAt = new Date().toISOString();
  persistCnsProgress(job, "job.completed");
  activeWorkers.delete(jobId);
}

// ── Public API ────────────────────────────────────────────────────────────────
export function createCnsJob(
  env: string,
  startCns: number,
  endCns: number,
  getToken: () => Promise<string>,
  tenantId?: number,
  createdBy?: number,
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
    confirmedLeads: 0,
    skipped: 0,
    errors: 0,
    retries: 0,
    startedAt: new Date().toISOString(),
    ratePerMin: 0,
  };

  cnsJobs.set(jobId, job);
  createPersistedCnsJob(job, createdBy);

  // Run in background — non-blocking
  runCnsScan(jobId, env, startCns, endCns, getToken).catch(err => {
    const j = cnsJobs.get(jobId);
    if (j) {
      j.status = "error";
      j.lastError = err.message;
      j.completedAt = new Date().toISOString();
      j.errors++;
      persistCnsProgress(j, "job.failed");
      activeWorkers.delete(jobId);
    }
  });

  return job;
}
