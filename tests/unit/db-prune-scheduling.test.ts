// ── The prune must not be a child of a feature flag ─────────────────────────
//
// Production reached 18.8 GB on a 38 GB volume, hit 100%, and took out a
// maintenance run with SQLITE_FULL — while a "nightly DB prune" sat in the code
// looking perfectly healthy. It never ran. The scheduler was nested inside
// `if (process.env.FRESH_HARVEST !== "off")`, so turning the scanner off (the
// sensible thing to do when proxy spend matters) also turned off the only thing
// keeping the database from eating the disk.
//
// A source-level assertion, like tests/unit/lasso-default-action.test.ts: the
// scheduling lives in a 1,900-line boot file that cannot be imported without
// starting a server. Pinning the nesting is worth more than not pinning it —
// the failure is silent, looks fine in review, and takes a month to show up.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(process.cwd(), "server/index.ts"), "utf8");

describe("nightly DB prune scheduling", () => {
  it("is scheduled at all", () => {
    expect(src).toContain("runDbPrune");
    expect(src).toMatch(/setTimeout\(\(\) => \{ void pruneTick\(\); \}, 30 \* 60_000\)/);
    expect(src).toMatch(/setInterval\(\(\) => \{ void pruneTick\(\); \}, 24 \* 3_600_000\)/);
  });

  it("THE REGRESSION: is NOT inside the FRESH_HARVEST block", () => {
    // Everything between the FRESH_HARVEST guard and its closing brace is
    // scanner work. The prune must sit after it, at the top level of the
    // scheduler section, so a disabled scanner still leaves the database
    // maintained.
    const guard = src.indexOf('if (process.env.FRESH_HARVEST !== "off") {');
    const prune = src.indexOf("const pruneTick");
    expect(guard).toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(-1);

    // The FRESH_HARVEST block ends at the first line that is exactly two-space
    // "}" after the guard — the boot file's indentation for that level.
    const afterGuard = src.slice(guard);
    const close = afterGuard.indexOf("\n  }\n");
    expect(close).toBeGreaterThan(-1);
    const blockEndsAt = guard + close;
    expect(prune).toBeGreaterThan(blockEndsAt);
  });

  it("is not gated on any other environment flag either", () => {
    // Read the ~30 lines around the scheduler and confirm no `if (process.env`
    // wraps it. Housekeeping that can be switched off by accident is
    // housekeeping that will be.
    const at = src.indexOf("const pruneTick");
    const window = src.slice(Math.max(0, at - 900), at);
    const lastGuard = window.lastIndexOf("if (process.env");
    const lastBrace = window.lastIndexOf("\n  }");
    // Any env guard above must already have been closed before the prune.
    if (lastGuard > -1) expect(lastBrace).toBeGreaterThan(lastGuard);
  });
});
