import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolate the DB; stub the run dispatcher.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hf-yield-"));
vi.mock("../../server/scanService", () => ({ startTargetRun: vi.fn(() => ({ runId: "run_test", queued: 0, budget: 0 })) }));

let rawDb: any, scoreDueTargets: any, runYieldCycle: any, getWeights: any;

beforeAll(async () => {
  ({ rawDb } = await import("../../server/db"));
  ({ scoreDueTargets, runYieldCycle, getWeights } = await import("../../server/yieldEngine"));
  rawDb.exec(`
    DROP TABLE IF EXISTS leads;
    DROP TABLE IF EXISTS scan_targets;
    DROP TABLE IF EXISTS coming_soon_watchlist;
    CREATE TABLE scan_targets (
      id INTEGER PRIMARY KEY, tenant_id INTEGER, address TEXT, city TEXT, state TEXT, zip TEXT,
      lat REAL, lng REAL, last_scanned_at TEXT, last_fiber_status TEXT, carrier TEXT DEFAULT 'kinetic',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE leads (
      id INTEGER PRIMARY KEY, tenant_id INTEGER, address TEXT, city TEXT, state TEXT,
      lat REAL, lng REAL, lead_tag TEXT, created_at TEXT
    );
    CREATE TABLE coming_soon_watchlist (
      id INTEGER PRIMARY KEY, tenant_id INTEGER, scan_target_id INTEGER, status TEXT DEFAULT 'active',
      last_checked_at INTEGER, first_seen_at INTEGER
    );
  `);
  const insT = rawDb.prepare("INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,last_scanned_at,last_fiber_status) VALUES (?,1,?,?,?,?,?,?,?,?)");
  const insL = rawDb.prepare("INSERT INTO leads (tenant_id,address,city,state,lat,lng,lead_tag,created_at) VALUES (1,?,?,?,?,?,'fresh_fiber_confirmed',datetime('now'))");
  // Fresh lead: "1 Fiber St", hotville, cell (35.00,-79.00)
  insL.run("1 Fiber St","hotville","nc",35.001,-79.001);
  insT.run(10,"10 Neighbor Ln","hotville","nc","27501",35.002,-79.002,null,null);  // same cell
  insT.run(11,"11 Far Rd","hotville","nc","27501",35.5,-79.5,null,null);          // same city only
  insT.run(12,"12 Cold Ave","coldtown","nc","27501",34.0,-80.0,null,null);        // nothing
  insT.run(14,"14 Watch Dr","hotville","nc","27501",35.01,-79.01,null,null);      // watchlist
  insT.run(17,"17 Fiber St","hotville","nc","27501",35.6,-79.6,null,null);        // same street
  insT.run(18,"18 Old St","coldtown","nc","27501",34.1,-80.1,"2026-06-01 00:00:00","no_service"); // stale negative
  insT.run(19,"19 Fresh St","raleigh","nc","27601",35.7,-78.6,"2026-07-20 00:00:00","no_service"); // NOT due (recent)
  insT.run(20,"20 Texas Ave","austin","tx","78701",30.2,-97.7,null,null);         // out of focus states
  rawDb.prepare("INSERT INTO coming_soon_watchlist (tenant_id,scan_target_id,status,last_checked_at,first_seen_at) VALUES (1,14,'active',?,?)")
    .run(Date.now()-7*3600_000, Date.now()-72*3600_000);
});

describe("yield engine", () => {
  it("scores watch > cell neighbor > street match > city-only > cold", () => {
    const rows = scoreDueTargets(1, 100);
    const order = rows.map((r: any) => r.id);
    const pos = (id: number) => order.indexOf(id);
    expect(pos(14)).toBeGreaterThanOrEqual(0);
    expect(pos(14)).toBeLessThan(pos(10));   // coming-soon beats cluster
    expect(pos(10)).toBeLessThan(pos(17));   // cell rate beats street-only
    expect(pos(17)).toBeLessThan(pos(11));   // street beats city-only
    expect(pos(11)).toBeLessThan(pos(12));   // city density beats cold
    expect(order).toContain(18);             // stale no_service is due
    expect(order).not.toContain(19);         // recently checked — not due
    expect(order).not.toContain(20);         // outside NC/SC focus
    // scores are actually descending
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].score).toBeGreaterThanOrEqual(rows[i].score);
  });

  it("cycle splits budget exploit/explore with no overlap, dispatching once", async () => {
    const h = new Date().getHours();
    const raw = h < 6 ? 3 : (h >= 9 && h < 17 ? 8 : 4);
    const shaped = h < 6 ? Math.round(raw * 1.5) : (h >= 9 && h < 17 ? Math.round(raw * 0.5) : raw);
    const counts = runYieldCycle(1, raw);
    expect(counts.exploit + counts.explore).toBeLessThanOrEqual(shaped);
    expect(counts.exploit).toBeGreaterThanOrEqual(Math.min(3, shaped - 1));
    expect(counts.explore).toBeGreaterThanOrEqual(0);
  });

  it("weights fall back to defaults when there is nothing to learn from", () => {
    const w = getWeights();
    expect(w.cell).toBe(1.0);
    expect(w.watch).toBe(2.0);
  });
});
