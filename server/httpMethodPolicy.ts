const UNSAFE_HTTP_METHODS = new Set(["TRACE", "TRACK", "CONNECT"]);

/** Methods the portal never needs and should never hand to the SPA fallback. */
export function isUnsafeHttpMethod(method: string | null | undefined): boolean {
  return UNSAFE_HTTP_METHODS.has(String(method ?? "").toUpperCase());
}

export const PORTAL_ALLOWED_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
