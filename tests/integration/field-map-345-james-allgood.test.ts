import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKineticResponse } from "../../server/kineticResponseParser";
import { KINETIC_345_JAMES_ALLGOOD as FIX } from "../fixtures/kinetic345JamesAllgood";

let rawDb: import("better-sqlite3").Database;
let engine: typeof import("../../server/scanEngine");
let store: typeof import("../../server/scanIntelStore");
let appStorage: typeof import("../../server/storage").storage;
const TENANT = 1;
const REP = 88;

// The ScanResult the shared scanAddressDirect classifier produces for the real
// fixture (new_fiber, NEW FIBER, billing N, FTTP, 2 Gig, the returned coords).
// The transport test proves the fixture → this shape; here we drive the Field Map
// worker with it to prove the counter + lead + map pin end to end.
function freshResult(): any {
  const p = parseKineticResponse(FIX);
  return {
    address: "345 James Allgood Dr", city: "Inman", state: "SC", zip: "29349",
    lat: p.lat, lng: p.lng,
    fiberStatus: "new_fiber", isNewFiber: true, isTenured: false, fiberAvailable: p.fiberQualified,
    maxDownloadKbps: p.finalQualSpeedKbps, maxDownloadMbps: 2_000, speedTier: "2gig",
    techType: p.technology, chipSetType: p.chipSetType, placement: null, maxQual: p.maxQual,
    competitorName: null, competitorSpeedMbps: null, competitorTech: null, inCompetitorArea: false,
    addressCatalogDate: null, householdSegmentType: p.householdSegmentType, billingStatus: p.billingStatus,
    exchangeId: null, dfAddressId: p.dfAddressId, accessId: p.accessId, serviceKey: p.serviceKey,
    confidence: "HIGH", apiSource: "kinetic_live", blocked: false, notes: "fresh",
    rawResponse: FIX, leadTag: "hot_lead", leadScore: 100,
  };
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-fieldmap-345-"));
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  appStorage = storage.storage;
  engine = await import("../../server/scanEngine");
  store = await import("../../server/scanIntelStore");
  // Territory over the address so the fresh lead auto-assigns and shows on the map.
  rawDb.prepare(`INSERT INTO territories (tenant_id,name,rep_id,polygon,status)
    VALUES (?, 'Inman area', ?, ?, 'active')`).run(TENANT, REP, JSON.stringify([
      [-82.080, 35.019], [-82.077, 35.019], [-82.077, 35.022], [-82.080, 35.022],
    ]));
});

describe("Field Map — 345 James Allgood Dr end-to-end (production worker path)", () => {
  const targetId = () => Number(rawDb.prepare(`SELECT id FROM scan_targets WHERE address='345 James Allgood Dr'`).get() as any)?.id;

  it("checks the address, creates ONE fresh lead, and pins it at 35.020537,-82.078668", async () => {
    const tid = Number(rawDb.prepare(`INSERT INTO scan_targets
      (address,city,state,zip,lat,lng,tenant_id,source) VALUES (?,?,?,?,?,?,?,'osm')`)
      .run("345 James Allgood Dr", "Inman", "SC", "29349", 35.020537, -82.078668, TENANT).lastInsertRowid);
    const runId = "run_345";
    store.createScanRun({ id: runId, tenantId: TENANT, kind: "bbox", label: "Field Map box", city: "Inman", state: "SC", budget: 1 });
    store.enqueueRunTargets(runId, [{ id: tid, seq: 0 }]);

    await engine.runScanWorker(runId, TENANT, async () => ({ result: freshResult(), bytes: 12_000, checkFailed: false }));

    // Checked >= 1, Unresolved = 0 for this address (never left at zero).
    const run = store.getRun(runId, TENANT)!;
    expect(run.verified).toBeGreaterThanOrEqual(1);
    expect(run.failed).toBe(0);

    // Exactly ONE deduplicated Fresh Lead, persisted with segment/billing + coords.
    const leads = rawDb.prepare(`SELECT lat,lng,fiber_status AS fs,lead_tag AS tag,billing_status AS billing,household_segment_type AS seg FROM leads WHERE tenant_id=?`).all(TENANT) as any[];
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ fs: "new_fiber", tag: "fresh_fiber_confirmed", billing: "N", seg: "NEW FIBER" });
    expect(leads[0].lat).toBeCloseTo(35.020537, 5);
    expect(leads[0].lng).toBeCloseTo(-82.078668, 5);

    // The GREEN Fresh Lead pin is on the rep's map at the returned coordinates.
    const mapLeads = appStorage.getLeadsForMap(TENANT, REP) as any[];
    const pin = mapLeads.find((l) => Math.abs(l.lat - 35.020537) < 1e-5 && Math.abs(l.lng + 82.078668) < 1e-5);
    expect(pin).toBeTruthy();
    expect(pin.leadTag).toBe("fresh_fiber_confirmed");

    // The scan target keeps its normalized fields (dfAddressId, billing, segment).
    const t = rawDb.prepare(`SELECT last_is_new_fiber AS nf, last_billing_status AS billing, last_fiber_status AS fs FROM scan_targets WHERE id=?`).get(tid) as any;
    expect(t).toMatchObject({ nf: 1, billing: "N", fs: "new_fiber" });
  });

  it("re-scanning the SAME address never creates a duplicate lead (New vs Still Fresh)", async () => {
    const tid = targetId();
    rawDb.prepare(`UPDATE scan_targets SET last_scanned_at=NULL WHERE id=?`).run(tid);
    const runId = "run_345_rescan";
    store.createScanRun({ id: runId, tenantId: TENANT, kind: "bbox", label: "rescan", city: "Inman", state: "SC", budget: 1 });
    store.enqueueRunTargets(runId, [{ id: tid, seq: 0 }]);
    await engine.runScanWorker(runId, TENANT, async () => ({ result: freshResult(), bytes: 12_000, checkFailed: false }));
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE tenant_id=?`).get(TENANT) as any).n).toBe(1);
  });
});
