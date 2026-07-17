import { describe, expect, it } from "vitest";
import {
  kineticTokenRequestInit,
  kineticTokenUrl,
  parseKineticTokenPayload,
} from "../../server/scanner";
import { KFS_SCAN_URL } from "../../server/kfs-config";

function unsignedJwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

describe("Kinetic browser-equivalent token contract", () => {
  it("uses the permissioned v1 address-search endpoint", () => {
    expect(KFS_SCAN_URL).toBe("https://buy.gokinetic.com/api/v1/address/search");
  });

  it("defaults to the live-verified auth/session URL and permits an explicit override", () => {
    expect(kineticTokenUrl({} as NodeJS.ProcessEnv)).toBe(
      "https://buy.gokinetic.com/api/v1/auth/session?context=web",
    );
    expect(
      kineticTokenUrl({
        KFS_AUTH_URL: " https://partner.example/token ",
      } as NodeJS.ProcessEnv),
    ).toBe("https://partner.example/token");
  });

  it("matches the browser GET request without sending credentials or a body", () => {
    const request = kineticTokenRequestInit();
    expect(request.method).toBe("GET");
    expect(request.body).toBeUndefined();
    expect(request.headers).toMatchObject({
      Accept: "*/*",
      Origin: "https://buy.gokinetic.com",
      Referer: "https://buy.gokinetic.com/",
    });
    expect(request.headers).not.toHaveProperty("Authorization");
  });

  it("parses access_token/expires_in and uses the earliest confirmed expiry", () => {
    const now = Date.UTC(2026, 6, 14, 12, 0, 0);
    const jwtExpiry = now + 10 * 60_000;
    const token = unsignedJwt({ exp: Math.floor(jwtExpiry / 1000) });
    expect(
      parseKineticTokenPayload(
        { access_token: token, expires_in: 2_100 },
        now,
      ),
    ).toEqual({ token, expiresAt: jwtExpiry });
  });

  it("rejects malformed or immediately expiring token responses", () => {
    expect(() =>
      parseKineticTokenPayload({ expires_in: 2_100 }),
    ).toThrow("No access_token");
    expect(() =>
      parseKineticTokenPayload({ access_token: "opaque", expires_in: 30 }),
    ).toThrow("expires too soon");
  });
});
