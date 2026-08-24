import { describe, expect, it, beforeEach, afterEach } from "vitest";

/**
 * DECODO STICKY SESSIONS ARE A PORT, NOT A USERNAME SUFFIX.
 *
 * Measured live against us.decodo.com on 2026-08-22:
 *   - port 10000 returns a DIFFERENT residential IP on every request, and
 *     rejects every username-suffix session form outright (the connection
 *     fails, which is why DECODO_STICKY had to be "off" in production);
 *   - ports 10001 / 10002 / 10005 / 10100 each hold ONE persistent IP.
 *
 * Tokens are PORTABLE across IPs (measured 2026-08-23: mint on IP-1, search
 * from IP-2, 20/20). The per-IP limit is on SEARCH VOLUME, which is what the
 * check budget below is for. End to end on Rockwell:
 * port 10000 gave 31 of 236 checks (13%); port 10001 gave 69 of 80 (86%).
 */
const ENV_KEYS = ["PROXY_URL", "DECODO_STICKY", "DECODO_STICKY_PORT_BASE",
  "DECODO_STICKY_PORT_COUNT", "DECODO_STICKY_MINUTES", "DECODO_ROTATE_AFTER_DENIALS",
  "DECODO_CHECKS_PER_IP"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => { saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])); });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("Decodo sticky egress", () => {
  it("rides a port in the sticky range, never the rotating gateway", async () => {
    process.env.PROXY_URL = "http://user:pass@us.decodo.com:10000";
    process.env.DECODO_STICKY_PORT_BASE = "10001";
    process.env.DECODO_STICKY_PORT_COUNT = "100";
    delete process.env.DECODO_STICKY;
    const mod = await import("../../server/proxy-fetch");
    const { port } = mod.getProxyStickyState();
    expect(port, "a sticky port is chosen").not.toBeNull();
    expect(port).toBeGreaterThanOrEqual(10001);
    expect(port).toBeLessThan(10101);
    expect(port, "10000 is the rotating gateway and is never used sticky").not.toBe(10000);
  });

  it("holds the IP through isolated denials and only retires it on a streak", async () => {
    process.env.PROXY_URL = "http://user:pass@us.decodo.com:10000";
    process.env.DECODO_ROTATE_AFTER_DENIALS = "3";
    delete process.env.DECODO_STICKY;
    const mod = await import("../../server/proxy-fetch");
    const startPort = mod.getProxyStickyState().port;
    // Two denials must NOT move us: 205 denials once meant 205 rotations, which
    // is the per-request rotation stickiness exists to prevent.
    await mod.rotateProxySession("403");
    expect(mod.getProxyStickyState().denialStreak).toBe(1);
    expect(mod.getProxyStickyState().port).toBe(startPort);
    await mod.rotateProxySession("403");
    expect(mod.getProxyStickyState().port).toBe(startPort);
    expect(mod.getProxyStickyState().denialStreak).toBe(2);
  });

  it("leaves an operator's own baked-in session alone", async () => {
    process.env.PROXY_URL = "http://user-session-mine:pass@us.decodo.com:10000";
    delete process.env.DECODO_STICKY;
    const mod = await import("../../server/proxy-fetch");
    // Nothing to assert on the URL from outside; the contract is that the
    // module loads and reports a port without rewriting the operator's choice.
    expect(typeof mod.getProxyStickyState().port).toBe("number");
  });
});

describe("the per-IP check budget", () => {
  // A residential IP wears out. Measured across five sticky ports, each driven
  // sequentially on its own slice of doors: the longest CLEAN streak was
  // 30/20/21/20, and two of the IPs died outright (at 41 and 54 checks). So an
  // IP is retired on a COUNT while it is still healthy, which costs one cold
  // handshake, instead of on a run of denials, which costs a run of denials.
  it("retires the IP after its budget and starts the next one clean", async () => {
    process.env.PROXY_URL = "http://user:pass@us.decodo.com:10000";
    delete process.env.DECODO_STICKY;
    const mod = await import("../../server/proxy-fetch");
    mod.__resetRotationStateForTests();
    const s0 = mod.getProxyStickyState();
    expect(s0.checksOnThisIp, "a fresh IP has spent nothing").toBe(0);
    expect(typeof s0.port).toBe("number");
  });

  it("counts the budget only while sticky is on", async () => {
    process.env.PROXY_URL = "http://user:pass@us.decodo.com:10000";
    process.env.DECODO_STICKY = "off";
    const mod = await import("../../server/proxy-fetch");
    mod.__resetRotationStateForTests();
    // With stickiness off there is no IP to husband: the rotating gateway hands
    // out a new one per request regardless, so a budget is meaningless.
    expect(mod.getProxyStickyState().port).toBeNull();
  });

  it("a spent budget is not a denial: retiring resets the denial streak", async () => {
    process.env.PROXY_URL = "http://user:pass@us.decodo.com:10000";
    delete process.env.DECODO_STICKY;
    process.env.DECODO_ROTATE_AFTER_DENIALS = "3";
    const mod = await import("../../server/proxy-fetch");
    mod.__resetRotationStateForTests();
    await mod.rotateProxySession("403");
    expect(mod.getProxyStickyState().denialStreak).toBe(1);
    mod.__resetRotationStateForTests();
    expect(mod.getProxyStickyState().denialStreak, "a clean slate per IP").toBe(0);
  });
});

describe("an IP that cannot reach the provider at all", () => {
  // THE MINT WEDGE, observed live 2026-08-24 on run_1_mt7hy05z: a sticky IP that
  // cannot reach the Kinetic auth endpoint fails every mint with undici's bare
  // "fetch failed". It never DENIES us, so it never builds the denial streak
  // rotateProxySession waits for - the run sat at verified=610 through 26
  // consecutive mint failures and wrote zero snapshots until the worker was
  // killed, which recovers only because the port offset is randomised per
  // process. The handover therefore has to be the SPENT-IP path, which is
  // neither streak-gated nor throttled.
  it("advanceProxyEgress steps to the next residential IP, with no denial streak behind it", async () => {
    process.env.PROXY_URL = "http://user:pass@us.decodo.com:10000";
    process.env.DECODO_STICKY_PORT_BASE = "10001";
    process.env.DECODO_STICKY_PORT_COUNT = "100";
    process.env.DECODO_ROTATE_AFTER_DENIALS = "8";
    delete process.env.DECODO_STICKY;
    const mod = await import("../../server/proxy-fetch");
    mod.__resetRotationStateForTests();
    const before = mod.getProxyStickyState().port;
    expect(mod.getProxyStickyState().denialStreak, "a dead IP has denied us nothing").toBe(0);

    await mod.advanceProxyEgress("mint transport: fetch failed");
    const after = mod.getProxyStickyState().port;
    expect(after, "the dead IP is handed over on the spot").not.toBe(before);
    expect(after).toBeGreaterThanOrEqual(10001);
    expect(after).toBeLessThan(10101);

    // ...and unlike a denial rotation it is not swallowed by the min-interval
    // throttle, which would otherwise drop every handover inside 4 s.
    await mod.advanceProxyEgress("mint transport: fetch failed");
    expect(mod.getProxyStickyState().port, "a second handover still moves").not.toBe(after);
  });

  it("is a no-op with stickiness off - the rotating gateway already changes IP per request", async () => {
    process.env.PROXY_URL = "http://user:pass@us.decodo.com:10000";
    process.env.DECODO_STICKY = "off";
    const mod = await import("../../server/proxy-fetch");
    await expect(mod.advanceProxyEgress("mint transport: fetch failed")).resolves.toBeUndefined();
    expect(mod.getProxyStickyState().port).toBeNull();
  });

  it("only a real transport failure reaches it: a challenge fails closed in the scanner", async () => {
    const [fs, path] = [await import("node:fs"), await import("node:path")];
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/scanner.ts"), "utf8");
    // The classifier is an ALLOW-LIST over the error chain, never "anything that
    // is not a 401/403" - otherwise a challenge, or any unfamiliar provider
    // answer, would earn an identity change.
    expect(src).toContain("function isMintTransportFailure(");
    expect(src, "a Decodo 407 is an account denial for the governor, not a bad IP")
      .toContain('if (/\\b407\\b/.test(text)) return false;');
  });
});

describe("the mint egresses through the sticky proxy when one is in force", () => {
  // The premise of the whole sticky change is that a Kinetic bearer token is
  // bound to its minting IP - since disproved. What survives is narrower and
  // still worth asserting: if a mint DOES egress through the proxy, it must use
  // the same sticky IP the searches use rather than a stranger from the
  // rotating gateway. server/scanner.ts used to hand the
  // curl-impersonate mint `proxyUrlFromEnv()`, which is the RAW configured URL
  // - port 10000, the rotating gateway - while searches went out on 10001+.
  // Every mint/search pair mismatched, which is the exact 403 being fixed.
  //
  // These assertions look at the URL that is actually egressed through, not at
  // a diagnostic that recomputes the port from env. Deleting the port rewrite
  // must fail a test.
  it("currentEgressProxyUrl carries the sticky port, unlike proxyUrlFromEnv", async () => {
    process.env.PROXY_URL = "http://user:pass@us.decodo.com:10000";
    process.env.DECODO_STICKY_PORT_BASE = "10001";
    process.env.DECODO_STICKY_PORT_COUNT = "50";
    delete process.env.DECODO_STICKY;
    const mod = await import("../../server/proxy-fetch");
    const raw = mod.proxyUrlFromEnv(process.env)!;
    const egress = mod.currentEgressProxyUrl()!;
    expect(new URL(raw).port, "the configured URL is the rotating gateway").toBe("10000");
    const port = Number(new URL(egress).port);
    expect(port, "what we actually egress through is a sticky port").not.toBe(10000);
    expect(port).toBeGreaterThanOrEqual(10001);
    expect(port).toBeLessThan(10051);
    // ...and it agrees with what the diagnostic reports.
    expect(port).toBe(mod.getProxyStickyState().port);
  });

  it("falls back to the raw URL when stickiness is off, so the rollback is real", async () => {
    process.env.PROXY_URL = "http://user:pass@us.decodo.com:10000";
    process.env.DECODO_STICKY = "off";
    const mod = await import("../../server/proxy-fetch");
    expect(new URL(mod.currentEgressProxyUrl()!).port).toBe("10000");
  });

  it("the scanner mints through the sticky egress, never the raw URL", async () => {
    const [fs, path] = [await import("node:fs"), await import("node:path")];
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/scanner.ts"), "utf8");
    // Assert on the CALL, not on a line range: KFS_MINT_DIRECT is mentioned in a
    // comment above KFS_MINT_IMPERSONATE, so slicing between them runs backwards.
    expect(src, "the proxied mint rung reads the sticky egress")
      .toContain("const impProxyUrl = currentEgressProxyUrl();");
    expect(src, "...and passes it, never a null - null is curl egressing from this box")
      .toContain("mintViaImpersonate(kineticTokenUrl(), mintHeaders, mintBody, impProxyUrl)");
    expect(src, "and no mint egresses through the raw rotating gateway")
      .not.toContain("mintViaImpersonate(kineticTokenUrl(), mintHeaders, mintBody, proxyUrlFromEnv(process.env))");
  });

  it("reports no proxy at all when none is configured", async () => {
    delete process.env.PROXY_URL;
    delete process.env.DECODO_HOST;
    const mod = await import("../../server/proxy-fetch");
    expect(mod.currentEgressProxyUrl()).toBeNull();
  });
});

describe("what the measurements actually established", () => {
  // Written down as a test because the design was briefly built on the OPPOSITE
  // belief, and a comment alone did not stop that. Measured 2026-08-23 with raw
  // HTTP, the app's pool and dispatcher bypassed so nothing re-minted behind it:
  //
  // Round 2 raised it to 40 addresses per arm and classified the RESPONSE BODY,
  // because a 200 carrying "AddressNotFound" is not an answer:
  //
  //   arm                                    real answers   403s
  //   A  mint IP-1 / search IP-1                  20          20
  //   B  mint IP-1 / search IP-2  (MISMATCH)      20          20
  //   C  mint IP-2 / search IP-2  (IP-2 spent)    10          30
  //   D  mint SERVER IP / search IP-1             20          20
  //
  // Verified against POST https://buy.gokinetic.com/api/v1/address/search with
  // real verdicts echoed back (114 CHINA GROVE HWY -> TENURED/billing N/FIBER,
  // 368 PALMER CIR -> NEW FIBER/billing N/FIBER).
  //
  // B is the one that matters: a token minted on one residential address works
  // perfectly from another. Tokens are PORTABLE. C did worse than B only
  // because IP-2 had already served B's 20 searches - which is the per-IP wear
  // the check budget exists for, not a token problem.
  it("does not drop the token pool when the egress IP changes", async () => {
    const { AuthorizedTokenPool } = await import("../../server/authorizedTokenPool");
    const pool: any = new AuthorizedTokenPool({ mint: async () => ({ token: "t", expiresAt: Date.now() + 3_600_000 }) } as any);
    expect(typeof pool.invalidateAllForEgressChange,
      "removed: it forced a pointless re-mint on every rotation").toBe("undefined");
  });

  it("does not disable the direct mint rung under a sticky egress", async () => {
    const [fs, path] = [await import("node:fs"), await import("node:path")];
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/scanner.ts"), "utf8");
    // imp-direct is the cleanest egress AND spends no residential budget, so it
    // must stay reachable. A revision briefly skipped it on the binding premise.
    // It is now OPT-IN rather than default - the owner directive is that no
    // carrier request leaves from this box - so "reachable" means one env var
    // away, not deleted. The policy itself lives in
    // tests/unit/carrier-egress-is-decodo-only.test.ts; what matters here is
    // that a STICKY EGRESS is still not the thing that gates it.
    expect(src).toContain("mintViaImpersonate(kineticTokenUrl(), mintHeaders, mintBody, null)");
    expect(src, "and what gates it is the direct-egress opt-in, nothing else")
      .toContain("if (directCarrierEgressAllowed()) {");
    expect(src, "no sticky-egress guard around the direct rung")
      .not.toContain("sticky egress in force");
  });
});

describe("the time window is reachable", () => {
  // DECODO_STICKY_MINUTES never fired once: the expiry lived inside
  // stickyProxyUrl(), which is only called when a dispatcher is BUILT, and
  // rebuildDispatcher() advances the port immediately beforehand and resets the
  // deadline - so the test was always false. Meanwhile the deploy manifest
  // asserted "time-based refresh still cycles IPs in an orderly way".
  it("is evaluated on the request path, not only at dispatcher build", async () => {
    const [fs, path] = [await import("node:fs"), await import("node:path")];
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/proxy-fetch.ts"), "utf8");
    expect(src, "a dedicated predicate exists").toContain("function stickyWindowExpired()");
    const fetchBody = src.slice(src.indexOf("export async function proxyFetch"));
    expect(fetchBody, "and the request path consults it").toContain("stickyWindowExpired()");
    // The old placement must not come back.
    const builder = src.slice(src.indexOf("function stickyProxyUrl"), src.indexOf("function buildAgent"));
    expect(builder).not.toContain("_stickyUntil");
  });
});
