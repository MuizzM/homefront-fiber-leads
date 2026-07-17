import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KINETIC_345_JAMES_ALLGOOD as FIX } from "../fixtures/kinetic345JamesAllgood";

// Live Test auth contract (DECODO-EXCLUSIVE):
//  - the token mint AND the address search both egress through proxyFetch (Decodo).
//    There is no directFetch / server-IP path anywhere.
//  - on an authenticated denial (401/403) the scanner asks for a fresh authorized
//    Decodo session (rotateProxySession → new residential IP) and retries the SAME
//    address; the mint's single-flight gate is preserved.
//  - a persistent auth denial → PENDING_AUTH (address kept for retry), NEVER no_service.
const { proxyFetch, rotateProxySession } = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
  rotateProxySession: vi.fn(async () => {}),
}));
vi.mock("../../server/proxy-fetch", () => ({
  proxyFetch,
  rotateProxySession,
  getProxySessionId: () => "decodo-s1",
  isProxyConnected: () => true,
  getProxyStatus: () => ({ enabled: true, url: "http://redacted@proxy", slots: 100, sessionId: "decodo-s1" }),
}));
vi.mock("../../server/distributedProviderCoordinator", () => {
  class DistributedProviderCoordinator<T> {
    async execute(_key: string, _source: string, task: () => Promise<T>): Promise<T> { return task(); }
    pauseFor() { return Date.now(); }
    halt() {}
    resume() {}
    snapshot() {
      return { active: 0, queued: 0, startsLastMinute: 0, maxConcurrency: 45, maxRequestsPerMinute: 100,
        pausedUntil: null, halted: false, haltReason: null, instanceId: "test" };
    }
  }
  return { DistributedProviderCoordinator, DistributedProviderHaltedError: Error };
});

let scanner: typeof import("../../server/scanner");

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const isTokenUrl = (u: string) => u.includes("/_internal/precisely/token") || u.includes("/auth/session");
const isSearchUrl = (u: string) => u.includes("/address/search");
const freshToken = () => json(201, { token: `t${Math.random()}`.padEnd(40, "x"), success: true });

const ADDR = ["4023 Dakeita Circle", "Concord", "NC", "28025"] as const;

describe("Live Test authentication flow — Decodo-exclusive", () => {
  beforeAll(async () => {
    process.env.KFS_AUTOMATION_AUTHORIZED = "false";
    process.env.KFS_TOKEN_POOL_WARM_MIN = "1";
    process.env.KFS_MINT_MIN_INTERVAL_MS = "0";
    scanner = await import("../../server/scanner");
    process.env.KFS_AUTOMATION_AUTHORIZED = "true";
  });

  beforeEach(() => {
    proxyFetch.mockReset();
    rotateProxySession.mockClear();
    scanner.__resetTokenTransportStateForTests();
  });

  it("mints AND searches through Decodo only (proxyFetch) — address checked", async () => {
    proxyFetch.mockImplementation(async (url: string) => isTokenUrl(url) ? freshToken() : json(200, FIX));
    const out = await scanner.liveTestAddress(...ADDR);
    expect(out.checked).toBe(true);
    expect(out.classification).toBe("fresh_fiber");
    expect(out.pendingAuth).toBe(false);
    // Every network call — mint and search — went through proxyFetch (Decodo).
    const urls = proxyFetch.mock.calls.map(([u]) => String(u));
    expect(urls.some(isTokenUrl)).toBe(true);   // mint via Decodo
    expect(urls.some(isSearchUrl)).toBe(true);  // search via Decodo
    // No auth failure → no session rotation needed.
    expect(rotateProxySession).not.toHaveBeenCalled();
  });

  it("mint 403 → rotates a fresh Decodo session and retries → address checked", async () => {
    let mintCalls = 0;
    proxyFetch.mockImplementation(async (url: string) => {
      if (isSearchUrl(url)) return json(200, FIX);
      mintCalls++;
      return mintCalls === 1 ? json(403, {}) : freshToken(); // first mint 403, retry ok
    });
    const out = await scanner.liveTestAddress(...ADDR);
    expect(out.checked).toBe(true);
    expect(out.classification).toBe("fresh_fiber");
    // A fresh authorized Decodo session was obtained before the mint retry.
    expect(rotateProxySession).toHaveBeenCalled();
  });

  it("mint 403 persists → PENDING_AUTH, never no_service, no search fired", async () => {
    proxyFetch.mockImplementation(async (url: string) => {
      if (isSearchUrl(url)) throw new Error("search must not run without a token");
      return json(403, {}); // every mint attempt denied
    });
    const out = await scanner.liveTestAddress(...ADDR);
    expect(out.checked).toBe(false);
    expect(out.pendingAuth).toBe(true);
    expect(out.classification).toBe("pending_auth");
    expect(out.classification).not.toBe("no_service");
    expect(rotateProxySession).toHaveBeenCalled(); // tried to recover with fresh sessions
    expect(proxyFetch.mock.calls.filter(([u]) => isSearchUrl(String(u))).length).toBe(0);
  });

  it("Search 403 → invalidate + rotate + re-mint + retry SAME address once → checked", async () => {
    let searches = 0;
    proxyFetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (isTokenUrl(url)) return freshToken();
      searches++;
      const body = JSON.parse(String(init.body));
      expect(body.addressLine1).toBe("4023 Dakeita Circle"); // same address every attempt
      return searches === 1 ? json(403, {}) : json(200, FIX);
    });
    const out = await scanner.liveTestAddress(...ADDR);
    expect(searches).toBe(2); // exactly one retry — no duplicate storm
    expect(out.checked).toBe(true);
    expect(out.classification).toBe("fresh_fiber");
    expect(out.stages.some(s => s.stage === "Auth retry")).toBe(true);
    // Search 403 rotated a fresh Decodo session.
    expect(rotateProxySession).toHaveBeenCalled();
  });

  it("Search 403 persists after re-mint → PENDING_AUTH, never no_service", async () => {
    proxyFetch.mockImplementation(async (url: string) => isTokenUrl(url) ? freshToken() : json(403, {}));
    const out = await scanner.liveTestAddress(...ADDR);
    expect(out.checked).toBe(false);
    expect(out.pendingAuth).toBe(true);
    expect(out.classification).toBe("pending_auth");
    expect(out.classification).not.toBe("no_service");
    // Exactly two search attempts (original + one post-remint retry).
    expect(proxyFetch.mock.calls.filter(([u]) => isSearchUrl(String(u))).length).toBe(2);
  });
});
