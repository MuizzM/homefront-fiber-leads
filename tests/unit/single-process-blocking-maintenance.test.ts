// Nothing that blocks for longer than a request budget may start on the web
// server's own event loop.
//
// better-sqlite3 is synchronous, which is the right trade for request-scoped
// statements measured in microseconds and a fatal one for maintenance measured
// in seconds. With SCAN_WORKERS=0 there is no cluster primary to absorb it, so
// the "single process" branch of server/index.ts IS the web server - and three
// separate lanes were started there, each documented as safe on a "near-idle"
// loop that does not exist in that mode:
//
//   1. the WAL guard        - wal_checkpoint(TRUNCATE), up to 30s, every 120s
//   2. the emergency reclaim - the same call, every 30s while pressure latches
//   3. yield-rollup maintenance - a HARD 5s synchronous budget every 30s, plus
//      one blocking CREATE INDEX per tick and a full ANALYZE
//
// Production symptoms, in order as each was removed: /api/health worst 26.19s,
// then 9.0s, then 3.8-6.4s on a ~60s cadence. Every request caught in a window
// was dropped by Caddy and reported by the browser as "Load failed".
//
// This is a source-level guard because the failure is a one-line reintroduction
// in a startup path that no unit test boots.
// See docs/architecture/BULK_ASSIGNMENT.md.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const indexSrc = readFileSync(join(process.cwd(), "server/index.ts"), "utf8");

// The SCAN_WORKERS === 0 branch only. The cluster-primary block above it starts
// the same lanes legitimately: that process serves no HTTP.
const singleProcessBranch = (() => {
  const start = indexSrc.indexOf("if (SCAN_WORKERS === 0) {");
  expect(start, "single-process startup branch not found - did it move?").toBeGreaterThan(-1);
  return indexSrc.slice(start, indexSrc.indexOf("await registerRoutes", start));
})();

describe("the single-process branch starts no blocking maintenance", () => {
  it("does not start the periodic WAL guard in-process", () => {
    expect(singleProcessBranch).not.toContain("startWalGuard()");
    expect(singleProcessBranch).toContain("startWalMaintenance()");
  });

  it("does not start yield-rollup maintenance in-process", () => {
    // It ticks every 30s and spends YIELD_ROLLUP_TICK_BUDGET_MS (5s) of
    // synchronous SQLite in a while-loop. The maintenance child runs it now.
    expect(singleProcessBranch).not.toContain("startYieldRollupMaintenance");
  });

  it("keeps only the boot reclaim, which runs before listen()", () => {
    // Blocking is free before anything is served, and with no other connection
    // the TRUNCATE always wins the lock.
    expect(singleProcessBranch).toContain("bootWalCheckpoint()");
    // lastIndexOf, not indexOf: an earlier COMMENT also spells "httpServer.listen()".
    const listenAt = indexSrc.lastIndexOf("httpServer.listen(");
    const bootAt = indexSrc.indexOf("bootWalCheckpoint()", indexSrc.indexOf("if (SCAN_WORKERS === 0) {"));
    expect(bootAt).toBeGreaterThan(-1);
    expect(bootAt, "boot reclaim must precede listen()").toBeLessThan(listenAt);
  });

  it("stops the maintenance child on shutdown so a cutover leaves no orphan", () => {
    expect(singleProcessBranch).toContain("stopWalMaintenance");
  });
});

describe("the emergency reclaim delegates before it blocks", () => {
  const pressureSrc = readFileSync(join(process.cwd(), "server/resourcePressure.ts"), "utf8");

  it("asks the maintenance child first, and only then falls back inline", () => {
    expect(pressureSrc).toContain('requestWalCheckpoint("emergency")');
    // The inline call must survive as the no-child fallback: on a box actually
    // running out of disk, a blocking checkpoint beats no checkpoint.
    expect(pressureSrc).toContain('forceWalTruncate("emergency")');
    expect(pressureSrc).toMatch(/!requestWalCheckpoint\("emergency"\)[\s\S]{0,80}forceWalTruncate\("emergency"\)/);
  });
});
