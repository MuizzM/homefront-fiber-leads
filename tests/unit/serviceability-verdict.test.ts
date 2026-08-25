import { describe, it, expect } from "vitest";
import { classifyServiceability } from "../../shared/serviceabilityVerdict";
import { parseKineticResponse } from "../../server/kineticResponseParser";

/**
 * A SEGMENT IS NOT A QUALIFICATION.
 *
 * These are the cases the old inline branch got wrong. It lived inside
 * scanAddressDirect, which is network-bound, so every scanner test injected a
 * fake checker and none of them reached it - which is precisely how a
 * segment-only read survived long enough to publish 49 China Grove doors that
 * the carrier had not built yet.
 */

/** The real body from 1716 Sawtooth Court, China Grove (2026-08-24). */
const SAWTOOTH = {
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

describe("the door that started this", () => {
  it("is NOT fiber, whatever its segment says", () => {
    const parsed = parseKineticResponse(SAWTOOTH);
    const v = classifyServiceability({
      householdSegmentType: parsed.householdSegmentType,
      fiberQualified: parsed.fiberQualified,
      validationResult: parsed.validationResult,
      billingStatus: parsed.billingStatus,
      maxQual: parsed.maxQual,
    });
    // The whole bug in one assertion: this used to be "tenured_fiber".
    expect(v.fiberStatus).toBe("no_service");
    expect(v.isNewFiber).toBe(false);
  });

  it("still records the household history - that part was never wrong", () => {
    const parsed = parseKineticResponse(SAWTOOTH);
    const v = classifyServiceability({
      householdSegmentType: parsed.householdSegmentType,
      fiberQualified: parsed.fiberQualified,
      validationResult: parsed.validationResult,
    });
    expect(v.isTenured).toBe(true);   // plant and a record here IS a fact
  });

  it("never claims a qualification it does not have", () => {
    const parsed = parseKineticResponse(SAWTOOTH);
    const v = classifyServiceability({
      householdSegmentType: parsed.householdSegmentType,
      fiberQualified: parsed.fiberQualified,
      validationResult: parsed.validationResult,
      maxQual: parsed.maxQual,
    });
    expect(v.notes).not.toMatch(/qualified/i);
    expect(v.notes).toContain("Not serviceable");
  });
});

describe("classifyServiceability", () => {
  const base = { fiberQualified: false as boolean };

  it("TENURED + qualified is a tenured fiber door", () => {
    const v = classifyServiceability({ ...base, householdSegmentType: "TENURED", fiberQualified: true, billingStatus: "N" });
    expect(v.fiberStatus).toBe("tenured_fiber");
    expect(v.isTenured).toBe(true);
    expect(v.notes).toContain("NOT a current subscriber");
  });

  it("TENURED + qualified + active account reads as a subscriber", () => {
    const v = classifyServiceability({ ...base, householdSegmentType: "TENURED", fiberQualified: true, billingStatus: "A" });
    expect(v.notes).toContain("already a Kinetic subscriber");
  });

  it("NEW FIBER + qualified is new fiber", () => {
    const v = classifyServiceability({ ...base, householdSegmentType: "NEW FIBER", fiberQualified: true, chipSetType: "FTTP" });
    expect(v.fiberStatus).toBe("new_fiber");
    expect(v.isNewFiber).toBe(true);
    expect(v.notes).toContain("FTTP confirmed");
  });

  it("NEW FIBER WITHOUT a qualification is not new fiber", () => {
    // isNewFiber feeds the fresh-fiber moat, which already demands availability.
    const v = classifyServiceability({ ...base, householdSegmentType: "NEW FIBER", fiberQualified: false });
    expect(v.isNewFiber).toBe(false);
    expect(v.fiberStatus).not.toBe("new_fiber");
  });

  it("an unknown segment with a qualification is existing fiber", () => {
    const v = classifyServiceability({ ...base, householdSegmentType: "SOMETHING ELSE", fiberQualified: true });
    expect(v.fiberStatus).toBe("existing_fiber");
  });

  it("unqualified and not unserviceable is copper, as before", () => {
    const v = classifyServiceability({ ...base, householdSegmentType: "DSL", fiberQualified: false, maxDownloadMbps: 25 });
    expect(v.fiberStatus).toBe("copper");
  });

  it("reads every unserviceable spelling the carrier uses", () => {
    for (const vr of ["AddressUnserviceableInTerritory", "NotServiceable", "OUT OF TERRITORY", "NoService"]) {
      expect(classifyServiceability({ ...base, householdSegmentType: "TENURED", fiberQualified: false, validationResult: vr }).fiberStatus,
        `validationResult=${vr}`).toBe("no_service");
    }
  });

  it("uses only vocabulary the existing consumers already understand", () => {
    // The reason this fix needed no six-file sweep: neither 'no_service' nor
    // 'copper' appears in any consumer's fiber list, so an unqualified door
    // drops out of every fiber reader at once.
    const known = new Set(["new_fiber", "tenured_fiber", "existing_fiber", "copper", "no_service"]);
    for (const seg of ["TENURED", "NEW FIBER", "DSL", "", null]) {
      for (const q of [true, false]) {
        for (const vr of [null, "AddressUnserviceableInTerritory"]) {
          const v = classifyServiceability({ householdSegmentType: seg, fiberQualified: q, validationResult: vr });
          expect(known.has(v.fiberStatus), `${seg}/${q}/${vr} -> ${v.fiberStatus}`).toBe(true);
        }
      }
    }
  });
});
