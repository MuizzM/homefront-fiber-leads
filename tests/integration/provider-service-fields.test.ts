import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * "TENURED" IS NOT A FIBER SIGNAL.
 *
 * The body below is the real Kinetic response for 843 Georgia Oak Ln, Landis NC
 * 28088, captured live. Read only householdSegmentType and you call it a prime
 * target that a rep should walk today. Read the rest of the SAME response and
 * it is a January 2027 build that is unserviceable right now:
 *
 *   maxQual          "NO QUAL"
 *   validationResult "AddressUnserviceableInTerritory"
 *   broadbandService.technologyType        "FUTURE_QUAL_EXTENDED"
 *   broadbandService.futureTechnologyType  "FIBER"
 *   broadbandService.estimatedCompletionDt "JAN-2027"
 *
 * Every one of those fields was already parsed and then dropped, so nothing
 * could answer "what is coming, and when". These tests hold the fields to the
 * response.
 */
let rawDb: import("better-sqlite3").Database;
let persist: typeof import("../../server/kineticObservation").persistKineticObservation;
const TENANT = 1;

const GEORGIA_OAK = {
  maxQual: "NO QUAL",
  techType: "",
  broadbandService: {
    futureQual: "FutureQual",
    technologyType: "FUTURE_QUAL_EXTENDED",
    qualDesc: "FUTURE QUAL UP TO 1G",
    futureTechnologyType: "FIBER",
    estimatedCompletionDt: "JAN-2027",
  },
  exchangeId: "NC018CHGV",
  validationResult: "AddressUnserviceableInTerritory",
  address: {
    addressLine1: "843 GEORGIA OAK LN", city: "LANDIS", stateProvinceCd: "NC", postalCd: "28088",
    geoLat: "35.551593", geoLong: "-80.596199",
    billingStatus: "N", householdSegmentType: "TENURED", newConstInd: "Y",
    competitorCompanyName: "Spectrum", competitorQualSpeed: "1000", competitorTechName: "Cable",
  },
};

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-psf-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  ({ persistKineticObservation: persist } = await import("../../server/kineticObservation"));
});
beforeEach(() => { rawDb.prepare("DELETE FROM scan_targets").run(); });

function observe(raw: any, over: Record<string, unknown> = {}) {
  persist({
    tenantId: TENANT,
    source: "test",
    observation: {
      address: "843 Georgia Oak Ln", city: "Landis", state: "NC", zip: "28088",
      lat: 35.551593, lng: -80.596199,
      fiberStatus: "tenured_fiber", fiberAvailable: false, isNewFiber: false,
      billingStatus: raw?.address?.billingStatus ?? null,
      householdSegmentType: raw?.address?.householdSegmentType ?? null,
      rawResponse: raw, ...over,
    } as any,
  } as any);
  return rawDb.prepare("SELECT * FROM scan_targets WHERE address LIKE '843 Georgia%'").get() as any;
}

describe("provider serviceability and build-date fields", () => {
  it("stores the completion date the portal shows the customer", () => {
    const t = observe(GEORGIA_OAK);
    expect(t.completion_text).toBe("JAN-2027");
  });

  it("normalises the date so 'what is due in September' is a range query", () => {
    const t = observe(GEORGIA_OAK);
    expect(t.completion_date).toBe("2027-01-01");
    const due = rawDb.prepare(
      `SELECT COUNT(*) c FROM scan_targets
        WHERE tenant_id=? AND completion_date >= '2027-01-01' AND completion_date < '2027-02-01'`,
    ).get(TENANT) as any;
    expect(due.c).toBe(1);
  });

  it("records that the door is NOT serviceable today, despite TENURED", () => {
    const t = observe(GEORGIA_OAK);
    expect(t.last_max_qual).toBe("NO QUAL");
    expect(t.last_validation_result).toBe("AddressUnserviceableInTerritory");
    // the segment that misled the first pass is still stored, unchanged
    expect(t.last_customer_segment).toBeTruthy();
  });

  it("keeps the future technology and its qual state", () => {
    const t = observe(GEORGIA_OAK);
    expect(t.future_qual_tech).toBe("FUTURE_QUAL_EXTENDED");
    expect(t.future_technology).toBe("FIBER");
  });

  it("flags new construction and names the incumbent to beat", () => {
    const t = observe(GEORGIA_OAK);
    expect(t.new_const_ind).toBe("Y");
    expect(t.competitor_company).toBe("Spectrum");
  });

  it("stores the exchange, so a whole build can be pulled as one cluster", () => {
    const t = observe(GEORGIA_OAK);
    expect(t.exchange_id).toBe("NC018CHGV");
  });

  it("a live door clears a stale promise instead of advertising a past date", () => {
    observe(GEORGIA_OAK);
    const lit = {
      ...GEORGIA_OAK,
      maxQual: "QUAL UP TO 1 GIG RANGE VIA FIBER",
      techType: "FIBER",
      validationResult: "AddressFound",
      broadbandService: { technologyType: "FIBER" },
    };
    const t = observe(lit, { fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true });
    expect(t.last_max_qual).toBe("QUAL UP TO 1 GIG RANGE VIA FIBER");
    expect(t.last_validation_result).toBe("AddressFound");
    // the qual state must not keep claiming a future build
    expect(t.future_qual_tech).toBe("FIBER");
  });

  it("a response with no date does not erase a date we already knew", () => {
    observe(GEORGIA_OAK);
    const noDate = { ...GEORGIA_OAK, broadbandService: { technologyType: "FUTURE_QUAL_EXTENDED" } };
    const t = observe(noDate);
    expect(t.completion_text).toBe("JAN-2027");
  });

  it("tolerates a missing or malformed body without throwing", () => {
    expect(() => observe(null)).not.toThrow();
    expect(() => observe({ broadbandService: "nonsense" })).not.toThrow();
  });

  it("leaves the date NULL for a sentinel rather than inventing one", () => {
    const sentinel = { ...GEORGIA_OAK, broadbandService: { ...GEORGIA_OAK.broadbandService, estimatedCompletionDt: "PENDING" } };
    const t = observe(sentinel);
    expect(t.completion_text).toBe("PENDING");
    expect(t.completion_date).toBeNull();
  });
});
