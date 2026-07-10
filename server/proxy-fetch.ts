/**
 * Proxy-aware fetch wrapper — MAXIMUM PERFORMANCE build
 *
 * Key tuning vs previous version:
 *  - 200 connections (was 50)       → 4x more parallel proxy slots
 *  - pipelining = 2 (was 1)         → 2 in-flight requests per socket
 *  - connect timeout = 5s (was 8s)  → fail fast, recycle slots faster
 *  - request timeout = 5s (was 7s)  → same
 *  - keepAliveTimeout = 60s (was 30s) → fewer reconnects under load
 *
 * Effective throughput: 200 sockets × 2 pipeline = ~400 simultaneous checks
 * At 200ms avg Kinetic API response = ~2,000 checks/sec theoretical max
 */

let _ProxyAgent: any = null;
let _undiciFetch: any = null;
let _proxyLoaded = false;
let _sharedDispatcher: any = null;

const POOL_SIZE = 200;          // 200 sockets — 4x previous
const PIPELINE  = 2;            // 2 requests in-flight per socket
const CONN_TIMEOUT = 5_000;     // 5s connect timeout — fail fast
const KEEP_ALIVE  = 60_000;     // 60s keepalive — fewer reconnects under load

function buildAgent(proxyUrl: string) {
  return new _ProxyAgent({
    uri: proxyUrl,
    connections: POOL_SIZE,
    pipelining: PIPELINE,
    keepAliveTimeout: KEEP_ALIVE,
    keepAliveMaxTimeout: 90_000,
    maxRedirections: 2,
    connect: {
      timeout: CONN_TIMEOUT,
      // TLS verification is ON by default so a MITM on the proxy egress can't
      // capture the Kinetic bearer token / KFS_AUTH_BASIC. Only an explicit
      // PROXY_INSECURE_TLS=true opt-in disables it (some proxies need it).
      rejectUnauthorized: process.env.PROXY_INSECURE_TLS !== "true",
    },
  });
}

async function loadUndici() {
  if (_proxyLoaded) return;
  try {
    const undici = await import("undici");
    _ProxyAgent  = undici.ProxyAgent;
    _undiciFetch = undici.fetch;
    _proxyLoaded = true;

    const proxyUrl = process.env.PROXY_URL;
    if (proxyUrl && _ProxyAgent) {
      _sharedDispatcher = buildAgent(proxyUrl);
      console.log(`[proxy-fetch] Pool created: ${POOL_SIZE} connections × ${PIPELINE} pipeline = ${POOL_SIZE * PIPELINE} slots`);
    }
  } catch {
    console.warn("[proxy-fetch] undici not available — falling back to native fetch");
    _proxyLoaded = true;
  }
}

loadUndici();

export async function proxyFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const proxyUrl = process.env.PROXY_URL;

  // When a proxy is configured it is REQUIRED: we must never silently fall back
  // to a direct request. A direct call would de-anonymize the origin IP (getting
  // it blocked) and break the "authorized outbound transport only" guarantee. So
  // if the proxy path fails we retry once (on a socket reset) and otherwise THROW
  // — fail closed — rather than leaking the request out our own IP.
  if (proxyUrl) {
    if (!_undiciFetch) throw new Error("[proxy-fetch] PROXY_URL set but undici unavailable — refusing a direct (de-anonymized) request");
    if (!_sharedDispatcher) _sharedDispatcher = buildAgent(proxyUrl);
    try {
      return await _undiciFetch(url, { ...opts, dispatcher: _sharedDispatcher } as any) as unknown as Response;
    } catch (err: any) {
      if (err?.message?.includes("destroyed") || err?.message?.includes("closed") || err?.message?.includes("reset")) {
        _sharedDispatcher = buildAgent(proxyUrl);
        console.log("[proxy-fetch] Pool rebuilt after socket reset");
        return await _undiciFetch(url, { ...opts, dispatcher: _sharedDispatcher } as any) as unknown as Response;
      }
      throw err; // fail closed — do NOT go direct
    }
  }

  // No proxy configured (local/dev): a direct request is the intended behaviour.
  return fetch(url, opts);
}

export function getProxyStatus(): { enabled: boolean; url: string | null; slots: number } {
  const proxyUrl = process.env.PROXY_URL;
  return {
    enabled: !!proxyUrl && !!_sharedDispatcher,
    url: proxyUrl ? proxyUrl.replace(/:[^:@]+@/, ":****@") : null,
    slots: POOL_SIZE * PIPELINE,
  };
}
