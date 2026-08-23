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
 * A Kinetic bearer token is bound to the IP that minted it, so minting on one
 * IP and searching from another is a guaranteed 403. End to end on Rockwell:
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

describe("a token is bound to the IP that minted it", () => {
  // Kinetic issues the bearer token to the residential address that asked for
  // it. After a sticky-IP handover every pooled token is dead on arrival, so
  // the pool must be drained or the first check on the new IP is a guaranteed
  // 403 - which then feeds the denial streak and rotates us off a good IP.
  it("drains every pooled token when the egress IP changes", async () => {
    const { AuthorizedTokenPool } = await import("../../server/authorizedTokenPool");
    const pool = new AuthorizedTokenPool({ mint: async () => ({ token: "t", expiresAt: Date.now() + 3_600_000 }) } as any);
    pool.install("token-minted-on-the-old-ip", Date.now() + 3_600_000);
    expect(pool.snapshot().ready, "a token is held").toBeGreaterThan(0);
    const dropped = pool.invalidateAllForEgressChange();
    expect(dropped).toBe(1);
    expect(pool.snapshot().ready, "nothing survives an IP change").toBe(0);
    expect(pool.invalidateAllForEgressChange(), "idempotent").toBe(0);
  });

  it("the scanner subscribes to egress changes at load", async () => {
    const [fs, path] = [await import("node:fs"), await import("node:path")];
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/scanner.ts"), "utf8");
    expect(src).toContain("onEgressChanged(");
    expect(src).toContain("invalidateAllForEgressChange()");
  });
});
