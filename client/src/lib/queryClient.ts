import { QueryClient, QueryFunction } from "@tanstack/react-query";

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
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const isMutation = !["GET", "HEAD"].includes(method.toUpperCase());
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

export const queryClient = new QueryClient({
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
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
