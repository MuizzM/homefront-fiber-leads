import { describe, expect, it } from "vitest";
import { estimateStripeConnectCost } from "../../shared/payoutCosts";

describe("Stripe Connect cost estimate", () => {
  it("estimates the published payout and monthly active-account fees in cents", () => {
    expect(estimateStripeConnectCost(1_000_000, 5)).toEqual({
      payoutRunFeeCents: 2_625,
      activeAccountsMonthlyCents: 1_000,
      firstRunPlusMonthlyCents: 3_625,
    });
  });

  it("normalizes negative and fractional inputs without floating-point money", () => {
    expect(estimateStripeConnectCost(-100, -2)).toEqual({
      payoutRunFeeCents: 0,
      activeAccountsMonthlyCents: 0,
      firstRunPlusMonthlyCents: 0,
    });
    expect(estimateStripeConnectCost(12_345.9, 2.9)).toEqual({
      payoutRunFeeCents: 81,
      activeAccountsMonthlyCents: 400,
      firstRunPlusMonthlyCents: 481,
    });
  });
});
