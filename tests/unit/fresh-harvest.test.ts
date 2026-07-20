import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolate the DB; stub the run dispatcher (tier selection is what we test).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hf-harvest-"));
vi.mock("../../server/scanService", () => ({ startTargetRun: vi.fn(() => ({ runId: "run_test", queued: 0, budget: 0 })) }));

let tierA: any, tierB: any, tierC: any, tierD: any, tierC0: any, tierD1: any, rawDb: any;

beforeAll(async () => {
  ({ rawDb } = await import("../../server/db"));
  ({ tierA, tierB, tierC, tierD, tierC0, tierD1 } = await import("../../server/freshHarvest"));
  rawDb.exec(`
    DROP TABLE IF EXISTS leads;
    DROP TABLE IF EXISTS scan_targets;
    DROP TABLE IF EXISTS coming_soon_watchlist;
    CREATE TABLE scan_targets (
      id INTEGER PRIMARY KEY, tenant_id INTEGER, address TEXT, city TEXT, state TEXT, zip TEXT,
      lat REAL, lng REAL, last_scanned_at TEXT, last_fiber_status TEXT, carrier TEXT DEFAULT 'kinetic'
    );
    CREATE TABLE leads (
      id INTEGER PRIMARY KEY, tenant_id INTEGER, address TEXT, city TEXT, state TEXT,
      lat REAL, lng REAL, lead_tag TEXT, created_at TEXT
    );
    CREATE TABLE coming_soon_watchlist (
      id INTEGER PRIMARY KEY, tenant_id INTEGER, scan_target_id INTEGER, status TEXT DEFAULT 'active', last_checked_at INTEGER
    );
  `);
  const insT = rawDb.prepare("INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,last_scanned_at,last_fiber_status) VALUES (?,1,?,?,?,?,?,?,?,?)");
  const insL = rawDb.prepare("INSERT INTO leads (tenant_id,address,city,state,lat,lng,lead_tag,created_at) VALUES (1,?,?,?,?,?,'fresh_fiber_confirmed',datetime('now'))");
  // Fresh lead in Hotville cell (35.00,-79.00)
  insL.run("1 Fiber St","hotville","nc",35.001,-79.001);
  // Target 10: never scanned, SAME cell as the fresh lead → Tier B
  insT.run(10,"10 Neighbor Ln","hotville","nc","27501",35.002,-79.002,null,null);
  // Target 11: never scanned, Hotville but far cell → Tier C (hot city), not B
  insT.run(11,"11 Far Rd","hotville","nc","27501",35.5,-79.5,null,null);
  // Target 12: never scanned, cold city → below C
  insT.run(12,"12 Cold Ave","coldtown","nc","27501",34.0,-80.0,null,null);
  // Target 13: stale no_service → Tier D
  insT.run(13,"13 Old St","coldtown","nc","27501",34.1,-80.1,"2026-06-01 00:00:00","no_service");
  // Target 14: watchlist due → Tier A
  insT.run(14,"14 Watch Dr","hotville","nc","27501",35.01,-79.01,null,null);
  rawDb.prepare("INSERT INTO coming_soon_watchlist (tenant_id,scan_target_id,status,last_checked_at) VALUES (1,14,'active',?)").run(Date.now()-7*3600_000);
  // Target 15: never scanned, PRIORITY city (davidson) → Tier C0
  insT.run(15,"15 Davidson Rd","davidson","nc","28035",35.49,-80.84,null,null);
  // Target 16: COPPER in hotville, 10 days stale → Tier D1 (copper-flip watch)
  insT.run(16,"16 Copper Ct","hotville","nc","27501",35.01,-79.02,"2026-07-05 00:00:00","copper");
  process.env.PRIORITY_CITIES = "davidson:nc";
});

describe("fresh harvest tiers", () => {
  it("Tier A returns due coming-soon watchlist entries only", () => {
    const rows = tierA(1, 100).map((r: any) => r.id);
    expect(rows).toEqual([14]);
  });
  it("Tier B picks never-scanned neighbors of fresh leads (cluster cells)", () => {
    const rows = tierB(1, 100).map((r: any) => r.id);
    expect(rows).toContain(10);  // same ~1.1km cell as the fresh lead
    expect(rows).not.toContain(11); // different cell
    expect(rows).not.toContain(12);
  });
  it("Tier C picks never-scanned in fresh-dense cities", () => {
    const rows = tierC(1, 100).map((r: any) => r.id);
    expect(rows).toContain(10);
    expect(rows).toContain(11);
    expect(rows).not.toContain(12); // coldtown has no fresh leads
  });
  it("Tier D picks only stale negative verdicts", () => {
    const rows = tierD(1, 100).map((r: any) => r.id);
    expect(rows).toEqual([13]);
  });
  it("Tier C0 picks never-scanned in priority cities", () => {
    const rows = tierC0(1, 100).map((r: any) => r.id);
    expect(rows).toEqual([15]);
  });
  it("Tier D1 picks stale copper in fresh-dense cities (flip watch)", () => {
    const rows = tierD1(1, 100).map((r: any) => r.id);
    expect(rows).toEqual([16]);
  });
  it("budget top-down: A before B before C before D, no duplicates", async () => {
    const { runHarvestCycle } = await import("../../server/freshHarvest");
    const counts = runHarvestCycle(1, 3); // budget 3 → A + B + C0
    expect(counts.a).toBe(1);
    expect(counts.b).toBe(1);
    expect(counts.c0).toBe(1);
    expect(counts.c).toBe(0);
    expect(counts.d1).toBe(0);
    expect(counts.d).toBe(0);
  });
});
