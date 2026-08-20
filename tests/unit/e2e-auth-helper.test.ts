import { beforeEach, describe, expect, it, vi } from "vitest";
import { loginAs } from "../e2e/helpers/auth";

describe("Playwright authenticated boot helper", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
  });

  it("seeds the current bounded localStorage session contract before navigation", async () => {
    const page = {
      addInitScript: vi.fn(async (script: (value: any) => void, value: any) => script(value)),
    };

    await loginAs(page as any, "session-123");

    expect(window.localStorage.getItem("hfs.sid")).toBe("session-123");
    expect(Number(window.localStorage.getItem("hfs.sid.until"))).toBe(
      Date.now() + 6 * 24 * 60 * 60 * 1000,
    );
    expect(window.name).not.toContain("session-123");
  });
});
