/** Shared transport for the authorized Decodo residential proxy. ALL provider
 * traffic (token mint + address search) egresses through Decodo — the server's
 * own IP is never used for provider calls. The application-level provider queue
 * remains the true concurrency control. On an authenticated denial the caller
 * asks for a fresh authorized Decodo SESSION (rotateProxySession): the dispatcher
 * is rebuilt so subsequent requests open new connections and Decodo's rotating
 * residential gateway hands out a fresh egress IP. This obtains a new authorized
 * session per the provider agreement; it never bypasses an actual upstream denial. */

import { noteProxyAuthFailure, noteProxySuccess, recordProxyResponse, setProxyRotateHook } from "./bandwidthGovernor";

let _ProxyAgent: any = null;
let _undiciFetch: any = null;
let _proxyLoaded = false;
let _sharedDispatcher: any = null;
// Monotonic session counter — bumped every time the Decodo dispatcher is rebuilt
// (a fresh authorized session). Exposed MASKED for the Scan Inspector diagnostics.
let _sessionSeq = 1;
// Single-flight guard so concurrent auth failures trigger exactly one rotation.
let _rotateInFlight: Promise<void> | null = null;
// Proactive rotation cadence: retire the Decodo egress IP set every N proxied
// requests so it never accumulates enough traffic to hit the per-IP rolling-window
// throttle. 0 disables. Tunable without redeploy via PROXY_ROTATE_EVERY.
// Unlimited Decodo budget → rotate aggressively so no residential egress IP ever
// accumulates enough traffic to trip the per-IP rolling-window throttle. There is
// no usage cap: fresh IPs are free, throttled IPs are not.
const PROACTIVE_ROTATE_EVERY = boundedInt(process.env.PROXY_ROTATE_EVERY, 10, 0, 100_000);
let _reqSinceRotate = 0;
// Minimum spacing between session rotations. rebuildDispatcher throws away every
// warm keep-alive connection, so a rotation storm (sequential 403s/timeouts, each
// past the single-flight window) made every following request pay a cold
// TCP+CONNECT+TLS handshake against the 5s search timeout — pushing checks into
// the abort path, which rotated again. The single-flight guard only coalesces
// CONCURRENT callers; this also throttles SEQUENTIAL ones.
const ROTATE_MIN_INTERVAL_MS = boundedInt(process.env.ROTATE_MIN_INTERVAL_MS, 4_000, 0, 120_000);
let _lastRotateAt = 0;

// Sized to support the raised global search window. The distributed
// coordinator, not this socket pool, remains the authoritative system ceiling.
const POOL_SIZE = boundedInt(process.env.PROXY_POOL_CONNECTIONS, 100, 1, 500);
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

// ── STICKY DECODO SESSIONS (Cloudflare workaround, verified live) ───────────
// Per-connection rotation makes EVERY request roll the IP-reputation dice
// fresh (measured: 87% of checks 403'd during a wall). Cloudflare reputation
// is sticky per egress IP — a clean IP stays clean for many minutes. So we
// ride ONE residential IP per 15-minute window (Decodo `session-<id>` username
// suffix) and rotate the id on schedule — or immediately on an auth denial,
// which was already the behavior via rotateProxySession(). A bad IP is
// retired in seconds; a good one is used at full speed instead of being
// thrown away after a single request. DECODO_STICKY=off restores per-
// connection rotation.
const STICKY_MS = Math.max(60_000, Number(process.env.DECODO_STICKY_MINUTES ?? 15) * 60_000);
let _stickyId = Math.random().toString(36).slice(2, 10);
let _stickyUntil = Date.now() + STICKY_MS;

function stickyProxyUrl(base: string): string {
  if (process.env.DECODO_STICKY === "off") return base;
  try {
    if (Date.now() > _stickyUntil) {
      _stickyId = Math.random().toString(36).slice(2, 10);
      _stickyUntil = Date.now() + STICKY_MS;
      console.log(`[proxy-fetch] sticky session window expired → new sticky id`);
    }
    const u = new URL(base);
    if (!u.username) return base;
    // Avoid double-stick if the operator baked a session into the URL already.
    if (u.username.includes("-session-")) return base;
    u.username = `${u.username}-session-${_stickyId}-sessionduration-30`;
    return u.toString();
  } catch { return base; }
}

/** Exposed for diagnostics: the current sticky session window (masked). */
export function stickySessionInfo(): { id: string; untilMs: number } {
  return { id: _stickyId.slice(0, 4) + "…", untilMs: Math.max(0, _stickyUntil - Date.now()) };
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
      _sharedDispatcher = buildAgent(stickyProxyUrl(proxyUrl));
      console.log(`[proxy-fetch] Pool created: ${POOL_SIZE} connections × ${PIPELINE} pipeline = ${POOL_SIZE * PIPELINE} slots`);
    }
  } catch {
    console.warn("[proxy-fetch] undici not available — falling back to native fetch");
    _proxyLoaded = true;
  }
}

// Keep the load promise: early callers AWAIT it instead of racing it. In the
// compiled CJS bundle the token pool's boot-time warm-up mint reached
// proxyFetch before this async import settled, threw "undici unavailable",
// and (via an uncaught maintenance-timer rejection) killed the prod process.
const undiciReady = loadUndici();

export async function proxyFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const proxyUrl = configuredProxyUrl();

  // When an authorized proxy is configured it is required for that deployment:
  // never silently change egress after a transport failure. Retry one broken
  // socket pool, then fail closed and let the caller surface a non-answer.
  if (proxyUrl) {
    if (!_proxyLoaded) await undiciReady;
    // Still unavailable after a completed load = undici truly missing: fail
    // closed rather than ever sending an unproxied direct request.
    if (!_undiciFetch) throw new Error("[proxy-fetch] PROXY_URL set but undici unavailable — refusing an unconfigured direct request");
    if (!_sharedDispatcher) _sharedDispatcher = buildAgent(stickyProxyUrl(proxyUrl));
    // Count this request toward the proactive-rotation cadence, but DON'T rotate
    // before dispatching it — the request that trips the counter must run on the
    // existing WARM dispatcher, and the rotation happens AFTER the response so
    // the fresh (connectionless) session is paid for by the NEXT request, not
    // this interactive one. Verified in prod: a fresh dispatcher searches 200
    // while a long-lived one 403s; we retire the IP set, just not mid-request.
    // Sticky mode: NO request-count rotation — the 15-min sticky window +
    // denial-driven rebuilds govern egress changes. Rotating every 10 requests
    // (the legacy default) would throw away the clean IP we just rode in on.
    const shouldProactiveRotate =
      process.env.DECODO_STICKY === "off" &&
      PROACTIVE_ROTATE_EVERY > 0 && ++_reqSinceRotate >= PROACTIVE_ROTATE_EVERY;
    if (shouldProactiveRotate) _reqSinceRotate = 0;
    try {
      const res = await _undiciFetch(url, { ...opts, dispatcher: _sharedDispatcher } as any) as unknown as Response;
      // Bandwidth governor: ledger every proxied response; a 407 from the
      // Decodo gateway means auth/limit denial — feed the circuit breaker so
      // scanning suspends instead of hammering a dead account.
      try {
        const cl = Number((res as any).headers?.get?.("content-length") ?? 0) || 0;
        if (res.status === 407) noteProxyAuthFailure();
        else { noteProxySuccess(); recordProxyResponse(cl); }
      } catch { /* metrics must never break the transport */ }
      // Rotate for the NEXT request, off the hot path.
      if (shouldProactiveRotate) void rotateProxySession("proactive");
      return res;
    } catch (err: any) {
      if (err?.message?.includes("destroyed") || err?.message?.includes("closed") || err?.message?.includes("reset")) {
        rebuildDispatcher(proxyUrl);
        console.log("[proxy-fetch] Pool rebuilt after socket reset");
        return await _undiciFetch(url, { ...opts, dispatcher: _sharedDispatcher } as any) as unknown as Response;
      }
      // Decodo rejects the CONNECT tunnel itself on auth/limit denials, so a
      // 407 surfaces here as a thrown error, never as a response above.
      try {
        const msg = String(err?.message ?? "") + String(err?.cause?.message ?? "");
        if (msg.includes("407")) noteProxyAuthFailure();
      } catch { /* metrics must never break the transport */ }
      throw err; // fail closed — do NOT go direct
    }
  }

  // No proxy resolved from env. In PRODUCTION this is a misconfiguration, and
  // going direct would expose the server IP for provider traffic — so FAIL CLOSED.
  // Dev/test (and an explicit ALLOW_DIRECT_EGRESS=true opt-in) may egress directly
  // so the suite + local dev run without a Decodo account.
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DIRECT_EGRESS !== "true") {
    throw new Error("[proxy-fetch] No Decodo proxy configured in production — refusing direct egress (fail closed)");
  }
  return fetch(url, opts);
}

// Replace the shared dispatcher with a freshly-built one and bump the session id.
// New requests open new connections, so Decodo's rotating residential gateway
// assigns a fresh egress IP — a fresh authorized session.
function rebuildDispatcher(proxyUrl: string): void {
  const old = _sharedDispatcher;
  // A rebuild is almost always denial-driven (403/socket reset): the whole
  // point is a FRESH egress IP. Force a new sticky id here — the time-based
  // window only applies to undisturbed operation, never to a rotate.
  if (process.env.DECODO_STICKY !== "off") {
    _stickyId = Math.random().toString(36).slice(2, 10);
    _stickyUntil = Date.now() + STICKY_MS;
  }
  _sharedDispatcher = buildAgent(stickyProxyUrl(proxyUrl));
  _sessionSeq++;
  // Graceful, fire-and-forget close of the old pool so in-flight requests finish
  // on it while new traffic moves to the fresh session. Never awaited.
  if (old && typeof old.close === "function") { old.close().catch(() => {}); }
}

async function doRotate(proxyUrl: string, reason?: string): Promise<void> {
  if (!_proxyLoaded) await undiciReady;
  if (!_ProxyAgent) return; // undici missing → nothing to rotate (fails closed elsewhere)
  rebuildDispatcher(proxyUrl);
  console.log(`[proxy-fetch] Decodo session rotated → #${_sessionSeq}${reason ? ` (${reason})` : ""}`);
}

/**
 * Obtain a fresh authorized Decodo session (new residential egress IP). Called by
 * the scanner on an authenticated denial (401/403) so the immediate retry leaves
 * the throttled IP behind. Single-flight: concurrent callers coalesce into ONE
 * rebuild, so a burst of auth failures never triggers a rotation storm.
 * No-op when no proxy is configured (local/dev). Never exposes the server IP.
 *
 * NOTE: the in-flight reset runs in a `.finally` attached AFTER the assignment
 * below (never inside the promise body). doRotate can complete SYNCHRONOUSLY when
 * undici is already loaded; if the reset lived in the body's `finally`, it would
 * run BEFORE `_rotateInFlight = done` and leave a resolved promise pinned forever,
 * silently disabling all future rotations (the exact bug that stalled the scan).
 */
export async function rotateProxySession(reason?: string): Promise<void> {
  const proxyUrl = configuredProxyUrl();
  if (!proxyUrl) return;
  if (_rotateInFlight) return _rotateInFlight;
  // Min-interval throttle for SEQUENTIAL callers (single-flight above only
  // covers concurrent ones). Within the window we skip the rebuild entirely so
  // the warm keep-alive pool survives — a burst of transient errors can't strip
  // every connection and make the next check pay a cold handshake. A 401/403
  // that lands inside the window still leaves that specific token invalidated
  // by the caller; only the (redundant) session rebuild is suppressed.
  const now = Date.now();
  if (ROTATE_MIN_INTERVAL_MS > 0 && now - _lastRotateAt < ROTATE_MIN_INTERVAL_MS) return;
  _lastRotateAt = now;
  const done = doRotate(proxyUrl, reason);
  _rotateInFlight = done;
  void done.catch(() => {}).finally(() => { if (_rotateInFlight === done) _rotateInFlight = null; });
  return done;
}

/** Test-only: reset rotation throttle state between cases. */
export function __resetRotationStateForTests(): void {
  _lastRotateAt = 0;
  _reqSinceRotate = 0;
  _rotateInFlight = null;
}

// In unlimited-plan mode the bandwidth governor rotates (instead of freezing) on
// an auth/limit-denial burst. Register the single-flight rotation here so it can
// do that without importing this transport (circular). Registered once at load.
setProxyRotateHook((reason) => { void rotateProxySession(reason); });

/** Masked, safe session identifier for diagnostics — no IP, no credentials. */
export function getProxySessionId(): string {
  return `decodo-s${_sessionSeq}`;
}

/** True when a Decodo proxy is configured AND a live dispatcher exists. */
export function isProxyConnected(): boolean {
  return !!configuredProxyUrl() && !!_sharedDispatcher;
}

export function getProxyStatus(): { enabled: boolean; url: string | null; slots: number; sessionId: string } {
  const proxyUrl = configuredProxyUrl();
  return {
    enabled: !!proxyUrl && !!_sharedDispatcher,
    url: proxyUrl ? proxyUrl.replace(/:[^:@]+@/, ":****@") : null,
    slots: POOL_SIZE * PIPELINE,
    sessionId: getProxySessionId(),
  };
}
