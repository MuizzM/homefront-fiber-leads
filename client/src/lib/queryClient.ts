import { QueryCache, QueryClient, QueryFunction } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { signalKnockRecovery } from "@/lib/knockQueue";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Module-level session ID — set by auth context
let _sessionId: string | null = null;
export function setSessionId(id: string | null) { _sessionId = id; }
export function getStoredSessionId() { return _sessionId; }

// Global 401 handler — registered by the auth context. When a request comes back
// 401 while we HELD a session, the session expired server-side: fail the whole
// app to a single re-auth path instead of letting each screen silently error
// (which used to leave reps staring at stale data with no way back in).
let _onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) { _onUnauthorized = fn; }
function notifyIfSessionExpired(status: number) {
  // Only when we actually had a session — a 401 during login (no token yet) is
  // a normal "wrong code", not an expiry, and must NOT trigger a logout.
  if (status === 401 && _sessionId) _onUnauthorized?.();
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly requestId: string | null,
    public readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function responseMessage(status: number, raw: string, fallback: string): string {
  let detail = raw.trim();
  try {
    const parsed = JSON.parse(detail);
    if (parsed && typeof parsed === "object") detail = String(parsed.error || parsed.message || fallback);
  } catch { /* plain-text API error */ }
  // Never let an upstream HTML page or accidentally-large diagnostic flood a
  // toast/error surface. The request id remains available for support tracing.
  detail = detail.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 320) || fallback;
  return `${status}: ${detail}`;
}

function authHeaders(extra?: Record<string, string>, includeCsrf = false): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (_sessionId) {
    h["x-session-id"] = _sessionId;
    // Double-submit CSRF pattern: include session ID as CSRF token on all mutations.
    // A cross-site attacker cannot read the session ID from JS (different origin),
    // so matching it server-side proves the request came from our app.
    if (includeCsrf) h["x-csrf-token"] = _sessionId;
  }
  return h;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(
      res.status,
      responseMessage(res.status, text, res.statusText || "Request failed"),
      res.headers.get("x-request-id"),
      retryAfterMs(res),
    );
  }
}

/** Safe GET retry policy for flaky field connections; mutations remain one-shot. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (!(error instanceof ApiError)) return failureCount < 1;
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
}

export function queryRetryDelay(attempt: number, error: unknown): number {
  if (error instanceof ApiError && error.retryAfterMs != null) {
    return Math.min(30_000, Math.max(250, error.retryAfterMs));
  }
  return Math.min(8_000, 600 * 2 ** attempt);
}

// In-flight GET de-dupe: when several callers (multiple queries/components, or a
// burst of invalidations settling in the same tick) request the SAME url at once,
// they share ONE network request instead of hammering the server N times (we saw
// ~15 concurrent /api/leads/map hits on mount). Each caller gets its own clone()
// so their independent .json()/.text() reads never collide. Only GETs with no body
// are shared; mutations always run their own request.
const _inflightGets = new Map<string, Promise<Response>>();

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const m = method.toUpperCase();
  const isMutation = !["GET", "HEAD"].includes(m);

  if (!isMutation && data == null) {
    const key = `${m} ${url}`;
    let shared = _inflightGets.get(key);
    if (!shared) {
      shared = fetch(`${API_BASE}${url}`, { headers: authHeaders() }).then(async (res) => {
        notifyIfSessionExpired(res.status);
        await throwIfResNotOk(res);
        return res; // body left UNREAD → every caller reads its own clone
      });
      _inflightGets.set(key, shared);
      // Free the slot once settled so a later, genuinely-new request re-fetches.
      shared.finally(() => { if (_inflightGets.get(key) === shared) _inflightGets.delete(key); });
    }
    return (await shared).clone();
  }

  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: authHeaders(
      data ? { "Content-Type": "application/json" } : {},
      isMutation, // attach CSRF token on all state-changing requests
    ),
    body: data ? JSON.stringify(data) : undefined,
  });

  notifyIfSessionExpired(res.status);
  await throwIfResNotOk(res);
  return res;
}

// Multipart upload — same session + CSRF headers and 401→re-auth path as
// apiRequest, but leaves Content-Type unset so the browser writes the multipart
// boundary. Use for file uploads (apiRequest JSON-encodes its body).
export async function apiUpload(url: string, form: FormData): Promise<Response> {
  const res = await fetch(`${API_BASE}${url}`, {
    method: "POST",
    headers: authHeaders({}, true), // x-session-id + x-csrf-token; NO content-type
    body: form,
  });
  notifyIfSessionExpired(res.status);
  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey[0]}`, {
      headers: authHeaders(),
    });

    notifyIfSessionExpired(res.status);
    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

// ── Knock-queue recovery signal ───────────────────────────────────────────────
// The FIRST successful query after any query failure means connectivity + auth
// are demonstrably healthy again — exactly the moment the knock queue's dead
// lane should try to heal itself (server-restart 403s parked there otherwise
// wait for a human tap). The queue side is cooldown-gated (one silent sweep
// per minute at most), so this edge-triggered nudge can never hot-loop.
// Exported so the queue tests can drive the signal without mounting queries.
let _sawQueryFailure = false;
export function noteQueryOutcome(ok: boolean): void {
  if (!ok) {
    _sawQueryFailure = true;
    return;
  }
  if (_sawQueryFailure) {
    _sawQueryFailure = false;
    signalKnockRecovery();
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: () => noteQueryOutcome(false),
    onSuccess: () => noteQueryOutcome(true),
  }),
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      // 60s freshness window: navigating between tabs re-uses cached data
      // instantly (no spinner, no API churn), but data older than a minute
      // refetches in the background so other reps' knocks/assignments appear.
      // (Was Infinity — data never refreshed unless this tab mutated it.)
      staleTime: 60_000,
      // Keep inactive query data for 24h so a persisted entry survives long
      // enough to be rehydrated on the next launch (must be >= persister maxAge).
      gcTime: 1000 * 60 * 60 * 24,
      retry: shouldRetryQuery,
      retryDelay: queryRetryDelay,
    },
    mutations: {
      retry: false,
    },
  },
});

// ── Stale-while-revalidate to disk (dashboard first paint) ────────────────────
// Persist ONLY the dashboard's aggregate stat + fiber-changes queries to
// localStorage. On the next launch the dashboard paints instantly from this
// snapshot, then TanStack revalidates in the background. Large / PII-bearing
// datasets (leads, map pins) are deliberately NOT persisted — they stay in
// memory only, keeping the localStorage snapshot tiny and non-sensitive.
export const PERSISTED_QUERY_KEYS = new Set<string>([
  "/api/stats/saas",
  "/api/stats",
  "/api/scan/first-seen-live",
]);

const QUERY_CACHE_STORAGE_KEY = "hf-query-cache-v1";

export const queryPersister =
  typeof window !== "undefined"
    ? createSyncStoragePersister({
        storage: window.localStorage,
        key: QUERY_CACHE_STORAGE_KEY,
        throttleTime: 1000,
      })
    : undefined;

export const persistOptions = {
  persister: queryPersister!,
  // Must match the query gcTime so a restored entry isn't immediately evicted.
  maxAge: 1000 * 60 * 60 * 24,
  // Bump to invalidate every persisted cache after a breaking response shape change.
  buster: "hf-cache-1",
  dehydrateOptions: {
    shouldDehydrateQuery: (query: { state: { status: string }; queryKey: unknown }) =>
      query.state.status === "success" &&
      PERSISTED_QUERY_KEYS.has(
        String(Array.isArray(query.queryKey) ? query.queryKey[0] : query.queryKey),
      ),
  },
};

// Purge the on-disk snapshot (call on logout so the next account never paints
// the previous user's dashboard from cache).
export function clearPersistedQueryCache(): void {
  try {
    if (typeof window !== "undefined") window.localStorage.removeItem(QUERY_CACHE_STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode) — nothing to clear */
  }
}
