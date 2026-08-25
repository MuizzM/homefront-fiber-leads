import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRequeueReason } from "@shared/scanRequeueReason";

/**
 * REQUEUE DIAGNOSABILITY.
 *
 * A requeue is the engine's only "try again", and it is invisible by
 * construction: the target flips back to 'queued', no counter moves, and the run
 * keeps reporting healthy. Two live runs on 2026-08-24 proved the cost -
 * run_1_mt7hy05z churned 31,777 requeues against 755 completions (42:1) and
 * run_1_mt7n0iyz logged 657 requeues with nothing verified - and neither could
 * be diagnosed from the database, because the only recorded discriminator was a
 * two-value `category`.
 *
 * The law under test: EVERY address.requeued event carries a machine-readable
 * reason from the closed vocabulary, plus the underlying HTTP status / error
 * where one exists, and bulk queue movements say why too.
 */

let rawDb: import("better-sqlite3").Database;
let store: typeof import("../../server/scanIntelStore");
let engine: typeof import("../../server/scanEngine");
let governor: typeof import("../../server/bandwidthGovernor");
const TENANT = 1;

type Checker = import("../../server/scanEngine").Checker;

const conclusive = (a: { address: string; city: string; state: string; zip: string }) => ({
  address: a.address, city: a.city, state: a.state, zip: a.zip,
  lat: 35.5, lng: -80.4,
  apiSource: "kinetic_live", fiberStatus: "no_service", isNewFiber: false, isTenured: false,
  fiberAvailable: false, billingStatus: null, householdSegmentType: null,
  confidence: "HIGH", blocked: false, notes: "Not serviceable: AddressUnserviceableOutOfTerritory",
  retryReason: null, httpStatus: null,
  leadTag: null, leadScore: 0,
  rawResponse: { success: false, validationResult: "AddressUnserviceableOutOfTerritory" },
});

/** Fails the FIRST attempt for each address with the given non-answer, then
 *  answers conclusively - so the run drains deterministically instead of
 *  requeueing forever (which is the real engine's correct behavior). */
function failOnce(nonAnswer: (a: any) => any): Checker {
  const seen = new Set<string>();
  return async (a) => {
    if (!seen.has(a.address)) {
      seen.add(a.address);
      const result = nonAnswer(a);
      return { result, bytes: 9000, checkFailed: result.apiSource === "failed" };
    }
    return { result: conclusive(a) as any, bytes: 12000, checkFailed: false };
  };
}

const seedTarget = (address: string) => Number(rawDb.prepare(
  `INSERT INTO scan_targets (address,city,state,zip,lat,lng,source) VALUES (?,?,?,?,?,?,'test')`,
).run(address, "Reasonville", "NC", "28100", 35.5, -80.4).lastInsertRowid);

function startRun(runId: string, targetIds: number[], budget = targetIds.length) {
  store.createScanRun({
    id: runId, tenantId: TENANT, kind: "city-sweep", label: "requeue reasons",
    city: "Reasonville", state: "NC", budget,
  });
  store.enqueueRunTargets(runId, targetIds.map((id, seq) => ({ id, seq })));
}

const requeueEvents = (runId: string) => (rawDb.prepare(
  `SELECT target_id AS targetId, payload_json AS payloadJson FROM fiber_job_events
     WHERE run_id=? AND event_type='address.requeued' ORDER BY sequence`,
).all(runId) as any[]).map((row) => ({ targetId: row.targetId, payload: JSON.parse(row.payloadJson) }));

const runEvents = (runId: string, eventType: string) => (rawDb.prepare(
  `SELECT payload_json AS payloadJson FROM fiber_job_events
     WHERE run_id=? AND event_type=? ORDER BY sequence`,
).all(runId, eventType) as any[]).map((row) => JSON.parse(row.payloadJson));

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-requeue-reason-"));
  // A blocked batch triggers the real 403-storm back-off (15s by default). Keep
  // it, but make it instant: the behavior under test is the recorded reason, not
  // the sleep. Read at module load, so this must precede the engine import.
  process.env.PROVIDER_BLOCK_BACKOFF_MS = "1";
  process.env.SCAN_BREAKER_WAIT_MS = "50"; // poll fast while the circuit is open
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  store = await import("../../server/scanIntelStore");
  engine = await import("../../server/scanEngine");
  governor = await import("../../server/bandwidthGovernor");
});

describe("a requeue records why", () => {
  it("stamps the provider's typed reason and HTTP status into payload_json", async () => {
    const targetId = seedTarget("100 Denied Way");
    const runId = "run_reason_auth";
    startRun(runId, [targetId]);

    // Exactly what scanner.ts returns on an upstream 403: blocked, token
    // invalidated, session rotated, address requeued.
    await engine.runScanWorker(runId, TENANT, failOnce((a) => ({
      ...conclusive(a),
      apiSource: "failed", fiberStatus: "unknown", confidence: "LOW",
      blocked: true, retryReason: "auth_denied", httpStatus: 403,
      notes: "Upstream 403 (token/session) - token invalidated, Decodo session rotated, address requeued",
      rawResponse: undefined,
    })));

    const events = requeueEvents(runId);
    expect(events).toHaveLength(1);
    expect(events[0].targetId).toBe(targetId);
    expect(events[0].payload).toMatchObject({
      reason: "auth_denied",
      httpStatus: 403,
      category: "provider_blocked", // the coarse bucket is preserved, not replaced
      attempt: 1,
      applied: true, // the requeue really did flip an inflight row
    });
    expect(events[0].payload.detail).toContain("403");

    // And the run still drained on the retry: diagnostics changed nothing about
    // the retry contract itself.
    expect(store.getRun(runId, TENANT)).toMatchObject({ status: "done", verified: 1 });
  });

  it("separates a saturated coordinator from a crashed worker", async () => {
    const targetId = seedTarget("200 Thrown St");
    const runId = "run_reason_exception";
    startRun(runId, [targetId]);

    let thrown = false;
    await engine.runScanWorker(runId, TENANT, async (a) => {
      if (!thrown) { thrown = true; throw new Error("persistence exploded mid-write"); }
      return { result: conclusive(a) as any, bytes: 12000, checkFailed: false };
    });

    const events = requeueEvents(runId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      reason: "worker_exception",
      category: "provider_exception",
      httpStatus: null,
    });
    // The underlying error text is what turns "657 requeues" into a diagnosis.
    expect(events[0].payload.detail).toContain("persistence exploded mid-write");
  });

  it("names a needs-fix non-answer even from a checker that stamps nothing", async () => {
    const targetId = seedTarget("300 Ghost Ln");
    const runId = "run_reason_needsfix";
    startRun(runId, [targetId]);

    // No retryReason field at all - the shape every pre-existing injected
    // checker (and the Frontier path before it was stamped) produces.
    await engine.runScanWorker(runId, TENANT, async (a) => ({
      result: {
        address: a.address, city: a.city, state: a.state, zip: a.zip,
        apiSource: "failed", fiberStatus: "unknown", isNewFiber: false,
        fiberAvailable: null, billingStatus: null,
        notes: "Non-conclusive response (success=false, AddressNeedsFix)",
      } as any,
      bytes: 9000,
      checkFailed: true,
    }));

    const events = requeueEvents(runId);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      reason: "inconclusive_address_needs_fix",
      category: "inconclusive",
    });
    // The needs-fix lane is the ONLY one that backs off exponentially; the
    // recorded reason and the recorded delay must agree, or the log lies about
    // why the run is slow.
    expect(events[0].payload.delaySeconds).toBeGreaterThan(0);
    expect(rawDb.prepare(
      `SELECT state FROM scan_run_targets WHERE run_id=? AND target_id=?`,
    ).get(runId, targetId)).toMatchObject({ state: "queued" });
  });

  it("says why a bulk reclaim moved targets, without one row per address", () => {
    const ids = [seedTarget("401 Orphan Ct"), seedTarget("403 Orphan Ct"), seedTarget("405 Orphan Ct")];
    const runId = "run_reason_reclaim";
    startRun(runId, ids);
    rawDb.prepare(`UPDATE scan_run_targets SET state='inflight' WHERE run_id=?`).run(runId);

    expect(store.resetInflightTargets(runId, { tenantId: TENANT, reason: "operator_reset" })).toBe(3);

    const bulk = runEvents(runId, "run.targets_requeued");
    expect(bulk).toHaveLength(1); // ONE event for three targets, not three
    expect(bulk[0]).toMatchObject({ reason: "operator_reset", targets: 3 });
    expect(requeueEvents(runId)).toHaveLength(0); // no per-address flood

    // A reclaim that moved nothing stays silent, so a quiet reaper tick that
    // runs every 60s over every resumable run cannot flood the log.
    expect(store.resetInflightTargets(runId, { tenantId: TENANT, reason: "crash_orphan_reclaim" })).toBe(0);
    expect(runEvents(runId, "run.targets_requeued")).toHaveLength(1);
  });

  it("says why a tail was abandoned rather than retried", async () => {
    const ids = [seedTarget("500 Spent Ave"), seedTarget("502 Spent Ave")];
    const runId = "run_reason_budget";
    startRun(runId, ids, 1); // budget 1, two targets: the tail cannot be bought

    await engine.runScanWorker(runId, TENANT, failOnce(() => { throw new Error("unused"); }));

    const closed = runEvents(runId, "run.tail_terminalized");
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ reason: "budget", targets: 1 });
    expect(closed[0].detail).toContain("budget exhausted");
  });

  it("says a run is parked behind the proxy breaker, not wedged", async () => {
    const targetId = seedTarget("600 Cooldown Cir");
    const runId = "run_reason_breaker";
    startRun(runId, [targetId]);

    // Trip the shared circuit the way production does - a burst of proxy
    // auth/limit denials - so the worker takes its real COOLDOWN yield path.
    try {
      for (let i = 0; i < 12; i++) governor.noteProxyAuthFailure();
      expect(governor.isProxyCircuitOpen()).toBe(true);

      const worker = engine.runScanWorker(runId, TENANT, failOnce(() => {
        throw new Error("the checker must never be reached while the circuit is open");
      }));
      const deadline = Date.now() + 5_000;
      for (;;) {
        if (runEvents(runId, "run.breaker_wait").length > 0) break;
        if (Date.now() > deadline) throw new Error("no run.breaker_wait event within 5s");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      rawDb.prepare(`UPDATE scan_runs SET status='cancelled' WHERE id=?`).run(runId);
      await worker;
    } finally {
      governor._resetCircuitForTests();
    }

    const stalls = runEvents(runId, "run.breaker_wait");
    expect(stalls[0]).toMatchObject({ reason: "breaker_open" });
    // Nothing was claimed, so nothing was requeued: the stall is legible as a
    // stall rather than as churn.
    expect(requeueEvents(runId)).toHaveLength(0);
    expect(rawDb.prepare(
      `SELECT state FROM scan_run_targets WHERE run_id=? AND target_id=?`,
    ).get(runId, targetId)).toMatchObject({ state: "queued" });
  });

  it("holds the invariant across every requeue this suite produced", () => {
    const all = rawDb.prepare(
      `SELECT run_id AS runId, event_type AS eventType, payload_json AS payloadJson
         FROM fiber_job_events
        WHERE event_type IN ('address.requeued','run.targets_requeued','run.tail_terminalized','run.breaker_wait')`,
    ).all() as any[];

    expect(all.length).toBeGreaterThan(0);
    for (const row of all) {
      const payload = JSON.parse(row.payloadJson);
      // Not merely "a reason field exists" - a reason from the CLOSED set, so
      // the operator's GROUP BY has no NULL bucket and no free-text tail.
      expect(
        isRequeueReason(payload.reason),
        `${row.runId} ${row.eventType} carried reason=${JSON.stringify(payload.reason)}`,
      ).toBe(true);
      expect(payload.reason).not.toBe("unknown"); // every producer here names itself
    }
  });
});
