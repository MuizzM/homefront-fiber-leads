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
 * mobile teams sharing one carrier NAT.
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

export function shouldSkipGlobalRateLimit(path: string, nodeEnv: string | undefined): boolean {
  if (isDedicatedAuthPath(path)) return true;
  if (isScanWorkflowPath(path)) return true;
  return nodeEnv !== "production" && !path.startsWith("/api");
}
