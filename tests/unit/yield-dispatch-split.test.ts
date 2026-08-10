import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// SPLIT DISPATCH — the yield engine must not ship change-detection targets as
// bulk 'fresh_harvest' (that runKind sits behind the 18h dedup window, which
// silently swallowed the 2h/12h coming-soon watch cadence and the 12h
// flip-proximity cooldown). Watch members go out under a dedup-exempt
// coming-soon kind; flip-proximity negatives under a dedup-exempt recheck kind;
// everything else stays bulk. Totals are unchanged — this is routing, not budget.

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hf-yield-split-"));
const startTargetRun = vi.fn(() => ({ runId: "run_test", queued: 0, budget: 0 }));
vi.mock("../../server/scanService", () => ({ startTargetRun: (...a: any[]) => (startTargetRun as any)(...a) }));

let rawDb: any, runYieldCycle: any, resetFootprint: any;

// Computed, not literal - see yield-engine.test.ts: pinned "days ago" rot
// across the engine's staleness windows as real time passes.
const FIVE_DAYS_AGO = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");

beforeAll(async () => {
  ({ rawDb } = await import("../../server/db"));
  ({ runYieldCycle } = await import("../../server/yieldEngine"));
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
  const T = (id: number, addr: string, city: string, lat: number, lng: number, scanned: string | null, status: string | null) =>
    rawDb.prepare("INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,last_scanned_at,last_fiber_status) VALUES (?,1,?,?,'nc','27501',?,?,?,?)")
      .run(id, addr, city, lat, lng, scanned, status);

  // WATCH: an active due coming-soon watchlist member.
  T(10, "10 Watch Dr", "watchville", 39.0, -75.0, null, null);
  rawDb.prepare("INSERT INTO coming_soon_watchlist (tenant_id,scan_target_id,status,last_checked_at,first_seen_at) VALUES (1,10,'active',?,?)")
    .run(Date.now() - 7 * 3600_000, Date.now() - 72 * 3600_000);
  // FLIP-PROX: a 5d-old negative whose cell got a fresh drop yesterday.
  rawDb.prepare("INSERT INTO leads (tenant_id,address,city,state,lat,lng,lead_tag,created_at) VALUES (1,'1 Flow Ave','flowtown','nc',37.00,-77.00,'fresh_fiber_confirmed',datetime('now','-1 days'))").run();
  T(20, "3 Flow Ave", "flowtown", 37.001, -77.001, FIVE_DAYS_AGO, "no_service");
  // BULK: a plain never-scanned cold target.
  T(30, "30 Cold Ave", "coldtown", 40.0, -74.0, null, null);
  for (const c of ["watchville", "flowtown", "coldtown"])
    rawDb.prepare("INSERT INTO state_fiber_markets (state,city,auto_scan_eligible,kinetic_status) VALUES ('NC',?,1,'verified_served')").run(c);
  resetFootprint();
});

describe("yield engine split dispatch", () => {
  it("routes watch → coming-soon kind, flip-prox → recheck kind, rest → bulk; no target in two runs", () => {
    startTargetRun.mockClear();
    const counts = runYieldCycle(1, 500);
    // The guaranteed discovery lane admits never-scanned fixtures first; the
    // routing below is what this test proves — total admitted must cover the
    // three seeded targets whichever lane carried them.
    expect(counts.exploit + (counts.discovery ?? 0)).toBeGreaterThanOrEqual(3);

    const calls = startTargetRun.mock.calls.map((c: any[]) => c[0]);
    const byKind = Object.fromEntries(calls.map((c: any) => [c.runKind, c.targetIds as number[]]));

    // Watch member ships dedup-exempt under the reserved coming-soon class.
    expect(byKind["coming_soon_watch_yield"]).toContain(10);
    // Flip-proximity negative ships dedup-exempt as a recheck.
    expect(byKind["fresh_flip_recheck"]).toContain(20);
    // The cold target stays bulk.
    expect(byKind["fresh_harvest"]).toContain(30);
    // Routing must be a partition — no id may ride in two runs.
    const all = calls.flatMap((c: any) => c.targetIds as number[]);
    expect(new Set(all).size).toBe(all.length);
    // Bulk never carries a change-detection target (that was the bug).
    expect(byKind["fresh_harvest"]).not.toContain(10);
    expect(byKind["fresh_harvest"]).not.toContain(20);
  });
});
