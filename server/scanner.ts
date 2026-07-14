// Kinetic availability adapter. Live use is opt-in and requires a licensed API,
// partner integration, or written automation permission; credentials and the
// stable provider-issued identity are loaded only from environment variables.
import { proxyFetch } from "./proxy-fetch";
import { KFS_SCAN_URL, KFS_REFERER, KFS_ORIGIN } from "./kfs-config";
import { scoreLead } from "./lead-scoring";
import { isKineticFiber } from "@shared/fiberDetect";
import { ProviderRequestQueue, type ProviderQueueSnapshot, type QueueEvent } from "./providerRequestQueue";
import { structuredLog } from "./structuredLog";
import crypto from "node:crypto";

// ─── KEY RESPONSE FIELDS FROM API ────────────────────────────────────────────
// address.householdSegmentType  → "NEW FIBER" | "TENURED" | "PROSPECT"
// address.maxQualTechnologyType → "FIBER" | "COPPER"
// techType                      → "FIBER" | "COPPER"
// maxQual                       → "QUAL UP TO 2 GIG RANGE VIA FIBER" etc.
// broadbandService.finalQualSpeed → speed in Kbps
// address.competitorCompanyName → "Spectrum" | "AT&T" etc.
// address.competitorQualSpeed   → competitor max speed Mbps
// address.addressCatalogDt      → when address entered Kinetic fabric (proxy for build date)
// uqualProvisioningResult.chipSetType → "FTTP" | "FTTN" | "VDSL"
// uqualProvisioningResult.finalPlacement → "BUR" (buried) | "AER" (aerial)
// ─────────────────────────────────────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiry: number = 0;
let manualToken: string | null = null; // set via POST /api/set-token
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let lastRefreshAttempt: number = 0;
let refreshFailCount: number = 0;
let refreshInFlight: Promise<string> | null = null; // mutex: coalesce concurrent refreshes

const DEFAULT_AUTOMATION_USER_AGENT = "HomeFrontFiber-AvailabilityMonitor/1.0 (operations@homefrontsolutions.com)";

export function assertAutomationAuthorized(): void {
  if (process.env.KFS_AUTOMATION_AUTHORIZED !== "true") {
    throw new Error("KFS_AUTOMATION_NOT_AUTHORIZED: enable only for a licensed API, partner integration, or written authorization");
  }
}

export function providerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": process.env.KFS_USER_AGENT?.trim() || DEFAULT_AUTOMATION_USER_AGENT,
    ...extra,
  };
  // Some authorized integrations issue a stable device identifier. Never
  // fabricate or rotate one; omit it unless the provider supplied it.
  const deviceId = process.env.KFS_DEVICE_ID?.trim();
  if (deviceId) headers["device-id"] = deviceId;
  return headers;
}

// Decode a JWT's `exp` claim → ms epoch (minus a 60s safety margin), so token life
// is DERIVED, not a hard-coded 28min guess. Returns null if unparseable.
function jwtExpiryMs(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof json.exp === "number" ? json.exp * 1000 - 60_000 : null;
  } catch { return null; }
}

/** Called from routes.ts when user pastes a JWT from their browser */
export function setManualToken(token: string) {
  manualToken = token;
  cachedToken = token;
  tokenExpiry = jwtExpiryMs(token) ?? Date.now() + 28 * 60 * 1000; // real exp, else 28min fallback
  refreshFailCount = 0;
  // Start auto-refresh keepalive whenever a manual token is set
  startTokenKeepalive();
}

/**
 * Token keepalive — refreshes automatically every 25 minutes.
 * Kinetic tokens last ~30 min. We refresh at 25 min to stay ahead of expiry.
 * Uses the KFS_AUTH_BASIC credential. Falls back gracefully if blocked.
 */
function startTokenKeepalive() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(async () => {
    const now = Date.now();
    // Don't try if we just attempted in the last 5 min
    if (now - lastRefreshAttempt < 5 * 60 * 1000) return;
    // Don't refresh if token still has 10+ min left and we have a manual token
    if (manualToken && now < tokenExpiry - 10 * 60 * 1000) return;

    lastRefreshAttempt = now;
    try {
      await refreshTokenFromApi();
      refreshFailCount = 0;
      console.log(`[token-keepalive] Token refreshed OK at ${new Date().toISOString()}`);
    } catch (err: any) {
      refreshFailCount++;
      console.warn(`[token-keepalive] Refresh failed (attempt ${refreshFailCount}): ${err.message}`);
      // After 3 consecutive failures, stop trying until a manual token is pasted
      if (refreshFailCount >= 3) {
        console.warn("[token-keepalive] Auto-refresh disabled after 3 failures. Paste a new token.");
        if (autoRefreshTimer) clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
      }
    }
  }, 25 * 60 * 1000); // every 25 minutes
}

export async function refreshTokenFromApi(): Promise<string> {
  // MUTEX: a mid-batch keepalive tick, a 401-retry, a manual paste, and the
  // scheduler's block-driven refresh can all fire at once. Without coalescing they
  // race and clobber cachedToken; share ONE in-flight refresh so callers all await it.
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    assertAutomationAuthorized();
    const kfsUrl = process.env.KFS_AUTH_URL ?? "";
    const kfsBasic = process.env.KFS_AUTH_BASIC ?? "";
    if (!kfsUrl || !kfsBasic) throw new Error("KFS_AUTH_URL or KFS_AUTH_BASIC not configured");

    const res = await proxyFetch(kfsUrl, {
      method: "POST",
      headers: providerHeaders({
        "Content-Type": "application/json",
        "Authorization": kfsBasic,
        "Accept": "application/json",
      }),
      body: JSON.stringify({ brazeDeviceId: "" }),
      signal: AbortSignal.timeout(5000), // 5s — faster slot recycling
    });

    if (!res.ok) throw new Error(`Auto-auth blocked (${res.status})`);
    const data = await res.json();
    if (!data.token) throw new Error("No token in response");

    cachedToken = data.token;
    manualToken = data.token;                                  // manual token refreshed
    tokenExpiry = jwtExpiryMs(data.token) ?? Date.now() + 28 * 60 * 1000; // real exp, else fallback
    return cachedToken!;
  })();
  try { return await refreshInFlight; }
  finally { refreshInFlight = null; }
}

/** Exported for use by CNS scanner and routes */
export async function getAuthToken(): Promise<string> {
  assertAutomationAuthorized();
  const now = Date.now();
  // Use cached token if still valid (5 min buffer)
  if (cachedToken && now < tokenExpiry - 5 * 60 * 1000) return cachedToken;

  // Try auto-refresh via API
  try {
    return await refreshTokenFromApi();
  } catch {
    // Auto-refresh failed
  }

  // If we still have a token that's close to expiry, use it as last resort
  if (cachedToken && now < tokenExpiry) return cachedToken;

  throw new Error("TOKEN_EXPIRED: Session expired. Paste a new token from buy.gokinetic.com in Token Setup.");
}

export function getTokenStatus(): {
  automationAuthorized: boolean;
  hasToken: boolean;
  expiresIn: number | null;
  source: string;
  keepaliveActive: boolean;
  refreshFailCount: number;
} {
  const automationAuthorized = process.env.KFS_AUTOMATION_AUTHORIZED === "true";
  if (!cachedToken) return { automationAuthorized, hasToken: false, expiresIn: null, source: "none", keepaliveActive: false, refreshFailCount };
  const remaining = Math.round((tokenExpiry - Date.now()) / 1000);
  return {
    automationAuthorized,
    hasToken: true,
    expiresIn: remaining > 0 ? remaining : 0,
    source: manualToken ? "manual+keepalive" : "auto",
    keepaliveActive: autoRefreshTimer !== null,
    refreshFailCount,
  };
}

// Start keepalive on boot if credentials are present
if (process.env.KFS_AUTOMATION_AUTHORIZED === "true" && process.env.KFS_AUTH_URL && process.env.KFS_AUTH_BASIC) {
  // Initial token fetch on startup
  refreshTokenFromApi()
    .then(() => {
      console.log("[scanner] Initial token acquired on startup");
      startTokenKeepalive();
    })
    .catch(err => console.warn("[scanner] Startup token fetch failed — will retry on first scan:", err.message));
}

export interface KineticAddressResponse {
  // Top-level
  success: boolean;
  validationResult: string; // "AddressFound" | "AddressNotFound"
  errorCode: number;
  techType: string; // "FIBER" | "COPPER"
  maxQual: string;
  dfAddressId: string;
  accessId: string;
  exchangeId: string;
  exactMatch: boolean;
  fiberFastFlag: boolean;

  // Broadband service
  broadbandService?: {
    finalQualSpeed: string; // Kbps as string e.g. "2000000"
    finalExpectedSpeedDown?: string;
    finalExpectedSpeedUp?: string;
    finalVoip?: string;
  };

  // Address object — contains the gold fields
  address?: {
    geoLat: string;
    geoLong: string;
    addressLine1: string;
    city: string;
    stateProvinceCd: string;
    postalCd: string;
    zip4: string;
    addressCatalogDt: string; // "2019-03-12" — when address entered Kinetic fabric
    householdSegmentType: string; // "NEW FIBER" | "TENURED" | "PROSPECT"
    maxQualTechnologyType: string; // "FIBER" | "COPPER"
    maxQualTermDistanceInFeet: string;
    competitorSuppressionAreaFlag: string; // "Y" | "N"
    competitorCompanyName?: string;
    competitorQualSpeed?: string;
    competitorTechName?: string;
    billingStatus: string; // "N" = no existing account, "Y" = has account
    marketSegmentType?: string;
    exchangeId: string;
    accountTier?: string;
    censusBlock?: string;
    nonPaymentDisconnectFlag?: string;
  };

  // UQUAL provisioning (nested — contains chipSetType, finalPlacement)
  uqualProvisioningResult?: {
    chipSetType?: string; // "FTTP" | "FTTN" | "VDSL"
    finalPlacement?: string; // "BUR" (buried) | "AER" (aerial)
    [key: string]: any;
  };

  addressCandidates?: any[];
  raw?: any;
}

export interface ScanResult {
  address: string;
  city: string;
  state: string;
  zip: string;
  lat: number | null;
  lng: number | null;

  // Core fiber status
  fiberStatus: "new_fiber" | "existing_fiber" | "tenured_fiber" | "copper" | "unknown" | "no_service";
  isNewFiber: boolean;
  isTenured: boolean; // Existing Kinetic customer eligible for upgrade
  fiberAvailable: boolean;

  // Speed
  maxDownloadKbps: number | null;
  maxDownloadMbps: number | null;
  speedTier: string | null;

  // Technology
  techType: string | null; // "FIBER" | "COPPER"
  chipSetType: string | null; // "FTTP" | "FTTN"
  placement: string | null; // "BUR" | "AER"
  maxQual: string | null;

  // Competitor intel
  competitorName: string | null;
  competitorSpeedMbps: number | null;
  competitorTech: string | null;
  inCompetitorArea: boolean;

  // Timing / history
  addressCatalogDate: string | null; // When address entered Kinetic fabric
  householdSegmentType: string | null;
  billingStatus: string | null; // "N" = no account (non-subscriber), "Y" = active subscriber
  exchangeId: string | null;
  dfAddressId: string | null;
  accessId: string | null;

  // Meta
  confidence: "HIGH" | "MEDIUM" | "LOW";
  apiSource: "kinetic_live" | "knowledge_base" | "failed";
  blocked: boolean; // true ONLY for a 403 throttle — a typed back-pressure signal (NOT a no-service); consumers must never regex `notes` to detect this
  notes: string;
  rawResponse?: any;

  // Lead Scoring
  leadTag: string | null;
  leadScore: number;
}

const configuredProviderConcurrency = Number(process.env.SCAN_PROVIDER_CONCURRENCY ?? 8);
const configuredCacheTtlMs = Number(process.env.SCAN_RESULT_CACHE_MS ?? 5 * 60_000);

function scanKey(address: string, city: string, state: string, zip: string): string {
  return `${address}|${city}|${state}|${zip}`.trim().toLowerCase().replace(/\s+/g, " ");
}

function logQueueEvent(event: QueueEvent): void {
  if (event.type === "queued" && process.env.SCAN_VERBOSE_LOGS !== "true") return;
  // Address-level work is observable without writing a resident's street address
  // to application logs. The stable hash is enough to correlate retries/dedupes.
  const addressKey = crypto.createHash("sha256").update(event.key).digest("hex").slice(0, 16);
  structuredLog(`scan.provider.${event.type}`, {
    addressKey,
    active: event.active,
    queued: event.queued,
    waitMs: "waitMs" in event ? event.waitMs : undefined,
    durationMs: "durationMs" in event ? event.durationMs : undefined,
  }, event.type === "failed" ? "warn" : event.type === "queued" ? "debug" : "info");
}

const providerQueue = new ProviderRequestQueue<ScanResult>({
  maxConcurrency: Number.isFinite(configuredProviderConcurrency) ? configuredProviderConcurrency : 8,
  cacheTtlMs: Number.isFinite(configuredCacheTtlMs) ? configuredCacheTtlMs : 5 * 60_000,
  maxCacheEntries: Number(process.env.SCAN_RESULT_CACHE_MAX ?? 20_000),
  // Only conclusive provider answers are cached. A timeout, throttle, auth error,
  // or schema problem must remain recheckable and is never converted into a No.
  cacheable: value => value.apiSource !== "failed" && !value.blocked && value.fiberStatus !== "unknown",
  // Callers attach harvested coordinates to the top-level object. Return a fresh
  // shell so one job cannot mutate the cached result observed by another job.
  clone: value => ({ ...value }),
  onEvent: logQueueEvent,
});

export function getAddressScanQueueStatus(): ProviderQueueSnapshot {
  return providerQueue.snapshot();
}

function kbpsToMbps(kbps: string | number | null | undefined): number | null {
  if (!kbps) return null;
  const n = typeof kbps === "string" ? parseInt(kbps) : kbps;
  if (isNaN(n)) return null;
  return Math.round(n / 1000);
}

function speedTierFromMbps(mbps: number | null): string | null {
  if (!mbps) return null;
  if (mbps >= 2000) return "2gig";
  if (mbps >= 1000) return "1gig";
  if (mbps >= 500) return "500mbps";
  if (mbps >= 300) return "300mbps";
  if (mbps >= 100) return "100mbps";
  return "sub100mbps";
}

export async function scanAddress(
  address: string,
  city: string,
  state: string,
  zip: string,
): Promise<ScanResult> {
  return providerQueue.request(scanKey(address, city, state, zip), () =>
    scanAddressDirect(address, city, state, zip, false));
}

async function scanAddressDirect(
  address: string,
  city: string,
  state: string,
  zip: string,
  _retriedAfterAuth: boolean,
): Promise<ScanResult> {
  const base: ScanResult = {
    address, city, state, zip,
    lat: null, lng: null,
    fiberStatus: "unknown", isNewFiber: false, isTenured: false, fiberAvailable: false,
    maxDownloadKbps: null, maxDownloadMbps: null, speedTier: null,
    techType: null, chipSetType: null, placement: null, maxQual: null,
    competitorName: null, competitorSpeedMbps: null, competitorTech: null, inCompetitorArea: false,
    addressCatalogDate: null, householdSegmentType: null, billingStatus: null,
    exchangeId: null, dfAddressId: null, accessId: null,
    confidence: "LOW", apiSource: "failed", blocked: false, notes: "",
    leadTag: null, leadScore: 0,
  };

  try {
    const token = await getAuthToken();

    const res = await proxyFetch(KFS_SCAN_URL, {
      method: "POST",
      headers: providerHeaders({
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
        "Referer": KFS_REFERER,
        "Origin": KFS_ORIGIN,
      }),
      body: JSON.stringify({
        addressLine1: address,
        addressLine2: "",
        city,
        state,
        postalCode: zip,
      }),
      signal: AbortSignal.timeout(5000), // 7s per address — frees slot quickly on slow/blocked requests
    });

    // 403 = Kinetic's refilling token-bucket pushing back (VERIFIED live: NOT a
    // WAF/geo IP block). It is a typed back-pressure signal, never a no-service.
    // We do NOT rotate the IP (same account from many IPs = permanent token ban) and
    // do NOT blindly refresh here; the scheduler's congestion controller owns the
    // response — shrink the window, and refresh the session only when at the floor.
    if (!res.ok && res.status === 403) {
      base.notes = "Kinetic throttle (403) — rate-limited";
      base.apiSource = "failed";
      base.blocked = true;
      return base;
    }
    // On 401 — token expired mid-scan. Force refresh and retry EXACTLY once.
    // The _retriedAfterAuth guard caps this at a single refresh+retry: without it,
    // a revoked credential would recurse without bound, and each level makes two
    // proxy (Decodo) requests — unbounded spend.
    if (!res.ok && res.status === 401) {
      if (_retriedAfterAuth) {
        base.notes = `Auth still failing (401) after one token refresh`;
        base.apiSource = "failed";
        return base;
      }
      try {
        await refreshTokenFromApi();
        // Stay inside the queue slot. Calling the public queued wrapper here
        // would wait on this address's own in-flight promise and deadlock.
        return await scanAddressDirect(address, city, state, zip, true);
      } catch {
        base.notes = `Token refresh failed after 401`;
        base.apiSource = "failed";
        return base;
      }
    }
    if (!res.ok) {
      base.notes = `API returned ${res.status}`;
      base.apiSource = "failed";
      return base;
    }

    const data: KineticAddressResponse = await res.json();
    base.rawResponse = data;

    // CONCLUSIVE not-serviceable verdicts — Kinetic definitively says this address
    // is not in / not served by its fabric (not in the DB, out of territory, or
    // unserviceable). These are REAL no-service answers to record (so we never
    // re-scan them), NOT failures. Matched by a known family of validationResult
    // codes, e.g. AddressNotFound, AddressUnserviceableOutOfTerritory.
    const vr = String(data.validationResult ?? "");
    if (/addressnotfound|unserviceable|outofterritory|not\s*serviceable|no\s*service/i.test(vr)) {
      base.fiberStatus = "no_service";
      base.apiSource = "kinetic_live";
      base.confidence = "HIGH";
      base.notes = `Not serviceable: ${vr}`;
      return base;
    }
    // A soft `success:false` with an UNRECOGNIZED / error-shaped validationResult is
    // a genuine NON-ANSWER (provider hiccup / degraded / schema change), NOT a
    // confirmed "no service" — treating it as conclusive would let an outage flip
    // the pool unavailable and fabricate "newly live" flips the next healthy night.
    if (!data.success) {
      base.apiSource = "failed";
      base.confidence = "LOW";
      base.notes = `Non-conclusive response (success=false, ${vr || "no validationResult"})`;
      return base;
    }

    // Geocoords from address object
    if (data.address?.geoLat) {
      base.lat = parseFloat(data.address.geoLat);
      base.lng = parseFloat(data.address.geoLong);
    }

    // Use Kinetic's canonical address form (title-cased) as the address string.
    // Kinetic normalizes abbreviations (e.g. "Court" → "CT", "Drive" → "DR"),
    // so using their canonical form prevents dedup mismatches between scans.
    if (data.address?.addressLine1) {
      const kineticAddr = data.address.addressLine1.trim();
      // Title-case the Kinetic address (it comes back ALL-CAPS)
      base.address = kineticAddr
        .toLowerCase()
        .replace(/\b\w/g, (c: string) => c.toUpperCase());
      // Also adopt canonical city from Kinetic
      if (data.address.city) {
        base.city = data.address.city
          .toLowerCase()
          .replace(/\b\w/g, (c: string) => c.toUpperCase());
      }
    }

    // Core fields
    base.dfAddressId = data.dfAddressId ?? null;
    base.accessId = data.accessId ?? null;
    base.exchangeId = data.exchangeId ?? data.address?.exchangeId ?? null;
    base.techType = data.techType ?? data.address?.maxQualTechnologyType ?? null;
    base.maxQual = data.maxQual ?? null;
    base.apiSource = "kinetic_live";

    // Speed
    const kbps = data.broadbandService?.finalQualSpeed;
    base.maxDownloadKbps = kbps ? parseInt(kbps) : null;
    base.maxDownloadMbps = kbpsToMbps(kbps);
    base.speedTier = speedTierFromMbps(base.maxDownloadMbps);

    // Technology detail
    base.chipSetType = data.uqualProvisioningResult?.chipSetType ?? null;
    base.placement = data.uqualProvisioningResult?.finalPlacement ?? null;

    // Competitor intel
    if (data.address?.competitorCompanyName) {
      base.competitorName = data.address.competitorCompanyName;
      base.competitorSpeedMbps = data.address.competitorQualSpeed
        ? parseInt(data.address.competitorQualSpeed)
        : null;
      base.competitorTech = data.address.competitorTechName ?? null;
      base.inCompetitorArea = data.address.competitorSuppressionAreaFlag === "Y";
    }

    // Address history
    base.addressCatalogDate = data.address?.addressCatalogDt ?? null;
    base.billingStatus = data.address?.billingStatus ?? null;

    // THE KEY FIELD — household segment type
    const segment = data.address?.householdSegmentType ?? "";
    base.householdSegmentType = segment;

    // Fiber is a technology, not a speed: Kinetic's VDSL2/FTTN/G.fast bonded copper
    // reaches 300–500 Mbps, so the old `maxDownloadMbps >= 300` clause mislabelled
    // copper as fiber (bogus fiber leads). Gate on the real fiber signals only.
    const isFiber = isKineticFiber({
      techType: data.techType,
      maxQualTechnologyType: data.address?.maxQualTechnologyType,
      chipSetType: base.chipSetType,
    });

    base.fiberAvailable = isFiber;

    if (segment === "NEW FIBER") {
      base.fiberStatus = "new_fiber";
      base.isNewFiber = true;
      base.isTenured = false;
      base.confidence = "HIGH";
      base.notes = `New fiber deployment. ${data.address?.competitorCompanyName ? `Competitor: ${data.address.competitorCompanyName} (${data.address.competitorQualSpeed} Mbps ${data.address.competitorTechName}).` : ""} ${base.chipSetType === "FTTP" ? "FTTP confirmed." : ""}`.trim();
    } else if (segment === "TENURED") {
      base.fiberStatus = "tenured_fiber";
      base.isTenured = true;
      base.isNewFiber = false;
      base.confidence = "HIGH";
      // TENURED = fiber infrastructure has been at this address long-term.
      // The resident may OR may not currently be a Kinetic subscriber.
      // billingStatus "N" = no active account → non-subscriber with fiber available (prime target).
      // billingStatus "Y" = active account → already a customer (low priority).
      // dfAddressId on TENURED addresses is significantly lower (older record) than NEW FIBER.
      const hasBilling = data.address?.billingStatus === "Y";
      base.notes = hasBilling
        ? `TENURED — long-established fiber address, already a Kinetic subscriber. Tech: ${base.techType}. ${base.maxDownloadMbps} Mbps qualified.`
        : `TENURED — long-established fiber address, NOT a current subscriber. Prime upgrade target. Tech: ${base.techType}. ${base.maxDownloadMbps} Mbps qualified.`;
    } else if (isFiber) {
      base.fiberStatus = "existing_fiber";
      base.confidence = "HIGH";
      base.notes = `Fiber available. Segment: ${segment || "unknown"}.`;
    } else {
      base.fiberStatus = "copper";
      base.confidence = "HIGH";
      base.notes = `Legacy copper/DSL. Max qual: ${base.maxDownloadMbps} Mbps. Segment: ${segment}.`;
    }

    // Apply smart lead scoring
    const score = scoreLead({
      householdSegmentType: base.householdSegmentType,
      billingStatus: base.billingStatus,
      techType: base.techType,
      maxDownloadMbps: base.maxDownloadMbps,
      competitorName: base.competitorName,
      inCompetitorArea: base.inCompetitorArea,
      addressCatalogDate: base.addressCatalogDate,
    });
    base.leadTag = score.leadTag;
    base.leadScore = score.leadScore;

  } catch (err: any) {
    // PRODUCT LAW: a failed check (timeout/error/no-token) carries NO
    // availability signal. We do NOT fabricate a result — the previous code
    // invented `new_fiber` for any address in a hardcoded ZIP set, which turned
    // a network timeout into a fake lead. A non-answer is not a "yes" and not a
    // "no": return an explicit failure so the caller keeps the address in the
    // recheck queue and never records or counts it as availability data.
    base.apiSource = "failed";
    base.fiberStatus = "unknown";
    base.confidence = "LOW";
    base.notes = `Check failed — no signal: ${err.message}`;
  }

  return base;
}
