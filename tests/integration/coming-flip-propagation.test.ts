import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * IF ONE TURNS ON, TURN THE WHOLE THING.
 *
 * Fiber is poured by the street, not by the door. When one watched address turns
 * on, its neighbours are the best-evidenced addresses we own - so they are
 * pulled forward to due-now instead of each waiting for its own slot.
 *
 * The failure this prevents is measured, not hypothetical: the Georgia Oak Ln /
 * Landis Oak Way build (32 doors across four street names) went live some time
 * after 2026-07-18 and was noticed five weeks later, by accident.
 *
 * Propagation MARKS ROWS DUE. It never calls the provider - dispatch stays with
 * the sweep's coming lane and its budget.
 */

let rawDb: import("better-sqlite3").Database;
let ledger: typeof import("../../server/comingLedger");

const TENANT = 1;
const OTHER_TENANT = 77;
const NOW = Date.parse("2026-08-22T12:00:00.000Z");
const DAY = 86_400_000;
const BASE_LAT = 35.99;
const BASE_LNG = -78.9;
/** ~111 m per 0.001 degree of latitude. */
const M = 0.001 / 111.32;

/** The real JAN-2027 shape: TENURED + billing N, unserviceable, dated build. */
const comingSoonBody = (eta: string) => ({
  success: true,
  validationResult: "AddressUnserviceableInTerritory",
  maxQual: "NO QUAL",
  address: { householdSegmentType: "TENURED", billingStatus: "N" },
  broadbandService: {
    technologyType: "FUTURE_QUAL_EXTENDED", futureTechnologyType: "FIBER",
    estimatedCompletionDt: eta,
  },
});
/** A settled, live answer: no promise left to keep. */
const liveBody = {
  success: true, validationResult: "AddressFound", exactMatch: true, techType: "FIBER",
  address: { householdSegmentType: "NEW FIBER", billingStatus: "N", addressCatalogDt: "2019-03-11" },
};

function door(id: number, metresNorth = 0, tenant = TENANT): { id: number; address: string; city: string; state: string; zip: string } {
  rawDb.prepare(
    `INSERT INTO scan_targets (id, tenant_id, address, city, state, zip, lat, lng, source, carrier)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, tenant, `${id} Georgia Oak Ln`, "China Grove", "NC", "28023",
        BASE_LAT + metresNorth * M, BASE_LNG, "test", "kinetic");
  return { id, address: `${id} Georgia Oak Ln`, city: "China Grove", state: "NC", zip: "28023" };
}

/** Open a real ledger promise through the real write path. */
function promise(id: number, metresNorth = 0, tenant = TENANT, eta = "2027-01-01"): void {
  const t = door(id, metresNorth, tenant);
  ledger.recordFutureService(tenant, t, {}, comingSoonBody(eta), { nowMs: NOW, log: false });
}

/** The flip: this door's promise closes because fiber actually arrived. */
function turnOn(id: number, tenant = TENANT): void {
  const t = { id, address: `${id} Georgia Oak Ln`, city: "China Grove", state: "NC", zip: "28023" };
  ledger.recordFutureService(tenant, t, {}, liveBody, { nowMs: NOW, fiberAvailable: true, log: false });
}

const watchOf = (id: number): any =>
  rawDb.prepare(`SELECT * FROM coming_soon_watchlist WHERE scan_target_id=?`).get(id);

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-flip-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  ledger = await import("../../server/comingLedger");
  ledger.ensureComingLedgerSchema();
});

beforeEach(() => {
  rawDb.prepare("DELETE FROM coming_soon_watchlist").run();
  rawDb.prepare("DELETE FROM scan_targets").run();
});
afterEach(() => {
  delete process.env.COMING_FLIP_PROPAGATION;
  delete process.env.COMING_FLIP_FANOUT;
  delete process.env.COMING_FLIP_RADIUS_M;
});

describe("cluster flip propagation", () => {
  it("pulls every watched neighbour forward to due-now, at the hot band", () => {
    promise(2001, 0);          // the door that will turn on
    promise(2002, 120);        // neighbours, all well inside the 800 m radius
    promise(2003, 400);
    promise(2004, 700);

    // Before: each is parked on the weekly floor, a week out.
    expect(watchOf(2002).due_at).toBe(NOW + 7 * DAY);

    turnOn(2001);

    for (const id of [2002, 2003, 2004]) {
      const w = watchOf(id);
      expect(w.due_at, `target ${id}`).toBe(NOW);
      expect(w.band, `target ${id}`).toBe("hot");
      expect(w.status, `target ${id}`).toBe("active");
    }
    // The origin's own promise is closed as collected, not left open.
    expect(watchOf(2001).status).toBe("promoted");
  });

  it("wakes nobody when the door that turned on was never on the list", () => {
    promise(2102, 120);
    door(2101, 0);             // a live door with no promise of its own
    turnOn(2101);
    expect(watchOf(2102).due_at).toBe(NOW + 7 * DAY);   // untouched
    expect(watchOf(2102).band).toBe("soon");
  });

  it("leaves watches outside the radius alone", () => {
    promise(2201, 0);
    promise(2202, 300);        // in
    promise(2203, 3000);       // out, ~3 km away
    turnOn(2201);
    expect(watchOf(2202).due_at).toBe(NOW);
    expect(watchOf(2203).due_at).toBe(NOW + 7 * DAY);
  });

  it("never crosses a tenant boundary", () => {
    promise(2301, 0);
    promise(2302, 120, OTHER_TENANT);   // same street, different tenant
    turnOn(2301);
    expect(watchOf(2302).due_at).toBe(NOW + 7 * DAY);
  });

  it("does not postpone expiry: updated_at is an affirmation, not a rumour", () => {
    promise(2401, 0);
    promise(2402, 120);
    const before = watchOf(2402).updated_at;
    turnOn(2401);
    // A neighbour's good news must not keep a dead promise alive forever.
    expect(watchOf(2402).updated_at).toBe(before);
  });

  it("is idempotent: a row already due is not seeded again", () => {
    promise(2501, 0);
    promise(2502, 120);
    const first = ledger.propagateFlip(TENANT, 2501, NOW);
    expect(first.seeded).toBe(1);
    const second = ledger.propagateFlip(TENANT, 2501, NOW);
    expect(second.seeded).toBe(0);
    expect(second.candidates).toBe(0);
  });

  it("honours the fan-out cap and reports what it dropped", () => {
    process.env.COMING_FLIP_FANOUT = "2";
    promise(2601, 0);
    promise(2602, 100);
    promise(2603, 200);
    promise(2604, 300);
    const r = ledger.propagateFlip(TENANT, 2601, NOW);
    expect(r.candidates).toBe(3);
    expect(r.seeded).toBe(2);
    expect(r.dropped).toBe(1);      // surfaced, never silently truncated
  });

  it("respects the kill switch", () => {
    process.env.COMING_FLIP_PROPAGATION = "off";
    promise(2701, 0);
    promise(2702, 120);
    turnOn(2701);
    expect(watchOf(2702).due_at).toBe(NOW + 7 * DAY);
  });

  it("does nothing for an origin with no coordinates", () => {
    promise(2802, 120);
    rawDb.prepare(`INSERT INTO scan_targets (id, tenant_id, address, city, state, zip, lat, lng, source)
      VALUES (?,?,?,?,?,?,NULL,NULL,?)`).run(2801, TENANT, "no geo", "China Grove", "NC", "28023", "test");
    const r = ledger.propagateFlip(TENANT, 2801, NOW);
    expect(r.seeded).toBe(0);
    expect(watchOf(2802).due_at).toBe(NOW + 7 * DAY);
  });
});
