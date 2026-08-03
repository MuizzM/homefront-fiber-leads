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
  /** Ceiling the balance may never exceed. `null` = uncapped (accrues forever). */
  reserveCapCents: number | null;
  /** Balance the split was computed against (0 when the caller passed none). */
  balanceBeforeCents: number;
  /** balanceBefore + reserveCents — never above the cap, never below zero. */
  balanceAfterCents: number;
  /** Room left under the cap BEFORE this period's hold. `null` = uncapped. */
  capRemainingCents: number | null;
  /** True when the balance is AT the cap after this period — "fully covered",
   *  nothing more will be held. Always false when uncapped. */
  atCap: boolean;
}

/** The default chargeback-reserve ceiling: $2,500. Applied when neither the rep
 *  nor the tenant sets one. A cap of 0 (or a negative) means UNCAPPED — an
 *  explicit "never stop accruing", which is the pre-cap behaviour. */
export const DEFAULT_RESERVE_CAP_CENTS = 250_000;

/** Normalize a configured cap into `null` (uncapped) or a non-negative integer. */
export function normalizeReserveCap(capCents: number | null | undefined): number | null {
  if (capCents == null) return null;
  const c = Math.trunc(capCents);
  return c > 0 ? c : null;   // 0 / negative = deliberately uncapped
}

/**
 * Split an earned commission into reserve + net, honouring an optional cap.
 *
 * - A non-positive earned amount (a net-negative week after adjustments, or
 *   zero) withholds nothing: you cannot reserve against money that isn't there,
 *   and a negative reserve would be a payment, not a holdback.
 * - The rate is clamped to 0..100 whole percent; a nonsensical config can never
 *   reserve more than the whole commission or a negative amount.
 * - reserveCents is `round(earned × pct / 100)` and net is the exact remainder,
 *   so the two always re-sum to earned — the invariant every display relies on.
 * - With a cap, the hold is TRIMMED to the room left under it:
 *       min(round(earned × pct / 100), max(0, cap − currentBalance))
 *   so the reserve stops dead at the cap and can never overshoot it. The trimmed
 *   cents are paid to the rep, not lost: reserve + net === earned still holds.
 *   A balance already at/over the cap withholds nothing (`atCap: true`).
 *
 * Both cap inputs are OPTIONAL — omitting them reproduces the original
 * uncapped split exactly, so every existing caller is unchanged.
 */
export function computeHoldback(input: {
  earnedCents: number;
  reservePercent: number;
  /** Ceiling for the running balance. Omit/null/0 = uncapped. */
  reserveCapCents?: number | null;
  /** The rep's reserve balance BEFORE this period. Omit = 0. */
  currentBalanceCents?: number | null;
}): Holdback {
  const earnedCents = Math.trunc(input.earnedCents || 0);
  const reservePercent = Math.min(100, Math.max(0, Math.trunc(input.reservePercent || 0)));
  const reserveCapCents = normalizeReserveCap(input.reserveCapCents);
  // A balance is never negative (the ledger forbids it); clamp defensively so a
  // corrupt read can never manufacture extra headroom under the cap.
  const balanceBeforeCents = Math.max(0, Math.trunc(input.currentBalanceCents || 0));
  const capRemainingCents = reserveCapCents == null ? null : Math.max(0, reserveCapCents - balanceBeforeCents);

  const uncapped = earnedCents <= 0 || reservePercent === 0
    ? 0
    : Math.round((earnedCents * reservePercent) / 100);
  const reserveCents = capRemainingCents == null ? uncapped : Math.min(uncapped, capRemainingCents);
  const balanceAfterCents = balanceBeforeCents + reserveCents;
  return {
    reservePercent, reserveCents, netPayableCents: earnedCents - reserveCents, earnedCents,
    reserveCapCents, balanceBeforeCents, balanceAfterCents, capRemainingCents,
    atCap: reserveCapCents != null && balanceAfterCents >= reserveCapCents,
  };
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
