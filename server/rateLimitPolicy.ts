const AUTH_PATHS = new Set([
  "/api/auth/otp/request",
  "/api/auth/otp/verify",
  "/api/auth/login",
  "/api/auth/setup",
]);

/** Auth endpoints have dedicated, tighter per-IP and per-email controls. */
export function isDedicatedAuthPath(path: string): boolean {
  return AUTH_PATHS.has(path);
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
export function isScanWorkflowPath(path: string): boolean {
  return path === "/api/check-fiber"
    || path === "/api/scanner/state"
    || path === "/api/sweeps"
    || path.startsWith("/api/sweeps/")
    || path === "/api/scan"
    || path.startsWith("/api/scan/");
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

export function isScanMutationPath(path: string): boolean {
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
export function isScanPollPath(path: string): boolean {
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
  return nodeEnv !== "production" && !path.startsWith("/api");
}
