import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { enablePush, disablePush } from "@/lib/pushNotifications";
import { setSessionId } from "@/lib/queryClient";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * CONTRACT — push registration rides the header-auth wire, not cookies.
 *
 * The API authenticates every /api/push/* route by the x-session-id header
 * (requireAuth reads nothing else), and the CSRF middleware rejects any
 * non-exempt POST without x-csrf-token. There is no auth cookie, so a
 * credentials:"include" fetch with neither header is a guaranteed 401/403 —
 * the exact bug class of the PDF review pane (a5cab11). These tests pin the
 * fix: enablePush/disablePush go through apiRequest, so
 *
 *   GET  /api/push/key         → carries x-session-id (no CSRF: it's a read)
 *   POST /api/push/subscribe   → carries x-session-id AND x-csrf-token
 *   POST /api/push/unsubscribe → carries x-session-id AND x-csrf-token
 *
 * and a server refusal still degrades to enablePush() === false, never a
 * thrown error — a rep who can't register is an ordinary outcome.
 * ────────────────────────────────────────────────────────────────────────────
 */

const SESSION = "sess-push-1";

function jsonRes(body: unknown, status = 200) {
  return Response.json(body, { status });
}

const subscription = {
  endpoint: "https://push.example/ep-1",
  unsubscribe: vi.fn(async () => true),
  toJSON: () => ({
    endpoint: "https://push.example/ep-1",
    keys: { p256dh: "p256dh-key", auth: "auth-secret" },
  }),
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/push/key") return jsonRes({ publicKey: "QUJDREVG" });
    return jsonRes({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  // A ready platform: permission already granted, an existing subscription to
  // reuse — the test exercises the wire, not the permission choreography.
  vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
  vi.stubGlobal("PushManager", class {});
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => subscription } }) },
  });
  setSessionId(SESSION);
});

afterEach(() => {
  setSessionId(null);
  delete (navigator as any).serviceWorker;
  vi.unstubAllGlobals();
});

describe("enablePush wire contract", () => {
  it("fetches the VAPID key with the session header and subscribes with session + CSRF headers", async () => {
    await expect(enablePush()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [keyUrl, keyInit] = fetchMock.mock.calls[0];
    expect(keyUrl).toBe("/api/push/key");
    expect(keyInit?.headers?.["x-session-id"]).toBe(SESSION);
    // Reads never carry the CSRF token — double-submit is mutation-only.
    expect(keyInit?.headers?.["x-csrf-token"]).toBeUndefined();

    const [subUrl, subInit] = fetchMock.mock.calls[1];
    expect(subUrl).toBe("/api/push/subscribe");
    expect(subInit.method).toBe("POST");
    expect(subInit.headers["x-session-id"]).toBe(SESSION);
    expect(subInit.headers["x-csrf-token"]).toBe(SESSION);
    expect(subInit.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(subInit.body)).toMatchObject({
      endpoint: "https://push.example/ep-1",
      p256dh: "p256dh-key",
      auth: "auth-secret",
    });
  });

  it("returns false, not a throw, when the server refuses the key", async () => {
    fetchMock.mockImplementation(async () => jsonRes({ error: "Not authenticated" }, 401));
    await expect(enablePush()).resolves.toBe(false);
  });

  it("returns false, not a throw, when the subscribe POST is refused", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/push/key"
        ? jsonRes({ publicKey: "QUJDREVG" })
        : jsonRes({ error: "CSRF token invalid" }, 403));
    await expect(enablePush()).resolves.toBe(false);
  });
});

describe("disablePush wire contract", () => {
  it("reports the dropped endpoint with session + CSRF headers", async () => {
    await disablePush();

    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/push/unsubscribe");
    expect(init.method).toBe("POST");
    expect(init.headers["x-session-id"]).toBe(SESSION);
    expect(init.headers["x-csrf-token"]).toBe(SESSION);
    expect(JSON.parse(init.body)).toEqual({ endpoint: "https://push.example/ep-1" });
  });
});
