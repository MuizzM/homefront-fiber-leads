// Kinetic availability adapter. Live use is opt-in and requires a licensed API,
// partner integration, or written automation permission; credentials and the
// stable provider-issued identity are loaded only from environment variables.
import { proxyFetch, directFetch } from "./proxy-fetch";
import { KFS_SCAN_URL, KFS_REFERER, KFS_ORIGIN } from "./kfs-config";
import { scoreLead } from "./lead-scoring";
import { parseKineticResponse } from "./kineticResponseParser";
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

const configuredTokenPoolSize = Number(process.env.KFS_TOKEN_POOL_MAX ?? 100);
const configuredWarmTokens = Number(process.env.KFS_TOKEN_POOL_WARM_MIN ?? 2);

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

async function mintAuthorizedToken(): Promise<{ token: string; expiresAt: number }> {
  // The gokinetic token endpoint is a POST that authenticates with the client
  // Basic credential (KFS_AUTH_BASIC, which already carries its "Basic " prefix)
  // and a braze device body, and returns { token } (a JWT). Some other token
  // services return { access_token, expires_in } — handle both.
  //
  // TRANSPORT: mint DIRECT (server egress), never through the residential proxy.
  // This endpoint is anonymous — it carries the baked client credential, not a
  // user identity — and is verified to return 201 from the server's own IP. The
  // proxy IP enforces a rolling-window rate limit shared with the high-volume
  // Search calls; routing the low-volume mint through it made the mint itself
  // return 403 ("Auto-auth blocked"), failing the whole check as an auth error
  // even though the address was never looked up. Only the identity-bearing Search
  // calls need the fixed residential egress. Opt back in with KFS_MINT_VIA_PROXY=true.
  const basic = process.env.KFS_AUTH_BASIC?.trim();
  const mintFetch = process.env.KFS_MINT_VIA_PROXY === "true" ? proxyFetch : directFetch;
  const response = await mintFetch(kineticTokenUrl(), {
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
  if (!response.ok) throw new Error(`Auto-auth blocked (${response.status})`);
  const data = (await response.json()) as Record<string, unknown>;
  const token = typeof data.token === "string" ? data.token.trim()
    : typeof data.access_token === "string" ? data.access_token.trim() : "";
  if (!token) throw new Error("No token in mint response");
  const now = Date.now();
  const expiresIn = Number(data.expires_in);
  const expiresAt = jwtExpiryMs(token)
    ?? (Number.isFinite(expiresIn) && expiresIn > 0 ? now + Math.floor(expiresIn * 1000) : now + 28 * 60 * 1000);
  if (expiresAt <= now + TOKEN_REFRESH_MARGIN_MS) throw new Error("Minted token expires too soon");
  return { token, expiresAt };
}

const authorizedTokenPool = new AuthorizedTokenPool({
  maxSize: Number.isFinite(configuredTokenPoolSize) ? configuredTokenPoolSize : 100,
  warmMinimum: Number.isFinite(configuredWarmTokens) ? configuredWarmTokens : 2,
  refreshMarginMs: TOKEN_REFRESH_MARGIN_MS,
  maintenanceIntervalMs: Number(process.env.KFS_TOKEN_MAINTENANCE_MS ?? 15_000),
  maxLeasesPerToken: Number(process.env.KFS_TOKEN_MAX_LEASES_PER_SLOT ?? 10),
  maxConcurrentRefreshes: Number(process.env.KFS_TOKEN_REFRESH_CONCURRENCY ?? 2),
  maxChecksPerToken: Number(process.env.KFS_TOKEN_MAX_CHECKS ?? 100),
  mint: () => mintAuthorizedToken(),
});

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
    distributed,
  };
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

  // Fresh Braze token via the approved flow (minted DIRECT, not through the
  // throttled proxy). On failure, invalidate stale state and retry ONCE — no
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
    exchangeId: null, dfAddressId: null, accessId: null, serviceKey: null,
    confidence: "LOW", apiSource: "failed", blocked: false, notes: "",
    leadTag: null, leadScore: 0,
  };

  let tokenLease: AuthorizedTokenLease | null = null;
  const tokenAddressKey = crypto.createHash("sha256")
    .update(normalizeKineticAddressKey(address, city, state, zip))
    .digest("hex");
  try {
    tokenLease = await authorizedTokenPool.lease(tokenAddressKey);
  } catch (err: any) {
    // No authorized session/token could be obtained — this is NOT a Search-API
    // error, so we fail CLOSED (unresolved), never requeue-loop with no session.
    // The address is never marked no-fiber and never marked scanned; the next
    // run / daily recheck revisits it.
    base.fiberStatus = "unknown"; base.confidence = "LOW"; base.blocked = false;
    base.notes = `No authorized session — ${String(err?.message ?? err)} (unresolved, recheck)`;
    return base;
  }
  try {
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

    // ── One shared error contract — NO in-loop retry, cooldown, backoff, or halt.
    //    TRANSIENT errors return a `blocked` result so the worker requeues the
    //    address and retries it later with a fresh token (no retry-count limit). A
    //    token/session error (401/403) also invalidates the leased token so the
    //    pool re-mints. A non-answer is NEVER recorded as "no fiber".
    if (res.status === 401 || res.status === 403) {
      authorizedTokenPool.invalidate(tokenLease.token);
      base.blocked = true; base.fiberStatus = "unknown"; base.confidence = "LOW";
      base.notes = `Upstream ${res.status} (token/session) — token invalidated, address requeued`;
      if (res.status === 403) {
        structuredLog("scan.provider.access_denied", { status: 403, source }, "warn");
        const alertHook = (globalThis as any).__alertProviderAccessDenied;
        if (typeof alertHook === "function") void Promise.resolve(alertHook({ provider: "kinetic", status: 403 })).catch(() => {});
      }
      return base;
    }
    if (res.status === 429 || res.status >= 500) {
      // Rate limit / transient server error — requeue (the coordinator paces admission).
      base.blocked = true; base.fiberStatus = "unknown"; base.confidence = "LOW";
      base.notes = `Upstream ${res.status} (transient) — address requeued`;
      structuredLog("scan.provider.rate_limited", { status: res.status, source }, "warn");
      return base;
    }
    if (!res.ok) {
      // Other non-2xx (e.g. 400/404) — a definite non-answer a retry won't fix →
      // unresolved (rechecked daily), NEVER a no-service answer.
      base.fiberStatus = "unknown"; base.confidence = "LOW";
      base.notes = `API returned ${res.status} (unresolved)`;
      return base;
    }

    let data: KineticAddressResponse;
    try {
      data = (await res.json()) as KineticAddressResponse;
    } catch {
      // 200 with an unparseable body = malformed → unresolved (recheck), not no-fiber.
      base.fiberStatus = "unknown"; base.confidence = "LOW";
      base.notes = "Malformed 200 response (unparseable) — unresolved, recheck";
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
  } finally {
    tokenLease?.release();
  }

  return base;
}
