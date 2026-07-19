import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// YIELD-FIRST CLAIM ORDER: the scanner claims a run's targets by yield, not raw
// enqueue order — never-scanned addresses before re-checks, and the AddressNeedsFix
// tail (high inconclusive_attempts) last — so the cluster's finite check budget goes
// to the highest-yield addresses first. A purely-fresh run must be unchanged (seq).

let rawDb: import("better-sqlite3").Database;
let store: typeof import("../../server/scanIntelStore");
const TENANT = 1;

const seed = (address: string, extra: Record<string, unknown> = {}) => {
  const cols = { address, city: "Yieldville", state: "NC", zip: "27000", lat: 35.5, lng: -79.2, source: "test", tenant_id: TENANT, ...extra };
  const names = Object.keys(cols).join(",");
  const marks = Object.keys(cols).map(() => "?").join(",");
  return Number(rawDb.prepare(`INSERT INTO scan_targets (${names}) VALUES (${marks})`).run(...Object.values(cols)).lastInsertRowid);
};

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-yield-"));
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  store = await import("../../server/scanIntelStore");
});

describe("yield-first claim order", () => {
  it("claims never-scanned before re-checks, and the needs-fix tail last", async () => {
    // Enqueue order (seq) deliberately puts the LOW-yield rows first:
    //   seq0 = re-checked, many needs-fix attempts (worst yield)
    //   seq1 = re-checked, few needs-fix attempts
    //   seq2 = never scanned (best yield) — should be claimed FIRST despite last seq
    const churner = seed("100 CHURN LN", { last_scanned_at: "2026-07-01 00:00:00", inconclusive_attempts: 5 });
    const lightRecheck = seed("200 LIGHT LN", { last_scanned_at: "2026-07-10 00:00:00", inconclusive_attempts: 1 });
    const fresh = seed("300 FRESH LN"); // last_scanned_at NULL, inconclusive_attempts 0

    const runId = "run_yield";
    store.createScanRun({ id: runId, tenantId: TENANT, kind: "city", label: "yield", city: "Yieldville", state: "NC", budget: 10 });
    store.enqueueRunTargets(runId, [
      { id: churner, seq: 0 }, { id: lightRecheck, seq: 1 }, { id: fresh, seq: 2 },
    ]);

    const claimed = store.claimRunTargets(runId, 3, 0);
    const order = claimed.map((c) => c.targetId);
    // Fresh first, then the lighter re-check, then the churner last.
    expect(order).toEqual([fresh, lightRecheck, churner]);
  });

  it("is byte-identical to seq order for a purely-fresh run", async () => {
    const ids = [10, 11, 12].map((n) => seed(`${n}0 NEW ST`)); // all never-scanned, 0 attempts
    const runId = "run_fresh";
    store.createScanRun({ id: runId, tenantId: TENANT, kind: "manual", label: "fresh", city: "Yieldville", state: "NC", budget: 10 });
    // Enqueue in a specific seq; a fresh run must preserve exactly that order.
    store.enqueueRunTargets(runId, ids.map((id, i) => ({ id, seq: i })));
    const claimed = store.claimRunTargets(runId, 3, 0);
    expect(claimed.map((c) => c.targetId)).toEqual(ids);
  });

  it("deprioritizes Frontier targets below Kinetic in a mixed run", async () => {
    // seq puts Frontier first; Kinetic must still be claimed ahead of it.
    const frontier = seed("400 FRONTIER AVE", { carrier: "frontier" });
    const kinetic = seed("500 KINETIC AVE", { carrier: "kinetic" });
    const runId = "run_mixed_carrier";
    store.createScanRun({ id: runId, tenantId: TENANT, kind: "city", label: "mixed", city: "Yieldville", state: "NC", budget: 10 });
    store.enqueueRunTargets(runId, [{ id: frontier, seq: 0 }, { id: kinetic, seq: 1 }]);
    const claimed = store.claimRunTargets(runId, 2, 0);
    expect(claimed.map((c) => c.targetId)).toEqual([kinetic, frontier]);
  });

  it("prioritizes known new-fiber and new-build sources among re-checks", async () => {
    // All re-checked (last_scanned_at set), same attempts; the new-fiber green and
    // the new-build-sourced address must sort ahead of a generic re-check.
    const generic = seed("600 GENERIC RD", { last_scanned_at: "2026-07-10 00:00:00", source: "overpass" });
    const newBuild = seed("700 NEWBUILD RD", { last_scanned_at: "2026-07-10 00:00:00", source: "new_build_radar" });
    const green = seed("800 GREEN RD", { last_scanned_at: "2026-07-10 00:00:00", last_fiber_status: "new_fiber", last_is_new_fiber: 1 });
    const runId = "run_recheck_value";
    store.createScanRun({ id: runId, tenantId: TENANT, kind: "recheck", label: "recheck", city: "Yieldville", state: "NC", budget: 10 });
    // seq deliberately worst-first: generic(0), newBuild(1), green(2).
    store.enqueueRunTargets(runId, [{ id: generic, seq: 0 }, { id: newBuild, seq: 1 }, { id: green, seq: 2 }]);
    const claimed = store.claimRunTargets(runId, 3, 0);
    expect(claimed.map((c) => c.targetId)).toEqual([green, newBuild, generic]);
  });
});
