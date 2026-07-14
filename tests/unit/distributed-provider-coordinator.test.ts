import { beforeEach, describe, expect, it, vi } from "vitest";
import { rawDb } from "../../server/db";
import { DistributedProviderCoordinator } from "../../server/distributedProviderCoordinator";

const codec = {
  cacheable: () => true,
  serialize: (value: { value: number }) => JSON.stringify(value),
  deserialize: (value: string) => JSON.parse(value) as { value: number },
};

beforeEach(() => {
  rawDb.exec(`DELETE FROM provider_rate_events; DELETE FROM provider_admission_queue;
    DELETE FROM provider_address_locks; DELETE FROM provider_shared_result_cache;
    UPDATE provider_global_control SET halted=0,halt_reason=NULL,paused_until=NULL WHERE id=1;`);
});

describe("DistributedProviderCoordinator", () => {
  it("enforces one concurrency semaphore across coordinator instances", async () => {
    const a = new DistributedProviderCoordinator<{ value: number }>({ maxConcurrency: 3, maxRequestsPerSecond: 100, resultCacheTtlMs: 1_000 });
    const b = new DistributedProviderCoordinator<{ value: number }>({ maxConcurrency: 3, maxRequestsPerSecond: 100, resultCacheTtlMs: 1_000 });
    let active = 0, peak = 0;
    const work = Array.from({ length: 12 }, (_, index) => (index % 2 ? a : b).execute(`key-${index}`, "city", async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 8));
      active--;
      return { value: index };
    }, codec));
    await Promise.all(work);
    expect(peak).toBe(3);
    expect(a.snapshot()).toMatchObject({ active: 0, queued: 0, maxConcurrency: 3 });
  });

  it("coalesces an identical address across instances through the shared lock and cache", async () => {
    const a = new DistributedProviderCoordinator<{ value: number }>({ maxConcurrency: 2, maxRequestsPerSecond: 100, resultCacheTtlMs: 5_000 });
    const b = new DistributedProviderCoordinator<{ value: number }>({ maxConcurrency: 2, maxRequestsPerSecond: 100, resultCacheTtlMs: 5_000 });
    const provider = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { value: 42 }; });
    const [first, second] = await Promise.all([
      a.execute("same-hash", "manual", provider, codec),
      b.execute("same-hash", "lasso", provider, codec),
    ]);
    expect(first).toEqual({ value: 42 }); expect(second).toEqual({ value: 42 });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("honors global priority and halt state", async () => {
    const coordinator = new DistributedProviderCoordinator<{ value: number }>({ maxConcurrency: 1, maxRequestsPerSecond: 100, resultCacheTtlMs: 0 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const active = coordinator.execute("active", "market", async () => { await gate; return { value: 0 }; }, codec);
    await new Promise(resolve => setTimeout(resolve, 20));
    const city = coordinator.execute("city", "city", async () => { order.push("city"); return { value: 1 }; }, codec);
    const manual = coordinator.execute("manual", "manual", async () => { order.push("manual"); return { value: 2 }; }, codec);
    release();
    await Promise.all([active, city, manual]);
    expect(order).toEqual(["manual", "city"]);
    coordinator.halt("403 denied");
    await expect(coordinator.execute("future", "manual", async () => ({ value: 3 }), codec)).rejects.toThrow("403 denied");
    expect(coordinator.snapshot()).toMatchObject({ halted: true, haltReason: "403 denied" });
    coordinator.resume();
  });
});
