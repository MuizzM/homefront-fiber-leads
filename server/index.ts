import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import crypto from "crypto";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { runMigrations } from "./storage";
import { rawDb } from "./db";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import { structuredLog } from "./structuredLog";
import { globalApiRateLimitMax, shouldSkipGlobalRateLimit } from "./rateLimitPolicy";

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
  runMigrations();
  // The Calling/DNC schema is a strict transactional migration. If it cannot
  // be created and verified, startup stops: serving a half-migrated compliance
  // system would be less safe than remaining offline.
  const { runCallingMigrations } = await import("./calling/migrations");
  runCallingMigrations();
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
  try {
    const { resumeInterruptedRuns, resumeCriticalRuns, startScanReaper } = await import("./scanEngine");
    resumeCriticalRuns();    // CRITICAL runs (new-build/manual/field) resume FIRST + immediately
    resumeInterruptedRuns();
    startScanReaper(); // periodic reaper: pick up runs whose worker died sans restart
  } catch (e: any) { console.warn("[scan-engine] resume skipped:", e?.message); }
  try {
    const { resumeSweepJobs, resumeStateSweeps } = await import("./sweepService");
    resumeSweepJobs();
    resumeStateSweeps(); // crash-recovery only — picks a running statewide sweep back up
  } catch (e: any) { console.warn("[sweep] resume skipped:", e?.message); }
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
    try {
      const { startStateSweep } = await import("./sweepService");
      const { getDefaultTenantId } = await import("./storage");
      const tenantId = getDefaultTenantId();
      if (tenantId == null) throw new Error("no default tenant yet");
      for (const state of ["NC", "SC"] as const) {
        const sweep = startStateSweep({ tenantId, state });
        structuredLog("state_sweep.deploy_start", {
          state, stateSweepId: sweep.id,
          citiesTotal: sweep.citiesTotal ?? sweep.cities_total ?? null,
          citiesCompleted: sweep.citiesCompleted ?? sweep.cities_completed ?? null,
        });
      }
    } catch (e: any) { console.warn("[state-sweep] deploy auto-start skipped:", e?.message); }
    // New Build Radar — continuously watch free NC/SC sources for newly-appearing
    // addresses/buildings and feed valid ones straight into the scan pipeline.
    // Kill-switch: NEWBUILD_RADAR=off.
    try {
      const { startNewBuildRadar } = await import("./newBuildRadar");
      startNewBuildRadar();
    } catch (e: any) { console.warn("[newbuild-radar] start skipped:", e?.message); }
    // Lead-triggered CRITICAL cluster expansion — fans out from every confirmed
    // green FRESH_LEAD. Kill-switch: EXPANSION_ENABLED=off.
    try {
      const { startExpansionEngine } = await import("./clusterExpansion");
      startExpansionEngine();
    } catch (e: any) { console.warn("[expansion] start skipped:", e?.message); }
  }
  try {
    const { resumeDiscoveryJobs } = await import("./addressDiscovery/engine");
    resumeDiscoveryJobs();
  } catch (e: any) { console.warn("[address-discovery] resume skipped:", e?.message); }
  try {
    // Coming-Soon watchlist tick — urgency-cadence rechecks (NEW_BUILD reserved class)
    // + promote-on-flip + AGED lifecycle pass. Kill-switch: COMING_SOON_WATCHLIST=off.
    const { startComingSoonWatchlist } = await import("./comingSoonWatchlist");
    startComingSoonWatchlist();
  } catch (e: any) { console.warn("[coming-soon-watchlist] start skipped:", e?.message); }
  try {
    // Rumor-driven territory probes ("I heard there's Kinetic fiber near X"):
    // EXPLORE_CITIES="durham:nc,…" → bounded city sweeps outside the verified
    // catalog. Idempotent per city; see server/exploreCities.ts.
    const { startExploreCycle } = await import("./exploreCities");
    startExploreCycle();
  } catch (e: any) { console.warn("[explore-cities] start skipped:", e?.message); }
  try {
    // One-shot: terminalize the already-exhausted needs-fix tail (30k+ targets at
    // 8+ attempts re-burning ~30% of check capacity) as address_not_found without
    // spending one more check each. Idempotent; ANF_BACKFILL=off disables.
    if (process.env.ANF_BACKFILL !== "off") {
      const { finalizeAddressNotFoundBacklog } = await import("./scanIntelStore");
      const cap = Math.max(2, Math.floor(Number(process.env.ADDRESS_NOT_FOUND_ATTEMPTS ?? 6) || 6));
      const res = finalizeAddressNotFoundBacklog(cap);
      if (res.targets > 0) structuredLog("anf_backfill.finalized", { targets: res.targets, runs: res.runs, attemptCap: cap });
    }
  } catch (e: any) { console.warn("[anf-backfill] skipped:", e?.message); }
  // FRESH-LEAD BACKFILL INVARIANT: every already-confirmed green address (NEW FIBER +
  // billing N, per its latest conclusive snapshot) must be an assignable Field-Map lead.
  // Re-project ALL tenants once on boot from EXISTING data (no re-scan, no Decodo cost,
  // fully idempotent) so no confirmed fresh fiber sits un-actioned. Kill-switch:
  // FRESH_LEAD_BOOT_BACKFILL=off.
  if (process.env.FRESH_LEAD_BOOT_BACKFILL !== "off") {
    void (async () => {
      try {
        const { projectConfirmedFreshLeads } = await import("./freshFiberProjector");
        const { rawDb } = await import("./db");
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
          }
          structuredLog("fresh_lead.boot_backfill", { tenantId: tid, candidates: ids.length, created, linkedExisting: linkedProj });
        }
      } catch (e: any) { console.warn("[fresh-lead-backfill] skipped:", e?.message); }
    })();
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
      for (const entry of hotSpec.split(",").map((s) => s.trim()).filter(Boolean)) {
        const [city, st = "ga"] = entry.split(":").map((s) => s.trim());
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
  if ((process.env.HOT_MARKETS ?? DEFAULT_HOT_MARKETS) !== "off") {
    // First burst 90s after boot — hot markets start pumping almost immediately.
    setTimeout(() => { void runHotBurst(); }, 90 * 1000);
    const hotCycle = setInterval(() => { void runHotBurst(); }, 20 * 60_000);
    if (typeof (hotCycle as any).unref === "function") hotCycle.unref();
  }

  // COMING SOON PROGRAM — the overarching always-on watch system. The built-in
  // worker sweeps the durable watchlist every 15 minutes on an opportunity-
  // weighted cadence and promotes COMING_SOON → AVAILABLE into a green assignable
  // Fresh Lead with nearby expansion. Set COMING_SOON_PROGRAM=off to disable.
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
  }; // end startBackgroundServices

  // ── Purge expired sessions every 6 hours ────────────────────────────────
  setInterval(() => {
    try {
      const raw = (require("./db").db as any).driver ?? (require("./db").db as any).$client;
      raw.exec(`DELETE FROM sessions WHERE expires_at < datetime('now')`);
      raw.exec(`DELETE FROM otp_codes WHERE expires_at < datetime('now')`);
    } catch {}
  }, 6 * 60 * 60 * 1000);

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
