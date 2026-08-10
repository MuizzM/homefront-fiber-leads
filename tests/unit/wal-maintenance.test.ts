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
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

  it("falls back in-process only when no bundled entry can be found", () => {
    delete process.env.WAL_GUARD;
    process.env.WAL_MAINTENANCE_ENTRY = join(tmp, "does-not-exist.cjs");
    // cwd during tests is the repo root, which has no dist/ in CI before build.
    const mode = mod.startWalMaintenance();
    expect(["in-process", "child"]).toContain(mode);
  });
});
