import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KINETIC_345_JAMES_ALLGOOD as FIX } from "../fixtures/kinetic345JamesAllgood";

// Live Test auth contract:
//  - the token mint egresses DIRECT (directFetch), never through the proxy
//  - a mint failure invalidates stale state and retries ONCE through the approved
//    flow; if that also fails the address is PENDING_AUTH (never no_service)
//  - a Search 401/403 invalidates the token, re-mints, and immediately retries the
//    SAME address once; still blocked → PENDING_AUTH (never no_service)
const { proxyFetch, directFetch } = vi.hoisted(() => ({ proxyFetch: vi.fn(), directFetch: vi.fn() }));
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

const ADDR = ["4023 Dakeita Circle", "Concord", "NC", "28025"] as const;

describe("Live Test authentication flow", () => {
  beforeAll(async () => {
    process.env.KFS_AUTOMATION_AUTHORIZED = "false";
    process.env.KFS_TOKEN_POOL_WARM_MIN = "1";
    scanner = await import("../../server/scanner");
    process.env.KFS_AUTOMATION_AUTHORIZED = "true";
  });

  beforeEach(() => {
    proxyFetch.mockReset();
    directFetch.mockReset();
  });

  it("mints the token DIRECT — the mint request never rides the proxy", async () => {
    directFetch.mockImplementation(async () => json(201, { token: "t".repeat(40), success: true }));
    proxyFetch.mockImplementation(async () => json(200, FIX));
    const out = await scanner.liveTestAddress(...ADDR);
    expect(out.checked).toBe(true);
    expect(directFetch.mock.calls.length).toBeGreaterThan(0);
    // Every proxied call is the Search API; no proxied call is the token endpoint.
    for (const [url] of proxyFetch.mock.calls) expect(String(url)).toContain("/address/search");
    expect(out.classification).toBe("fresh_fiber");
    expect(out.pendingAuth).toBe(false);
  });

  it("mint 403 twice → PENDING_AUTH, never no_service, address left un-checked", async () => {
    directFetch.mockImplementation(async () => json(403, {}));
    proxyFetch.mockImplementation(async () => { throw new Error("search must not run without a token"); });
    const out = await scanner.liveTestAddress(...ADDR);
    expect(out.checked).toBe(false);
    expect(out.pendingAuth).toBe(true);
    expect(out.classification).toBe("pending_auth");
    expect(out.classification).not.toBe("no_service");
    // Retried the mint through the approved flow (>= 2 mint attempts), no search fired.
    expect(directFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    const searchCalls = proxyFetch.mock.calls.filter(([u]) => String(u).includes("/address/search"));
    expect(searchCalls.length).toBe(0);
  });

  it("mint fails once then succeeds on the single retry → address IS checked", async () => {
    let mints = 0;
    directFetch.mockImplementation(async () => {
      mints++;
      return mints === 1 ? json(403, {}) : json(201, { token: "t".repeat(40), success: true });
    });
    proxyFetch.mockImplementation(async () => json(200, FIX));
    const out = await scanner.liveTestAddress(...ADDR);
    expect(out.checked).toBe(true);
    expect(out.pendingAuth).toBe(false);
    expect(out.classification).toBe("fresh_fiber");
  });

  it("Search 403 → token invalidated, re-mint, SAME address retried once and checked", async () => {
    directFetch.mockImplementation(async () => json(201, { token: `t${Math.random()}`.padEnd(40, "x"), success: true }));
    let searches = 0;
    proxyFetch.mockImplementation(async (_url: string, init: RequestInit) => {
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
    directFetch.mockImplementation(async () => json(201, { token: `t${Math.random()}`.padEnd(40, "x"), success: true }));
    proxyFetch.mockImplementation(async () => json(403, {}));
    const out = await scanner.liveTestAddress(...ADDR);
    expect(out.checked).toBe(false);
    expect(out.pendingAuth).toBe(true);
    expect(out.classification).toBe("pending_auth");
    // Exactly two search attempts (original + one post-remint retry).
    const searchCalls = proxyFetch.mock.calls.filter(([u]) => String(u).includes("/address/search"));
    expect(searchCalls.length).toBe(2);
  });
});
