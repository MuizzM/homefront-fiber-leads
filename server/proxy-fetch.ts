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
// Running on 10000 is fatal for this workload, though NOT for the reason first
// assumed. The original theory was that a Kinetic token is bound to the IP that
// minted it. Measured 2026-08-23, that is false: a token minted on one
// residential IP searched 20/20 from a different one, and a server-IP mint
// searched 20/20 through a residential proxy. Tokens are portable.
//
// What the rotating gateway actually costs us is the ability to RIDE an IP. The
// limit is on search volume per residential address (~20-30 checks, see
// CHECKS_PER_IP), and on 10000 every request lands on a stranger - so we pay a
// cold IP of unknown reputation every single time instead of spending a known
// good one down to its budget. Measured end to end on Rockwell doors:
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

// ── PARALLEL EGRESS LANES ────────────────────────────────────────────────────
//
// Kinetic throttles one (IP, token) PAIR at about 20 answers. One dispatcher on
// one port means every concurrent check in the process shares a single
// residential IP and drains that single budget together - which is why the app
// measured best at concurrency 5 while the standalone runner does 4 lanes
// comfortably: the runner gives each lane its own port and its own token.
//
// A LANE IS A PORT. Lane i rides its own sticky port with its own dispatcher and
// its own check budget, so N lanes are N independent pairs running at once.
// Lanes are bound to TOKEN SLOTS by the caller (slot i -> lane i), which is what
// makes the pair real rather than nominal: retiring lane i retires only the
// token minted against it.
//
// HOW MANY LANES THE ACCOUNT ACTUALLY SUSTAINS, measured 2026-08-25 against
// us.decodo.com, one request per port, all ports fired at once:
//
//     lanes   ok/total   distinct IPs   wall    p50      p95
//         8       8/8              8   1.4s   1190ms   1425ms
//        16     16/16             16   1.8s   1148ms   1786ms
//        32     32/32             32   3.0s   1418ms   2510ms
//        64     64/64             63   3.0s   1360ms   2057ms
//       128   128/128            128   3.2s   1331ms   2307ms
//       256   256/256            255   4.1s   1164ms   2231ms
//       512   436/512            435   4.4s   1228ms   2051ms   (76 x curl rc 7)
//
// Flat latency to 256 and one distinct residential IP per port: Decodo was never
// the constraint, this process holding ONE dispatcher was. The 512 failures were
// connect errors from firing 512 concurrent curls on one laptop, so they bound
// that machine rather than the account.
//
// The ceiling here is 64, well under the measured 256, because a lane is not
// free on THIS side: each one builds its own undici pool. See POOL_SIZE below,
// which divides across lanes for exactly that reason.
//
// DECODO_LANES=1 (the default) is exactly the previous behaviour: one lane,
// lane 0, sharing the single dispatcher path below.
const LANE_COUNT = () => boundedInt(process.env.DECODO_LANES, 1, 1, 64);

interface EgressLane { id: number; offset: number; dispatcher: any; checks: number; }
const _lanes = new Map<number, EgressLane>();

/** How many lanes this process is running. */
export function egressLaneCount(): number { return LANE_COUNT(); }

/** Lane ids are dense and small; a caller's slot id maps onto one. */
export function laneFor(key: number): number {
  const lanes = LANE_COUNT();
  return lanes <= 1 ? 0 : ((Math.abs(Math.floor(key)) % lanes) + lanes) % lanes;
}

/** The port a lane rides: the process offset, stepped once per lane. */
function lanePort(lane: EgressLane): number {
  return stickyPortBase() + ((_stickyPortOffset + lane.offset) % stickyPortCount());
}

function laneUrl(base: string, lane: EgressLane): string {
  if (process.env.DECODO_STICKY === "off") return base;
  try {
    const u = new URL(base);
    if (!u.username || u.username.includes("-session-")) return base;
    u.port = String(lanePort(lane));
    return u.toString();
  } catch { return base; }
}

function getLane(id: number, proxyUrl: string): EgressLane {
  const existing = _lanes.get(id);
  if (existing) return existing;
  // offset id keeps lanes on DIFFERENT ports: two lanes on one IP would halve
  // each other's budget, which is the bug this whole design exists to avoid.
  const lane: EgressLane = { id, offset: id, dispatcher: null, checks: 0 };
  lane.dispatcher = buildAgent(laneUrl(proxyUrl, lane), LANE_COUNT());
  _lanes.set(id, lane);
  return lane;
}

/** Hand lane `id` a fresh residential IP and clear its budget. */
function retireLane(lane: EgressLane, proxyUrl: string): void {
  const old = lane.dispatcher;
  // Step past every lane at once so no two lanes ever collide on a port.
  lane.offset += LANE_COUNT();
  lane.checks = 0;
  lane.dispatcher = buildAgent(laneUrl(proxyUrl, lane), LANE_COUNT());
  if (old && typeof old.close === "function") old.close().catch(() => {});
  _sessionSeq++;
  if (_generationHook) {
    // Only this lane's token is spent, not the whole pool's.
    try { _generationHook(`lane ${lane.id} -> port ${lanePort(lane)}`, lane.id, LANE_COUNT()); }
    catch { /* the token pool must never break the transport */ }
  }
}

/** Diagnostics: what every lane is riding right now. */
export function getLaneState(): Array<{ id: number; port: number; checks: number }> {
  return [..._lanes.values()].map(lane => ({ id: lane.id, port: lanePort(lane), checks: lane.checks }));
}

/** The sticky port this process is currently riding. */
function currentStickyPort(): number {
  return stickyPortBase() + (_stickyPortOffset % stickyPortCount());
}

/** Move to the next residential IP by stepping to the next sticky port. */
function advanceStickyPort(): void {
  _stickyPortOffset = (_stickyPortOffset + 1) % stickyPortCount();
  _stickyUntil = Date.now() + STICKY_MS;
  _checksOnThisIp = 0;
}

// A RESIDENTIAL IP GIVES ABOUT 20 ANSWERS, THEN REFUSES - AND RECOVERS.
//
// Measured twice. First across five sticky ports driven to exhaustion, counting
// HTTP status (longest clean streak 20/20/20/21/30; every IP that died had
// delivered ~30 successes). Then again against the real Kinetic serviceability
// API, 40 addresses per arm, classifying the RESPONSE BODY rather than the
// status - because a 200 carrying "AddressNotFound" is not an answer:
//
//   arm                                    real answers   403s
//   A  mint IP-1 / search IP-1                  20          20
//   B  mint IP-1 / search IP-2  (MISMATCH)      20          20
//   C  mint IP-2 / search IP-2  (IP-2 spent)    10          30
//   D  mint SERVER IP / search IP-1             20          20
//
// Every fresh IP gave exactly 20 real answers and then started refusing. C got
// half that because arm B had already spent IP-2. D got a full 20 from IP-1 -
// which A had already exhausted - because B and C took minutes in between, so
// the IP had replenished. The budget is per-IP and time-recovering, not a
// lifetime cap.
//
// Two things this DISPROVED, both of which the design briefly rested on:
//   - tokens are NOT bound to their minting IP (arm B is the proof, on real
//     AddressFound verdicts with echoed addresses, not on status codes);
//   - a server-IP mint pairs fine with a residential search (arm D), so mints
//     belong on the direct rung where they cost no residential budget at all.
//
// What remains true is the reason to ride one IP: spend a known-good address
// down to its budget instead of paying a cold stranger on every request.
// An isolated denial still means nothing - see DECODO_ROTATE_AFTER_DENIALS.
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

// WHICH RESIDENTIAL IP ARE WE ACTUALLY ON?
//
// The port selects one; it never tells us which. An operator watching the live
// view wants the address itself - it is the only way to see, rather than
// assume, that provider traffic is not leaving from this building.
//
// Resolved by asking Decodo's own echo endpoint THROUGH the proxy, at most once
// per sticky port, and only when someone is actually looking (the diagnostics
// endpoint pulls it). It is a diagnostic, not a check, so it must not spend the
// IP's ~20-answer budget - hence the exclusion below alongside mints.
const EGRESS_ECHO_URL = () => process.env.DECODO_ECHO_URL?.trim() || "https://ip.decodo.com/json";
function isDiagnosticUrl(u: string): boolean {
  try { return new URL(u).host === new URL(EGRESS_ECHO_URL()).host; }
  catch { return false; }
}
let _egressIp: { port: number | null; ip: string | null; at: number; error: string | null } = { port: null, ip: null, at: 0, error: null };
let _egressIpInFlight: Promise<void> | null = null;

/** The last known public IP for the port we are on, or null until it resolves.
 * Carries WHY when it could not: a silent null is indistinguishable from a slow
 * one, and that ambiguity has cost this codebase enough already. */
export function getEgressIp(): { ip: string | null; forPort: number | null; at: number | null; error: string | null } {
  const port = process.env.DECODO_STICKY === "off" ? null : currentStickyPort();
  if (_egressIp.port !== port) return { ip: null, forPort: port, at: null, error: null };
  return { ip: _egressIp.ip, forPort: _egressIp.port, at: _egressIp.at || null, error: _egressIp.error };
}

/**
 * Resolve the current egress IP if we do not already know it for this port.
 * Single-flight, best-effort, never throws: a diagnostic that breaks scanning
 * would be a poor trade for a label.
 */
export async function refreshEgressIp(): Promise<void> {
  const port = process.env.DECODO_STICKY === "off" ? null : currentStickyPort();
  if (_egressIp.port === port && _egressIp.ip) return;
  if (_egressIpInFlight) return _egressIpInFlight;
  const done = (async () => {
    try {
      const res = await proxyFetch(EGRESS_ECHO_URL(), { signal: AbortSignal.timeout(8_000) });
      const body: any = await res.json().catch(() => null);
      const ip = typeof body?.proxy?.ip === "string" ? body.proxy.ip
        : typeof body?.ip === "string" ? body.ip : null;
      _egressIp = { port, ip, at: Date.now(), error: ip ? null : `echo ${res.status} had no ip field` };
    } catch (err: any) {
      _egressIp = { port, ip: null, at: Date.now(), error: String(err?.message ?? err).slice(0, 80) };
    }
  })();
  _egressIpInFlight = done;
  void done.finally(() => { if (_egressIpInFlight === done) _egressIpInFlight = null; });
  return done;
}

/**
 * Has this IP been ridden past its time window?
 *
 * The expiry used to live inside stickyProxyUrl(), which is only ever called
 * when a dispatcher is BUILT - and rebuildDispatcher() advances the port
 * immediately beforehand, resetting the deadline. So the test was always false
 * and DECODO_STICKY_MINUTES never fired once, while the deploy manifest claimed
 * "time-based refresh still cycles IPs in an orderly way". It is checked on the
 * REQUEST path now, which is where time actually passes.
 */
function stickyWindowExpired(): boolean {
  return process.env.DECODO_STICKY !== "off" && Date.now() > _stickyUntil;
}

function stickyProxyUrl(base: string): string {
  if (process.env.DECODO_STICKY === "off") return base;
  try {
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
 * Whether the mint SHOULD ride the proxy is a separate question: tokens are
 * portable (measured 2026-08-23), and minting from the server IP is both
 * cleaner and free of any residential budget. This exists so that a caller
 * which does egress through the proxy uses the SAME IP the searches are on,
 * rather than a stranger from the rotating gateway. Returns null when no proxy
 * is configured.
 */
export function currentEgressProxyUrl(): string | null {
  const base = configuredProxyUrl();
  return base ? stickyProxyUrl(base) : null;
}

/** Exposed for diagnostics: the current sticky session window (masked). */

function buildAgent(proxyUrl: string, lanes = 1) {
  return new _ProxyAgent({
    uri: proxyUrl,
    // POOL_SIZE is the budget for the PROCESS, not for each lane. Handing every
    // lane the full 100 would open 1,600 sockets at 16 lanes; a lane only ever
    // carries its own checks, so it needs its share. Floor of 4 so a lane can
    // still pipeline a little.
    connections: lanes > 1 ? Math.max(4, Math.floor(POOL_SIZE / lanes)) : POOL_SIZE,
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

export async function proxyFetch(url: string, opts: RequestInit = {}, laneId = 0): Promise<Response> {
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
    // Multi-lane: each lane has its own port, dispatcher and budget, so N pairs
    // run at once instead of N checks sharing one IP. One lane means the shared
    // dispatcher, byte for byte the previous behaviour.
    const lanesOn = LANE_COUNT() > 1;
    const lane = lanesOn ? getLane(laneFor(laneId), proxyUrl) : null;
    const dispatcher = lane ? lane.dispatcher : _sharedDispatcher;
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
      const res = await _undiciFetch(url, { ...opts, dispatcher });
      // Bandwidth governor: ledger every proxied response; a 407 from the
      // Decodo gateway means auth/limit denial — feed the circuit breaker so
      // scanning suspends instead of hammering a dead account.
      try {
        const cl = Number(res.headers?.get?.("content-length") ?? 0) || 0;
        if (res.status === 407) noteProxyAuthFailure();
        else { noteProxySuccess(); recordProxyResponse(cl); }
        // A 2xx proves THIS egress IP is still welcome: forgive its earlier
        // denials so an occasional 403 never accumulates into a rotation.
        //
        // But NOT a mint's 2xx. The mint endpoint answers happily from an IP
        // whose search quota is exhausted, so counting it would let one healthy
        // mint erase a run of search denials and keep a burnt IP in service
        // forever. Only a real check earns the forgiveness.
        if (res.status >= 200 && res.status < 300 && !isMintUrl(url) && !isDiagnosticUrl(url)) _denialStreak = 0;
        // ...and spend one unit of the IP's budget. Retiring on a COUNT while
        // the IP is still healthy beats discovering it is spent from a run of
        // denials (see CHECKS_PER_IP for the measurements).
        // The budget counts CHECKS, never mints.
        //
        // Counting every proxied request burned IPs for nothing: a rotation
        // forces a re-mint, and a mint is itself a proxied request - up to four
        // with its retry ladder - so it spent the budget it had just reset and
        // triggered another retirement. Measured live at budget 5: 58 handovers
        // for 30 checks, entire IPs consumed without a single check run on them.
        // (Tokens are portable across IPs, so a handover does not require a
        // re-mint at all; the pool is retired on its own ~20-answer budget.)
        //
        // The counter is also reset HERE, synchronously at the decision, rather
        // than in advanceStickyPort() inside the async retire - otherwise every
        // response landing in that gap re-arms the flag and queues another one.
        if (process.env.DECODO_STICKY !== "off" && !isMintUrl(url) && !isDiagnosticUrl(url)) {
          const budget = CHECKS_PER_IP();
          if (lane) {
            // Each lane spends its OWN budget and retires on its own, so a busy
            // lane never shortens a quiet one.
            if (budget > 0 && ++lane.checks >= budget) retireLane(lane, proxyUrl);
          } else if (budget > 0 && ++_checksOnThisIp >= budget) {
            _checksOnThisIp = 0;
            _ipBudgetSpent = true;
          }
        }
      } catch { /* metrics must never break the transport */ }
      // Rotate for the NEXT request, off the hot path - never mid-request: a
      // fresh dispatcher has no warm connections, so the request that trips the
      // counter must finish on the pool it rode in on.
      if (!lane) {
        if (shouldProactiveRotate) void rotateProxySession("proactive");
        else if (_ipBudgetSpent) { _ipBudgetSpent = false; void retireStickyIp(); }
        else if (stickyWindowExpired()) void retireStickyIp();
      }
      return res;
    } catch (err: any) {
      if (err?.message?.includes("destroyed") || err?.message?.includes("closed") || err?.message?.includes("reset")) {
        if (lane) {
          // Rebuild THIS lane's pool on THIS lane's port. Rebuilding the shared
          // dispatcher here fixed an egress the request never used, and going
          // through rebuildDispatcher would advance the port for every lane.
          // No port change: a dropped tunnel is not evidence the IP is spent.
          const stale = lane.dispatcher;
          lane.dispatcher = buildAgent(laneUrl(proxyUrl, lane), LANE_COUNT());
          if (stale && typeof stale.close === "function") stale.close().catch(() => {});
          return await _undiciFetch(url, { ...opts, dispatcher: lane.dispatcher });
        }
        rebuildDispatcher(proxyUrl);
        console.log("[proxy-fetch] Pool rebuilt after socket reset");
        return await _undiciFetch(url, { ...opts, dispatcher: _sharedDispatcher });
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

// ── NO CARRIER REQUEST LEAVES FROM THIS BOX ─────────────────────────────────
// Owner directive 2026-08-24: all carrier traffic goes through Decodo, always.
//
// Decodo's sticky ports ARE residential IPs - that is what the account buys -
// so "residential" and "Decodo" are the same egress here. What is NOT Decodo is
// the machine's own connection, and until this gate existed three carrier paths
// used it by DEFAULT: the two direct mint rungs in server/scanner.ts and
// Frontier's direct-first serviceability call. A fourth, the Kinetic directory
// poll in server/kineticMarketCatalog.ts, had no switch at all.
//
// Direct carrier egress is now opt-IN. A deployment that forgets to set anything
// gets Decodo, which is the safe direction: the failure mode of the old default
// was silent (the logs still said the request went out, never that it went out
// from here), and a blocked home or server IP is not something you can rotate.
//
// CARRIER_DIRECT_EGRESS=on restores the hybrid ladder for an operator who wants
// it back - see docs/SCAN_OPERATIONS.md. It is deliberately ONE switch: the
// measured tradeoff (curl-impersonate direct mints 6/6 from a clean IP and spend
// no residential search budget) applies to the whole class, not per call site.
export function directCarrierEgressAllowed(): boolean {
  return process.env.CARRIER_DIRECT_EGRESS === "on";
}

/**
 * The ONE way to make an unproxied carrier request. Throws unless direct egress
 * is explicitly allowed, so a caller cannot leak by forgetting to check - the
 * gate lives at the point of egress rather than at each call site.
 */
export async function directCarrierFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!directCarrierEgressAllowed()) {
    throw new Error("[proxy-fetch] direct carrier egress is off (CARRIER_DIRECT_EGRESS is not \"on\") - route this through proxyFetch");
  }
  return fetch(url, init);
}

// ── ONE IP, ONE TOKEN, TWENTY CHECKS ────────────────────────────────────────
// Owner directive 2026-08-24, and the measurement agrees. Against the live
// search API, 60 addresses per arm, reading the response BODY:
//
//   one TOKEN, fresh IP every 20 ......... 20/60   (33%)
//   one IP, fresh TOKEN every 20 ......... 35/60   (58%)
//   fresh TOKEN + fresh IP every 20 ...... 60/60   (100%)
//
// What Kinetic throttles is the PAIR, so the pair is what has to be retired -
// together, not on two counters that happen to share the number 20. They used
// to drift: this module counts every proxied check, while the token pool counts
// distinct addresses, so a generation was rarely one clean (IP, token).
//
// The IP is the authoritative half. Its counter is a SUPERSET of the token's -
// retries and denials spend it too - so at equal budgets the IP always reaches
// 20 first, and coupling in this one direction is enough. Registered by
// server/scanner.ts; a no-op until then, and never called during a rebuild that
// does not actually change the IP.
// laneId is the token slot whose pair just ended; undefined means every lane
// (the whole-process rotation paths, which retire one shared IP).
// (reason, laneId, laneCount). laneId undefined means every lane: the shared
// rotation paths move the whole process. When a lane IS named, laneCount comes
// with it, because the slots riding lane L are every slot where
// slotId % laneCount === L - the lane id alone cannot identify them, and
// indexing the slot array with it retires an idle slot in silence.
let _generationHook: ((reason: string, laneId?: number, laneCount?: number) => void) | null = null;
export function setEgressGenerationHook(hook: (reason: string, laneId?: number, laneCount?: number) => void): void {
  _generationHook = hook;
}

// Replace the shared dispatcher with a freshly-built one and bump the session id.
// New requests open new connections, so Decodo's rotating residential gateway
// assigns a fresh egress IP — a fresh authorized session.
function rebuildDispatcher(proxyUrl: string): void {
  const old = _sharedDispatcher;
  // A rebuild is almost always denial-driven (403/socket reset): the whole
  // point is a FRESH egress IP. Force a new sticky id here — the time-based
  // window only applies to undisturbed operation, never to a rotate.
  const ipChanged = process.env.DECODO_STICKY !== "off";
  if (ipChanged) advanceStickyPort();
  _sharedDispatcher = buildAgent(stickyProxyUrl(proxyUrl));
  _sessionSeq++;
  // EVERY LANE MOVES, OR NONE OF THEM DOES. This is the process-wide rotation
  // (denial streak, sticky window, mint transport handover). Before, it advanced
  // only the shared dispatcher and then retired the whole token pool - so every
  // token was destroyed while every lane carried on dialling the same spent IP,
  // which is the 33% arm of the measurement table. Lanes are rebuilt here so the
  // pool-wide retirement below is true.
  if (ipChanged && _lanes.size) {
    for (const lane of _lanes.values()) {
      const old = lane.dispatcher;
      lane.offset += LANE_COUNT();
      lane.checks = 0;
      lane.dispatcher = buildAgent(laneUrl(proxyUrl, lane), LANE_COUNT());
      if (old && typeof old.close === "function") old.close().catch(() => {});
    }
  }
  // A new IP ends the generation: the token minted against the old one is half
  // of a pair that no longer exists. One call site, so the rule is structural -
  // every path that changes the IP (budget spent, denial streak, sticky window,
  // transport handover) retires the token with it.
  if (ipChanged && _generationHook) {
    try { _generationHook(`egress -> port ${currentStickyPort()}`); }
    catch { /* the token pool must never break the transport */ }
  }
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

async function retireStickyIp(reason = "budget"): Promise<void> {
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
    console.log(`[proxy-fetch] sticky IP retired (${reason}) -> port ${currentStickyPort()}`);
  } finally {
    _retireInFlight = false;
  }
}

/**
 * Step to the next residential IP because THIS one cannot do the work at all -
 * not because it denied us. The caller has already established that (the mint
 * path calls this after a streak of failures that never reached the provider:
 * DNS, connect, TLS, reset, timeout).
 *
 * Deliberately the SPENT-BUDGET path, not rotateProxySession: an IP that never
 * answers produces no denials, so the denial streak it requires would never be
 * satisfied, and its min-interval throttle can drop the rebuild entirely. This
 * is a planned handover, so it is neither streak-gated nor throttled - and it is
 * still bounded by its caller, which only reaches it after N consecutive
 * failures. A denial, a challenge, or any other real provider answer must NOT
 * come through here; that remains rotateProxySession's or the caller's business.
 *
 * No-op when stickiness is off (the rotating gateway hands out a fresh IP per
 * request anyway) or when no proxy is configured (local/dev).
 */
export function advanceProxyEgress(reason: string): Promise<void> {
  return retireStickyIp(reason);
}

export async function rotateProxySession(reason?: string): Promise<void> {
  const proxyUrl = configuredProxyUrl();
  if (!proxyUrl) return;
  // On a sticky port, hold the IP until it has failed repeatedly. This is the
  // fix for the rotation death spiral: 205 denials in 57 s once meant 205 IP
  // rotations, which is exactly the per-request rotation stickiness exists to
  // prevent. The caller still invalidates its own token either way.
  if (process.env.DECODO_STICKY !== "off" && ++_denialStreak < rotateAfterDenials()) return;
  // The streak is spent only once a rotation ACTUALLY happens. Resetting it
  // here, above the guards below, meant a rotation suppressed by the
  // single-flight check or the min-interval throttle silently discarded the
  // denials that had earned it - so the next retirement needed a whole fresh
  // streak and a burnt IP stayed in service that much longer.
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
  _denialStreak = 0; // spent, because a rotation is now certain to happen
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
