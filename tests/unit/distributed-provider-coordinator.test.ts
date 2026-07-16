import { beforeEach, describe, expect, it, vi } from "vitest";
import { rawDb } from "../../server/db";
import {
  DistributedProviderCoordinator,
  ensureSchema,
} from "../../server/distributedProviderCoordinator";

const codec = {
  cacheable: () => true,
  serialize: (value: { value: number }) => JSON.stringify(value),
  deserialize: (value: string) => JSON.parse(value) as { value: number },
};

beforeEach(() => {
  // CI starts with a pristine database, unlike a developer database that may
  // already contain the coordinator tables.
  ensureSchema();
  rawDb.exec(`DELETE FROM provider_rate_events; DELETE FROM provider_admission_queue;
    DELETE FROM provider_address_locks; DELETE FROM provider_shared_result_cache;
    UPDATE provider_global_control SET halted=0,halt_reason=NULL,paused_until=NULL,next_start_at=0 WHERE id=1;`);
});

describe("DistributedProviderCoordinator", () => {
  it("enforces one concurrency semaphore across coordinator instances", async () => {
    const a = new DistributedProviderCoordinator<{ value: number }>({ maxConcurrency: 3, maxRequestsPerMinute: 100, resultCacheTtlMs: 1_000, rateWindowMs: 100 });
    const b = new DistributedProviderCoordinator<{ value: number }>({ maxConcurrency: 3, maxRequestsPerMinute: 100, resultCacheTtlMs: 1_000, rateWindowMs: 100 });
    let active = 0, peak = 0;
    const work = Array.from({ length: 12 }, (_, index) => (index % 2 ? a : b).execute(`key-${index}`, "city", async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 8));
      active--;
      return { value: index };
    }, codec));
    await Promise.all(work);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    expect(a.snapshot()).toMatchObject({ active: 0, queued: 0, maxConcurrency: 3 });
  });

  it("coalesces an identical address across instances through the shared lock and cache", async () => {
    const a = new DistributedProviderCoordinator<{ value: number }>({ maxConcurrency: 2, maxRequestsPerMinute: 100, resultCacheTtlMs: 5_000, rateWindowMs: 100 });
    const b = new DistributedProviderCoordinator<{ value: number }>({ maxConcurrency: 2, maxRequestsPerMinute: 100, resultCacheTtlMs: 5_000, rateWindowMs: 100 });
    const provider = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { value: 42 }; });
    const [first, second] = await Promise.all([
      a.execute("same-hash", "manual", provider, codec),
      b.execute("same-hash", "lasso", provider, codec),
    ]);
    expect(first).toEqual({ value: 42 }); expect(second).toEqual({ value: 42 });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("honors global priority and has no halt state", async () => {
    const coordinator = new DistributedProviderCoordinator<{ value: number }>({ maxConcurrency: 1, maxRequestsPerMinute: 100, resultCacheTtlMs: 0, rateWindowMs: 100 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const active = coordinator.execute("active", "market", async () => { await gate; return { value: 0 }; }, codec);
    await new Promise(resolve => setTimeout(resolve, 20));
    const city = coordinator.execute("city", "city", async () => { order.push("city"); return { value: 1 }; }, codec);
    const nightly = coordinator.execute("nightly", "nightly", async () => { order.push("nightly"); return { value: 2 }; }, codec);
    const comingSoon = coordinator.execute("coming", "coming_soon", async () => { order.push("coming"); return { value: 3 }; }, codec);
    const lasso = coordinator.execute("lasso", "lasso", async () => { order.push("lasso"); return { value: 4 }; }, codec);
    const manual = coordinator.execute("manual", "manual", async () => { order.push("manual"); return { value: 5 }; }, codec);
    release();
    await Promise.all([active, city, nightly, comingSoon, lasso, manual]);
    expect(order).toEqual(["manual", "lasso", "coming", "nightly", "city"]);
    // No halt mechanism — a denial never stops the coordinator; future work runs
    // and the snapshot carries no halted flag.
    expect((coordinator as unknown as { halt?: unknown }).halt).toBeUndefined();
    await expect(coordinator.execute("future", "manual", async () => ({ value: 9 }), codec))
      .resolves.toMatchObject({ value: 9 });
    expect(coordinator.snapshot()).not.toHaveProperty("halted");
  });

  it("enforces one aggregate rolling-minute budget without losing queued jobs", async () => {
    const rateWindowMs = 200;
    const a = new DistributedProviderCoordinator<{ value: number }>({
      maxConcurrency: 10,
      maxRequestsPerMinute: 3,
      resultCacheTtlMs: 0,
      rateWindowMs,
      pollMs: 10,
    });
    const b = new DistributedProviderCoordinator<{ value: number }>({
      maxConcurrency: 10,
      maxRequestsPerMinute: 3,
      resultCacheTtlMs: 0,
      rateWindowMs,
      pollMs: 10,
    });
    const starts: number[] = [];
    const startedAt = Date.now();
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      (index % 2 ? a : b).execute(`rpm-${index}`, index === 1 ? "lasso" : "city", async () => {
        starts.push(Date.now());
        return { value: index };
      }, codec),
    ));
    expect(results).toHaveLength(6);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(rateWindowMs - 20);
    for (const windowStart of starts) {
      expect(starts.filter(value => value >= windowStart && value < windowStart + rateWindowMs).length)
        .toBeLessThanOrEqual(3);
    }
    expect(a.snapshot()).toMatchObject({ maxRequestsPerMinute: 3, active: 0, queued: 0 });
  });
});
