import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KINETIC_345_JAMES_ALLGOOD as FIX } from "../fixtures/kinetic345JamesAllgood";

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

  it("on 401 invalidates the token and returns a blocked result (one attempt) for the worker to requeue", async () => {
    let searches = 0;
    proxyFetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.includes("/_internal/precisely/token")) return json(200, { access_token: "fresh", expires_in: 2_100 });
      expect(url).toBe("https://buy.gokinetic.com/api/v1/address/search");
      searches++;
      expect(new Headers(init.headers).get("authorization")).toMatch(/^Bearer /);
      return json(401, {});
    });
    // ONE attempt — no in-loop retry-count. A 401 is a token/session error → the
    // token is invalidated and the address returned blocked so the worker requeues
    // it (and re-mints). Never a no-fiber.
    const result = await scanner.scanAddress("401 Retry Road", "Lexington", "NC", "27292", { source: "manual" });
    expect(result).toMatchObject({ apiSource: "failed", blocked: true, fiberStatus: "unknown" });
    expect(searches).toBe(1);
  });

  it("on 429 returns a blocked result (one attempt) for the worker to requeue — no in-loop wait", async () => {
    let searches = 0;
    proxyFetch.mockImplementation(async (url: string) => {
      if (url.includes("/_internal/precisely/token")) return json(200, { access_token: "fresh", expires_in: 2_100 });
      searches++;
      return json(429, {}, { "retry-after": "0" });
    });
    const result = await scanner.scanAddress("429 Resume Lane", "Lexington", "NC", "27292", { source: "lasso" });
    expect(result).toMatchObject({ apiSource: "failed", blocked: true, fiberStatus: "unknown" });
    expect(searches).toBe(1);
  });

  it("treats a 403 as a transient block (no halt): invalidates token, re-mints, keeps scanning, never a no-fiber", async () => {
    // Mint succeeds; the search always 403s. A 403 invalidates the leased token,
    // so the next address re-mints a fresh one and tries again — never wedged.
    proxyFetch.mockImplementation(async (url: string) => {
      if (url.includes("/_internal/precisely/token")) return json(200, { access_token: "fresh", expires_in: 2_100 });
      return json(403, {});
    });
    const first = await scanner.scanAddress("403 Stop Court", "Lexington", "NC", "27292", { source: "manual" });
    expect(first).toMatchObject({ apiSource: "failed", blocked: true, fiberStatus: "unknown" });
    // Not wedged: the next address re-mints + calls the provider again (no operator
    // reset needed) and also comes back blocked, not no-fiber.
    const before = proxyFetch.mock.calls.length;
    const second = await scanner.scanAddress("404 Queued Court", "Lexington", "NC", "27292", { source: "city" });
    expect(second).toMatchObject({ apiSource: "failed", blocked: true, fiberStatus: "unknown" });
    expect(proxyFetch.mock.calls.length).toBeGreaterThan(before);
    expect(scanner.getAddressScanQueueStatus()).not.toHaveProperty("halted");
  });

  it("345 James Allgood Dr flows through the SHARED scanAddress path as fresh fiber (copper override ignored)", async () => {
    proxyFetch.mockImplementation(async (url: string) => {
      if (url.includes("/_internal/precisely/token")) return json(200, { access_token: "fresh", expires_in: 2_100 });
      return json(200, FIX);
    });
    // scanAddress is the ONE path Manual Check + Field Map + city + recheck share,
    // so an identical classification here means all surfaces classify identically.
    const r = await scanner.scanAddress("345 James Allgood Dr", "Inman", "SC", "29349", { source: "manual" });
    expect(r).toMatchObject({
      apiSource: "kinetic_live",
      fiberStatus: "new_fiber",
      isNewFiber: true,
      fiberAvailable: true, // the COPPER "remove fiber area" override did NOT sink it
      techType: "FIBER",
      householdSegmentType: "NEW FIBER",
      billingStatus: "N",
      chipSetType: "FTTP",
      serviceKey: "SVC-345JA-FTTP",
      dfAddressId: "DF-345-JAMES-ALLGOOD",
      accessId: "ACC-345-JA-0001",
    });
    expect(r.maxDownloadMbps).toBe(2000);
    expect(r.lat).toBeCloseTo(35.020537, 5);
    expect(r.lng).toBeCloseTo(-82.078668, 5);
  });
});
