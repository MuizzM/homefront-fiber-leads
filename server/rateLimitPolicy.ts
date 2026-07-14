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
 * Mobile map/polling traffic can legitimately exceed the old 150/15m ceiling.
 * Keep this environment-tunable, but use a practical default for shared NATs.
 */
export function globalApiRateLimitMax(raw: string | undefined): number {
  const configured = Number(raw);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 1_200;
}

export function shouldSkipGlobalRateLimit(path: string, nodeEnv: string | undefined): boolean {
  if (isDedicatedAuthPath(path)) return true;
  return nodeEnv !== "production" && !path.startsWith("/api");
}
