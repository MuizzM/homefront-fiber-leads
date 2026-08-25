import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * RECOVERING THE 49.
 *
 * On 2026-08-24 an ad-hoc "sawtooth-cluster" ingest flipped 49 China Grove doors
 * from a conclusive fiber_available=0 to 1, storing no body. Their only stored
 * body, from 2026-07-18, says the build lands NOV-2026. The columns say "lit";
 * the evidence says "coming".
 *
 * Nothing needs to be rewritten by hand to fix that. The evidence is already
 * paid for and sitting in fiber_checks, and backfillFromStoredEvidence mines it
 * into the ledger; the projector's gate then refuses anything with an open
 * promise. This test walks that whole chain on the real body shape.
 */

let rawDb: import("better-sqlite3").Database;
let ledger: typeof import("../../server/comingLedger");
let projector: typeof import("../../server/tenuredLeadProjector");
const TENANT = 1;

const SAWTOOTH_BODY = JSON.stringify({
  success: true,
  validationResult: "AddressUnserviceableInTerritory",
  maxQual: "NO QUAL",
  techType: "",
  dfAddressId: "8000000000000009925622",
  broadbandService: {
    futureQual: "FutureQual", technologyType: "FUTURE_QUAL_EXTENDED",
    qualSpeed: "1000000", qualDesc: "FUTURE QUAL UP TO 1G",
    futureTechnologyType: "FIBER", estimatedCompletionDt: "NOV-2026",
  },
  address: {
    householdSegmentType: "TENURED", billingStatus: "N",
    competitorCompanyName: "Spectrum", addressLine1: "1716 Sawtooth Court",
    city: "CHINA GROVE", stateProvinceCd: "NC", postalCd: "28088",
  },
});

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-sawtooth-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  ledger = await import("../../server/comingLedger");
  projector = await import("../../server/tenuredLeadProjector");
  ledger.ensureComingLedgerSchema();
});

beforeEach(() => {
  rawDb.prepare("DELETE FROM leads").run();
  rawDb.prepare("DELETE FROM coming_soon_watchlist").run();
  rawDb.prepare("DELETE FROM scan_targets").run();
  rawDb.prepare("DELETE FROM fiber_checks").run();
});

/** The door exactly as the bad ingest left it: columns say lit, body says NOV-2026. */
function contaminatedDoor(): number {
  const id = 990_001;
  rawDb.prepare(
    `INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,source,street_key,
       last_customer_segment,last_scanned_at,last_fiber_status,last_is_new_fiber,
       last_billing_status,last_fiber_available)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, TENANT, "1716 Sawtooth Court", "China Grove", "NC", "28088", 35.55, -80.42,
        "test", "SAWTOOTH COURT", "unknown", "2026-08-24T03:59:32.419Z",
        "tenured_fiber", 0, "N", 1);
  rawDb.prepare(
    `INSERT INTO fiber_checks (tenant_id, address, result, checked_at)
     VALUES (?,?,?,?)`,
  ).run(TENANT, "1716 Sawtooth Court, China Grove, NC 28088", SAWTOOTH_BODY, "2026-07-18T18:38:10.000Z");
  return id;
}

describe("recovering a door the columns called lit", () => {
  it("publishes it BEFORE the evidence is mined - the state we are fixing", () => {
    contaminatedDoor();
    // Nothing on the ledger yet, and the qualification column says 1, so the
    // gate has nothing to hold it back. This is the defect, reproduced.
    expect(projector.projectTenuredOpenLeads(TENANT).created).toBe(1);
  });

  it("mines the promise out of evidence we already paid for", () => {
    const id = contaminatedDoor();
    const r = ledger.backfillFromStoredEvidence(TENANT, 100, Date.parse("2026-08-24T12:00:00Z"));
    expect(r.recorded).toBeGreaterThan(0);
    expect(r.dated).toBeGreaterThan(0);

    const w = rawDb.prepare(`SELECT * FROM coming_soon_watchlist WHERE scan_target_id=?`).get(id) as any;
    expect(w).toBeTruthy();
    expect(w.status).toBe("active");
    expect(w.promised_date).toBe("2026-11-01");            // NOV-2026, the carrier's own month
    expect(w.date_source).toBe("provider");
    expect(w.date_path).toBe("broadbandService.estimatedCompletionDt");
  });

  it("REFUSES to publish it once the promise is on the ledger", () => {
    contaminatedDoor();
    ledger.backfillFromStoredEvidence(TENANT, 100, Date.parse("2026-08-24T12:00:00Z"));
    expect(projector.projectTenuredOpenLeads(TENANT).created).toBe(0);
    expect(projector.countTenuredOpenCandidates(TENANT)).toBe(0);
  });

  it("schedules it for a weekly re-read, not a December one", () => {
    const id = contaminatedDoor();
    const now = Date.parse("2026-08-24T12:00:00Z");
    ledger.backfillFromStoredEvidence(TENANT, 100, now);
    const w = rawDb.prepare(`SELECT due_at FROM coming_soon_watchlist WHERE scan_target_id=?`).get(id) as any;
    // NOV-2026 is far off, so the weekly floor governs: a week from the last
    // look, not two weeks before the promised month.
    expect(w.due_at).toBeLessThanOrEqual(now + 7 * 86_400_000);
    expect(w.due_at).toBeLessThan(Date.parse("2026-11-01T00:00:00Z") - 14 * 86_400_000);
  });
});
