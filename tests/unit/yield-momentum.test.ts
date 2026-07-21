import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated fixture for the build-momentum score term: how ACTIVELY fiber is
// being lit in a cell right now (recency-weighted drop count), distinct from the
// cell hit-RATE. All probes share one city (city term cancels) and are
// never-scanned (so only cell/momentum differ), letting momentum orderings be
// asserted cleanly.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hf-momentum-"));
vi.mock("../../server/scanService", () => ({ startTargetRun: vi.fn(() => ({ runId: "run_test", queued: 0, budget: 0 })) }));

let rawDb: any, scoreDueTargets: any, resetFootprint: any;

beforeAll(async () => {
  ({ rawDb } = await import("../../server/db"));
  ({ scoreDueTargets } = await import("../../server/yieldEngine"));
  ({ _resetFootprintGateForTests: resetFootprint } = await import("../../server/footprintGate"));
  rawDb.exec(`
    DROP TABLE IF EXISTS leads;
    DROP TABLE IF EXISTS scan_targets;
    DROP TABLE IF EXISTS coming_soon_watchlist;
    DROP TABLE IF EXISTS state_fiber_markets;
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
    CREATE TABLE state_fiber_markets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT, city TEXT, auto_scan_eligible INTEGER DEFAULT 0, kinetic_status TEXT
    );
  `);
  let tid = 0;
  const probe = (lat: number, lng: number): number => {
    const id = ++tid;
    rawDb.prepare("INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,last_scanned_at,last_fiber_status) VALUES (?,1,?,?,?,'27501',?,?,NULL,NULL)")
      .run(id, `${id} Probe St`, "buildtown", "nc", lat, lng);
    return id;
  };
  const drops = (n: number, lat: number, lng: number, ageDays: number) => {
    for (let i = 0; i < n; i++)
      rawDb.prepare("INSERT INTO leads (tenant_id,address,city,state,lat,lng,lead_tag,created_at) VALUES (1,?,?,'nc',?,?,'fresh_fiber_confirmed',datetime('now',?))")
        .run(`${i} Drop Ave`, "buildtown", lat, lng, `-${ageDays} days`);
  };

  // Cell A: 2 drops TODAY. Cell B: 2 drops 14 days (2 half-lives) old. Equal count.
  (globalThis as any).A = probe(35.101, -80.101); drops(2, 35.10, -80.10, 0);
  (globalThis as any).B = probe(35.201, -80.201); drops(2, 35.20, -80.20, 14);
  // Cell C: 2 drops TODAY. Cell D: 3 drops 20 days old — MORE drops but stale.
  (globalThis as any).C = probe(35.301, -80.301); drops(2, 35.30, -80.30, 0);
  (globalThis as any).D = probe(35.401, -80.401); drops(3, 35.40, -80.40, 20);
  // Cell E: NO drops (never-scanned → still due, momentum 0).
  (globalThis as any).E = probe(35.501, -80.501);
  // Cell F: 4 drops TODAY — more recent drops than A.
  (globalThis as any).F = probe(35.601, -80.601); drops(4, 35.60, -80.60, 0);

  // Base-rate filler far away so p0 is realistic (not dominated by our drops);
  // scanned + not-due, so it never enters the result set.
  for (let i = 0; i < 100; i++)
    rawDb.prepare("INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,last_scanned_at,last_fiber_status) VALUES (?,1,?,'filltown','nc','27501',?,?,'2026-07-20 00:00:00','new_fiber')")
      .run(1000 + i, `${i} Fill Rd`, 34.0 + i * 0.001, -81.0);

  rawDb.prepare("INSERT INTO state_fiber_markets (state,city,auto_scan_eligible,kinetic_status) VALUES ('NC','buildtown',1,'verified_served')").run();
  rawDb.prepare("INSERT INTO state_fiber_markets (state,city,auto_scan_eligible,kinetic_status) VALUES ('NC','filltown',1,'verified_served')").run();
  resetFootprint();
});

const scoreOf = (rows: any[], id: number) => rows.find((r) => r.id === id)?.score;

describe("build momentum score term", () => {
  it("recency beats age at EQUAL drop count (A today > B two half-lives old)", () => {
    const rows = scoreDueTargets(1, 500);
    const A = (globalThis as any).A, B = (globalThis as any).B;
    expect(scoreOf(rows, A)).toBeGreaterThan(scoreOf(rows, B));
  });

  it("recency beats a HIGHER but older drop count (C: 2 today > D: 3 stale)", () => {
    // The decisive test: build-momentum is not just a drop count — 2 drops
    // lit today outrank 3 drops that finished three weeks ago, even though the
    // hit-rate term slightly favours D's higher count.
    const rows = scoreDueTargets(1, 500);
    const C = (globalThis as any).C, D = (globalThis as any).D;
    expect(scoreOf(rows, C)).toBeGreaterThan(scoreOf(rows, D));
  });

  it("count still matters at EQUAL recency (F: 4 today > A: 2 today)", () => {
    const rows = scoreDueTargets(1, 500);
    const F = (globalThis as any).F, A = (globalThis as any).A;
    expect(scoreOf(rows, F)).toBeGreaterThan(scoreOf(rows, A));
  });

  it("a cell with no recent drops carries zero momentum (A > E, both never-scanned same city)", () => {
    const rows = scoreDueTargets(1, 500);
    const A = (globalThis as any).A, E = (globalThis as any).E;
    expect(scoreOf(rows, E)).toBeTruthy();          // E is still due (never scanned)
    expect(scoreOf(rows, A)).toBeGreaterThan(scoreOf(rows, E));
  });

  it("momentum only reorders — it never changes which targets are due", () => {
    const rows = scoreDueTargets(1, 500).map((r: any) => r.id);
    // All six never-scanned probes are due regardless of momentum.
    for (const key of ["A", "B", "C", "D", "E", "F"]) expect(rows).toContain((globalThis as any)[key]);
  });
});
