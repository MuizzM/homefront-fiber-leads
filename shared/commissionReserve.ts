// ── Chargeback reserve (holdback) — PURE, integer-cents ──────────────────────
// The Commission Agreement withholds a percentage of otherwise-payable
// commissions as a chargeback reserve: the rep is paid the NET this period, and
// the reserve accrues until it is released (per the agreement, within 90 days
// after termination, less valid chargebacks/reversals/offsets).
//
// This module owns ONLY the split arithmetic. It changes no stored payroll and
// applies to a single earned amount; the caller decides which statements it
// runs on (open weeks only — an already-earned, locked week is never re-split).
//
// Integer cents throughout, same discipline as shared/money and the tier engine
// — never binary floats. The reserve is the ROUNDED cut and the net is the
// remainder, so reserve + net === earned EXACTLY at every input (no lost or
// invented cent).

export interface Holdback {
  /** Whole-percent rate applied (0 = holdback disabled for this tenant). */
  reservePercent: number;
  /** Cents withheld this period. 0 when earned ≤ 0 or the rate is 0. */
  reserveCents: number;
  /** Cents actually payable this period = earned − reserve. */
  netPayableCents: number;
  /** The earned amount the split was taken from, echoed for display. */
  earnedCents: number;
}

/**
 * Split an earned commission into reserve + net.
 *
 * - A non-positive earned amount (a net-negative week after adjustments, or
 *   zero) withholds nothing: you cannot reserve against money that isn't there,
 *   and a negative reserve would be a payment, not a holdback.
 * - The rate is clamped to 0..100 whole percent; a nonsensical config can never
 *   reserve more than the whole commission or a negative amount.
 * - reserveCents is `round(earned × pct / 100)` and net is the exact remainder,
 *   so the two always re-sum to earned — the invariant every display relies on.
 */
export function computeHoldback(input: { earnedCents: number; reservePercent: number }): Holdback {
  const earnedCents = Math.trunc(input.earnedCents || 0);
  const reservePercent = Math.min(100, Math.max(0, Math.trunc(input.reservePercent || 0)));

  if (earnedCents <= 0 || reservePercent === 0) {
    return { reservePercent, reserveCents: 0, netPayableCents: earnedCents, earnedCents };
  }
  const reserveCents = Math.round((earnedCents * reservePercent) / 100);
  return { reservePercent, reserveCents, netPayableCents: earnedCents - reserveCents, earnedCents };
}

export interface ReserveLedger {
  reservePercent: number;
  /** Reserve accrued across the statements summed by the caller. */
  reserveBalanceCents: number;
  /** Net paid across those statements. */
  netPaidCents: number;
  /** Gross earned across those statements = balance + netPaid. */
  earnedToDateCents: number;
}

/**
 * Roll a set of per-period earned amounts into a running reserve ledger. Pure
 * fold over computeHoldback so the balance can never disagree with the
 * per-period splits shown on each statement.
 */
export function rollupReserve(earnedCentsByPeriod: number[], reservePercent: number): ReserveLedger {
  let reserveBalanceCents = 0;
  let netPaidCents = 0;
  for (const earned of earnedCentsByPeriod) {
    const h = computeHoldback({ earnedCents: earned, reservePercent });
    reserveBalanceCents += h.reserveCents;
    netPaidCents += h.netPayableCents;
  }
  return {
    reservePercent: Math.min(100, Math.max(0, Math.trunc(reservePercent || 0))),
    reserveBalanceCents,
    netPaidCents,
    earnedToDateCents: reserveBalanceCents + netPaidCents,
  };
}
