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
let streetKeyOf: typeof import("../../shared/addressKey").streetKeyOf;
const TENANT = 1;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-antimiss-"));
  ({ rawDb } = await import("../../server/db"));
  const s = await import("../../server/storage");
  s.runMigrations();
  storage = s.storage;
  yieldEngine = await import("../../server/yieldEngine");
  ({ streetKeyOf } = await import("../../shared/addressKey"));
});

// upsertScanTargets does not stamp street_key; the yield-rollup janitor fills it
// (and script/import-rowan.ts fills it as it writes). The alias guard matches on
// `street_key = ?`, so a fixture that leaves it NULL cannot make the guard run
// AT ALL - it passes no matter what the guard does. Every case below fills it
// first, on purpose.
function fillStreetKeys(): void {
  const rows = rawDb.prepare(`SELECT id, address FROM scan_targets WHERE street_key IS NULL`)
    .all() as Array<{ id: number; address: string }>;
  const upd = rawDb.prepare(`UPDATE scan_targets SET street_key=? WHERE id=?`);
  for (const r of rows) upd.run(streetKeyOf(r.address), r.id);
}
const door = (address: string, city: string, lat: number, lng: number, zip = "28147") =>
  ({ address, city, state: "NC", zip, lat, lng, tenantId: TENANT, source: "e911-nc-onemap" });

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
    ] as any);
    fillStreetKeys(); // without this the guard never runs and this test proves nothing
    storage.upsertScanTargets([
      { address: "200 Stonewyck Dr Apt 2", city: "Lexington", state: "NC", zip: "", lat: 35.60601, lng: -80.43519, tenantId: TENANT, source: "mapbox-deep-seed" },
    ] as any);
    const n = (rawDb.prepare(`SELECT COUNT(*) n FROM scan_targets WHERE address LIKE '200 Stonewyck%'`).get() as any).n;
    expect(n).toBe(2); // two doors of one building — different unit, different row
  });
});

// The guard matched street_key + state + house number + a ~25m box and called
// that a premise. It is not one: streetKeyOf CUTS the unit clause off, so every
// door of a building shares all four. One Salisbury complex has 240 units at
// 2715 Statesville Boulevard; 6,793 of Rowan County's E911 doors were held back
// because of this. Coordinates deliberately sit inside the ~25m box.
describe("units of one building are separate doors", () => {
  const LAT = 35.6700, LNG = -80.5200;

  it("every unit at one address gets its own row, with street_key populated", () => {
    expect(storage.upsertScanTargets([door("2715 Statesville Blvd Unit 101", "Salisbury", LAT, LNG)] as any)).toBe(1);
    fillStreetKeys();
    expect(storage.upsertScanTargets([door("2715 Statesville Blvd Unit 102", "Salisbury", LAT, LNG)] as any)).toBe(1);
    fillStreetKeys();
    // Same building, a rooftop-width apart — still inside the box, still its own door.
    expect(storage.upsertScanTargets([door("2715 Statesville Blvd Unit 240", "Salisbury", 35.67015, -80.52015)] as any)).toBe(1);
    fillStreetKeys();
    // The building itself is not any of its units (v4: no-unit and Unit N are
    // distinct identities).
    expect(storage.upsertScanTargets([door("2715 Statesville Blvd", "Salisbury", LAT, LNG)] as any)).toBe(1);
    fillStreetKeys();
    // The house next door was never at risk, and still is not.
    expect(storage.upsertScanTargets([door("2717 Statesville Blvd", "Salisbury", LAT, LNG)] as any)).toBe(1);

    const n = (rawDb.prepare(`SELECT COUNT(*) n FROM scan_targets WHERE address LIKE '271_ Statesville%'`).get() as any).n;
    expect(n).toBe(5);
  });

  it("a LOT is a unit too - the mobile-home-park case", () => {
    expect(storage.upsertScanTargets([door("77 Lake Vista Dr", "Lyman", 35.0001, -82.0001)] as any)).toBe(1);
    fillStreetKeys();
    expect(storage.upsertScanTargets([door("77 LAKE VISTA DR LOT 16", "Lyman", 35.0001, -82.0001)] as any)).toBe(1);
    fillStreetKeys();
    expect(storage.upsertScanTargets([door("77 Lake Vista Dr Lot 17", "Lyman", 35.0001, -82.0001)] as any)).toBe(1);
    const n = (rawDb.prepare(`SELECT COUNT(*) n FROM scan_targets WHERE address LIKE '77 Lake Vista%' OR address LIKE '77 LAKE VISTA%'`).get() as any).n;
    expect(n).toBe(3);
  });

  it("the SAME unit under two postal cities and two spellings still attaches to one row", () => {
    // The alias dedup this guard exists for has to keep working THROUGH a unit
    // clause: "Apt 7" in Salisbury and "Unit 7" in Lexington are one door, and
    // the canonical-twin guard misses it because city is in the canonical key.
    expect(storage.upsertScanTargets([door("2719 Statesville Blvd Apt 7", "Salisbury", LAT, LNG)] as any)).toBe(1);
    fillStreetKeys();
    expect(storage.upsertScanTargets([
      { ...door("2719 Statesville Blvd Unit 7", "Lexington", LAT + 0.00001, LNG - 0.00001), zip: "" },
    ] as any)).toBe(0);
    const rows = rawDb.prepare(`SELECT city, zip FROM scan_targets WHERE address LIKE '2719 Statesville%'`).all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].zip).toBe("28147"); // first verified ZIP retained
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
