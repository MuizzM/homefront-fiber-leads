// Kinetic Fiber Scout — Real API Scanner
// Uses buy.gokinetic.com/api/v2/address/search (v2 — not rate-limited by Cloudflare WAF)
// Auth: credentials loaded from environment variables
import { proxyFetch } from "./proxy-fetch";
import { KFS_SCAN_URL, KFS_REFERER, KFS_ORIGIN } from "./kfs-config";
import { scoreLead } from "./lead-scoring";

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

/** Called from routes.ts when user pastes a JWT from their browser */
export function setManualToken(token: string) {
  manualToken = token;
  cachedToken = token;
  tokenExpiry = Date.now() + 28 * 60 * 1000; // assume 28 min life
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
  const kfsUrl = process.env.KFS_AUTH_URL ?? "";
  const kfsBasic = process.env.KFS_AUTH_BASIC ?? "";
  if (!kfsUrl || !kfsBasic) throw new Error("KFS_AUTH_URL or KFS_AUTH_BASIC not configured");

  const res = await proxyFetch(kfsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": kfsBasic,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "application/json",
    },
    body: JSON.stringify({ brazeDeviceId: "" }),
    signal: AbortSignal.timeout(5000), // 5s — faster slot recycling
  });

  if (!res.ok) throw new Error(`Auto-auth blocked (${res.status})`);
  const data = await res.json();
  if (!data.token) throw new Error("No token in response");

  cachedToken = data.token;
  // Manual token is now refreshed — update expiry
  manualToken = data.token;
  tokenExpiry = Date.now() + 28 * 60 * 1000;
  return cachedToken!;
}

/** Exported for use by CNS scanner and routes */
export async function getAuthToken(): Promise<string> {
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
  hasToken: boolean;
  expiresIn: number | null;
  source: string;
  keepaliveActive: boolean;
  refreshFailCount: number;
} {
  if (!cachedToken) return { hasToken: false, expiresIn: null, source: "none", keepaliveActive: false, refreshFailCount };
  const remaining = Math.round((tokenExpiry - Date.now()) / 1000);
  return {
    hasToken: true,
    expiresIn: remaining > 0 ? remaining : 0,
    source: manualToken ? "manual+keepalive" : "auto",
    keepaliveActive: autoRefreshTimer !== null,
    refreshFailCount,
  };
}

// Start keepalive on boot if credentials are present
if (process.env.KFS_AUTH_URL && process.env.KFS_AUTH_BASIC) {
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
  notes: string;
  rawResponse?: any;

  // Lead Scoring
  leadTag: string | null;
  leadScore: number;
}

// REFERENCE ONLY — real published FCC/Kinetic build periods for known ZIPs.
// These are NOT used to classify availability (that would be fabrication). They
// can seed a "known active build area" hint in market priority, never a result.
export const FCC_DEPLOYMENT_PERIODS: Record<string, string> = {
  "28138": "Q4 2025 — Rowan County CAB (507 locations, $2.1M)",
  "28072": "Q4 2025 — Rowan County CAB expansion",
  "28023": "Q4 2025 — Rowan County CAB",
  "28081": "Q4 2025 — Kannapolis expansion",
  "28083": "Q4 2025 — Kannapolis expansion",
  "28025": "Q4 2025 — Concord expansion",
  "28001": "Q4 2025 — Albemarle expansion",
};

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
  zip: string
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
    confidence: "LOW", apiSource: "failed", notes: "",
    leadTag: null, leadScore: 0,
  };

  try {
    const token = await getAuthToken();

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
      body: JSON.stringify({
        addressLine1: address,
        addressLine2: "",
        city,
        state,
        postalCode: zip,
      }),
      signal: AbortSignal.timeout(5000), // 7s per address — frees slot quickly on slow/blocked requests
    });

    // On 401/403 — token expired mid-scan. Force refresh and retry once automatically.
    if (!res.ok && (res.status === 401 || res.status === 403)) {
      try {
        await refreshTokenFromApi();
        return await scanAddress(address, city, state, zip); // retry with fresh token
      } catch {
        base.notes = `Token refresh failed after ${res.status}`;
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

    // Address not in Kinetic fabric
    if (!data.success || data.validationResult === "AddressNotFound") {
      base.fiberStatus = "no_service";
      base.apiSource = "kinetic_live";
      base.confidence = "HIGH";
      base.notes = "Address not found in Kinetic service fabric";
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

    const isFiber =
      data.techType === "FIBER" ||
      data.address?.maxQualTechnologyType === "FIBER" ||
      (base.maxDownloadMbps !== null && base.maxDownloadMbps >= 300);

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
