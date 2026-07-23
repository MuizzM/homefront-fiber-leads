import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The resource-pressure gate at the ONE admission choke point every scan check
// flows through. PAUSE admits only CRITICAL work (field/manual/new-build,
// priority ≥ 380); EMERGENCY admits nothing and refuses new enqueues; a STALE
// pressure row fails open (admits normally).

let rawDb: import("better-sqlite3").Database;
let rp: typeof import("../../server/resourcePressure");
let dpc: typeof import("../../server/distributedProviderCoordinator");

const codec = {
  cacheable: () => false,
  serialize: (v: { value: number }) => JSON.stringify(v),
  deserialize: (v: string) => JSON.parse(v) as { value: number },
};

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-pressure-adm-"));
  ({ rawDb } = await import("../../server/db"));
  rp = await import("../../server/resourcePressure");
  dpc = await import("../../server/distributedProviderCoordinator");
  dpc.ensureSchema();
});

beforeEach(() => {
  rawDb.exec(`DELETE FROM provider_rate_events; DELETE FROM provider_admission_queue;
    DELETE FROM provider_address_locks; DELETE FROM provider_shared_result_cache;
    UPDATE provider_global_control SET next_start_at=0 WHERE id=1;
    DELETE FROM resource_pressure;`);
});

function coordinator(admissionMaxWaitMs = 600) {
  return new dpc.DistributedProviderCoordinator<{ value: number }>({
    maxConcurrency: 4, maxRequestsPerMinute: 1000, resultCacheTtlMs: 0, rateWindowMs: 100,
    pollMs: 20, admissionMaxWaitMs,
  });
}

describe("resource-pressure admission gate", () => {
  it("PAUSE: critical (manual/field) work admits, bulk (market) work times out", async () => {
    rp.publishPressure("pause", 4000, 100, 7000, "test", Date.now());
    const c = coordinator();
    const critical = await c.execute("crit-1", "manual", async () => ({ value: 1 }), codec);
    expect(critical).toEqual({ value: 1 });
    await expect(
      c.execute("bulk-1", "market", async () => ({ value: 2 }), codec),
    ).rejects.toThrow(dpc.AdmissionTimeoutError);
  });

  it("EMERGENCY: nothing admits, not even critical", async () => {
    rp.publishPressure("emergency", 1000, 5000, 7000, "test", Date.now());
    const c = coordinator();
    await expect(
      c.execute("crit-2", "manual", async () => ({ value: 1 }), codec),
    ).rejects.toThrow(dpc.AdmissionTimeoutError);
  });

  it("a STALE pressure row fails open — bulk work admits normally", async () => {
    rp.publishPressure("emergency", 1000, 5000, 7000, "test", Date.now() - rp.PRESSURE_TTL_MS - 60_000);
    const c = coordinator();
    const result = await c.execute("bulk-2", "market", async () => ({ value: 3 }), codec);
    expect(result).toEqual({ value: 3 });
  });

  it("recovery: demoting to normal lets bulk work admit again", async () => {
    rp.publishPressure("pause", 4000, 100, 7000, "test", Date.now());
    const c = coordinator();
    await expect(c.execute("bulk-3", "market", async () => ({ value: 4 }), codec))
      .rejects.toThrow(dpc.AdmissionTimeoutError);
    rp.publishPressure("normal", 20_000, 10, 7000, "recovered", Date.now());
    const result = await c.execute("bulk-4", "market", async () => ({ value: 5 }), codec);
    expect(result).toEqual({ value: 5 });
  });

  it("THROTTLE: work still admits (ceilings halved, not zeroed)", async () => {
    rp.publishPressure("throttle", 6000, 100, 7000, "test", Date.now());
    const c = coordinator(3_000);
    const results = await Promise.all([
      c.execute("t-1", "market", async () => ({ value: 1 }), codec),
      c.execute("t-2", "manual", async () => ({ value: 2 }), codec),
    ]);
    expect(results.map(r => r.value).sort()).toEqual([1, 2]);
  });
});
