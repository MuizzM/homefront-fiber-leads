import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const indexSrc = readFileSync(join(process.cwd(), "server/index.ts"), "utf8");

const clusterPrimaryBranch = (() => {
  const start = indexSrc.indexOf("if (SCAN_WORKERS > 0 && cluster.isPrimary)");
  const end = indexSrc.indexOf("return; // primary never runs the worker body below", start);
  expect(start, "cluster-primary startup branch not found").toBeGreaterThan(-1);
  expect(end, "cluster-primary return not found").toBeGreaterThan(start);
  return indexSrc.slice(start, end);
})();

describe("rep metrics scheduler ownership", () => {
  it("starts exactly one scheduler in the cluster primary and stops it on shutdown", () => {
    expect(clusterPrimaryBranch).toContain('import("./repMetricsAggregator")');
    expect(clusterPrimaryBranch).toContain("startRepMetricsWorkers()");
    expect(clusterPrimaryBranch).toContain("stopPrimaryRepMetrics?.()");
  });

  it("keeps cluster workers out of the scheduler while preserving single-process startup", () => {
    const afterPrimary = indexSrc.slice(indexSrc.indexOf("// Migrations run once per DB"));
    expect(afterPrimary).toMatch(/if \(!IS_CLUSTER_WORKER\) \{[\s\S]{0,300}startRepMetricsWorkers\(\)/);
  });
});
