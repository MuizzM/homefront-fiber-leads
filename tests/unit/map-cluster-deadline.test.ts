import { afterEach, expect, it, vi } from "vitest";
import { clusterExpansionZoom } from "../../client/src/lib/mapLibrary";
afterEach(() => vi.useRealTimers());
it("bounds a stalled promise-based worker and releases its deadline timer", async () => {
  vi.useFakeTimers();
  const pending = clusterExpansionZoom({ getClusterExpansionZoom: () => new Promise(() => {}) }, 1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
it("clears deadlines on both successful APIs and rejected workers", async () => {
  vi.useFakeTimers();
  expect(await clusterExpansionZoom({ getClusterExpansionZoom: async () => 12 }, 1)).toBe(12);
  expect(vi.getTimerCount()).toBe(0);
  expect(await clusterExpansionZoom({ getClusterExpansionZoom: (_: number, cb: Function) => cb(null, 10) }, 1)).toBe(10);
  expect(vi.getTimerCount()).toBe(0);
  expect(await clusterExpansionZoom({ getClusterExpansionZoom: async () => { throw new Error("worker failed"); } }, 1)).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
it.each([null, { easeTo: vi.fn() }])("discards an old map's result after removal or replacement (%s)", async replacement => {
  vi.useFakeTimers();
  const original = { easeTo: vi.fn() }; let current: typeof original | null = original;
  let settle!: (zoom: number) => void;
  const zoom = clusterExpansionZoom({ getClusterExpansionZoom: () => new Promise<number>(resolve => { settle = resolve; }) }, 1,
    () => current === original);
  current = replacement; settle(15);
  expect(await zoom).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
