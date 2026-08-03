import { describe, expect, it } from "vitest";
import { SseConnectionCaps, sseCapsFromEnv } from "../../server/scanSseCaps";

describe("SSE scan-stream connection caps", () => {
  it("defaults: 5 per user, 100 global, 30-minute max duration", () => {
    const opts = sseCapsFromEnv();
    expect(opts.perUser).toBe(5);
    expect(opts.global).toBe(100);
    expect(opts.maxDurationMs).toBe(30 * 60 * 1000);
  });

  it("env overrides are honored and invalid values fall back", () => {
    const bak = { ...process.env };
    try {
      process.env.SCAN_SSE_PER_USER_CAP = "7";
      process.env.SCAN_SSE_GLOBAL_CAP = "bad";
      process.env.SCAN_SSE_MAX_DURATION_MS = "5000";
      const opts = sseCapsFromEnv();
      expect(opts.perUser).toBe(7);
      expect(opts.global).toBe(100);
      expect(opts.maxDurationMs).toBe(5_000);
    } finally {
      process.env = bak;
    }
  });

  it("caps connections per user with a named reason", () => {
    const caps = new SseConnectionCaps({ perUser: 2, global: 10, maxDurationMs: 1_000 });
    const a = caps.tryAcquire("u1");
    const b = caps.tryAcquire("u1");
    const c = caps.tryAcquire("u1");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c).toEqual({ ok: false, reason: "user_cap" });
    // A different user is unaffected.
    expect(caps.tryAcquire("u2").ok).toBe(true);
    expect(caps.activeConnections).toBe(3);
  });

  it("caps connections globally across users", () => {
    const caps = new SseConnectionCaps({ perUser: 3, global: 4, maxDurationMs: 1_000 });
    for (const u of ["a", "b", "c", "d"]) expect(caps.tryAcquire(u).ok).toBe(true);
    expect(caps.tryAcquire("e")).toEqual({ ok: false, reason: "global_cap" });
  });

  it("release frees the slot exactly once (close + timeout double-fire safe)", () => {
    const caps = new SseConnectionCaps({ perUser: 1, global: 2, maxDurationMs: 1_000 });
    const first = caps.tryAcquire("u1");
    expect(first.ok).toBe(true);
    expect(caps.tryAcquire("u1").ok).toBe(false);
    if (first.ok) {
      first.grant.release();
      first.grant.release(); // idempotent
    }
    expect(caps.activeConnections).toBe(0);
    expect(caps.activeFor("u1")).toBe(0);
    expect(caps.tryAcquire("u1").ok).toBe(true);
  });
});
