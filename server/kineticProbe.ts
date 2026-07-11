// ── kineticProbe — the ONE typed probe primitive ─────────────────────────────
// Every scan (manual address, nightly CNS sweep, watchlist recheck, discovery,
// radar) resolves against Kinetic through exactly this. It replaces note-string
// sniffing with a discriminated ProbeOutcome so "what a 403 means" lives in ONE
// place and can never be silently broken by reworded log text. A task is keyed
// EITHER by street address (scanAddress) or by Kinetic df-id (probeKineticDfId);
// both collapse to the same ProbeOutcome so the scheduler treats them identically.

import { scanAddress, getAuthToken, refreshTokenFromApi, type ScanResult } from "./scanner";
import { probeKineticDfId, type CnsResult } from "./cns-scanner";

// A task key — the scheduler carries these and hands them to probe().
export interface AddrKey { kind: "addr"; address: string; city: string; state: string; zip: string }
export interface DfKey { kind: "df"; dfAddressId: string }
export type ProbeKey = AddrKey | DfKey;

// The common result fields every consumer persists (a ScanResult is a structural
// superset; a CnsResult is normalized into this via cnsToProbeResult).
export interface ProbeResult {
  address: string; city: string; state: string; zip: string;
  lat: number | null; lng: number | null;
  fiberStatus: string; isNewFiber: boolean; billingStatus: string | null;
  householdSegmentType: string | null; techType: string | null;
  speedTier: string | null; maxDownloadMbps: number | null;
  competitorName: string | null; addressCatalogDate: string | null; dfAddressId: string | null;
}

export type ProbeOutcome =
  | { kind: "answered"; result: ProbeResult; latencyMs: number }    // Kinetic gave a real verdict (fiber/copper/tenured/etc.)
  | { kind: "no_service"; result: ProbeResult; latencyMs: number }  // conclusive: address not in / not served by the fabric
  | { kind: "blocked"; latencyMs: number }                          // 403 throttle — the ONLY congestion signal
  | { kind: "inconclusive"; reason: string; latencyMs: number };    // 401/timeout/5xx/network/soft-fail — NO availability signal

export type ProbeOutcomeKind = ProbeOutcome["kind"];

// Unified entry point — the scheduler calls this and nothing else.
export function probe(key: ProbeKey): Promise<ProbeOutcome> {
  return key.kind === "df" ? probeDf(key.dfAddressId) : probeAddress(key);
}

// ── Address path ─────────────────────────────────────────────────────────────
// Pure: map a completed ScanResult to its outcome KIND using the scanner's TYPED
// fields only (blocked / apiSource / fiberStatus) — never `notes`.
export function classifyScanResult(r: ScanResult): ProbeOutcomeKind {
  if (r.blocked) return "blocked";
  if (r.apiSource === "kinetic_live") return r.fiberStatus === "no_service" ? "no_service" : "answered";
  return "inconclusive";
}

export async function probeAddress(task: AddrKey): Promise<ProbeOutcome> {
  const t0 = Date.now();
  let r: ScanResult;
  try {
    r = await scanAddress(task.address, task.city, task.state, task.zip);
  } catch (e: any) {
    return { kind: "inconclusive", reason: e?.message ?? "probe threw", latencyMs: Date.now() - t0 };
  }
  const latencyMs = Date.now() - t0;
  switch (classifyScanResult(r)) {
    case "blocked":    return { kind: "blocked", latencyMs };
    case "no_service": return { kind: "no_service", result: r, latencyMs };
    case "answered":   return { kind: "answered", result: r, latencyMs };
    default:           return { kind: "inconclusive", reason: r.notes || "non-conclusive", latencyMs };
  }
}

// ── df-id path ───────────────────────────────────────────────────────────────
// Derive the fiberStatus a CnsResult implies (mirrors scanAddress's segment logic).
export function cnsFiberStatus(cr: Pick<CnsResult, "isNewFiber" | "householdSegmentType" | "techType" | "maxDownloadMbps">): string {
  if (cr.isNewFiber) return "new_fiber";
  if ((cr.householdSegmentType ?? "").toUpperCase() === "TENURED") return "tenured_fiber";
  if (cr.techType === "FIBER" || (cr.maxDownloadMbps ?? 0) >= 300) return "existing_fiber";
  return "copper";
}

export function cnsToProbeResult(cr: CnsResult): ProbeResult {
  return {
    address: cr.address, city: cr.city, state: cr.state, zip: cr.zip,
    lat: cr.lat, lng: cr.lng,
    fiberStatus: cnsFiberStatus(cr), isNewFiber: cr.isNewFiber, billingStatus: cr.billingStatus,
    householdSegmentType: cr.householdSegmentType, techType: cr.techType,
    speedTier: cr.speedTier, maxDownloadMbps: cr.maxDownloadMbps,
    competitorName: cr.competitorName, addressCatalogDate: cr.addressCatalogDate, dfAddressId: cr.dfAddressId,
  };
}

export async function probeDf(dfAddressId: string): Promise<ProbeOutcome> {
  const t0 = Date.now();
  let token: string;
  try { token = await getAuthToken(); }
  catch (e: any) { return { kind: "inconclusive", reason: e?.message ?? "no token", latencyMs: Date.now() - t0 }; }

  let p = await probeKineticDfId(dfAddressId, token);
  // A 401 mid-run = expired token; refresh once and retry (parity with scanAddress).
  if (p.kind === "fail" && p.reason === "token_expired") {
    try { token = await refreshTokenFromApi(); p = await probeKineticDfId(dfAddressId, token); } catch { /* stays a fail */ }
  }
  const latencyMs = Date.now() - t0;
  if (p.kind === "hit") return { kind: "answered", result: cnsToProbeResult(p.result), latencyMs };
  if (p.kind === "miss") {
    // Not in the fabric — conclusive no-service, keyed by the df id so callers can persist it.
    return { kind: "no_service", result: emptyDfResult(dfAddressId), latencyMs };
  }
  if (p.reason === "blocked") return { kind: "blocked", latencyMs };
  return { kind: "inconclusive", reason: p.reason, latencyMs };
}

function emptyDfResult(dfAddressId: string): ProbeResult {
  return {
    address: "", city: "", state: "", zip: "", lat: null, lng: null,
    fiberStatus: "no_service", isNewFiber: false, billingStatus: null,
    householdSegmentType: null, techType: null, speedTier: null, maxDownloadMbps: null,
    competitorName: null, addressCatalogDate: null, dfAddressId,
  };
}
