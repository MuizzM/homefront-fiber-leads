import { describe, expect, it, vi } from "vitest";
import { ProviderRequestQueue } from "../../server/providerRequestQueue";

describe("ProviderRequestQueue", () => {
  it("accepts unlimited queued work while enforcing one global concurrency ceiling", async () => {
    let active = 0;
    let peak = 0;
    const queue = new ProviderRequestQueue<number>({ maxConcurrency: 3, cacheTtlMs: 0 });
    const work = Array.from({ length: 50 }, (_, i) => queue.request(`address-${i}`, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return i;
    }));

    await expect(Promise.all(work)).resolves.toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(peak).toBe(3);
    expect(queue.snapshot()).toMatchObject({ active: 0, queued: 0, completed: 50, failed: 0, maxConcurrency: 3 });
  });

  it("coalesces concurrent duplicate addresses into one provider request", async () => {
    const queue = new ProviderRequestQueue<{ answer: string }>({ maxConcurrency: 4, cacheTtlMs: 0, clone: value => ({ ...value }) });
    const provider = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { answer: "fresh" };
    });

    const results = await Promise.all(Array.from({ length: 20 }, () => queue.request("1 main st|lexington|nc|27292", provider)));
    expect(provider).toHaveBeenCalledTimes(1);
    expect(results.every(result => result.answer === "fresh")).toBe(true);
    expect(queue.snapshot().deduped).toBe(19);
  });

  it("caches only approved conclusive values and returns defensive clones", async () => {
    let now = 1_000;
    const queue = new ProviderRequestQueue<{ conclusive: boolean; nested?: object }>({
      maxConcurrency: 1,
      cacheTtlMs: 5_000,
      now: () => now,
      cacheable: value => value.conclusive,
      clone: value => ({ ...value }),
    });
    const provider = vi.fn(async () => ({ conclusive: true }));

    const first = await queue.request("a", provider);
    first.conclusive = false;
    const second = await queue.request("a", provider);
    expect(second.conclusive).toBe(true);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(queue.snapshot().cacheHits).toBe(1);

    now += 5_001;
    await queue.request("a", provider);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("never caches failures or rejected tasks", async () => {
    const queue = new ProviderRequestQueue<{ conclusive: boolean }>({
      maxConcurrency: 1,
      cacheTtlMs: 5_000,
      cacheable: value => value.conclusive,
    });
    const nonAnswer = vi.fn(async () => ({ conclusive: false }));
    await queue.request("non-answer", nonAnswer);
    await queue.request("non-answer", nonAnswer);
    expect(nonAnswer).toHaveBeenCalledTimes(2);

    const rejected = vi.fn(async () => { throw new Error("network"); });
    await expect(queue.request("failure", rejected)).rejects.toThrow("network");
    await expect(queue.request("failure", rejected)).rejects.toThrow("network");
    expect(rejected).toHaveBeenCalledTimes(2);
    expect(queue.snapshot().failed).toBe(2);
  });
});
