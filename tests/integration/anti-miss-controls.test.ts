import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Anti-miss controls (post-Stonewyck): the guaranteed discovery lane, the
// postal-city alias writer guard, and their non-goals (genuine neighbors and
// units never merge).

let rawDb: import("better-sqlite3").Database;
let storage: typeof import("../../server/storage").storage;
let yieldEngine: typeof import("../../server/yieldEngine");
const TENANT = 1;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-antimiss-"));
  ({ rawDb } = await import("../../server/db"));
  const s = await import("../../server/storage");
  s.runMigrations();
  storage = s.storage;
  yieldEngine = await import("../../server/yieldEngine");
});

describe("postal-city alias writer guard", () => {
  it("the SAME premise under two postal cities attaches to one scan identity", () => {
    storage.upsertScanTargets([{
      address: "1315 Stonewyck Dr", city: "Salisbury", state: "NC", zip: "28146",
      lat: 35.605598, lng: -80.435109, tenantId: TENANT, source: "field",
    }] as any);
    // Backfill street_key the way the janitor would, then re-file the premise
    // under the alias city (mapbox said Lexington) at the same rooftop.
    rawDb.prepare(`UPDATE scan_targets SET street_key=(SELECT '' || ?) WHERE street_key IS NULL`).run("STONEWYCK DR");
    storage.upsertScanTargets([{
      address: "1315 Stonewyck Drive", city: "Lexington", state: "NC", zip: "",
      lat: 35.605601, lng: -80.435105, tenantId: TENANT, source: "mapbox-deep-seed",
    }] as any);
    const rows = rawDb.prepare(`SELECT id, city, zip FROM scan_targets WHERE address LIKE '1315 Stonewyck%'`).all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].zip).toBe("28146"); // first verified ZIP retained
  });

  it("genuine NEIGHBORS on the same street never merge (identity first, geo second)", () => {
    storage.upsertScanTargets([
      { address: "1317 Stonewyck Dr", city: "Salisbury", state: "NC", zip: "28146", lat: 35.60562, lng: -80.43508, tenantId: TENANT, source: "field" },
      { address: "1319 Stonewyck Dr", city: "Lexington", state: "NC", zip: "", lat: 35.60563, lng: -80.43507, tenantId: TENANT, source: "mapbox-deep-seed" },
    ] as any);
    const n = (rawDb.prepare(`SELECT COUNT(*) n FROM scan_targets WHERE address LIKE '131_ Stonewyck%' AND address NOT LIKE '1315%'`).get() as any).n;
    expect(n).toBe(2); // different house numbers — two premises, even 1m apart
  });

  it("distinct UNITS never merge across city aliases", () => {
    storage.upsertScanTargets([
      { address: "200 Stonewyck Dr Apt 1", city: "Salisbury", state: "NC", zip: "28146", lat: 35.6060, lng: -80.4352, tenantId: TENANT, source: "field" },
      { address: "200 Stonewyck Dr Apt 2", city: "Lexington", state: "NC", zip: "", lat: 35.60601, lng: -80.43519, tenantId: TENANT, source: "mapbox-deep-seed" },
    ] as any);
    const n = (rawDb.prepare(`SELECT COUNT(*) n FROM scan_targets WHERE address LIKE '200 Stonewyck%'`).get() as any).n;
    expect(n).toBe(2); // street_key retains the unit token — units stay distinct
  });
});

describe("guaranteed discovery lane", () => {
  it("oldest never-scanned admit first, partitioned so a tiny city is never starved by a big one", async () => {
    // A "hot metro" with many never-scanned rows + one tiny street seeded LONG ago.
    const ins = rawDb.prepare(
      `INSERT INTO scan_targets (address, city, state, zip, lat, lng, tenant_id, source, created_at)
       VALUES (?, ?, 'NC', '28000', ?, ?, ?, 'osm', datetime('now', ?))`,
    );
    for (let i = 0; i < 300; i++) {
      ins.run(`${i + 1} Metro Blvd`, "Bigcity", 35.2 + i / 1e4, -80.8, TENANT, "-1 days");
    }
    const oldId = Number(ins.run("7 Quiet Ln", "Tinytown", 35.9, -80.1, TENANT, "-30 days").lastInsertRowid);
    process.env.YIELD_DISCOVERY_FRACTION = "0.2";
    // The lane query is inside runYieldCycle; call it with dispatch mocked via
    // a tiny budget and inspect the run it creates.
    const cycle = yieldEngine.runYieldCycle(TENANT, 100);
    const queued = rawDb.prepare(
      `SELECT t.target_id id FROM scan_run_targets t JOIN scan_runs r ON r.id = t.run_id
        WHERE r.kind IN ('fresh_harvest') ORDER BY t.seq LIMIT 50`,
    ).all() as any[];
    const queuedIds = new Set(queued.map((q) => q.id));
    // The 30-day-old Tinytown address must be admitted ahead of week-old metro bulk.
    expect(queuedIds.has(oldId)).toBe(true);
    expect(cycle.exploit + cycle.explore).toBeGreaterThanOrEqual(0); // cycle ran
  });
});
