import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import crypto from "crypto";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import cluster from "node:cluster";
import os from "node:os";
import { decideRespawn } from "./clusterRespawnPolicy";
import { runMigrations } from "./storage";
import { rawDb } from "./db";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import { structuredLog } from "./structuredLog";
import { anfParkedSql, provenHourlyCapacity } from "@shared/scanPolicy";
import { globalApiRateLimitMax, shouldSkipGlobalRateLimit } from "./rateLimitPolicy";

// ── Multi-core scan cluster ────────────────────────────────────────────────────
// The scan pipeline is single-threaded JavaScript (synchronous better-sqlite3 +
// parsing + classification) and pegs ONE core at ~100% while the box's other cores
// sit idle. SCAN_WORKERS>0 forks that many worker processes so scanning uses every
// core: each worker is a full Express+scan process, the kernel load-balances HTTP
// across them (SO_REUSEPORT, already set on listen), the DB-backed provider-admission
// coordinator keeps total Decodo pressure globally bounded, and Phase-0's atomic
// claimRunTargets + finalize CAS guarantee two workers can never double-scan or
// double-finalize a target. Runs distribute automatically: the CONTROL worker's
// singletons PRODUCE runs; every worker's reaper CONSUMES queued targets.
//   SCAN_WORKERS unset / 0 → single process, byte-for-byte today's behavior (the
//   code-free kill-switch). Worker index 0 is the control worker (runs producers +
//   consumers); workers 1..N-1 are scan-only consumers. HF_ROLE/HF_WORKER_INDEX are
//   set by the primary on fork.
//   SCAN_WORKERS="auto" sizes the worker count to the vCPUs detected at boot; an
//   explicit integer pins it; 0/unset stays single-process. Shared parser
//   (scanWorkers.ts) so index/db/scanner can never drift.
import { resolveScanWorkerCount } from "./scanWorkers";
import { startPrimaryElection, isPrimaryNode } from "./primaryNodeLease";
const SCAN_WORKERS = resolveScanWorkerCount();
// The control role runs the work-PRODUCING singletons (statewide sweep, radar,
// expansion, hot/frontier markets, discovery, daily refresh). True in single-process
// and only in the index-0 worker under the cluster. Work-CONSUMING resume/reaper runs
// in every process regardless.
const IS_CONTROL_ROLE = SCAN_WORKERS === 0 || process.env.HF_ROLE === "control";
// A cluster WORKER must NOT re-run migrations / coordinator boot-clean / calling
// migrations — the primary ran them exactly once before forking, and a concurrent
// merge migration would race. Single-process runs them inline as before.
const IS_CLUSTER_WORKER = SCAN_WORKERS > 0 && cluster.isWorker;

// Node <20.12 compat: Vite 7's dep optimizer calls crypto.hash(), which was
// only added in Node 20.12/21. Polyfill it so dev works on older runtimes;
// on newer Node this branch is skipped entirely.
if (typeof (crypto as any).hash !== "function") {
  (crypto as any).hash = (algorithm: string, data: crypto.BinaryLike, outputEncoding: crypto.BinaryToTextEncoding = "hex") =>
    crypto.createHash(algorithm).update(data).digest(outputEncoding);
}

// ── Never die on a stray async failure ───────────────────────────────────────
// Node's default kills the process on an unhandled rejection; for a field app
// a background transient (token mint, proxy hiccup) must never take the whole
// server down. Log loudly instead — the failed work already surfaced its own
// error to its caller. (uncaughtException still exits: state is unknown.)
process.on("unhandledRejection", (reason) => {
  structuredLog("process.unhandled_rejection", {
    error: String((reason as any)?.stack ?? reason).slice(0, 600),
  }, "error");
});

const app = express();
const httpServer = createServer(app);

// ── Trust the reverse proxy in production ─────────────────────────────────────
// Behind nginx/Caddy/Render/Fly/etc. the real client IP arrives in
// X-Forwarded-For. Without this, per-IP rate limiting keys off the proxy's IP
// (defeating it) and express-rate-limit throws a validation error. Trust one
// hop by default in production; override with TRUST_PROXY (e.g. 2 for a CDN in
// front of a load balancer). Disabled in dev where there is no proxy.
app.set(
  "trust proxy",
  process.env.TRUST_PROXY !== undefined
    ? (isNaN(Number(process.env.TRUST_PROXY)) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY))
    : (process.env.NODE_ENV === "production" ? 1 : false),
);

// ── CORS — tight origin allowlist ─────────────────────────────────────────────
// Driven entirely by env so a standalone deployment (e.g. homefrontsolutionsllc.com)
// isn't pinned to a specific host provider. APP_ORIGIN is the canonical site
// origin; EXTRA_ORIGINS is an optional comma-separated list for embeds/staging.
const ALLOWED_ORIGINS = [
  process.env.APP_ORIGIN,
  // The public careers site submits unauthenticated applications into the same
  // tenant-scoped portal queue. Auth still uses an explicit session header, not
  // ambient cookies, so allowing this first-party origin does not grant account
  // access.
  "https://www.homefrontsolutionsllc.com",
  "https://homefrontsolutionsllc.com",
  ...(process.env.EXTRA_ORIGINS?.split(",").map(s => s.trim()).filter(Boolean) ?? []),
].filter(Boolean) as string[];

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // same-origin / curl / server-side — allow
  if (process.env.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

// All API routes: strict origin allowlist
app.use("/api", cors({
  origin: (origin, cb) => cb(null, originAllowed(origin)),
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-session-id", "x-csrf-token"],
}));

// ── Security headers (helmet) ─────────────────────────────────────────────
// ── Gzip compression — ~70% smaller JSON payloads for map/leads endpoints ────
app.use(compression({ threshold: 1024 })); // compress responses > 1KB

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-eval'", "blob:", "https://api.mapbox.com"],   // Mapbox GL CDN
      scriptSrcElem:  ["'self'", "'unsafe-inline'", "blob:", "https://api.mapbox.com"],   // Mapbox GL <script> tag
      workerSrc:      ["'self'", "blob:"],   // service worker (PWA offline shell)
      manifestSrc:    ["'self'"],            // installable web app manifest
      styleSrc:       ["'self'", "'unsafe-inline'", "https://api.mapbox.com", "https://fonts.googleapis.com"],
      styleSrcElem:   ["'self'", "'unsafe-inline'", "https://api.mapbox.com", "https://fonts.googleapis.com"],
      imgSrc:         ["'self'", "data:", "blob:", "https://*.mapbox.com", "https://*.mapbox.cn"],
      connectSrc:     ["'self'", "https://*.mapbox.com", "https://events.mapbox.com"],
      fontSrc:        ["'self'", "data:", "https://fonts.gstatic.com"],
      objectSrc:      ["'none'"],
      mediaSrc:       ["'none'"],
      frameSrc:       ["'none'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'"],
      // Standalone deployments frame only themselves. Set EMBED_ANCESTORS
      // (comma-separated) if the app must be embedded by another origin.
      frameAncestors: ["'self'", ...(process.env.EMBED_ANCESTORS?.split(",").map(s => s.trim()).filter(Boolean) ?? [])],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "cross-origin" }, // allow font/image assets
  noSniff: true,
  // X-Frame-Options: DENY as legacy-browser clickjacking defense. Modern
  // browsers that support CSP ignore X-Frame-Options when frame-ancestors is
  // present, so the allowed embeds above (self/perplexity) still work there;
  // older browsers without frame-ancestors support fall back to DENY.
  frameguard: { action: "deny" },
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },  // 2 years
  dnsPrefetchControl: { allow: false },
  referrerPolicy: { policy: "no-referrer" },
  permittedCrossDomainPolicies: { permittedPolicies: "none" },
}));

// ── Cache-Control: no-store on all API routes (prevent browser caching of sensitive data) ──
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// ── Permissions-Policy: geolocation MUST be allowed for our own origin — the map's
// "locate me" blue dot (Mapbox GeolocateControl → navigator.geolocation, used in
// LiveMap/geoFix/mapPins) is core to field reps. geolocation=(self) permits it for
// THIS site only; empty () blocked it in every browser (iOS Safari most strictly).
// Camera stays () — lead-photo uses a file-input (capture="environment"), not
// getUserMedia, so it needs no grant. mic/payment/usb/FLoC stay disabled.
app.use((_req, res, next) => {
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(self), payment=(), usb=(), interest-cohort=()");
  // Extra hardening headers not covered by Helmet defaults
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  next();
});

// ── Remove fingerprinting headers ────────────────────────────────────────────
app.disable("x-powered-by");

// ── CSRF: double-submit cookie pattern for all state-changing API calls ────────
// Every non-GET API call must carry X-CSRF-Token matching the session token.
// The client reads the CSRF token from the GET /api/auth/status response
// and sends it back on every mutation. Since JS can read it (same origin),
// but a cross-site attacker cannot, this is a solid CSRF defense.
const CSRF_EXEMPT = new Set([
  "/api/auth/otp/request",
  "/api/auth/otp/verify",
  "/api/auth/setup",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/onboarding/apply",    // public form
  "/join",
  "/api/billing/webhook/stripe", // Stripe-signed webhook — authenticated by HMAC signature, not a session
  "/api/payouts/webhook/stripe", // Stripe Connect webhook — HMAC-signed, not a session
]);
// ── Request ID — one correlation id per request, echoed to the client and used
// in every server log line so a failure can be traced end to end. Honors an
// upstream x-request-id (from a load balancer) or mints a fresh UUID.
app.use((req, res, next) => {
  const rid = (req.headers["x-request-id"] as string) || crypto.randomUUID();
  (req as any).id = rid;
  res.setHeader("x-request-id", rid);
  next();
});

app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (CSRF_EXEMPT.has(req.path)) return next();
  const sessionId = req.headers["x-session-id"] as string | undefined;
  const csrfToken = req.headers["x-csrf-token"] as string | undefined;
  // If no session, let requireAuth handle 401
  if (!sessionId) return next();
  // CSRF token must match session ID (double-submit pattern)
  if (!csrfToken || csrfToken !== sessionId) {
    return res.status(403).json({ error: "CSRF validation failed" });
  }
  next();
});

// ── Response sanitizer — defense-in-depth: strip ALL sensitive fields from every API response ──
// Prevents passwordHash, tokens, stack traces, and vendor URLs leaking via network tab.
const BLOCKED_FIELDS = new Set([
  "passwordHash", "password_hash", "password", "tempPassword",
  "stack", "trace", "errno", "syscall",
  "KFS_AUTH_BASIC", "SCANNER_SUBMIT_SECRET", "SMTP_PASS",
  "RESEND_API_KEY",
  "kfsAuthBasic", "scannerSecret", "mapboxToken", "enrichmentApiKey",
]);
const REDACT_PATTERNS: RegExp[] = [
  /https?:\/\/[^\s"']*gokinetic[^\s"']*/gi,
  /gokinetic\.com/gi,
  /Basic [A-Za-z0-9+/=]{20,}/g,
  /Bearer eyJ[A-Za-z0-9._-]{20,}/g,
  /eyJ[A-Za-z0-9._-]{40,}/g,
  /pk\.eyJ[A-Za-z0-9._-]{20,}/g, // Mapbox public tokens — served via /api/config/map only
];
function sanitizeVal(v: any): any {
  if (v === null || v === undefined) return v;
  if (typeof v === "string") {
    let s = v;
    for (const re of REDACT_PATTERNS) { re.lastIndex = 0; s = s.replace(re, "[redacted]"); }
    return s;
  }
  if (Array.isArray(v)) return v.map(sanitizeVal);
  if (typeof v === "object") {
    const out: any = {};
    for (const [k, val] of Object.entries(v)) {
      if (BLOCKED_FIELDS.has(k)) continue;
      out[k] = sanitizeVal(val);
    }
    return out;
  }
  return v;
}
// Endpoints whose entire purpose is to deliver a secret/token to the
// authorized client (already gated by requireAuth/requireManager). The
// redaction patterns above would otherwise mangle their payload — e.g. the
// Mapbox pk.* token matches /pk\.eyJ.../ and would be replaced with
// "[redacted]", handing the map an invalid token and crashing MapView.
const SANITIZE_EXEMPT_PATHS = new Set([
  "/api/config/map",
  // Fixed server-owned projection with no secret fields. Skipping the generic
  // recursive sanitizer avoids cloning up to 5,000+ rows before serialization.
  "/api/leads/map",
  // These manager-only endpoints intentionally return the candidate-specific
  // application URL so an operator can copy it. The URL's HMAC token looks
  // JWT-like to the generic redactor but grants only one pre-account application.
  "/api/onboarding/invitations",
  "/api/onboarding/pipeline",
]);
app.use((req, res, next) => {
  if (SANITIZE_EXEMPT_PATHS.has(req.path)
      || /^\/api\/onboarding\/invitations\/\d+\/resend$/.test(req.path)
      // This response intentionally contains the short-lived, tenant/user/
      // lead-bound one-use authorization. The generic JWT-looking-string
      // scrubber would otherwise replace it with "[redacted]" and make the
      // compliant manual-call flow unusable.
      || /^\/api\/v1\/calling\/leads\/\d+\/authorize-call$/.test(req.path)) return next();
  const origJson = res.json.bind(res);
  res.json = function(body: any) { return origJson(sanitizeVal(body)); };
  next();
});

// ── Global rate limit: mobile/shared-NAT safe, env-tunable for ops ────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: globalApiRateLimitMax(process.env.API_RATE_LIMIT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again in 15 minutes." },
  // In development, Vite serves hundreds of module files through this same
  // Express app; counting them exhausts the budget in a couple of reloads and
  // 429s the whole app. Only meter API traffic in dev — prod ships a bundle,
  // so the global limit still guards every request there.
  // Login has its own tighter IP + email limiters below. Keeping auth outside
  // this general bucket prevents normal map/polling traffic from locking the
  // user out of the only way to authenticate.
  skip: (req) => shouldSkipGlobalRateLimit(req.path, process.env.NODE_ENV),
  // Key on req.ip — with `trust proxy` set, Express resolves the real client from
  // the RIGHTMOST trusted hop. The old leftmost X-Forwarded-For parse was
  // client-spoofable (prepend a fake IP → dodge the limit), so never use raw XFF.
  keyGenerator: (req) => {
    const ip = req.ip ?? req.socket.remoteAddress;
    return ip ? ipKeyGenerator(ip) : "unknown";
  },
}));

// ── Strict auth rate limit: failed attempts only; email limits live in route ─
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again in 15 minutes." },
  skipSuccessfulRequests: true,
});

// ── OTP network limit: generous enough for shared NAT; per-email remains 5 ──
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 50,
  message: { error: "Too many code requests. Wait 10 minutes." },
});


// Attach limiters to auth routes before registerRoutes runs
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/setup", authLimiter);
app.use("/api/auth/otp/request", otpLimiter);
app.use("/api/auth/otp/verify", authLimiter);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// ── Body size limits — prevent DoS via oversized payloads ────────────────────
// Stripe webhooks (billing + Connect payouts) can exceed 64 KB — an invoice or
// subscription event with many line items. Parse those two paths at a higher limit
// (still capturing rawBody for HMAC verification) BEFORE the global 64 KB parser,
// so a large signed event isn't 413'd before its signature is ever checked.
app.use(
  ["/api/billing/webhook/stripe", "/api/payouts/webhook/stripe"],
  express.json({ limit: "1mb", verify: (req, _res, buf) => { req.rawBody = buf; } }),
);
// Admin address-dataset uploads are explicitly capped at 10 MB and parsed
// before the normal 64 KB API limit. Authorization still runs in the route;
// this exception exists only for the documented CSV/GeoJSON ingestion surface.
app.use(
  "/api/discovery/uploads",
  express.json({
    limit: Math.max(64 * 1024, Math.min(10 * 1024 * 1024, Number(process.env.DISCOVERY_UPLOAD_MAX_BYTES) || 10 * 1024 * 1024)),
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }),
);
app.use(
  express.json({
    limit: "64kb",   // API JSON payloads: 64 KB max
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "32kb" }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

// ── Request logger — method + path + status + duration ONLY, never response body ──
// Response bodies may contain sessionIds, tokens, or PII — never log them.
app.use((req, res, next) => {
  const start = performance.now();
  const reqPath = req.path;
  res.on("finish", () => {
    if (reqPath.startsWith("/api")) {
      const rid = ((req as any).id as string | undefined)?.slice(0, 8) ?? "--------";
      structuredLog("http.request", {
        requestId: rid,
        method: req.method,
        path: reqPath,
        status: res.statusCode,
        durationMs: Number((performance.now() - start).toFixed(2)),
      });
    }
  });
  next();
});

(async () => {
  // ── CLUSTER PRIMARY: control-plane bootstrap + supervisor only ────────────────
  // Runs the one-time migrations/coordinator-clean/calling-migrations EXACTLY ONCE
  // (before any worker exists, so no concurrent-writer race), forks the workers, and
  // supervises them (respawn on crash, forward SIGTERM). It does NOT serve HTTP or
  // scan. Only entered when SCAN_WORKERS>0; single-process falls straight through.
  if (SCAN_WORKERS > 0 && cluster.isPrimary) {
    // Defer the heavy scan_targets uniqueness rebuild until workers are
    // already serving (health gate safe); everything else runs here as before.
    process.env.DEFER_ADDR_UNIQUENESS_MIGRATION = "on";
    runMigrations();
    // Reclaim any WAL left by the previous run NOW, while the primary is the
    // only connection (no reader can starve the TRUNCATE), then start the
    // file-size-based WAL guard here in the primary: its event loop is a
    // near-idle supervisor, so a blocking checkpoint stalls no HTTP or scans.
    // (See db.ts — the 2026-07-23 12GB-WAL disk-full incident.)
    {
      const { bootWalCheckpoint, startWalGuard } = await import("./db");
      bootWalCheckpoint();
      startWalGuard();
      // Disk/WAL pressure sampler — one per box, same owner as the guard.
      // Interval-driven (first tick 30s out); nothing heavy runs at boot.
      const { startResourceSentinel } = await import("./resourcePressure");
      startResourceSentinel();
      // Yield-rollup maintenance (index builds + street_key/neg_streak
      // backfill) — chunked, sentinel-gated, interval-only. Runs in the
      // PRIMARY: its near-idle loop can absorb the one-time blocking index
      // builds that would stall an HTTP-serving worker.
      const { startYieldRollupMaintenance } = await import("./yieldRollups");
      startYieldRollupMaintenance();
      // ADDRESS REPAIR LANE — INDEPENDENT of YIELD_ROLLUPS. It was originally
      // wired inside the rollup tick, so YIELD_ROLLUPS=off silently disabled
      // it (observed live: the repair columns were never even created). It
      // owns its own bounded, sentinel-aware timer in the primary.
      if (process.env.ADDRESS_REPAIR_LANE !== "off") {
        const { runAddressRepairPass, ensureRepairSchema } = await import("./addressRepairLane");
        try { ensureRepairSchema(); } catch (e: any) { console.warn("[address-repair] schema:", e?.message); }
        const repairTimer = setInterval(() => {
          try { runAddressRepairPass(Math.max(50, Number(process.env.ADDRESS_REPAIR_BATCH) || 300)); }
          catch (e: any) { console.warn("[address-repair] pass failed:", e?.message); }
        }, Math.max(30_000, Number(process.env.ADDRESS_REPAIR_TICK_MS) || 120_000));
        if (typeof (repairTimer as any).unref === "function") (repairTimer as any).unref();
      }
    }
    try { const { coordinatorBootClean } = await import("./distributedProviderCoordinator"); coordinatorBootClean(); }
    catch (e: any) { console.warn("[coordinator] boot clean skipped:", e?.message); }
    try { const { runCallingMigrations } = await import("./calling/migrations"); runCallingMigrations(); }
    catch (e: any) { console.error("[cluster] calling migrations failed in primary:", e?.message); process.exit(1); }
    let primaryDown = false;
    // Per-index crash-loop state: a worker that dies almost immediately after
    // fork is crash-looping (bad boot state, unrunnable migration). Respawning
    // it every 1s forever pegs the box and floods the logs. We back off
    // exponentially on RAPID crashes and PARK a hopelessly-looping index, while
    // resetting the backoff the moment a worker proves it can stay up.
    const CRASH_MIN_HEALTHY_MS = Math.max(5_000, Number(process.env.SCAN_WORKER_MIN_HEALTHY_MS) || 60_000);
    const CRASH_MAX_RAPID = Math.max(2, Number(process.env.SCAN_WORKER_MAX_RAPID_CRASHES) || 8);
    const CRASH_BACKOFF_CAP_MS = 60_000;
    const crashState = new Map<number, { rapid: number; parkedLogged: boolean }>();
    const forkWorker = (index: number) => {
      const w = cluster.fork({ HF_ROLE: index === 0 ? "control" : "scan", HF_WORKER_INDEX: String(index) });
      (w as any).__hfIndex = index;
      (w as any).__hfForkedAt = Date.now();
      return w;
    };
    for (let i = 0; i < SCAN_WORKERS; i++) forkWorker(i);
    const heavyTimer = setTimeout(() => {
      void import("./storage").then((m) => m.runDeferredMigrations());
    }, 150_000);
    if (typeof heavyTimer.unref === "function") heavyTimer.unref();
    structuredLog("cluster.primary_started", {
      workers: SCAN_WORKERS, pid: process.pid,
      vcpus: os.availableParallelism?.() ?? os.cpus().length,
      totalRamMb: Math.round(os.totalmem() / 1_048_576),
      scanWorkersEnv: String(process.env.SCAN_WORKERS ?? ""),
    });
    cluster.on("exit", (w, code, signal) => {
      const index = (w as any).__hfIndex ?? 0;
      console.warn(`[cluster] worker index=${index} pid=${w.process.pid} exited (code=${code} signal=${signal ?? "none"})`);
      // Immediately expire the dead worker's QUEUED admission rows. Its rows would
      // otherwise keep aging in the priority rank (their own admission-timeout code
      // died with the process) and stall NORMAL admission until the coordinator's
      // staleness reaper catches them (~60-90s). The coordinator instanceId is
      // "<pid>-<uuid8>", and the primary knows the pid right now. Best-effort.
      try {
        rawDb.prepare(`UPDATE provider_admission_queue SET state='expired',last_error='worker exited',updated_at=? WHERE state='queued' AND instance_id LIKE ?`)
          .run(Date.now(), `${w.process.pid}-%`);
      } catch { /* table may not exist on a fresh DB — the staleness reaper covers it */ }
      if (!primaryDown) {
        const uptime = Date.now() - ((w as any).__hfForkedAt ?? 0);
        const st = crashState.get(index) ?? { rapid: 0, parkedLogged: false };
        const decision = decideRespawn(index, uptime, { rapid: st.rapid }, {
          minHealthyMs: CRASH_MIN_HEALTHY_MS, maxRapid: CRASH_MAX_RAPID, backoffCapMs: CRASH_BACKOFF_CAP_MS,
        });
        st.rapid = decision.rapid;
        crashState.set(index, st);
        if (decision.action === "park") {
          if (!st.parkedLogged) {
            st.parkedLogged = true;
            structuredLog("cluster.worker_parked", { index, rapidCrashes: st.rapid, reason: "crash loop" });
            console.error(`[cluster] worker index=${index} PARKED after ${st.rapid} rapid crashes — not respawning (SCAN_WORKER_MAX_RAPID_CRASHES to tune)`);
          }
          return; // stop respawning this hopeless index; the rest of the fleet runs on
        }
        if (st.rapid > 0) {
          structuredLog("cluster.worker_backoff", { index, rapidCrashes: st.rapid, delayMs: decision.delayMs });
        }
        const t = setTimeout(() => { if (!primaryDown) forkWorker(index); }, decision.delayMs);
        if (typeof (t as any).unref === "function") (t as any).unref();
      }
    });
    const stopPrimary = (sig: string) => {
      if (primaryDown) return; primaryDown = true;
      const n = Object.keys(cluster.workers ?? {}).length;
      console.log(`[cluster] ${sig} received — forwarding to ${n} worker(s)`);
      for (const id in cluster.workers) { try { cluster.workers[id]?.kill("SIGTERM"); } catch {} }
      // Give workers longer than their own 10s drain cap, then exit.
      const t = setTimeout(() => process.exit(0), 12_000);
      if (typeof (t as any).unref === "function") (t as any).unref();
    };
    process.on("SIGTERM", () => stopPrimary("SIGTERM"));
    process.on("SIGINT", () => stopPrimary("SIGINT"));
    return; // primary never runs the worker body below
  }

  // Migrations run once per DB: in single-process here, in the cluster PRIMARY above.
  // A cluster WORKER must skip them (they already ran; a concurrent merge migration
  // would race) but still needs every migrated table to exist — which it does, since
  // the primary completed all migrations before forking this worker.
  if (!IS_CLUSTER_WORKER) runMigrations();
  // Clear stale admission/lock/rate rows left by the previous container. This ran
  // implicitly inside the coordinator's ensureSchema() before; it now lives in an
  // explicit call so the cluster primary can run it EXACTLY ONCE before forking
  // workers (a worker must never wipe its siblings' live locks). Single-process
  // runs it here; the cluster primary ran it above; cluster workers skip it.
  if (!IS_CLUSTER_WORKER) {
    try { const { coordinatorBootClean } = await import("./distributedProviderCoordinator"); coordinatorBootClean(); }
    catch (e: any) { console.warn("[coordinator] boot clean skipped:", e?.message); }
  }
  // The Calling/DNC schema is a strict transactional migration. If it cannot
  // be created and verified, startup stops: serving a half-migrated compliance
  // system would be less safe than remaining offline. Cluster workers skip the
  // CALL (primary already migrated) but keep the import for the purge/audit hooks.
  const { runCallingMigrations } = await import("./calling/migrations");
  if (!IS_CLUSTER_WORKER) runCallingMigrations();
  // Provider contracts can require prompt deletion of cached payloads even
  // when no representative opens Calling. Run a bounded global cleanup at
  // startup and hourly; durable usage/cost/audit metadata is preserved.
  const { purgeExpiredProviderPayloads } = await import("./calling/providers");
  const purgeCallingProviderPayloads = () => {
    try {
      let result = { purged: 0, hasMore: true };
      let purged = 0;
      for (let batch = 0; batch < 10 && result.hasMore; batch += 1) {
        result = purgeExpiredProviderPayloads({ batchSize: 500 });
        purged += result.purged;
      }
      if (purged > 0 || result.hasMore) structuredLog("calling.provider_payload_retention", { purged, hasMore: result.hasMore });
    } catch (error) {
      structuredLog("calling.provider_payload_retention_failed", {
        message: error instanceof Error ? error.message : "unknown error",
      });
    }
  };
  purgeCallingProviderPayloads();
  const providerRetentionTimer = setInterval(purgeCallingProviderPayloads, 60 * 60 * 1_000);
  providerRetentionTimer.unref();
  const { verifyCallingAuditIntegrity } = await import("./calling/store");
  const verifyCallingAuditChain = () => {
    try {
      const result = verifyCallingAuditIntegrity();
      structuredLog(result.invalidTenants.length ? "calling.audit_integrity_failed" : "calling.audit_integrity_ok", {
        tenantsChecked: result.tenantsChecked,
        eventsChecked: result.eventsChecked,
        invalidTenants: JSON.stringify(result.invalidTenants),
      });
    } catch (error) {
      structuredLog("calling.audit_integrity_failed", {
        message: error instanceof Error ? error.message : "unknown error",
      });
    }
  };
  verifyCallingAuditChain();
  const callingAuditTimer = setInterval(verifyCallingAuditChain, 6 * 60 * 60 * 1_000);
  callingAuditTimer.unref();

  // Route modules import stores that prepare statements for migrated tables.
  // Load them only after migrations so a brand-new deployment can boot from an
  // empty data directory instead of failing during module evaluation.
  const { registerRoutes, registerSaasRoutes } = await import("./routes");

  // One-time, idempotent: adopt every currently-sold door into the weekly
  // commission ledger so the engine reflects real production from day one.
  try {
    const { backfillFieldSales } = await import("./commissionService");
    backfillFieldSales();
  } catch (e: any) { console.warn("[commission] field-sale backfill skipped:", e?.message); }

  // Resume any budgeted scan that was mid-flight when the process last died —
  // "leave and return without losing progress" must survive a crash/deploy, not
  // just a navigation. Each interrupted run continues from its persisted queue.
  {
    const { registerKineticEvidenceSource } = await import("./kineticProviderAdapter");
    const { KineticAuthorizedSearchAdapter } = await import("./kineticAuthorizedSearchAdapter");
    registerKineticEvidenceSource(new KineticAuthorizedSearchAdapter());
  }
  // Heavy background startup — resuming runs, statewide sweep, radar, expansion,
  // discovery. This is DEFERRED until AFTER httpServer.listen() so /api/health responds
  // in seconds (container becomes healthy immediately) instead of waiting out ~120s of
  // boot work on a large production DB — which exceeded the deploy health-check window
  // and forced a rollback. None of these need to run before the server is listening.
  const startBackgroundServices = async () => {
  try {
    // Scan Inspector: begin persisting + relaying per-address pipeline stage events.
    const { startScanEvents } = await import("./scanEvents");
    startScanEvents();
  } catch (e: any) { console.warn("[scan-events] start skipped:", e?.message); }
  // DEFER all scan/sweep RESUME past the healthcheck start_period. On a fresh
  // container these fire dozens of worker loops that immediately hammer Decodo
  // (and, when its 403 rolling-window is depleted, spin) — enough to peg the box
  // and fail the deploy health-gate before /api/health ever stabilizes. Letting
  // the container answer health FIRST, then resuming scanning ~150s later (past
  // start_period 120s), makes the gate deterministic. Resume is idempotent and
  // checkpoint-based, so nothing is lost by starting a bit later. The periodic
  // reaper (started immediately, first tick 60s) still recovers anything if this
  // deferred pass is somehow missed. BACKGROUND_RESUME_DELAY_MS overrides.
  // STAGGER across the cluster: a single shared delay had all 4 workers' resume
  // bursts AND the control worker's outbox prune firing at the identical T+150s
  // instant — a synchronized write herd into the one SQLite writer. Offset each
  // worker by 25s (worker 0 keeps exactly the base delay, so single-process
  // SCAN_WORKERS=0 behavior — HF_WORKER_INDEX unset → offset 0 — is unchanged).
  // All offsets land past the 120s health start_period, so the deploy gate is
  // unaffected.
  const workerStaggerMs = Math.max(0, Math.floor(Number(process.env.HF_WORKER_INDEX ?? 0) || 0)) * 25_000;
  const resumeDelay = Math.max(0, Number(process.env.BACKGROUND_RESUME_DELAY_MS ?? 150_000) || 150_000) + workerStaggerMs;
  // Defer any engine START past the deploy health gate. These schedule 20s
  // interval ticks that would otherwise begin firing (heavy synchronous DB work)
  // WHILE the gate is still probing /api/health — the recurring cause of failed
  // deploys/rollbacks. The imports below still run at boot (cheap); only the
  // scheduling of the recurring work is delayed. Own try/catch since the caller's
  // has already returned by the time this fires.
  const deferBoot = (fn: () => void, label: string) => {
    const t = setTimeout(() => { try { fn(); } catch (e: any) { console.warn(`[${label}] deferred start failed:`, e?.message); } }, resumeDelay);
    if (typeof (t as any).unref === "function") (t as any).unref();
  };
  const deferredResume = setTimeout(() => { void (async () => {
    // RUN CONSUMERS + REAPER — run in EVERY worker. This is the multi-core lever:
    // each process independently pulls queued targets (atomic claimRunTargets makes
    // sharing safe) and reaps dead-worker runs. The decoupled run heartbeat keeps a
    // live sibling's run from being reclaimed here.
    try {
      const { resumeInterruptedRuns, resumeCriticalRuns, startScanReaper } = await import("./scanEngine");
      resumeCriticalRuns();    // CRITICAL runs (new-build/manual/field) resume first
      resumeInterruptedRuns();
      startScanReaper(); // periodic reaper — started only now so its 60s tick can't fire during the health gate
    } catch (e: any) { console.warn("[scan-engine] resume skipped:", e?.message); }
    // SWEEP DRIVERS — control worker of the PRIMARY node only. These advance the
    // statewide-sweep checkpoint / re-drive sweep jobs (work PRODUCERS); driving
    // them from every worker would race the checkpoint, and driving them from a
    // second NODE would double-create per-city runs. isPrimaryNode() gates the
    // fleet down to one producer (single box → always true; see the producer
    // block below where the lease is acquired).
    if (IS_CONTROL_ROLE && isPrimaryNode()) {
      try {
        const { resumeSweepJobs, resumeStateSweeps } = await import("./sweepService");
        resumeSweepJobs();
        resumeStateSweeps(); // crash-recovery only — picks a running statewide sweep back up
      } catch (e: any) { console.warn("[sweep] resume skipped:", e?.message); }
    }
  })(); }, resumeDelay);
  if (typeof (deferredResume as any).unref === "function") (deferredResume as any).unref();
  // ── WORK PRODUCERS — CONTROL WORKER OF THE PRIMARY NODE ONLY ──────────────────
  // Everything below SCHEDULES or CREATES scan work (statewide sweep, new-build
  // radar, cluster expansion, priority/hot/frontier bursts, discovery, coming-soon,
  // daily refresh) or fires external-API cadences (OSM/OneMap/Mapbox). Running these
  // in every cluster worker would multiply external-API spend and double-create runs;
  // running them on a SECOND NODE would do the same across the fleet. The runs they
  // produce are consumed by ALL workers on ALL nodes via the shared DB queue + reaper,
  // so ONE producer feeds the whole fleet.
  //
  // MULTI-NODE: startPrimaryElection() acquires a DB lease so producers run on
  // exactly one node. On a lone box that node always wins the lease → byte-for-byte
  // unchanged from today. Point a second app node at the same DB and it becomes a
  // pure serve/consume replica (no double-scanning). NOTE: producer FAILOVER to a
  // surviving node currently needs that node to (re)boot as primary — the lease
  // makes multi-node SAFE now; automatic producer-failover is the next step.
  if (IS_CONTROL_ROLE && startPrimaryElection()) {
  // Alert-outbox janitor — supersede the runaway pending backlog (1.25M rows
  // observed) down to the cap, chunked with yields so it can never block /api.
  // Control worker only (one writer), deferred past the health gate. Kill-switch:
  // OUTBOX_PRUNE=off.
  if (process.env.OUTBOX_PRUNE !== "off") {
    // Own slot AFTER every worker's staggered resume burst (workers offset by 25s
    // each) — the million-row prune must never overlap a resume herd.
    const pruneDelay = resumeDelay + (SCAN_WORKERS > 0 ? SCAN_WORKERS : 1) * 25_000 + 10_000;
    const pruneTimer = setTimeout(() => { void (async () => {
      try {
        const { pruneAlertOutboxBacklog } = await import("./stateMonitorScheduler");
        await pruneAlertOutboxBacklog();
      } catch (e: any) { console.warn("[outbox-prune] skipped:", e?.message); }
    })(); }, pruneDelay);
    if (typeof (pruneTimer as any).unref === "function") (pruneTimer as any).unref();
  }
  // ── Statewide NC+SC scan on every production deployment ────────────────────
  // Business purpose: surface newly serviceable, non-active Kinetic addresses so
  // reps reach fresh doors first. Every prod boot (deploy = container restart)
  // starts the full NC+SC sweep IMMEDIATELY — no nightly wait. startStateSweep
  // is idempotent per (tenant,state): if a sweep is already running it is
  // reused, and resumeStateSweeps() above already continued its checkpoint, so
  // a redeploy mid-sweep resumes rather than restarts. OSM discovery only (no
  // Mapbox spend); the shared provider scheduler paces Kinetic; user-triggered
  // Field Map scans outrank sweep traffic in the priority queue.
  // Kill-switch: STATEWIDE_SCAN_ON_DEPLOY=off.
  if (process.env.NODE_ENV === "production" && process.env.STATEWIDE_SCAN_ON_DEPLOY !== "off") {
    // DEFER past the warm-up window. Starting the statewide sweep the instant the
    // container boots pulls every due market (hundreds) and drives a city sweep +
    // OSM harvest immediately — on a 1-CPU box that synchronous burst blocks the
    // event loop while the deploy health-gate is still probing /api/health, so the
    // gate times out and the deploy rolls back (observed live). A ~90s delay lets
    // the app answer health first; the sweep is idempotent + checkpoint-resumed,
    // so nothing is lost by starting it a minute later. Default 150s is past the
    // healthcheck start_period (120s), so the deploy health-gate confirms the
    // container healthy BEFORE the sweep's first heavy harvest runs — the gate
    // can never time out on sweep work. STATE_SWEEP_BOOT_DELAY_MS overrides.
    const stateSweepDelay = Math.max(0, Number(process.env.STATE_SWEEP_BOOT_DELAY_MS ?? 150_000) || 150_000);
    const startStateSweeps = async () => {
      try {
        const { startStateSweep } = await import("./sweepService");
        const { getDefaultTenantId } = await import("./storage");
        const tenantId = getDefaultTenantId();
        if (tenantId == null) throw new Error("no default tenant yet");
        for (const state of ["NC", "SC", "GA"] as const) {
          const sweep = startStateSweep({ tenantId, state });
          structuredLog("state_sweep.deploy_start", {
            state, stateSweepId: sweep.id,
            citiesTotal: sweep.citiesTotal ?? sweep.cities_total ?? null,
            citiesCompleted: sweep.citiesCompleted ?? sweep.cities_completed ?? null,
          });
        }
      } catch (e: any) { console.warn("[state-sweep] deploy auto-start skipped:", e?.message); }
    };
    const sst = setTimeout(() => { void startStateSweeps(); }, stateSweepDelay);
    if (typeof (sst as any).unref === "function") (sst as any).unref();
  }
  // ── New-build discovery + cluster expansion — DECOUPLED from the statewide
  // sweep ─────────────────────────────────────────────────────────────────────
  // These were nested under STATEWIDE_SCAN_ON_DEPLOY, so neither could run
  // without also paying the heavy statewide OSM boot-sweep (the documented
  // single biggest wedge risk). They are now governed ONLY by their own
  // kill-switches. Cluster expansion is the street-level "we found a new build
  // → the surrounding area turns on" engine: every confirmed NEW FIBER +
  // billing-N result seeds a bounded ring crawl around the drop (scanEngine →
  // triggerExpansionForTargets), capped by maxActive/ring/cluster budgets +
  // generation backpressure. Production-only so tests/dev never poll external
  // feeds; both starts no-op when their flag is off.
  if (process.env.NODE_ENV === "production") {
    // New Build Radar — continuously watch free NC/SC/GA sources for newly-
    // appearing addresses/buildings and feed valid ones into the scan pipeline.
    // Kill-switch: NEWBUILD_RADAR=off.
    try {
      const { startNewBuildRadar } = await import("./newBuildRadar");
      deferBoot(startNewBuildRadar, "newbuild-radar");
    } catch (e: any) { console.warn("[newbuild-radar] start skipped:", e?.message); }
    // Lead-triggered cluster expansion — fans out from every confirmed green
    // FRESH_LEAD. Rings admit in the NORMAL band (below the reserved CRITICAL
    // slots, so rep-facing checks always win), bounded by the engine's own
    // maxActive/ring/cluster budgets. Kill-switch: EXPANSION_ENABLED=off.
    try {
      const { startExpansionEngine } = await import("./clusterExpansion");
      deferBoot(startExpansionEngine, "expansion");
    } catch (e: any) { console.warn("[expansion] start skipped:", e?.message); }
  }
  try {
    const { resumeDiscoveryJobs } = await import("./addressDiscovery/engine");
    deferBoot(resumeDiscoveryJobs, "address-discovery");
  } catch (e: any) { console.warn("[address-discovery] resume skipped:", e?.message); }
  try {
    // Coming-Soon watchlist tick — urgency-cadence rechecks (NEW_BUILD reserved class)
    // + promote-on-flip + AGED lifecycle pass. Kill-switch: COMING_SOON_WATCHLIST=off.
    const { startComingSoonWatchlist } = await import("./comingSoonWatchlist");
    deferBoot(startComingSoonWatchlist, "coming-soon-watchlist");
  } catch (e: any) { console.warn("[coming-soon-watchlist] start skipped:", e?.message); }
  try {
    // Rumor-driven territory probes ("I heard there's Kinetic fiber near X"):
    // EXPLORE_CITIES="durham:nc,…" → bounded city sweeps outside the verified
    // catalog. Idempotent per city; see server/exploreCities.ts.
    const { startExploreCycle } = await import("./exploreCities");
    deferBoot(startExploreCycle, "explore-cities");
  } catch (e: any) { console.warn("[explore-cities] start skipped:", e?.message); }
  // One-shot: terminalize the already-exhausted needs-fix tail (targets at the attempt
  // cap re-burning check capacity) as address_not_found without spending one more check
  // each. DEFERRED past the health gate (deferBoot → resumeDelay): it is a heavy
  // better-sqlite3 sweep over the grown DB, so running it in the boot window would stall
  // the control worker's event loop and re-wedge /api. finalizeAddressNotFoundBacklog now
  // yields between chunks so even post-gate it never blocks for its whole duration.
  // Idempotent; ANF_BACKFILL=off disables.
  if (process.env.ANF_BACKFILL !== "off") {
    deferBoot(() => { void (async () => {
      try {
        const { finalizeAddressNotFoundBacklog } = await import("./scanIntelStore");
        const cap = Math.max(2, Math.floor(Number(process.env.ADDRESS_NOT_FOUND_ATTEMPTS ?? 6) || 6));
        const res = await finalizeAddressNotFoundBacklog(cap);
        if (res.targets > 0) structuredLog("anf_backfill.finalized", { targets: res.targets, runs: res.runs, attemptCap: cap });
      } catch (e: any) { console.warn("[anf-backfill] skipped:", e?.message); }
    })(); }, "anf-backfill");
  }
  // FRESH-LEAD BACKFILL INVARIANT: every already-confirmed green address (NEW FIBER +
  // billing N, per its latest conclusive snapshot) must be an assignable Field-Map lead.
  // Re-project ALL tenants once on boot from EXISTING data (no re-scan, no Decodo cost,
  // fully idempotent) so no confirmed fresh fiber sits un-actioned. Kill-switch:
  // FRESH_LEAD_BOOT_BACKFILL=off.
  // DEFERRED past the health gate (deferBoot): the green predicate scans scan_targets
  // (covered by idx_scan_targets_green_unlinked) and the link/projection loops now yield
  // between chunks, but running it in the boot window over the grown DB still risks
  // stalling the control worker — keep it out of the health window like every producer.
  if (process.env.FRESH_LEAD_BOOT_BACKFILL !== "off") {
    deferBoot(() => { void (async () => {
      try {
        const { projectConfirmedFreshLeads } = await import("./freshFiberProjector");
        const { rawDb } = await import("./db");
        const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));
        const tenantIds = rawDb.prepare("SELECT id FROM tenants").all().map((r: any) => Number(r.id));
        for (const tid of tenantIds) {
          // LINK-BY-ADDRESS first: thousands of green scan_targets already have a lead
          // row for the same address (created before source_scan_target_id linking) but
          // no converted_to_lead_id. Link them so the metric is honest and the projector
          // never double-creates. Pure existing-data join (idx_leads_addr_ci), chunked.
          // ONE lead per target (MIN(l.id)) — the address join can match several leads
          // with identical address text; without dedup, stamping the same
          // source_scan_target_id onto a second lead violates the UNIQUE partial index
          // idx_leads_confirmed_scan_target and aborted the whole backfill (seen live).
          const pairs = rawDb.prepare(`SELECT s.id sid, MIN(l.id) lid FROM scan_targets s JOIN leads l
              ON lower(trim(l.address))=lower(trim(s.address)) AND lower(trim(l.city))=lower(trim(s.city)) AND upper(l.state)=upper(s.state)
            WHERE s.tenant_id=? AND s.converted_to_lead_id IS NULL
              AND s.last_fiber_status='new_fiber' AND s.last_billing_status='N'
            GROUP BY s.id`).all(tid) as any[];
          const linkStmt = rawDb.prepare(`UPDATE scan_targets SET converted_to_lead_id=? WHERE id=? AND converted_to_lead_id IS NULL`);
          // OR IGNORE: if this sid is already stamped on another lead (duplicate address
          // rows sharing one lead), skip the stamp rather than violate the unique index.
          const stampStmt = rawDb.prepare(`UPDATE OR IGNORE leads SET source_scan_target_id=COALESCE(source_scan_target_id,?) WHERE id=?`);
          let addrLinked = 0;
          for (let i = 0; i < pairs.length; i += 500) {
            try {
              rawDb.transaction(() => {
                for (const p of pairs.slice(i, i + 500)) { linkStmt.run(p.lid, p.sid); stampStmt.run(p.sid, p.lid); addrLinked++; }
              })();
            } catch (chunkErr: any) {
              // Isolate a bad chunk — never abort the remaining thousands of links.
              console.warn(`[fresh-lead-backfill] link chunk ${i / 500} failed:`, chunkErr?.message);
            }
            await yieldLoop(); // let the control worker serve HTTP between chunks
          }
          if (pairs.length) structuredLog("fresh_lead.link_backfill", { tenantId: tid, candidatePairs: pairs.length, linkedByAddress: addrLinked });
          // Confirmed-green (NEW FIBER + billing N) scan_targets that are not yet a lead.
          const ids = rawDb.prepare(`SELECT id FROM scan_targets WHERE tenant_id=? AND state IN ('GA','NC','SC')
            AND last_fiber_status='new_fiber' AND last_billing_status='N' AND converted_to_lead_id IS NULL`).all(tid).map((r: any) => Number(r.id));
          let created = 0, linkedProj = 0;
          // Chunk so each projection transaction is small and the event loop breathes.
          for (let i = 0; i < ids.length; i += 300) {
            const r = projectConfirmedFreshLeads(tid, ids.slice(i, i + 300));
            created += r.created; linkedProj += r.linkedExisting;
            await yieldLoop(); // let the control worker serve HTTP between projection chunks
          }
          structuredLog("fresh_lead.boot_backfill", { tenantId: tid, candidates: ids.length, created, linkedExisting: linkedProj });
        }
      } catch (e: any) { console.warn("[fresh-lead-backfill] skipped:", e?.message); }
    })(); }, "fresh-lead-backfill");
  }
  // PRIORITY SEED + MARKET SCAN — ON BY DEFAULT, CONTINUOUSLY CYCLING. Enqueue the
  // Sugar-and-Wine-Rd seed corridor (IMMEDIATE) + the 7 target markets'
  // unchecked/stale addresses (DISCOVERY) through the REAL startTargetRun path
  // (dedup + worker dispatch). Runs on boot AND on a 4h cycle forever, so all seven
  // markets keep sweeping for new addresses, new fiber, Coming Soon transitions and
  // stale-lead rechecks without any operator action. Only UNCHECKED-or-stale
  // targets are picked and it self-limits to one burst per 4h, so the cycle never
  // piles up duplicate runs. Set SEED_PRIORITY_SCAN=off to disable entirely.
  const runPrioritySeedBurst = async () => {
    try {
      const { rawDb } = await import("./db");
      const { startTargetRun } = await import("./scanService");
      const { getDefaultTenantId } = await import("./storage");
      const tid = getDefaultTenantId();
      if (tid == null) return;
      const recent = rawDb.prepare(`SELECT COUNT(*) c FROM scan_runs WHERE label LIKE 'PRIORITY:%' AND heartbeat_at > datetime('now','-4 hours')`).get() as any;
      if (Number(recent.c) > 0) { structuredLog("priority_seed_scan.skipped", { reason: "recent PRIORITY burst" }); return; }
      const enqueued: any[] = [];
      const pick = (sql: string, ...a: any[]) => (rawDb.prepare(sql).all(...a) as any[]).map((r) => Number(r.id));
      // Seed corridor (includes 4707 Sugar and Wine Rd) — IMMEDIATE so it's checked first.
      const seedIds = pick(`SELECT id FROM scan_targets WHERE lower(address) LIKE '%sugar%wine%'
        AND (last_scanned_at IS NULL OR last_scanned_at < datetime('now','-12 hours')) LIMIT 400`);
      if (seedIds.length) enqueued.push({ area: "seed:sugar-and-wine", ...startTargetRun({ tenantId: tid, city: "Marshville", state: "NC", targetIds: seedIds, runKind: "manual", label: "PRIORITY: Sugar and Wine Rd seed corridor" }) });
      // 7 Kinetic markets — DISCOVERY (revenue class), unchecked/stale first.
      for (const c of ["harrisburg", "monroe", "albemarle", "oakboro", "indian trail", "concord", "rockwell"]) {
        const ids = pick(`SELECT id FROM scan_targets WHERE lower(city)=?
          AND (last_scanned_at IS NULL OR last_scanned_at < datetime('now','-12 hours'))
          ORDER BY (last_scanned_at IS NULL) DESC LIMIT 1000`, c);
        if (ids.length) enqueued.push({ area: c, ...startTargetRun({ tenantId: tid, city: c, state: "NC", targetIds: ids, runKind: "discovery", label: "PRIORITY: market " + c }) });
      }
      structuredLog("priority_seed_scan.enqueued", { runs: enqueued.length, totalQueued: enqueued.reduce((s, e) => s + (e.queued || 0), 0), areas: JSON.stringify(enqueued.map((e) => ({ area: e.area, queued: e.queued }))) });
    } catch (e: any) { console.warn("[priority-seed-scan] skipped:", e?.message); }
  };
  if (process.env.SEED_PRIORITY_SCAN !== "off") {
    // Stagger: web settles + token pool warms first, then the market cycle starts.
    setTimeout(() => { void runPrioritySeedBurst(); }, 2 * 60_000);
    const seedCycle = setInterval(() => { void runPrioritySeedBurst(); }, 4 * 60 * 60_000);
    if (typeof (seedCycle as any).unref === "function") seedCycle.unref();
  }

  // HOT MARKETS — active fresh-fiber build zones. Default: Dalton GA plus the
  // Sanford NC cluster (Sanford, Broadway, and the surrounding Lee/Moore-county
  // towns already in the market catalog). Own 20-minute cycle, 30-minute stale
  // window, 5000-target batches, never-checked first, plus an hourly address-
  // discovery job per hot city. HOT_MARKETS=off disables; comma-separated
  // "city:st" entries extend.
  const DEFAULT_HOT_MARKETS = "dalton:ga,sanford:nc,broadway:nc,cameron:nc,aberdeen:nc,pinebluff:nc";
  const runHotBurst = async () => {
    try {
      const hotSpec = (process.env.HOT_MARKETS ?? DEFAULT_HOT_MARKETS).trim();
      if (hotSpec === "off") return;
      const { rawDb } = await import("./db");
      const { startTargetRun } = await import("./scanService");
      const { getDefaultTenantId } = await import("./storage");
      const tid = getDefaultTenantId();
      if (tid == null) return;
      // Static env cities UNIONED with build-intel dynamic promotions (news/
      // permit-detected build zones) — a newly-announced market starts pumping
      // on the next 20-min cycle, no redeploy. Env entries always kept.
      let hotEntries: Array<{ city: string; state: string }>;
      try {
        const { listHotMarkets } = await import("./buildIntel");
        hotEntries = listHotMarkets(hotSpec);
      } catch {
        hotEntries = hotSpec.split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
          const [city, st = "ga"] = entry.split(":").map((p) => p.trim());
          return { city, state: st };
        }).filter((e) => e.city);
      }
      for (const { city, state: st } of hotEntries) {
        if (!city) continue;
        const ids = (rawDb.prepare(`SELECT id FROM scan_targets WHERE lower(city)=? AND lower(state)=?
          AND (last_scanned_at IS NULL OR last_scanned_at < datetime('now','-30 minutes'))
          ORDER BY (last_scanned_at IS NULL) DESC, last_scanned_at ASC LIMIT 5000`)
          .all(city, st) as any[]).map((r) => Number(r.id));
        if (ids.length) {
          startTargetRun({ tenantId: tid, city, state: st.toUpperCase(), targetIds: ids, runKind: "hot_market", label: `HOT: ${city} ${st.toUpperCase()} fresh-fiber sweep` });
          structuredLog("hot_market.burst", { city, state: st, queued: ids.length });
        }
        try {
          const { createDiscoveryJob } = await import("./addressDiscovery/store");
          const pretty = city.replace(/\b\w/g, (c) => c.toUpperCase());
          const hourKey = new Date().toISOString().slice(0, 13);
          const { job } = createDiscoveryJob({
            tenantId: tid,
            idempotencyKey: `hot:${city.toLowerCase()}:${st.toLowerCase()}:${hourKey}`,
            requestHash: `hot-market:${city.toLowerCase()}:${st.toLowerCase()}`,
            townName: pretty, state: st.toUpperCase(), createdBy: 1,
          } as any);
          if (job) structuredLog("hot_market.discovery", { city, state: st, jobId: (job as any).id });
        } catch { /* discovery module optional */ }
      }
    } catch (e: any) { console.warn("[hot-market] skipped:", e?.message); }
  };
  // ── KEEP-WARM continuous scan (2026-07-21) ───────────────────────────────
  // The moat is fresh leads, but the periodic HOT/PRIORITY bursts (5k/city every
  // 20 min) leave the pipeline IDLE between cycles while 180k+ never-scanned Kinetic
  // targets sit in the priority cities (Concord 59k, Mooresville 52k, Lexington 10k).
  // This keeps the scan CONTINUOUSLY fed from that EXISTING inventory — SCAN-ONLY via
  // startTargetRun (NO OSM harvest, so the harvest write-storm that took the site down
  // cannot happen), and it only tops up when the claimable queue is DRAINING, so total
  // queued work is bounded (oscillates KW_LOW..KW_LOW+KW_REFILL) and never exceeds the
  // global concurrency cap (admission gates in-flight at SCAN_GLOBAL_CONCURRENCY=24).
  // Safe under the write-contention fixes now live (scan_events batching, WAL guard,
  // log retention). Never-scanned first (highest-yield). Control worker only (this is
  // inside the IS_CONTROL_ROLE producer block). KEEPWARM_SCAN=off disables.
  const keepWarmCities = (process.env.PRIORITY_CITIES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (process.env.KEEPWARM_SCAN !== "off" && keepWarmCities.length) {
    const KW_LOW = Math.max(500, Number(process.env.KEEPWARM_LOW ?? 3000) || 3000);        // top up when claimable dips below this
    const KW_PER_CITY = Math.max(250, Number(process.env.KEEPWARM_PER_CITY ?? 2000) || 2000);
    const KW_REFILL = Math.max(1000, Number(process.env.KEEPWARM_REFILL ?? 8000) || 8000); // cap enqueued per top-up
    const KW_MS = Math.max(30_000, Number(process.env.KEEPWARM_MS ?? 90_000) || 90_000);
    const runKeepWarm = async () => {
      try {
        const { rawDb } = await import("./db");
        const { startTargetRun } = await import("./scanService");
        const { getDefaultTenantId } = await import("./storage");
        const tid = getDefaultTenantId();
        if (tid == null) return;
        // BANDWIDTH GOVERNOR — keep-warm is the main call-volume driver, so it
        // must respect the Decodo pool pace: scale the refill by bwScale
        // (and skip entirely while the proxy circuit is open).
        const { bandwidthBudgetScale, isProxyCircuitOpen } = await import("./bandwidthGovernor");
        if (isProxyCircuitOpen()) return;
        const bwScale = bandwidthBudgetScale();
        let refillCap = Math.max(500, Math.round(KW_REFILL * bwScale));
        // THROUGHPUT-MATCHED REFILL (measured 2026-07-24): with the yield
        // engine capped to proven throughput, keep-warm became the dominant
        // enqueuer — 176,415 rows/hour against 3,179 completed checks, and
        // 169,404 of those were skipped again as parked. Topping the queue up
        // far past what the provider can drain buys nothing and costs the
        // single writer an INSERT plus a claim/skip UPDATE per row. Cap the
        // refill at what actually drains in an hour (x2 headroom).
        if (process.env.YIELD_THROUGHPUT_MATCH !== "off") {
          try {
            const checkedLastHour = Number((rawDb.prepare(
              `SELECT COUNT(*) n FROM availability_snapshots WHERE checked_at_epoch > ?`,
            ).get(Date.now() - 3_600_000) as any)?.n ?? 0);
            const checkedLast24h = Number((rawDb.prepare(
              `SELECT COUNT(*) n FROM availability_snapshots WHERE checked_at_epoch > ?`,
            ).get(Date.now() - 86_400_000) as any)?.n ?? 0);
            // Spiral fix: capacity is the BEST recent evidence, never the
            // worst. `capped: 500, checkedLastHour: 34` was this feeder
            // starving itself in production.
            const drainCap = Math.max(500, provenHourlyCapacity(checkedLastHour, checkedLast24h) * 2);
            if (drainCap < refillCap) {
              structuredLog("keepwarm.throughput_capped", { requested: refillCap, capped: drainCap, checkedLastHour, checkedLast24h });
              refillCap = drainCap;
            }
          } catch { /* best-effort — never block the feeder */ }
        }
        const perCityCap = Math.max(250, Math.round(KW_PER_CITY * bwScale));
        // Only refill when the pipeline is draining — this is what bounds total work.
        const claimable = Number((rawDb.prepare(`SELECT COUNT(*) c FROM scan_run_targets t JOIN scan_runs r ON r.id=t.run_id
          WHERE r.status='running' AND t.state='queued' AND (t.next_attempt_at IS NULL OR t.next_attempt_at<=datetime('now'))`).get() as any).c);
        if (claimable >= KW_LOW) return;
        let enqueued = 0;
        for (const entry of keepWarmCities) {
          if (enqueued >= refillCap) break;
          const [city, st = "nc"] = entry.split(":").map((s) => s.trim());
          if (!city) continue;
          const ids = (rawDb.prepare(`SELECT id FROM scan_targets WHERE lower(city)=? AND lower(state)=?
            AND (carrier IS NULL OR carrier='kinetic')
            AND (last_scanned_at IS NULL OR last_scanned_at < datetime('now','-24 hours'))
            AND NOT ${anfParkedSql("scan_targets", 14)}
            ORDER BY (last_scanned_at IS NULL) DESC, last_scanned_at ASC LIMIT ?`)
            .all(city, st, perCityCap) as any[]).map((r) => Number(r.id));
          if (ids.length) {
            // startTargetRun dedups against already-queued/inflight targets, so an
            // overlap with a hot-market run is skipped, never double-scanned.
            startTargetRun({ tenantId: tid, city, state: st.toUpperCase(), targetIds: ids, runKind: "discovery", label: `KEEPWARM: ${city} ${st.toUpperCase()}` });
            enqueued += ids.length;
          }
        }
        // STATEWIDE FEEDER — NEIGHBORHOOD SATURATION MODE (operator directive:
        // "full fresh neighborhoods where no one's been before, NOT scattered").
        // Rank ~1.1km cells by their NEVER-SCANNED density and sweep the
        // densest untouched neighborhoods COMPLETELY before moving on — every
        // rep gets a whole fresh street map to knock, not a scatter plot.
        if (enqueued < refillCap && process.env.VITEST !== "true") {
          const wideStates = (process.env.FRESH_HARVEST_STATES ?? "nc,sc,ga").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
          const inClause = wideStates.map(() => "?").join(",");
          const ids = (rawDb.prepare(`
            WITH cold_cells AS (
              SELECT ROUND(lat,2) AS clat, ROUND(lng,2) AS clng, COUNT(*) AS unscanned
                FROM scan_targets
               WHERE tenant_id=? AND last_scanned_at IS NULL AND lat IS NOT NULL AND lng IS NOT NULL
                 AND (carrier IS NULL OR carrier='kinetic')
                 AND lower(state) IN (${inClause})
               GROUP BY clat, clng
            )
            SELECT s.id FROM scan_targets s
            JOIN cold_cells cc ON ROUND(s.lat,2)=cc.clat AND ROUND(s.lng,2)=cc.clng
            WHERE s.tenant_id=? AND lower(s.state) IN (${inClause})
              AND (s.carrier IS NULL OR s.carrier='kinetic')
              AND (s.last_scanned_at IS NULL OR s.last_scanned_at < datetime('now','-24 hours'))
              AND NOT ${anfParkedSql("s", 14)}
            ORDER BY cc.unscanned DESC, (s.last_scanned_at IS NULL) DESC, s.id ASC
            LIMIT ?`)
            .all(tid, ...wideStates, tid, ...wideStates, refillCap - enqueued) as any[]).map((r) => Number(r.id));
          if (ids.length) {
            startTargetRun({ tenantId: tid, city: "statewide", state: wideStates.join("/").toUpperCase(), targetIds: ids, runKind: "discovery", label: `KEEPWARM: SATURATE ${wideStates.join("/").toUpperCase()}` });
            enqueued += ids.length;
          }
        }
        if (enqueued) structuredLog("keepwarm.topup", { claimableWas: claimable, enqueued, bwScale });
      } catch (e: any) { console.warn("[keepwarm] skipped:", e?.message); }
    };
    deferBoot(() => {
      const t = setInterval(() => { void runKeepWarm(); }, KW_MS);
      if (typeof (t as any).unref === "function") (t as any).unref();
      void runKeepWarm();
    }, "keepwarm-scan");
  }
  if ((process.env.HOT_MARKETS ?? DEFAULT_HOT_MARKETS) !== "off") {
    // First burst 90s after boot — hot markets start pumping almost immediately.
    setTimeout(() => { void runHotBurst(); }, 90 * 1000);
    const hotCycle = setInterval(() => { void runHotBurst(); }, 20 * 60_000);
    if (typeof (hotCycle as any).unref === "function") hotCycle.unref();
  }

  // BUILD INTELLIGENCE — news + county-permit signals promote cities into the
  // DYNAMIC hot zone the burst above unions in, so a newly-announced Kinetic
  // build market starts scanning within one cycle of the story breaking — no
  // redeploy. Free public sources (RSS/ArcGIS), no proxy spend; control worker
  // only. Kill-switch: BUILD_INTEL=off.
  try {
    const { startBuildIntel } = await import("./buildIntel");
    deferBoot(startBuildIntel, "build-intel");
  } catch (e: any) { console.warn("[build-intel] start skipped:", e?.message); }

  // FRONTIER MARKETS — Frontier-fiber towns (default: Durham NC). Mirrors the
  // hot-market cadence but tags every target carrier='frontier' so the engine
  // routes it to the Frontier serviceability scanner and publishes RED leads.
  // Own 20-minute cycle, 30-minute stale window, hourly discovery job per town.
  // FRONTIER_MARKETS=off disables; comma-separated "city:st" entries extend.
  const DEFAULT_FRONTIER_MARKETS = "durham:nc";
  const runFrontierBurst = async () => {
    try {
      const spec = (process.env.FRONTIER_MARKETS ?? DEFAULT_FRONTIER_MARKETS).trim();
      if (spec === "off") return;
      const { rawDb } = await import("./db");
      const { startTargetRun } = await import("./scanService");
      const { getDefaultTenantId } = await import("./storage");
      const tid = getDefaultTenantId();
      if (tid == null) return;
      for (const entry of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
        const [city, st = "nc"] = entry.split(":").map((s) => s.trim());
        if (!city) continue;
        // Tag everything harvested for this town as Frontier territory — the
        // discovery harvester is carrier-agnostic; the town assignment owns it.
        // Retag via the carrier='kinetic' predicate so idx_scan_targets_carrier_city
        // (carrier, lower(city), state) serves it — '<>frontier' full-scanned the
        // 884k-row table inside one write txn per town and wedged the DB writer.
        rawDb.prepare(`UPDATE scan_targets SET carrier='frontier' WHERE carrier='kinetic' AND lower(city)=? AND lower(state)=?`).run(city, st);
        // Verdict-aware re-check windows (Decodo budget guard): never-scanned
        // first; negative verdicts weekly; unknown/blocked daily. Confirmed
        // fiber and existing-service addresses are KNOWN states — re-checking
        // them every 30 minutes burned thousands of proxy calls for zero yield.
        const ids = (rawDb.prepare(`SELECT id FROM scan_targets WHERE carrier='frontier' AND lower(city)=? AND lower(state)=?
          AND (last_scanned_at IS NULL
               OR (COALESCE(last_fiber_status,'') IN ('no_service','copper') AND last_scanned_at < datetime('now','-7 days'))
               OR (COALESCE(last_fiber_status,'')='' AND last_scanned_at < datetime('now','-1 day')))
          ORDER BY (last_scanned_at IS NULL) DESC, last_scanned_at ASC LIMIT 5000`)
          .all(city, st) as any[]).map((r) => Number(r.id));
        if (ids.length) {
          startTargetRun({ tenantId: tid, city, state: st.toUpperCase(), targetIds: ids, runKind: "frontier_hot", label: `FRONTIER: ${city} ${st.toUpperCase()} fiber sweep` });
          structuredLog("frontier_market.burst", { city, state: st, queued: ids.length });
        }
        try {
          const { createDiscoveryJob } = await import("./addressDiscovery/store");
          const pretty = city.replace(/\b\w/g, (c) => c.toUpperCase());
          const hourKey = new Date().toISOString().slice(0, 13);
          const { job } = createDiscoveryJob({
            tenantId: tid,
            idempotencyKey: `frontier:${city.toLowerCase()}:${st.toLowerCase()}:${hourKey}`,
            requestHash: `frontier-market:${city.toLowerCase()}:${st.toLowerCase()}`,
            townName: pretty, state: st.toUpperCase(), createdBy: 1,
          } as any);
          if (job) structuredLog("frontier_market.discovery", { city, state: st, jobId: (job as any).id });
        } catch { /* discovery module optional */ }
      }
    } catch (e: any) { console.warn("[frontier-market] skipped:", e?.message); }
  };
  if ((process.env.FRONTIER_MARKETS ?? DEFAULT_FRONTIER_MARKETS) !== "off") {
    // First burst 2.5 min after boot (offset from the 90s Kinetic hot burst so
    // both don't slam the event loop in the same second).
    setTimeout(() => { void runFrontierBurst(); }, 150 * 1000);
    const frontierCycle = setInterval(() => { void runFrontierBurst(); }, 20 * 60_000);
    if (typeof (frontierCycle as any).unref === "function") frontierCycle.unref();
  }

  // FRESH HARVEST — Kinetic yield-ranked continuous scanning (fresh + coming-soon
  // focus). Every cycle ranks all due work into four tiers (coming-soon flip
  // watch → fresh-cluster neighbors → hot-city frontier → stale re-checks) and
  // spends the budget top-down. Throughput self-regulates via adaptivePace
  // (event-loop lag + health probe), so this runs CONTINUOUSLY with zero
  // website impact. FRESH_HARVEST=off disables.
  if (process.env.FRESH_HARVEST !== "off") {
    const harvestTick = async () => {
      try {
        const { getDefaultTenantId } = await import("./storage");
        const tid = getDefaultTenantId();
        if (tid == null) return;
        if (process.env.YIELD_ENGINE !== "off") {
          const { runYieldCycle } = await import("./yieldEngine");
          runYieldCycle(tid);
        } else {
          const { runHarvestCycle } = await import("./freshHarvest");
          runHarvestCycle(tid);
        }
      } catch (e: any) { console.warn("[fresh-harvest] skipped:", e?.message); }
    };
    // Periodic baseline coverage (first cycle 4 min after boot, after the Kinetic
    // hot burst + Frontier burst) PLUS on-demand wakes: a confirmed fresh drop
    // wakes the harvest so its now-due cell/street neighbours scan within seconds
    // (see wakeHarvest in the projection path), instead of waiting a full interval.
    const { startHarvestScheduler } = await import("./harvestScheduler");
    startHarvestScheduler(harvestTick, {
      intervalMs: Math.max(5, Number(process.env.FRESH_HARVEST_INTERVAL_MIN) || 15) * 60_000,
      firstDelayMs: 4 * 60_000,
    });

    // ECONOMY REPORT — every 6h, log proxy-call efficiency: checks, block
    // rate, fresh verdicts, fresh leads, and calls-per-fresh-lead so we can
    // prove (and tune) the value of every Decodo call spent.
    const economyTick = async () => {
      try {
        const { getDefaultTenantId } = await import("./storage");
        const { emitEconomyReport } = await import("./freshHarvest");
        const tid = getDefaultTenantId();
        if (tid != null) emitEconomyReport(tid);
      } catch (e: any) { console.warn("[fresh-harvest] economy report skipped:", e?.message); }
    };
    setTimeout(() => { void economyTick(); }, 10 * 60_000);
    const economyInterval = setInterval(() => { void economyTick(); }, 6 * 3_600_000);
    if (typeof (economyInterval as any).unref === "function") economyInterval.unref();

    // NIGHTLY LEARNING — recompute the yield weights from realized conversion
    // (which signals actually produced fresh leads in the last 14 days). The
    // engine measurably gets smarter every night. First pass at boot +12min.
    const learnTick = async () => {
      try {
        const { getDefaultTenantId } = await import("./storage");
        const { learnYieldWeights } = await import("./yieldEngine");
        const tid = getDefaultTenantId();
        if (tid != null) learnYieldWeights(tid);
      } catch (e: any) { console.warn("[yield-engine] learn skipped:", e?.message); }
    };
    setTimeout(() => { void learnTick(); }, 12 * 60_000);
    const learnInterval = setInterval(() => { void learnTick(); }, 24 * 3_600_000);
    if (typeof (learnInterval as any).unref === "function") learnInterval.unref();

    // NIGHTLY DB PRUNE — the scan firehose grows the DB ~1GB/day; un-pruned
    // it bloats the WAL (10GB observed) and fails every deploy backup.
    // Batched deletes keep the write lock free. First pass at boot +30min.
    const pruneTick = async () => {
      try {
        const { runDbPrune } = await import("./dbPrune");
        runDbPrune();
      } catch (e: any) { console.warn("[db-prune] skipped:", e?.message); }
    };
    setTimeout(() => { void pruneTick(); }, 30 * 60_000);
    const pruneInterval = setInterval(() => { void pruneTick(); }, 24 * 3_600_000);
    if (typeof (pruneInterval as any).unref === "function") pruneInterval.unref();
  }

  // CITY INGEST — free OSM address discovery for the priority cities
  // (Davidson/Lake Norman). Idempotent: skips cities ingested in the last 7d.
  // First pass at boot +5min, then daily. CITY_INGEST=off disables.
  if (process.env.CITY_INGEST !== "off") {
    const ingestTick = async () => {
      try {
        const { getDefaultTenantId } = await import("./storage");
        const { runCityIngest } = await import("./cityIngest");
        const tid = getDefaultTenantId();
        if (tid != null) await runCityIngest(tid);
      } catch (e: any) { console.warn("[city-ingest] skipped:", e?.message); }
    };
    setTimeout(() => { void ingestTick(); }, 5 * 60_000);
    const ingestInterval = setInterval(() => { void ingestTick(); }, 24 * 3_600_000);
    if (typeof (ingestInterval as any).unref === "function") ingestInterval.unref();
  }

  // FRONTIER BUILD ZONES — controlNumber serving-area clustering (the Fiber Focus
  // playbook). Frontier builds fiber per serving area (controlNumber); every
  // strict Frontier verdict carries its "cn:<n>" fingerprint. When a serving area
  // shows a CLUSTER of fresh no-service leads, the whole area is a fresh build —
  // member leads are promoted to cross_verified (verified fresh) and the zone is
  // logged for the map/ops. FRONTIER_BUILD_ZONES=off disables; threshold via
  // FRONTIER_BUILD_ZONE_MIN (default 8 fresh leads in 21 days).
  const runFrontierBuildZones = async () => {
    try {
      if (process.env.FRONTIER_BUILD_ZONES === "off") return;
      const minCluster = Math.max(3, Math.floor(Number(process.env.FRONTIER_BUILD_ZONE_MIN ?? 8) || 8));
      const { rawDb } = await import("./db");
      const { getDefaultTenantId } = await import("./storage");
      const tid = getDefaultTenantId();
      if (tid == null) return;
      const zones = rawDb.prepare(`SELECT exchange_id AS cn, COUNT(*) AS c,
          MIN(created_at) AS firstSeen, MAX(created_at) AS lastSeen
        FROM leads
        WHERE tenant_id=? AND carrier='frontier' AND lead_tag='fresh_fiber_confirmed'
          AND exchange_id LIKE 'cn%' AND created_at >= datetime('now','-21 days')
        GROUP BY exchange_id HAVING c >= ? ORDER BY c DESC`).all(tid, minCluster) as any[];
      for (const z of zones) {
        const boosted = rawDb.prepare(`UPDATE leads SET fresh_confidence='cross_verified', updated_at=datetime('now')
          WHERE tenant_id=? AND carrier='frontier' AND exchange_id=?
            AND lead_tag='fresh_fiber_confirmed' AND fresh_confidence<>'cross_verified'`).run(tid, z.cn);
        structuredLog("frontier.build_zone", {
          control: z.cn, freshLeads: z.c, boosted: boosted.changes,
          firstSeen: z.firstSeen, lastSeen: z.lastSeen,
        });
      }
    } catch (e: any) { console.warn("[frontier-zones] skipped:", e?.message); }
  };
  setTimeout(() => { void runFrontierBuildZones(); }, 6 * 60_000);
  const frontierZoneCycle = setInterval(() => { void runFrontierBuildZones(); }, 30 * 60_000);
  if (typeof (frontierZoneCycle as any).unref === "function") frontierZoneCycle.unref();

  // COMING SOON PROGRAM — opportunity metadata + promotion surface. The worker
  // bridges legacy watches into the comingSoonWatchlist engine (the sole
  // scheduler of coming-soon rechecks), detects promotions, and refreshes
  // opportunity scores for the board. DB-only; no provider dispatch here.
  // Set COMING_SOON_PROGRAM=off to disable.
  if (process.env.COMING_SOON_PROGRAM !== "off") {
    void (async () => {
      try {
        const { startComingSoonProgram } = await import("./comingSoonProgram");
        const { getDefaultTenantId } = await import("./storage");
        startComingSoonProgram(() => getDefaultTenantId());
      } catch (e: any) { console.warn("[coming-soon-program] start failed:", e?.message); }
    })();
  }

  // DAILY FULL-MARKET SCAN — built-in worker: every day, re-discover addresses in
  // every confirmed GA/NC/SC market and live-check the new ones, so we are FIRST
  // to find fresh fiber. Set DAILY_MARKET_REFRESH=off to disable.
  if (process.env.DAILY_MARKET_REFRESH !== "off") {
    const runDaily = async () => {
      try {
        const { runDailyMarketRefresh } = await import("./dailyMarketRefresh");
        const { runCopperUpgradeSweep } = await import("./copperUpgradeSweep");
        const { getDefaultTenantId } = await import("./storage");
        const tid = getDefaultTenantId();
        if (tid != null) {
          await runDailyMarketRefresh(tid);
          // Copper-upgrade sweep: recheck known non-fiber addresses (rolling 7d)
          // so a legacy-copper → fiber flip becomes a green Fresh Lead instantly.
          runCopperUpgradeSweep(tid);
        }
      } catch (e: any) { console.warn("[daily-market-refresh] failed:", e?.message); }
    };
    const dailyTimer = setInterval(() => { void runDaily(); }, 24 * 60 * 60_000);
    if (typeof (dailyTimer as any).unref === "function") dailyTimer.unref();
    setTimeout(() => { void runDaily(); }, 20 * 60_000); // first run 10 min after boot
  }
  } // end IS_CONTROL_ROLE work-producers
  }; // end startBackgroundServices

  // ── Purge expired sessions every 6 hours ────────────────────────────────
  setInterval(() => {
    try {
      const raw = (require("./db").db as any).driver ?? (require("./db").db as any).$client;
      // FORMAT MATCH: both tables store expires_at as a JS ISO string
      // ("2026-07-25T00:19:00.000Z"), but datetime('now') renders SQLite's
      // space-separated form ("2026-07-25 00:19:00"). These compare as plain
      // text, and 'T' (0x54) sorts above ' ' (0x20), so same-day expiries never
      // matched and lingered a full extra day. Compare ISO against ISO.
      const nowIso = new Date().toISOString();
      raw.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(nowIso);
      raw.prepare(`DELETE FROM otp_codes WHERE expires_at < ?`).run(nowIso);
    } catch {}
  }, 6 * 60 * 60 * 1000);

  // ── WAL guard (single-process mode only) ─────────────────────────────────
  // In cluster mode the guard runs in the PRIMARY (see the bootstrap above) —
  // its near-idle supervisor loop can afford the blocking checkpoint. With
  // SCAN_WORKERS=0 there is no primary, so this one process runs it. The old
  // in-worker guard sized the WAL from wal_checkpoint(PASSIVE)'s `log` column,
  // which reports -1 under checkpoint-lock contention — it measured a negative
  // WAL and never escalated while the file grew to 12GB and filled the disk
  // (2026-07-23). The shared db.ts guard stats the -wal FILE instead.
  if (SCAN_WORKERS === 0) {
    const { bootWalCheckpoint, startWalGuard } = await import("./db");
    bootWalCheckpoint();
    startWalGuard();
    const { startResourceSentinel } = await import("./resourcePressure");
    startResourceSentinel();
    const { startYieldRollupMaintenance } = await import("./yieldRollups");
    startYieldRollupMaintenance();
  }

  await registerRoutes(httpServer, app);
  registerSaasRoutes(app);

  // Unknown API paths must fail as JSON. Without this boundary Vite/SPA static
  // fallback returns index.html with HTTP 200, making removed or mistyped API
  // routes appear to exist and hiding integration mistakes.
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

  // ── Global error handler — never leak stack traces or internal error details ──
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);

    const status = err.status || err.statusCode || 500;

    // Log full error server-side (never to client)
    console.error(`[ERROR] ${err?.constructor?.name ?? "Error"}: ${err?.message ?? "unknown"} (status ${status})`);

    // Generic messages only — no stack traces, no internal codes, no DB errors
    const safeMessages: Record<number, string> = {
      400: "Invalid request.",
      401: "Authentication required.",
      403: "Access denied.",
      404: "Not found.",
      409: "Conflict — resource already exists.",
      413: "Request too large.",
      429: "Too many requests. Please slow down.",
    };
    const message = safeMessages[status] ?? (status < 500 ? err.message : "An internal error occurred. Please try again.");

    return res.status(status).json({ error: message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  // CONTROL WORKER SERVES NO HTTP (2026-07-23 portal-latency root cause): all
  // cluster workers shared the listen socket, so ~1/4 of requests — INCLUDING
  // the deploy health probes — landed on the control worker, whose event loop
  // blocks 20-25s during every scoring cycle. Observed live: portal 2.9-3.8s,
  // two deploy health gates failed while the app was actually fine. Workers
  // 1..N-1 carry HTTP; the scorer/producers get a dedicated loop.
  // CONTROL_SERVES_HTTP=on restores the old behavior (single-worker rigs).
  const controlSkipsHttp = process.env.HF_ROLE === "control"
    && SCAN_WORKERS > 1 && process.env.CONTROL_SERVES_HTTP !== "on";
  if (controlSkipsHttp) {
    log("control worker: HTTP disabled (dedicated producer/scorer loop)");
    void startBackgroundServices();
  } else {
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
      // Server is listening → /api/health now responds. Kick off the heavy background
      // services (resume/sweep/radar/expansion/discovery) without blocking readiness.
      void startBackgroundServices();
    },
  );
  }

  // ── Graceful shutdown ────────────────────────────────────────────────────────
  // A deploy/restart sends SIGTERM. Without this, the process is killed mid-flight:
  // in-flight requests are severed and the SQLite WAL isn't checkpointed cleanly.
  // Drain the HTTP server (stop accepting new conns, let active ones finish), then
  // close the DB (checkpoints WAL — safe for Litestream), then exit. A hard 10s cap
  // guarantees the platform's kill-timer never has to SIGKILL us.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received — draining connections…`);
    const force = setTimeout(() => { log("drain timed out — forcing exit"); process.exit(1); }, 10_000);
    force.unref();
    httpServer.close(() => {
      try { rawDb.close(); } catch (e: any) { console.warn("[shutdown] db close:", e?.message); }
      log("drained cleanly — exiting");
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
})();
