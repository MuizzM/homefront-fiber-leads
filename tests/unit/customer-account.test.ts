import { describe, expect, it } from "vitest";
import { readAccount } from "../../shared/futureService";
import { maskAccountNumber } from "../../server/customerAccount";

describe("reading the provider's account record", () => {
  // The SHAPE is taken from a real payload for billingStatus 'A'; the account
  // number is synthetic. Never commit a real customer's account number.
  const withAccount = {
    address: {
      householdSegmentType: "TENURED", billingStatus: "A", billingSystem: "CAMS",
      localAccountNumber: "000000123", accountTier: "Tier 10", accountSubTier: "Tier 10",
    },
  };

  it("reads the account, tier and billing system", () => {
    expect(readAccount(withAccount)).toEqual({
      accountNumber: "000000123", tier: "Tier 10", subTier: "Tier 10", billingSystem: "CAMS",
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
    expect(maskAccountNumber("000000123")).toBe("..0123");
    expect(maskAccountNumber("12")).toBe("..12");
    expect(maskAccountNumber("")).toBeNull();
    expect(maskAccountNumber(null)).toBeNull();
    // The mask never contains the leading digits.
    expect(maskAccountNumber("000000123")).not.toContain("00000012");
  });
});
