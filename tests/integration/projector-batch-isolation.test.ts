import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A single bad candidate must skip ONLY itself — never roll back or abort the
// whole batch. The old projector published every candidate inside one
// transaction, so one LEAD_ADDRESS_TENANT_CONFLICT throw discarded up to
// hundreds of confirmed green leads at once (observed live: 72 new_fiber/N
// targets scanned, zero leads minted). This locks in per-candidate isolation.

let rawDb: import("better-sqlite3").Database;
let record: typeof import("../../server/availabilitySnapshot").recordAvailabilitySnapshot;
let projectConfirmedFreshLeads: typeof import("../../server/freshFiberProjector").projectConfirmedFreshLeads;
let storage: typeof import("../../server/storage").storage;
const TENANT = 1;
const OTHER_TENANT = 2;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-projector-batch-"));
  ({ rawDb } = await import("../../server/db"));
  const s = await import("../../server/storage");
  s.runMigrations();
  storage = s.storage;
  record = (await import("../../server/availabilitySnapshot")).recordAvailabilitySnapshot;
  projectConfirmedFreshLeads = (await import("../../server/freshFiberProjector")).projectConfirmedFreshLeads;
});

function freshTarget(address: string): number {
  const id = Number(rawDb.prepare(`INSERT INTO scan_targets (address,city,state,zip,lat,lng,tenant_id,source) VALUES (?,?,?,?,?,?,?,'osm')`)
    .run(address, "Inman", "SC", "29349", 35.02, -82.08, TENANT).lastInsertRowid);
  storage.recordScanTargetResult(id, { fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true, billingStatus: "N", availabilityStatus: "checked_available", newlyLive: false, customerSegment: "new_opportunity", customerConfidence: "high", customerSignals: [] });
  record({ tenantId: TENANT, scanTargetId: id, runId: `r-${id}`, checkedAt: new Date().toISOString(), conclusive: true, fiberAvailable: true, fiberStatus: "new_fiber", householdSegmentType: "NEW FIBER", billingStatus: "N", transitionStatus: "baseline_available", apiSource: "kinetic_live", evidenceHash: `h-${id}` });
  return id;
}

describe("projector per-candidate isolation - one bad door never discards the batch", () => {
  it("publishes every clean NEW FIBER + N candidate even when one collides with a foreign tenant", () => {
    const clean = [freshTarget("10 Clean St"), freshTarget("20 Clean St"), freshTarget("30 Clean St")];

    // A foreign-tenant lead at the SAME normalized address as one more target —
    // this is what used to throw LEAD_ADDRESS_TENANT_CONFLICT and abort the whole
    // transaction. (findByCityLeads is now tenant-scoped, so this can't even
    // enter the index; the isolation guard is the belt-and-braces backstop.)
    rawDb.prepare(`INSERT INTO leads (address,city,state,zip,lat,lng,lead_status,tenant_id,carrier,canonical_key,created_at,updated_at)
      VALUES ('40 Collide St','Inman','SC','29349',35.02,-82.08,'prospect',?,'kinetic',NULL,datetime('now'),datetime('now'))`).run(OTHER_TENANT);
    const collide = freshTarget("40 Collide St");

    const res = projectConfirmedFreshLeads(TENANT, [...clean, collide]);

    // All three clean doors became this tenant's leads — the batch did NOT abort.
    for (const address of ["10 clean st", "20 clean st", "30 clean st"]) {
      const rows = rawDb.prepare(`SELECT lead_tag AS tag FROM leads WHERE lower(address)=? AND tenant_id=?`).all(address, TENANT) as any[];
      expect(rows, address).toHaveLength(1);
      expect(rows[0].tag).toBe("fresh_fiber_confirmed");
    }
    expect(res.published).toBeGreaterThanOrEqual(3);
    // The projector returned normally (no throw) and carries an errors array.
    expect(Array.isArray(res.errors)).toBe(true);
  });
});
