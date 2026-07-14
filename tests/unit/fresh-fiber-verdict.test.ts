import { describe, expect, it } from "vitest";
import { decideFreshFiber } from "../../shared/freshFiberVerdict";

describe("decideFreshFiber", () => {
  it("returns fresh only when new fiber, real fiber service, and no subscriber all agree", () => {
    expect(decideFreshFiber({
      apiSource: "kinetic_live",
      fiberStatus: "new_fiber",
      isNewFiber: true,
      fiberAvailable: true,
      billingStatus: "N",
    })).toMatchObject({ verdict: "fresh", isFreshFiber: true });
  });

  it.each([
    { fiberStatus: "tenured_fiber", isNewFiber: false, fiberAvailable: true, billingStatus: "N" },
    { fiberStatus: "new_fiber", isNewFiber: true, fiberAvailable: true, billingStatus: "Y" },
    { fiberStatus: "copper", isNewFiber: false, fiberAvailable: false, billingStatus: "N" },
    { fiberStatus: "no_service", isNewFiber: false, fiberAvailable: false, billingStatus: null },
  ])("returns a conclusive no for a non-fresh answer", evidence => {
    expect(decideFreshFiber({ apiSource: "kinetic_live", ...evidence })).toMatchObject({
      verdict: "not_fresh",
      isFreshFiber: false,
    });
  });

  it.each([
    { apiSource: "failed", fiberStatus: "unknown" },
    { apiSource: "kinetic_live", fiberStatus: "unknown" },
    { apiSource: "failed", fiberStatus: "new_fiber", isNewFiber: true, fiberAvailable: true, billingStatus: "N" },
    { apiSource: "kinetic_live", fiberStatus: "new_fiber", blocked: true, isNewFiber: true, fiberAvailable: true, billingStatus: "N" },
  ])("never turns a non-answer into not-fresh", evidence => {
    expect(decideFreshFiber(evidence)).toMatchObject({ verdict: "unverified", isFreshFiber: null });
  });
});
