/**
 * Normalise a path to the spelling these matchers are written in.
 *
 * Every predicate in this file is a hand-rolled Set lookup or regexp, but
 * EXPRESS decides what actually reaches a handler - and Express defaults to
 * `caseSensitive: false` and `strict: false`. So `/API/SCAN/START` and
 * `/api/scan/start/` both run the same route while missing a `Set.has()` on
 * the exact lowercase, unslashed spelling. That is a bypass of every budget
 * expressed here, including the 120/hour ceiling on money-spending scan
 * mutations and the tighter per-IP controls on the auth endpoints.
 *
 * Path-MOUNTED limiters (`app.use("/api/x", limiter)`) are unaffected: Express
 * does that matching itself, case-insensitively. Only these hand-rolled
 * matchers drift, which is exactly why the normalisation belongs here, once,
 * rather than at each call site.
 *
 * Dot segments are deliberately NOT collapsed: Express does not collapse them
 * for routing either, so `/api/scan/./start` reaches no route at all and is not
 * a bypass. (`/uploads` is a different story - that one is a static mount, and
 * it is normalised at its own call site.)
 */
export function normalizeRateLimitPath(path: string): string {
  const lowered = (path || "").toLowerCase();
  // Trailing slash, but never turn "/" itself into "".
  return lowered.length > 1 && lowered.endsWith("/") ? lowered.slice(0, -1) : lowered;
}

const AUTH_PATHS = new Set([
  "/api/auth/otp/request",
  "/api/auth/otp/verify",
  "/api/auth/login",
  "/api/auth/setup",
]);

/** Auth endpoints have dedicated, tighter per-IP and per-email controls. */
export function isDedicatedAuthPath(path: string): boolean {
  return AUTH_PATHS.has(normalizeRateLimitPath(path));
}

/**
 * Scan polling and admission are high-volume authenticated workflows. Provider
 * pressure is governed by the shared queue/congestion controller, while each
 * route still enforces JWT role and billing policy. Counting 400ms progress
 * polls in the generic per-IP bucket would recreate a hidden scan cooldown for
 * mobile teams sharing one carrier NAT — so scan paths skip the GLOBAL bucket
 * here, but every one of them is metered by the dedicated PER-USER budgets
 * below (isScanMutationPath / isScanPollPath / isScanReadPath). Nothing under
 * /api/scan or /api/sweeps is unmetered anymore.
 */
export function isScanWorkflowPath(rawPath: string): boolean {
  const path = normalizeRateLimitPath(rawPath);
  return path === "/api/check-fiber"
    || path === "/api/scanner/state"
    || path === "/api/sweeps"
    || path.startsWith("/api/sweeps/")
    || path === "/api/scan"
    || path.startsWith("/api/scan/");
}

/**
 * The floor chat polls every 4s while the pane is open, plus a 30s baseline
 * from every field user's nav badge. Counted in the generic per-IP bucket,
 * a handful of reps behind one carrier NAT with the room open would burn the
 * whole team's budget and 429 the entire app — the exact failure the scan
 * exemption exists to prevent. Chat paths skip the GLOBAL bucket and are
 * metered by dedicated PER-USER budgets instead (chat limiters in limiters.ts
 * plus the per-route post budget). Nothing under /api/chat is unmetered.
 */
export function isChatPath(rawPath: string): boolean {
  const path = normalizeRateLimitPath(rawPath);
  return path === "/api/chat" || path.startsWith("/api/chat/");
}

/** Per-user hourly budget for chat GETs (default 3600 ≈ the 4s poll for an
 *  hour on two devices, with headroom for tab switches). */
export function chatReadRateLimitMax(raw: string | undefined): number {
  const configured = Number(raw);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 3_600;
}

/** Per-user hourly budget for chat writes that are NOT message posts —
 *  read-marks and deletes. Read-marks fire at most once per new-message batch,
 *  so 1200/hour clears even a nonstop room while capping scripted spam. */
export function chatWriteRateLimitMax(raw: string | undefined): number {
  const configured = Number(raw);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 1_200;
}

/**
 * Mobile map/polling traffic can legitimately exceed the old 150/15m ceiling.
 * Keep this environment-tunable, but use a practical default for shared NATs.
 */
export function globalApiRateLimitMax(raw: string | undefined): number {
  const configured = Number(raw);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 1_200;
}

// ── Dedicated scan budgets (SEC-B) ──────────────────────────────────────────
// The scan workflow stays OUTSIDE the global per-IP bucket (shared carrier NATs
// must not cooldown a whole field team), but it is NO LONGER blanket-exempt
// from metering: every scan path falls into exactly one dedicated PER-USER
// bucket below, enforced by scanWorkflowRateLimits() in limiters.ts.

/**
 * Money-spending scan mutations — each call burns metered upstream
 * (geocoding/qualification) budget, so they get the tightest bucket.
 * Matched against the FULL path (req.path outside any mount).
 */
const SCAN_MUTATION_PATHS = new Set([
  "/api/scan/start",
  "/api/scan/start-city",
  "/api/scan/area",
  "/api/scan/tiled",
  "/api/scan/daily-refresh",
  "/api/scan/runs",
  "/api/scan/rescan-pool",
  "/api/scan/deploy",
  "/api/sweeps/city",
  "/api/sweeps/state",
  "/api/sweeps/address",
  "/api/check-fiber",
  "/api/leads/scan-house",
]);

export function isScanMutationPath(rawPath: string): boolean {
  const path = normalizeRateLimitPath(rawPath);
  if (SCAN_MUTATION_PATHS.has(path)) return true;
  // Run lifecycle actions (pause/resume/cancel) restart spend on demand.
  return /^\/api\/scan\/runs\/[^/]+\/(pause|resume|cancel|stop)$/.test(path);
}

/**
 * Hot progress-poll surface: the scan board refetches job state every 1.5–3s
 * while a scan runs. These stay bounded (not exempt) but need a budget sized
 * for sustained polling — the SSE stream is the primary channel and has its
 * own connection caps (see scanSseCaps).
 */
export function isScanPollPath(rawPath: string): boolean {
  const path = normalizeRateLimitPath(rawPath);
  return path === "/api/scan"
    || path === "/api/scanner/state"
    || /^\/api\/scan\/[^/]+$/.test(path)                    // GET /api/scan/:jobId
    || /^\/api\/scan\/runs\/[^/]+$/.test(path);             // GET /api/scan/runs/:id
}

/** Read-only scan GETs that are not the hot poll loop. */
export function isScanReadPath(path: string): boolean {
  if (!isScanWorkflowPath(path)) return false;
  return !isScanPollPath(path);
}

/** Per-user hourly budget for money-spending scan mutations (default 120). */
export function scanMutationRateLimitMax(raw: string | undefined): number {
  const configured = Number(raw);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 120;
}

/** Per-user hourly budget for ordinary read-only scan GETs (default 600). */
export function scanReadRateLimitMax(raw: string | undefined): number {
  const configured = Number(raw);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 600;
}

/** Per-user hourly budget for the hot progress poll (default 3600 ≈ 1/s for an hour). */
export function scanPollRateLimitMax(raw: string | undefined): number {
  const configured = Number(raw);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 3_600;
}

/** Rescan-pool is a fleet-scale re-scan: a handful per hour per user is plenty. */
export function rescanPoolRateLimitMax(raw: string | undefined): number {
  const configured = Number(raw);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 6;
}

export function shouldSkipGlobalRateLimit(path: string, nodeEnv: string | undefined): boolean {
  if (isDedicatedAuthPath(path)) return true;
  if (isScanWorkflowPath(path)) return true;
  // Same shared-NAT reasoning as scans; per-user chat budgets replace the
  // global bucket for these paths (see isChatPath above).
  if (isChatPath(path)) return true;
  return nodeEnv !== "production" && !path.startsWith("/api");
}
