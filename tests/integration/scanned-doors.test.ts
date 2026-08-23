import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * SCANNED DOORS ON THE FIELD MAP.
 *
 * The tag is the whole product here. TENURED means Kinetic has plant and
 * history at an address; it does NOT mean anyone is paying. Collapsing those
 * two into one "already served" colour would tell a rep to walk past 6,574
 * workable doors in the current data, so the split is what these tests defend.
 *
 * The first version of this read model also queried `account_number`, a column
 * that exists on no table in this schema, so every request threw and the
 * client's `if (!r.ok) return` swallowed it - the layer silently never drew.
 * The executes-at-all test below is deliberately not redundant with the tag
 * tests: it is the one that would have caught that.
 */
let rawDb: import("better-sqlite3").Database;
let mod: typeof import("../../server/scannedDoors");

const TENANT = 1;
// A window comfortably around the fixtures below.
const WINDOW = { minLat: 35.50, maxLat: 35.60, minLng: -80.50, maxLng: -80.35 };

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-doors-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  mod = await import("../../server/scannedDoors");
});

let seq = 0;
function door(o: {
  status?: string | null; newFiber?: number; billing?: string | null;
  avail?: number; segment?: string | null; scanned?: boolean; lat?: number; lng?: number;
}): number {
  const id = ++seq + 900_000;
  rawDb.prepare(
    `INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,source,
       last_fiber_status,last_is_new_fiber,last_billing_status,last_fiber_available,
       last_customer_segment,last_scanned_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, TENANT, `${id} Palmer Cir`, "Rockwell", "NC", "28138",
    o.lat ?? 35.55, o.lng ?? -80.42, "test",
    o.status ?? null, o.newFiber ?? 0, o.billing ?? null, o.avail ?? 0,
    // NOT NULL in the real schema; 'unknown' is what 89% of live rows carry.
    o.segment ?? "unknown", o.scanned === false ? null : "2026-08-23T12:00:00.000Z");
  return id;
}
const tagOf = (id: number) =>
  mod.scannedDoorsInBbox(TENANT, WINDOW).doors.find((d) => d.id === id)?.tag;

describe("scanned doors read model", () => {
  it("runs at all, against the real schema", () => {
    // Every column this query names must exist. An earlier version referenced
    // one that did not and threw on every single request.
    expect(() => mod.scannedDoorsInBbox(TENANT, WINDOW)).not.toThrow();
  });

  it("tags NEW FIBER with no account as the sellable door", () => {
    const id = door({ status: "new_fiber", newFiber: 1, billing: "N", avail: 1 });
    expect(tagOf(id)).toBe("new_fiber");
  });

  it("tags TENURED with an active account as taken", () => {
    const id = door({ status: "tenured_fiber", billing: "A", avail: 1 });
    expect(tagOf(id)).toBe("tenured_active");
  });

  it("does NOT call a tenured door taken when nobody is billed for it", () => {
    // The finding this whole split exists for: 6,574 doors in the live data are
    // TENURED with no active billing. Painting them blue hides real work.
    const id = door({ status: "tenured_fiber", billing: "N", avail: 1 });
    expect(tagOf(id)).toBe("fiber_open");
  });

  it("treats an explicit existing_customer segment as taken", () => {
    const id = door({ status: "tenured_fiber", billing: null, segment: "existing_customer", avail: 1 });
    expect(tagOf(id)).toBe("tenured_active");
  });

  it("counts NEW FIBER that is already billed as taken, not sellable", () => {
    const id = door({ status: "new_fiber", newFiber: 1, billing: "A", avail: 1 });
    expect(tagOf(id)).toBe("tenured_active");
  });

  it("omits doors we have never scanned", () => {
    const id = door({ status: "new_fiber", newFiber: 1, billing: "N", avail: 1, scanned: false });
    expect(tagOf(id)).toBeUndefined();
  });

  it("omits doors with no fiber verdict, which would bury the street in grey", () => {
    const copper = door({ status: "copper", billing: "N" });
    const none = door({ status: "no_service" });
    expect(tagOf(copper)).toBeUndefined();
    expect(tagOf(none)).toBeUndefined();
  });

  it("excludes doors outside the window", () => {
    const far = door({ status: "new_fiber", newFiber: 1, billing: "N", avail: 1, lat: 36.9, lng: -79.1 });
    expect(tagOf(far)).toBeUndefined();
  });

  it("reports truncation honestly instead of silently dropping pins", () => {
    for (let i = 0; i < 4; i++) door({ status: "new_fiber", newFiber: 1, billing: "N", avail: 1 });
    const out = mod.scannedDoorsInBbox(TENANT, WINDOW, 2);
    expect(out.doors.length).toBe(2);
    expect(out.truncated).toBe(true);
  });

  it("labels every tag it can return", () => {
    const out = mod.scannedDoorsInBbox(TENANT, WINDOW);
    expect(out.doors.length).toBeGreaterThan(0);
    for (const d of out.doors) {
      expect(mod.DOOR_TAG_LABEL[d.tag]).toBeTruthy();
      expect(d.label).toBe(mod.DOOR_TAG_LABEL[d.tag]);
    }
  });
});

/**
 * The connection the whole feature is: a scan the engine runs with
 * publishLeads must end up as a tagged pin the rep can see.
 *
 * This is the gap that motivated the work. The scan runners wrote their own
 * tables and never touched scan_targets.last_scanned_at, so a door could be
 * scanned, classified and counted while the field map still showed nothing.
 * Asserting the two halves separately would not have caught it; only walking
 * the chain does.
 */
describe("a published scan becomes a pin on the field map", () => {
  it("puts a NEW FIBER answer on the map tagged New Fiber", async () => {
    const engine = await import("../../server/mpboxScanEngine");
    const id = door({ scanned: false, lat: 35.551, lng: -80.421 });
    // Not on the map yet: nothing has answered for it.
    expect(tagOf(id)).toBeUndefined();

    const scanId = "e2e_new_fiber";
    rawDb.prepare(
      `INSERT INTO scan_runs (id,tenant_id,kind,label,city,state,budget,status)
       VALUES (?,?,'area','e2e','Rockwell','NC',1,'running')`).run(scanId, TENANT);

    await engine.runIncrementalScan({
      scanId, tenantId: TENANT, publishLeads: true, source: "test-e2e",
      records: [{
        targetId: id, address: `${id} Palmer Cir`, city: "Rockwell", state: "NC", zip: "28138",
        lastFiberStatus: "new_fiber", isNewFiber: 1, billingStatus: "N",
        customerSegment: null, fiberAvailable: 1,
      } as any],
      // The classifier returns ClassifierEvidence itself; the engine derives
      // the tenured/freshFiber verdict from it via the store's classify().
      classify: async () => ({
        lastFiberStatus: "new_fiber", isNewFiber: 1, billingStatus: "N", fiberAvailable: 1,
        householdSegmentType: "NEW FIBER", lat: 35.551, lng: -80.421,
      }),
    });

    expect(tagOf(id)).toBe("new_fiber");
  });

  it("puts a TENURED answer with an active account on the map tagged Tenured", async () => {
    const engine = await import("../../server/mpboxScanEngine");
    const id = door({ scanned: false, lat: 35.552, lng: -80.422 });
    expect(tagOf(id)).toBeUndefined();

    const scanId = "e2e_tenured";
    rawDb.prepare(
      `INSERT INTO scan_runs (id,tenant_id,kind,label,city,state,budget,status)
       VALUES (?,?,'area','e2e','Rockwell','NC',1,'running')`).run(scanId, TENANT);

    await engine.runIncrementalScan({
      scanId, tenantId: TENANT, publishLeads: true, source: "test-e2e",
      records: [{
        targetId: id, address: `${id} Palmer Cir`, city: "Rockwell", state: "NC", zip: "28138",
        lastFiberStatus: "tenured_fiber", isNewFiber: 0, billingStatus: "A",
        customerSegment: null, fiberAvailable: 1,
      } as any],
      classify: async () => ({
        lastFiberStatus: "tenured_fiber", isNewFiber: 0, billingStatus: "A", fiberAvailable: 1,
        householdSegmentType: "TENURED", lat: 35.552, lng: -80.422,
      }),
    });

    expect(tagOf(id)).toBe("tenured_active");
  });
});
