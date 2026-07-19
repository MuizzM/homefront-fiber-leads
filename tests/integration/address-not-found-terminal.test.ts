import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// address_not_found terminal: persistent needs-fix non-answers (no adoptable
// suggestion) conclude as a DATA verdict after the attempt cap — never
// no-service — then park out of BULK claims for the quiet window.

let rawDb: import("better-sqlite3").Database;
let store: typeof import("../../server/scanIntelStore");
let engine: typeof import("../../server/scanEngine");
const TENANT = 1;

const needsFixChecker: import("../../server/scanEngine").Checker = async (a) => ({
  result: {
    address: a.address, city: a.city, state: a.state, zip: a.zip,
    apiSource: "failed", fiberStatus: "unknown", isNewFiber: false,
    fiberAvailable: null, billingStatus: null,
    notes: "Non-conclusive response (success=false, AddressNeedsFix)",
  } as any,
  bytes: 9000,
  checkFailed: true,
});

const seedTarget = (address: string, extra: Record<string, unknown> = {}) => {
  const cols = { address, city: "Testville", state: "NC", zip: "27000", lat: 35.5, lng: -79.2, source: "test", ...extra };
  const names = Object.keys(cols).join(",");
  const marks = Object.keys(cols).map(() => "?").join(",");
  return Number(rawDb.prepare(`INSERT INTO scan_targets (${names}) VALUES (${marks})`).run(...Object.values(cols)).lastInsertRowid);
};

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-anf-"));
  process.env.ADDRESS_NOT_FOUND_ATTEMPTS = "2"; // fast terminal for the test
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  store = await import("../../server/scanIntelStore");
  engine = await import("../../server/scanEngine");
});

describe("address_not_found terminal", () => {
  it("concludes a persistent needs-fix address after the attempt cap and drains the run", async () => {
    const targetId = seedTarget("999 GHOST LN");
    const runId = "run_anf_terminal";
    store.createScanRun({ id: runId, tenantId: TENANT, kind: "city-sweep", label: "ANF", city: "Testville", state: "NC", budget: 10 });
    store.enqueueRunTargets(runId, [{ id: targetId, seq: 0 }]);

    // Attempt 1: needs-fix → requeued with backoff (not terminal, not lost).
    await engine.runScanWorker(runId, TENANT, needsFixChecker);
    let row = rawDb.prepare(`SELECT state, result, attempt_count FROM scan_run_targets WHERE run_id=? AND target_id=?`).get(runId, targetId) as any;
    expect(row.state).toBe("queued");
    expect(row.attempt_count).toBe(1);

    // Attempt 2 (== cap): terminal address_not_found; run counts it failed/unresolved.
    rawDb.prepare(`UPDATE scan_run_targets SET next_attempt_at=NULL WHERE run_id=?`).run(runId);
    rawDb.prepare(`UPDATE scan_runs SET status='running' WHERE id=?`).run(runId);
    await engine.runScanWorker(runId, TENANT, needsFixChecker);

    row = rawDb.prepare(`SELECT state, result FROM scan_run_targets WHERE run_id=? AND target_id=?`).get(runId, targetId) as any;
    expect(row.state).toBe("failed");
    expect(String(row.result)).toMatch(/^address_not_found:/);
    const run = rawDb.prepare(`SELECT status, failed FROM scan_runs WHERE id=?`).get(runId) as any;
    expect(run.status).toBe("done");
    expect(run.failed).toBe(1);
    // Never a serviceability verdict: no conclusive availability snapshot exists.
    expect((rawDb.prepare(`SELECT COUNT(*) c FROM availability_snapshots WHERE scan_target_id=?`).get(targetId) as any).c).toBe(0);
    // Target-level ledger advanced (address still has no conclusive answer).
    const t = rawDb.prepare(`SELECT inconclusive_attempts, last_inconclusive_at, last_scanned_at FROM scan_targets WHERE id=?`).get(targetId) as any;
    expect(t.last_scanned_at).toBeNull();
    expect(t.inconclusive_attempts).toBeGreaterThanOrEqual(2);
    expect(t.last_inconclusive_at).not.toBeNull();
  });

  it("parks exhausted addresses from BULK claims during the quiet window, but never from skipSec=0 kinds", () => {
    const parked = seedTarget("777 PARKED CT", { inconclusive_attempts: 3, last_inconclusive_at: rawDb.prepare("SELECT datetime('now') d").pluck().get() });
    const bulkRun = "run_anf_bulk";
    store.createScanRun({ id: bulkRun, tenantId: TENANT, kind: "city-sweep", label: "bulk", city: "Testville", state: "NC", budget: 10 });
    store.enqueueRunTargets(bulkRun, [{ id: parked, seq: 0 }]);
    expect(store.claimRunTargets(bulkRun, 10, 3600)).toHaveLength(0);
    const skipped = rawDb.prepare(`SELECT state, result FROM scan_run_targets WHERE run_id=? AND target_id=?`).get(bulkRun, parked) as any;
    expect(skipped.state).toBe("skipped");
    expect(String(skipped.result)).toMatch(/^parked: address_not_found/);

    // Manual/lasso/recheck (skipSec=0) always re-verify.
    const manualRun = "run_anf_manual";
    store.createScanRun({ id: manualRun, tenantId: TENANT, kind: "manual", label: "manual", city: "Testville", state: "NC", budget: 10 });
    store.enqueueRunTargets(manualRun, [{ id: parked, seq: 0 }]);
    expect(store.claimRunTargets(manualRun, 10, 0)).toHaveLength(1);
  });

  it("re-probes after the quiet window lapses", () => {
    const lapsed = seedTarget("555 LAPSED AVE", { inconclusive_attempts: 5, last_inconclusive_at: rawDb.prepare("SELECT datetime('now','-20 days') d").pluck().get() });
    const runId = "run_anf_lapsed";
    store.createScanRun({ id: runId, tenantId: TENANT, kind: "city-sweep", label: "lapsed", city: "Testville", state: "NC", budget: 10 });
    store.enqueueRunTargets(runId, [{ id: lapsed, seq: 0 }]);
    expect(store.claimRunTargets(runId, 10, 3600)).toHaveLength(1);
  });

  it("backfills the already-exhausted needs-fix tail without new checks", async () => {
    const t1 = seedTarget("111 TAIL RD");
    const t2 = seedTarget("113 TAIL RD");
    const fresh = seedTarget("115 FINE RD");
    const runId = "run_anf_backfill";
    store.createScanRun({ id: runId, tenantId: TENANT, kind: "city-sweep", label: "tail", city: "Testville", state: "NC", budget: 100 });
    store.enqueueRunTargets(runId, [{ id: t1, seq: 0 }, { id: t2, seq: 1 }, { id: fresh, seq: 2 }]);
    rawDb.prepare(`UPDATE scan_run_targets SET attempt_count=9, last_error_message='Non-conclusive response (success=false, AddressNeedsFix)' WHERE run_id=? AND target_id IN (?,?)`).run(runId, t1, t2);
    rawDb.prepare(`UPDATE scan_run_targets SET attempt_count=1, last_error_message='network timeout' WHERE run_id=? AND target_id=?`).run(runId, fresh);

    const res = await store.finalizeAddressNotFoundBacklog(6);
    expect(res.targets).toBe(2);
    expect(res.runs).toBe(1);
    const states = rawDb.prepare(`SELECT target_id, state, result FROM scan_run_targets WHERE run_id=? ORDER BY seq`).all(runId) as any[];
    expect(states[0].state).toBe("failed");
    expect(String(states[0].result)).toMatch(/^address_not_found: backfill/);
    expect(states[1].state).toBe("failed");
    expect(states[2].state).toBe("queued"); // ordinary transient untouched
    // Parked for the quiet window.
    const parked = rawDb.prepare(`SELECT inconclusive_attempts, last_inconclusive_at FROM scan_targets WHERE id=?`).get(t1) as any;
    expect(parked.inconclusive_attempts).toBeGreaterThanOrEqual(3);
    expect(parked.last_inconclusive_at).not.toBeNull();
    // Idempotent second pass.
    expect((await store.finalizeAddressNotFoundBacklog(6)).targets).toBe(0);
    // Run counters reflect the finalized tail.
    expect((rawDb.prepare(`SELECT failed FROM scan_runs WHERE id=?`).get(runId) as any).failed).toBe(2);
  });
});
