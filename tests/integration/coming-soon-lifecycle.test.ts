import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Coming-Soon lifecycle: recheck counts, promote → archive, age-out junk → history,
 * manual remove → history. The active list stays clean; nothing is hard-deleted.
 */
let storage: typeof import("../../server/storage").storage;
let rawDb: import("better-sqlite3").Database;

const add = (address: string, over: any = {}) =>
  storage.createComingSoon({ tenantId: 1, address, city: "Concord", state: "NC", zip: "28025", reason: "no_service", lastChecked: new Date().toISOString(), ...over } as any);
const activeAddrs = () => storage.getComingSoonAddresses(1).map((r: any) => r.address).sort();
const historyAddrs = () => storage.getComingSoonHistory(1).map((r: any) => r.address).sort();

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-cslife-"));
  ({ storage } = await import("../../server/storage"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
});
beforeEach(() => { rawDb.prepare("DELETE FROM coming_soon_addresses").run(); });

describe("coming-soon lifecycle", () => {
  it("recheck increments checkCount", () => {
    const cs = add("1 Recheck St");
    expect((cs as any).checkCount).toBe(0);
    storage.markComingSoonChecked(cs.id);
    storage.markComingSoonChecked(cs.id);
    const row: any = rawDb.prepare("SELECT check_count FROM coming_soon_addresses WHERE id=?").get(cs.id);
    expect(row.check_count).toBe(2);
  });

  it("active list excludes archived; history includes them", () => {
    const a = add("10 Active St");
    const b = add("20 Gone St");
    expect(activeAddrs()).toEqual(["10 Active St", "20 Gone St"]);
    storage.archiveComingSoon(b.id, "manual");
    expect(activeAddrs()).toEqual(["10 Active St"]);      // junk removed from active
    expect(historyAddrs()).toEqual(["20 Gone St"]);        // but kept as history
    const arch: any = rawDb.prepare("SELECT status, archived_reason, archived_at FROM coming_soon_addresses WHERE id=?").get(b.id);
    expect(arch.status).toBe("removed");
    expect(arch.archived_reason).toBe("manual");
    expect(arch.archived_at).toBeTruthy();
  });

  it("promote archives as 'promoted' with the lead id, out of the active list", () => {
    const cs = add("30 Live St");
    storage.markComingSoonAvailable(cs.id, 999);
    expect(activeAddrs()).toEqual([]);
    const row: any = rawDb.prepare("SELECT status, converted_to_lead_id, fiber_available FROM coming_soon_addresses WHERE id=?").get(cs.id);
    expect(row.status).toBe("promoted");
    expect(row.converted_to_lead_id).toBe(999);
    expect(row.fiber_available).toBe(1);
    expect(historyAddrs()).toContain("30 Live St");
  });

  it("age-out sweep retires over-checked and too-old rows, keeps fresh ones", () => {
    const fresh = add("40 Fresh St");                                  // checkCount 0, new
    const overChecked = add("50 Stale St");
    rawDb.prepare("UPDATE coming_soon_addresses SET check_count=60 WHERE id=?").run(overChecked.id);
    const tooOld = add("60 Ancient St");
    rawDb.prepare("UPDATE coming_soon_addresses SET created_at=? WHERE id=?")
      .run(new Date(Date.now() - 200 * 86400000).toISOString(), tooOld.id);

    const archived = storage.ageOutComingSoon(45, 120);
    expect(archived).toBe(2);                                           // stale + ancient
    expect(activeAddrs()).toEqual(["40 Fresh St"]);                    // fresh survives
    expect(historyAddrs().sort()).toEqual(["50 Stale St", "60 Ancient St"]);
    const r: any = rawDb.prepare("SELECT status, archived_reason FROM coming_soon_addresses WHERE id=?").get(overChecked.id);
    expect(r.status).toBe("aged_out");
    expect(r.archived_reason).toBe("aged_out");
  });

  it("age-out never retires a row that already went live (fiberAvailable)", () => {
    const cs = add("70 Won St");
    storage.markComingSoonAvailable(cs.id, 1);   // promoted (fiberAvailable=1)
    rawDb.prepare("UPDATE coming_soon_addresses SET check_count=99 WHERE id=?").run(cs.id);
    const archived = storage.ageOutComingSoon(45, 120);
    expect(archived).toBe(0);                     // already promoted, not re-archived as junk
  });
});
