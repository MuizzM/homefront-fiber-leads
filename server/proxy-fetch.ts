/** Shared transport for an authorized fixed egress proxy. The application-level
 * provider queue remains the true concurrency control; this pool only reuses
 * sockets and never rotates identities or bypasses an upstream denial. */

let _ProxyAgent: any = null;
let _undiciFetch: any = null;
let _proxyLoaded = false;
let _sharedDispatcher: any = null;

// Sized to support the globally selected 40–50 search window. The distributed
// coordinator, not this socket pool, remains the authoritative system ceiling.
const POOL_SIZE = boundedInt(process.env.PROXY_POOL_CONNECTIONS, 50, 1, 100);
const PIPELINE = boundedInt(process.env.PROXY_PIPELINING, 1, 1, 2);
const CONN_TIMEOUT = 5_000;     // 5s connect timeout — fail fast
const KEEP_ALIVE  = 60_000;     // 60s keepalive — fewer reconnects under load

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

export function proxyUrlFromEnv(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.PROXY_URL?.trim();
  if (explicit) return explicit;
  const host = env.DECODO_HOST?.trim();
  const port = env.DECODO_PORT?.trim();
  const password = env.DECODO_PASS?.trim();
  const country = env.DECODO_COUNTRY?.trim() || "us";
  const template = env.DECODO_USERNAME_TEMPLATE?.trim();
  const username = env.DECODO_USER?.trim()
    || template?.replace(/\{country\}/gi, country).replace(/\$\{country\}/gi, country);
  if (!host || !port || !username || !password) return null;
  const protocol = env.DECODO_PROTOCOL?.trim() || "http";
  if (!/^(https?|socks5)$/i.test(protocol)) throw new Error("Unsupported DECODO_PROTOCOL");
  return `${protocol.toLowerCase()}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
}

function configuredProxyUrl(): string | null {
  return proxyUrlFromEnv(process.env);
}

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
      // capture the Kinetic bearer token. Only an explicit
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

    const proxyUrl = configuredProxyUrl();
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
  const proxyUrl = configuredProxyUrl();

  // When an authorized proxy is configured it is required for that deployment:
  // never silently change egress after a transport failure. Retry one broken
  // socket pool, then fail closed and let the caller surface a non-answer.
  if (proxyUrl) {
    if (!_undiciFetch) throw new Error("[proxy-fetch] PROXY_URL set but undici unavailable — refusing an unconfigured direct request");
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
  const proxyUrl = configuredProxyUrl();
  return {
    enabled: !!proxyUrl && !!_sharedDispatcher,
    url: proxyUrl ? proxyUrl.replace(/:[^:@]+@/, ":****@") : null,
    slots: POOL_SIZE * PIPELINE,
  };
}
