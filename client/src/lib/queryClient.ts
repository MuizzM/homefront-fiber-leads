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
    public readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function responseCode(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && typeof parsed.code === "string"
      ? parsed.code
      : null;
  } catch {
    return null;
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
      responseCode(text),
    );
  }
}

/**
 * A fetch that never got a response at all.
 *
 * `fetch` rejects with a bare TypeError whose message is pure platform detail -
 * Safari says "Load failed", Chrome "Failed to fetch", Firefox "NetworkError
 * when attempting to fetch resource". Mutations surface `e.message` in a toast,
 * so a manager assigning doors during a server stall was shown the words
 * "Load failed" and nothing else. See docs/architecture/BULK_ASSIGNMENT.md.
 *
 * This is a DIFFERENT failure from an error response: the server made no
 * decision, so the write's fate is genuinely unknown and the request may be
 * safely retried when the caller knows the operation is idempotent.
 */
export class NetworkError extends Error {
  readonly cause?: unknown;
  constructor(cause?: unknown) {
    super(
      typeof navigator !== "undefined" && navigator.onLine === false
        ? "You are offline - reconnect and try again."
        : "Lost connection to the server before it answered. Nothing may have been saved - try again.",
    );
    this.name = "NetworkError";
    this.cause = cause;
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

// A completed mutation makes every in-flight GET's eventual body suspect: it
// left the server BEFORE the write. Any query that refetches after the
// mutation (invalidation, onSettled) must not be handed that pre-write body —
// that is exactly how a just-created lead vanished from the list until some
// later refetch found it. Busting the share map doesn't abort the underlying
// requests (their earlier callers still get their response); it only stops
// NEW callers from joining a response that predates the write.
function bustInflightGetShare(): void {
  _inflightGets.clear();
}

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
      // .then(onOk, onErr), NOT .finally: .finally's derived promise would
      // itself reject UNHANDLED when the shared request fails (offline GET),
      // which surfaces as unhandled-rejection noise in tests and consoles.
      shared.then(
        () => { if (_inflightGets.get(key) === shared) _inflightGets.delete(key); },
        () => { if (_inflightGets.get(key) === shared) _inflightGets.delete(key); },
      );
    }
    return (await shared).clone();
  }

  let res: Response;
  try {
    try {
      res = await fetch(`${API_BASE}${url}`, {
        method,
        headers: authHeaders(
          data ? { "Content-Type": "application/json" } : {},
          isMutation, // attach CSRF token on all state-changing requests
        ),
        body: data ? JSON.stringify(data) : undefined,
      });
    } catch (e) {
      // The request died at the network layer - no status, no body. Raise a
      // typed error with a human sentence instead of letting the platform's
      // "Load failed" / "Failed to fetch" reach a toast.
      throw new NetworkError(e);
    }
  } finally {
    // Even a network-failed mutation may have reached the server — the write's
    // fate is unknown, so pre-mutation GET bodies stay unjoinable either way.
    if (isMutation) bustInflightGetShare();
  }

  notifyIfSessionExpired(res.status);
  await throwIfResNotOk(res);
  return res;
}

/**
 * apiRequest for writes whose repetition is a no-op, so a dead connection can be
 * retried instead of shown to the user.
 *
 * Assignment qualifies: setting `assigned_rep_id` to the same rep twice reaches
 * the same end state. When the server is stalled its window is seconds, not
 * minutes, so the backoff deliberately straddles it - the retry is what turns a
 * visible failure into a slow success.
 *
 * ONLY NetworkError is retried. An error RESPONSE is a decision the server made
 * and repeating it just asks the same question twice.
 */
export async function apiRequestIdempotent(
  method: string,
  url: string,
  data?: unknown,
  attempts = 3,
): Promise<Response> {
  const backoffMs = [2_000, 6_000];
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await apiRequest(method, url, data);
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      lastError = e;
      if (attempt < attempts - 1) {
        await new Promise((r) => setTimeout(r, backoffMs[Math.min(attempt, backoffMs.length - 1)]));
      }
    }
  }
  throw lastError;
}

// Multipart upload — same session + CSRF headers and 401→re-auth path as
// apiRequest, but leaves Content-Type unset so the browser writes the multipart
// boundary. Use for file uploads (apiRequest JSON-encodes its body).
export async function apiUpload(url: string, form: FormData): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${url}`, {
      method: "POST",
      headers: authHeaders({}, true), // x-session-id + x-csrf-token; NO content-type
      body: form,
    });
  } finally {
    bustInflightGetShare(); // uploads mutate too — same stale-share rule
  }
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
      // How long an UNMOUNTED query's data is kept. 30min covers navigating
      // away and back (including a screen read from cache while offline) and
      // then lets it go: this default used to be 24h for everything, which on a
      // long manager session pinned every paged/filtered Leads entry and every
      // per-lead subquery in memory for the rest of the day. The entries that
      // genuinely need to outlive it — the persisted ones, and the offline-first
      // field screens — get their own 24h gcTime via setQueryDefaults below.
      gcTime: 30 * 60_000,
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
  // CE-2 coaching engine: the drill-card deck snapshot makes the whole
  // coaching loop work offline after one warm visit.
  "/api/training/deck",
  // Training progress: the hero ring, streak and module rings paint their real
  // numbers instantly on revisit instead of a dash, then reconcile.
  "/api/training/progress",
]);

// Screens a rep reads with no signal. These are NOT persisted to disk (too
// personal / too large for localStorage), so the ONLY thing keeping "Offline —
// showing your last synced follow-ups" honest after a few hours away from the
// screen is in-memory retention. They keep the old 24h gcTime; the global
// default no longer does.
const OFFLINE_RETAINED_QUERY_KEYS: readonly string[] = [
  "/api/followups",
  "/api/clock/status",
  // The opportunity-score overlay behind Today's route order and its "why"
  // chips. In a dead zone this fetch simply fails, and without retention the
  // rep's route silently degrades to distance-only mid-shift. Retained in
  // MEMORY only, never persisted: it is lead-level data, like the map pins.
  "/api/leads/ranked",
];

const DAY_MS = 1000 * 60 * 60 * 24;

// Per-key retention. setQueryDefaults matches by key PREFIX, and every entry
// below is the first (and for these, only) segment of the real query key — the
// same segment shouldDehydrateQuery matches on — so a default set here lands on
// exactly the query it names.
for (const key of [...PERSISTED_QUERY_KEYS, ...OFFLINE_RETAINED_QUERY_KEYS]) {
  queryClient.setQueryDefaults([key], { gcTime: DAY_MS });
}

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
  // Must match the gcTime of the keys that actually persist — the 24h
  // setQueryDefaults applied to PERSISTED_QUERY_KEYS above, NOT the 30min
  // global default — so a restored entry isn't immediately evicted.
  maxAge: DAY_MS,
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

// ── Session-scoped localStorage sweep (SEC-B) ───────────────────────────────
// On logout / confirmed 401 / identity switch, the previous account's
// session-scoped data must not survive for the next user of the device. The
// sweep is PREFIX-based and deliberately narrow — unrelated keys (map camera,
// filter prefs, last geo fix) are convenience state, not account data, and
// stay.
const SESSION_SCOPED_KEY_PREFIXES = [
  "hf.mapPinsSnapshot.", // per-tenant/rep pin snapshots (address-level data)
  // The direct sibling of the line above, and it was the one omission: the
  // WINDOW snapshot persists up to 1.5MB of the same address-level rows
  // (street, city, zip, do-not-knock) plus the bbox they were fetched for.
  // Both families are written by mapPinsSnapshot.ts; only one was swept.
  "hf.mapWindowSnapshot.",
  "hf.knockQueue.v1.",   // queued knocks for the signed-out rep
  "hf.knockDead.v1.",    // dead-lettered knocks for the signed-out rep
  // Training review outbox - the one queue cloned from knockQueue whose prefix
  // never made it into this list (trainingReviewQueue.ts).
  "hf.trainingReviews.v1.",
  // Recorded pitch audio, persisted under a DEVICE-GLOBAL key (PitchRecorder's
  // PERSIST_PREFIX): without this, the next rep to open the recorder on a
  // shared crew tablet is handed a colleague's voice recording.
  "pitch-take:",
];
const SESSION_SCOPED_KEYS = [
  "hf.pendingNotes.v1",  // stashed lead notes awaiting sync
  // Offline GPS queue (fieldTracking.ts QUEUE_KEY). It is not keyed by
  // identity, so anything unflushed at logout is replayed under the NEXT rep's
  // session - one rep's location trail written into another's shift. Purging
  // at logout is the containment; identity-keying the queue is the real fix
  // and is a larger change.
  "hfs.fieldTracking.queue",
];

export function isSessionScopedStorageKey(key: string): boolean {
  return SESSION_SCOPED_KEYS.includes(key)
    || SESSION_SCOPED_KEY_PREFIXES.some((p) => key.startsWith(p));
}

export function purgeSessionScopedKeys(): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    // Collect first — removing while iterating shifts indexes.
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && isSessionScopedStorageKey(key)) doomed.push(key);
    }
    for (const key of doomed) window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable (private mode) — nothing to clear */
  }
}
