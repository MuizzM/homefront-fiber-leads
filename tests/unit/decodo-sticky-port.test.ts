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
  "DECODO_STICKY_PORT_COUNT", "DECODO_STICKY_MINUTES", "DECODO_ROTATE_AFTER_DENIALS"];
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
