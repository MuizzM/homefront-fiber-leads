import { describe, expect, it } from "vitest";
import { globalApiRateLimitMax, shouldSkipGlobalRateLimit } from "../../server/rateLimitPolicy";

describe("global API rate-limit policy", () => {
  it("never lets ordinary API traffic lock the dedicated OTP login routes", () => {
    expect(shouldSkipGlobalRateLimit("/api/auth/otp/request", "production")).toBe(true);
    expect(shouldSkipGlobalRateLimit("/api/auth/otp/verify", "production")).toBe(true);
  });

  it("still meters ordinary production API traffic", () => {
    expect(shouldSkipGlobalRateLimit("/api/leads", "production")).toBe(false);
    expect(shouldSkipGlobalRateLimit("/api/monitor/summary", "production")).toBe(false);
  });

  it("uses a mobile/shared-network-safe default while honoring an override", () => {
    expect(globalApiRateLimitMax(undefined)).toBe(1_200);
    expect(globalApiRateLimitMax("2500")).toBe(2_500);
    expect(globalApiRateLimitMax("bad")).toBe(1_200);
  });
});
