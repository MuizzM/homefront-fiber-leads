import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { METRICS_REFETCH_MS } from "../../client/src/components/metrics/MetricsDataState";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("metrics client refresh and money-source contract", () => {
  it("uses a bounded 30-second refresh on every metrics tab", () => {
    expect(METRICS_REFETCH_MS).toBe(30_000);
    for (const file of ["MyMetrics.tsx", "TeamMetrics.tsx", "TerritoryMetrics.tsx", "Reports.tsx"]) {
      const source = fs.readFileSync(path.join(ROOT, "client/src/components/metrics", file), "utf8");
      expect(source, file).toContain("refetchInterval: METRICS_REFETCH_MS");
    }
  });

  it("keeps legacy estimated and paid money labels out of metrics tabs", () => {
    for (const file of ["MyMetrics.tsx", "TeamMetrics.tsx", "Reports.tsx"]) {
      const source = fs.readFileSync(path.join(ROOT, "client/src/components/metrics", file), "utf8");
      expect(source, file).not.toContain('label="Estimated pay"');
      expect(source, file).not.toContain('label="Paid"');
      expect(source, file).not.toContain('"Paid"].map');
    }
  });
});
