// Kinetic availability adapter. Live use is opt-in and requires a licensed API,
// partner integration, or written automation permission; credentials and the
// stable provider-issued identity are loaded only from environment variables.
import { proxyFetch } from "./proxy-fetch";
import { KFS_SCAN_URL, KFS_REFERER, KFS_ORIGIN } from "./kfs-config";
import { scoreLead } from "./lead-scoring";
import { isKineticFiber } from "@shared/fiberDetect";
import {
  ProviderRequestQueue,
  type ProviderQueueSnapshot,
  type ProviderRequestPriority,
  type QueueEvent,
} from "./providerRequestQueue";
import { structuredLog } from "./structuredLog";
import crypto from "node:crypto";
import { AuthorizedTokenPool, type AuthorizedTokenLease } from "./authorizedTokenPool";
import { DistributedProviderCoordinator, type DistributedProviderSnapshot } from "./distributedProviderCoordinator";

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

const configuredTokenPoolSize = Number(process.env.KFS_TOKEN_POOL_MAX ?? 300);
const configuredWarmTokens = Number(process.env.KFS_TOKEN_POOL_WARM_MIN ?? 2);

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

const TOKEN_REFRESH_MARGIN_MS = 60_000;

// Decode a JWT's `exp` claim → ms epoch so token life is derived rather than
// guessed. The caller applies the refresh margin separately.
function jwtExpiryMs(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch { return null; }
}

export function kineticTokenUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.KFS_AUTH_URL?.trim() || `${KFS_ORIGIN}/_internal/precisely/token`;
}

export function kineticTokenRequestInit(signal?: AbortSignal): RequestInit {
  return {
    method: "GET",
    headers: providerHeaders({
      "Accept": "*/*",
      "Origin": KFS_ORIGIN,
      "Referer": KFS_REFERER,
    }),
    signal,
  };
}

export function parseKineticTokenPayload(
  payload: unknown,
  now = Date.now(),
): { token: string; expiresAt: number } {
  if (!payload || typeof payload !== "object")
    throw new Error("Invalid token response");
  const data = payload as Record<string, unknown>;
  const token = typeof data.access_token === "string" ? data.access_token.trim() : "";
  const expiresIn = Number(data.expires_in);
  if (!token) throw new Error("No access_token in response");
  if (!Number.isFinite(expiresIn) || expiresIn <= 0)
    throw new Error("Invalid expires_in in token response");
  const responseExpiry = now + Math.floor(expiresIn * 1000);
  const jwtExpiry = jwtExpiryMs(token);
  const expiresAt = jwtExpiry ? Math.min(jwtExpiry, responseExpiry) : responseExpiry;
  if (expiresAt <= now + TOKEN_REFRESH_MARGIN_MS)
    throw new Error("Token response expires too soon");
  return { token, expiresAt };
}

async function mintAuthorizedToken(): Promise<{ token: string; expiresAt: number }> {
  assertAutomationAuthorized();
  const response = await proxyFetch(
    kineticTokenUrl(),
    kineticTokenRequestInit(AbortSignal.timeout(5_000)),
  );
  if (!response.ok) throw new Error(`Auto-auth blocked (${response.status})`);
  return parseKineticTokenPayload(await response.json());
}

const authorizedTokenPool = new AuthorizedTokenPool({
  maxSize: Number.isFinite(configuredTokenPoolSize) ? configuredTokenPoolSize : 300,
  warmMinimum: Number.isFinite(configuredWarmTokens) ? configuredWarmTokens : 2,
  refreshMarginMs: TOKEN_REFRESH_MARGIN_MS,
  maintenanceIntervalMs: Number(process.env.KFS_TOKEN_MAINTENANCE_MS ?? 15_000),
  maxLeasesPerToken: Number(process.env.KFS_TOKEN_MAX_LEASES_PER_SLOT ?? 10),
  maxConcurrentRefreshes: Number(process.env.KFS_TOKEN_REFRESH_CONCURRENCY ?? 2),
  mint: () => mintAuthorizedToken(),
});

/** Called from routes.ts when user pastes a JWT from their browser */
export function setManualToken(token: string) {
  authorizedTokenPool.install(token, jwtExpiryMs(token) ?? Date.now() + 28 * 60 * 1000);
  providerQueue.resume();
}

export async function refreshTokenFromApi(): Promise<string> {
  const beforeRefresh = authorizedTokenPool.snapshot();
  if (beforeRefresh.disabled) authorizedTokenPool.resume();
  const lease = await authorizedTokenPool.lease();
  try {
    // lease() already minted a fresh token when the pool was empty or disabled.
    // Avoid immediately replacing that token during explicit administrator recovery.
    if (beforeRefresh.disabled || beforeRefresh.ready === 0) return lease.token;
    return await authorizedTokenPool.refreshLease(lease);
  }
  finally { lease.release(); }
}

/** Shared token accessor for authorized server-side scanner routes. */
export async function getAuthToken(): Promise<string> {
  assertAutomationAuthorized();
  const lease = await authorizedTokenPool.lease();
  try { return lease.token; }
  finally { lease.release(); }
}

export function getTokenStatus(): {
  automationAuthorized: boolean;
  hasToken: boolean;
  expiresIn: number | null;
  source: string;
  keepaliveActive: boolean;
  refreshFailCount: number;
  configuredSessions: number;
  readySessions: number;
  pool: ReturnType<AuthorizedTokenPool["snapshot"]>;
} {
  const automationAuthorized = process.env.KFS_AUTOMATION_AUTHORIZED === "true";
  const pool = authorizedTokenPool.snapshot();
  if (pool.ready === 0) return {
    automationAuthorized, hasToken: false, expiresIn: null, source: "none",
    keepaliveActive: automationAuthorized && !pool.disabled, refreshFailCount: pool.states.COOLDOWN,
    configuredSessions: pool.maxSize, readySessions: pool.ready, pool,
  };
  const remaining = pool.nextExpiryAt == null ? null : Math.max(0, Math.round((pool.nextExpiryAt - Date.now()) / 1000));
  return {
    automationAuthorized,
    hasToken: true,
    expiresIn: remaining == null ? null : remaining > 0 ? remaining : 0,
    source: "authorized_pool",
    keepaliveActive: automationAuthorized && !pool.disabled,
    refreshFailCount: pool.states.COOLDOWN,
    configuredSessions: pool.maxSize,
    readySessions: pool.ready,
    pool,
  };
}

// Start keepalive on boot if credentials are present
if (process.env.KFS_AUTOMATION_AUTHORIZED === "true") {
  authorizedTokenPool.start();
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

const configuredProviderConcurrency = Number(process.env.SCAN_PROVIDER_CONCURRENCY ?? 50);
const configuredGlobalConcurrency = Number(process.env.SCAN_GLOBAL_CONCURRENCY ?? 50);
const configuredProviderRpm = Number(process.env.SCAN_PROVIDER_REQUESTS_PER_MINUTE ?? 100);
const configuredCacheTtlMs = Number(process.env.SCAN_RESULT_CACHE_MS ?? 5 * 60_000);

const addressTokenAliases: Record<string, string> = {
  STREET: "ST", ST: "ST", ROAD: "RD", RD: "RD", AVENUE: "AVE", AVE: "AVE",
  DRIVE: "DR", DR: "DR", COURT: "CT", CT: "CT", LANE: "LN", LN: "LN",
  BOULEVARD: "BLVD", BLVD: "BLVD", HIGHWAY: "HWY", HWY: "HWY",
  NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W",
};

function canonicalAddressPart(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9#]+/g, " ").trim().split(/\s+/)
    .filter(Boolean).map(token => addressTokenAliases[token] ?? token).join(" ");
}

export function normalizeKineticAddressKey(address: string, city: string, state: string, zip: string): string {
  return [canonicalAddressPart(address), canonicalAddressPart(city), canonicalAddressPart(state), String(zip).match(/\d{5}/)?.[0] ?? ""]
    .join("|");
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
    source: event.source,
    retryAt: "retryAt" in event ? event.retryAt : undefined,
  }, event.type === "failed" ? "warn" : event.type === "queued" ? "debug" : "info");
}

const providerQueue = new ProviderRequestQueue<ScanResult>({
  maxConcurrency: Number.isFinite(configuredProviderConcurrency) ? configuredProviderConcurrency : 50,
  // The DB-backed coordinator below is the sole aggregate rate authority. This
  // process-local queue only bounds waiters, prioritizes work and coalesces
  // duplicate calls before they reach the shared database queue.
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

const distributedProviderCoordinator = new DistributedProviderCoordinator<ScanResult>({
  maxConcurrency: Number.isFinite(configuredGlobalConcurrency) ? configuredGlobalConcurrency : 50,
  maxRequestsPerMinute: Number.isFinite(configuredProviderRpm) ? configuredProviderRpm : 100,
  resultCacheTtlMs: Number.isFinite(configuredCacheTtlMs) ? configuredCacheTtlMs : 5 * 60_000,
});

export function getAddressScanQueueStatus(): ProviderQueueSnapshot & {
  maxRequestsPerMinute: number;
  startsLastMinute: number;
  distributed: DistributedProviderSnapshot;
} {
  const local = providerQueue.snapshot();
  const distributed = distributedProviderCoordinator.snapshot();
  return {
    ...local,
    active: distributed.active,
    queued: Math.max(distributed.queued, local.queued),
    maxConcurrency: distributed.maxConcurrency,
    maxRequestsPerSecond: null,
    startsLastSecond: 0,
    maxRequestsPerMinute: distributed.maxRequestsPerMinute,
    startsLastMinute: distributed.startsLastMinute,
    pausedUntil: distributed.pausedUntil,
    halted: distributed.halted || local.halted,
    haltReason: distributed.haltReason ?? local.haltReason,
    distributed,
  };
}

/** Explicit operator recovery after investigating an upstream 403. */
export function resumeAddressScanQueue(): void {
  authorizedTokenPool.resume();
  providerQueue.resume();
  distributedProviderCoordinator.resume();
}

export class ProviderAccessDeniedError extends Error {
  readonly code = "KINETIC_ACCESS_DENIED";
  constructor(message = "Kinetic address search returned 403; all provider work has been stopped.") {
    super(message);
    this.name = "ProviderAccessDeniedError";
  }
}

export interface AddressScanOptions {
  source?: ProviderRequestPriority;
}

function retryAfterMs(response: Response, attempt: number): number {
  const value = response.headers.get("retry-after")?.trim();
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(15 * 60_000, Math.max(0, Math.ceil(seconds * 1_000)));
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(15 * 60_000, Math.max(0, date - Date.now()));
  }
  return Math.min(30_000, 1_000 * Math.pow(2, Math.min(attempt, 5)));
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)));

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
  options: AddressScanOptions = {},
): Promise<ScanResult> {
  const source = options.source ?? "market";
  const normalizedKey = normalizeKineticAddressKey(address, city, state, zip);
  const distributedKey = crypto.createHash("sha256").update(normalizedKey).digest("hex");
  return providerQueue.request(normalizedKey, () => distributedProviderCoordinator.execute(
    distributedKey,
    source,
    () => scanAddressDirect(address, city, state, zip, source),
    {
      cacheable: value => value.apiSource !== "failed" && !value.blocked && value.fiberStatus !== "unknown",
      serialize: value => JSON.stringify(value),
      deserialize: value => JSON.parse(value) as ScanResult,
    },
  ), { source });
}

async function scanAddressDirect(
  address: string,
  city: string,
  state: string,
  zip: string,
  source: ProviderRequestPriority,
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

  let tokenLease: AuthorizedTokenLease | null = null;
  try {
    tokenLease = await authorizedTokenPool.lease();
    let authRefreshes = 0;
    let rateLimitAttempts = 0;
    let res: Response;
    for (;;) {
      const token = tokenLease.token;
      res = await proxyFetch(KFS_SCAN_URL, {
        method: "POST",
        headers: providerHeaders({
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": `Bearer ${token}`,
          "Referer": KFS_REFERER,
          "Origin": KFS_ORIGIN,
        }),
        body: JSON.stringify({ addressLine1: address, addressLine2: "", city, state, postalCode: zip }),
        signal: AbortSignal.timeout(5_000),
      });

      if (res.status === 401) {
        if (authRefreshes >= 3) {
          base.notes = "Auth still failing (401) after three token refreshes";
          return base;
        }
        authRefreshes++;
        try {
          const refreshed = await authorizedTokenPool.refreshLease(tokenLease);
          tokenLease = { ...tokenLease, token: refreshed };
        }
        catch { base.notes = `Token refresh ${authRefreshes}/3 failed after 401`; return base; }
        continue;
      }
      if (res.status === 403) {
        const denied = new ProviderAccessDeniedError();
        structuredLog("scan.provider.access_denied", {
          status: 403, source, active: providerQueue.snapshot().active,
          queued: providerQueue.snapshot().queued,
        }, "error");
        providerQueue.halt(denied, source);
        distributedProviderCoordinator.halt(denied.message);
        authorizedTokenPool.disable();
        const alertHook = (globalThis as any).__alertProviderAccessDenied;
        if (typeof alertHook === "function") void Promise.resolve(alertHook({ provider: "kinetic", status: 403 })).catch(() => {});
        throw denied;
      }
      if (res.status === 429) {
        const waitMs = retryAfterMs(res, rateLimitAttempts++);
        providerQueue.pauseFor(waitMs, source);
        distributedProviderCoordinator.pauseFor(waitMs);
        structuredLog("scan.provider.rate_limited", { source, waitMs, attempt: rateLimitAttempts }, "warn");
        await delay(waitMs);
        continue;
      }
      break;
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
    if (err instanceof ProviderAccessDeniedError) throw err;
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
  } finally {
    tokenLease?.release();
  }

  return base;
}
