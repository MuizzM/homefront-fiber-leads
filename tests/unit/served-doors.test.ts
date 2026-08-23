import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * DOORS THAT ALREADY HAVE SERVICE.
 *
 * Fiber being live is not the same as the door being sellable. The lead
 * projector only publishes NEW FIBER + billing N, so an already-served house is
 * filtered out upstream and never becomes a pin - which left a rep unable to
 * tell an open door from one that is taken. Measured live on Howard St /
 * Hilbert Rd in Rockwell: 8 of 10 fiber doors already had an account.
 *
 * The signal is dominated by tenured_fiber (8,679 NC doors) rather than
 * customer_segment (250), which is why the predicate cannot key on segment
 * alone - doing so would miss 98% of them.
 */
let rawDb: import("better-sqlite3").Database;
let served: typeof import("../../server/servedDoors");
const T = 1;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-served-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  served = await import("../../server/servedDoors");
});

let seq = 0;
function door(o: { lat: number; lng: number; status?: string; segment?: string; account?: string; tenant?: number }) {
  const id = ++seq + 7000;
  rawDb.prepare(`INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,source,
                   last_fiber_status,last_customer_segment)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, o.tenant ?? T, `${id} Served Rd`, "Rockwell", "NC", "28138", o.lat, o.lng, "test",
         o.status ?? null, o.segment ?? "unknown");
  if (o.account) {
    try { rawDb.prepare(`UPDATE scan_targets SET account_number=? WHERE id=?`).run(o.account, id); }
    catch { /* column added by ensureAccountSchema in prod */ }
  }
  return id;
}

const WIN = { minLat: 35.50, maxLat: 35.60, minLng: -80.50, maxLng: -80.40 };

describe("servedDoorsInBbox", () => {
  beforeAll(async () => {
    (await import("../../server/customerAccount")).ensureAccountSchema();
    door({ lat: 35.55, lng: -80.45, status: "tenured_fiber" });
    door({ lat: 35.55, lng: -80.44, segment: "existing_customer" });
    door({ lat: 35.55, lng: -80.43, account: "000000123" });
    door({ lat: 35.55, lng: -80.42, status: "new_fiber", segment: "new_opportunity" }); // sellable
    door({ lat: 35.55, lng: -80.41, status: "no_service" });                            // nothing there
    door({ lat: 35.90, lng: -80.45, status: "tenured_fiber" });                         // outside the window
    door({ lat: 35.55, lng: -80.46, status: "tenured_fiber", tenant: 999 });            // another tenant
  });

  it("returns only doors that are actually taken, with the reason", () => {
    const { doors } = served.servedDoorsInBbox(T, WIN);
    const reasons = doors.map((d) => d.reason).sort();
    expect(reasons).toEqual(["account_on_file", "existing_customer", "tenured"]);
  });

  it("never returns a sellable door - that is the whole point", () => {
    const { doors } = served.servedDoorsInBbox(T, WIN);
    for (const d of doors) {
      const row = rawDb.prepare(`SELECT last_customer_segment seg FROM scan_targets WHERE id=?`).get(d.id) as any;
      expect(row.seg, "an open door must never be painted as taken").not.toBe("new_opportunity");
    }
  });

  it("respects the viewport", () => {
    expect(served.servedDoorsInBbox(T, WIN).doors.every((d) => d.lat <= WIN.maxLat && d.lat >= WIN.minLat)).toBe(true);
    const far = served.servedDoorsInBbox(T, { minLat: 34.0, maxLat: 34.1, minLng: -81.0, maxLng: -80.9 });
    expect(far.doors).toHaveLength(0);
  });

  it("is tenant-scoped", () => {
    const mine = served.servedDoorsInBbox(T, WIN).doors.map((d) => d.id);
    const theirs = served.servedDoorsInBbox(999, WIN).doors.map((d) => d.id);
    expect(mine.some((id) => theirs.includes(id)), "no door appears for two tenants").toBe(false);
    expect(theirs.length).toBe(1);
  });

  it("says when it truncated instead of silently dropping pins", () => {
    const out = served.servedDoorsInBbox(T, WIN, 1);
    expect(out.doors).toHaveLength(1);
    expect(out.truncated).toBe(true);
    expect(served.servedDoorsInBbox(T, WIN, 50).truncated).toBe(false);
  });
});
