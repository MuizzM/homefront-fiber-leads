import { afterEach, describe, expect, it } from "vitest";
import { ApiError, queryRetryDelay, shouldRetryQuery } from "../../client/src/lib/queryClient";

const originalOnline = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, "onLine");

function setOnline(value: boolean) {
  if (typeof navigator === "undefined") return;
  Object.defineProperty(navigator, "onLine", { configurable: true, value });
}

afterEach(() => {
  if (typeof navigator === "undefined") return;
  if (originalOnline) Object.defineProperty(navigator, "onLine", originalOnline);
  else delete (navigator as any).onLine;
});

describe("mobile-safe query retry policy", () => {
  it("retries transient server, timeout, and throttle responses only twice", () => {
    setOnline(true);
    for (const status of [408, 425, 429, 500, 503]) {
      const error = new ApiError(status, `${status}: transient`, "req-1", null);
      expect(shouldRetryQuery(0, error)).toBe(true);
      expect(shouldRetryQuery(1, error)).toBe(true);
      expect(shouldRetryQuery(2, error)).toBe(false);
    }
  });

  it("never retries permanent auth, permission, validation, or missing-data responses", () => {
    setOnline(true);
    for (const status of [400, 401, 403, 404, 422]) {
      expect(shouldRetryQuery(0, new ApiError(status, "permanent", null, null))).toBe(false);
    }
  });

  it("honors Retry-After but caps a stalled screen at 30 seconds", () => {
    expect(queryRetryDelay(0, new ApiError(429, "slow down", null, 2_500))).toBe(2_500);
    expect(queryRetryDelay(0, new ApiError(429, "slow down", null, 90_000))).toBe(30_000);
  });

  it("allows the query layer to pause and resume while the browser is offline", () => {
    setOnline(false);
    expect(shouldRetryQuery(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetryQuery(2, new TypeError("Failed to fetch"))).toBe(false);
  });
});
