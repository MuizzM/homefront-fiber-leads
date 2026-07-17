import { afterAll, describe, expect, it } from "vitest";
import { proxyUrlFromEnv, rotateProxySession, getProxySessionId } from "../../server/proxy-fetch";

describe("Decodo session rotation (single-flight reset)", () => {
  afterAll(() => { delete process.env.PROXY_URL; });

  it("rebuilds the dispatcher on EVERY sequential call — not pinned after the first", async () => {
    // A dummy proxy URL: undici's ProxyAgent is lazy, so building one never
    // connects here. Regression guard for the sync-async-IIFE bug where the
    // in-flight guard stayed pinned to a resolved promise and disabled all
    // rotations after the first (which stalled the production scan at 0 checked).
    process.env.PROXY_URL = "http://u:p@127.0.0.1:1";
    await new Promise(r => setTimeout(r, 50)); // let module-level undici load settle
    const before = getProxySessionId();
    await rotateProxySession("t1");
    const after1 = getProxySessionId();
    await rotateProxySession("t2");
    const after2 = getProxySessionId();
    await rotateProxySession("t3");
    const after3 = getProxySessionId();
    expect(after1).not.toBe(before);   // 1st rotation advanced the session
    expect(after2).not.toBe(after1);   // 2nd rotation advanced it again (bug would pin here)
    expect(after3).not.toBe(after2);   // 3rd too
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
