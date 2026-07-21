import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolate the DB; stub the run dispatcher.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hf-cadence-"));
vi.mock("../../server/scanService", () => ({ startTargetRun: vi.fn(() => ({ runId: "r", queued: 0, budget: 0 })) }));

let rawDb: any, scoreDueTargets: any, resetFootprint: any;

const DAY = 86_400_000;
const NOW = Date.now();

beforeAll(async () => {
  ({ rawDb } = await import("../../server/db"));
  ({ scoreDueTargets } = await import("../../server/yieldEngine"));
  ({ _resetFootprintGateForTests: resetFootprint } = await import("../../server/footprintGate"));
  rawDb.exec(`
    DROP TABLE IF EXISTS leads;
    DROP TABLE IF EXISTS scan_targets;
    DROP TABLE IF EXISTS coming_soon_watchlist;
    DROP TABLE IF EXISTS state_fiber_markets;
    DROP TABLE IF EXISTS availability_snapshots;
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
    CREATE TABLE availability_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scan_target_id INTEGER, tenant_id INTEGER,
      conclusive INTEGER, fiber_available INTEGER, checked_at_epoch INTEGER
    );
  `);
  // No state_fiber_markets → footprint gate fails open (every eligible focus-state
  // row passes), so this suite isolates the ADAPTIVE CADENCE behaviour.
  const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString().replace("T", " ").slice(0, 19);
  const T = (id: number, lat: number, lng: number, scannedDaysAgo: number | null, status: string | null) =>
    rawDb.prepare("INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,last_scanned_at,last_fiber_status) VALUES (?,1,?,'town','nc','27501',?,?,?,?)")
      .run(id, `${id} Main St`, lat, lng, scannedDaysAgo == null ? null : daysAgo(scannedDaysAgo), status);
  const negStreak = (targetId: number, count: number) => {
    for (let i = 0; i < count; i++)
      rawDb.prepare("INSERT INTO availability_snapshots (scan_target_id,tenant_id,conclusive,fiber_available,checked_at_epoch) VALUES (?,1,1,0,?)")
        .run(targetId, NOW - (i + 1) * 10 * DAY);
  };

  // T1: fresh negative — 1 prior negative, last scanned 10 days ago.
  //   adaptive cadence (streak 1) = 7 days → 10d > 7d → DUE. Fixed 30d → not due.
  T(1, 35.0, -80.0, 10, "no_service"); negStreak(1, 1);
  // T2: chronic dead — 5 priors, last scanned 40 days ago.
  //   adaptive cadence (streak 5, capped) = 7×8 = 56 days → 40d < 56d → NOT due.
  //   Fixed 30d → due (a wasted scan: it will come back negative again).
  T(2, 35.5, -80.5, 40, "no_service"); negStreak(2, 5);
  // T3: chronic dead WITH a neighbour that just flipped → override resets cadence → DUE.
  T(3, 36.0, -79.0, 40, "no_service"); negStreak(3, 5);
  rawDb.prepare("INSERT INTO leads (tenant_id,address,city,state,lat,lng,lead_tag,created_at) VALUES (1,'1 Flip Ave','town','nc',36.0,-79.0,'fresh_fiber_confirmed',datetime('now','-1 days'))").run();
  // T4: chronic dead, scanned yesterday, no neighbour → NOT due.
  T(4, 37.0, -78.0, 1, "no_service"); negStreak(4, 5);
  resetFootprint();
});

const streakOf = (id: number) =>
  Number((rawDb.prepare("SELECT COUNT(*) n FROM availability_snapshots WHERE scan_target_id=? AND conclusive=1 AND fiber_available=0").get(id) as any).n);

describe("adaptive negative recheck cadence", () => {
  it("rechecks a FRESH negative faster than the old fixed 30-day cooldown", () => {
    const ids = scoreDueTargets(1, 100).map((r: any) => r.id);
    expect(ids).toContain(1); // 10d-old single negative is due at the 7-day base cadence
  });

  it("backs a CHRONIC-dead negative off well past 30 days (no wasted rescan)", () => {
    const ids = scoreDueTargets(1, 100).map((r: any) => r.id);
    expect(ids).not.toContain(2); // 40d old, streak 5 → 56-day cadence → not yet due
    expect(ids).not.toContain(4); // streak 5, scanned yesterday → nowhere near due
  });

  it("a neighbour flip resets a chronic-dead address to due immediately", () => {
    const ids = scoreDueTargets(1, 100).map((r: any) => r.id);
    expect(ids).toContain(3); // same 40d/streak-5 as T2, but a drop lit next door 1 day ago
  });

  it("wasted-scan proof: adaptive selects no chronic-dead rescans; fixed-30d would", () => {
    const adaptive = new Set(scoreDueTargets(1, 100).map((r: any) => r.id));
    // Reconstruct the OLD fixed policy (no_service due at 30d) on the same fixture.
    const fixedDue = (rawDb.prepare(
      `SELECT id FROM scan_targets
        WHERE tenant_id=1 AND COALESCE(last_fiber_status,'')='no_service'
          AND last_scanned_at < datetime('now','-30 days')`,
    ).all() as any[]).map((r) => r.id);

    // A "wasted" rescan = a chronic-dead address (streak ≥ 4) with no neighbour
    // flip. On this fixture the fixed policy burns one (T2); adaptive burns none.
    const wasted = (ids: number[] | Set<number>) =>
      [...(ids as any)].filter((id) => streakOf(id) >= 4 && id !== 3).length;

    expect(wasted(fixedDue)).toBe(1);   // fixed-30d rescans T2 (chronic dead)
    expect(wasted(adaptive)).toBe(0);   // adaptive defers it — 100% fewer wasted chronic rescans here
  });
});
