import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let rawDb: import("better-sqlite3").Database;
let monitor: typeof import("../../server/stateMonitorStore");
let billing: typeof import("../../server/billingStore");
const TENANT = 1;
let freshId: number;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-state-monitor-"));
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  monitor = await import("../../server/stateMonitorStore");
  billing = await import("../../server/billingStore");
  billing.ensureBilling(TENANT, { planKey: "starter", state: "active" });
  const insert = rawDb.prepare(`INSERT INTO scan_targets
    (address,city,state,zip,lat,lng,tenant_id,last_is_new_fiber,last_scanned_at,first_seen_live_at,first_seen_fiber_at,last_fiber_available,source,last_customer_segment,last_customer_confidence)
    VALUES (?,?,?,?,?,?,?,1,datetime('now'),datetime('now'),datetime('now'),1,'test','new_opportunity','medium')`);
  freshId = Number(insert.run("100 Fresh St", "Lexington", "NC", "27292", 35.8240, -80.2534, TENANT).lastInsertRowid);
  rawDb.prepare(`INSERT INTO availability_snapshots
    (tenant_id,scan_target_id,run_id,checked_at_epoch,conclusive,fiber_available,customer_segment,customer_confidence,transition_status,fresh,api_source,evidence_hash)
    VALUES (?,?,?,1784000000000,1,1,'new_opportunity','medium','freshly_available',1,'kinetic_live','fresh-test')`)
    .run(TENANT, freshId, "state-monitor-test");
  // A baseline-live record is not fresh without a proven flip timestamp.
  rawDb.prepare(`INSERT INTO scan_targets
    (address,city,state,zip,lat,lng,tenant_id,last_is_new_fiber,last_scanned_at,source)
    VALUES (?,?,?,?,?,?,?,1,datetime('now'),'test')`).run("200 Baseline St", "Lexington", "NC", "27292", 35.8242, -80.2532, TENANT);
});

describe("state monitoring evidence store", () => {
  it("seeds every official market with the intended critical, weekly, and change-watch cadence tiers", () => {
    // 161 = 132 NC/SC + 29 GA (Dalton active build + north-GA ILEC legacy watch);
    // Dalton is the 14th critical/expanding market.
    expect(monitor.seedStateMarkets("/definitely/missing-market-catalog.csv")).toMatchObject({
      verifiedMarkets: 161, expandingMarkets: 14, syntheticMarkets: 161,
    });
    const tiers = rawDb.prepare(`SELECT priority_class AS priorityClass,cadence_hours AS cadenceHours,COUNT(*) AS count
      FROM state_fiber_markets GROUP BY priority_class,cadence_hours ORDER BY cadence_hours,priority_class`).all();
    expect(tiers).toEqual([
      { priorityClass: "critical", cadenceHours: 24, count: 14 },
      // Copper-switch watch: SW-Chatham CAB towns (bear creek/goldston/moncure)
      // run daily; every other legacy copper town re-sweeps at 72h (was 336h)
      // so a copper→fiber switch-on is caught within days, not weeks.
      { priorityClass: "low", cadenceHours: 24, count: 3 },
      { priorityClass: "low", cadenceHours: 72, count: 94 },
      { priorityClass: "medium", cadenceHours: 168, count: 50 },
    ]);
  });

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
    const leads = rawDb.prepare(`SELECT id,fresh_confidence,source_scan_target_id FROM leads WHERE tenant_id=?`).all(TENANT) as any[];
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ fresh_confidence: "cross_verified", source_scan_target_id: freshId });
    expect(billing.getBilling(TENANT)?.creditsUsed).toBe(1);
    // Reprojection is accounting-idempotent as well as lead-idempotent.
    expect(monitor.recordCorroboration(TENANT, [row])).toEqual({ accepted: 0, duplicates: 1 });
    expect(billing.getBilling(TENANT)?.creditsUsed).toBe(1);
  });

  it("produces a ranked, mappable knock-list row", () => {
    const rows = monitor.knockList(TENANT, 30);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ address: "100 Fresh St", confidence: "cross_verified", cluster_density: 1 });
    expect(rows[0].map_url).toContain("google.com/maps");
  });

  it("removes a regressed address from live fresh and knock surfaces", () => {
    rawDb.prepare(`UPDATE scan_targets SET last_fiber_available=0,last_availability_status='went_stale' WHERE id=?`).run(freshId);
    expect(monitor.freshPoints(TENANT, 30)).toHaveLength(0);
    expect(monitor.knockList(TENANT, 30)).toHaveLength(0);
    rawDb.prepare(`UPDATE scan_targets SET last_fiber_available=1,last_availability_status='still_available' WHERE id=?`).run(freshId);
  });

  it("rejects evidence for an inaccessible target", () => {
    expect(() => monitor.recordCorroboration(TENANT, [{
      scanTargetId: 999_999, source: "field_verification", observedAt: new Date().toISOString(), availability: "available",
    }])).toThrow(/SCAN_TARGET_NOT_FOUND/);
  });
});
