import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKineticResponse, classifyKineticResult } from "../../server/kineticResponseParser";
import { readFutureService } from "../../shared/futureService";

/**
 * A COMING-SOON DOOR IS NOT A LEAD.
 *
 * The body below is real, dumped from the portal on 2026-08-24. It carries
 * householdSegmentType TENURED and billing 'N' - the pair an earlier gate
 * treated as "fiber at the curb, nobody on it" - alongside the carrier saying,
 * in the same response, that the address is unserviceable and the fiber build
 * lands in JAN-2027.
 *
 * TENURED + billing N proves nobody is paying. It does not prove fiber is live.
 * These tests hold that line: publication requires a positive recorded
 * qualification, and an open carrier promise outranks anything derived.
 */
const BODY: any = {
  success: true,
  validationResult: "AddressUnserviceableInTerritory",
  maxQual: "NO QUAL",
  techType: "",
  broadbandService: {
    technologyType: "FUTURE_QUAL_EXTENDED",
    futureTechnologyType: "FIBER",
    estimatedCompletionDt: "JAN-2027",
  },
  address: {
    householdSegmentType: "TENURED",
    billingStatus: "N",
    newConstInd: "Y",
    maxQualTechnologyType: "",
    competitorCompanyName: "Spectrum",
    addressLine1: "123 Coming Soon Rd", city: "ROCKWELL",
    stateProvinceCd: "NC", postalCd: "28138",
    geoLat: 35.55, geoLong: -80.42,
  },
};

let rawDb: import("better-sqlite3").Database;
let mod: typeof import("../../server/tenuredLeadProjector");
const TENANT = 1;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-tencoming-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  mod = await import("../../server/tenuredLeadProjector");
});
beforeEach(() => {
  rawDb.prepare("DELETE FROM leads").run();
  rawDb.prepare("DELETE FROM scan_targets").run();
  rawDb.prepare("DELETE FROM coming_soon_watchlist").run();
});

let seq = 0;
/** A scanned TENURED door with billing N, varying only the qualification signal. */
function door(fiberAvailable: number | null): number {
  const id = ++seq + 910_000;
  rawDb.prepare(
    `INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,source,street_key,
       last_customer_segment,last_scanned_at,last_fiber_status,last_is_new_fiber,
       last_billing_status,last_fiber_available)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, TENANT, `${id} Coming Soon Rd`, "Rockwell", "NC", "28138",
    35.55 + seq * 0.0001, -80.42, "test", "COMING SOON RD", "unknown",
    "2026-08-20T00:00:00.000Z", "tenured_fiber", 0, "N", fiberAvailable);
  return id;
}

function watch(targetId: number, status: string, eta: string | null = "2027-01-01"): void {
  const now = Date.now();
  rawDb.prepare(
    `INSERT INTO coming_soon_watchlist
       (tenant_id,scan_target_id,address_key,first_seen_at,estimated_completion,
        source,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(TENANT, targetId, `${targetId} coming soon rd`, now, eta, "kinetic", status, now, now);
}

describe("the carrier's own answer, read whole", () => {
  it("is not fiber-qualified", () => {
    expect(parseKineticResponse(BODY).fiberQualified).toBe(false);
  });

  it("carries the TENURED segment that used to be mistaken for a fiber signal", () => {
    expect(parseKineticResponse(BODY).householdSegmentType).toBe("TENURED");
  });

  it("is NO_SERVICE to the canonical classifier", () => {
    expect(classifyKineticResult(parseKineticResponse(BODY))).toBe("NO_SERVICE");
  });

  it("is a dated future promise, attributed to the exact payload path", () => {
    const r = readFutureService(parseKineticResponse(BODY), BODY);
    expect(r.isFuture).toBe(true);
    expect(r.promisedDate).toBe("2027-01-01");
    expect(r.datePath).toBe("broadbandService.estimatedCompletionDt");
    expect(r.quote).toBe("JAN-2027");
  });
});

describe("tenured projector: sellable as fiber, or not published", () => {
  it("NEVER publishes a door whose qualification says no fiber", () => {
    door(0);
    expect(mod.projectTenuredOpenLeads(TENANT).created).toBe(0);
  });

  it("NEVER publishes a door with no qualification recorded at all", () => {
    // 74% of the old candidate set. "We never checked" is not "it is live".
    door(null);
    expect(mod.projectTenuredOpenLeads(TENANT).created).toBe(0);
  });

  it("NEVER publishes a door the carrier still promises for later", () => {
    // Qualification says yes, but an OPEN promise outranks it: this is the door
    // the map labels "Coming soon, JAN-2027".
    const id = door(1);
    watch(id, "active");
    expect(mod.projectTenuredOpenLeads(TENANT).created).toBe(0);
  });

  it("PUBLISHES a door that is qualified with no open promise", () => {
    // The positive control: the gate must not be "publish nothing".
    const id = door(1);
    const r = mod.projectTenuredOpenLeads(TENANT);
    expect(r.created).toBe(1);
    const lead = rawDb.prepare("SELECT * FROM leads WHERE source_scan_target_id=?").get(id) as any;
    expect(lead.lead_tag).toBe(mod.TENURED_LEAD_TAG);
    expect(lead.is_new_fiber).toBe(0);   // the fresh-fiber trigger stays untouched
    expect(lead.notes).toContain("qualified");
  });

  it("publishes once a promise is closed, because the door actually turned on", () => {
    const id = door(1);
    watch(id, "promoted");            // the promise was collected: fiber arrived
    expect(mod.projectTenuredOpenLeads(TENANT).created).toBe(1);
  });

  it("counts exactly what it would publish", () => {
    door(1);                          // publishable
    door(null);                       // no qualification
    door(0);                          // not qualified
    watch(door(1), "active");         // open promise
    expect(mod.countTenuredOpenCandidates(TENANT)).toBe(1);
    expect(mod.projectTenuredOpenLeads(TENANT).created).toBe(1);
  });

  it("does not leak another tenant's promise into this tenant's gate", () => {
    const id = door(1);
    // An active watch belonging to a DIFFERENT tenant must not suppress ours.
    const now = Date.now();
    rawDb.prepare(
      `INSERT INTO coming_soon_watchlist
         (tenant_id,scan_target_id,address_key,first_seen_at,estimated_completion,
          source,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(TENANT + 99, id, "other tenant", now, "2027-01-01", "kinetic", "active", now, now);
    expect(mod.projectTenuredOpenLeads(TENANT).created).toBe(1);
  });
});
