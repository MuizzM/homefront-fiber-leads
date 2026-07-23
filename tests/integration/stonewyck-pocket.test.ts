import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyKineticFreshLead } from "../../shared/competitiveEligibility";

// THE STONEWYCK FIXTURE (sanitized) — the missed-pocket failure of 2026-07-23.
// 1315 Stonewyck Dr, Salisbury NC 28146: conclusive Kinetic FIBER + NEW FIBER +
// billing N with NO competitor returned. Rules proven here:
//   • competitor ABSENT → eligible (absence is not evidence),
//   • non-fiber competitor → eligible,
//   • explicit competitor fiber → excluded,
//   • contradictory/unparseable fiber evidence → review,
//   • copper override / NO QUAL service entries never suppress the conclusive
//     fiber qualification,
//   • end-to-end: exactly ONE deduplicated lead with the full verified address.

const STONEWYCK = {
  success: true, errorCode: 0, validationResult: "AddressFound",
  techType: "FIBER", maxQualTechnologyType: "FIBER",
  householdSegmentType: "NEW FIBER", billingStatus: "N",
};

describe("Stonewyck classifier fixtures", () => {
  it("competitor ABSENT → eligible (missing competitor data never blocks)", () => {
    const r = classifyKineticFreshLead({ ...STONEWYCK, competitors: [] });
    expect(r.decision).toBe("fresh_lead");
    expect(r.eligible).toBe(true);
  });
  it("non-fiber competitor → eligible; explicit fiber → excluded; contradictory → review", () => {
    expect(classifyKineticFreshLead({ ...STONEWYCK, competitors: [{ name: "Spectrum", tech: "Cable" }] }).eligible).toBe(true);
    expect(classifyKineticFreshLead({ ...STONEWYCK, competitors: [{ name: "Anyone", tech: "FTTH" }] }).decision).toBe("not_eligible");
    expect(classifyKineticFreshLead({ ...STONEWYCK, competitors: [{ name: "Mystery ISP", tech: "hyperlink" }] }).decision).toBe("competitor_review");
  });
});

describe("Stonewyck end-to-end publication", () => {
  let rawDb: import("better-sqlite3").Database;
  let storage: typeof import("../../server/storage").storage;
  let record: typeof import("../../server/availabilitySnapshot").recordAvailabilitySnapshot;
  let project: typeof import("../../server/freshFiberProjector").projectConfirmedFreshLeads;
  const TENANT = 1;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-stonewyck-"));
    ({ rawDb } = await import("../../server/db"));
    const s = await import("../../server/storage");
    s.runMigrations();
    storage = s.storage;
    record = (await import("../../server/availabilitySnapshot")).recordAvailabilitySnapshot;
    project = (await import("../../server/freshFiberProjector")).projectConfirmedFreshLeads;
  });

  it("publishes exactly ONE deduplicated pin-accurate lead for 1315 Stonewyck Dr", () => {
    const id = Number(rawDb.prepare(
      `INSERT INTO scan_targets (address, city, state, zip, lat, lng, tenant_id, source)
       VALUES ('1315 Stonewyck Dr', 'Salisbury', 'NC', '28146', 35.605598, -80.435109, ?, 'mapbox-deep-seed')`,
    ).run(TENANT).lastInsertRowid);
    const scan = (attempt: number) => {
      storage.recordScanTargetResult(id, {
        fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true, billingStatus: "N",
        availabilityStatus: "checked_available", newlyLive: false,
        customerSegment: "new_opportunity", customerConfidence: "high", customerSignals: [],
      });
      record({
        tenantId: TENANT, scanTargetId: id, runId: `r-stonewyck-${attempt}`,
        checkedAt: new Date(Date.now() + attempt * 60_000).toISOString(),
        conclusive: true, fiberAvailable: true, fiberStatus: "new_fiber",
        householdSegmentType: "NEW FIBER", billingStatus: "N", transitionStatus: "baseline_available",
        apiSource: "kinetic_live",
        competitorName: null, competitorTech: null, // competitor ABSENT — must not block
        evidenceHash: `h-stonewyck-${attempt}`,
      });
      project(TENANT, [id]);
    };
    scan(1);
    scan(2); // recheck — dedup must hold
    const rows = rawDb.prepare(
      `SELECT id, address, city, state, zip, lead_status, lead_tag FROM leads WHERE address LIKE '1315 Stonewyck%' AND tenant_id=?`,
    ).all(TENANT) as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].lead_status).toBe("prospect");
    expect(rows[0].lead_tag).toBe("fresh_fiber_confirmed");
    // Pin-accurate verified address, complete for the card.
    expect(rows[0].city).toBe("Salisbury");
    expect(rows[0].state).toBe("NC");
    expect(rows[0].zip).toBe("28146");
    const pins = storage.getLeadsForMap(TENANT).filter((p: any) => String(p.address).includes("1315 Stonewyck"));
    expect(pins.length).toBe(1);
    expect(pins[0].zip).toBe("28146");
  });

  it("a lit ACTIVE CUSTOMER on new fiber (billing A) publishes no lead but seeds expansion", async () => {
    process.env.EXPANSION_ENABLED = "on";
    const id = Number(rawDb.prepare(
      `INSERT INTO scan_targets (address, city, state, zip, lat, lng, tenant_id, source)
       VALUES ('1321 Stonewyck Dr', 'Salisbury', 'NC', '28146', 35.6058, -80.4348, ?, 'field')`,
    ).run(TENANT).lastInsertRowid);
    storage.recordScanTargetResult(id, {
      fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true, billingStatus: "A",
      availabilityStatus: "checked_available",
    });
    const { triggerExpansionForTargets } = await import("../../server/clusterExpansion");
    const started = triggerExpansionForTargets(TENANT, [id]);
    expect(started).toBe(1); // the lit-pocket evidence expands the neighbors
    const n = (rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE address LIKE '1321 Stonewyck%'`).get() as any).n;
    expect(n).toBe(0); // active customer — correctly NOT a fresh lead
  });
});
