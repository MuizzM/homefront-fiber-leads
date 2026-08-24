import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barrenGroundSql, BARREN_CELL_MIN_DOORS,
         barrenCellSkipEnabled, barrenStreetSkipEnabled } from "../../shared/scanPolicy";

/**
 * BARREN GROUND.
 *
 * The operator's rule: stop paying for ground already proven dead. The risk it
 * carries is going permanently blind to a street that gets built later, so the
 * tests that matter here are the ones about what must NOT be skipped - a cell
 * with any fiber at all, a cell with too little evidence, and anything under a
 * coming-soon promise.
 */
let rawDb: import("better-sqlite3").Database;
const TENANT = 1;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-barren-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
});

let seq = 0;
/** One door. `scanned` false leaves it in the never-scanned pool. */
function door(o: { lat: number; lng: number; fiber?: boolean; scanned?: boolean; street?: string; city?: string }): number {
  const id = ++seq + 700_000;
  rawDb.prepare(
    // street_key is a plain column the app populates, not a generated one.
    `INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,source,street_key,
       last_customer_segment,last_scanned_at,last_fiber_status,last_is_new_fiber,last_fiber_available)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, TENANT, `${id} ${o.street ?? "Dead End Rd"}`, o.city ?? "Testville", "NC", "27000",
    o.lat, o.lng, "test", (o.street ?? "Dead End Rd").toUpperCase(), "unknown",
    o.scanned === false ? null : "2026-08-01T00:00:00.000Z",
    o.scanned === false ? null : (o.fiber ? "new_fiber" : "no_service"),
    o.fiber ? 1 : 0, o.fiber ? 1 : 0);
  return id;
}
const isBarren = (id: number, opts = {}) =>
  (rawDb.prepare(
    `SELECT ${barrenGroundSql("s", opts)} AS b FROM scan_targets s WHERE s.id = ?`,
  ).get(id) as any).b === 1;

describe("barren ground", () => {
  it("the predicate actually executes against the real schema", () => {
    const id = door({ lat: 35.10, lng: -80.10, scanned: false });
    expect(() => isBarren(id)).not.toThrow();
  });

  it("skips an unscanned door in a cell where every answered door had no fiber", () => {
    for (let i = 0; i < BARREN_CELL_MIN_DOORS; i++) door({ lat: 35.20, lng: -80.20, fiber: false });
    const target = door({ lat: 35.201, lng: -80.201, scanned: false });
    expect(isBarren(target)).toBe(true);
  });

  it("does NOT skip when a single door in the cell had fiber", () => {
    for (let i = 0; i < BARREN_CELL_MIN_DOORS; i++) door({ lat: 35.30, lng: -80.30, fiber: false });
    door({ lat: 35.301, lng: -80.301, fiber: true });   // one is enough
    const target = door({ lat: 35.302, lng: -80.302, scanned: false });
    expect(isBarren(target)).toBe(false);
  });

  it("does NOT skip on thin evidence, below the minimum", () => {
    for (let i = 0; i < BARREN_CELL_MIN_DOORS - 1; i++) door({ lat: 35.40, lng: -80.40, fiber: false });
    const target = door({ lat: 35.401, lng: -80.401, scanned: false });
    expect(isBarren(target)).toBe(false);
  });

  it("never skips a door under a coming-soon promise, however dead the ground", () => {
    for (let i = 0; i < BARREN_CELL_MIN_DOORS; i++) door({ lat: 35.50, lng: -80.50, fiber: false });
    const target = door({ lat: 35.501, lng: -80.501, scanned: false });
    expect(isBarren(target)).toBe(true);            // barren before the promise
    rawDb.prepare(
      `INSERT INTO coming_soon_watchlist
         (tenant_id, scan_target_id, address_key, first_seen_at, created_at, updated_at, source)
       VALUES (?,?,?,?,?,?, 'test')`,
    ).run(TENANT, target, `k${target}`, Date.now(), Date.now(), Date.now());
    expect(isBarren(target)).toBe(false);           // the promise outranks the ground
  });

  it("leaves streets alone unless the street rule is asked for", () => {
    // Same street, but spread across cells so the cell rule cannot fire.
    for (let i = 0; i < 6; i++) door({ lat: 36.00 + i * 0.05, lng: -81.00 - i * 0.05, fiber: false, street: "Barren Rd", city: "Streetville" });
    const target = door({ lat: 36.40, lng: -81.40, scanned: false, street: "Barren Rd", city: "Streetville" });
    expect(isBarren(target)).toBe(false);                              // cells only, the default
    expect(isBarren(target, { streets: true })).toBe(true);            // opt in and it fires
  });

  it("keeps the door in the table - this is a selector, not a delete", () => {
    const target = door({ lat: 35.20, lng: -80.20, scanned: false });
    expect(isBarren(target)).toBe(true);
    const row = rawDb.prepare("SELECT id, address FROM scan_targets WHERE id=?").get(target) as any;
    expect(row).toBeTruthy();
    expect(row.address).toContain("Dead End Rd");
  });
});

describe("the dead-list ships OFF, and that is the finding", () => {
  it("is off by default for both units", () => {
    // Measured: between a sixth and a third of every door these rules skip sits
    // on ground that fiber actually reaches, while the saving is ~2.5% of the
    // scan. Turning either on by default would trade inventory for rounding.
    expect(barrenCellSkipEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(barrenStreetSkipEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("can still be switched on deliberately", () => {
    expect(barrenCellSkipEnabled({ SCAN_SKIP_BARREN_CELLS: "on" } as any)).toBe(true);
    expect(barrenStreetSkipEnabled({ SCAN_SKIP_BARREN_STREETS: "on" } as any)).toBe(true);
  });
});
