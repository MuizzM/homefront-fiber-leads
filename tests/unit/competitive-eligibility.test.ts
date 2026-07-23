import { describe, it, expect } from "vitest";
import {
  classifyCompetitor,
  classifyCompetitiveEligibility,
  evaluateSingleCompetitor,
  COMPETITIVE_ELIGIBILITY_VERSION,
} from "../../shared/competitiveEligibility";

describe("competitiveEligibility — canonical Spectrum-only gate", () => {
  it("Kinetic + Spectrum cable only → eligible", () => {
    const r = evaluateSingleCompetitor("Spectrum", "Cable");
    expect(r.decision).toBe("eligible");
    expect(r.eligible).toBe(true);
  });

  it("Kinetic only (no competitor) → eligible", () => {
    expect(evaluateSingleCompetitor(null, null).eligible).toBe(true);
    expect(evaluateSingleCompetitor("NO COMPETITOR", null).eligible).toBe(true);
    expect(classifyCompetitiveEligibility([]).eligible).toBe(true);
  });

  it("satellite competition (Starlink / NGSO Satellite) → eligible (not fiber)", () => {
    expect(evaluateSingleCompetitor("Starlink", "NGSO Satellite").eligible).toBe(true);
    expect(evaluateSingleCompetitor("HughesNet", null).eligible).toBe(true);
  });

  it("fixed-wireless and DSL competition → eligible (not fiber)", () => {
    expect(evaluateSingleCompetitor(null, "Licensed Fixed Wireless").eligible).toBe(true);
    expect(evaluateSingleCompetitor("Some Telco", "DSL").eligible).toBe(true);
  });

  it("Kinetic + a FIBER competitor (Fiber to the Premises) → excluded", () => {
    const r = evaluateSingleCompetitor("Google Fiber", "Fiber to the Premises");
    expect(r.decision).toBe("excluded_fiber_competitor");
    expect(r.eligible).toBe(false);
    expect(r.fiberCompetitors).toContain("Google Fiber");
  });

  it("fiber implied by the carrier NAME even when tech is blank → excluded", () => {
    expect(evaluateSingleCompetitor("Ripple Fiber", null).decision).toBe("excluded_fiber_competitor");
    expect(evaluateSingleCompetitor("Lumos", null).decision).toBe("excluded_fiber_competitor");
    expect(evaluateSingleCompetitor("Verizon", "Fiber to the Premises").decision).toBe("excluded_fiber_competitor");
  });

  it("Kinetic + Spectrum + ANOTHER fiber provider → excluded (Spectrum being present does not save it)", () => {
    const r = classifyCompetitiveEligibility([
      { name: "Spectrum", tech: "Cable" },
      { name: "AT&T Fiber", tech: "Fiber to the Premises" },
    ]);
    expect(r.decision).toBe("excluded_fiber_competitor");
    expect(r.eligible).toBe(false);
  });

  it("unknown competitor technology → review (fail closed), never eligible", () => {
    const r = evaluateSingleCompetitor("Randolph Telephone Telecommunications Inc.", null);
    expect(r.decision).toBe("competitor_review");
    expect(r.eligible).toBe(false);
    expect(r.reviewCompetitors.length).toBe(1);
  });

  it("a fiber competitor outranks an unknown one (excluded beats review)", () => {
    const r = classifyCompetitiveEligibility([
      { name: "Mystery ISP", tech: null },
      { name: "Google Fiber", tech: "Fiber to the Premises" },
    ]);
    expect(r.decision).toBe("excluded_fiber_competitor");
  });

  it("free-text fiber wording anywhere in the fields → excluded", () => {
    expect(evaluateSingleCompetitor("Acme Broadband", "Gigabit FTTH service").eligible).toBe(false);
    expect(evaluateSingleCompetitor("Acme Broadband", "GPON").eligible).toBe(false);
  });

  it("stamps the classifier version for audit", () => {
    expect(evaluateSingleCompetitor("Spectrum", "Cable").version).toBe(COMPETITIVE_ELIGIBILITY_VERSION);
  });

  it("classifyCompetitor maps the real observed values correctly", () => {
    expect(classifyCompetitor({ name: "Spectrum", tech: "Cable" }).klass).toBe("cable");
    expect(classifyCompetitor({ name: "Starlink", tech: "NGSO Satellite" }).klass).toBe("satellite");
    expect(classifyCompetitor({ name: "Google Fiber", tech: "Fiber to the Premises" }).klass).toBe("fiber");
    expect(classifyCompetitor({ name: null, tech: "Licensed Fixed Wireless" }).klass).toBe("wireless");
    expect(classifyCompetitor({ name: "NO COMPETITOR", tech: null }).klass).toBe("none");
    expect(classifyCompetitor({ name: "Randolph Telephone Telecommunications Inc.", tech: null }).klass).toBe("unknown");
  });
});
