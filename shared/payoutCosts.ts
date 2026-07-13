// Published US Stripe Connect "platform handles pricing" estimate.
// Pricing can vary by contract and can change; callers must label this an estimate.
// Amounts are integer cents so the UI never introduces floating-point money math.
export const STRIPE_CONNECT_ESTIMATE = Object.freeze({
  activeAccountMonthlyCents: 200,
  payoutFixedCents: 25,
  payoutRateBasisPoints: 25, // 0.25%
});

export interface StripeConnectCostEstimate {
  payoutRunFeeCents: number;
  activeAccountsMonthlyCents: number;
  firstRunPlusMonthlyCents: number;
}

export function estimateStripeConnectCost(
  payoutTotalCents: number,
  payoutCount: number,
): StripeConnectCostEstimate {
  const total = Math.max(0, Math.trunc(payoutTotalCents));
  const count = Math.max(0, Math.trunc(payoutCount));
  const percentageCents = Math.round(
    (total * STRIPE_CONNECT_ESTIMATE.payoutRateBasisPoints) / 10_000,
  );
  const payoutRunFeeCents = percentageCents + count * STRIPE_CONNECT_ESTIMATE.payoutFixedCents;
  const activeAccountsMonthlyCents = count * STRIPE_CONNECT_ESTIMATE.activeAccountMonthlyCents;
  return {
    payoutRunFeeCents,
    activeAccountsMonthlyCents,
    firstRunPlusMonthlyCents: payoutRunFeeCents + activeAccountsMonthlyCents,
  };
}
