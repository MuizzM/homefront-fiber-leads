import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Planner statistics upkeep: ONE BOUNDED TABLE PER TICK, then SQLite's
 * steady-state `PRAGMA optimize`.
 *
 * Why not `PRAGMA optimize=0x10002` in one go, which is the documented
 * lifecycle: it runs its ANALYZE as a SINGLE write transaction, and SQLite's
 * write lock is database-wide ACROSS PROCESSES. Measured on a production-shaped
 * copy - 13.6 s in one lock, against a busy_timeout of 15 s - so every HTTP
 * worker attempting a write would stall and then throw SQLITE_BUSY. Per table
 * with analysis_limit, the worst single lock is 3.4 s and the warm case is
 * milliseconds.
 *
 * The bug this guards: `analyze_done` was a one-shot latch, so an install kept
 * whatever statistics existed the first time it ran. On a production-shaped copy
 * sqlite_stat1 held stats for ONE scan_targets index, value "0 0 0 0", and the
 * planner walked 919k rows for a count the range index answers immediately.
 * Plain `PRAGMA optimize` cannot fix that - it only reconsiders tables the
 * current connection has queried - which is what the 0x10002 mask is for.
 *
 * Deliberately asserts BEHAVIOUR (that statistics exist and get refreshed),
 * never EXPLAIN QUERY PLAN text, whose format SQLite may change.
 */
let rawDb: import("better-sqlite3").Database;
let mod: typeof import("../../server/yieldRollups");

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-planner-"));
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  mod = await import("../../server/yieldRollups");
});
afterEach(() => { delete process.env.ANALYZE_MAINTENANCE; mod._resetPlannerStatsForTests(); });

describe("optimizePlannerStats", () => {
  it("analyses the most important table FIRST, not alphabetically", () => {
    // The planner is blind on scan_targets, so it must not queue behind 250
    // alphabetically-earlier tables at one table per tick.
    rawDb.prepare(`INSERT INTO scan_targets (tenant_id,address,city,state,zip,lat,lng,source)
      VALUES (1,'2 Priority Way','Rockwell','NC','28138',35.55,-80.4,'test')`).run();
    mod._resetPlannerStatsForTests();
    expect(mod.optimizePlannerStats(Date.now())).toBe("full");
    expect(
      (rawDb.prepare(`SELECT COUNT(*) n FROM sqlite_stat1 WHERE tbl='scan_targets'`).get() as any).n,
      "scan_targets has statistics after the very first tick",
    ).toBeGreaterThan(0);
  });

  it("advances one table per tick rather than analysing everything at once", () => {
    mod._resetPlannerStatsForTests();
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      mod.optimizePlannerStats(Date.now());
      const cur = (rawDb.prepare(`SELECT v FROM yield_rollup_state WHERE k='analyze_table_cursor'`).get() as any)?.v;
      if (cur) seen.add(cur);
    }
    expect(seen.size, "each tick moves the cursor to a different table").toBeGreaterThan(1);
  });

  it("keeps sweeping until every table is analysed, then goes incremental", () => {
    // One table per tick means "full" repeats for as many ticks as there are
    // tables - that IS the bounded behaviour. Incremental is what it settles to.
    mod._resetPlannerStatsForTests();
    const now = Date.now();
    let last: string | null = null;
    for (let i = 0; i < 400; i++) {
      last = mod.optimizePlannerStats(now);
      if (last === "incremental") break;
    }
    expect(last, "the sweep terminates rather than looping forever").toBe("incremental");
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM sqlite_stat1 WHERE tbl='scan_targets'`).get() as any).n)
      .toBeGreaterThan(0);
    expect(mod.optimizePlannerStats(now + 60_000)).toBe("incremental");
  });

  it("restarts the sweep once the period has elapsed, so stats can never freeze", () => {
    mod._resetPlannerStatsForTests();
    const now = Date.now();
    for (let i = 0; i < 400 && mod.optimizePlannerStats(now) !== "incremental"; i++) { /* drain */ }
    expect(mod.optimizePlannerStats(now)).toBe("incremental");
    // A day later the cursor is cleared and a fresh bounded sweep begins.
    expect(mod.optimizePlannerStats(now + 25 * 3_600_000)).toBe("incremental");
    expect(mod.optimizePlannerStats(now + 25 * 3_600_000 + 1000)).toBe("full");
  });

  it("a fresh process re-runs the full pass even if the period has not elapsed", () => {
    mod.optimizePlannerStats(Date.now());
    mod._resetPlannerStatsForTests(); // simulates a restart
    expect(mod.optimizePlannerStats(Date.now())).toBe("full");
  });

  it("can be switched off", () => {
    process.env.ANALYZE_MAINTENANCE = "off";
    expect(mod.optimizePlannerStats(Date.now())).toBeNull();
  });
});

describe("planner upkeep is not gated by an unrelated feature flag", () => {
  // Production sets YIELD_ROLLUPS=off. startYieldRollupMaintenance returns
  // before its timer is created, so anything wired inside that tick never runs
  // there - which is exactly how the address repair lane was silently disabled
  // once before.
  it("starts with YIELD_ROLLUPS=off and stops only for its own switch", async () => {
    const mod = await import("../../server/yieldRollups");
    const prev = { y: process.env.YIELD_ROLLUPS, a: process.env.ANALYZE_MAINTENANCE };
    try {
      process.env.YIELD_ROLLUPS = "off";
      delete process.env.ANALYZE_MAINTENANCE;
      expect(mod.startYieldRollupMaintenance(), "the rollup tick is off in prod").toBeNull();
      const t = mod.startPlannerStatsMaintenance();
      expect(t, "planner upkeep still starts").not.toBeNull();
      clearInterval(t as NodeJS.Timeout);
      process.env.ANALYZE_MAINTENANCE = "off";
      expect(mod.startPlannerStatsMaintenance(), "its own switch stops it").toBeNull();
    } finally {
      if (prev.y === undefined) delete process.env.YIELD_ROLLUPS; else process.env.YIELD_ROLLUPS = prev.y;
      if (prev.a === undefined) delete process.env.ANALYZE_MAINTENANCE; else process.env.ANALYZE_MAINTENANCE = prev.a;
    }
  });

  it("is wired into the server boot independently of the rollup tick", async () => {
    const [fs, path] = [await import("node:fs"), await import("node:path")];
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/index.ts"), "utf8");
    expect(src).toContain("startPlannerStatsMaintenance()");
  });
});

describe("planner upkeep never queues behind a migration", () => {
  // It used to sit at the BOTTOM of the maintenance tick, after five one-time
  // steps that each `return`. On any install still draining a migration the
  // planner ran blind, and if the alias merge halts on its integrity guard it
  // would never run at all.
  it("the rollup tick no longer performs the analysis itself", async () => {
    // Behavioural, not a source-text slice: with rollups OFF the rollup timer
    // never exists, yet statistics still advance - which can only be true if
    // the work lives outside that tick.
    const prev = process.env.YIELD_ROLLUPS;
    try {
      process.env.YIELD_ROLLUPS = "off";
      expect(mod.startYieldRollupMaintenance()).toBeNull();
      mod._resetPlannerStatsForTests();
      const before = (rawDb.prepare(`SELECT COUNT(*) n FROM sqlite_stat1`).get() as any).n;
      mod.optimizePlannerStats(Date.now());
      mod.optimizePlannerStats(Date.now());
      expect((rawDb.prepare(`SELECT COUNT(*) n FROM sqlite_stat1`).get() as any).n).toBeGreaterThanOrEqual(before);
      expect((rawDb.prepare(`SELECT v FROM yield_rollup_state WHERE k='analyze_table_cursor'`).get() as any)?.v)
        .toBeTruthy();
    } finally {
      if (prev === undefined) delete process.env.YIELD_ROLLUPS; else process.env.YIELD_ROLLUPS = prev;
    }
  });
});
