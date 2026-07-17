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
    UPDATE provider_global_control SET next_start_at=0 WHERE id=1;`);
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

  it("reserves concurrency for CRITICAL so a bulk NORMAL sweep can never starve it", async () => {
    // maxConcurrency 5, reserve 2 for CRITICAL → NORMAL may hold at most 3 active.
    const c = new DistributedProviderCoordinator<{ value: number }>({
      maxConcurrency: 5, maxRequestsPerMinute: 1000, resultCacheTtlMs: 0, rateWindowMs: 100, pollMs: 5,
      criticalReservedConcurrency: 2, criticalReservedRate: 0,
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    // 3 NORMAL (city) checks fill the NORMAL ceiling (5 - 2 reserved) and hold it.
    const holders = Array.from({ length: 3 }, (_, i) =>
      c.execute(`hold-${i}`, "city", async () => { await gate; order.push(`hold-${i}`); return { value: i }; }, codec));
    await new Promise(resolve => setTimeout(resolve, 50)); // let all 3 become active
    // 3 MORE NORMAL checks queue but CANNOT start — NORMAL is capped at 3 active.
    const extraNormal = Array.from({ length: 3 }, (_, i) =>
      c.execute(`extra-${i}`, "city", async () => { order.push(`extra-${i}`); return { value: 10 + i }; }, codec));
    // A CRITICAL new-build check submitted LAST must STILL start immediately — it
    // takes a reserved slot the NORMAL sweep can never occupy. Resolves without
    // releasing the gate that the NORMAL holders are stuck on.
    const critical = c.execute("crit", "new_build", async () => { order.push("CRITICAL"); return { value: 99 }; }, codec);
    await critical;
    expect(order).toContain("CRITICAL");
    // The bulk NORMAL work is still blocked (gate held) — CRITICAL jumped ahead.
    expect(order.filter(o => o.startsWith("extra")).length).toBe(0);
    // Snapshot exposes the reservation + the live critical/normal split.
    const snap = c.snapshot();
    expect(snap.criticalReservedConcurrency).toBe(2);
    release();
    await Promise.all([...holders, ...extraNormal]);
    expect(order.indexOf("CRITICAL")).toBeLessThan(order.indexOf("extra-0")); // classified before bulk
  });

  it("reserves per-window rate headroom for CRITICAL under a full rolling budget", async () => {
    // 3 starts/window, reserve 1 for CRITICAL → NORMAL may only consume 2/window.
    const c = new DistributedProviderCoordinator<{ value: number }>({
      maxConcurrency: 10, maxRequestsPerMinute: 3, resultCacheTtlMs: 0, rateWindowMs: 300, pollMs: 8,
      criticalReservedConcurrency: 0, criticalReservedRate: 1,
    });
    const order: string[] = [];
    // Fire 3 NORMAL first; only 2 may start this window (1 rate slot reserved).
    const normals = Array.from({ length: 3 }, (_, i) =>
      c.execute(`n-${i}`, "city", async () => { order.push(`n-${i}`); return { value: i }; }, codec));
    const critical = c.execute("c", "new_build", async () => { order.push("CRITICAL"); return { value: 9 }; }, codec);
    await critical; // CRITICAL claims the reserved rate slot in the first window
    expect(order).toContain("CRITICAL");
    // At most 2 NORMAL got in before CRITICAL used the reserved slot.
    expect(order.filter(o => o.startsWith("n-")).length).toBeLessThanOrEqual(2);
    await Promise.all([...normals, critical]);
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

  it("times out a request that never gets admitted so its worker can requeue (no deadlock)", async () => {
    // One concurrency slot, held forever by a CRITICAL request. A NORMAL request
    // behind it can never be admitted; instead of hanging its worker forever it must
    // give up after admissionMaxWaitMs and reject (the scan worker then requeues).
    const c = new DistributedProviderCoordinator<{ value: number }>({
      maxConcurrency: 1, maxRequestsPerMinute: 1000, resultCacheTtlMs: 0, rateWindowMs: 100, pollMs: 5,
      admissionMaxWaitMs: 120, agingRatePerSec: 0, // aging off so it truly can't be admitted
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = c.execute("hold", "new_build", async () => { await gate; return { value: 1 }; }, codec);
    await new Promise(r => setTimeout(r, 20)); // holder becomes active
    await expect(
      c.execute("blocked", "city", async () => ({ value: 2 }), codec),
    ).rejects.toThrow(/admission not granted/i);
    // The timed-out request must not leave a stuck 'queued' row that blocks the head.
    const stuckQueued = rawDb.prepare(`SELECT COUNT(*) c FROM provider_admission_queue WHERE state='queued'`).get() as any;
    expect(stuckQueued.c).toBe(0);
    release();
    await holder;
  });

  it("ages a starved NORMAL item into the CRITICAL band so a sustained flood can't starve it forever", async () => {
    // One slot + one rate/window. A steady stream of CRITICAL work would ordinarily
    // keep a lone NORMAL item queued indefinitely. Aging must lift it to the cutoff
    // within a bounded time so it eventually runs. Fast aging keeps the test quick.
    const c = new DistributedProviderCoordinator<{ value: number }>({
      maxConcurrency: 2, maxRequestsPerMinute: 1000, resultCacheTtlMs: 0, rateWindowMs: 50, pollMs: 4,
      admissionMaxWaitMs: 5_000, agingRatePerSec: 400, agingMaxBoost: 200, // NORMAL 275 → 380 in ~0.26s
    });
    const done: string[] = [];
    let stop = false;
    // Flood: keep a CRITICAL request in flight continuously.
    const flood = (async () => {
      let i = 0;
      while (!stop) {
        await c.execute(`flood-${i++}`, "new_build", async () => { done.push("C"); return { value: 0 }; }, codec)
          .catch(() => {});
      }
    })();
    // The lone NORMAL request must complete despite the flood (aging saves it).
    const normal = await c.execute("normal", "city", async () => { done.push("N"); return { value: 1 }; }, codec);
    stop = true;
    await flood;
    expect(normal).toEqual({ value: 1 });
    expect(done).toContain("N"); // it ran — never starved
  });
});
