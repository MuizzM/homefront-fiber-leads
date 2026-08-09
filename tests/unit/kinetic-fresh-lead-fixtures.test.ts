import { describe, expect, it } from "vitest";
import { classifyKineticFreshLead, evaluateSingleCompetitor, COMPETITIVE_ELIGIBILITY_VERSION } from "../../shared/competitiveEligibility";

// Owner fixture matrix (2026-07-23): brand never matters — technology decides.
// Eligible with ANY non-fiber competitor; excluded only when another provider
// is identified as offering fiber; unknown/conflicting tech → review.

const BASE = {
  success: true, errorCode: 0, validationResult: "AddressFound",
  techType: "FIBER", householdSegmentType: "NEW FIBER", billingStatus: "N",
};

describe("classifyKineticFreshLead - owner fixture matrix", () => {
  it("THE canonical fixture: 485 Brown Acres Rd (Kinetic FIBER + Spectrum Cable) is eligible", () => {
    const r = classifyKineticFreshLead({
      ...BASE,
      competitors: [{ name: "Spectrum", tech: "Cable" }],
    });
    expect(r.decision).toBe("fresh_lead");
    expect(r.eligible).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.version).toBe(COMPETITIVE_ELIGIBILITY_VERSION);
  });

  it("Kinetic + any cable brand → eligible (Comcast, Cox - brand is irrelevant)", () => {
    for (const name of ["Comcast", "Cox", "Some Local Cableco"]) {
      expect(classifyKineticFreshLead({ ...BASE, competitors: [{ name, tech: "Cable" }] }).eligible).toBe(true);
    }
  });

  it("Kinetic + Starlink/satellite → eligible", () => {
    expect(classifyKineticFreshLead({ ...BASE, competitors: [{ name: "Starlink", tech: "NGSO Satellite" }] }).eligible).toBe(true);
  });

  it("Kinetic + DSL/copper → eligible", () => {
    expect(classifyKineticFreshLead({ ...BASE, competitors: [{ name: "CenturyLink", tech: "DSL" }] }).eligible).toBe(true);
    expect(classifyKineticFreshLead({ ...BASE, competitors: [{ name: "Windstream Legacy", tech: "Copper" }] }).eligible).toBe(true);
  });

  it("Kinetic + fixed wireless / cellular home internet → eligible", () => {
    expect(classifyKineticFreshLead({ ...BASE, competitors: [{ name: "AirLink", tech: "Licensed Fixed Wireless" }] }).eligible).toBe(true);
    expect(classifyKineticFreshLead({ ...BASE, competitors: [{ name: "T-Mobile", tech: "Cellular Home Internet" }] }).eligible).toBe(true);
  });

  it("Kinetic-only (no competitor) → eligible", () => {
    expect(classifyKineticFreshLead({ ...BASE, competitors: [] }).eligible).toBe(true);
    expect(classifyKineticFreshLead({ ...BASE, competitors: [{ name: "NO COMPETITOR", tech: null }] }).eligible).toBe(true);
  });

  it("ANY fiber competitor → excluded, regardless of brand or wording", () => {
    const fiberWordings = [
      { name: "Spectrum", tech: "Fiber to the Premises" }, // even the accepted cable brand's FIBER product
      { name: "Anybody", tech: "FTTH" },
      { name: "Anybody", tech: "FTTP" },
      { name: "Anybody", tech: "fiber optic" },
      { name: "Anybody", tech: "Optical" },
      { name: "Anybody", tech: "gig fiber" },
      { name: "Anybody", tech: "Fiber Internet" },
      { name: "Google Fiber", tech: null },                // brand-only evidence
    ];
    for (const competitor of fiberWordings) {
      const r = classifyKineticFreshLead({ ...BASE, competitors: [competitor] });
      expect(r.decision, JSON.stringify(competitor)).toBe("not_eligible");
      expect(r.reasons.join(" ")).toContain("fiber competitor");
    }
  });

  it("unknown/conflicting competitor technology → COMPETITOR_REVIEW, never published", () => {
    const r = classifyKineticFreshLead({ ...BASE, competitors: [{ name: "Randolph Telephone", tech: "Advanced Network" }] });
    expect(r.decision).toBe("competitor_review");
    expect(r.eligible).toBe(false);
  });

  it("billing active → excluded even with a clean competitive landscape", () => {
    const r = classifyKineticFreshLead({ ...BASE, billingStatus: "Y", competitors: [{ name: "Spectrum", tech: "Cable" }] });
    expect(r.eligible).toBe(false);
    expect(r.reasons.join(" ")).toContain("billingStatus=Y");
  });

  it("non-NEW FIBER segment → excluded", () => {
    const r = classifyKineticFreshLead({ ...BASE, householdSegmentType: "TENURED FIBER" });
    expect(r.eligible).toBe(false);
  });

  it("failed lookups are never leads: success=false / errorCode / address not found", () => {
    expect(classifyKineticFreshLead({ ...BASE, success: false }).eligible).toBe(false);
    expect(classifyKineticFreshLead({ ...BASE, errorCode: 17 }).eligible).toBe(false);
    expect(classifyKineticFreshLead({ ...BASE, validationResult: "AddressNeedsFix" }).eligible).toBe(false);
  });

  it("Kinetic not fiber (maxQual fallback honored) → excluded unless either field says fiber", () => {
    expect(classifyKineticFreshLead({ ...BASE, techType: "COPPER", maxQualTechnologyType: null }).eligible).toBe(false);
    expect(classifyKineticFreshLead({ ...BASE, techType: null, maxQualTechnologyType: "FIBER" }).eligible).toBe(true);
  });

  it("evaluateSingleCompetitor stays in lockstep (the snapshot writer's path)", () => {
    expect(evaluateSingleCompetitor("Spectrum", "Cable").decision).toBe("eligible");
    expect(evaluateSingleCompetitor("Spectrum", "Fiber to the Premises").decision).toBe("excluded_fiber_competitor");
    expect(evaluateSingleCompetitor("T-Mobile", "Cellular Home Internet").decision).toBe("eligible");
    expect(evaluateSingleCompetitor("Mystery ISP", "Quantum Link").decision).toBe("competitor_review");
  });
});
