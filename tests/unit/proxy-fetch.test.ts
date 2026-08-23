import { afterAll, describe, expect, it } from "vitest";
import { proxyUrlFromEnv, rotateProxySession, getProxySessionId, __resetRotationStateForTests } from "../../server/proxy-fetch";

describe("Decodo session rotation (single-flight reset)", () => {
  afterAll(() => { delete process.env.PROXY_URL; delete process.env.DECODO_ROTATE_AFTER_DENIALS; });

  it("is not pinned after the first rotation - resumes rotating once the min-interval passes", async () => {
    // A dummy proxy URL: undici's ProxyAgent is lazy, so building one never
    // connects here. Regression guard for the sync-async-IIFE bug where the
    // in-flight guard stayed pinned to a resolved promise and disabled ALL
    // future rotations (which stalled the production scan at 0 checked).
    //
    // Rotations are now throttled by ROTATE_MIN_INTERVAL_MS so a transient-error
    // burst can't strip every warm connection. __resetRotationStateForTests()
    // simulates the window elapsing; the key guarantee is that after it, a
    // rotation STILL advances the session (proving the guard is never pinned).
    process.env.PROXY_URL = "http://u:p@127.0.0.1:1";
    // A sticky IP is now held until it has been denied DECODO_ROTATE_AFTER_DENIALS
    // times (one 403 says nothing about an IP - measured: first denial at check
    // 15, then 30 clean). This test is about the single-flight guard, not the
    // streak, so make one denial enough and let the streak have its own test.
    process.env.DECODO_ROTATE_AFTER_DENIALS = "1";
    await new Promise(r => setTimeout(r, 50)); // let module-level undici load settle
    __resetRotationStateForTests();
    const before = getProxySessionId();
    await rotateProxySession("t1");
    const after1 = getProxySessionId();
    expect(after1).not.toBe(before);   // 1st rotation advanced the session

    // Within the min-interval window a second rotation is suppressed (keep-alive
    // pool survives) — the session does NOT advance.
    await rotateProxySession("t2-throttled");
    expect(getProxySessionId()).toBe(after1);

    // Window elapsed → rotation works again (the guard was never permanently
    // pinned — the original bug would leave it stuck here forever).
    __resetRotationStateForTests();
    await rotateProxySession("t3");
    expect(getProxySessionId()).not.toBe(after1);
  });
});

describe("Decodo proxy configuration", () => {
  it("prefers an explicit proxy URL", () => {
    expect(proxyUrlFromEnv({ PROXY_URL: "http://explicit:secret@proxy.example:1234" }))
      .toBe("http://explicit:secret@proxy.example:1234");
  });

  it("builds an encoded URL from split Decodo secrets", () => {
    expect(proxyUrlFromEnv({
      DECODO_HOST: "us.decodo.com",
      DECODO_PORT: "10000",
      DECODO_USER: "field user",
      DECODO_PASS: "p@ss:word",
    })).toBe("http://field%20user:p%40ss%3Aword@us.decodo.com:10000");
  });

  it("fails closed when split credentials are incomplete", () => {
    expect(proxyUrlFromEnv({ DECODO_HOST: "us.decodo.com", DECODO_PORT: "10000" })).toBeNull();
  });
});
