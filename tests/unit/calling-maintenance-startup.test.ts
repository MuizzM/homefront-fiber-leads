import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("server/index.ts", "utf8");
const primaryEnd = source.indexOf("return; // primary never runs the worker body below");
const primary = source.slice(source.indexOf("if (SCAN_WORKERS > 0 && cluster.isPrimary)"), primaryEnd);
const worker = source.slice(primaryEnd);

describe("calling maintenance ownership", () => {
  it("starts and stops one scheduler in the primary after calling migrations", () => {
    expect(primary.indexOf("await startCallingMaintenance()")).toBeGreaterThan(primary.indexOf("runCallingMigrations();"));
    expect(primary).toContain("stopPrimaryCallingMaintenance();");
  });
  it("excludes clustered HTTP workers while retaining single-process startup", () => {
    expect(worker).toMatch(/if \(!IS_CLUSTER_WORKER\) \{\s*const \{ startCallingMaintenance \} = await import\("\.\/callingMaintenance"\);\s*stopCallingMaintenance = await startCallingMaintenance\(\);/);
    expect(worker).toContain("stopCallingMaintenance?.();");
    expect(worker).not.toContain("setInterval(purgeCallingProviderPayloads");
    expect(worker).not.toContain("setInterval(reapStrandedSkipTraceRuns");
  });
});
