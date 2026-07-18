import { describe, it, expect } from "vitest";
import { classifyFrontierResponse } from "../../server/frontierScanner";
import type { ScanResult } from "../../server/scanner";

function base(): ScanResult {
  return {
    address: "2600 Ferrand Dr", city: "Durham", state: "NC", zip: "27705", lat: null, lng: null,
    fiberStatus: "unknown", isNewFiber: false, isTenured: false, fiberAvailable: false,
    maxDownloadKbps: null, maxDownloadMbps: null, speedTier: null,
    techType: null, chipSetType: null, placement: null, maxQual: null,
    competitorName: null, competitorSpeedMbps: null, competitorTech: null, inCompetitorArea: false,
    addressCatalogDate: null, householdSegmentType: null, billingStatus: null,
    exchangeId: null, dfAddressId: null, accessId: null, serviceKey: null,
    confidence: "LOW", apiSource: "failed", blocked: false, notes: "",
    leadTag: null, leadScore: 0,
  };
}
const pred = {
  addressKey: "k-1",
  address: { addressLine1: "2600 Ferrand Dr", city: "Durham", stateProvince: "NC", zipCode: "27705-1738" },
  inFootprint: true,
};

describe("classifyFrontierResponse", () => {
  it("FIBER + no existing service → NEW FIBER + billing N (RED fresh lead)", () => {
    const r = classifyFrontierResponse(base(), { plantType: "OVERLAY", techAvailable: "FIBER", isBroadbandEligible: true, addressHasExistingService: false }, pred as any);
    expect(r.fiberStatus).toBe("new_fiber");
    expect(r.householdSegmentType).toBe("NEW FIBER");
    expect(r.billingStatus).toBe("N");
    expect(r.fiberAvailable).toBe(true);
    expect(r.apiSource).toBe("kinetic_live");
  });

  it("FIBER + existing service → billing Y (watch / NOW_ACTIVE)", () => {
    const r = classifyFrontierResponse(base(), { plantType: "OVERLAY", techAvailable: "FIBER", addressHasExistingService: true }, pred as any);
    expect(r.fiberStatus).toBe("new_fiber");
    expect(r.billingStatus).toBe("Y");
  });

  it("future fiber eligible → coming-soon watch", () => {
    const r = classifyFrontierResponse(base(), { plantType: "COPPER", techAvailable: "COPPER", isFutureFiberEligible: true, fiberBuildOutStatus: "IN_PROGRESS" }, pred as any);
    expect(r.isNewFiber).toBe(true);
    expect(r.billingStatus).toBe("Y");
    expect(r.notes).toMatch(/coming soon/i);
  });

  it("copper plant → copper pool", () => {
    const r = classifyFrontierResponse(base(), { plantType: "COPPER", techAvailable: "SMARTVOICE" }, pred as any);
    expect(r.fiberStatus).toBe("copper");
    expect(r.fiberAvailable).toBe(false);
  });

  it("Verizon redirect → no_service", () => {
    const r = classifyFrontierResponse(base(), { redirect: { reason: "VZ_ELIGIBLE" } }, pred as any);
    expect(r.fiberStatus).toBe("no_service");
    expect(r.fiberAvailable).toBe(false);
  });

  it("NO_TERMINAL → no_service", () => {
    const r = classifyFrontierResponse(base(), { plantType: "NO_TERMINAL", techAvailable: "NONE" }, pred as any);
    expect(r.fiberStatus).toBe("no_service");
  });
});
