import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let rawDb: import("better-sqlite3").Database;
let monitor: typeof import("../../server/stateMonitorStore");
const TENANT = 1;
let freshId: number;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-state-monitor-"));
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  monitor = await import("../../server/stateMonitorStore");
  const insert = rawDb.prepare(`INSERT INTO scan_targets
    (address,city,state,zip,lat,lng,tenant_id,last_is_new_fiber,last_scanned_at,first_seen_live_at,source,last_customer_segment,last_customer_confidence)
    VALUES (?,?,?,?,?,?,?,1,datetime('now'),datetime('now'),'test','new_opportunity','medium')`);
  freshId = Number(insert.run("100 Fresh St", "Lexington", "NC", "27292", 35.8240, -80.2534, TENANT).lastInsertRowid);
  // A baseline-live record is not fresh without a proven flip timestamp.
  rawDb.prepare(`INSERT INTO scan_targets
    (address,city,state,zip,lat,lng,tenant_id,last_is_new_fiber,last_scanned_at,source)
    VALUES (?,?,?,?,?,?,?,1,datetime('now'),'test')`).run("200 Baseline St", "Lexington", "NC", "27292", 35.8242, -80.2532, TENANT);
});

describe("state monitoring evidence store", () => {
  it("reports only proven flips and labels Kinetic-only evidence provisional", () => {
    const points = monitor.freshPoints(TENANT, 30);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ id: freshId, confidence: "single_source_provisional", sources: ["kinetic"] });
  });

  it("requires recent independent address-level availability for cross-verification", () => {
    const row = {
      scanTargetId: freshId, source: "fcc_bdc_licensed" as const,
      sourceRecordId: "licensed-1", observedAt: new Date().toISOString(), availability: "available" as const,
      technology: "fiber", maxDownMbps: 1000, importBatchId: "fcc-test",
    };
    expect(monitor.recordCorroboration(TENANT, [row])).toEqual({ accepted: 1, duplicates: 0 });
    expect(monitor.recordCorroboration(TENANT, [row])).toEqual({ accepted: 0, duplicates: 1 });
    expect(monitor.freshPoints(TENANT, 30)[0]).toMatchObject({ confidence: "cross_verified", sources: ["kinetic", "fcc_bdc_licensed"] });
  });

  it("produces a ranked, mappable knock-list row", () => {
    const rows = monitor.knockList(TENANT, 30);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ address: "100 Fresh St", confidence: "cross_verified", cluster_density: 1 });
    expect(rows[0].map_url).toContain("google.com/maps");
  });

  it("rejects evidence for an inaccessible target", () => {
    expect(() => monitor.recordCorroboration(TENANT, [{
      scanTargetId: 999_999, source: "field_verification", observedAt: new Date().toISOString(), availability: "available",
    }])).toThrow(/SCAN_TARGET_NOT_FOUND/);
  });
});
