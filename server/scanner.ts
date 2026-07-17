// Kinetic availability adapter. Live use is opt-in and requires a licensed API,
// partner integration, or written automation permission; credentials and the
// stable provider-issued identity are loaded only from environment variables.
import { proxyFetch, rotateProxySession, getProxySessionId } from "./proxy-fetch";
import { emitStage, type ScanStage } from "./scanStageBus";
import { KFS_SCAN_URL, KFS_REFERER, KFS_ORIGIN } from "./kfs-config";
import { scoreLead } from "./lead-scoring";
import { parseKineticResponse, selectReliableAddressSuggestion } from "./kineticResponseParser";
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

const configuredTokenPoolSize = Number(process.env.KFS_TOKEN_POOL_MAX ?? 200);
// Keep enough authorized Decodo sessions warm to cover the full concurrent
// workload (≈maxConcurrency 200 ÷ maxLeasesPerToken 10 = 20, plus headroom so a
// burst never waits on a mint). Unlimited Decodo budget → mint generously; token
// scarcity must never stall a priority check.
const configuredWarmTokens = Number(process.env.KFS_TOKEN_POOL_WARM_MIN ?? 25);

const DEFAULT_AUTOMATION_USER_AGENT = "HomeFrontFiber-AvailabilityMonitor/1.0 (operations@homefrontsolutions.com)";


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

// A message that signals an AUTHENTICATED denial (401/403) — the retriable case
// where a fresh authorized Decodo session (new residential IP) is the remedy.
function isAuthDenialMessage(message: string): boolean {
  return /\b(401|403)\b/.test(message);
}

// One mint attempt over the authorized Decodo transport. The gokinetic token
// endpoint is a POST that authenticates with the client Basic credential
// (KFS_AUTH_BASIC, which already carries its "Basic " prefix) and a braze device
// body, and returns { token } (a JWT). Some other token services return
// { access_token, expires_in } — handle both. A non-2xx (403 IP throttle, 429,
// 5xx) or a non-JSON body (bot-challenge interstitial) throws so the caller can
// rotate the Decodo session and retry.
async function mintViaDecodo(): Promise<{ token: string; expiresAt: number }> {
  const basic = process.env.KFS_AUTH_BASIC?.trim();
  const response = await proxyFetch(kineticTokenUrl(), {
    method: "POST",
    headers: providerHeaders({
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(basic ? { "Authorization": basic } : {}),
      "Origin": KFS_ORIGIN,
      "Referer": KFS_REFERER,
    }),
    body: JSON.stringify({ brazeDeviceId: "" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Auto-auth blocked (${response.status} via decodo)`);
  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error("Auto-auth non-JSON body (challenge via decodo)");
  }
  const token = typeof data.token === "string" ? data.token.trim()
    : typeof data.access_token === "string" ? data.access_token.trim() : "";
  if (!token) throw new Error("No token in mint response (via decodo)");
  const now = Date.now();
  const expiresIn = Number(data.expires_in);
  const expiresAt = jwtExpiryMs(token)
    ?? (Number.isFinite(expiresIn) && expiresIn > 0 ? now + Math.floor(expiresIn * 1000) : now + 28 * 60 * 1000);
  if (expiresAt <= now + TOKEN_REFRESH_MARGIN_MS) throw new Error("Minted token expires too soon (via decodo)");
  return { token, expiresAt };
}

async function mintAuthorizedToken(): Promise<{ token: string; expiresAt: number }> {
  // DECODO-EXCLUSIVE MINT. The token is minted ONLY through the authorized Decodo
  // residential proxy — the server's own IP is never used. Root cause of the
  // production stall ("8 found · 0 checked · 8 pending"): the long-lived undici
  // dispatcher kept its keep-alive connections pinned to a couple of Decodo egress
  // IPs; under continuous mint load those IPs hit Kinetic's rolling-window rate
  // limit → 403 forever, and a 403 HTTP *response* (not a socket error) never
  // rebuilt the dispatcher. Verified in prod: a freshly-built dispatcher gets a new
  // residential IP and returns 201. So on an authenticated denial we rotate the
  // Decodo SESSION (fresh IP) and retry once. If Decodo itself is unavailable the
  // request fails closed (proxyFetch throws) and the address stays PENDING_AUTH.
  try {
    return await mintViaDecodo();
  } catch (err) {
    const message = String((err as any)?.message ?? err);
    structuredLog("scan.token.mint_failed", { transport: "decodo", error: message.slice(0, 120) }, "warn");
    if (isAuthDenialMessage(message)) {
      // Fresh authorized Decodo session (new residential IP), then retry once.
      await rotateProxySession(`mint ${message.match(/\d{3}/)?.[0] ?? "auth"}`);
      return await mintViaDecodo();
    }
    throw err; // fail closed (Decodo down / transient) — pool self-heals next tick
  }
}

// ── Global mint gate — collapse the stampede ──────────────────────────────────
// On boot the auto-started statewide sweep leases tokens en masse; with no pacing
// the pool fired ~1.7k mint attempts in seconds, DDoSing BOTH egresses (direct →
// Cloudflare 429, proxy → rolling-window 403) so neither could ever succeed — a
// self-reinforcing deadlock. This gate serializes every mint through one chain
// with a minimum spacing, so the egresses see at most one gentle mint at a time.
// The first success populates a READY slot; concurrent leasers then take that token
// via pickReady instead of minting, so the queue drains without a flood. This is
// pacing, NOT a disabled/halted state — the pool still self-heals on the next tick.
// The chain still SERIALIZES mints (no duplicate concurrent mint requests — that
// guard prevents a stampede deadlock), but the spacing is now minimal: unlimited
// Decodo budget means a fresh residential IP is always available for the next mint.
const MINT_MIN_INTERVAL_MS = process.env.VITEST
  ? 0 // unit/integration tests never pace mints (real timers would slow the suite)
  : Math.max(0, Number(process.env.KFS_MINT_MIN_INTERVAL_MS ?? 100));
let mintChain: Promise<unknown> = Promise.resolve();
let lastMintAt = 0;
function gatedMint(): Promise<{ token: string; expiresAt: number }> {
  const run = mintChain.then(async () => {
    const wait = Math.max(0, lastMintAt + MINT_MIN_INTERVAL_MS - Date.now());
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    try { return await mintAuthorizedToken(); }
    finally { lastMintAt = Date.now(); }
  });
  // Keep the chain alive across failures without unhandled rejections.
  mintChain = run.then(() => undefined, () => undefined);
  return run;
}

const authorizedTokenPool = new AuthorizedTokenPool({
  maxSize: Number.isFinite(configuredTokenPoolSize) ? configuredTokenPoolSize : 100,
  warmMinimum: Number.isFinite(configuredWarmTokens) ? configuredWarmTokens : 2,
  refreshMarginMs: TOKEN_REFRESH_MARGIN_MS,
  maintenanceIntervalMs: Number(process.env.KFS_TOKEN_MAINTENANCE_MS ?? 10_000),
  maxLeasesPerToken: Number(process.env.KFS_TOKEN_MAX_LEASES_PER_SLOT ?? 25),
  // The global gate still serializes individual mint requests, but several slots
  // may refresh concurrently so a large warm pool never waits on one mint stream.
  maxConcurrentRefreshes: Number(process.env.KFS_TOKEN_REFRESH_CONCURRENCY ?? 4),
  // Unlimited budget → a token serves many more checks before being retired.
  maxChecksPerToken: Number(process.env.KFS_TOKEN_MAX_CHECKS ?? 1_000),
  mint: () => gatedMint(),
});

/** Test-only: reset the module-level mint-gate state so unit tests don't leak
 * pacing state between cases. No effect in prod use. */
export function __resetTokenTransportStateForTests(): void {
  lastMintAt = 0;
  mintChain = Promise.resolve();
}

/** Called from routes.ts when user pastes a JWT from their browser */
export function setManualToken(token: string) {
  authorizedTokenPool.install(token, jwtExpiryMs(token) ?? Date.now() + 28 * 60 * 1000);
  providerQueue.resume();
}

/** Mint/lease a fresh Braze token. Called at the start of every scan run. */
export async function refreshTokenFromApi(): Promise<string> {
  const beforeRefresh = authorizedTokenPool.snapshot();
  const lease = await authorizedTokenPool.lease();
  try {
    // lease() already minted a fresh token when the pool was empty. Avoid
    // immediately replacing a just-minted token.
    if (beforeRefresh.ready === 0) return lease.token;
    return await authorizedTokenPool.refreshLease(lease);
  }
  finally { lease.release(); }
}

/** Drop a token the caller saw fail against the provider so it is never reused.
 * The slot returns to EMPTY and is re-minted on the next lease. */
export function invalidateAuthorizedToken(token: string | null | undefined): void {
  authorizedTokenPool.invalidate(token);
}

/** Shared token accessor for authorized server-side scanner routes. */
export async function getAuthToken(): Promise<string> {
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
    keepaliveActive: automationAuthorized, refreshFailCount: pool.unhealthy,
    configuredSessions: pool.maxSize, readySessions: pool.ready, pool,
  };
  const remaining = pool.nextExpiryAt == null ? null : Math.max(0, Math.round((pool.nextExpiryAt - Date.now()) / 1000));
  return {
    automationAuthorized,
    hasToken: true,
    expiresIn: remaining == null ? null : remaining > 0 ? remaining : 0,
    source: "authorized_pool",
    keepaliveActive: automationAuthorized,
    refreshFailCount: pool.unhealthy,
    configuredSessions: pool.maxSize,
    readySessions: pool.ready,
    pool,
  };
}

// Warm the token pool on boot so scans start with a ready token.
authorizedTokenPool.start();

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
  serviceKey: string | null; // miror.svcKey from the nested provisioning payload

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

// Unlimited Decodo budget → run wide open by default. Decodo session rotation
// (proactive + reactive-on-403) is what absorbs upstream throttle pressure, not
// static rate caps. Every value remains env-tunable for an emergency dial-down.
const configuredProviderConcurrency = Number(process.env.SCAN_PROVIDER_CONCURRENCY ?? 100);
const configuredGlobalConcurrency = Number(process.env.SCAN_GLOBAL_CONCURRENCY ?? 100);
const configuredProviderRpm = Number(process.env.SCAN_PROVIDER_REQUESTS_PER_MINUTE ?? 30_000);
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
  // Slots + per-window rate held for CRITICAL (new-build / field / manual / admin)
  // so the bulk statewide sweep can never starve immediate checks.
  criticalReservedConcurrency: Number(process.env.PROVIDER_CRITICAL_RESERVED ?? 3),
  criticalReservedRate: Number(process.env.PROVIDER_CRITICAL_RESERVED_RATE ?? 2),
  // Bounded admission wait + aging so a sustained CRITICAL flood (e.g. many
  // lead-expansion runs) can never deadlock or permanently starve NORMAL work.
  admissionMaxWaitMs: Number(process.env.PROVIDER_ADMISSION_MAX_WAIT_MS ?? 120_000),
  agingRatePerSec: Number(process.env.PROVIDER_ADMISSION_AGING_PER_SEC ?? 4),
  agingMaxBoost: Number(process.env.PROVIDER_ADMISSION_AGING_MAX_BOOST ?? 15),
  // Weighted-fair caps: EXPANSION and MAINTENANCE (statewide/stale bulk) may each hold
  // at most this fraction of concurrency. Their combined headroom is the guaranteed
  // reserve for the revenue classes (IMMEDIATE/NEW_BUILD/DISCOVERY) — a burst of
  // expansion OR a 300k maintenance backlog can never occupy every slot.
  // Share caps default to 0 (UNCAPPED): with an unlimited Decodo budget there is
  // no spend to ration, and priority ordering + aging alone govern admission. Set
  // the env vars to re-introduce fairness caps if upstream pressure ever returns.
  expansionShareFraction: Number(process.env.PROVIDER_EXPANSION_SHARE ?? 0),
  maintenanceShareFraction: Number(process.env.PROVIDER_MAINTENANCE_SHARE ?? 0),
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
    distributed,
  };
}

// ── Scan Inspector controls ───────────────────────────────────────────────────
// Pause/resume act on the shared provider admission queue, so they gate ALL scan
// sources (statewide sweep, field map, manual) at once. Pause is a long, explicit
// hold the admin clears with Resume — distinct from the coordinator's short
// Retry-After pacing pauses.
let _inspectorPaused = false;
const PAUSE_MS = 24 * 60 * 60 * 1000; // effectively "until Resume"
export function pauseScanning(): void {
  _inspectorPaused = true;
  providerQueue.pauseFor(PAUSE_MS, "manual");
}
export function resumeScanning(): void {
  _inspectorPaused = false;
  providerQueue.resume();
}
export function isScanningPaused(): boolean {
  return _inspectorPaused;
}

// A transient upstream access-denial (403). It is NOT a halt: the scan worker's
// AIMD controller treats a `blocked` result as back-pressure (shrinks the window,
// refreshes the session, paces), and the address is left pending for retry. No
// queue/coordinator/pool is ever disabled and nothing is persisted.
export class ProviderAccessDeniedError extends Error {
  readonly code = "KINETIC_ACCESS_DENIED";
  constructor(message = "Kinetic address search returned 403 (transient throttle).") {
    super(message);
    this.name = "ProviderAccessDeniedError";
  }
}

export interface AddressScanOptions {
  source?: ProviderRequestPriority;
  /** Polled while awaiting coordinator admission — abandon promptly if it returns true. */
  abort?: () => boolean;
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

// Mask an applied-correction address for Scan Inspector telemetry: redact the
// precise house number (a resident's exact door) while keeping the street +
// locality so the correction stays observable to an admin.
function maskSuggestedAddress(address: string, city: string, state: string, zip: string): string {
  const street = address.replace(/^\s*\d+\s*/, "").trim() || address.trim();
  const zip5 = String(zip).match(/\d{5}/)?.[0] ?? "";
  return `#•• ${street}, ${city}, ${state} ${zip5}`.replace(/\s+/g, " ").trim();
}

export interface LiveTestStage { stage: string; ok: boolean; detail: string; data?: Record<string, unknown>; }
export interface LiveTestResult {
  input: { address: string; city: string; state: string; zip: string };
  stages: LiveTestStage[];
  checked: boolean;
  // "pending_auth" = the mint/token flow failed (403/401/mint error); the address
  // is intentionally left un-checked and un-classified so a later run retries it.
  // It is NEVER "no_service" — an auth failure is not a service verdict.
  classification: string;
  wouldSaveLead: boolean;
  pendingAuth: boolean;
}

// Mint through the approved token flow, dropping any stale token first so a retry
// never reuses a token the provider just rejected. Single-flight + bounded refresh
// concurrency inside the pool guarantee this issues no duplicate mint requests.
async function mintThroughApprovedFlow(invalidateFirst?: string): Promise<string> {
  if (invalidateFirst) invalidateAuthorizedToken(invalidateFirst);
  return refreshTokenFromApi();
}

// A `blocked` ScanResult is an AUTH block (401/403 — retry after re-mint) rather
// than a plain throttle (429/5xx) when scanAddressDirect tagged it token/session.
function isAuthBlock(result: ScanResult): boolean {
  const notes = String(result.notes ?? "");
  return /token\/session/i.test(notes) || /\b(401|403)\b/.test(notes);
}

// Diagnostic — runs ONE address through the SAME shared check path the Field Map,
// city, and nightly scans use (scanAddressDirect), after minting a fresh Braze
// token. There is no separate Live Test code path: the classification you see here
// is exactly what a scan would record. Sanitized — the bearer token and proxy
// password are NEVER emitted, only the token length. Powers the Live Test panel.
export async function liveTestAddress(
  address: string, city: string, state: string, zip: string,
): Promise<LiveTestResult> {
  const stages: LiveTestStage[] = [];
  const out: LiveTestResult = { input: { address, city, state, zip }, stages, checked: false, classification: "unresolved", wouldSaveLead: false, pendingAuth: false };

  const markPendingAuth = (why: string) => {
    out.checked = false;
    out.classification = "pending_auth";
    out.pendingAuth = true;
    out.wouldSaveLead = false;
    stages.push({ stage: "Classification", ok: false, detail: `PENDING_AUTH — ${why}; address kept for retry, NOT a no-service verdict` });
    return out;
  };

  stages.push({ stage: "OSM found", ok: true, detail: `${address}, ${city}, ${state} ${zip}` });
  stages.push({ stage: "Normalized address", ok: true, detail: normalizeKineticAddressKey(address, city, state, zip) });

  // Fresh Braze token via the approved flow (minted through the authorized Decodo
  // transport — never direct). On failure, invalidate stale state and retry ONCE — no
  // duplicate requests (the pool single-flights the mint). If it still fails the
  // address stays PENDING_AUTH and is never classified as no-service.
  try {
    const token = await mintThroughApprovedFlow();
    stages.push({ stage: "Token minted", ok: true, detail: `fresh token · ${token.length} chars` });
  } catch (firstErr: any) {
    stages.push({ stage: "Token minted", ok: false, detail: `mint failed (${String(firstErr?.message ?? firstErr)}) — invalidating stale state, retrying once` });
    try {
      const token = await mintThroughApprovedFlow();
      stages.push({ stage: "Token minted (retry)", ok: true, detail: `fresh token · ${token.length} chars` });
    } catch (retryErr: any) {
      stages.push({ stage: "Token minted (retry)", ok: false, detail: `AUTH FAILED: ${String(retryErr?.message ?? retryErr)}` });
      return markPendingAuth("token mint returned auth failure after one retry");
    }
  }

  stages.push({ stage: "Kinetic search called", ok: true, detail: `POST ${KFS_SCAN_URL}`, data: { request: { addressLine1: address, addressLine2: "", city, state, postalCode: zip }, authorization: "Bearer <redacted>" } });

  // THE one shared check path — same code the field/city/nightly workers run.
  // scanAddressDirect invalidates the leased token on a 401/403 and returns a
  // `blocked` result. When that is an AUTH block, remint through the approved flow
  // (which stores a fresh token in the pool) and immediately retry the SAME address
  // ONCE before giving up — never a duplicate concurrent request.
  let result = await scanAddressDirect(address, city, state, zip, "manual");
  if (result.blocked && isAuthBlock(result)) {
    stages.push({ stage: "Auth retry", ok: true, detail: "Search returned 401/403 — token invalidated, reminting and retrying same address once" });
    try {
      const token = await mintThroughApprovedFlow();
      stages.push({ stage: "Token re-minted", ok: true, detail: `fresh token · ${token.length} chars` });
    } catch (e: any) {
      stages.push({ stage: "Token re-minted", ok: false, detail: `AUTH FAILED: ${String(e?.message ?? e)}` });
      return markPendingAuth("re-mint after Search auth block failed");
    }
    result = await scanAddressDirect(address, city, state, zip, "manual");
  }

  const httpOk = result.apiSource === "kinetic_live";
  stages.push({
    stage: "HTTP result", ok: httpOk,
    detail: httpOk ? "HTTP 200 OK"
      : result.blocked ? "throttled/auth-blocked (401/403/429) — transient, address kept pending for retry"
      : `no conclusive answer — ${result.notes || "infra error"} (NOT a no-service verdict)`,
  });

  if (!httpOk) {
    stages.push({ stage: "Response", ok: false, detail: result.notes || "non-conclusive response" });
    // An auth/throttle block is PENDING_AUTH (retriable), not a service verdict.
    if (result.blocked && isAuthBlock(result)) return markPendingAuth("Search API kept returning 401/403 after retry");
    stages.push({ stage: "Classification", ok: false, detail: `unresolved (infra) — ${result.blocked ? "throttled" : "error"}; NOT a no-service verdict` });
    return out;
  }

  stages.push({
    stage: "Response", ok: true, detail: "parsed",
    data: { fiberStatus: result.fiberStatus, techType: result.techType, householdSegmentType: result.householdSegmentType, billingStatus: result.billingStatus, dfAddressId: result.dfAddressId },
  });

  out.checked = true;
  const isFiber = result.fiberAvailable;
  const billing = String(result.billingStatus ?? "").toUpperCase();
  // Matches applyCheck's lead gate exactly: NEW FIBER + no active billing + fiber.
  const isTarget = result.isNewFiber && billing === "N" && isFiber;
  const classification = result.fiberStatus === "no_service" || !isFiber ? "no_service"
    : isTarget ? "fresh_fiber"
    : billing === "Y" && result.isNewFiber ? "coming_soon"
    : "service_active";
  out.classification = classification;
  out.wouldSaveLead = isTarget;
  stages.push({ stage: "Classification", ok: true, detail: `${classification} · fiber=${isFiber} · segment=${result.householdSegmentType || "?"} · billing=${billing || "?"}` });
  stages.push({ stage: "Lead saved", ok: out.wouldSaveLead, detail: out.wouldSaveLead ? "YES — fresh fiber, no active billing" : `no — ${classification}` });
  return out;
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
  // Inspector: the address has entered the active check queue (awaiting admission
  // through the coordinator, then token mint). scanAddressDirect emits the rest.
  emitStage({ addressKey: normalizedKey, address, city, state, zip, runId: null, source: String(source), stage: "queued", status: "info", attempt: 1, tsEpoch: Date.now() });
  return providerQueue.request(normalizedKey, () => distributedProviderCoordinator.execute(
    distributedKey,
    source,
    () => scanAddressDirect(address, city, state, zip, source),
    {
      cacheable: value => value.apiSource !== "failed" && !value.blocked && value.fiberStatus !== "unknown",
      serialize: value => JSON.stringify(value),
      deserialize: value => JSON.parse(value) as ScanResult,
      abort: options.abort,
    },
  ), { source });
}

async function scanAddressDirect(
  address: string,
  city: string,
  state: string,
  zip: string,
  source: ProviderRequestPriority,
  // Bounds the AddressNeedsFix/AddressSuggestions correction to ONE retry per
  // check: the correction re-enters this same function with depth+1, and the
  // correction block below only fires at depth 0 — so a correction can never
  // trigger another correction (no correction loops).
  correctionDepth = 0,
): Promise<ScanResult> {
  const base: ScanResult = {
    address, city, state, zip,
    lat: null, lng: null,
    fiberStatus: "unknown", isNewFiber: false, isTenured: false, fiberAvailable: false,
    maxDownloadKbps: null, maxDownloadMbps: null, speedTier: null,
    techType: null, chipSetType: null, placement: null, maxQual: null,
    competitorName: null, competitorSpeedMbps: null, competitorTech: null, inCompetitorArea: false,
    addressCatalogDate: null, householdSegmentType: null, billingStatus: null,
    exchangeId: null, dfAddressId: null, accessId: null, serviceKey: null,
    confidence: "LOW", apiSource: "failed", blocked: false, notes: "",
    leadTag: null, leadScore: 0,
  };

  // ── Scan Inspector telemetry — emit each pipeline stage to the stage bus. Safe
  //    diagnostics only: MASKED session id + token last-4, never the token/creds.
  const evKey = normalizeKineticAddressKey(address, city, state, zip);
  const emit = (stage: ScanStage, extra: Partial<Parameters<typeof emitStage>[0]> = {}) =>
    emitStage({
      addressKey: evKey, address, city, state, zip, runId: null, source: String(source),
      stage, status: (extra.status ?? "info") as any, attempt: extra.attempt ?? 1,
      tsEpoch: Date.now(), ...extra,
    });

  let tokenLease: AuthorizedTokenLease | null = null;
  const tokenAddressKey = crypto.createHash("sha256")
    .update(normalizeKineticAddressKey(address, city, state, zip))
    .digest("hex");
  emit("minting", { status: "info", detail: "acquiring authorized Decodo token" });
  try {
    tokenLease = await authorizedTokenPool.lease(tokenAddressKey);
  } catch (err: any) {
    // No authorized session/token could be obtained — this is NOT a Search-API
    // error, so we fail CLOSED (unresolved), never requeue-loop with no session.
    // The address is never marked no-fiber and never marked scanned; the next
    // run / daily recheck revisits it.
    base.fiberStatus = "unknown"; base.confidence = "LOW"; base.blocked = false;
    base.notes = `No authorized session — ${String(err?.message ?? err)} (unresolved, recheck)`;
    emit("error", { status: "error", detail: `no authorized Decodo session — ${String(err?.message ?? err).slice(0, 80)}`, sessionId: getProxySessionId() });
    return base;
  }
  emit("token_ready", { status: "info", sessionId: getProxySessionId(), tokenSuffix: tokenLease.token.slice(-4) });
  const searchStart = Date.now();
  try {
    emit("searching", { status: "info", sessionId: getProxySessionId(), tokenSuffix: tokenLease.token.slice(-4) });
    const res = await proxyFetch(KFS_SCAN_URL, {
      method: "POST",
      headers: providerHeaders({
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${tokenLease.token}`,
        "Referer": KFS_REFERER,
        "Origin": KFS_ORIGIN,
      }),
      body: JSON.stringify({ addressLine1: address, addressLine2: "", city, state, postalCode: zip }),
      signal: AbortSignal.timeout(5_000),
    });
    const searchMs = Date.now() - searchStart;

    // ── One shared error contract — NO in-loop retry, cooldown, backoff, or halt.
    //    TRANSIENT errors return a `blocked` result so the worker requeues the
    //    address and retries it later with a fresh token (no retry-count limit). A
    //    token/session error (401/403) also invalidates the leased token so the
    //    pool re-mints. A non-answer is NEVER recorded as "no fiber".
    if (res.status === 401 || res.status === 403) {
      authorizedTokenPool.invalidate(tokenLease.token);
      // Fresh authorized Decodo session (new residential IP) so the requeued retry
      // and the pool's re-mint leave the throttled egress IP behind. Single-flight
      // inside rotateProxySession coalesces a burst of concurrent 403s into ONE
      // rotation. Fire-and-forget — this result is already `blocked`/requeued.
      void rotateProxySession(`search ${res.status}`);
      base.blocked = true; base.fiberStatus = "unknown"; base.confidence = "LOW";
      base.notes = `Upstream ${res.status} (token/session) — token invalidated, Decodo session rotated, address requeued`;
      emit("retry", { status: "pending_auth", httpStatus: res.status, latencyMs: searchMs, sessionId: getProxySessionId(), tokenSuffix: tokenLease.token.slice(-4), retryReason: `auth ${res.status} — token invalidated, Decodo session rotated`, detail: "PENDING_AUTH — retrying same address on a fresh session" });
      if (res.status === 403) {
        structuredLog("scan.provider.access_denied", { status: 403, source }, "warn");
        const alertHook = (globalThis as any).__alertProviderAccessDenied;
        if (typeof alertHook === "function") void Promise.resolve(alertHook({ provider: "kinetic", status: 403 })).catch(() => {});
      }
      return base;
    }
    if (res.status === 429 || res.status >= 500) {
      // Rate limit / transient server error — NO waiting, NO Retry-After pauses.
      // We are authorized and the budget is unlimited: the throttle is keyed to the
      // current residential egress IP, so the remedy is immediate — rotate the
      // Decodo session (fresh IP) and requeue the SAME address so it retries right
      // away on the fresh session. Never a halt, never a cooldown, never a
      // no-service verdict.
      void rotateProxySession(`upstream ${res.status}`);
      base.blocked = true; base.fiberStatus = "unknown"; base.confidence = "LOW";
      base.notes = `Upstream ${res.status} (transient) — Decodo session rotated, address requeued immediately`;
      emit("blocked", { status: "blocked", httpStatus: res.status, latencyMs: searchMs, sessionId: getProxySessionId(), retryReason: `${res.status === 429 ? "rate-limited" : "server error"} — session rotated, retrying immediately on fresh IP`, detail: "transient — kept pending, NOT a no-service verdict" });
      structuredLog("scan.provider.rate_limited", { status: res.status, source }, "warn");
      return base;
    }
    if (!res.ok) {
      // Other non-2xx (e.g. malformed 400 / 404) — a definite non-answer a retry
      // won't fix. Do NOT rotate the session (this is not an IP/auth denial) — the
      // request contract is at fault. DIAGNOSE it: capture the safe response head so
      // an admin can repair the request. Marked unresolved (rechecked), NEVER no-service.
      let diag = "";
      try { diag = (await res.text()).replace(/eyJ[A-Za-z0-9._-]{10,}/g, "<jwt>").slice(0, 160); } catch { /* body unreadable */ }
      base.fiberStatus = "unknown"; base.confidence = "LOW";
      base.notes = `API returned ${res.status} (unresolved, request-contract issue — NOT rotated)`;
      emit("bad_request", { status: "bad_request", httpStatus: res.status, latencyMs: searchMs, sessionId: getProxySessionId(), retryReason: `HTTP ${res.status} malformed/not-found — diagnose request contract (session NOT rotated)`, detail: diag || `HTTP ${res.status}` });
      structuredLog("scan.provider.bad_request", { status: res.status, source, detail: diag.slice(0, 120) }, "warn");
      return base;
    }

    emit("parsing", { status: "info", httpStatus: res.status, latencyMs: searchMs, sessionId: getProxySessionId() });
    let data: KineticAddressResponse;
    try {
      data = (await res.json()) as KineticAddressResponse;
    } catch {
      // 200 with an unparseable body = malformed → unresolved (recheck), not no-fiber.
      base.fiberStatus = "unknown"; base.confidence = "LOW";
      base.notes = "Malformed 200 response (unparseable) — unresolved, recheck";
      emit("error", { status: "error", httpStatus: res.status, latencyMs: searchMs, detail: "malformed 200 body (unparseable) — unresolved, recheck" });
      return base;
    }
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
      emit("classified", { status: "ok", httpStatus: 200, latencyMs: searchMs, classification: /addressnotfound/i.test(vr) ? "address_not_found" : "not_serviceable", detail: `conclusive: ${vr}` });
      return base;
    }
    // A soft `success:false` with an UNRECOGNIZED / error-shaped validationResult is
    // a genuine NON-ANSWER (provider hiccup / degraded / schema change), NOT a
    // confirmed "no service" — treating it as conclusive would let an outage flip
    // the pool unavailable and fabricate "newly live" flips the next healthy night.
    if (!data.success) {
      // AddressNeedsFix / AddressSuggestions: Kinetic rejected the *request address*
      // but usually returns SUGGESTED corrected addresses. Rather than re-sending the
      // same malformed request forever (requeue+backoff), apply ONE reliable
      // correction and re-run the SAME Decodo search once. Guardrails:
      //  • only when there is exactly ONE unambiguous / clearly-top-ranked suggestion;
      //  • bounded to a single correction (depth 0 only — no correction loops);
      //  • the retry goes through this same authorized-token + proxyFetch path
      //    (zero direct requests);
      //  • a correction that does not yield a conclusive *serviceable* answer stays
      //    non-conclusive — it NEVER becomes a no-service verdict for the original.
      const needsFixFamily = /addressneedsfix|addresssuggestion|needs\s*fix|suggest/i.test(vr);
      if (correctionDepth === 0 && needsFixFamily) {
        const selection = selectReliableAddressSuggestion(data);
        const pick = selection.suggestion;
        if (pick) {
          const cAddress = pick.addressLine1 ?? address;
          const cCity = pick.city ?? city;
          const cState = pick.state ?? state;
          const cZip = pick.zip ?? zip;
          const origKey = normalizeKineticAddressKey(address, city, state, zip);
          const corrKey = normalizeKineticAddressKey(cAddress, cCity, cState, cZip);
          // Never "correct" an address to itself — that would just repeat the request.
          if (corrKey !== origKey) {
            emit("searching", {
              status: "info", httpStatus: 200, latencyMs: searchMs, sessionId: getProxySessionId(),
              tokenSuffix: tokenLease.token.slice(-4),
              retryReason: `${vr} — applying one reliable address suggestion and re-searching once`,
              detail: `applied address suggestion: ${maskSuggestedAddress(cAddress, cCity, cState, cZip)} (${selection.reason})`,
            });
            // SAME transport, SAME authorized-token + proxyFetch path; depth+1 bounds it.
            const corrected = await scanAddressDirect(cAddress, cCity, cState, cZip, source, correctionDepth + 1);
            // ADOPT the correction ONLY if it produced a conclusive serviceable answer
            // (fiber/copper/tenured — a real kinetic_live verdict that is not no-service
            // and not an unresolved non-answer). The corrected/canonical address then
            // becomes the address of record for this check.
            if (corrected.apiSource === "kinetic_live" && corrected.fiberStatus !== "no_service" && corrected.fiberStatus !== "unknown") {
              corrected.notes = `Corrected ${vr || "address"} → ${cAddress} (${selection.reason}). ${corrected.notes}`.trim();
              return corrected;
            }
            // The correction did NOT resolve to a serviceable answer (it came back
            // no-service, blocked, or non-conclusive). Per product law we do NOT adopt a
            // no-service verdict from a guessed correction — stay non-conclusive so the
            // worker requeues + backs off exactly as it did before. The `${vr}` marker is
            // preserved so the engine's AddressNeedsFix backoff cadence still applies.
            base.apiSource = "failed";
            base.confidence = "LOW";
            base.notes = `Non-conclusive (${vr}); applied suggestion "${cAddress}" but it did not resolve to a serviceable answer — unresolved, recheck (NOT no-service)`;
            emit("error", { status: "error", httpStatus: 200, latencyMs: searchMs, detail: `correction did not resolve (${vr}) — unresolved, NOT no-service` });
            return base;
          }
        }
        // 0 suggestions, ambiguous suggestions, low-confidence sole suggestion, or a
        // suggestion identical to the query → fall through to the existing
        // non-conclusive requeue+backoff behavior below. We never guess.
      }
      base.apiSource = "failed";
      base.confidence = "LOW";
      base.notes = `Non-conclusive response (success=false, ${vr || "no validationResult"})`;
      emit("error", { status: "error", httpStatus: 200, latencyMs: searchMs, detail: `non-conclusive (success=false, ${vr || "no validationResult"}) — unresolved, NOT no-service` });
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

    // ── Canonical parse — ONE parser shared by Manual Check, Field Map, city
    //    scans, and rechecks. Reads the real field paths AND the stringified
    //    uqualProvisioningResult, and keeps FIBER qualified INDEPENDENTLY of any
    //    COPPER "NO QUAL / REMOVE FIBER AREA" override (that override disqualifies
    //    copper only, never fiber).
    const parsed = parseKineticResponse(data);

    // Core fields
    base.dfAddressId = parsed.dfAddressId;
    base.accessId = parsed.accessId;
    base.exchangeId = data.exchangeId ?? data.address?.exchangeId ?? null;
    base.techType = parsed.technology;
    base.maxQual = parsed.maxQual;
    base.serviceKey = parsed.serviceKey;
    base.apiSource = "kinetic_live";

    // Speed (top-level broadband, supplemented by the nested fiber service)
    base.maxDownloadKbps = parsed.finalQualSpeedKbps;
    base.maxDownloadMbps = kbpsToMbps(parsed.finalQualSpeedKbps ?? undefined);
    base.speedTier = speedTierFromMbps(base.maxDownloadMbps);

    // Technology detail
    base.chipSetType = parsed.chipSetType;
    base.placement = null;

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
    base.billingStatus = parsed.billingStatus;

    // THE KEY FIELD — household segment type
    const segment = (parsed.householdSegmentType ?? "").toUpperCase();
    base.householdSegmentType = parsed.householdSegmentType ?? "";

    // Fiber qualification is copper-override-safe (see kineticResponseParser).
    const isFiber = parsed.fiberQualified;
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

    const billingY = String(base.billingStatus ?? "").toUpperCase() === "Y";
    const cls = base.fiberStatus === "new_fiber"
      ? (billingY ? "already_customer" : "fresh_fiber")
      : base.fiberStatus === "tenured_fiber"
        ? (billingY ? "already_customer" : "tenured_fiber")
        : base.fiberAvailable ? "fiber_available" : "copper";
    emit("classified", {
      status: "ok", httpStatus: 200, latencyMs: Date.now() - searchStart, sessionId: getProxySessionId(),
      classification: cls,
      detail: `${base.fiberStatus} · segment=${base.householdSegmentType || "?"} · billing=${base.billingStatus || "?"}`,
    });
  } catch (err: any) {
    // PRODUCT LAW: a failed check (timeout / network / no-token) carries NO
    // availability signal and NEVER aborts the run or becomes a "no fiber". These
    // are TRANSIENT — mark blocked so the worker requeues the address and retries
    // it with a fresh token. A stale/errored lease token is invalidated so the
    // pool re-mints on the next attempt.
    if (tokenLease?.token) authorizedTokenPool.invalidate(tokenLease.token);
    base.apiSource = "failed";
    base.fiberStatus = "unknown";
    base.confidence = "LOW";
    base.blocked = true;
    base.notes = `Check failed (transient) — ${err.message}`;
    emit("error", { status: "error", latencyMs: Date.now() - searchStart, retryReason: `transient — ${String(err?.message ?? err).slice(0, 60)}`, detail: "network/timeout — kept pending for retry, NOT no-service" });
  } finally {
    tokenLease?.release();
  }

  return base;
}
