import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolate the DB; stub the run dispatcher (tier selection is what we test).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hf-harvest-"));
vi.mock("../../server/scanService", () => ({ startTargetRun: vi.fn(() => ({ runId: "run_test", queued: 0, budget: 0 })) }));

let tierB: any, tierB2: any, tierC: any, tierD: any, tierC0: any, tierD1: any, tierE1: any, tierE2: any, streetKeyOf: any, rawDb: any;

beforeAll(async () => {
  ({ rawDb } = await import("../../server/db"));
  ({ tierB, tierB2, tierC, tierD, tierC0, tierD1, tierE1, tierE2, streetKeyOf } = await import("../../server/freshHarvest"));
  rawDb.exec(`
    DROP TABLE IF EXISTS leads;
    DROP TABLE IF EXISTS scan_targets;
    CREATE TABLE scan_targets (
      id INTEGER PRIMARY KEY, tenant_id INTEGER, address TEXT, city TEXT, state TEXT, zip TEXT,
      lat REAL, lng REAL, last_scanned_at TEXT, last_fiber_status TEXT, carrier TEXT DEFAULT 'kinetic'
    ,
      inconclusive_attempts INTEGER NOT NULL DEFAULT 0, last_inconclusive_at TEXT);
    CREATE TABLE leads (
      id INTEGER PRIMARY KEY, tenant_id INTEGER, address TEXT, city TEXT, state TEXT,
      lat REAL, lng REAL, lead_tag TEXT, created_at TEXT
    );
  `);
  const insT = rawDb.prepare("INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,last_scanned_at,last_fiber_status) VALUES (?,1,?,?,?,?,?,?,?,?)");
  // Scan ages are RELATIVE to now, matching how the engine reads them
  // (datetime('now') windows). Literal dates rot: "2026-07-11" was written as
  // "10 days stale" and aged across Tier D's 30-day line on 2026-08-10,
  // flipping a tier assertion a month after the ink dried.
  const sqlDaysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const insL = rawDb.prepare("INSERT INTO leads (tenant_id,address,city,state,lat,lng,lead_tag,created_at) VALUES (1,?,?,?,?,?,'fresh_fiber_confirmed',datetime('now'))");
  // Fresh lead in Hotville cell (35.00,-79.00), street "fiber st"
  insL.run("1 Fiber St","hotville","nc",35.001,-79.001);
  // Target 10: never scanned, SAME cell as the fresh lead → Tier B
  insT.run(10,"10 Neighbor Ln","hotville","nc","27501",35.002,-79.002,null,null);
  // Target 11: never scanned, Hotville but far cell → Tier C (hot city), not B
  insT.run(11,"11 Far Rd","hotville","nc","27501",35.5,-79.5,null,null);
  // Target 12: never scanned, cold city → below C
  insT.run(12,"12 Cold Ave","coldtown","nc","27501",34.0,-80.0,null,null);
  // Target 13: stale no_service → Tier D
  insT.run(13,"13 Old St","coldtown","nc","27501",34.1,-80.1,sqlDaysAgo(70),"no_service");
  // Target 14: never scanned, hotville far cell (coming-soon rechecks are the
  // watchlist engine's job now, not a harvest tier) → Tier C only
  insT.run(14,"14 Watch Dr","hotville","nc","27501",35.01,-79.01,null,null);
  // Target 15: never scanned, PRIORITY city (davidson) → Tier C0
  insT.run(15,"15 Davidson Rd","davidson","nc","28035",35.49,-80.84,null,null);
  // Target 16: COPPER in hotville, 10 days stale → Tier D1 (copper-flip watch)
  insT.run(16,"16 Copper Ct","hotville","nc","27501",35.01,-79.02,sqlDaysAgo(10),"copper");
  // Target 17: never scanned, SAME STREET as the fresh lead but far cell → Tier B2 only
  insT.run(17,"17 Fiber St","hotville","nc","27501",35.6,-79.6,null,null);
  // Target 18: street matches via canonical key only ("Street"→"St", unit stripped)
  insT.run(18,"18 Fiber Street Apt 2","hotville","nc","27501",35.7,-79.7,null,null);
  // Target 19: different street that merely CONTAINS the lead street's name
  insT.run(19,"19 Fiberview St","hotville","nc","27501",35.7,-79.71,null,null);

  // ── Empirical-Bayes cells (gemtown) ──
  // PROVEN cell (36.20,-78.20): 8 fresh leads over 20 scanned targets (~40%).
  // NOISY cell (36.10,-78.10): 1 fresh lead over 1 scanned target (naive 50%).
  // Naive hits/(1+scanned) ranks NOISY first; smoothing must rank PROVEN first.
  // P1 (id 20) gets the smaller id so the dedup-after-limit budget test below
  // keeps its Tier C expectations.
  insT.run(20,"20 Topaz Trl","gemtown","nc","27502",36.201,-78.201,null,null);  // P1: never-scanned probe, proven cell
  insT.run(21,"21 Topaz Trl","gemtown","nc","27502",36.101,-78.101,null,null);  // N1: never-scanned probe, noisy cell
  insL.run("30 Quartz Way","gemtown","nc",36.102,-78.102);                       // noisy cell: 1 hit
  insT.run(30,"30 Quartz Way","gemtown","nc","27502",36.102,-78.102,sqlDaysAgo(11),"new_fiber"); // noisy cell: 1 scan
  for (let i = 0; i < 8; i++)                                                    // proven cell: 8 hits
    insL.run(`${40+i} Quartz Way`,"gemtown","nc",36.202,-78.202);
  for (let i = 0; i < 20; i++)                                                   // proven cell: 20 scans
    insT.run(40+i,`${40+i} Quartz Way`,"gemtown","nc","27502",36.202,-78.202,sqlDaysAgo(11),"new_fiber");
  // Scanned mass elsewhere pulls the tenant-wide prior rate down (~3%), the
  // regime where smoothing must prefer evidence over small-sample luck.
  for (let i = 0; i < 300; i++)
    insT.run(1000+i,`${i} Filler Rd`,"coldtown","nc","27501",34.5,-80.5,sqlDaysAgo(11),"new_fiber");

  // ── Expansion markets (Tier E) + footprint ──
  // boomtown: officially announced build (verified_expanding) with no fresh
  // leads yet — the cold-start case. coldtown stays auto_scan_eligible so the
  // footprint gate keeps Tier D's stale negative (id 13) selectable.
  rawDb.exec(`
    DROP TABLE IF EXISTS state_fiber_markets;
    CREATE TABLE state_fiber_markets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT, city TEXT,
      auto_scan_eligible INTEGER DEFAULT 0, kinetic_status TEXT
    );
  `);
  rawDb.prepare("INSERT INTO state_fiber_markets (state,city,auto_scan_eligible,kinetic_status) VALUES ('NC','boomtown',1,'verified_expanding')").run();
  rawDb.prepare("INSERT INTO state_fiber_markets (state,city,auto_scan_eligible,kinetic_status) VALUES ('NC','coldtown',1,'verified_served')").run();
  insT.run(300,"300 Boom Blvd","boomtown","nc","28001",35.35,-80.2,null,null);                          // Tier E1: never scanned
  insT.run(301,"301 Boom Blvd","boomtown","nc","28001",35.35,-80.21,sqlDaysAgo(10),"no_service"); // Tier E2: 10d stale negative
  process.env.PRIORITY_CITIES = "davidson:nc";
});


describe("fresh harvest tiers", () => {
  it("Tier B picks never-scanned neighbors of fresh leads (cluster cells)", () => {
    const rows = tierB(1, 100).map((r: any) => r.id);
    expect(rows).toContain(10);  // same ~1.1km cell as the fresh lead
    expect(rows).not.toContain(11); // different cell
    expect(rows).not.toContain(12);
    expect(rows).not.toContain(17); // far cell — street match is Tier B2's job
  });
  it("Tier B ranks proven cells above lucky small-sample cells (EB smoothing)", () => {
    const rows = tierB(1, 100).map((r: any) => r.id);
    expect(rows).toContain(20);   // proven cell: 8 hits / 20 scans (~40%)
    expect(rows).toContain(21);   // noisy cell: 1 hit / 1 scan (naive 50%)
    // Naive hits/(1+scanned) would put the noisy cell first; the smoothed
    // rate shrinks its 1-of-1 toward the ~3% tenant-wide prior instead.
    expect(rows.indexOf(20)).toBeLessThan(rows.indexOf(21));
  });
  it("Tier B2 completes streets that have a fresh lead", () => {
    const rows = tierB2(1, 100).map((r: any) => r.id);
    expect(rows).toContain(17);       // "fiber st", hotville, never scanned
    expect(rows).toContain(18);       // "Fiber Street Apt 2" — canonical key match
    expect(rows).not.toContain(19);   // "Fiberview St" is a different street
    expect(rows).not.toContain(10);   // different street
    expect(rows).not.toContain(12);   // cold city
  });
  it("Tier C picks never-scanned in fresh-dense cities", () => {
    const rows = tierC(1, 100).map((r: any) => r.id);
    expect(rows).toContain(10);
    expect(rows).toContain(11);
    expect(rows).not.toContain(12); // coldtown has no fresh leads
  });
  it("Tier D picks only stale negative verdicts in footprint markets", () => {
    // The footprint gate is ACTIVE (boomtown/coldtown eligible); coldtown's
    // stale negative stays selectable, and boomtown's 10-day negative is
    // Tier E2's job (not yet 30 days stale).
    const rows = tierD(1, 100).map((r: any) => r.id);
    expect(rows).toEqual([13]);
  });
  it("Tier E1 scans never-scanned addresses in announced expansion markets (cold start)", () => {
    const rows = tierE1(1, 100).map((r: any) => r.id);
    expect(rows).toEqual([300]);      // boomtown, no leads yet — density tiers would skip it
    expect(rows).not.toContain(11);   // hotville is not an expansion market
    expect(rows).not.toContain(301);  // already scanned
  });
  it("Tier E2 rechecks stale negatives in expansion markets at the 7-day cadence", () => {
    const rows = tierE2(1, 100).map((r: any) => r.id);
    expect(rows).toEqual([301]);      // 10 days stale — far too fresh for Tier D's 30d
    expect(rows).not.toContain(13);   // coldtown is served, not expanding
    expect(rows).not.toContain(16);   // hotville copper is Tier D1's job
    expect(rows).not.toContain(300);  // never scanned → Tier E1
  });
  it("Tier C0 picks never-scanned in priority cities", () => {
    const rows = tierC0(1, 100).map((r: any) => r.id);
    expect(rows).toEqual([15]);
  });
  it("Tier D1 picks stale copper in fresh-dense cities (flip watch)", () => {
    const rows = tierD1(1, 100).map((r: any) => r.id);
    expect(rows).toEqual([16]);
  });
  it("budget top-down: B → B2 → E1 → C0 → C → E2 → D1 → D, no duplicates", async () => {
    // Shape to exactly 10 using the engine's own Eastern-time factor, so the
    // test tracks the real budget regardless of the hour it runs.
    const { budgetShapeFactor } = await import("../../server/harvestScheduler");
    const raw = 10 / budgetShapeFactor();
    const { runHarvestCycle } = await import("../../server/freshHarvest");
    const counts = runHarvestCycle(1, raw);
    expect(counts.b).toBe(3);   // 20 (proven), 10 (hotville), 21 (noisy)
    expect(counts.b2).toBe(2);  // 17, 18
    expect(counts.e1).toBe(1);  // 300 (boomtown cold start)
    expect(counts.c0).toBe(1);  // 15
    // Tier C's top-ranked rows (gemtown 20/21, hotville 10) were already taken
    // by Tier B, so C contributes nothing; the last slots go to E2, D1 and D.
    expect(counts.c).toBe(0);
    expect(counts.e2).toBe(1);  // 301 (expansion flip watch)
    expect(counts.d1).toBe(1);  // 16
    expect(counts.d).toBe(1);   // 13
  });
  it("streetKeyOf canonicalizes street identity", () => {
    expect(streetKeyOf("17 Fiber St")).toBe("FIBER ST");
    expect(streetKeyOf("22 Fiber Street")).toBe("FIBER ST");   // suffix synonym folds
    expect(streetKeyOf("Nard Ln")).toBe("NARD LN");            // no house number → keep full name
    expect(streetKeyOf("100 Oak Ridge Ct Apt 4")).toBe("OAK RIDGE CT");
    expect(streetKeyOf("300 Main St # 12")).toBe("MAIN ST");
    expect(streetKeyOf("123-A Bell Ridge Court")).toBe("BELL RIDGE CT"); // unit letter dropped
    expect(streetKeyOf("101 N Main St")).toBe("N MAIN ST");    // directional kept
    expect(streetKeyOf("456 5th Ave")).toBe("5TH AVE");
    expect(streetKeyOf("123 1/2 Main St")).toBe("MAIN ST");    // fraction dropped
    expect(streetKeyOf("123")).toBe("");
    expect(streetKeyOf("")).toBe("");
    expect(streetKeyOf(null)).toBe("");
  });
});

// ── Footprint gate: Tier D never re-burns proxy on non-Kinetic cities ─────────
describe("footprint gate (Tier D)", () => {
  let gate: any;
  beforeAll(async () => {
    gate = await import("../../server/footprintGate");
    // A stale no_service in a real footprint city (Salisbury) alongside the
    // existing stale negative in the non-footprint coldtown (id 13).
    rawDb.prepare("INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,last_scanned_at,last_fiber_status) VALUES (?,1,?,?,?,?,?,?,?,?)")
      .run(200,"200 Salisbury Rd","salisbury","nc","28144",35.67,-80.47,new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 19).replace("T", " "),"no_service");
    // Empty the footprint so the fail-open behavior is observable from scratch.
    rawDb.exec("DELETE FROM state_fiber_markets");
  });

  it("stays fail-open while no market is eligible (empty footprint)", () => {
    gate._resetFootprintGateForTests();
    expect(gate.footprintGateActive()).toBe(false);
    expect(gate.isFootprintCity("nc", "coldtown")).toBe(true);   // fail-open: everything passes
    const rows = tierD(1, 100).map((r: any) => r.id);
    expect(rows).toEqual(expect.arrayContaining([13, 200]));     // both stale negatives kept
  });

  it("once the footprint loads, Tier D drops stale negatives outside it", () => {
    rawDb.prepare("INSERT INTO state_fiber_markets (state,city,auto_scan_eligible) VALUES ('NC','Salisbury',1)").run();
    gate._resetFootprintGateForTests();
    expect(gate.footprintGateActive()).toBe(true);
    expect(gate.isFootprintCity("nc", "salisbury")).toBe(true);
    expect(gate.isFootprintCity("nc", "coldtown")).toBe(false);  // not a Kinetic market
    const rows = tierD(1, 100).map((r: any) => r.id);
    expect(rows).toEqual([200]);   // Salisbury kept, coldtown (id 13) no longer re-burned
  });

  it("matches catalog city names through the same normalization (hyphens/Mt/St)", () => {
    rawDb.prepare("INSERT INTO state_fiber_markets (state,city,auto_scan_eligible) VALUES ('NC','Winston-Salem',1)").run();
    rawDb.prepare("INSERT INTO state_fiber_markets (state,city,auto_scan_eligible) VALUES ('NC','Mount Pleasant',1)").run();
    gate._resetFootprintGateForTests();
    expect(gate.isFootprintCity("nc", "winston salem")).toBe(true);   // geocoder spelling
    expect(gate.isFootprintCity("NC", "Winston-Salem")).toBe(true);
    expect(gate.isFootprintCity("nc", "Mt Pleasant")).toBe(true);     // Mt → Mount
    expect(gate.isFootprintCity("nc", "raleigh")).toBe(false);
  });

  afterAll(() => {
    rawDb.exec("DROP TABLE IF EXISTS state_fiber_markets; DELETE FROM scan_targets WHERE id=200;");
    gate._resetFootprintGateForTests();
  });
});
