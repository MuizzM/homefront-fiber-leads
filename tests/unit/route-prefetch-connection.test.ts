import { afterEach, describe, expect, it, vi } from "vitest";
const imported = vi.hoisted(() => vi.fn());
vi.mock("@/pages/FollowUps", () => { imported(); return { default: () => null }; });
vi.mock("@/lib/queryClient", () => ({ queryClient: { prefetchQuery: vi.fn() } }));
afterEach(() => { vi.unstubAllGlobals(); });
describe("speculative route download connection gate", () => {
  it("does not warm chunks on offline, Data Saver or 2G intent, then warms and deduplicates when permitted", async () => {
    const { prefetchRoute } = await import("../../client/src/lib/routePrefetch");
    for (const connection of [{ onLine: false }, { onLine: true, connection: { saveData: true } }, { onLine: true, connection: { effectiveType: "2g" } }]) {
      vi.stubGlobal("navigator", connection); prefetchRoute("/followups");
      await vi.dynamicImportSettled(); expect(imported).not.toHaveBeenCalled();
    }
    vi.stubGlobal("navigator", { onLine: true, connection: { effectiveType: "3g" } });
    prefetchRoute("/followups"); prefetchRoute("/followups");
    await vi.dynamicImportSettled(); expect(imported).toHaveBeenCalledTimes(1);
  });
});
