import { describe, it, expect } from "vitest";
import { parseKineticResponse, classifyKineticResult, parseUqual } from "../../server/kineticResponseParser";
import { KINETIC_345_JAMES_ALLGOOD as FIX } from "../fixtures/kinetic345JamesAllgood";

describe("canonical Kinetic parser + classifier - 345 James Allgood Dr regression", () => {
  const parsed = parseKineticResponse(FIX);

  it("1) parses the real field paths incl. the stringified uqualProvisioningResult", () => {
    expect(parsed.householdSegmentType).toBe("NEW FIBER");
    expect(parsed.billingStatus).toBe("N");
    expect(parsed.technology).toBe("FIBER");
    expect(parsed.finalQualSpeedKbps).toBe(2_000_000);
    expect(parsed.chipSetType).toBe("FTTP");
    expect(parsed.serviceKey).toBe("SVC-345JA-FTTP");
    expect(parsed.serviceStatus).toBe("AVAILABLE");
    expect(parsed.dfAddressId).toBe("DF-345-JAMES-ALLGOOD");
    expect(parsed.dfAddressIdXref).toBe("XREF-345-JA");
    expect(parsed.accessId).toBe("ACC-345-JA-0001");
    expect(parsed.productId).toBe(2347);
    expect(parsed.lat).toBeCloseTo(35.020537, 6);
    expect(parsed.lng).toBeCloseTo(-82.078668, 6);
    expect(parsed.exactMatch).toBe(true);
    expect(parsed.addressFound).toBe(true);
  });

  it("2) classifies as FRESH_LEAD", () => {
    expect(classifyKineticResult(parsed)).toBe("FRESH_LEAD");
  });

  it("3) the COPPER 'remove fiber area' override does NOT invalidate FIBER", () => {
    expect(parsed.copperOverridePresent).toBe(true); // the override IS present …
    expect(parsed.fiberQualified).toBe(true); // … but fiber remains qualified
    expect(classifyKineticResult(parsed)).toBe("FRESH_LEAD");
    // The nested payload alone still qualifies fiber despite the copper override.
    const u = parseUqual(FIX.uqualProvisioningResult);
    expect(u.fiberService).toBeTruthy();
    expect(u.fiberService.chipSetType).toBe("FTTP");
    expect(u.copperOverridePresent).toBe(true);
    // Even if the TOP-LEVEL tech were blanked, the nested fiber service still wins.
    const noTopTech = parseKineticResponse({ ...FIX, techType: "", address: { ...FIX.address, maxQualTechnologyType: "" } });
    expect(noTopTech.fiberQualified).toBe(true);
    expect(classifyKineticResult(noTopTech)).toBe("FRESH_LEAD");
  });

  it("4) categories: NEW FIBER+Y = NOW_ACTIVE; missing billing/segment or failure = UNRESOLVED", () => {
    expect(classifyKineticResult(parseKineticResponse({ ...FIX, address: { ...FIX.address, billingStatus: "Y" } }))).toBe("NOW_ACTIVE");
    expect(classifyKineticResult(parseKineticResponse({ ...FIX, address: { ...FIX.address, billingStatus: "" } }))).toBe("UNRESOLVED");
    expect(classifyKineticResult(parseKineticResponse({ ...FIX, address: { ...FIX.address, householdSegmentType: "" } }))).toBe("UNRESOLVED");
    expect(classifyKineticResult(parseKineticResponse({ ...FIX, success: false }))).toBe("UNRESOLVED");
    expect(classifyKineticResult(parseKineticResponse({ ...FIX, validationResult: "AddressNotFound" }))).toBe("NO_SERVICE");
  });

  it("does not let a missing/weaker nested value overwrite a valid top-level value", () => {
    // Top-level speed present, nested speed absent → keep the top-level speed.
    const p = parseKineticResponse({ ...FIX, uqualProvisioningResult: JSON.stringify({ miror: { svcKey: "K" } }) });
    expect(p.finalQualSpeedKbps).toBe(2_000_000);
    expect(p.technology).toBe("FIBER"); // top-level techType still wins
  });
});
