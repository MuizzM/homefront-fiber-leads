import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The dfAddressId watchlist — the moat: save in-fabric, not-yet-live addresses with
 * Kinetic's own key, so the nightly recheck can catch a "went live" flip by EXACT
 * key and promote it to a lead the same night. These test the data layer that
 * powers it (dedup by df id, backfill, the recheck work-list, and promotion),
 * with zero network.
 */
let storage: typeof import("../../server/storage").storage;
let rawDb: import("better-sqlite3").Database;

const CS = (over: any = {}) => ({ address: "1 Watch St", city: "Concord", state: "NC", zip: "28025", tenantId: null, reason: "no_service", ...over });

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-watch-"));
  ({ storage } = await import("../../server/storage"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
});
beforeEach(() => { rawDb.exec("DELETE FROM coming_soon_addresses; DELETE FROM leads;"); });

describe("dfAddressId watchlist", () => {
  it("upserts a watch address keyed by dfAddressId, dedup on re-sight (no duplicate)", () => {
    storage.upsertComingSoonByDfAddressId(CS({ dfAddressId: "8000000000000000272349", householdSegmentType: "PROSPECT", reason: "prospect" }));
    storage.upsertComingSoonByDfAddressId(CS({ dfAddressId: "8000000000000000272349", householdSegmentType: "COMING SOON", reason: "coming_soon" })); // re-sight
    const rows = rawDb.prepare("SELECT * FROM coming_soon_addresses").all() as any[];
    expect(rows).toHaveLength(1);                                   // deduped, not duplicated
    expect(rows[0].household_segment_type).toBe("COMING SOON");     // refreshed
    expect(rows[0].df_address_id).toBe("8000000000000000272349");
  });

  it("backfills the dfAddressId onto a legacy address-only row (no collision)", () => {
    storage.createComingSoon(CS({ reason: "copper_only" }) as any);  // legacy row, no df id
    storage.upsertComingSoonByDfAddressId(CS({ dfAddressId: "8000000000000000430393" })); // same address, now with df
    const rows = rawDb.prepare("SELECT * FROM coming_soon_addresses").all() as any[];
    expect(rows).toHaveLength(1);                                   // backfilled in place, no dup
    expect(rows[0].df_address_id).toBe("8000000000000000430393");
  });

  it("getComingSoonWithDfId returns only df-keyed, not-yet-converted rows, oldest-checked first", () => {
    storage.upsertComingSoonByDfAddressId(CS({ address: "A St", dfAddressId: "8000000000000000000001" }));
    storage.upsertComingSoonByDfAddressId(CS({ address: "B St", dfAddressId: "8000000000000000000002" }));
    storage.createComingSoon(CS({ address: "C St" }) as any);       // no df → excluded
    const work = storage.getComingSoonWithDfId();
    expect(work.map((w: any) => w.address).sort()).toEqual(["A St", "B St"]);
  });

  it("promotion: marking available removes it from the recheck work-list", () => {
    const row = storage.upsertComingSoonByDfAddressId(CS({ dfAddressId: "8000000000000000999999" }));
    expect(storage.getComingSoonWithDfId()).toHaveLength(1);
    // Simulate the nightly promote: create the lead, mark the watch row available.
    const up = storage.upsertLeadByAddress({ address: row.address, city: row.city, state: row.state, zip: row.zip, fiberStatus: "new_fiber", isNewFiber: true, dfAddressId: row.dfAddressId } as any);
    storage.markComingSoonAvailable(row.id, up.lead.id);
    expect(storage.getComingSoonWithDfId()).toHaveLength(0);        // no longer rechecked
    const cs = rawDb.prepare("SELECT * FROM coming_soon_addresses WHERE id=?").get(row.id) as any;
    expect(cs.fiber_available).toBe(1);
    expect(cs.converted_to_lead_id).toBe(up.lead.id);
    expect((rawDb.prepare("SELECT COUNT(*) c FROM leads WHERE is_new_fiber=1").get() as any).c).toBe(1);
  });
});
