import { describe, expect, it } from "vitest";

// BOOT-STORM GUARD: both resume paths must dispatch a BOUNDED number of runs
// per tick. Five production deploys failed their health gates because a boot
// with 221 resumable runs spawned 221 worker loops at once, each racing to mint
// a Decodo token against its 403 rolling window — the event loops pegged and
// the in-container health probe failed. The reaper drains the remainder.

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Vitest transforms this file, so import.meta.url is not a file: URL here —
// resolve from the project root instead.
const src = readFileSync(join(process.cwd(), "server/scanEngine.ts"), "utf8");

describe("resume dispatch is bounded", () => {
  it("declares a per-tick resume budget with an env override", () => {
    expect(src).toMatch(/RESUME_MAX_PER_TICK\s*=\s*Math\.max\(1,\s*Number\(process\.env\.SCAN_RESUME_MAX_PER_TICK\)/);
  });

  it("resumeInterruptedRuns stops dispatching past the budget and defers the rest", () => {
    const fn = src.slice(src.indexOf("export function resumeInterruptedRuns"), src.indexOf("export function resumeCriticalRuns"));
    expect(fn).toContain("dispatched >= RESUME_MAX_PER_TICK");
    expect(fn).toContain("deferred++");
    // deferral must be a `continue`, never a status change — no run is lost.
    expect(fn).not.toMatch(/deferred\+\+;\s*setRunStatus/);
  });

  it("resumeCriticalRuns is bounded too (the boot burst that broke deploys)", () => {
    const fn = src.slice(src.indexOf("export function resumeCriticalRuns"));
    expect(fn).toContain("dispatched >= RESUME_MAX_PER_TICK");
    expect(fn).toContain("deferred++");
  });

  it("the periodic reaper still exists to drain the deferred backlog", () => {
    expect(src).toMatch(/startScanReaper\(intervalMs = 60_000\)/);
    expect(src).toContain("resumeInterruptedRuns()");
  });
});
