import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Copper-Upgrade Sweep — footprint-gated: the daily non-fiber recheck budget
// must go to addresses Kinetic can actually flip. Out-of-footprint inventory
// (e.g. a 37k-address Frontier-territory harvest) used to dilute the batch and
// stretch the real copper towns far past their 7-day cadence.

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hf-copper-gate-"));
const startTargetRun = vi.fn(() => ({ runId: "run_test", queued: 0, budget: 0 }));
vi.mock("../../server/scanService", () => ({ startTargetRun: (...a: any[]) => (startTargetRun as any)(...a) }));

let rawDb: any, runCopperUpgradeSweep: any, resetFootprint: any;

beforeAll(async () => {
  ({ rawDb } = await import("../../server/db"));
  ({ runCopperUpgradeSweep } = await import("../../server/copperUpgradeSweep"));
  ({ _resetFootprintGateForTests: resetFootprint } = await import("../../server/footprintGate"));
  rawDb.exec(`
    DROP TABLE IF EXISTS scan_targets;
    DROP TABLE IF EXISTS state_fiber_markets;
    CREATE TABLE scan_targets (
      id INTEGER PRIMARY KEY, tenant_id INTEGER, address TEXT, city TEXT, state TEXT,
      last_scanned_at TEXT, last_fiber_status TEXT, last_is_new_fiber INTEGER,
      converted_to_lead_id INTEGER
    );
    CREATE TABLE state_fiber_markets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT, city TEXT,
      auto_scan_eligible INTEGER DEFAULT 0, kinetic_status TEXT
    );
  `);
  const T = (id: number, city: string, status: string) =>
    rawDb.prepare(`INSERT INTO scan_targets (id,tenant_id,address,city,state,last_scanned_at,last_fiber_status,last_is_new_fiber)
      VALUES (?,1,?,?, 'nc', datetime('now','-30 days'), ?, 0)`).run(id, `${id} Main St`, city, status);
  T(1, "rockwell", "copper");       // Kinetic footprint → must be swept
  T(2, "hillsborough", "copper");   // Frontier/AT&T territory → must NOT burn budget
  T(3, "concord", "no_service");    // footprint → swept
  rawDb.prepare("INSERT INTO state_fiber_markets (state,city,auto_scan_eligible,kinetic_status) VALUES ('NC','rockwell',1,'verified_served')").run();
  rawDb.prepare("INSERT INTO state_fiber_markets (state,city,auto_scan_eligible,kinetic_status) VALUES ('NC','concord',1,'verified_expanding')").run();
  resetFootprint();
});

describe("copper-upgrade sweep footprint gate", () => {
  it("sweeps only footprint cities - out-of-footprint copper never claims budget", () => {
    startTargetRun.mockClear();
    const { queued } = runCopperUpgradeSweep(1);
    expect(queued).toBe(2);
    const ids = startTargetRun.mock.calls.flatMap((c: any[]) => c[0].targetIds as number[]);
    expect(ids.sort()).toEqual([1, 3]);
    expect(ids).not.toContain(2); // Hillsborough-class dilution is gone
  });

  it("fails OPEN without the market table - bare replay DBs sweep everything as before", () => {
    rawDb.exec("DROP TABLE state_fiber_markets");
    resetFootprint();
    startTargetRun.mockClear();
    const { queued } = runCopperUpgradeSweep(1);
    expect(queued).toBe(3); // gate absent → no filtering
  });
});
