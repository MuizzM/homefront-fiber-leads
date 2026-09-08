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
  it("retains fresh active ownership past task age and fences a lost lease before later transport", async () => {
    const a = new DistributedProviderCoordinator<{ value: number }>({ maxConcurrency: 1, maxRequestsPerMinute: 100, resultCacheTtlMs: 0 });
    const b = new DistributedProviderCoordinator<{ value: number }>({ maxConcurrency: 1, maxRequestsPerMinute: 100, admissionMaxWaitMs: 100, resultCacheTtlMs: 0 });
    let release!: () => void, ready!: () => void, check!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    const first = a.execute("long-but-owned", "manual", async ownership => { check = ownership.assertActive; ready(); await gate; return { value: 1 }; }, codec);
    await entered;
    rawDb.prepare("UPDATE provider_admission_queue SET started_at=? WHERE dedupe_key='long-but-owned'").run(Date.now() - 600_000);
    expect(a.snapshot().active).toBe(1);
    const second = vi.fn(async () => ({ value: 2 }));
    try {
      await expect(b.execute("must-wait", "manual", second, codec)).rejects.toThrow(/admission/);
      expect(second).not.toHaveBeenCalled(); check();
      rawDb.prepare("UPDATE provider_admission_queue SET state='expired' WHERE dedupe_key='long-but-owned'").run();
      expect(check).toThrow(/admission/);
    } finally { release(); await first; }
  });
  it("bounds address-lock admission wait and never executes the second task", async () => {
    const a = new DistributedProviderCoordinator<{ value: number }>({ maxConcurrency: 2, maxRequestsPerMinute: 100, resultCacheTtlMs: 0 });
    const b = new DistributedProviderCoordinator<{ value: number }>({ maxConcurrency: 2, maxRequestsPerMinute: 100, resultCacheTtlMs: 0, admissionMaxWaitMs: 100 });
    let release!: () => void, entered!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = a.execute("contended-address", "manual", async () => { entered(); await gate; return { value: 1 }; }, codec);
    await running;
    const task = vi.fn(async () => ({ value: 2 })); const started = performance.now();
    try { await expect(b.execute("contended-address", "manual", task, codec)).rejects.toThrow(/admission/i); }
    finally { release(); await first; }
    expect(performance.now() - started).toBeLessThan(400);
    expect(task).not.toHaveBeenCalled();
    expect(rawDb.prepare("SELECT COUNT(*) n FROM provider_address_locks").get()).toEqual({ n: 0 });
  });
  it("fails closed on an uncertain cancellation read before admission", async () => {
    const coordinator = new DistributedProviderCoordinator<{ value: number }>({ maxConcurrency: 2, maxRequestsPerMinute: 100 });
    const task = vi.fn(async () => ({ value: 2 }));
    await expect(coordinator.execute("abort-read-failure", "manual", task, { ...codec, abort: () => { throw new Error("database unavailable"); } })).rejects.toThrow(/admission/i);
    expect(task).not.toHaveBeenCalled();
    expect(rawDb.prepare("SELECT COUNT(*) n FROM provider_address_locks").get()).toEqual({ n: 0 });
  });
  it("releases its address lock if queue insertion fails", async () => {
    const coordinator = new DistributedProviderCoordinator<{ value: number }>({ maxConcurrency: 2, maxRequestsPerMinute: 100 });
    const task = vi.fn(async () => ({ value: 2 }));
    rawDb.exec("CREATE TEMP TRIGGER fixture_admission_fault BEFORE INSERT ON provider_admission_queue BEGIN SELECT RAISE(ABORT,'fixture admission fault'); END");
    try { await expect(coordinator.execute("queue-failure", "manual", task, codec)).rejects.toThrow("fixture admission fault"); }
    finally { rawDb.exec("DROP TRIGGER fixture_admission_fault"); }
    expect(task).not.toHaveBeenCalled(); expect(rawDb.prepare("SELECT COUNT(*) n FROM provider_address_locks").get()).toEqual({ n: 0 });
  });
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

  it("R13: a continuous lead-expansion flood cannot starve a normal 42-address scan (weighted-fair share cap)", async () => {
    // The real incident shape: lead-cluster expansion outranks the bulk sweep
    // (expansion=365 > city=200) and, if uncapped, holds every concurrency slot
    // forever — permanently starving a normal 42-address scan. With aging OFF (so
    // nothing else rescues the scan) the ONLY thing that lets the 42 finish is the
    // per-source share cap: expansion may hold at most floor(maxConcurrency*frac)
    // slots, leaving the rest for everyone else. Without the cap this test times out.
    const MAXC = 4, FRAC = 0.5, EXP_CAP = Math.floor(MAXC * FRAC); // 2
    const c = new DistributedProviderCoordinator<{ value: number }>({
      maxConcurrency: MAXC, maxRequestsPerMinute: 100_000, resultCacheTtlMs: 0,
      rateWindowMs: 50, pollMs: 4,
      expansionShareFraction: FRAC,
      criticalReservedConcurrency: 0, criticalReservedRate: 0,
      admissionMaxWaitMs: 12_000, agingRatePerSec: 0, agingMaxBoost: 0, // aging OFF isolates the cap
    });
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
    let expActive = 0, expPeak = 0, expRan = 0, scanRan = 0;
    const run = (key: string, source: "expansion" | "city", ms: number) =>
      c.execute(key, source, async () => {
        if (source === "expansion") { expActive++; expRan++; expPeak = Math.max(expPeak, expActive); }
        else scanRan++;
        await sleep(ms);
        if (source === "expansion") expActive--;
        return { value: 1 };
      }, codec);

    // Continuous expansion flood: always keep MORE than maxConcurrency expansion
    // requests contending (bounded in-flight, so no event-loop meltdown), so an
    // uncapped coordinator would hand expansion every slot forever.
    let stop = false, floodId = 0, live = 0;
    const pending: Promise<unknown>[] = [];
    const flood = (async () => {
      while (!stop) {
        while (live < MAXC + 2 && !stop) {
          live++;
          pending.push(run(`exp-${floodId++}`, "expansion", 8).catch(() => {}).then(() => { live--; }));
        }
        await sleep(3);
      }
      await Promise.allSettled(pending);
    })();

    // The normal 42-address scan fired into the teeth of the flood.
    const scan = Promise.all(Array.from({ length: 42 }, (_, i) => run(`scan-${i}`, "city", 4)));
    const outcome = await Promise.race([scan.then(() => "OK"), sleep(12_000).then(() => "TIMEOUT")]);
    stop = true;
    await flood;

    expect(outcome).toBe("OK");            // all 42 completed despite the flood — not starved
    expect(scanRan).toBe(42);
    expect(expRan).toBeGreaterThan(0);     // expansion still made progress (fair, not frozen)
    expect(expPeak).toBeLessThanOrEqual(EXP_CAP); // expansion never exceeded its concurrency share
  }, 20_000);

  it("weighted-fair 5-class: an EXPANSION+MAINTENANCE flood can't starve DISCOVERY/IMMEDIATE/NEW_BUILD; every class gets capacity, capped classes stay bounded", async () => {
    // Models the production shape the spec calls out: a huge EXPANSION + MAINTENANCE
    // (statewide/stale) backlog running while a 42-address DISCOVERY scan + IMMEDIATE
    // (manual/Field-Map) + NEW_BUILD (Coming Soon) checks arrive. Revenue classes must
    // all complete, immediate must start promptly, each class must receive capacity,
    // and the capped classes must never exceed their share. (A continuous bounded flood
    // stands in for the 300k backlog — what matters is the admission pressure, not the
    // literal row count; a separate store test proves dedup at 300k scale.)
    const MAXC = 6;
    const EXP_CAP = Math.floor(MAXC * 0.34);   // 2
    const MAINT_CAP = Math.floor(MAXC * 0.5);  // 3  → revenue always keeps ≥ 6-2-3 = 1
    const c = new DistributedProviderCoordinator<{ value: number }>({
      maxConcurrency: MAXC, maxRequestsPerMinute: 100_000, resultCacheTtlMs: 0,
      rateWindowMs: 50, pollMs: 4,
      expansionShareFraction: 0.34, maintenanceShareFraction: 0.5,
      criticalReservedConcurrency: 0, criticalReservedRate: 0,
      admissionMaxWaitMs: 15_000, agingRatePerSec: 0, agingMaxBoost: 0,
    });
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
    const active: Record<string, number> = { expansion: 0, city: 0 };
    const peak: Record<string, number> = { expansion: 0, city: 0 };
    const ran: Record<string, number> = { manual: 0, coming_soon: 0, discovery: 0, expansion: 0, city: 0 };
    let firstImmediateAdmissions = -1, totalStarts = 0;
    const run = (key: string, source: "manual" | "coming_soon" | "discovery" | "expansion" | "city", ms: number) =>
      c.execute(key, source, async () => {
        totalStarts++;
        ran[source]++;
        if (source === "expansion" || source === "city") { active[source]++; peak[source] = Math.max(peak[source], active[source]); }
        if (source === "manual" && firstImmediateAdmissions < 0) firstImmediateAdmissions = totalStarts;
        await sleep(ms);
        if (source === "expansion" || source === "city") active[source]--;
        return { value: 1 };
      }, codec);

    // Continuous EXPANSION + MAINTENANCE flood (bounded in-flight).
    let stop = false, id = 0, liveExp = 0, liveMaint = 0;
    const pend: Promise<unknown>[] = [];
    const flood = (async () => {
      while (!stop) {
        while (liveExp < MAXC && !stop) { liveExp++; pend.push(run(`exp-${id++}`, "expansion", 8).catch(() => {}).then(() => { liveExp--; })); }
        while (liveMaint < MAXC && !stop) { liveMaint++; pend.push(run(`mnt-${id++}`, "city", 8).catch(() => {}).then(() => { liveMaint--; })); }
        await sleep(3);
      }
      await Promise.allSettled(pend);
    })();

    await sleep(30); // let the flood saturate first
    // Revenue work arrives into the teeth of the flood.
    const immediate = run("manual-0", "manual", 4);      // IMMEDIATE
    const newBuild = run("cs-0", "coming_soon", 4);       // NEW_BUILD
    const discovery = Promise.all(Array.from({ length: 42 }, (_, i) => run(`disc-${i}`, "discovery", 4)));
    const outcome = await Promise.race([
      Promise.all([immediate, newBuild, discovery]).then(() => "OK"),
      sleep(14_000).then(() => "TIMEOUT"),
    ]);
    stop = true;
    await flood;

    expect(outcome).toBe("OK");                  // revenue never starved by the flood
    expect(ran.discovery).toBe(42);              // all 42 discovery completed
    expect(ran.manual).toBe(1);                  // immediate ran
    expect(ran.coming_soon).toBe(1);             // new-build/Coming Soon ran
    expect(firstImmediateAdmissions).toBeGreaterThan(0);
    expect(peak.expansion).toBeLessThanOrEqual(EXP_CAP);    // EXPANSION bounded to its share
    expect(peak.city).toBeLessThanOrEqual(MAINT_CAP);       // MAINTENANCE bounded to its share
    expect(ran.expansion).toBeGreaterThan(0);    // capped classes still received capacity
    expect(ran.city).toBeGreaterThan(0);
  }, 25_000);

  // Regression for the 2026-07-19 cluster freeze: the old admit rule required the
  // exact queue HEAD to admit itself — a head row whose submitting process died (or
  // whose event loop was wedged) blocked every other worker forever (11/20 active,
  // 164 queued, checks → 0 observed live). Top-K self-admission must let a live
  // waiter admit past a dead higher-priority head.
  it("admits a live waiter past a dead submitter's higher-priority queued head row", async () => {
    const coordinator = new DistributedProviderCoordinator<{ value: number }>({
      maxConcurrency: 3, maxRequestsPerMinute: 1_000, resultCacheTtlMs: 0, rateWindowMs: 100,
    });
    // Simulate a DEAD submitter: a CRITICAL-priority row inserted straight into the
    // queue with no process polling it (exactly what a crashed/wedged worker leaves).
    rawDb.prepare(`INSERT INTO provider_admission_queue
      (id,dedupe_key,source,priority,instance_id,state,enqueued_at,updated_at)
      VALUES ('dead-head','dead-key','manual',500,'dead-instance','queued',?,?)`)
      .run(Date.now(), Date.now());
    // A live NORMAL-priority request must admit despite ranking BELOW the dead head.
    const outcome = await Promise.race([
      coordinator.execute("live-item", "city", async () => ({ value: 7 }), codec).then(() => "ADMITTED"),
      new Promise<string>((resolve) => setTimeout(() => resolve("DEADLOCKED"), 5_000)),
    ]);
    expect(outcome).toBe("ADMITTED");
    // The dead row is still queued (its 90s staleness window hasn't elapsed) — it
    // occupied a rank but no longer blocks the live queue behind it.
    const dead = rawDb.prepare(`SELECT state FROM provider_admission_queue WHERE id='dead-head'`).get() as any;
    expect(dead?.state).toBe("queued");
  }, 10_000);

  it("expires queued rows whose submitter heartbeat is lost, freeing their ranks", async () => {
    const coordinator = new DistributedProviderCoordinator<{ value: number }>({
      maxConcurrency: 2, maxRequestsPerMinute: 1_000, resultCacheTtlMs: 0, rateWindowMs: 100,
    });
    // A dead-submitter row whose updated_at is already far past the staleness window.
    const stale = Date.now() - 10 * 60_000;
    rawDb.prepare(`INSERT INTO provider_admission_queue
      (id,dedupe_key,source,priority,instance_id,state,enqueued_at,updated_at)
      VALUES ('stale-dead','stale-key','manual',500,'dead-instance','queued',?,?)`)
      .run(stale, stale);
    // Any admission pass runs cleanup(), which must expire the heartbeat-lost row.
    await coordinator.execute("cleanup-driver", "city", async () => ({ value: 1 }), codec);
    const row = rawDb.prepare(`SELECT state,last_error FROM provider_admission_queue WHERE id='stale-dead'`).get() as any;
    expect(row?.state).toBe("expired");
    expect(String(row?.last_error ?? "")).toContain("heartbeat lost");
  }, 10_000);
});
