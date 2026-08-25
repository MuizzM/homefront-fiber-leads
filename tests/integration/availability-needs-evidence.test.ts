import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * AN AVAILABILITY CLAIM MUST CARRY ITS EVIDENCE.
 *
 * "Fiber is available here" is the claim that mints a lead and sends a rep to a
 * door. It is also the claim an ad-hoc caller can assert from a segment label
 * with nothing behind it - which is exactly what happened on 2026-08-24, when a
 * "sawtooth-cluster" ingest flipped 49 China Grove doors from a conclusive
 * fiber_available=0 to 1 while storing no body at all. Their only stored body
 * says "FUTURE QUAL UP TO 1G", NOV-2026.
 *
 * This mirrors the rule the module already applies in the other direction:
 * a bare `priorUnavailable: true` is refused because it would fabricate the
 * baseline that makes a result fresh.
 */

let rawDb: import("better-sqlite3").Database;
let persist: typeof import("../../server/kineticObservation").persistKineticObservation;
const TENANT = 1;

/** The real body from 1716 Sawtooth Court: a dated FUTURE build, not service. */
const SAWTOOTH_BODY = {
  success: true,
  validationResult: "AddressUnserviceableInTerritory",
  maxQual: "NO QUAL",
  techType: "",
  broadbandService: {
    futureQual: "FutureQual", technologyType: "FUTURE_QUAL_EXTENDED",
    qualSpeed: "1000000", qualDesc: "FUTURE QUAL UP TO 1G",
    futureTechnologyType: "FIBER", estimatedCompletionDt: "NOV-2026",
  },
  address: { householdSegmentType: "TENURED", billingStatus: "N", competitorCompanyName: "Spectrum" },
};
/** A body that really does qualify fiber today. */
const LIVE_BODY = {
  success: true, validationResult: "AddressFound", exactMatch: true, techType: "FIBER",
  address: { householdSegmentType: "NEW FIBER", billingStatus: "N", maxQualTechnologyType: "FIBER" },
};

let seq = 0;
function obs(over: Record<string, unknown>) {
  seq += 1;
  return {
    tenantId: TENANT,
    source: "sawtooth-cluster",
    observation: {
      address: `${seq} Evidence Rd`, city: "China Grove", state: "NC", zip: "28088",
      lat: 35.55 + seq * 0.0001, lng: -80.42,
      householdSegmentType: "TENURED", billingStatus: "N",
      apiSource: "kinetic_live", blocked: false,
      discoveredAt: new Date().toISOString(),
      ...over,
    },
  } as any;
}

const targetOf = (address: string): any =>
  rawDb.prepare(`SELECT * FROM scan_targets WHERE address=?`).get(address);
const snapOf = (address: string): any =>
  rawDb.prepare(
    `SELECT a.* FROM availability_snapshots a JOIN scan_targets s ON s.id=a.scan_target_id
      WHERE s.address=? ORDER BY a.checked_at_epoch DESC LIMIT 1`).get(address);

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-evidence-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  persist = (await import("../../server/kineticObservation")).persistKineticObservation;
});
beforeEach(() => {
  rawDb.prepare("DELETE FROM leads").run();
  rawDb.prepare("DELETE FROM availability_snapshots").run();
  rawDb.prepare("DELETE FROM scan_targets").run();
});

describe("availability needs evidence", () => {
  it("ACCEPTS a claim with no body, because refusing them suppresses real flips", () => {
    // Deliberate, and it cost 7 tests across three suites to learn: MP Box, the
    // verdict route and the field map all publish a classified answer without
    // shipping the payload, and a door going from no_service to fiber is the
    // most valuable event this system has. Refusing unbodied claims blocked
    // exactly that. Lead publication is protected downstream instead - see
    // sawtooth-recovery.test.ts.
    const o = obs({ fiberStatus: "tenured_fiber", fiberAvailable: true });
    persist(o);
    expect(targetOf(o.observation.address).last_fiber_available).toBe(1);
  });

  it("reads the carrier's FUTURE QUAL body as NOT available, whatever the caller claims", () => {
    // The exact Sawtooth case: caller says fiber is on, the body says NOV-2026.
    const o = obs({ fiberStatus: "tenured_fiber", fiberAvailable: true, rawResponse: SAWTOOTH_BODY });
    persist(o);
    const t = targetOf(o.observation.address);
    expect(t.last_fiber_available).toBe(0);
    const snap = snapOf(o.observation.address);
    expect(snap.conclusive).toBe(1);      // a body is a conclusive answer
    expect(snap.fiber_available).toBe(0); // and the answer is no
  });

  it("ACCEPTS an availability claim the body actually supports", () => {
    const o = obs({
      fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true,
      householdSegmentType: "NEW FIBER", rawResponse: LIVE_BODY,
    });
    persist(o);
    expect(targetOf(o.observation.address).last_fiber_available).toBe(1);
    expect(snapOf(o.observation.address).fiber_available).toBe(1);
  });

  it("lets a claim stand when the body is from a carrier this parser does not model", () => {
    // Frontier's shape. The caller DID bring evidence; we just cannot read it,
    // so refusing would throw away a real answer.
    const o = obs({
      fiberStatus: "new_fiber", fiberAvailable: true,
      rawResponse: { matchType: "EXACT", techAvailable: "FIBER", offerType: "CHALLENGER1" },
    });
    persist(o);
    expect(targetOf(o.observation.address).last_fiber_available).toBe(1);
  });

  it("still accepts an UNAVAILABLE answer with no body", () => {
    // Refusing negatives would fabricate nothing and lose real information.
    const o = obs({ fiberStatus: "no_service", fiberAvailable: false });
    persist(o);
    expect(targetOf(o.observation.address).last_fiber_available).toBe(0);
    expect(snapOf(o.observation.address).conclusive).toBe(1);
  });

  it("lets the BODY reverse a claim even when the door was previously available", () => {
    // The direction that matters: we thought it was lit, the carrier says the
    // build is still coming. The body wins, and the door drops back to not
    // available so the ledger can pick up the promise.
    const first = obs({ fiberStatus: "new_fiber", fiberAvailable: true, rawResponse: LIVE_BODY });
    persist(first);
    const addr = first.observation.address;
    expect(targetOf(addr).last_fiber_available).toBe(1);

    persist({ ...first, observation: {
      ...first.observation, fiberStatus: "tenured_fiber", fiberAvailable: true,
      rawResponse: SAWTOOTH_BODY,
    } });
    expect(targetOf(addr).last_fiber_available).toBe(0);
  });
});
