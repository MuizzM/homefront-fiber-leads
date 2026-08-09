import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The previous production failure shape: a large box discovers 324 addresses,
 * the provider starts failing after 34 checks (stale token / throttle), and the
 * old scanner stopped after one batch, stranding the rest as "Unresolved".
 *
 * Required behavior now: the failed address stays PENDING, the same address is
 * retried after a fresh token, and the run continues from its checkpoint until
 * ALL 324 are conclusively processed with balanced totals:
 *   discovered = checked + pending(0), verified = fresh + comingSoon + noService + other.
 */

let rawDb: import("better-sqlite3").Database;
let store: typeof import("../../server/scanIntelStore");
let engine: typeof import("../../server/scanEngine");
const TENANT = 1;
const TOTAL = 324;

// Deterministic per-address plan: every 9th address is NOSVC, every 7th COMING
// (billing Y), the rest NEW FIBER + billing N. Addresses 35..74 fail their
// FIRST attempt (the "failure after 34" wall), succeeding on retry.
function planFor(n: number): "nosvc" | "coming" | "fresh" {
  if (n % 9 === 0) return "nosvc";
  if (n % 7 === 0) return "coming";
  return "fresh";
}

const failedOnce = new Set<number>();
const attempts: number[] = [];

const replay: import("../../server/scanEngine").Checker = async (a) => {
  const n = Number(a.address.split(" ")[0]);
  attempts.push(n);
  if (n >= 35 && n < 75 && !failedOnce.has(n)) {
    // The wall: transient provider failure (equivalent to a stale-token 403 —
    // the live path invalidates + re-mints; here the seam returns blocked).
    failedOnce.add(n);
    return {
      result: {
        address: a.address, city: a.city, state: a.state, zip: a.zip,
        lat: 35.4, lng: -80.9, fiberStatus: "unknown", fiberAvailable: false,
        isNewFiber: false, billingStatus: null, householdSegmentType: null,
        apiSource: "failed", blocked: true, confidence: "LOW",
        notes: "provider throttle - token refreshed, retry",
      } as any,
      bytes: 12_000,
      checkFailed: true,
    };
  }
  const plan = planFor(n);
  const base: any = {
    address: a.address, city: a.city, state: a.state, zip: a.zip,
    lat: 35.4 + n * 1e-5, lng: -80.9 - n * 1e-5,
    apiSource: "kinetic_live", blocked: false, confidence: "HIGH", notes: "",
    techType: "FIBER", maxDownloadMbps: 2000,
  };
  if (plan === "nosvc") return { result: { ...base, fiberStatus: "no_service", fiberAvailable: false, isNewFiber: false, billingStatus: null, householdSegmentType: null, rawResponse: { success: false, validationResult: "AddressNotFound" } }, bytes: 12_000, checkFailed: false };
  if (plan === "coming") return { result: { ...base, fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true, billingStatus: "Y", householdSegmentType: "NEW FIBER", rawResponse: { success: true, address: { householdSegmentType: "NEW FIBER", billingStatus: "Y" } } }, bytes: 12_000, checkFailed: false };
  return { result: { ...base, fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true, billingStatus: "N", householdSegmentType: "NEW FIBER", rawResponse: { success: true, address: { householdSegmentType: "NEW FIBER", billingStatus: "N" } } }, bytes: 12_000, checkFailed: false };
};

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-324-"));
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  store = await import("../../server/scanIntelStore");
  engine = await import("../../server/scanEngine");
  const seed = rawDb.prepare(
    `INSERT INTO scan_targets (address, city, state, zip, lat, lng, source) VALUES (?,?,?,?,?,?,'test')`,
  );
  for (let n = 1; n <= TOTAL; n++) seed.run(`${n} Wall St`, "Bigbox", "NC", "28100", 35.4 + n * 1e-5, -80.9 - n * 1e-5);
});

describe("324-address box: failure wall after 34 → retry same addresses → all processed", () => {
  it("processes all 324 with balanced totals and zero finalized failures", async () => {
    const targets = rawDb
      .prepare(`SELECT id FROM scan_targets WHERE city='Bigbox' ORDER BY id`)
      .all() as Array<{ id: number }>;
    expect(targets.length).toBe(TOTAL);
    const runId = "run_wall_324";
    store.createScanRun({
      id: runId, tenantId: TENANT, kind: "address_discovery",
      label: "324 wall", city: "Bigbox", state: "NC", budget: TOTAL,
    });
    store.enqueueRunTargets(runId, targets.map((t, seq) => ({ id: t.id, seq })));

    await engine.runScanWorker(runId, TENANT, replay);

    const run = store.getRun(runId, TENANT)!;
    // Every discovered address conclusively processed — no stopping after one
    // batch, no stranded remainder, nothing finalized as failed.
    expect(run.status).toBe("done");
    expect(run.verified).toBe(TOTAL);
    expect(run.failed).toBe(0);

    // The wall really happened: 40 transient failures, each address retried —
    // total attempts = 324 successes + 40 failed first tries.
    expect(failedOnce.size).toBe(40);
    expect(attempts.length).toBe(TOTAL + 40);
    // Every failed address was retried (appears at least twice in attempts).
    const counts = new Map<number, number>();
    for (const n of attempts) counts.set(n, (counts.get(n) ?? 0) + 1);
    for (const n of failedOnce) expect(counts.get(n)!).toBeGreaterThanOrEqual(2);

    // Balanced totals: discovered = checked + pending(0); classification sums.
    const states = rawDb
      .prepare(`SELECT state, COUNT(*) AS n FROM scan_run_targets WHERE run_id=? GROUP BY state`)
      .all(runId) as Array<{ state: string; n: number }>;
    expect(Object.fromEntries(states.map((s) => [s.state, s.n]))).toEqual({ verified: TOTAL });
    const results = rawDb
      .prepare(`SELECT result, COUNT(*) AS n FROM scan_run_targets WHERE run_id=? GROUP BY result`)
      .all(runId) as Array<{ result: string; n: number }>;
    const byResult = Object.fromEntries(results.map((r) => [r.result, r.n]));
    const expectedNoSvc = Math.floor(TOTAL / 9);
    // Fresh = NEW FIBER + billing N only; coming-soon (billing Y) is 'other'.
    expect(byResult.no_service).toBe(expectedNoSvc);
    expect((byResult.new_fiber ?? 0) + (byResult.other ?? 0) + (byResult.no_service ?? 0)).toBe(TOTAL);
    expect(run.newFiber).toBe(byResult.new_fiber);

    // Every conclusive check wrote exactly one canonical snapshot; the 40
    // transient failures wrote none (retry history lives in fiber_job_failures).
    const snapshots = rawDb
      .prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN conclusive=1 THEN 1 ELSE 0 END) AS conclusive FROM availability_snapshots WHERE run_id=?`)
      .get(runId) as any;
    expect(snapshots).toEqual({ n: TOTAL, conclusive: TOTAL });
    const retries = rawDb
      .prepare(`SELECT COUNT(*) AS n FROM fiber_job_failures WHERE run_id=?`)
      .get(runId) as any;
    expect(retries.n).toBe(40);

    // Cost honesty: every attempt (including the 40 retried failures) accrued bytes.
    expect(run.estBytes).toBe((TOTAL + 40) * 12_000);
  }, 120_000);
});
