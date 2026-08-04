// ── Install-gated commission hold ─────────────────────────────────────────────
// Pure, shared policy math for the 90-day commission hold. Both the server
// (pay totals, confirm-install) and the client (held badges) read this one
// source so they can never drift.
//
// Semantics (no new lifecycle statuses — the legal set stays
// pending/approved/paid/disputed/superseded):
//   • A 'pending' commission under a tenant policy with requireInstallConfirm
//     is HELD until BOTH (a) a manager has confirmed the install
//     (installConfirmedAt set, payableAfter = installConfirmedAt + holdDays)
//     AND (b) now >= payableAfter.
//   • Held commissions keep status 'pending' but are excluded from PAYABLE
//     totals at read time; they surface with their payableAfter date instead.
//   • requireInstallConfirm = 0 → held is always false (legacy behavior).
//
// TERMINOLOGY: this is the INSTALL hold. It is NOT the chargeback-reserve
// "holdback" (shared/commissionReserve.ts) — a statement-level reserve
// percentage with its own ledger. API fields for this feature are named
// `installHold` so the two vocabularies never collide in a response.

export interface PayPolicyShape {
  requireInstallConfirm: boolean;
  holdDays: number;
}

// The effective policy for a tenant with no tenant_pay_policy row — mirrors
// the SQL column defaults (require install confirm, 90-day hold).
export const DEFAULT_PAY_POLICY: PayPolicyShape = Object.freeze({
  requireInstallConfirm: true,
  holdDays: 90,
});

export const HOLD_DAYS_MIN = 0;
export const HOLD_DAYS_MAX = 365;

export function clampHoldDays(value: unknown): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_PAY_POLICY.holdDays;
  return Math.min(HOLD_DAYS_MAX, Math.max(HOLD_DAYS_MIN, n));
}

export interface HoldableCommission {
  status: string;
  installConfirmedAt?: string | null;
  payableAfter?: string | null;
}

/**
 * Is this commission held (not yet payable) right now? Only 'pending' rows can
 * be held — approved/paid/disputed/superseded rows already left the payable
 * pipeline or followed their own lifecycle.
 */
export function isCommissionHeld(
  commission: HoldableCommission,
  policy: PayPolicyShape,
  now: Date = new Date(),
): boolean {
  if (!policy.requireInstallConfirm) return false;
  if (commission.status !== "pending") return false;
  if (!commission.installConfirmedAt || !commission.payableAfter) return true;
  const payableAt = Date.parse(commission.payableAfter);
  if (!Number.isFinite(payableAt)) return true; // corrupt timestamp → fail held
  return now.getTime() < payableAt;
}

/** payable_after = install confirmation instant + holdDays (ISO string). */
export function payableAfterFor(installConfirmedAt: Date, holdDays: number): string {
  return new Date(installConfirmedAt.getTime() + clampHoldDays(holdDays) * 86_400_000).toISOString();
}
