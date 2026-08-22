import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Planner statistics upkeep, per SQLite's documented lifecycle
 * (lang_analyze.html): `PRAGMA optimize=0x10002` once for a long-lived
 * connection, then plain `PRAGMA optimize` periodically.
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
  it("runs the full pass first, then stays incremental", () => {
    rawDb.prepare(`INSERT INTO scan_targets (tenant_id,address,city,state,zip,lat,lng,source)
      VALUES (1,'1 Stats Way','Rockwell','NC','28138',35.55,-80.4,'test')`).run();
    const now = Date.now();
    expect(mod.optimizePlannerStats(now)).toBe("full");
    // Statistics now exist for the table the maintenance connection never queries.
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM sqlite_stat1 WHERE tbl='scan_targets'`).get() as any).n).toBeGreaterThan(0);
    expect(mod.optimizePlannerStats(now + 60_000)).toBe("incremental");
    expect(mod.optimizePlannerStats(now + 3_600_000)).toBe("incremental");
  });

  it("returns to a full pass once the period has elapsed, so stats can never freeze", () => {
    const now = Date.now();
    mod.optimizePlannerStats(now);
    expect(mod.optimizePlannerStats(now + 25 * 3_600_000)).toBe("full");
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

describe("planner upkeep never queues behind a migration", () => {
  // It used to sit at the BOTTOM of the maintenance tick, after five one-time
  // steps that each `return`. On any install still draining a migration the
  // planner ran blind, and if the alias merge halts on its integrity guard it
  // would never run at all.
  it("runs before the one-time ladder in the tick body", async () => {
    const [fs, path] = [await import("node:fs"), await import("node:path")];
    const src = fs.readFileSync(path.resolve(process.cwd(), "server/yieldRollups.ts"), "utf8");
    const body = src.slice(src.indexOf("const tick = () =>"));
    const upkeep = body.indexOf("optimizePlannerStats()");
    expect(upkeep, "optimizePlannerStats is called inside the tick").toBeGreaterThan(-1);
    // Every one-time step must come AFTER it.
    for (const marker of ["INDEXES", "streetKeyJanitorChunk", "negStreakBackfillChunk",
                          "analyze_done", "alias_merge_done"]) {
      expect(body.indexOf(marker), `${marker} runs after the planner upkeep`).toBeGreaterThan(upkeep);
    }
    // ...and it is called exactly once, so there is no second copy left behind.
    expect(body.split("optimizePlannerStats()").length - 1).toBe(1);
  });
});
