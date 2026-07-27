import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type ScannerModule = typeof import("../../server/scanner");

let scanner: ScannerModule;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  fetchSpy = vi.fn(async () => {
    throw new Error("scanner module import attempted an outbound request");
  });
  vi.stubGlobal("fetch", fetchSpy);

  scanner = await import("../../server/scanner");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("scanner authorized-token auto-warm boot policy", () => {
  it("auto-warms in production even when the legacy authorization flag is absent", () => {
    expect(scanner.shouldAutoWarmAuthorizedTokenPool({
      NODE_ENV: "production",
    })).toBe(true);
  });

  it("does not let the legacy authorization flag disable production warming", () => {
    expect(scanner.shouldAutoWarmAuthorizedTokenPool({
      NODE_ENV: "production",
      KFS_AUTOMATION_AUTHORIZED: "false",
    })).toBe(true);
  });

  it("never auto-warms under tests and module import performs no outbound request", () => {
    expect(scanner.shouldAutoWarmAuthorizedTokenPool({
      NODE_ENV: "test",
      VITEST: "true",
      KFS_AUTOMATION_AUTHORIZED: "true",
    })).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
