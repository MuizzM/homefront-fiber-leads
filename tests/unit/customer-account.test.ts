import { describe, expect, it } from "vitest";
import { readAccount } from "../../shared/futureService";
import { maskAccountNumber } from "../../server/customerAccount";

describe("reading the provider's account record", () => {
  // The exact shape a real payload carries for billingStatus 'A'.
  const withAccount = {
    address: {
      householdSegmentType: "TENURED", billingStatus: "A", billingSystem: "CAMS",
      localAccountNumber: "061769244", accountTier: "Tier 10", accountSubTier: "Tier 10",
    },
  };

  it("reads the account, tier and billing system", () => {
    expect(readAccount(withAccount)).toEqual({
      accountNumber: "061769244", tier: "Tier 10", subTier: "Tier 10", billingSystem: "CAMS",
    });
  });

  it("reports nothing for a door with no account", () => {
    expect(readAccount({ address: { householdSegmentType: "NEW FIBER", billingStatus: "N" } }))
      .toEqual({ accountNumber: null, tier: null, subTier: null, billingSystem: null });
    expect(readAccount(undefined).accountNumber).toBeNull();
    expect(readAccount("nonsense").tier).toBeNull();
  });

  it("treats empty and null-ish provider values as absent", () => {
    expect(readAccount({ address: { localAccountNumber: "", accountTier: "null" } }))
      .toMatchObject({ accountNumber: null, tier: null });
  });

  it("masks the number to a tail that can never reconstruct it", () => {
    expect(maskAccountNumber("061769244")).toBe("..9244");
    expect(maskAccountNumber("12")).toBe("..12");
    expect(maskAccountNumber("")).toBeNull();
    expect(maskAccountNumber(null)).toBeNull();
    // The mask never contains the leading digits.
    expect(maskAccountNumber("061769244")).not.toContain("0617");
  });
});
