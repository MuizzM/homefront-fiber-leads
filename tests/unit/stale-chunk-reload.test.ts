// ── One-shot stale-chunk reload gate ─────────────────────────────────────────
// After a deploy, a tab on the previous build recovers from a failed route
// chunk import by reloading into the new build — but the reload must fire
// EXACTLY once per tab session: a rep who is truly offline fails the imports
// on the reloaded page too, and a second automatic reload would loop the tab
// forever. These tests pin the latch semantics the whole recovery hangs on.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetStaleChunkForTests,
  installStaleChunkRecovery,
  recoverFromStaleChunk,
} from "@/lib/staleChunk";

const RELOADED_KEY = "hfs:stale-chunk-reloaded";

describe("recoverFromStaleChunk", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    reload = vi.fn();
    __resetStaleChunkForTests(reload);
  });

  it("first failure of the session: reloads once and reports handled", () => {
    expect(recoverFromStaleChunk()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(RELOADED_KEY)).toBe("1");
  });

  it("later failures on the SAME page ride the in-flight reload, no second fire", () => {
    recoverFromStaleChunk();
    expect(recoverFromStaleChunk()).toBe(true);
    expect(recoverFromStaleChunk()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("after the reload landed (fresh page, flag persisted): declines so the ErrorBoundary shows", () => {
    recoverFromStaleChunk();
    // Next page load = fresh module state, same per-tab sessionStorage.
    __resetStaleChunkForTests(reload);
    expect(recoverFromStaleChunk()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads when sessionStorage is unusable — an unbounded retry could loop", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    expect(recoverFromStaleChunk()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("vite:preloadError is wired to the same gate, latch included", () => {
    installStaleChunkRecovery();
    window.dispatchEvent(new Event("vite:preloadError"));
    expect(reload).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("vite:preloadError"));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
