import { describe, expect, it, vi } from "vitest";
import { ProviderRequestQueue } from "../../server/providerRequestQueue";

describe("ProviderRequestQueue", () => {
  it("reads a shared run cancellation once per sweep even under a large backlog", async () => {
    vi.useFakeTimers();
    const queue = new ProviderRequestQueue<number>({ maxConcurrency: 1, cacheTtlMs: 0 });
    try {
      queue.pauseFor(10_000); const abort = vi.fn(() => false), task = vi.fn(async () => 1);
      const work = Array.from({ length: 1_000 }, (_, i) => queue.request(String(i), task, { abort }).catch(() => null));
      abort.mockClear(); await vi.advanceTimersByTimeAsync(100);
      expect(abort).toHaveBeenCalledTimes(1); expect(queue.snapshot().queued).toBe(1_000);
      abort.mockReturnValue(true); await vi.advanceTimersByTimeAsync(100);
      expect(abort).toHaveBeenCalledTimes(2); expect(queue.snapshot().queued).toBe(0);
      await Promise.all(work); expect(task).not.toHaveBeenCalled();
      queue.resume(); await vi.advanceTimersByTimeAsync(10_000);
    } finally { vi.useRealTimers(); }
  });
  it("expires paused admission without executing it later", async () => {
    const queue = new ProviderRequestQueue<number>({ maxConcurrency: 1, cacheTtlMs: 0 });
    queue.pauseFor(10_000); const task = vi.fn(async () => 1);
    await expect(queue.request("expired", task, { deadlineAt: Date.now() + 20 })).rejects.toThrow(/admission/);
    queue.resume(); await Promise.resolve();
    expect(task).not.toHaveBeenCalled(); expect(queue.snapshot().queued).toBe(0);
  });
  it("cancels one duplicate waiter without releasing a live owner's slot", async () => {
    const queue = new ProviderRequestQueue<number>({ maxConcurrency: 1, cacheTtlMs: 0 });
    let release!: (n: number) => void, cancelled = false;
    const task = vi.fn(() => new Promise<number>(resolve => { release = resolve; }));
    const owner = queue.request("shared", task); await Promise.resolve();
    const duplicate = queue.request("shared", task, { abort: () => cancelled }); cancelled = true;
    await expect(duplicate).rejects.toThrow(/admission/);
    expect(queue.snapshot().active).toBe(1); expect(task).toHaveBeenCalledTimes(1);
    release(1); expect(await owner).toBe(1);
  });
  it("clears capacity when a task throws synchronously", async () => {
    const queue = new ProviderRequestQueue<number>({ maxConcurrency: 1, cacheTtlMs: 0 });
    await expect(queue.request("throw", () => { throw new Error("sync fault"); })).rejects.toThrow("sync fault");
    expect(await queue.request("next", async () => 2)).toBe(2);
  });
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

  it("prioritizes manual and lasso, then coming-soon rechecks, ahead of city work", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queue = new ProviderRequestQueue<string>({ maxConcurrency: 1, cacheTtlMs: 0 });
    const order: string[] = [];
    const first = queue.request("busy", async () => { await gate; return "busy"; }, { source: "market" });
    const jobs = [
      queue.request("recheck", async () => { order.push("recheck"); return "recheck"; }, { source: "recheck" }),
      queue.request("city", async () => { order.push("city"); return "city"; }, { source: "city" }),
      queue.request("coming-soon", async () => { order.push("coming-soon"); return "coming-soon"; }, { source: "coming_soon" }),
      queue.request("lasso", async () => { order.push("lasso"); return "lasso"; }, { source: "lasso" }),
      queue.request("manual", async () => { order.push("manual"); return "manual"; }, { source: "manual" }),
    ];
    release();
    await first;
    await Promise.all(jobs);
    expect(order).toEqual(["manual", "lasso", "coming-soon", "recheck", "city"]);
  });

  it("upgrades the priority of a queued duplicate without duplicating provider work", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queue = new ProviderRequestQueue<string>({ maxConcurrency: 1, cacheTtlMs: 0 });
    const provider = vi.fn(async () => "same");
    const blocker = queue.request("busy", async () => { await gate; return "busy"; });
    const low = queue.request("same-address", provider, { source: "recheck" });
    const high = queue.request("same-address", provider, { source: "manual" });
    expect(queue.snapshot().queuedBySource.manual).toBe(1);
    release();
    await blocker;
    await expect(Promise.all([low, high])).resolves.toEqual(["same", "same"]);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("supports a 100-check global concurrency ceiling", async () => {
    let active = 0, peak = 0;
    const queue = new ProviderRequestQueue<number>({ maxConcurrency: 100, cacheTtlMs: 0 });
    await Promise.all(Array.from({ length: 120 }, (_, index) => queue.request(String(index), async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return index;
    })));
    expect(peak).toBe(100);
    expect(queue.snapshot().maxConcurrency).toBe(100);
  });

  it("enforces one rolling RPS ceiling across all priorities", async () => {
    const starts: number[] = [];
    const queue = new ProviderRequestQueue<number>({ maxConcurrency: 4, maxRequestsPerSecond: 2, cacheTtlMs: 0 });
    await Promise.all(Array.from({ length: 4 }, (_, index) => queue.request(String(index), async () => {
      starts.push(Date.now());
      return index;
    }, { source: index === 3 ? "manual" : "recheck" })));
    expect(starts).toHaveLength(4);
    expect(starts[2] - starts[0]).toBeGreaterThanOrEqual(900);
    expect(queue.snapshot().maxRequestsPerSecond).toBe(2);
  });

  it("has no halt: an access denial never wedges queued or future work", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queue = new ProviderRequestQueue<string>({ maxConcurrency: 1, cacheTtlMs: 0 });
    const active = queue.request("active", async () => { await gate; return "ok"; });
    const queued = queue.request("queued", async () => "queued-ran");
    // The queue has no halt mechanism — nothing can put it into a stuck state.
    expect((queue as unknown as { halt?: unknown }).halt).toBeUndefined();
    release();
    await expect(active).resolves.toBe("ok");
    await expect(queued).resolves.toBe("queued-ran");
    // Future work still runs; the snapshot carries no halted flag anymore.
    await expect(queue.request("future", async () => "future-ran")).resolves.toBe("future-ran");
    expect(queue.snapshot()).not.toHaveProperty("halted");
  });
});
