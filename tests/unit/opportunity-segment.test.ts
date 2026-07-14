import { describe, expect, it } from "vitest";
import { classifyCustomerOpportunity, classifyFiberAvailabilityTransition, opportunityRank } from "@shared/opportunitySegment";

describe("customer opportunity classification", () => {
  it("labels serviceable billing-N as provider-indicated, never confirmed", () => {
    expect(classifyCustomerOpportunity({ fiberAvailable: true, billingStatus: "N", householdSegmentType: "NEW FIBER" })).toMatchObject({
      segment: "new_opportunity", confidence: "medium", confirmed: false,
    });
  });
  it("labels billing-Y as likely existing and missing billing as unknown", () => {
    expect(classifyCustomerOpportunity({ fiberAvailable: true, billingStatus: "Y" }).segment).toBe("existing_customer");
    expect(classifyCustomerOpportunity({ fiberAvailable: true, billingStatus: null }).segment).toBe("unknown");
  });
});

describe("fiber transition truth", () => {
  it("does not call a first available observation fresh", () => {
    expect(classifyFiberAvailabilityTransition({ everObserved: false, fiberAvailable: false }, { conclusive: true, fiberAvailable: true })).toMatchObject({ status: "baseline_available", fresh: false });
  });
  it("calls only a proven unavailable-to-available change fresh", () => {
    expect(classifyFiberAvailabilityTransition({ everObserved: true, fiberAvailable: false }, { conclusive: true, fiberAvailable: true })).toMatchObject({ status: "freshly_available", fresh: true });
  });
  it("preserves truth on failures", () => {
    expect(classifyFiberAvailabilityTransition({ everObserved: true, fiberAvailable: true }, { conclusive: false, fiberAvailable: false })).toMatchObject({ status: "check_failed", record: false });
  });
});

it("ranks fresh, non-customer, cross-verified dense clusters first", () => {
  const hot = opportunityRank({ fresh: true, customerSegment: "new_opportunity", crossVerified: true, clusterDensity: 8, ageHours: 2 });
  const cold = opportunityRank({ fresh: false, customerSegment: "unknown", crossVerified: false, clusterDensity: 1, ageHours: 72 });
  expect(hot).toBeGreaterThan(cold);
  expect(hot).toBeGreaterThanOrEqual(90);
});
