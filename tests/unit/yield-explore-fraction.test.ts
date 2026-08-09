import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// YIELD_EXPLORE_FRACTION is read at module load — set it BEFORE importing the
// engine. Proves the (formerly hardcoded 0.15) explore share is now tunable, so
// "reach further" coverage is a config knob.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hf-yef-"));
process.env.YIELD_EXPLORE_FRACTION = "0.5";
const startTargetRun = vi.fn(() => ({ runId: "r", queued: 0, budget: 0 }));
vi.mock("../../server/scanService", () => ({ startTargetRun: (...a: any[]) => (startTargetRun as any)(...a) }));

let rawDb: any, runYieldCycle: any, resetFootprint: any;

beforeAll(async () => {
  ({ rawDb } = await import("../../server/db"));
  ({ runYieldCycle } = await import("../../server/yieldEngine"));
  ({ _resetFootprintGateForTests: resetFootprint } = await import("../../server/footprintGate"));
  rawDb.exec(`
    DROP TABLE IF EXISTS leads; DROP TABLE IF EXISTS scan_targets;
    DROP TABLE IF EXISTS coming_soon_watchlist; DROP TABLE IF EXISTS state_fiber_markets;
    CREATE TABLE scan_targets (
      id INTEGER PRIMARY KEY, tenant_id INTEGER, address TEXT, city TEXT, state TEXT, zip TEXT,
      lat REAL, lng REAL, last_scanned_at TEXT, last_fiber_status TEXT, carrier TEXT DEFAULT 'kinetic',
      inconclusive_attempts INTEGER NOT NULL DEFAULT 0, last_inconclusive_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE leads (id INTEGER PRIMARY KEY, tenant_id INTEGER, address TEXT, city TEXT, state TEXT, lat REAL, lng REAL, lead_tag TEXT, created_at TEXT);
    CREATE TABLE coming_soon_watchlist (id INTEGER PRIMARY KEY, tenant_id INTEGER, scan_target_id INTEGER, status TEXT DEFAULT 'active', last_checked_at INTEGER, first_seen_at INTEGER);
    CREATE TABLE state_fiber_markets (id INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT, city TEXT, auto_scan_eligible INTEGER DEFAULT 0, kinetic_status TEXT);
  `);
  // 40 never-scanned footprint targets → pure explore inventory (no scored signal).
  for (let i = 0; i < 40; i++)
    rawDb.prepare("INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,last_scanned_at,last_fiber_status) VALUES (?,1,?,?,'nc','27501',?,?,NULL,NULL)")
      .run(i + 1, `${i} Reach Rd`, "reachville", 35.5 + i * 0.001, -80.5 - i * 0.001);
  rawDb.prepare("INSERT INTO state_fiber_markets (state,city,auto_scan_eligible,kinetic_status) VALUES ('NC','reachville',1,'verified_served')").run();
  resetFootprint();
});

describe("YIELD_EXPLORE_FRACTION - tunable coverage reach", () => {
  it("honors the env-set explore fraction (0.5 → half the cycle is discovery)", async () => {
    const { budgetShapeFactor } = await import("../../server/harvestScheduler");
    const raw = 20 / budgetShapeFactor(); // shapes to a 20-target budget
    const counts = runYieldCycle(1, raw);
    // With 0.5 explore and only never-scanned inventory, ~half go to explore.
    expect(counts.explore).toBeGreaterThanOrEqual(8); // ≈10, generous lower bound
    expect(counts.exploit + counts.explore).toBeGreaterThan(0);
  });
});
