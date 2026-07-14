import { describe, expect, it } from "vitest";
import { proxyUrlFromEnv } from "../../server/proxy-fetch";

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
