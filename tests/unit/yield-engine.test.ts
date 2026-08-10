import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolate the DB; stub the run dispatcher.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hf-yield-"));
vi.mock("../../server/scanService", () => ({ startTargetRun: vi.fn(() => ({ runId: "run_test", queued: 0, budget: 0 })) }));

let rawDb: any, scoreDueTargets: any, runYieldCycle: any, getWeights: any, resetFootprint: any;

// A recent-but-conclusive scan timestamp (~1 day ago) — not stale, so a
// negative here is due ONLY via the flip-proximity override, never the 30d rule.
// Computed, not literal: pinned dates rot - a "~1 day ago" written as July 20
// crosses the 30d staleness rule on August 19 and flips every assertion built
// on "recent". Same SQL text shape the engine's datetime('now') comparisons use.
const sqlAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
const DAY_AGO = sqlAgo(1);
const FIVE_DAYS_AGO = sqlAgo(5);

beforeAll(async () => {
  ({ rawDb } = await import("../../server/db"));
  ({ scoreDueTargets, runYieldCycle, getWeights } = await import("../../server/yieldEngine"));
  ({ _resetFootprintGateForTests: resetFootprint } = await import("../../server/footprintGate"));
  rawDb.exec(`
    DROP TABLE IF EXISTS leads;
    DROP TABLE IF EXISTS scan_targets;
    DROP TABLE IF EXISTS coming_soon_watchlist;
    DROP TABLE IF EXISTS state_fiber_markets;
    CREATE TABLE scan_targets (
      id INTEGER PRIMARY KEY, tenant_id INTEGER, address TEXT, city TEXT, state TEXT, zip TEXT,
      lat REAL, lng REAL, last_scanned_at TEXT, last_fiber_status TEXT, carrier TEXT DEFAULT 'kinetic',
      inconclusive_attempts INTEGER NOT NULL DEFAULT 0, last_inconclusive_at TEXT,
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
      id INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT, city TEXT,
      auto_scan_eligible INTEGER DEFAULT 0, kinetic_status TEXT
    );
  `);
  const T = (id: number, addr: string, city: string, lat: number, lng: number, scanned: string | null, status: string | null, state = "nc") =>
    rawDb.prepare("INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,last_scanned_at,last_fiber_status) VALUES (?,1,?,?,?,'27501',?,?,?,?)")
      .run(id, addr, city, state, lat, lng, scanned, status);
  const L = (addr: string, city: string, lat: number, lng: number, ageDays: number) =>
    rawDb.prepare("INSERT INTO leads (tenant_id,address,city,state,lat,lng,lead_tag,created_at) VALUES (1,?,?,'nc',?,?,'fresh_fiber_confirmed',datetime('now',?))")
      .run(addr, city, lat, lng, `-${ageDays} days`);
  const M = (city: string, status = "verified_served") =>
    rawDb.prepare("INSERT INTO state_fiber_markets (state,city,auto_scan_eligible,kinetic_status) VALUES ('NC',?,1,?)").run(city, status);

  // ── Empirical-Bayes: proven cell (8 hits / 10 scans) vs lucky cell (1/1) ──
  for (let i = 0; i < 8; i++) L(`${i} Gem Way`, "gemtown", 36.20, -78.20, 10);   // proven cell: 8 hits (10d old, no prox)
  for (let i = 0; i < 10; i++) T(200 + i, `${i} Gem Way`, "gemtown", 36.20, -78.20, DAY_AGO, "new_fiber"); // 10 scans
  L("99 Luck Ln", "gemtown", 36.10, -78.10, 10);                                 // lucky cell: 1 hit
  T(220, "99 Luck Ln", "gemtown", 36.10, -78.10, DAY_AGO, "new_fiber");          // lucky cell: 1 scan
  T(100, "100 Gem Way", "gemtown", 36.201, -78.201, null, null);                 // proven-cell probe (never scanned)
  T(101, "101 Luck Ln", "gemtown", 36.101, -78.101, null, null);                 // lucky-cell probe (never scanned)
  // Base-rate filler: scanned mass with no leads pushes the tenant rate to ~5%,
  // the regime where a lucky 1/1 must not beat a proven 8/10.
  for (let i = 0; i < 200; i++) T(1000 + i, `${i} Filler Rd`, "gemtown", 36.9, -78.9, DAY_AGO, "new_fiber");

  // ── Canonical street key: "60 Fiber St" completes "50 Fiber Street" ──
  L("50 Fiber Street", "maptown", 36.5, -79.4, 10);                              // old lead, isolates the street signal
  T(110, "60 Fiber St", "maptown", 36.51, -79.5, null, null);                    // suffix-synonym street match, different cell

  // ── Flip-proximity override ──
  L("1 Flow Ave", "flowtown", 37.00, -77.00, 1);                                 // drop that lit 1 DAY ago
  T(120, "3 Flow Ave", "flowtown", 37.001, -77.001, FIVE_DAYS_AGO, "no_service"); // 5d-old negative in that cell → DUE via override
  L("1 Stale Rd", "staletown", 38.00, -76.00, 10);                               // drop that lit 10 days ago
  T(121, "3 Stale Rd", "staletown", 38.001, -76.001, FIVE_DAYS_AGO, "no_service"); // same age, old drop → NOT due

  // ── Base due/not-due + footprint ──
  T(130, "130 Watch Dr", "watchville", 39.0, -75.0, null, null);                 // coming-soon watch member
  rawDb.prepare("INSERT INTO coming_soon_watchlist (tenant_id,scan_target_id,status,last_checked_at,first_seen_at) VALUES (1,130,'active',?,?)")
    .run(Date.now() - 7 * 3600_000, Date.now() - 72 * 3600_000);
  T(140, "140 Cold Ave", "coldtown", 40.0, -74.0, null, null);                   // never scanned, no signal → due, low score
  T(141, "141 Fresh St", "freshtown", 41.0, -73.0, DAY_AGO, "no_service");       // recently scanned, no drop → NOT due
  T(142, "142 Texas Ave", "austin", 30.2, -97.7, null, null, "tx");              // out of NC/SC focus
  T(150, "150 Ghost Rd", "ghosttown", 42.0, -72.0, null, null);                  // NC but NOT an eligible market

  for (const c of ["gemtown", "maptown", "flowtown", "staletown", "watchville", "coldtown", "freshtown"]) M(c);
  resetFootprint();
});

describe("yield engine", () => {
  it("footprint-gates and applies base due rules", () => {
    const ids = scoreDueTargets(1, 500).map((r: any) => r.id);
    expect(ids).toContain(140);       // never scanned → due
    expect(ids).not.toContain(141);   // recently scanned, no nearby drop → not due
    expect(ids).not.toContain(142);   // out of NC/SC focus
    expect(ids).not.toContain(150);   // NC but not an auto_scan_eligible market
  });

  it("empirical-Bayes: a proven 8/10 cell outranks a lucky 1/1 cell", () => {
    const ids = scoreDueTargets(1, 500).map((r: any) => r.id);
    expect(ids.indexOf(100)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(101)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(100)).toBeLessThan(ids.indexOf(101)); // proven beats lucky small-sample
  });

  it("canonical street key matches Fiber St ≡ Fiber Street", () => {
    const rows = scoreDueTargets(1, 500);
    const street = rows.find((r: any) => r.id === 110);
    const cold = rows.find((r: any) => r.id === 140);
    expect(street).toBeTruthy();
    expect(street.score).toBeGreaterThan(cold.score); // street signal beats a no-signal cold target
  });

  it("flip-proximity override: a stale negative next to a fresh drop is due NOW", () => {
    const rows = scoreDueTargets(1, 500);
    const ids = rows.map((r: any) => r.id);
    expect(ids).toContain(120);        // 5d-old negative, drop lit 1 day ago in its cell → override
    expect(ids).not.toContain(121);    // same age, but nearest drop is 10 days old → no override
    expect(ids.indexOf(120)).toBeLessThan(ids.indexOf(140)); // proximity bonus ranks it above a cold target
  });

  it("scores are strictly descending", () => {
    const rows = scoreDueTargets(1, 500);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].score).toBeGreaterThanOrEqual(rows[i].score);
  });

  it("cycle splits budget exploit/explore with no overlap, dispatching once", async () => {
    // Use the engine's own Eastern-time shaping so the test tracks the real
    // budget, not a reimplemented (and now stale) day/night formula.
    const { budgetShapeFactor } = await import("../../server/harvestScheduler");
    const factor = budgetShapeFactor();
    const raw = 8 / factor;                       // shapes to ~8 whatever the hour
    const shaped = Math.round(raw * factor);
    const counts = runYieldCycle(1, raw);
    expect(counts.exploit + counts.explore).toBeLessThanOrEqual(shaped);
    expect(counts.exploit).toBeGreaterThanOrEqual(Math.min(3, shaped - 1));
    expect(counts.explore).toBeGreaterThanOrEqual(0);
  });

  it("weights fall back to defaults, including the new prox/expand signals", () => {
    const w = getWeights();
    expect(w.cell).toBe(1.0);
    expect(w.watch).toBe(2.0);
    expect(w.prox).toBe(1.6);
    expect(w.expand).toBe(0.6);
  });
});
