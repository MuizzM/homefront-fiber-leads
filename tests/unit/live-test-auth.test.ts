import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KINETIC_345_JAMES_ALLGOOD as FIX } from "../fixtures/kinetic345JamesAllgood";

// Live Test auth contract:
//  - the token mint is a TWO-TRANSPORT fail-over: DIRECT (server IP) preferred,
//    PROXY (rotating IP) as fallback — the two egresses fail independently, so a
//    403/429 on one recovers on the other; the mint never rides the search throttle
//  - a mint failure invalidates stale state and retries ONCE through the approved
//    flow; if every transport is blocked the address is PENDING_AUTH (never no_service)
//  - a Search 401/403 invalidates the token, re-mints, and immediately retries the
//    SAME address once; still blocked → PENDING_AUTH (never no_service)
const { directFetch, proxyFetch } = vi.hoisted(() => ({ directFetch: vi.fn(), proxyFetch: vi.fn() }));
vi.mock("../../server/proxy-fetch", () => ({
  proxyFetch,
  directFetch,
  getProxyStatus: () => ({ enabled: true, url: "http://redacted@proxy", slots: 100 }),
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

describe("Live Test authentication flow", () => {
  beforeAll(async () => {
    process.env.KFS_AUTOMATION_AUTHORIZED = "false";
    process.env.KFS_TOKEN_POOL_WARM_MIN = "1";
    scanner = await import("../../server/scanner");
    process.env.KFS_AUTOMATION_AUTHORIZED = "true";
  });

  beforeEach(() => {
    directFetch.mockReset();
    proxyFetch.mockReset();
  });

  it("mints DIRECT first — the mint never rides the proxy when direct works", async () => {
    directFetch.mockImplementation(async (url: string) => isTokenUrl(url) ? freshToken() : json(200, FIX));
    proxyFetch.mockImplementation(async (url: string) => isSearchUrl(url) ? json(200, FIX) : freshToken());
    const out = await scanner.liveTestAddress(...ADDR);
    expect(out.checked).toBe(true);
    // The mint was served by directFetch; no proxied call hit the token endpoint.
    expect(directFetch.mock.calls.some(([u]) => isTokenUrl(String(u)))).toBe(true);
    expect(proxyFetch.mock.calls.some(([u]) => isTokenUrl(String(u)))).toBe(false);
    // Search rides the proxy.
    expect(proxyFetch.mock.calls.some(([u]) => isSearchUrl(String(u)))).toBe(true);
    expect(out.pendingAuth).toBe(false);
  });

  it("direct mint blocked (403/Cloudflare) → PROXY fallback recovers → address IS checked", async () => {
    directFetch.mockImplementation(async () => json(403, {})); // server IP challenged
    proxyFetch.mockImplementation(async (url: string) => isTokenUrl(url) ? freshToken() : json(200, FIX));
    const out = await scanner.liveTestAddress(...ADDR);
    expect(out.checked).toBe(true);
    expect(out.classification).toBe("fresh_fiber");
    // Fallback exercised: proxy served the mint.
    expect(proxyFetch.mock.calls.some(([u]) => isTokenUrl(String(u)))).toBe(true);
  });

  it("EVERY mint transport blocked → PENDING_AUTH, never no_service, no search fired", async () => {
    directFetch.mockImplementation(async () => json(403, {}));
    proxyFetch.mockImplementation(async (url: string) => {
      if (isSearchUrl(url)) throw new Error("search must not run without a token");
      return json(403, {}); // proxy token endpoint also blocked
    });
    const out = await scanner.liveTestAddress(...ADDR);
    expect(out.checked).toBe(false);
    expect(out.pendingAuth).toBe(true);
    expect(out.classification).toBe("pending_auth");
    expect(out.classification).not.toBe("no_service");
    // Retried the mint through the approved flow (>= 2 mint rounds), no search fired.
    expect(directFetch.mock.calls.filter(([u]) => isTokenUrl(String(u))).length).toBeGreaterThanOrEqual(2);
    expect(proxyFetch.mock.calls.filter(([u]) => isSearchUrl(String(u))).length).toBe(0);
  });

  it("mint blocked once then recovers on the single retry → address IS checked", async () => {
    let round = 0;
    directFetch.mockImplementation(async (url: string) => {
      if (!isTokenUrl(url)) return json(200, FIX);
      round++;
      return round === 1 ? json(403, {}) : freshToken();
    });
    // Proxy fallback also blocked on the first round so the FIRST mint truly fails
    // and the single retry is what recovers it.
    proxyFetch.mockImplementation(async (url: string) => isSearchUrl(url) ? json(200, FIX) : json(403, {}));
    const out = await scanner.liveTestAddress(...ADDR);
    expect(out.checked).toBe(true);
    expect(out.pendingAuth).toBe(false);
    expect(out.classification).toBe("fresh_fiber");
  });

  it("Search 403 → token invalidated, re-mint, SAME address retried once and checked", async () => {
    directFetch.mockImplementation(async (url: string) => isTokenUrl(url) ? freshToken() : json(200, FIX));
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
  });

  it("Search 403 persists after re-mint → PENDING_AUTH, never no_service", async () => {
    directFetch.mockImplementation(async (url: string) => isTokenUrl(url) ? freshToken() : json(403, {}));
    proxyFetch.mockImplementation(async (url: string) => isTokenUrl(url) ? freshToken() : json(403, {}));
    const out = await scanner.liveTestAddress(...ADDR);
    expect(out.checked).toBe(false);
    expect(out.pendingAuth).toBe(true);
    expect(out.classification).toBe("pending_auth");
    // Exactly two search attempts (original + one post-remint retry).
    expect(proxyFetch.mock.calls.filter(([u]) => isSearchUrl(String(u))).length).toBe(2);
  });
});
