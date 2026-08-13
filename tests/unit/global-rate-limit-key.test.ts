// The global rate-limit bucket is keyed per SIGNED-IN USER, not per IP.
//
// Why this is a multi-rep bug and not a tuning preference: a field crew shares
// an IP. One office WiFi, one carrier gateway, one hotspot - to Express they
// are one client. The app is chatty on their behalf (measured: ~15 API calls
// to open the map, ~4/min while it merely sits there, before a door is
// knocked), so a per-IP budget is divided by however many reps are standing in
// the same parking lot.
//
// Measured against a live server with the budget set to 40, two reps on one IP:
//   IP-keyed    rep A 33 ok then 429 · rep B 10/10 REFUSED (zero requests of
//               their own - just standing next to a colleague)
//   user-keyed  rep A 40 ok then 429 · rep B 10/10 SERVED
//
// The codebase already knew: the scan and chat buckets were carved out of the
// global one because "shared carrier NATs must not cooldown a whole field
// team". This applies that same reasoning to the traffic that dominates.
//
// The second half is the security half. This bucket runs BEFORE any auth gate,
// so it is the only ceiling anonymous traffic has. A token therefore has to
// RESOLVE before it earns its own bucket, or a caller could mint an unlimited
// budget by rotating forged headers. Verified live: 60 rotating forged UUIDs
// collapsed onto the IP bucket and were cut off.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionScopedKey, perUserKey } from "../../server/limiters";
import { shouldSkipGlobalRateLimit } from "../../server/rateLimitPolicy";

const ROOT = join(__dirname, "..", "..");
const REAL = "11111111-2222-4333-8444-555555555555";
const FORGED = "99999999-8888-4777-8666-555555555555";

const req = (sid?: string, ip = "203.0.113.7") =>
  ({ headers: sid ? { "x-session-id": sid } : {}, ip, socket: { remoteAddress: ip } }) as any;

const live = (sid: string) => sid === REAL;
const key = sessionScopedKey(live);

describe("two reps on one IP get two budgets", () => {
  it("a signed-in rep is keyed by their session, not their address", () => {
    expect(key(req(REAL))).toBe(`u:${REAL}`);
  });

  it("the same rep keeps ONE bucket as they roam between networks", () => {
    // Carrier handoff mid-shift must not hand them a second budget either.
    expect(key(req(REAL, "203.0.113.7"))).toBe(key(req(REAL, "198.51.100.9")));
  });

  it("two reps behind ONE address never share a bucket", () => {
    const a = sessionScopedKey(() => true)(req("aaaaaaaa-1111-4111-8111-111111111111"));
    const b = sessionScopedKey(() => true)(req("bbbbbbbb-2222-4222-8222-222222222222"));
    expect(a).not.toBe(b);
  });
});

describe("the ceiling on anonymous traffic still holds", () => {
  it("an unauthenticated caller is keyed by IP", () => {
    expect(key(req(undefined))).toBe("ip:203.0.113.7");
  });

  it("a FORGED token cannot mint its own budget - it falls back to the IP", () => {
    // The whole point: this bucket runs before auth, so trusting the header
    // would delete the global limit for anyone willing to send junk.
    expect(key(req(FORGED))).toBe("ip:203.0.113.7");
    expect(key(req(FORGED))).toBe(key(req(undefined)));
  });

  it("rotating forged tokens all land in the SAME bucket", () => {
    const keys = new Set(
      Array.from({ length: 50 }, (_, i) =>
        key(req(`ffffffff-0000-4000-8000-${String(i).padStart(12, "0")}`)),
      ),
    );
    expect(keys.size).toBe(1);
  });

  it("IPv6 collapses to its subnet, so a /64 holder gets one bucket not 2^64", () => {
    const a = key(req(undefined, "2001:db8:1234:5678::1"));
    const b = key(req(undefined, "2001:db8:1234:5678::99ff"));
    expect(a).toBe(b);
  });
});

describe("wiring", () => {
  const index = readFileSync(join(ROOT, "server/index.ts"), "utf8");

  it("the global limiter uses the session-scoped key", () => {
    expect(index).toContain("keyGenerator: sessionScopedKey(isLiveSession)");
    // The bare-IP keyGenerator must not come back.
    expect(index).not.toMatch(/keyGenerator:\s*\(req\)\s*=>\s*\{[^}]*ipKeyGenerator/);
  });

  it("session validity is memoised, so the key costs no DB read per request", () => {
    expect(index).toContain("_liveSessionCache");
    expect(index).toContain("LIVE_SESSION_TTL_MS");
    // Bounded: forged tokens must not be able to grow it without limit.
    expect(index).toContain("LIVE_SESSION_CACHE_MAX");
    expect(index).toMatch(/_liveSessionCache\.size >= LIVE_SESSION_CACHE_MAX/);
  });

  it("a malformed token never reaches the DB at all", () => {
    expect(index).toMatch(/sid\.length !== 36/);
  });

  it("field API paths are still METERED - this widens the key, never the net", () => {
    // If these started skipping, the fix would have become a hole.
    for (const p of ["/api/leads/map", "/api/leads/7/knock", "/api/followups", "/api/leaderboard"]) {
      expect(shouldSkipGlobalRateLimit(p, "production"), `${p} must stay metered`).toBe(false);
    }
  });

  it("perUserKey is unchanged for the buckets that sit BEHIND auth", () => {
    // Scan/chat resolve their user before their limiter runs, so the header is
    // already proven there; only the global bucket needed the stricter key.
    expect(perUserKey(req(FORGED))).toBe(`u:${FORGED}`);
  });
});
