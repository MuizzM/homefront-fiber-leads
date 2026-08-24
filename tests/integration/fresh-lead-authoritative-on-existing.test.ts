// A DOOR THAT ALREADY HAS A LEAD ROW MUST STILL PUBLISH ON THE AUTHORITATIVE RULE.
//
// trg_leads_fresh_update_guard allows a fresh-fiber lead by EITHER path: (a)
// cross-verified with >=2 independent sources, or (b) the AUTHORITATIVE rule -
// Kinetic NEW FIBER + billing N, published on Kinetic's own new-build signal.
//
// The projector's UPDATE path fires that guard (lead_tag is one of its watched
// columns) but used to leave household_segment_type and billing_status untouched,
// so path (b) was evaluated against whatever the existing row held. For a lead
// created by an earlier backfill that is an EMPTY STRING - so the authoritative
// path could only ever be satisfied by an INSERT, and any door that already had a
// lead row was permanently unpublishable. It failed with
// `fresh_fiber_requires_cross_verification`, naming a rule it never needed to meet.
//
// Measured on Salisbury 2026-08-24: 434 doors Kinetic answers NEW FIBER + billing
// N, every one already carrying a half-formed backfill lead, every one rejected.
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let rawDb: import("better-sqlite3").Database;
let record: typeof import("../../server/availabilitySnapshot").recordAvailabilitySnapshot;
let projectConfirmedFreshLeads: typeof import("../../server/freshFiberProjector").projectConfirmedFreshLeads;
let storage: typeof import("../../server/storage").storage;
const TENANT = 1;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-auth-existing-"));
  ({ rawDb } = await import("../../server/db"));
  const s = await import("../../server/storage");
  s.runMigrations();
  storage = s.storage;
  record = (await import("../../server/availabilitySnapshot")).recordAvailabilitySnapshot;
  projectConfirmedFreshLeads = (await import("../../server/freshFiberProjector")).projectConfirmedFreshLeads;
});

/** A scanned door Kinetic answers NEW FIBER + billing N. */
function authoritativeDoor(address: string): number {
  const tid = Number(rawDb.prepare(
    `INSERT INTO scan_targets (address,city,state,zip,lat,lng,tenant_id,source)
     VALUES (?,?,?,?,?,?,?,'osm')`)
    .run(address, "Salisbury", "NC", "28146", 35.67, -80.47, TENANT).lastInsertRowid);
  storage.recordScanTargetResult(tid, {
    fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true, billingStatus: "N",
    availabilityStatus: "checked_available", newlyLive: false, customerSegment: "new_opportunity",
    customerConfidence: "high", customerSignals: [],
  });
  record({
    tenantId: TENANT, scanTargetId: tid, runId: `r-${tid}`, checkedAt: "2026-08-24T23:12:58.000Z",
    conclusive: true, fiberAvailable: true, fiberStatus: "new_fiber",
    householdSegmentType: "NEW FIBER", billingStatus: "N",
    transitionStatus: "baseline_available", apiSource: "kinetic_live", evidenceHash: `h-${tid}`,
  });
  return tid;
}

describe("the authoritative rule reaches doors that already have a lead", () => {
  it("upgrades a half-formed backfill lead instead of failing on cross-verification", () => {
    const address = "315 Teague Rd";
    // The lead an earlier backfill left behind: already marked new_fiber, but with
    // no provenance at all - exactly the shape found in production.
    const existingId = Number(rawDb.prepare(
      `INSERT INTO leads (address,city,state,zip,lat,lng,fiber_status,lead_status,tenant_id,
                          household_segment_type,billing_status,lead_score,created_at,updated_at)
       VALUES (?,?,?,?,?,?, 'unknown','prospect',?, '', 'N', 0, datetime('now'), datetime('now'))`)
      .run(address, "Salisbury", "NC", "28146", 35.67, -80.47, TENANT).lastInsertRowid);
    const tid = authoritativeDoor(address);

    const res = projectConfirmedFreshLeads(TENANT, [tid]);
    expect(res.errors, "no cross-verification rejection: this door never needed that path").toEqual([]);
    expect(res.rejected).toBe(0);
    expect(res.linkedExisting, "the existing lead is upgraded, not duplicated").toBe(1);
    expect(res.created).toBe(0);

    const lead = rawDb.prepare(
      `SELECT id, lead_tag AS tag, household_segment_type AS seg, billing_status AS bill,
              fresh_confirmed_at AS confirmedAt, lead_score AS score, source_scan_target_id AS src
         FROM leads WHERE id=?`).get(existingId) as any;
    expect(lead.id, "same lead row, not a second pin at the address").toBe(existingId);
    expect(lead.tag).toBe("fresh_fiber_confirmed");
    expect(lead.seg, "the segment the guard checks is now on the row").toBe("NEW FIBER");
    expect(lead.bill).toBe("N");
    expect(lead.confirmedAt).toBeTruthy();
    expect(lead.src).toBe(tid);
    // ...and the door is linked back, so it stops showing as unpublished.
    const linked = rawDb.prepare(`SELECT converted_to_lead_id AS lead FROM scan_targets WHERE id=?`).get(tid) as any;
    expect(linked.lead).toBe(existingId);
  });

  it("never ERASES a segment the lead already carried", () => {
    const address = "9 Held Segment Way";
    const existingId = Number(rawDb.prepare(
      `INSERT INTO leads (address,city,state,zip,lat,lng,fiber_status,lead_status,tenant_id,
                          household_segment_type,billing_status,lead_score,created_at,updated_at)
       VALUES (?,?,?,?,?,?, 'unknown','prospect',?, 'TENURED', 'Y', 0, datetime('now'), datetime('now'))`)
      .run(address, "Salisbury", "NC", "28146", 35.67, -80.47, TENANT).lastInsertRowid);
    const tid = authoritativeDoor(address);
    projectConfirmedFreshLeads(TENANT, [tid]);
    const lead = rawDb.prepare(`SELECT household_segment_type AS seg FROM leads WHERE id=?`).get(existingId) as any;
    // The provider's current answer wins where the row was blank; where the row
    // already said something, the write is a fill-in, never a blank-out.
    expect(lead.seg).toBe("NEW FIBER");
  });
});
