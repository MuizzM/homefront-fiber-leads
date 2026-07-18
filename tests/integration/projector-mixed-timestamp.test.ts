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
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-snap-canon-"));
  ({ rawDb } = await import("../../server/db"));
  const s = await import("../../server/storage");
  s.runMigrations();
  storage = s.storage;
  record = (await import("../../server/availabilitySnapshot")).recordAvailabilitySnapshot;
  projectConfirmedFreshLeads = (await import("../../server/freshFiberProjector")).projectConfirmedFreshLeads;
});

function target(address: string): number {
  return Number(rawDb.prepare(`INSERT INTO scan_targets (address,city,state,zip,lat,lng,tenant_id,source) VALUES (?,?,?,?,?,?,?,'osm')`)
    .run(address, "Inman", "SC", "29349", 35.02, -82.08, TENANT).lastInsertRowid);
}

describe("canonical availability_snapshots — mixed formats impossible; failed can't outrank/erase a Fresh Lead", () => {
  it("the DB constraint rejects any snapshot lacking an integer epoch (no mixed formats)", () => {
    const tid = target("1 Guard St");
    // A raw insert with only a TEXT checked_at (the old defect) is rejected.
    expect(() => rawDb.prepare(`INSERT INTO availability_snapshots
      (tenant_id,scan_target_id,run_id,checked_at,conclusive,transition_status,evidence_hash)
      VALUES (?,?,NULL,'2026-07-16T14:56:24.230Z',1,'baseline_available','h')`).run(TENANT, tid))
      .toThrow(/checked_at_epoch_must_be_integer/);
    // A non-integer (text) epoch is likewise rejected.
    expect(() => rawDb.prepare(`INSERT INTO availability_snapshots
      (tenant_id,scan_target_id,run_id,checked_at_epoch,conclusive,transition_status,evidence_hash)
      VALUES (?,?,NULL,'not-a-number',1,'baseline_available','h')`).run(TENANT, tid))
      .toThrow(/checked_at_epoch_must_be_integer/);
    // The shared writer always supplies an integer epoch, so it succeeds.
    expect(() => record({ tenantId: TENANT, scanTargetId: tid, conclusive: true, transitionStatus: "baseline_available", evidenceHash: "ok" })).not.toThrow();
    expect(typeof (rawDb.prepare(`SELECT checked_at_epoch AS e FROM availability_snapshots WHERE scan_target_id=? ORDER BY id DESC LIMIT 1`).get(tid) as any).e).toBe("number");
  });

  it("a NEWER conclusive NEW FIBER wins over an OLDER failed attempt → exactly one Fresh Lead", () => {
    const tid = target("615 Nettie Dr");
    // an OLDER failed attempt (blocked) — retained for diagnostics only (conclusive=0)
    record({ tenantId: TENANT, scanTargetId: tid, runId: "r-fail-old", checkedAt: "2026-07-16T14:56:24.230Z", conclusive: false, transitionStatus: "check_failed", apiSource: "failed", blocked: true, error: "403 throttle", evidenceHash: "fail-old" });
    // a NEWER conclusive NEW FIBER + billing N — this is the current state
    storage.recordScanTargetResult(tid, { fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true, billingStatus: "N", availabilityStatus: "checked_available", newlyLive: false, customerSegment: "new_opportunity", customerConfidence: "high", customerSignals: [] });
    record({ tenantId: TENANT, scanTargetId: tid, runId: "r-good", checkedAt: "2026-07-16T15:06:15.000Z", conclusive: true, fiberAvailable: true, fiberStatus: "new_fiber", householdSegmentType: "NEW FIBER", billingStatus: "N", transitionStatus: "baseline_available", apiSource: "kinetic_live", evidenceHash: "good" });

    const res = projectConfirmedFreshLeads(TENANT, [tid]);
    expect(res.published).toBeGreaterThanOrEqual(1);
    const leads = rawDb.prepare(`SELECT lead_tag AS tag, billing_status AS b, household_segment_type AS seg FROM leads WHERE lower(address)='615 nettie dr'`).all() as any[];
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ tag: "fresh_fiber_confirmed", b: "N", seg: "NEW FIBER" });
  });

  it("a LATER failed attempt cannot erase a prior Fresh Lead or clear current state", () => {
    const tid = target("158 Glassy Dr");
    storage.recordScanTargetResult(tid, { fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true, billingStatus: "N", availabilityStatus: "checked_available", newlyLive: false, customerSegment: "new_opportunity", customerConfidence: "high", customerSignals: [] });
    record({ tenantId: TENANT, scanTargetId: tid, runId: "g1", checkedAt: "2026-07-16T15:00:00.000Z", conclusive: true, fiberAvailable: true, fiberStatus: "new_fiber", householdSegmentType: "NEW FIBER", billingStatus: "N", transitionStatus: "baseline_available", apiSource: "kinetic_live", evidenceHash: "g1" });
    expect(projectConfirmedFreshLeads(TENANT, [tid]).published).toBeGreaterThanOrEqual(1);

    // A later failed attempt: history grows, but current state + the lead are untouched.
    record({ tenantId: TENANT, scanTargetId: tid, runId: "f1", checkedAt: "2026-07-16T16:00:00.000Z", conclusive: false, transitionStatus: "check_failed", apiSource: "failed", blocked: true, error: "timeout", evidenceHash: "f1" });
    projectConfirmedFreshLeads(TENANT, [tid]);
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE lower(address)='158 glassy dr'`).get() as any).n).toBe(1);
    const st = rawDb.prepare(`SELECT last_is_new_fiber AS nf, last_billing_status AS b, last_fiber_status AS fs FROM scan_targets WHERE id=?`).get(tid) as any;
    expect(st).toMatchObject({ nf: 1, b: "N", fs: "new_fiber" });
    // The failed attempt IS retained in history (diagnostics).
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM availability_snapshots WHERE scan_target_id=? AND conclusive=0`).get(tid) as any).n).toBe(1);
  });

  it("a later conclusive billing Y transitions a Fresh Lead to Now Active (same lead, not deleted)", () => {
    const tid = target("258 Ranier Dr");
    // First conclusive answer: NEW FIBER + billing N → Fresh Lead.
    storage.recordScanTargetResult(tid, { fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true, billingStatus: "N", availabilityStatus: "checked_available", newlyLive: false, customerSegment: "new_opportunity", customerConfidence: "high", customerSignals: [] });
    record({ tenantId: TENANT, scanTargetId: tid, runId: "n1", checkedAt: "2026-07-16T15:00:00.000Z", conclusive: true, fiberAvailable: true, fiberStatus: "new_fiber", householdSegmentType: "NEW FIBER", billingStatus: "N", transitionStatus: "baseline_available", apiSource: "kinetic_live", evidenceHash: "rn1" });
    projectConfirmedFreshLeads(TENANT, [tid]);
    const lead = rawDb.prepare(`SELECT id,lead_status AS status FROM leads WHERE lower(address)='258 ranier dr'`).get() as any;
    expect(lead).toBeTruthy();
    expect(lead.status).not.toBe("now_active");

    // A genuinely NEWER conclusive NEW FIBER + billing Y — the prospect signed up.
    storage.recordScanTargetResult(tid, { fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true, billingStatus: "Y", availabilityStatus: "checked_available", newlyLive: false, customerSegment: "existing_customer", customerConfidence: "high", customerSignals: [] });
    record({ tenantId: TENANT, scanTargetId: tid, runId: "y1", checkedAt: "2026-07-16T18:00:00.000Z", conclusive: true, fiberAvailable: true, fiberStatus: "new_fiber", householdSegmentType: "NEW FIBER", billingStatus: "Y", transitionStatus: "still_available", apiSource: "kinetic_live", evidenceHash: "ry1" });
    projectConfirmedFreshLeads(TENANT, [tid]);

    const after = rawDb.prepare(`SELECT id,lead_status AS status FROM leads WHERE lower(address)='258 ranier dr'`).get() as any;
    expect(after.id).toBe(lead.id); // SAME lead — not deleted, not duplicated
    expect(after.status).toBe("now_active");
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE lower(address)='258 ranier dr'`).get() as any).n).toBe(1);
  });
});

describe("canonical-address dedup — suffix/case variants attach, never duplicate", () => {
  it("a Kinetic-canonical variant of an existing lead's address attaches to it", async () => {
    // Existing lead minted from the OSM-form address.
    const tidA = target("338 Farrell Road");
    (storage as any).recordScanTargetResult(tidA, { fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true, billingStatus: "N", availabilityStatus: "checked_available", newlyLive: false, customerSegment: "new_opportunity", customerConfidence: "high", customerSignals: [] });
    record({ tenantId: TENANT, scanTargetId: tidA, runId: "dup-a", checkedAt: "2026-07-18T16:25:00.000Z", conclusive: true, fiberAvailable: true, fiberStatus: "new_fiber", householdSegmentType: "NEW FIBER", billingStatus: "N", transitionStatus: "baseline_available", apiSource: "kinetic_live", evidenceHash: "dup-a" });
    expect(projectConfirmedFreshLeads(TENANT, [tidA]).created).toBe(1);

    // A SECOND scan target for the SAME house in Kinetic's canonical form
    // ("Road"→"RD", ALL CAPS) — must attach to the existing lead, not mint #2
    // (prod defect: lead #11318 duplicated #11198 exactly this way).
    const tidB = target("338 FARRELL RD");
    (storage as any).recordScanTargetResult(tidB, { fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true, billingStatus: "N", availabilityStatus: "checked_available", newlyLive: false, customerSegment: "new_opportunity", customerConfidence: "high", customerSignals: [] });
    record({ tenantId: TENANT, scanTargetId: tidB, runId: "dup-b", checkedAt: "2026-07-18T17:35:00.000Z", conclusive: true, fiberAvailable: true, fiberStatus: "new_fiber", householdSegmentType: "NEW FIBER", billingStatus: "N", transitionStatus: "baseline_available", apiSource: "kinetic_live", evidenceHash: "dup-b" });
    const res = projectConfirmedFreshLeads(TENANT, [tidB]);
    expect(res.created).toBe(0);
    expect(res.published).toBeGreaterThanOrEqual(1);
    const rows = rawDb.prepare(`SELECT id FROM leads WHERE lower(replace(address,'road','rd')) LIKE '338 farrell%'`).all() as any[];
    expect(rows).toHaveLength(1);
  });
});
