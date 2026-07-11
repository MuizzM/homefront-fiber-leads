import { describe, it, expect } from "vitest";
import { classifyScanResult } from "../../server/kineticProbe";
import type { ScanResult } from "../../server/scanner";

// The typed probe boundary must decide outcome KIND from TYPED fields (blocked /
// apiSource / fiberStatus), never from the human `notes` string — that coupling is
// exactly what silently broke backoff before. These cases pin the mapping.

const mk = (over: Partial<ScanResult>): ScanResult => ({
  address: "1 Test St", city: "Broadway", state: "NC", zip: "27505",
  lat: null, lng: null,
  fiberStatus: "unknown", isNewFiber: false, isTenured: false, fiberAvailable: false,
  maxDownloadKbps: null, maxDownloadMbps: null, speedTier: null,
  techType: null, chipSetType: null, placement: null, maxQual: null,
  competitorName: null, competitorSpeedMbps: null, competitorTech: null, inCompetitorArea: false,
  addressCatalogDate: null, householdSegmentType: null, billingStatus: null,
  exchangeId: null, dfAddressId: null, accessId: null,
  confidence: "LOW", apiSource: "failed", blocked: false, notes: "",
  leadTag: null, leadScore: 0, ...over,
});

describe("classifyScanResult", () => {
  it("a 403 throttle → blocked, regardless of notes wording", () => {
    // Even with EMPTY notes, the typed flag decides — no regex on the string.
    expect(classifyScanResult(mk({ blocked: true, apiSource: "failed", notes: "" }))).toBe("blocked");
    expect(classifyScanResult(mk({ blocked: true, apiSource: "failed", notes: "some future reworded text" }))).toBe("blocked");
  });

  it("a live NEW FIBER answer → answered", () => {
    expect(classifyScanResult(mk({ apiSource: "kinetic_live", fiberStatus: "new_fiber", isNewFiber: true }))).toBe("answered");
  });

  it("a live copper / tenured / existing answer → answered", () => {
    expect(classifyScanResult(mk({ apiSource: "kinetic_live", fiberStatus: "copper" }))).toBe("answered");
    expect(classifyScanResult(mk({ apiSource: "kinetic_live", fiberStatus: "tenured_fiber" }))).toBe("answered");
    expect(classifyScanResult(mk({ apiSource: "kinetic_live", fiberStatus: "existing_fiber" }))).toBe("answered");
  });

  it("a conclusive not-serviceable verdict → no_service", () => {
    expect(classifyScanResult(mk({ apiSource: "kinetic_live", fiberStatus: "no_service" }))).toBe("no_service");
  });

  it("a soft failure / non-answer → inconclusive (never no_service, never blocked)", () => {
    expect(classifyScanResult(mk({ apiSource: "failed", blocked: false, notes: "Non-conclusive response" }))).toBe("inconclusive");
    expect(classifyScanResult(mk({ apiSource: "failed", blocked: false, notes: "Check failed — no signal: timeout" }))).toBe("inconclusive");
  });

  it("blocked wins even if apiSource somehow reads kinetic_live (defensive precedence)", () => {
    expect(classifyScanResult(mk({ blocked: true, apiSource: "kinetic_live", fiberStatus: "no_service" }))).toBe("blocked");
  });
});
