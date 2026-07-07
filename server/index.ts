import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import crypto from "crypto";
import { registerRoutes, registerSaasRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { runMigrations } from "./storage";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";

// Node <20.12 compat: Vite 7's dep optimizer calls crypto.hash(), which was
// only added in Node 20.12/21. Polyfill it so dev works on older runtimes;
// on newer Node this branch is skipped entirely.
if (typeof (crypto as any).hash !== "function") {
  (crypto as any).hash = (algorithm: string, data: crypto.BinaryLike, outputEncoding: crypto.BinaryToTextEncoding = "hex") =>
    crypto.createHash(algorithm).update(data).digest(outputEncoding);
}

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

// ── CORS — tight allowlist; standalone scanner uses secret not origin trust ───
// We do NOT use origin:true — instead the submit-leads endpoint uses a
// server-side secret validated with timingSafeEqual. CORS just lets the
// pre-flight through; auth is enforced in the route handler.
const ALLOWED_ORIGINS = [
  process.env.APP_ORIGIN,
  "https://www.perplexity.ai",
  "https://sites.pplx.app",
].filter(Boolean) as string[];

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // same-origin / curl / server-side — allow
  return ALLOWED_ORIGINS.some(o => origin === o) ||
         origin.endsWith(".pplx.app");
}

// Submit-leads: allow cross-origin so standalone scanner HTML can POST;
// actual auth is the SCANNER_SUBMIT_SECRET (timingSafeEqual), not origin.
app.options("/api/scan/submit-leads", cors({ origin: true, methods: ["POST", "OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.use("/api/scan/submit-leads", cors({ origin: true, methods: ["POST", "OPTIONS"], allowedHeaders: ["Content-Type"] }));

// All other API routes: strict origin allowlist
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
      workerSrc:      ["'self'", "blob:"],
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
      frameAncestors: ["'self'", "https://www.perplexity.ai", "https://sites.pplx.app"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "cross-origin" }, // allow font/image assets
  noSniff: true,
  frameguard: false,           // handled via CSP frameAncestors above
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

// ── Permissions-Policy: disable sensors/camera/mic/geolocation ──
app.use((_req, res, next) => {
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
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
  "/api/scan/submit-leads",   // uses its own secret
  "/api/onboarding/apply",    // public form
  "/join",
]);
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
  "stack", "trace", "errno", "syscall", "code",
  "KFS_AUTH_BASIC", "SCANNER_SUBMIT_SECRET", "SMTP_PASS",
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
  "/api/config/scanner-secret",
]);
app.use((req, res, next) => {
  if (SANITIZE_EXEMPT_PATHS.has(req.path)) return next();
  const origJson = res.json.bind(res);
  res.json = function(body: any) { return origJson(sanitizeVal(body)); };
  next();
});

// ── Global rate limit: 150 req / 15 min per IP ───────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again in 15 minutes." },
  // In development, Vite serves hundreds of module files through this same
  // Express app; counting them exhausts the budget in a couple of reloads and
  // 429s the whole app. Only meter API traffic in dev — prod ships a bundle,
  // so the global limit still guards every request there.
  skip: (req) => process.env.NODE_ENV !== "production" && !req.path.startsWith("/api"),
  // Use forwarded IP for proxied deployments
  keyGenerator: (req) => {
    const forwarded = req.headers["x-forwarded-for"] as string | undefined;
    return forwarded ? forwarded.split(",")[0].trim() : (req.socket.remoteAddress ?? "unknown");
  },
}));

// ── Strict auth rate limit: 10 attempts / 15 min per IP ──────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again in 15 minutes." },
  skipSuccessfulRequests: true,
});

// ── OTP rate limit: 5 requests / 10 min per IP ───────────────────────────────
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
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
  const start = Date.now();
  const reqPath = req.path;
  res.on("finish", () => {
    if (reqPath.startsWith("/api")) {
      log(`${req.method} ${reqPath} ${res.statusCode} in ${Date.now() - start}ms`);
    }
  });
  next();
});

(async () => {
  runMigrations();

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
    },
  );
})();
