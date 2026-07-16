import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { proxyFetch } = vi.hoisted(() => ({ proxyFetch: vi.fn() }));
vi.mock("../../server/proxy-fetch", () => ({
  proxyFetch,
  getProxyStatus: () => ({ enabled: true, url: "http://redacted@proxy", slots: 100 }),
}));
vi.mock("../../server/distributedProviderCoordinator", () => {
  class DistributedProviderCoordinator<T> {
    private halted = false;
    async execute(_key: string, _source: string, task: () => Promise<T>): Promise<T> {
      if (this.halted) throw new Error("distributed halted");
      return task();
    }
    pauseFor() { return Date.now(); }
    halt() { this.halted = true; }
    resume() { this.halted = false; }
    snapshot() {
      return { active: 0, queued: 0, startsLastMinute: 0, maxConcurrency: 45, maxRequestsPerMinute: 100,
        pausedUntil: null, halted: this.halted, haltReason: this.halted ? "halted" : null, instanceId: "test" };
    }
  }
  return { DistributedProviderCoordinator, DistributedProviderHaltedError: Error };
});

let scanner: typeof import("../../server/scanner");

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const noService = {
  success: false,
  validationResult: "AddressNotFound",
  errorCode: 0,
  techType: "",
  maxQual: "",
  dfAddressId: "",
  accessId: "",
  exchangeId: "",
  exactMatch: false,
  fiberFastFlag: false,
};

describe("Kinetic scanner transport hardening", () => {
  beforeAll(async () => {
    process.env.KFS_AUTOMATION_AUTHORIZED = "false";
    process.env.KFS_TOKEN_POOL_WARM_MIN = "1";
    scanner = await import("../../server/scanner");
    process.env.KFS_AUTOMATION_AUTHORIZED = "true";
  });

  beforeEach(() => {
    proxyFetch.mockReset();
    scanner.setManualToken("test-server-token-with-a-safe-fallback-expiry");
  });

  it("normalizes equivalent address spellings to one coalescing key", () => {
    expect(scanner.normalizeKineticAddressKey("101 North Main Street", "Lexington", "nc", "27292-1234"))
      .toBe(scanner.normalizeKineticAddressKey("101 N. Main St", "LEXINGTON", "NC", "27292"));
  });

  it("refreshes the assigned token session up to three times on 401 and retries with Bearer auth", async () => {
    let searches = 0, refreshes = 0;
    proxyFetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes("/_internal/precisely/token")) {
        refreshes++;
        return json(200, { access_token: `refreshed-token-${refreshes}`, expires_in: 2_100 });
      }
      expect(url).toBe("https://buy.gokinetic.com/api/v1/address/search");
      searches++;
      expect(new Headers(init.headers).get("authorization")).toMatch(/^Bearer /);
      return searches <= 3 ? json(401, {}) : json(200, noService);
    });

    await expect(scanner.scanAddress("401 Retry Road", "Lexington", "NC", "27292", { source: "manual" }))
      .resolves.toMatchObject({ fiberStatus: "no_service", apiSource: "kinetic_live" });
    expect(searches).toBe(4);
    expect(refreshes).toBe(3);
  });

  it("honors Retry-After on 429 and keeps the same address work alive", async () => {
    let searches = 0;
    proxyFetch.mockImplementation(async (url: string) => {
      if (url.includes("/_internal/precisely/token")) return json(200, { access_token: "refreshed", expires_in: 2_100 });
      searches++;
      return searches === 1 ? json(429, {}, { "retry-after": "0" }) : json(200, noService);
    });
    await expect(scanner.scanAddress("429 Resume Lane", "Lexington", "NC", "27292", { source: "lasso" }))
      .resolves.toMatchObject({ fiberStatus: "no_service" });
    expect(searches).toBe(2);
  });

  it("treats a 403 as a transient block (no halt), keeps scanning, never a no-fiber", async () => {
    proxyFetch.mockResolvedValue(json(403, {}));
    // A 403 resolves to a blocked/failed result — NOT a throw, NOT a no-service.
    const first = await scanner.scanAddress("403 Stop Court", "Lexington", "NC", "27292", { source: "manual" });
    expect(first).toMatchObject({ apiSource: "failed", blocked: true, fiberStatus: "unknown" });
    // The scanner is not wedged: the next address actually calls the provider
    // again (no operator reset required) and also comes back blocked, not no-fiber.
    const before = proxyFetch.mock.calls.length;
    const second = await scanner.scanAddress("404 Queued Court", "Lexington", "NC", "27292", { source: "city" });
    expect(second).toMatchObject({ apiSource: "failed", blocked: true, fiberStatus: "unknown" });
    expect(proxyFetch.mock.calls.length).toBeGreaterThan(before);
    expect(scanner.getAddressScanQueueStatus()).not.toHaveProperty("halted");
  });
});
