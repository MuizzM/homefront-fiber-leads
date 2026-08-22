import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Planner statistics upkeep. The bug this guards: `analyze_done` was a one-shot
 * latch, so a long-lived install kept whatever stats ANALYZE captured the first
 * time - on a production-shaped copy that was stats for ONE scan_targets index,
 * value "0 0 0 0", which made the planner walk 919k rows for a query the range
 * index answers in 9 ms.
 */
let rawDb: import("better-sqlite3").Database;
let mod: typeof import("../../server/yieldRollups");

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-analyze-"));
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  mod = await import("../../server/yieldRollups");
});

describe("reanalyseStaleTable", () => {
  it("analyses one table per tick and writes real planner stats", () => {
    rawDb.prepare(`INSERT INTO scan_targets (tenant_id,address,city,state,zip,lat,lng,source)
      VALUES (1,'1 Stats Way','Rockwell','NC','28138',35.55,-80.4,'test')`).run();
    const first = mod.reanalyseStaleTable(Date.now());
    expect(first).toBe("scan_targets");
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM sqlite_stat1 WHERE tbl='scan_targets'`).get() as any).n).toBeGreaterThan(0);
    // One table per tick: the next call moves on rather than redoing the first.
    expect(mod.reanalyseStaleTable(Date.now())).toBe("scan_run_targets");
  });

  it("does not re-analyse a table inside its max age, and does again after it", () => {
    const now = Date.now();
    while (mod.reanalyseStaleTable(now)) { /* drain every table once */ }
    expect(mod.reanalyseStaleTable(now)).toBeNull();
    // A day later the rotation starts again - stats can never freeze forever.
    expect(mod.reanalyseStaleTable(now + 25 * 3_600_000)).toBe("scan_targets");
  });

  it("can be switched off", () => {
    process.env.ANALYZE_MAINTENANCE = "off";
    try { expect(mod.reanalyseStaleTable(Date.now() + 999 * 3_600_000)).toBeNull(); }
    finally { delete process.env.ANALYZE_MAINTENANCE; }
  });
});
