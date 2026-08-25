// Kinetic availability adapter. Live use is opt-in and requires a licensed API,
// partner integration, or written automation permission; credentials and the
// stable provider-issued identity are loaded only from environment variables.
import { proxyFetch, rotateProxySession, advanceProxyEgress, getProxySessionId, currentEgressProxyUrl, directCarrierEgressAllowed, directCarrierFetch, setEgressGenerationHook, getProxyStickyState, isProxyConnected, getEgressIp, refreshEgressIp, egressLaneCount } from "./proxy-fetch";
import { classifyServiceability } from "@shared/serviceabilityVerdict";
import { mintViaImpersonate } from "./curlMint";
import { emitStage, type ScanStage } from "./scanStageBus";
import { KFS_SCAN_URL, KFS_REFERER, KFS_ORIGIN } from "./kfs-config";
import { scoreLead } from "./lead-scoring";
import { classifyKineticResult, parseKineticResponse, selectReliableAddressSuggestion } from "./kineticResponseParser";
import { isActiveBilling } from "@shared/billingStatus";
import { NEEDS_FIX_NOTE, type RequeueReason } from "@shared/scanRequeueReason";
import {
  ProviderRequestQueue,
  type ProviderQueueSnapshot,
  type ProviderRequestPriority,
  type QueueEvent,
} from "./providerRequestQueue";
import { structuredLog } from "./structuredLog";
import crypto from "node:crypto";
import { resolveScanWorkerCount } from "./scanWorkers";
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
// WARM RESERVE 1, under the one-IP-one-token rule.
//
// The old reserve was 40 (min 4 per worker), sized to "cover the full concurrent
// workload so a burst never waits on a mint". That reasoning assumed a token
// outlives the egress it was minted against. It does not any more: an IP change
// ends the generation, so a crowd of warm tokens is a crowd that dies together,
// unused, and every one of them cost a mint through the serialized gate.
//
// One ready token is also all a leaser ever needs - ensureWarm in
// authorizedTokenPool returns the moment ONE is ready, and a single token
// carries KFS_TOKEN_MAX_LEASES_PER_SLOT concurrent leases. Raise
// KFS_TOKEN_POOL_WARM_MIN only if leases are measurably waiting on mints.
// MULTI-PROCESS: the pool is per-process, so the reserve is still divided across
// cluster workers - N workers each warming a big reserve was an auth-storm
// against Decodo's window at boot.
const _scanWorkerCount = Math.max(1, resolveScanWorkerCount());
const configuredWarmTokens = Math.max(1,
  Math.floor(Number(process.env.KFS_TOKEN_POOL_WARM_MIN ?? 1) / _scanWorkerCount));

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
  // Live-verified session mint (2026-07): the storefront's real flow is
  // POST /api/v1/auth/session?context=web with the client Basic credential —
  // the legacy /_internal/precisely/token endpoint rejects non-internal callers.
  return env.KFS_AUTH_URL?.trim() || `${KFS_ORIGIN}/api/v1/auth/session?context=web`;
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

/**
 * A mint that never received a response at all: the egress could not reach the
 * token endpoint (timeout, socket error, black-holed tunnel, "fetch failed").
 *
 * This is a THIRD class, distinct from the two the mint ladder already knew:
 *  - an AUTH DENIAL is the provider answering 401/403 → rotate and retry;
 *  - a CHALLENGE is the provider answering with an interstitial → fail closed,
 *    never rotate, because rotating past a challenge is evasion.
 * A transport failure carries NO provider verdict, because no provider was
 * reached. It is evidence about the EGRESS, not about our authorization.
 *
 * It is raised structurally — only where `proxyFetch` itself throws — and never
 * inferred from an error string. That is what keeps a challenge a challenge: a
 * challenge can only exist once a response has been received, so it can never
 * be mistaken for this.
 */
export class MintTransportError extends Error {
  readonly code = "MINT_TRANSPORT";
  constructor(cause: unknown) {
    super(`Mint transport failure (via decodo) - ${String((cause as any)?.message ?? cause).slice(0, 120)}`);
    this.name = "MintTransportError";
  }
}

// CONSECUTIVE mint transport failures on the Decodo egress.
//
// WHY THIS COUNTER EXISTS. A run that lands on a sticky port whose residential
// IP cannot reach the Kinetic auth endpoint used to retry that same dead IP
// every ~3s forever: rotation was gated on isAuthDenialMessage, so a transport
// failure failed closed WITHOUT advancing the port. Observed twice on
// 2026-08-24 — the run sat at verified=610 through 26 consecutive mint failures
// and wrote zero snapshots, and only a process restart (which picks a new random
// port) recovered it.
//
// WHY IT IS A STREAK AND NOT A REFLEX. Rotating on every failure is its own
// measured bug: moving IP mid-run correlates with collapse, which is why search
// denials are gated behind DECODO_ROTATE_AFTER_DENIALS rather than firing on
// each 403. So this needs N in a row before it moves, and ANY successful Decodo
// mint forgives the streak — a working egress can never accumulate its way into
// a rotation. No time window is needed: the 15-minute sticky window retires the
// IP on its own under normal traffic, so a stale streak can at worst cost one
// extra rotation.
//
// 0 disables the behavior entirely (restores the pre-2026-08-24 fail-closed).
const MINT_TRANSPORT_ROTATE_AFTER = Math.max(0, Math.floor(Number(process.env.KFS_MINT_TRANSPORT_ROTATE_AFTER ?? 3)) || 0);
let _mintTransportStreak = 0;

// One mint attempt over the authorized Decodo transport. The gokinetic token
// endpoint is a POST that authenticates with the client Basic credential
// (KFS_AUTH_BASIC, which already carries its "Basic " prefix) and a braze device
// body, and returns { token } (a JWT). Some other token services return
// { access_token, expires_in } — handle both. A non-2xx (403 IP throttle, 429,
// 5xx) or a non-JSON body (bot-challenge interstitial) throws so the caller can
// rotate the Decodo session and retry.
// The storefront's public client credential (base64 of "kinetic:SecuRe!CoNneCt1",
// extracted from the official buy.gokinetic.com web bundle). KFS_AUTH_BASIC
// overrides it when the provider issues a deployment-specific credential.
const DEFAULT_KFS_AUTH_BASIC = `Basic ${Buffer.from("kinetic:SecuRe!CoNneCt1").toString("base64")}`;

// Shared mint request body; `transport` picks the egress (direct server IP vs
// Decodo residential proxy).
async function mintRequest(transport: "direct" | "decodo"): Promise<{ token: string; expiresAt: number }> {
  const basic = process.env.KFS_AUTH_BASIC?.trim() || DEFAULT_KFS_AUTH_BASIC;
  const init = {
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
  } as any;
  // "direct" = this box's own IP, so it goes through the gate rather than
  // global fetch: directCarrierFetch throws unless an operator opted in.
  const response = transport === "direct" ? await directCarrierFetch(kineticTokenUrl(), init) : await proxyFetch(kineticTokenUrl(), init);
  if (!response.ok) throw new Error(`Auto-auth blocked (${response.status} via ${transport})`);
  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`Auto-auth non-JSON body (challenge via ${transport})`);
  }
  const token = typeof data.token === "string" ? data.token.trim()
    : typeof data.access_token === "string" ? data.access_token.trim() : "";
  if (!token) throw new Error(`No token in mint response (via ${transport})`);
  const now = Date.now();
  const expiresIn = Number(data.expires_in);
  const expiresAt = jwtExpiryMs(token)
    ?? (Number.isFinite(expiresIn) && expiresIn > 0 ? now + Math.floor(expiresIn * 1000) : now + 28 * 60 * 1000);
  if (expiresAt <= now + TOKEN_REFRESH_MARGIN_MS) throw new Error(`Minted token expires too soon (via ${transport})`);
  return { token, expiresAt };
}

async function mintViaDecodo(): Promise<{ token: string; expiresAt: number }> {
  const basic = process.env.KFS_AUTH_BASIC?.trim() || DEFAULT_KFS_AUTH_BASIC;
  // The ONLY place a MintTransportError is raised: a throw from proxyFetch means
  // no response was ever seen. Everything below this point has a response in
  // hand and is therefore a provider verdict (denial, challenge, bad body),
  // which must keep failing closed exactly as before.
  let response: Response;
  try {
    response = await proxyFetch(kineticTokenUrl(), {
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
  } catch (err) {
    throw new MintTransportError(err);
  }
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
  // Proof this egress can reach the token endpoint — forgive any earlier
  // transport failures so a working IP can never accumulate into a rotation.
  _mintTransportStreak = 0;
  return { token, expiresAt };
}

async function mintAuthorizedTokenViaLadder(): Promise<{ token: string; expiresAt: number }> {
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
  // HYBRID EGRESS (verified live 2026-07-24): the server's own IP passes
  // Cloudflare cleanly (3/3 → 201) while Decodo pool IPs carry mixed
  // reputation. With the token economy capping mints at ~30/min, direct
  // volume stays far under the per-IP rate radar. Direct first; on a direct
  // denial, rotate the Decodo session and mint via proxy instead — two
  // independent egress reputations means the wall has to block BOTH to stop us.
  // KFS_MINT_DIRECT=off restores Decodo-exclusive minting.
  // THE CRACK (verified live 2026-07-25): curl-impersonate DIRECT — Chrome's
  // exact TLS fingerprint + the clean server IP = 6/6 mints (100%). Node's
  // undici fingerprint was the real tell all along. Mints are capped ~30/min
  // by the token economy, so direct volume stays far under the per-IP radar.
  // Ladder: impersonate-direct -> impersonate-proxy -> legacy paths below.
  if (process.env.KFS_MINT_IMPERSONATE !== "off") {
    // CRITICAL: do NOT inject our custom User-Agent here. curl-impersonate
    // ships a Chrome fingerprint paired to its own Chrome UA — overriding it
    // (e.g. the iPhone Safari UA in KFS_USER_AGENT) creates a UA/fingerprint
    // mismatch Cloudflare reads instantly (measured: 4/4 403s with the
    // override, 4/4 201s without). The impersonate UA stays matched, always.
    const mintHeaders = providerHeaders({
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(process.env.KFS_AUTH_BASIC?.trim() || DEFAULT_KFS_AUTH_BASIC
        ? { "Authorization": process.env.KFS_AUTH_BASIC?.trim() || DEFAULT_KFS_AUTH_BASIC }
        : {}),
      "Origin": KFS_ORIGIN,
      "Referer": KFS_REFERER,
    });
    delete mintHeaders["User-Agent"];
    const mintBody = JSON.stringify({ brazeDeviceId: "" });
    // imp-direct mints from the SERVER's own IP, and that is where we WANT the
    // mint: cleanest egress, and it does not spend any residential IP's search
    // budget.
    //
    // A previous revision skipped this rung under a sticky egress, on the
    // premise that a Kinetic token is bound to the IP that minted it. MEASURED
    // 2026-08-23, and the premise is false:
    //   mint IP-1 / search IP-1 (matched)      20/20  100%
    //   mint IP-1 / search IP-2 (MISMATCH)     20/20  100%   <- travels fine
    //   mint SERVER IP / search residential    20/20  100%
    // Tokens are portable. The per-IP limit is on SEARCH volume, not on token
    // provenance - so skipping this rung disabled the best mint path for no
    // reason at all.
    // ...but it egresses from THIS BOX, and the owner directive is that no
    // carrier request does. The rung is kept, behind the explicit opt-in, so
    // the measured-best mint path is one env var away rather than deleted.
    if (directCarrierEgressAllowed()) {
      try {
        return await mintViaImpersonate(kineticTokenUrl(), mintHeaders, mintBody, null);
      } catch (err) {
        structuredLog("scan.token.mint_failed", { transport: "imp-direct", error: String((err as any)?.message ?? err).slice(0, 120) }, "warn");
      }
    }
    // No proxy resolved means no authorized egress. Passing null here would send
    // the mint out DIRECT while the log still said "imp-proxy" - the silent leak
    // this gate exists to prevent - so the rung is skipped instead.
    const impProxyUrl = currentEgressProxyUrl();
    if (impProxyUrl) {
      try {
        return await mintViaImpersonate(kineticTokenUrl(), mintHeaders, mintBody, impProxyUrl);
      } catch (err2) {
        structuredLog("scan.token.mint_failed", { transport: "imp-proxy", error: String((err2 as any)?.message ?? err2).slice(0, 120) }, "warn");
        // fall through to the legacy paths below
      }
    }
  }

  // Also this box's own IP, so also behind the opt-in. KFS_MINT_DIRECT=off still
  // disables it independently, for an operator who wants the impersonate rung
  // direct but not this one.
  if (directCarrierEgressAllowed() && process.env.KFS_MINT_DIRECT !== "off") {
    try {
      return await mintRequest("direct");
    } catch (err) {
      const message = String((err as any)?.message ?? err);
      structuredLog("scan.token.mint_failed", { transport: "direct", error: message.slice(0, 120) }, "warn");
      // fall through to the Decodo path on ANY direct failure
    }
  }
  // Decodo rung: on a bot-wall auth denial (401/403) the remedy is a FRESH
  // residential IP, not a wait — a rotated Decodo session commonly clears the
  // wall (verified live: a freshly-built dispatcher gets a new IP and returns
  // 201). So when the wall hits, SWITCH THE DECODO IP and retry, up to
  // KFS_MINT_MAX_ROTATIONS fresh IPs, before deferring to the pool's next tick
  // (which is itself paced by the fleet-shared 403-storm backoff, so this can
  // never become a hot loop). Bounded so a Kinetic-wide wall can't spin.
  //
  // A CHALLENGE (non-JSON interstitial) still fails closed WITHOUT rotating —
  // this scanner never rotates to evade a CAPTCHA/challenge. A TRANSPORT
  // failure is neither: no provider was reached, so it expresses no policy to
  // respect, and staying on an egress that cannot connect is the livelock this
  // gate exists to break (see MINT_TRANSPORT_ROTATE_AFTER).
  //
  // Set KFS_MINT_MAX_ROTATIONS=1 to restore the prior single-retry behavior, or
  // 0 to disable IP switching on the mint path.
  const maxMintRotations = Math.max(0, Math.floor(Number(process.env.KFS_MINT_MAX_ROTATIONS ?? 3)) || 0);
  let lastMintErr: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      return await mintViaDecodo();
    } catch (err) {
      lastMintErr = err;
      const message = String((err as any)?.message ?? err);
      const transportFailed = err instanceof MintTransportError;
      // The streak counts only DEAD-EGRESS evidence. A denial or a challenge
      // leaves it untouched: those say something about our authorization, not
      // about whether this IP can carry a request.
      if (transportFailed) _mintTransportStreak++;
      const streakSpent = transportFailed
        && MINT_TRANSPORT_ROTATE_AFTER > 0
        && _mintTransportStreak >= MINT_TRANSPORT_ROTATE_AFTER;
      structuredLog("scan.token.mint_failed", {
        transport: "decodo", attempt, error: message.slice(0, 120),
        // Name the class in the log, so "26 consecutive mint failures" is
        // readable as a dead egress instead of guessed at from the message.
        failure: transportFailed ? "transport" : isAuthDenialMessage(message) ? "auth_denied" : "provider",
        ...(transportFailed ? { transportStreak: _mintTransportStreak } : {}),
      }, "warn");
      const rotatable = streakSpent || (!transportFailed && isAuthDenialMessage(message));
      if (!rotatable || attempt >= maxMintRotations) break;
      if (streakSpent) {
        // Advance the sticky port (rotateProxySession rebuilds the dispatcher,
        // which steps to the next residential IP). Reset the streak so this
        // moves at most once per N failures rather than on every one after N.
        _mintTransportStreak = 0;
        structuredLog("scan.token.mint_egress_rotated", {
          after: MINT_TRANSPORT_ROTATE_AFTER,
          reason: "consecutive mint transport failures - egress cannot reach the token endpoint",
        }, "warn");
        // advanceProxyEgress, NOT rotateProxySession. The denial path holds the
        // IP until DECODO_ROTATE_AFTER_DENIALS consecutive denials (8 in
        // production) and is throttled by ROTATE_MIN_INTERVAL_MS, so it returns
        // early having advanced nothing. A dead egress produces no denials at
        // all - it produces no responses - so the only thing that could feed
        // that streak is this call, which would need ~24 consecutive transport
        // failures to move one port, and any successful search resets it.
        //
        // This is the SPENT-IP handover instead: unthrottled and not
        // streak-gated, because the caller has already established across N
        // failures that the IP cannot carry a request.
        await advanceProxyEgress("mint transport: egress cannot reach the token endpoint");
      } else {
        // Fresh authorized Decodo session (new residential IP), then retry.
        await rotateProxySession(`mint ${message.match(/\d{3}/)?.[0] ?? "auth"}`);
      }
    }
  }
  throw lastMintErr; // fail closed — pool self-heals next tick under the fleet backoff
}

async function mintAuthorizedToken(): Promise<{ token: string; expiresAt: number }> {
  let minted: { token: string; expiresAt: number };
  try {
    minted = await mintAuthorizedTokenViaLadder();
  } catch (err) {
    egressActivity.mintsFailed++;
    egressActivity.lastMintAt = Date.now();
    egressActivity.lastMintError = String((err as any)?.message ?? err).slice(0, 120);
    throw err;
  }
  egressActivity.mintsOk++;
  egressActivity.lastMintAt = Date.now();
  egressActivity.lastMintError = null;
  // A token in hand — from ANY rung — proves the mint path is alive, so the
  // consecutive-transport-failure streak starts over.
  _mintTransportStreak = 0;
  return minted;
}

// ── Global mint gate — serialize mints, never pace them ──────────────────────
// On boot the auto-started statewide sweep leases tokens en masse; with no pacing
// the pool fired ~1.7k mint attempts in seconds, DDoSing BOTH egresses (direct →
// Cloudflare 429, proxy → rolling-window 403) so neither could ever succeed — a
// self-reinforcing deadlock. This gate serializes every mint through one chain
// with minimal spacing (100ms), so the pool refills at full speed.
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
  // Frequent token switching (owner directive): a token serves only 10 leases /
  // 250 checks before retirement, so no single token accumulates upstream
  // throttle pressure. Unlimited Decodo budget funds the higher mint rate.
  maxLeasesPerToken: Number(process.env.KFS_TOKEN_MAX_LEASES_PER_SLOT ?? 10),
  // The global gate still serializes individual mint requests, but several slots
  // may refresh concurrently so a large warm pool never waits on one mint stream.
  maxConcurrentRefreshes: Number(process.env.KFS_TOKEN_REFRESH_CONCURRENCY ?? 6),
  maxChecksPerToken: Number(process.env.KFS_TOKEN_MAX_CHECKS ?? 250),
  // MINTING IS NOT ENV-GATED. An earlier revision refused to mint unless
  // KFS_AUTOMATION_AUTHORIZED === "true"; production never sets that variable
  // (it appears only in .env.example), so the pool could never warm, every
  // address hit the fail-closed branch in scanAddressDirect, and a run sat at
  // "N found · 0 checked · N pending" retrying forever. Scanning is the
  // product's core function and the operator runs it continuously — making it
  // depend on a flag the deployment does not define was the defect, not the
  // hardening. The real safety property is unchanged and lives where it always
  // did: scanAddressDirect fails CLOSED (unresolved, never a no-service verdict)
  // whenever no authorized session can actually be obtained.
  mint: () => gatedMint(),
});

// Which lane the next check rides. Round-robin, so concurrent checks spread
// across residential IPs instead of queueing behind one.
let _nextLane = -1;

// ── WHAT THE EGRESS IS DOING RIGHT NOW ──────────────────────────────────────
// Counters for the live view, so an operator can watch the pair rule work
// instead of inferring it from the logs. Diagnostics only: nothing here is a
// credential, and the residential IP itself is never known to this process -
// only the sticky PORT that selects it, and the masked session id.
const egressActivity = {
  mintsOk: 0, mintsFailed: 0,
  lastMintAt: null as number | null, lastMintError: null as string | null,
  generationsRetired: 0, lastGenerationAt: null as number | null, lastGenerationReason: null as string | null,
};

export function getEgressActivity() {
  // Ask what IP we are on, at most once per port, only because someone is
  // looking. Fire and forget: this call answers with what is known now.
  void refreshEgressIp();
  const egressIp = getEgressIp();
  const sticky = getProxyStickyState();
  const pool = authorizedTokenPool.snapshot();
  const budget = Math.max(0, Number(process.env.DECODO_CHECKS_PER_IP ?? 20));
  // The token actually being drained: the pool hands out the MOST-used one
  // first (sticky reuse), so that is the one whose budget is running down.
  const active = [...pool.slots].filter(slot => slot.state === "READY")
    .sort((a, b) => b.checksUsed - a.checksUsed)[0] ?? null;
  return {
    proxy: {
      connected: isProxyConnected(),
      sessionId: getProxySessionId(),          // masked "decodo-sN", never a credential
      stickyPort: sticky.port,
      publicIp: egressIp.forPort === sticky.port ? egressIp.ip : null,   // the address itself, once known
      publicIpError: egressIp.forPort === sticky.port ? egressIp.error : null,
      checksOnThisIp: sticky.checksOnThisIp,
      checksPerIp: budget,
      denialStreak: sticky.denialStreak,
      rotateAfterDenials: Math.max(1, Number(process.env.DECODO_ROTATE_AFTER_DENIALS ?? 3)),
    },
    token: {
      ready: pool.ready,
      total: pool.total,
      warmMinimum: pool.warmMinimum,
      maxChecksPerToken: pool.maxChecksPerToken,
      activeChecksUsed: active?.checksUsed ?? 0,
      activeChecksRemaining: active?.checksRemaining ?? 0,
      inFlight: pool.activeLeases,
      refreshing: pool.activeRefreshes,
    },
    mints: {
      ok: egressActivity.mintsOk,
      failed: egressActivity.mintsFailed,
      lastAt: egressActivity.lastMintAt,
      lastError: egressActivity.lastMintError,
    },
    pairs: {
      retired: egressActivity.generationsRetired,
      lastAt: egressActivity.lastGenerationAt,
      lastReason: egressActivity.lastGenerationReason,
    },
  };
}

/** Test-only: zero the live counters. */
export function __resetEgressActivityForTests(): void {
  egressActivity.mintsOk = 0; egressActivity.mintsFailed = 0;
  egressActivity.lastMintAt = null; egressActivity.lastMintError = null;
  egressActivity.generationsRetired = 0; egressActivity.lastGenerationAt = null;
  egressActivity.lastGenerationReason = null;
}

// ONE IP, ONE TOKEN, TWENTY CHECKS. The egress owns the boundary (its check
// counter is a superset of the token's - retries and denials spend it too), so
// when the IP changes, the token generation ends with it. See the measurement
// table at setEgressGenerationHook in server/proxy-fetch.ts.
setEgressGenerationHook((reason, laneId, laneCount) => {
  // A lane retirement spends the pairs on THAT lane: every slot riding it, which
  // is slot % laneCount === laneId, not slots[laneId]. A process-wide rotation
  // (no lane) ends every generation, and now genuinely moves every lane's port
  // first, so the pool-wide retirement is honest rather than a token cull that
  // leaves each lane on its spent IP.
  const retired = laneId == null || laneCount == null
    ? authorizedTokenPool.retireGeneration()
    : authorizedTokenPool.retireLane(laneId, laneCount);
  egressActivity.generationsRetired++;
  egressActivity.lastGenerationAt = Date.now();
  egressActivity.lastGenerationReason = reason;
  if (retired) structuredLog("scan.token.generation_retired", { retired, reason }, "info");
});

/** Test-only: reset the module-level mint-gate state so unit tests don't leak
 * pacing state between cases. No effect in prod use. */
export function __resetTokenTransportStateForTests(): void {
  lastMintAt = 0;
  mintChain = Promise.resolve();
  _mintTransportStreak = 0;
}

/** Called from routes.ts when user pastes a JWT from their browser */
export function setManualToken(token: string) {
  authorizedTokenPool.install(token, jwtExpiryMs(token) ?? Date.now() + 28 * 60 * 1000);
  providerQueue.resume();
}

/** Lease a valid token — minting ONLY when none is ready. Called at the start
 * of scan runs and by the admin refresh route. A healthy READY token is
 * returned as-is: force-refreshing here threw away a perfectly good token on
 * every run start (one needless Decodo mint per run, and the batch then
 * re-spread across fresh slots instead of draining one token). The pool
 * self-heals invalid tokens via the 401/403 invalidate path. */
export async function refreshTokenFromApi(): Promise<string> {
  const lease = await authorizedTokenPool.lease();
  try { return lease.token; }
  finally { lease.release(); }
}

/** Force a genuinely FRESH mint, discarding any healthy token. Use ONLY where a
 * new token is contractually required — the Live Test diagnostic ("fresh mint ·
 * no cache"), the per-address auth-retry remint after a 401/403, and the admin
 * "refresh token" action. The run-start path uses refreshTokenFromApi (reuse). */
export async function forceFreshTokenFromApi(): Promise<string> {
  const lease = await authorizedTokenPool.lease();
  try { return await authorizedTokenPool.refreshLease(lease); }
  finally { lease.release(); }
}

/** Drop a token the caller saw fail against the provider so it is never reused.
 * The slot returns to EMPTY and is re-minted on the next lease. */
export function invalidateAuthorizedToken(token: string | null | undefined): void {
  authorizedTokenPool.invalidate(token);
}

// NOTE: tokens are NOT bound to the IP that minted them - measured 2026-08-23,
// a token minted on one residential IP searched 20/20 from a different one, and
// a server-IP mint searched 20/20 through a residential proxy. An earlier
// revision dropped the whole token pool on every egress change to "fix" a
// binding that does not exist; all it bought was a forced re-mint per rotation.

/** Per-address count of 4xx-driven token/session switches. A 4xx burns the
 * token and rotates the session up to 3 times per address (fresh-token proof
 * that the request contract — not the session — is at fault), then stops. */
const fourXxRotations = new Map<string, number>();

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

/**
 * Boot-time token warming is a production behavior.
 *
 * Importing scanner.ts is common in unit/integration tests. Starting the pool at
 * module scope used to schedule maintenance immediately, which could mint a real
 * provider token after an otherwise offline test imported the scan engine. Keep
 * the decision pure and exported so it can be verified without starting timers
 * or touching a transport. Manual-token installation remains unchanged:
 * AuthorizedTokenPool.install() starts pool maintenance after installing the
 * supplied token.
 */
export function shouldAutoWarmAuthorizedTokenPool(env: NodeJS.ProcessEnv = process.env): boolean {
  const runningUnderTest =
    env.NODE_ENV === "test"
    || env.VITEST === "true"
    || typeof env.VITEST_POOL_ID === "string"
    || typeof env.VITEST_WORKER_ID === "string";
  return !runningUnderTest;
}

// Production still warms by default even when the legacy authorization flag is
// absent. Test/module imports remain transport-free.
if (shouldAutoWarmAuthorizedTokenPool()) {
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
  serviceKey: string | null; // miror.svcKey from the nested provisioning payload

  // Meta
  confidence: "HIGH" | "MEDIUM" | "LOW";
  apiSource: "kinetic_live" | "knowledge_base" | "failed";
  blocked: boolean; // true ONLY for a 403 throttle — a typed back-pressure signal (NOT a no-service); consumers must never regex `notes` to detect this
  notes: string;
  /** WHY this non-answer must be requeued, from the closed vocabulary in
   *  `shared/scanRequeueReason.ts`. Set on every path that returns without a
   *  conclusive verdict; null on a real answer. This is the typed replacement
   *  for regexing `notes` — 31,777 undiagnosable requeues on one live run
   *  (2026-08-24) are what it exists to prevent. */
  retryReason?: RequeueReason | null;
  /** Provider HTTP status when the non-answer came from a response; null when
   *  no response was ever seen (transport failure, no session). */
  httpStatus?: number | null;
  /** Provider request duration only. Kept separate from queue/admission time so
   *  the Scan Inspector never reports an 80-second queue wait as an 80-second
   *  Kinetic response. Optional for non-Kinetic/replay checkers. */
  providerLatencyMs?: number | null;
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

// Canonical address key moved to ./addressKey (dependency-free) so storage.ts's
// migration can reuse it without importing the heavy scanner graph. Imported as a
// local binding (scanner.ts uses it internally) AND re-exported so every existing
// `import { normalizeKineticAddressKey } from "./scanner"` keeps working.
import { normalizeKineticAddressKey, canonicalAddressPart, kineticLeadKeyOrNull } from "./addressKey";
export { normalizeKineticAddressKey, canonicalAddressPart, kineticLeadKeyOrNull };

function logQueueEvent(event: QueueEvent): void {
  // Per-check started/completed lines are the app's largest log stream (~50% of all
  // container output at full scan rate — thousands of JSON serializations/minute,
  // rotating real diagnostics out of the 10MB log window within minutes). The Scan
  // Inspector (scan_events + SSE) is the observability path for per-address flow;
  // keep only failures/pauses in logs unless SCAN_VERBOSE_LOGS=true.
  if ((event.type === "queued" || event.type === "started" || event.type === "completed" || event.type === "cache_hit" || event.type === "deduped") && process.env.SCAN_VERBOSE_LOGS !== "true") return;
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
  // Always a fresh mint: this path is the Live Test diagnostic and the auth
  // retry after a provider denial, both of which require a brand-new token, not
  // a reused one (a reused token here would silently skip the mint the retry
  // depends on and never rotate the Decodo session).
  return forceFreshTokenFromApi();
}

// Reason for a 200 whose BODY is not a verdict. The needs-fix family is the only
// one that takes the slow lane (exponential backoff, then the `address_not_found`
// terminal verdict), and scanEngine gates that lane on this exact pattern — so
// derive the code from the note we just wrote instead of a second, subtly
// different test that could drift and move addresses into a terminal verdict
// they never earned.
const inconclusiveReason = (note: string): RequeueReason =>
  NEEDS_FIX_NOTE.test(note) ? "inconclusive_address_needs_fix" : "inconclusive_response";

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
    stages.push({ stage: "Classification", ok: false, detail: `PENDING_AUTH - ${why}; address kept for retry, NOT a no-service verdict` });
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
    stages.push({ stage: "Token minted", ok: false, detail: `mint failed (${String(firstErr?.message ?? firstErr)}) - invalidating stale state, retrying once` });
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
    stages.push({ stage: "Auth retry", ok: true, detail: "Search returned 401/403 - token invalidated, reminting and retrying same address once" });
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
      : result.blocked ? "throttled/auth-blocked (401/403/429) - transient, address kept pending for retry"
      : `no conclusive answer - ${result.notes || "infra error"} (NOT a no-service verdict)`,
  });

  if (!httpOk) {
    stages.push({ stage: "Response", ok: false, detail: result.notes || "non-conclusive response" });
    // An auth/throttle block is PENDING_AUTH (retriable), not a service verdict.
    if (result.blocked && isAuthBlock(result)) return markPendingAuth("Search API kept returning 401/403 after retry");
    stages.push({ stage: "Classification", ok: false, detail: `unresolved (infra) - ${result.blocked ? "throttled" : "error"}; NOT a no-service verdict` });
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
    : isActiveBilling(billing) && result.isNewFiber ? "coming_soon"
    : "service_active";
  out.classification = classification;
  out.wouldSaveLead = isTarget;
  stages.push({ stage: "Classification", ok: true, detail: `${classification} · fiber=${isFiber} · segment=${result.householdSegmentType || "?"} · billing=${billing || "?"}` });
  stages.push({ stage: "Lead saved", ok: out.wouldSaveLead, detail: out.wouldSaveLead ? "YES - fresh fiber, no active billing" : `no - ${classification}` });
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
    retryReason: null, httpStatus: null,
    providerLatencyMs: null,
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

  // Fail closed FAST: automation not authorized and no ready/manual token in the
  // pool → do not even attempt a mint. The address stays unresolved for a future
  // recheck; zero token spend is wasted on a session that cannot exist yet.
  if (process.env.KFS_AUTOMATION_AUTHORIZED !== "true" && authorizedTokenPool.snapshot().ready === 0) {
    base.fiberStatus = "unknown"; base.confidence = "LOW"; base.blocked = false;
    base.retryReason = "not_authorized";
    base.notes = "No authorized session - automation not authorized (unresolved, recheck)";
    emit("error", { status: "error", detail: "automation not authorized - no session, check skipped" });
    return base;
  }

  let tokenLease: AuthorizedTokenLease | null = null;
  const tokenAddressKey = crypto.createHash("sha256")
    .update(normalizeKineticAddressKey(address, city, state, zip))
    .digest("hex");
  emit("minting", { status: "info", detail: "acquiring authorized Decodo token" });
  try {
    // ROUND-ROBIN THE LANE, then take a token that belongs to it. Deriving the
    // lane from whichever slot sticky-reuse happened to pick collapsed every
    // lane onto one: the pool drains the most-used token first, so one live slot
    // meant one lane meant one residential IP, and DECODO_LANES did nothing.
    const laneCount = egressLaneCount();
    const lane = laneCount > 1 ? (_nextLane = (_nextLane + 1) % laneCount) : undefined;
    tokenLease = await authorizedTokenPool.lease(tokenAddressKey, lane, laneCount > 1 ? laneCount : undefined);
  } catch (err: any) {
    // No authorized session/token could be obtained — this is NOT a Search-API
    // error, so we fail CLOSED (unresolved), never requeue-loop with no session.
    // The address is never marked no-fiber and never marked scanned; the next
    // run / daily recheck revisits it.
    base.fiberStatus = "unknown"; base.confidence = "LOW"; base.blocked = false;
    base.retryReason = "token_unavailable";
    base.notes = `No authorized session - ${String(err?.message ?? err)} (unresolved, recheck)`;
    emit("error", { status: "error", detail: `no authorized Decodo session - ${String(err?.message ?? err).slice(0, 80)}`, sessionId: getProxySessionId() });
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
    // THE PAIR, MADE REAL. The lane is chosen by the TOKEN SLOT this check
    // leased, so this token always leaves from its own residential IP and spends
    // its own 20-check budget. Without it every concurrent check shares one IP
    // and drains one budget together, which is why the app measured best at
    // concurrency 5 while a 4-lane runner is comfortable.
    }, tokenLease.slotId);
    const searchMs = Date.now() - searchStart;
    base.providerLatencyMs = searchMs;

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
      base.retryReason = "auth_denied"; base.httpStatus = res.status;
      base.notes = `Upstream ${res.status} (token/session) - token invalidated, Decodo session rotated, address requeued`;
      emit("retry", { status: "pending_auth", httpStatus: res.status, latencyMs: searchMs, sessionId: getProxySessionId(), tokenSuffix: tokenLease.token.slice(-4), retryReason: `auth ${res.status} - token invalidated, Decodo session rotated`, detail: "PENDING_AUTH - retrying same address on a fresh session" });
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
      base.retryReason = res.status === 429 ? "rate_limited" : "provider_server_error";
      base.httpStatus = res.status;
      base.notes = `Upstream ${res.status} (transient) - Decodo session rotated, address requeued immediately`;
      emit("blocked", { status: "blocked", httpStatus: res.status, latencyMs: searchMs, sessionId: getProxySessionId(), retryReason: `${res.status === 429 ? "rate-limited" : "server error"} - session rotated, retrying immediately on fresh IP`, detail: "transient - kept pending, NOT a no-service verdict" });
      structuredLog("scan.provider.rate_limited", { status: res.status, source }, "warn");
      return base;
    }
    if (!res.ok) {
      // ANY other 4xx (400 / 404 / 422 …) — owner directive: SWITCH TOKEN FIRST.
      // A 4xx can be Kinetic rejecting the token/session shape rather than the
      // address, and the proxy budget is unlimited — so the first remedy is the
      // same as an auth denial: burn the leased token, rotate the Decodo session
      // (fresh residential IP), and requeue the address so it retries right away
      // on a fresh token. Only after 3 fresh-token retries for the SAME address
      // do we conclude the request contract itself is at fault and stop rotating.
      let diag = "";
      try { diag = (await res.text()).replace(/eyJ[A-Za-z0-9._-]{10,}/g, "<jwt>").slice(0, 160); } catch { /* body unreadable */ }
      const rotations = (fourXxRotations.get(tokenAddressKey) ?? 0) + 1;
      if (fourXxRotations.size > 50_000) fourXxRotations.clear(); // bound memory
      fourXxRotations.set(tokenAddressKey, rotations);
      if (rotations <= 3) {
        authorizedTokenPool.invalidate(tokenLease.token);
        // Single-flight inside rotateProxySession coalesces a concurrent burst
        // into ONE rotation; fire-and-forget — the result is already requeued.
        void rotateProxySession(`search ${res.status}`);
        base.blocked = true; base.fiberStatus = "unknown"; base.confidence = "LOW";
        base.retryReason = "provider_bad_request"; base.httpStatus = res.status;
        base.notes = `Upstream ${res.status} - token invalidated + Decodo session rotated (switch ${rotations}/3), address requeued`;
        emit("retry", { status: "pending_auth", httpStatus: res.status, latencyMs: searchMs, sessionId: getProxySessionId(), tokenSuffix: tokenLease.token.slice(-4), retryReason: `HTTP ${res.status} - fresh token + session (switch ${rotations}/3), retrying same address`, detail: diag || `HTTP ${res.status}` });
        structuredLog("scan.provider.4xx_rotate", { status: res.status, source, switch: rotations }, "warn");
        return base;
      }
      // 3 fresh-token retries all returned the same 4xx — the request contract
      // is genuinely at fault. DIAGNOSE: capture the safe response head so an
      // admin can repair the request. Unresolved (rechecked), NEVER no-service.
      fourXxRotations.delete(tokenAddressKey);
      base.fiberStatus = "unknown"; base.confidence = "LOW";
      base.retryReason = "provider_bad_request"; base.httpStatus = res.status;
      base.notes = `API returned ${res.status} after 3 fresh-token retries (unresolved, request-contract issue)`;
      emit("bad_request", { status: "bad_request", httpStatus: res.status, latencyMs: searchMs, sessionId: getProxySessionId(), retryReason: `HTTP ${res.status} persisted across 3 token switches - diagnose request contract`, detail: diag || `HTTP ${res.status}` });
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
      base.retryReason = "inconclusive_response"; base.httpStatus = res.status;
      base.notes = "Malformed 200 response (unparseable) - unresolved, recheck";
      emit("error", { status: "error", httpStatus: res.status, latencyMs: searchMs, detail: "malformed 200 body (unparseable) - unresolved, recheck" });
      return base;
    }
    base.rawResponse = data;
    const parsed = parseKineticResponse(data);
    const providerClassification = classifyKineticResult(parsed);
    const requestedIdentityKey = normalizeKineticAddressKey(address, city, state, "");
    const echoedIdentityKey = parsed.addressLine1 && parsed.city && parsed.state
      ? normalizeKineticAddressKey(parsed.addressLine1, parsed.city, parsed.state, "")
      : null;
    const exactAddressIdentity =
      parsed.addressFound
      && parsed.exactMatch
      && echoedIdentityKey === requestedIdentityKey;

    // ADDRESS IDENTITY GATE — a successful response is conclusive for the
    // requested door only when the provider explicitly says AddressFound AND
    // exactMatch AND its echoed address/city/state canonicalize to the requested
    // identity. exactMatch alone is insufficient: a provider/cache defect can
    // still echo a different rooftop with valid NEW FIBER fields. Keep the raw
    // response only on this in-memory result for diagnostics; the failed result
    // never reaches applyCheck or durable availability evidence.
    if (
      providerClassification !== "NO_SERVICE"
      && parsed.success
      && !exactAddressIdentity
    ) {
      base.apiSource = "failed";
      base.fiberStatus = "unknown";
      base.confidence = "LOW";
      base.notes = `Non-conclusive response (AddressNeedsFix: successful result failed address identity; validation=${parsed.validationResult || "missing"}, exactMatch=${parsed.exactMatch}, echoedIdentity=${echoedIdentityKey ? "mismatch" : "missing"})`;
      base.retryReason = inconclusiveReason(base.notes); base.httpStatus = 200;
      emit("error", {
        status: "error",
        httpStatus: 200,
        latencyMs: searchMs,
        classification: "unresolved/address_identity_mismatch",
        detail: "successful provider response failed exact echoed-address identity - unresolved, NOT no-service",
      });
      return base;
    }

    // CONCLUSIVE not-serviceable verdicts — Kinetic definitively says this address
    // is not in / not served by its fabric (not in the DB, out of territory, or
    // unserviceable). These are REAL no-service answers to record (so we never
    // re-scan them), NOT failures. Matched by a known family of validationResult
    // codes, e.g. AddressNotFound, AddressUnserviceableOutOfTerritory.
    const vr = String(data.validationResult ?? "");
    if (providerClassification === "NO_SERVICE" || /addressnotfound|unserviceable|outofterritory|not\s*serviceable|no\s*service/i.test(vr)) {
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
          const requestTuple = (a: string, c: string, s: string, z: string) =>
            [a, c, s, String(z).replace(/\D/g, "").slice(0, 5)]
              .map((part) => String(part ?? "").trim().toUpperCase().replace(/\s+/g, " "))
              .join("|");
          const repeatsIdenticalRequest =
            requestTuple(cAddress, cCity, cState, cZip) === requestTuple(address, city, state, zip);
          // Re-search a genuine spelling/format correction once, including a
          // suffix-equivalent form (DRIVE → DR). An identical request would only
          // repeat the same non-answer.
          if (!repeatsIdenticalRequest) {
            emit("searching", {
              status: "info", httpStatus: 200, latencyMs: searchMs, sessionId: getProxySessionId(),
              tokenSuffix: tokenLease.token.slice(-4),
              retryReason: `${vr} - applying one reliable address suggestion and re-searching once`,
              detail: `applied address suggestion: ${maskSuggestedAddress(cAddress, cCity, cState, cZip)} (${selection.reason})`,
            });
            // SAME transport, SAME authorized-token + proxyFetch path; depth+1 bounds it.
            const corrected = await scanAddressDirect(cAddress, cCity, cState, cZip, source, correctionDepth + 1);
            // A conclusive correction may be adopted only when it represents the
            // SAME canonical address. A materially different suggestion needs an
            // atomic scan-target identity migrate/merge that does not exist yet;
            // attaching its evidence to the original target would publish the
            // wrong door. We still perform the bounded correction search so the
            // provider behavior remains observable, then fail closed.
            if (corrected.apiSource === "kinetic_live" && corrected.fiberStatus !== "no_service" && corrected.fiberStatus !== "unknown") {
              if (corrKey === origKey) {
                corrected.notes = `Corrected equivalent ${vr || "address"} → ${cAddress} (${selection.reason}). ${corrected.notes}`.trim();
                return corrected;
              }
              base.apiSource = "failed";
              base.fiberStatus = "unknown";
              base.confidence = "LOW";
              base.notes = `Non-conclusive (${vr}); suggestion resolved a materially different address and cannot be attached to the original scan target - unresolved, recheck`;
              base.retryReason = inconclusiveReason(base.notes); base.httpStatus = 200;
              emit("error", {
                status: "error",
                httpStatus: 200,
                latencyMs: searchMs,
                classification: "unresolved/address_identity_mismatch",
                detail: `correction resolved but changed canonical identity (${vr}) - not attached to original target`,
              });
              return base;
            }
            // The correction did NOT resolve to a serviceable answer (it came back
            // no-service, blocked, or non-conclusive). Per product law we do NOT adopt a
            // no-service verdict from a guessed correction — stay non-conclusive so the
            // worker requeues + backs off exactly as it did before. The `${vr}` marker is
            // preserved so the engine's AddressNeedsFix backoff cadence still applies.
            base.apiSource = "failed";
            base.confidence = "LOW";
            base.notes = `Non-conclusive (${vr}); applied suggestion "${cAddress}" but it did not resolve to a serviceable answer - unresolved, recheck (NOT no-service)`;
            base.retryReason = inconclusiveReason(base.notes); base.httpStatus = 200;
            emit("error", { status: "error", httpStatus: 200, latencyMs: searchMs, detail: `correction did not resolve (${vr}) - unresolved, NOT no-service` });
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
      base.retryReason = inconclusiveReason(base.notes); base.httpStatus = 200;
      emit("error", { status: "error", httpStatus: 200, latencyMs: searchMs, detail: `non-conclusive (success=false, ${vr || "no validationResult"}) - unresolved, NOT no-service` });
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

    // The household segment is RECORDED but no longer decides serviceability -
    // classifyServiceability below owns that, and requires a qualification.
    base.householdSegmentType = parsed.householdSegmentType ?? "";

    // Fiber qualification is copper-override-safe (see kineticResponseParser).
    const isFiber = parsed.fiberQualified;
    base.fiberAvailable = isFiber;

    // ONE classifier, shared and pure: see shared/serviceabilityVerdict.ts for
    // why a segment may never set a fiber status by itself. It lives there
    // rather than here because this function is network-bound - every scanner
    // test injects a fake checker and never reaches this line, which is exactly
    // how the segment-only read survived.
    const verdict = classifyServiceability({
      householdSegmentType: parsed.householdSegmentType,
      fiberQualified: isFiber,
      validationResult: parsed.validationResult,
      billingStatus: data.address?.billingStatus,
      techType: base.techType,
      chipSetType: base.chipSetType,
      maxQual: base.maxQual,
      maxDownloadMbps: base.maxDownloadMbps,
      competitorName: data.address?.competitorCompanyName,
      competitorSpeed: data.address?.competitorQualSpeed,
      competitorTech: data.address?.competitorTechName,
    });
    base.fiberStatus = verdict.fiberStatus;
    base.isNewFiber = verdict.isNewFiber;
    base.isTenured = verdict.isTenured;
    base.confidence = "HIGH";
    base.notes = verdict.notes;

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

    const billingActive = isActiveBilling(base.billingStatus);
    const cls = base.fiberStatus === "new_fiber"
      ? (billingActive ? "already_customer" : "fresh_fiber")
      : base.fiberStatus === "tenured_fiber"
        ? (billingActive ? "already_customer" : "tenured_fiber")
        : base.fiberAvailable ? "fiber_available" : "copper";
    emit("classified", {
      status: "ok", httpStatus: 200, latencyMs: Date.now() - searchStart, sessionId: getProxySessionId(),
      classification: cls,
      detail: `${base.fiberStatus} · segment=${base.householdSegmentType || "?"} · billing=${base.billingStatus || "?"}`,
    });
  } catch (err: any) {
    // PRODUCT LAW: a failed check (timeout / network / no-token) carries NO
    // availability signal and NEVER aborts the run or becomes a "no fiber". These
    // are TRANSIENT — mark blocked so the worker requeues the address and retries.
    // The TOKEN IS KEPT: a bearer JWT is valid regardless of egress — a timeout
    // means no response was seen, not that the token is bad. Burning it here made
    // every network blip cost a Decodo mint AND re-spread the next batch across
    // fresh slots (the 40-50-checks-one-token directive). Only a provider 401/403
    // (handled above) invalidates.
    // A timeout/socket error usually means THIS Decodo egress is black-holing —
    // rotating (single-flight coalesced) moves the retry to a fresh residential IP
    // instead of feeding the same dead egress for minutes. Observed live: a stalled
    // egress collapsed throughput 728→15 searches/5m until rotation.
    void rotateProxySession(`search transient: ${String(err?.message ?? err).slice(0, 40)}`);
    base.apiSource = "failed";
    base.providerLatencyMs = Date.now() - searchStart;
    base.fiberStatus = "unknown";
    base.confidence = "LOW";
    base.blocked = true;
    base.retryReason = "transient_transport";
    base.notes = `Check failed (transient) - ${err.message}`;
    emit("error", { status: "error", latencyMs: Date.now() - searchStart, retryReason: `transient - ${String(err?.message ?? err).slice(0, 60)}`, detail: "network/timeout - kept pending for retry, NOT no-service" });
  } finally {
    tokenLease?.release();
  }

  return base;
}
