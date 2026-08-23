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

// ── STICKY DECODO SESSIONS, BY PORT ─────────────────────────────────────────
// Decodo hands out sticky residential sessions through the PORT, not through a
// username suffix. Measured live 2026-08-22 against us.decodo.com:
//
//   port 10000  ->  206.204.115.128, 2601:84:847e:..., 68.201.57.149, ...
//                   a DIFFERENT residential IP on every single request
//   port 10001  ->  32.223.187.36 on every request
//   port 10002  ->  73.105.42.201        "
//   port 10005  ->  68.3.94.34           "
//   port 10100  ->  47.32.214.254        "
//
// and every username-suffix form (`-session-x`, `-session-x-sessionduration-10`,
// `-sessionduration-10-session-x`, `-sessid-x`) is REJECTED outright by 10000 -
// the connection simply fails. That is why the suffix-based stickiness written
// here originally could not work, and why DECODO_STICKY had to be set to "off"
// in production: switching it on broke every request, so it was disabled and
// the scanner has been running on the rotating gateway ever since.
//
// Running on 10000 is fatal for this workload because a Kinetic bearer token is
// bound to the IP that minted it: mint on one IP, search from another, get 403.
// Measured end to end on Rockwell doors:
//
//   port 10000 (rotating)  236 checks ->  31 x 200 (13%), 205 x 403
//   port 10001 (sticky)     80 checks ->  69 x 200 (86%),  10 x 403,
//                                         longest clean streak 30, 1.23 s/check
//
// So: pick a port from the sticky range and STAY on it. Rotation means moving to
// the NEXT PORT (a different residential IP), never re-dialling 10000.
// DECODO_STICKY=off restores the old rotating-gateway behaviour.
const STICKY_MS = Math.max(60_000, Number(process.env.DECODO_STICKY_MINUTES ?? 15) * 60_000);
// Read at CALL time, like configuredProxyUrl(): the port range is operator
// configuration, and capturing it at import makes it unreachable to anything
// that sets the env after this module is first loaded.
const stickyPortBase = () => Math.max(1, Number(process.env.DECODO_STICKY_PORT_BASE ?? 10001));
const stickyPortCount = () => Math.max(1, Number(process.env.DECODO_STICKY_PORT_COUNT ?? 100));
let _stickyPortOffset = Math.floor(Math.random() * 100);
let _stickyUntil = Date.now() + STICKY_MS;

/** The sticky port this process is currently riding. */
function currentStickyPort(): number {
  return stickyPortBase() + (_stickyPortOffset % stickyPortCount());
}

// EGRESS-CHANGE SUBSCRIBERS. proxy-fetch must not import the token pool (the
// pool's mint path comes back through here), so the dependency is inverted: the
// scanner registers a listener at load and proxy-fetch just fires it.
type EgressListener = (port: number | null) => void;
const _egressListeners: EgressListener[] = [];
export function onEgressChanged(fn: EgressListener): void { _egressListeners.push(fn); }
function fireEgressChanged(): void {
  const port = process.env.DECODO_STICKY === "off" ? null : currentStickyPort();
  for (const fn of _egressListeners) { try { fn(port); } catch { /* never break the transport */ } }
}

/** Move to the next residential IP by stepping to the next sticky port. */
function advanceStickyPort(): void {
  _stickyPortOffset = (_stickyPortOffset + 1) % stickyPortCount();
  _stickyUntil = Date.now() + STICKY_MS;
  _checksOnThisIp = 0;
  fireEgressChanged();
}

// A RESIDENTIAL IP WEARS OUT. Measured across five sticky ports, each driven
// sequentially on its own slice of doors (concurrency 1, no rotation, distinct
// addresses so the coordinator cache cannot fake a healthy result):
//
//   port    checks   ok      longest clean   outcome
//   10001      80    86%          30         survived
//   10011      41    73%          20         DIED (10 consecutive denials)
//   10023      60    88%          21         survived
//   10037      54    67%          20         DIED
//   10041      43    70%          20         DIED
//   10059      48    63%          20         DIED
//
// Two numbers matter. The longest CLEAN streak is 20 on the nose (20/20/20/21/30,
// median 20), and every IP that died had delivered exactly ~30 successes first
// (30/30/30/36). Kinetic allows roughly 30 successes per residential IP, with
// reliability falling off after about 20.
//
// So the budget is 20, not 30. Taking the last ten answers means eating 13-18
// denials for them (the 63-73% runs above), each of which costs a retry and
// feeds the fleet-shared 403-storm backoff. Stopping at 20 stays inside the
// clean streak, costs one cold handshake per rotation, and there are 100 sticky
// ports to cycle. An isolated denial is still forgiven, not acted on: 10023's
// very first check was a 403 and it went on to finish at 88%.
const CHECKS_PER_IP = () => Math.max(0, Number(process.env.DECODO_CHECKS_PER_IP ?? 20));
let _checksOnThisIp = 0;

/**
 * Is this request a session mint rather than an address check?
 *
 * Matched on the path so it holds for the default endpoint and for a
 * KFS_AUTH_URL override alike (see kineticTokenUrl in server/scanner.ts:77-81).
 * proxy-fetch cannot import the scanner - the scanner imports this module - so
 * the discriminator lives here rather than being passed down through every
 * call site.
 */
function isMintUrl(u: string): boolean {
  try { return /\/auth\/session|\/precisely\/token/.test(new URL(u).pathname); }
  catch { return false; }
}

function stickyProxyUrl(base: string): string {
  if (process.env.DECODO_STICKY === "off") return base;
  try {
    if (Date.now() > _stickyUntil) {
      advanceStickyPort();
      console.log(`[proxy-fetch] sticky window expired -> port ${currentStickyPort()}`);
    }
    const u = new URL(base);
    if (!u.username) return base;
    // An operator who baked their own session into the URL owns the choice.
    if (u.username.includes("-session-")) return base;
    u.port = String(currentStickyPort());
    return u.toString();
  } catch { return base; }
}

/**
 * The proxy URL THIS PROCESS IS ACTUALLY EGRESSING THROUGH, sticky port and all.
 *
 * proxyUrlFromEnv() returns the raw configured URL - port 10000, the rotating
 * gateway. Anything that egresses OUTSIDE proxyFetch (the curl-impersonate mint
 * ladder in server/scanner.ts is the only one today) must use this instead, or
 * it leaves from a different residential IP than the searches do.
 *
 * That is not a hypothetical: a Kinetic bearer token is bound to the IP that
 * minted it, so minting on 10000 and searching on 10001+ is the exact 403 the
 * sticky work exists to remove. Returns null when no proxy is configured.
 */
export function currentEgressProxyUrl(): string | null {
  const base = configuredProxyUrl();
  return base ? stickyProxyUrl(base) : null;
}

/** Exposed for diagnostics: the current sticky session window (masked). */

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
    console.warn("[proxy-fetch] undici not available - falling back to native fetch");
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
    if (!_undiciFetch) throw new Error("[proxy-fetch] PROXY_URL set but undici unavailable - refusing an unconfigured direct request");
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
        // A 2xx proves THIS egress IP is still welcome: forgive its earlier
        // denials so an occasional 403 never accumulates into a rotation.
        //
        // But NOT a mint's 2xx. The mint endpoint answers happily from an IP
        // whose search quota is exhausted, so counting it would let one healthy
        // mint erase a run of search denials and keep a burnt IP in service
        // forever. Only a real check earns the forgiveness.
        if (res.status >= 200 && res.status < 300 && !isMintUrl(url)) _denialStreak = 0;
        // ...and spend one unit of the IP's budget. Retiring on a COUNT while
        // the IP is still healthy beats discovering it is spent from a run of
        // denials (see CHECKS_PER_IP for the measurements).
        // The budget counts CHECKS, never mints.
        //
        // Counting every proxied request built a feedback loop that burned IPs
        // for nothing: retiring an IP drops its tokens (they are bound to it),
        // which forces a re-mint, and the mint is itself a proxied request - up
        // to four with its retry ladder - so it spent the budget it had just
        // reset and triggered another retirement. Measured live at budget 5:
        // 58 handovers for 30 checks, entire IPs consumed without a single
        // check being run on them.
        //
        // The counter is also reset HERE, synchronously at the decision, rather
        // than in advanceStickyPort() inside the async retire - otherwise every
        // response landing in that gap re-arms the flag and queues another one.
        if (process.env.DECODO_STICKY !== "off" && !isMintUrl(url)) {
          const budget = CHECKS_PER_IP();
          if (budget > 0 && ++_checksOnThisIp >= budget) {
            _checksOnThisIp = 0;
            _ipBudgetSpent = true;
          }
        }
      } catch { /* metrics must never break the transport */ }
      // Rotate for the NEXT request, off the hot path - never mid-request: a
      // fresh dispatcher has no warm connections, so the request that trips the
      // counter must finish on the pool it rode in on.
      if (shouldProactiveRotate) void rotateProxySession("proactive");
      else if (_ipBudgetSpent) { _ipBudgetSpent = false; void retireStickyIp(); }
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
    throw new Error("[proxy-fetch] No Decodo proxy configured in production - refusing direct egress (fail closed)");
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
  if (process.env.DECODO_STICKY !== "off") advanceStickyPort();
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
// How many consecutive denials retire a sticky IP. Measured on port 10001:
// 80 checks, 69 x 200 (86%), first 403 at check 15 and then a 30-check clean
// run - so ONE denial says nothing about the IP, and rotating on it throws away
// a working session and pays a cold handshake for nothing. On the rotating
// gateway (DECODO_STICKY=off) there is no IP to keep, so rotate immediately.
const rotateAfterDenials = () => Math.max(1, Number(process.env.DECODO_ROTATE_AFTER_DENIALS ?? 3));
let _denialStreak = 0;

/** Diagnostics: the sticky port in use and the current denial streak. */
export function getProxyStickyState(): { port: number | null; denialStreak: number; checksOnThisIp: number } {
  return {
    port: process.env.DECODO_STICKY === "off" ? null : currentStickyPort(),
    denialStreak: _denialStreak,
    checksOnThisIp: _checksOnThisIp,
  };
}

let _ipBudgetSpent = false;

/**
 * Retire a sticky IP whose check budget is spent. Distinct from
 * rotateProxySession: that one is the response to a DENIAL and is deliberately
 * reluctant (a streak, then a min-interval throttle). This is the opposite - a
 * planned handover while the IP is still healthy - so it must not be gated by
 * the denial streak, and it resets that streak because the next IP starts clean.
 */
let _retireInFlight = false;

async function retireStickyIp(): Promise<void> {
  const proxyUrl = configuredProxyUrl();
  if (!proxyUrl || process.env.DECODO_STICKY === "off") return;
  // Single-flight, for the same reason rotateProxySession is: concurrent
  // responses must not each hand over the IP.
  if (_retireInFlight) return;
  _retireInFlight = true;
  try {
    if (!_proxyLoaded) await undiciReady;
    if (!_ProxyAgent) return;
    _denialStreak = 0;
    _lastRotateAt = Date.now();
    rebuildDispatcher(proxyUrl); // advances the port, so a new residential IP
    console.log(`[proxy-fetch] sticky IP retired on budget -> port ${currentStickyPort()}`);
  } finally {
    _retireInFlight = false;
  }
}

export async function rotateProxySession(reason?: string): Promise<void> {
  const proxyUrl = configuredProxyUrl();
  if (!proxyUrl) return;
  // On a sticky port, hold the IP until it has failed repeatedly. This is the
  // fix for the rotation death spiral: 205 denials in 57 s once meant 205 IP
  // rotations, which is exactly the per-request rotation stickiness exists to
  // prevent. The caller still invalidates its own token either way.
  if (process.env.DECODO_STICKY !== "off" && ++_denialStreak < rotateAfterDenials()) return;
  _denialStreak = 0;
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
  _denialStreak = 0;
  _checksOnThisIp = 0;
  _ipBudgetSpent = false;
  _retireInFlight = false;
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
