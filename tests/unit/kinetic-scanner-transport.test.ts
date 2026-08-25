import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KINETIC_345_JAMES_ALLGOOD as FIX } from "../fixtures/kinetic345JamesAllgood";

const { proxyFetch, rotateProxySession, advanceProxyEgress, setEgressGenerationHook, egressHook } = vi.hoisted(() => {
  // The scanner registers its egress-change callback at IMPORT. clearMocks wipes
  // the call record before every test, so the callback is kept here instead of
  // being read back off the spy.
  const egressHook: { current: ((reason: string) => void) | null } = { current: null };
  return {
    proxyFetch: vi.fn(),
    rotateProxySession: vi.fn(async () => {}),
    advanceProxyEgress: vi.fn(async () => {}),
    egressHook,
    setEgressGenerationHook: vi.fn((cb: (reason: string) => void) => { egressHook.current = cb; }),
  };
});
vi.mock("../../server/proxy-fetch", () => ({
  // Decodo-exclusive: mint AND search both funnel through proxyFetch (the Decodo
  // transport), observable through one call log. rotateProxySession is the
  // fresh-session hook the scanner calls on an auth denial.
  proxyFetch,
  rotateProxySession,
  // The handover a caller asks for when the residential IP cannot reach the
  // provider at all — the spent-IP path, not the denial path.
  advanceProxyEgress,
  // Direct carrier egress is OFF, exactly as an unconfigured deployment has it
  // (server/proxy-fetch.ts). directCarrierFetch throws here for the same reason
  // it throws in production: a test that reaches it is leaking, and should say so.
  // Captured, so a test can fire the egress change the scanner registered for.
  setEgressGenerationHook,
  directCarrierEgressAllowed: () => false,
  directCarrierFetch: async () => { throw new Error("direct carrier egress is off"); },
  // One lane, so the scanner's lane round-robin is a no-op in these suites.
  egressLaneCount: () => 1,
  getProxySessionId: () => "decodo-s1",
  isProxyConnected: () => true,
  proxyUrlFromEnv: () => "http://redacted@proxy",
  getProxyStatus: () => ({ enabled: true, url: "http://redacted@proxy", slots: 100, sessionId: "decodo-s1" }),
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
    process.env.KFS_MINT_MIN_INTERVAL_MS = "0"; // no inter-mint spacing in tests
    // This suite owns a mocked Decodo transport. Keep unrelated direct and
    // curl-impersonate fallback ladders out of the test so a missing local
    // binary cannot consume the five-second case budget before the mock runs.
    process.env.KFS_MINT_IMPERSONATE = "off";
    process.env.KFS_MINT_DIRECT = "off";
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
      if (url.includes("/api/v1/auth/session")) return json(200, { access_token: "fresh", expires_in: 2_100 });
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

  it("on 429 returns a blocked result (one attempt) for the worker to requeue - no in-loop wait", async () => {
    let searches = 0;
    proxyFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/v1/auth/session")) return json(200, { access_token: "fresh", expires_in: 2_100 });
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
    rotateProxySession.mockClear();
    proxyFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/v1/auth/session")) return json(200, { access_token: "fresh", expires_in: 2_100 });
      return json(403, {});
    });
    const first = await scanner.scanAddress("403 Stop Court", "Lexington", "NC", "27292", { source: "manual" });
    expect(first).toMatchObject({ apiSource: "failed", blocked: true, fiberStatus: "unknown" });
    // Owner directive — when the bot wall hits, SWITCH THE DECODO IP: a search
    // 403 rotates the Decodo session (fresh residential IP) so the requeued
    // retry leaves the walled IP behind.
    expect(rotateProxySession).toHaveBeenCalled();
    // Not wedged: the next address re-mints + calls the provider again (no operator
    // reset needed) and also comes back blocked, not no-fiber.
    const before = proxyFetch.mock.calls.length;
    const second = await scanner.scanAddress("404 Queued Court", "Lexington", "NC", "27292", { source: "city" });
    expect(second).toMatchObject({ apiSource: "failed", blocked: true, fiberStatus: "unknown" });
    expect(proxyFetch.mock.calls.length).toBeGreaterThan(before);
    expect(scanner.getAddressScanQueueStatus()).not.toHaveProperty("halted");
  });

  it("mint bot-wall: switches the Decodo IP on 403 and retries, succeeding on a fresh residential session", async () => {
    // Owner directive — when the token-mint bot wall hits, rotate to a fresh
    // Decodo IP and retry (bounded by KFS_MINT_MAX_ROTATIONS) instead of giving
    // up after one try. Skip the impersonate + direct rungs so the mint funnels
    // through the Decodo rung this test observes.
    const prevImp = process.env.KFS_MINT_IMPERSONATE;
    const prevDirect = process.env.KFS_MINT_DIRECT;
    const prevRot = process.env.KFS_MINT_MAX_ROTATIONS;
    process.env.KFS_MINT_IMPERSONATE = "off";
    process.env.KFS_MINT_DIRECT = "off";
    process.env.KFS_MINT_MAX_ROTATIONS = "3";
    scanner.__resetTokenTransportStateForTests();
    rotateProxySession.mockClear();
    let mints = 0;
    proxyFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/v1/auth/session")) {
        mints++;
        // The wall blocks the first two residential IPs; a fresh IP clears it.
        return mints < 3 ? json(403, {}) : json(200, { access_token: "fresh-on-ip-3", expires_in: 2_100 });
      }
      return json(200, noService);
    });
    try {
      const token = await scanner.forceFreshTokenFromApi();
      expect(token).toBe("fresh-on-ip-3");
      expect(mints).toBe(3);                                  // walled twice, minted on the 3rd IP
      expect(rotateProxySession).toHaveBeenCalledTimes(2);    // one IP switch before each retry
    } finally {
      process.env.KFS_MINT_IMPERSONATE = prevImp;
      process.env.KFS_MINT_DIRECT = prevDirect;
      process.env.KFS_MINT_MAX_ROTATIONS = prevRot;
      scanner.__resetTokenTransportStateForTests();
    }
  });

  // ── THE MINT WEDGE (observed live 2026-08-24 on run_1_mt7hy05z) ───────────
  // A residential IP that cannot REACH the Kinetic auth endpoint fails the mint
  // with undici's bare "fetch failed" - no 401, no 403 anywhere in it. The
  // rotation above was gated on isAuthDenialMessage, so the scanner retried the
  // same dead IP every ~3 s forever: 26 consecutive mint failures, the run stuck
  // at verified=610, zero snapshots written. Killing the worker recovered it,
  // because the sticky port offset is randomised per process - which is the
  // proof that the IP, not Kinetic, was the problem.
  function transportFailure(): Error {
    // Shaped exactly like undici's: a bare message with the real reason buried
    // one `cause` level down, which is why classification reads the chain.
    return Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 32.223.187.36:443"), { code: "ECONNREFUSED" }),
    });
  }

  async function withMintEnv<T>(overrides: Record<string, string>, run: () => Promise<T>): Promise<T> {
    const keys = ["KFS_MINT_IMPERSONATE", "KFS_MINT_DIRECT", "KFS_MINT_MAX_ROTATIONS",
      "KFS_MINT_TRANSPORT_ROTATE_AFTER", ...Object.keys(overrides)];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    // Skip the impersonate + direct rungs so the mint funnels through the Decodo
    // rung these cases observe.
    Object.assign(process.env, { KFS_MINT_IMPERSONATE: "off", KFS_MINT_DIRECT: "off" }, overrides);
    scanner.__resetTokenTransportStateForTests();
    advanceProxyEgress.mockClear();
    rotateProxySession.mockClear();
    try { return await run(); }
    finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      scanner.__resetTokenTransportStateForTests();
    }
  }

  it("mint transport failure: a STREAK hands the residential IP over, through the UNTHROTTLED path", async () => {
    await withMintEnv({ KFS_MINT_MAX_ROTATIONS: "5" }, async () => {
      let mints = 0;
      proxyFetch.mockImplementation(async (url: string) => {
        if (url.includes("/api/v1/auth/session")) {
          mints++;
          // MintTransportError is raised structurally where proxyFetch throws,
          // so the classification never has to read an error string.
          if (mints <= 3) throw transportFailure();
          return json(200, { access_token: "minted-on-the-next-ip", expires_in: 2_100 });
        }
        return json(200, noService);
      });

      // One failure is not evidence: the call fails closed and the streak
      // carries to the next mint rather than moving the IP.
      for (let i = 0; i < 2; i++) {
        scanner.setManualToken("test-server-token-with-a-safe-fallback-expiry");
        await expect(scanner.forceFreshTokenFromApi()).rejects.toThrow(/transport/i);
      }
      expect(advanceProxyEgress, "two failures have not earned a handover").not.toHaveBeenCalled();

      // The third completes the streak: hand the IP over and retry in place.
      scanner.setManualToken("test-server-token-with-a-safe-fallback-expiry");
      await expect(scanner.forceFreshTokenFromApi()).resolves.toBe("minted-on-the-next-ip");

      // THE POINT OF THIS TEST: the handover goes through advanceProxyEgress.
      // rotateProxySession holds the IP until DECODO_ROTATE_AFTER_DENIALS
      // consecutive DENIALS (8 in production) and is throttled on top, so on a
      // dead egress - which produces no denials at all - it returns early and
      // advances nothing. The spent-IP path is neither streak-gated nor
      // throttled, which is what actually breaks the livelock.
      expect(advanceProxyEgress).toHaveBeenCalledTimes(1);
      expect(String(advanceProxyEgress.mock.calls[0][0])).toContain("mint transport");
      expect(rotateProxySession, "a transport failure is not a denial").not.toHaveBeenCalled();
    });
  });

  it("mint challenge: a non-JSON interstitial NEVER earns an IP change, however often it repeats", async () => {
    await withMintEnv({ KFS_MINT_MAX_ROTATIONS: "3", KFS_MINT_ROTATE_AFTER_TRANSPORT_FAILURES: "2" }, async () => {
      let mints = 0;
      proxyFetch.mockImplementation(async (url: string) => {
        if (url.includes("/api/v1/auth/session")) {
          mints++;
          // A bot-challenge interstitial: the provider ANSWERED, just not with JSON.
          return new Response("<html>Attention Required</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        return json(200, noService);
      });

      // Three in a row - past the transport threshold, had it counted them.
      for (let i = 0; i < 3; i++) {
        scanner.setManualToken("test-server-token-with-a-safe-fallback-expiry");
        await expect(scanner.forceFreshTokenFromApi()).rejects.toThrow(/challenge/);
      }
      expect(mints, "one attempt each: a challenge is never retried").toBe(3);
      expect(advanceProxyEgress, "the scanner never changes identity to get around a challenge").not.toHaveBeenCalled();
      expect(rotateProxySession).not.toHaveBeenCalled();
    });
  });

  it("the transport handover has an off switch, and it is read from one place", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/scanner.ts"), "utf8");
    expect(src).toContain("KFS_MINT_TRANSPORT_ROTATE_AFTER");
    // 0 disables it, restoring the pre-2026-08-24 fail-closed behaviour.
    expect(src).toContain("MINT_TRANSPORT_ROTATE_AFTER > 0");
    // ...and the handover itself must not go through the denial path.
    expect(src, "the spent-IP path, not the streak-gated denial path")
      .toContain('await advanceProxyEgress("mint transport');
  });

  it("an egress change ends the token generation: the next check mints a fresh pair", async () => {
    // ONE IP, ONE TOKEN, TWENTY CHECKS. The scanner registers for the egress
    // change at import; firing that callback is exactly what proxy-fetch does
    // when the sticky port advances.
    expect(typeof egressHook.current, "the scanner registers for egress changes").toBe("function");
    const onEgressChange = egressHook.current!;

    let mints = 0;
    proxyFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/v1/auth/session")) {
        mints++;
        return json(200, { access_token: `minted-${mints}`, expires_in: 2_100 });
      }
      return json(200, noService);
    });

    // A healthy token is REUSED - the pool does not re-mint per check.
    scanner.setManualToken("token-from-the-current-pair");
    await expect(scanner.refreshTokenFromApi()).resolves.toBe("token-from-the-current-pair");
    await expect(scanner.refreshTokenFromApi()).resolves.toBe("token-from-the-current-pair");
    expect(mints, "reuse, not a mint per check").toBe(0);

    // ...until the IP underneath it changes. That token is now half of a pair
    // that no longer exists, so the next check mints against the fresh IP.
    onEgressChange("egress -> port 10042");
    await expect(scanner.refreshTokenFromApi()).resolves.toBe("minted-1");
    expect(mints).toBe(1);
  });

  it("345 James Allgood Dr flows through the SHARED scanAddress path as fresh fiber (copper override ignored)", async () => {
    proxyFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/v1/auth/session")) return json(200, { access_token: "fresh", expires_in: 2_100 });
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
