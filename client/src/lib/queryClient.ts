import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Module-level session ID — set by auth context
let _sessionId: string | null = null;
export function setSessionId(id: string | null) { _sessionId = id; }
export function getStoredSessionId() { return _sessionId; }

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
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
