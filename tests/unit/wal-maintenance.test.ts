// Where the WAL guard runs.
//
// `PRAGMA wal_checkpoint(TRUNCATE)` is synchronous and waits up to 30s for
// readers to drain. Production ran it on the web server's own event loop
// (SCAN_WORKERS=0 takes the "single process" branch), which blocked /api/health
// for up to 26s every 120s and made Caddy drop every request caught in the
// window - surfacing in the browser as "Load failed".
//
// This pins the decision, not the checkpoint: a single-process deployment must
// hand the periodic guard to a process that serves nothing.
// See docs/architecture/BULK_ASSIGNMENT.md.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let mod: typeof import("../../server/walMaintenance");
let tmp: string;
const saved = { guard: process.env.WAL_GUARD, entry: process.env.WAL_MAINTENANCE_ENTRY };

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "hf-wal-maint-"));
  // Fresh module per test: the supervisor holds child state at module scope,
  // and a `stopping` flag set by one test would mute the next one's spawn.
  vi.resetModules();
  mod = await import("../../server/walMaintenance");
});

afterEach(() => {
  mod.stopWalMaintenance();
  if (saved.guard === undefined) delete process.env.WAL_GUARD; else process.env.WAL_GUARD = saved.guard;
  if (saved.entry === undefined) delete process.env.WAL_MAINTENANCE_ENTRY; else process.env.WAL_MAINTENANCE_ENTRY = saved.entry;
});

describe("WAL maintenance placement", () => {
  it("honours the WAL_GUARD=off kill switch", () => {
    process.env.WAL_GUARD = "off";
    delete process.env.WAL_MAINTENANCE_ENTRY;
    expect(mod.startWalMaintenance()).toBe("off");
  });

  it("runs the guard in a CHILD when the bundled entry exists", async () => {
    delete process.env.WAL_GUARD;
    // A stand-in for dist/wal-maintenance.cjs that proves it was executed.
    const entry = join(tmp, "wal-maintenance.cjs");
    const marker = join(tmp, "ran.txt");
    writeFileSync(entry, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ok");\n`);
    process.env.WAL_MAINTENANCE_ENTRY = entry;

    expect(mod.startWalMaintenance()).toBe("child");

    // The child is a real process; give it a moment to run and exit cleanly.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(existsSync(marker)).toBe(true);
  }, 15_000);

  it("delegates an emergency reclaim to the child instead of blocking the server", async () => {
    // The resource sentinel latches on `emergency` while the WAL is over the
    // threshold, so this fires every 30s. Run inline it blocks the web server
    // for the length of the checkpoint - the same defect as the 120s guard.
    delete process.env.WAL_GUARD;
    const entry = join(tmp, "wal-maintenance.cjs");
    const got = join(tmp, "got.txt");
    writeFileSync(entry, `
      process.on("message", (m) => {
        if (m && m.type === "checkpoint") {
          require("node:fs").writeFileSync(${JSON.stringify(got)}, String(m.reason));
        }
      });
    `);
    process.env.WAL_MAINTENANCE_ENTRY = entry;

    expect(mod.startWalMaintenance()).toBe("child");
    await new Promise((r) => setTimeout(r, 800)); // let the child come up
    expect(mod.requestWalCheckpoint("emergency")).toBe(true);

    await new Promise((r) => setTimeout(r, 800));
    expect(existsSync(got)).toBe(true);
    expect(readFileSync(got, "utf8")).toBe("emergency");
  }, 15_000);

  it("reports no delegate when nothing is running, so the caller reclaims inline", () => {
    // Returning true here would silently disable the emergency reclaim on a box
    // that is running out of disk.
    expect(mod.requestWalCheckpoint("emergency")).toBe(false);
  });

  it("falls back in-process only when no bundled entry can be found", () => {
    delete process.env.WAL_GUARD;
    process.env.WAL_MAINTENANCE_ENTRY = join(tmp, "does-not-exist.cjs");
    // cwd during tests is the repo root, which has no dist/ in CI before build.
    const mode = mod.startWalMaintenance();
    expect(["in-process", "child"]).toContain(mode);
  });
});
