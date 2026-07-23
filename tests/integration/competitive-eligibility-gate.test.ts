import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The competitive-eligibility gate enforced at the projector: a NEW FIBER + N
// house publishes ONLY when the competitive landscape is clear of non-Kinetic
// fiber. Spectrum-cable/satellite/none → publish; a fiber competitor or an
// ambiguous competitor → never publish, and RETRACT an existing lead.

let rawDb: import("better-sqlite3").Database;
let record: typeof import("../../server/availabilitySnapshot").recordAvailabilitySnapshot;
let project: typeof import("../../server/freshFiberProjector").projectConfirmedFreshLeads;
let storage: typeof import("../../server/storage").storage;
const TENANT = 1;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-comp-elig-"));
  ({ rawDb } = await import("../../server/db"));
  const s = await import("../../server/storage");
  s.runMigrations();
  storage = s.storage;
  record = (await import("../../server/availabilitySnapshot")).recordAvailabilitySnapshot;
  project = (await import("../../server/freshFiberProjector")).projectConfirmedFreshLeads;
});

function freshTarget(address: string, competitorName: string | null, competitorTech: string | null): number {
  const id = Number(rawDb.prepare(`INSERT INTO scan_targets (address,city,state,zip,lat,lng,tenant_id,source) VALUES (?,?,?,?,?,?,?,'osm')`)
    .run(address, "Concord", "NC", "28025", 35.4 + Math.random() / 1e4, -80.5 - Math.random() / 1e4, TENANT).lastInsertRowid);
  storage.recordScanTargetResult(id, { fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true, billingStatus: "N", availabilityStatus: "checked_available", newlyLive: false, customerSegment: "new_opportunity", customerConfidence: "high", customerSignals: [] });
  record({
    tenantId: TENANT, scanTargetId: id, runId: `r-${id}`, checkedAt: new Date().toISOString(),
    conclusive: true, fiberAvailable: true, fiberStatus: "new_fiber",
    householdSegmentType: "NEW FIBER", billingStatus: "N", transitionStatus: "baseline_available",
    apiSource: "kinetic_live", competitorName, competitorTech, evidenceHash: `h-${id}`,
  });
  return id;
}
const leadCount = (address: string) =>
  (rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE lower(address)=lower(?) AND tenant_id=?`).get(address, TENANT) as any).n;
const leadStatus = (address: string) =>
  (rawDb.prepare(`SELECT lead_status s FROM leads WHERE lower(address)=lower(?) AND tenant_id=?`).get(address, TENANT) as any)?.s;

describe("competitive eligibility gate — projector enforcement", () => {
  it("publishes NEW FIBER + N with Spectrum-cable competition", () => {
    const t = freshTarget("10 Spectrum St", "Spectrum", "Cable");
    project(TENANT, [t]);
    expect(leadCount("10 Spectrum St")).toBe(1);
    expect(leadStatus("10 Spectrum St")).toBe("prospect");
  });

  it("publishes with satellite competition (Starlink / NGSO)", () => {
    const t = freshTarget("20 Star Ln", "Starlink", "NGSO Satellite");
    project(TENANT, [t]);
    expect(leadCount("20 Star Ln")).toBe(1);
  });

  it("does NOT publish when a fiber competitor is present", () => {
    const t = freshTarget("30 Google Dr", "Google Fiber", "Fiber to the Premises");
    project(TENANT, [t]);
    expect(leadCount("30 Google Dr")).toBe(0);
  });

  it("does NOT publish an ambiguous (unknown) competitor — fail closed", () => {
    const t = freshTarget("40 Mystery Rd", "Randolph Telephone Telecommunications Inc.", null);
    project(TENANT, [t]);
    expect(leadCount("40 Mystery Rd")).toBe(0);
  });

  it("THE owner fixture: 485 Brown Acres Rd, Salisbury NC — Kinetic FIBER/NEW FIBER/N + Spectrum Cable → exactly ONE deduplicated Fresh Lead", () => {
    // ONE canonical pool row per house (UNIQUE address+city+state); two scans
    // of it — the real dedup flow — must yield exactly one published lead.
    const id = Number(rawDb.prepare(`INSERT INTO scan_targets (address,city,state,zip,lat,lng,tenant_id,source) VALUES (?,?,?,?,?,?,?,'osm')`)
      .run("485 Brown Acres Rd", "Salisbury", "NC", "28146", 35.6201, -80.4201, TENANT).lastInsertRowid);
    const scanOnce = (attempt: number) => {
      storage.recordScanTargetResult(id, { fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true, billingStatus: "N", availabilityStatus: "checked_available", newlyLive: false, customerSegment: "new_opportunity", customerConfidence: "high", customerSignals: [] });
      record({
        tenantId: TENANT, scanTargetId: id, runId: `r-brownacres-${attempt}`, checkedAt: new Date(Date.now() + attempt * 60_000).toISOString(),
        conclusive: true, fiberAvailable: true, fiberStatus: "new_fiber",
        householdSegmentType: "NEW FIBER", billingStatus: "N", transitionStatus: "baseline_available",
        apiSource: "kinetic_live", competitorName: "Spectrum", competitorTech: "Cable", evidenceHash: `h-brownacres-${attempt}`,
      });
      project(TENANT, [id]);
    };
    scanOnce(1);
    scanOnce(2);
    const n = (rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE lower(address)=lower('485 Brown Acres Rd') AND tenant_id=?`).get(TENANT) as any).n;
    expect(n).toBe(1);
    expect(leadStatus("485 Brown Acres Rd")).toBe("prospect");
    const onMap = storage.getLeadsForMap(TENANT).some((p: any) => String(p.address).toLowerCase().includes("brown acres"));
    expect(onMap).toBe(true);
  });

  it("RETRACTS a published lead when a later recheck reveals a fiber competitor", () => {
    // First scan: clean (Spectrum cable) → publishes.
    const t = freshTarget("50 Flip Ave", "Spectrum", "Cable");
    project(TENANT, [t]);
    expect(leadStatus("50 Flip Ave")).toBe("prospect");
    // Later recheck: a fiber competitor appears at the same address.
    record({
      tenantId: TENANT, scanTargetId: t, runId: "r-flip-2", checkedAt: new Date(Date.now() + 60000).toISOString(),
      conclusive: true, fiberAvailable: true, fiberStatus: "new_fiber",
      householdSegmentType: "NEW FIBER", billingStatus: "N", transitionStatus: "baseline_available",
      apiSource: "kinetic_live", competitorName: "AT&T Fiber", competitorTech: "Fiber to the Premises", evidenceHash: "h-flip-2",
    });
    project(TENANT, [t]);
    // Lead is suppressed (never deleted) and off the rep map.
    expect(leadStatus("50 Flip Ave")).toBe("competitor_suppressed");
    const onMap = storage.getLeadsForMap(TENANT).some((p: any) => String(p.address).toLowerCase() === "50 flip ave");
    expect(onMap).toBe(false);
  });
});
