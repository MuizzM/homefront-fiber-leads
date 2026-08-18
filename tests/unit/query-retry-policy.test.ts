import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest, queryRetryDelay, shouldRetryQuery } from "../../client/src/lib/queryClient";

const originalOnline = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, "onLine");
const originalFetch = globalThis.fetch;

function setOnline(value: boolean) {
  if (typeof navigator === "undefined") return;
  Object.defineProperty(navigator, "onLine", { configurable: true, value });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (typeof navigator === "undefined") return;
  if (originalOnline) Object.defineProperty(navigator, "onLine", originalOnline);
  else delete (navigator as any).onLine;
});

describe("mobile-safe query retry policy", () => {
  it("preserves a structured API error code for precise recovery UI", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "No team member is linked to this login", code: "NO_REP" }),
      { status: 400, headers: { "content-type": "application/json", "x-request-id": "req-no-rep" } },
    ));

    await expect(apiRequest("GET", "/api/test-no-rep")).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      code: "NO_REP",
      requestId: "req-no-rep",
    });
  });

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
