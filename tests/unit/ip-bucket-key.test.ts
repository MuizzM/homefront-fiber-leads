import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { ipBucketKey, perUserKey } from "../../server/limiters";

/**
 * Regression cover for the IPv6 rate-limit bypass.
 *
 * Residential IPv6 is allocated per-customer in /64 blocks. Keying a limiter on
 * the full /128 address therefore hands ONE caller 2^64 distinct buckets, and
 * every per-IP cap — including the OTP send and verify caps that are the only
 * thing standing between an attacker and unlimited sign-in attempts — silently
 * stops existing. express-rate-limit warns about this at startup; the fix is to
 * route every IP through ipKeyGenerator so the bucket is per-SUBNET.
 */

const req = (over: Partial<Request> & Record<string, any> = {}) =>
  ({ headers: {}, socket: {}, ...over }) as unknown as Request;

describe("ipBucketKey — IPv6 bypass regression", () => {
  it("collapses addresses inside one IPv6 /64 to a SINGLE bucket", () => {
    // Same /64, different hosts — an attacker rotating within their own block.
    const a = ipBucketKey("2a01:4ff:f0:6b71::1");
    const b = ipBucketKey("2a01:4ff:f0:6b71::dead:beef");
    const c = ipBucketKey("2a01:4ff:f0:6b71:aaaa:bbbb:cccc:dddd");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("keeps genuinely different IPv6 subnets in different buckets", () => {
    expect(ipBucketKey("2a01:4ff:f0:6b71::1")).not.toBe(ipBucketKey("2a01:4ff:f0:9999::1"));
  });

  it("leaves IPv4 addresses distinct — no accidental over-grouping", () => {
    expect(ipBucketKey("203.0.113.7")).not.toBe(ipBucketKey("203.0.113.8"));
  });

  it("is deterministic, so check() and reset() cannot derive different keys", () => {
    // The reset path previously built its key inline. A reset that misses its
    // bucket is a lockout no operator can clear, so this must be stable.
    const ip = "2a01:4ff:f0:6b71::42";
    expect(ipBucketKey(ip)).toBe(ipBucketKey(ip));
  });

  it("namespaces buckets under ip: so they cannot collide with session keys", () => {
    expect(ipBucketKey("203.0.113.7").startsWith("ip:")).toBe(true);
  });
});

describe("perUserKey", () => {
  it("prefers the session token so a NAT'd field team is not one shared bucket", () => {
    expect(perUserKey(req({ headers: { "x-session-id": "sess-abc" }, ip: "203.0.113.7" }))).toBe("u:sess-abc");
  });

  it("falls back to the SUBNET-collapsed IP when unauthenticated", () => {
    const one = perUserKey(req({ ip: "2a01:4ff:f0:6b71::1" }));
    const two = perUserKey(req({ ip: "2a01:4ff:f0:6b71::2" }));
    expect(one).toBe(two);
    expect(one).toBe(ipBucketKey("2a01:4ff:f0:6b71::1"));
  });

  it("survives a request with neither session nor resolvable IP", () => {
    expect(() => perUserKey(req())).not.toThrow();
  });
});
