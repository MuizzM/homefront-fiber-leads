// ── Earnings ledger (PURE) — one row per thing a worker earned ──────────────
//
// The unified financial view across commissions, overrides, spiffs, training
// bonuses, mileage and referral rewards.
//
// ── PROJECTION FOR OLD MONEY, NATIVE FOR NEW ────────────────────────────────
// This ledger is deliberately NOT a second source of truth for money that
// already has one. The weekly commission plane computes a statement by summing
// five source tables, and those sums are what `commission_statements` froze and
// what reps have already been paid from. Making the ledger authoritative for
// them would mean backfilling history — and a backfill that disagrees by one
// cent rewrites a FINALIZED statement, which is the exact failure
// `commission_statements` immutability exists to prevent.
//
// So each earning type has an ORIGIN:
//
//   PROJECTED — derived, deterministically, from the existing source table.
//               Rebuildable at any time; never the thing that decides pay.
//   NATIVE    — this ledger IS the source. Only for money the platform did not
//               previously have anywhere: mileage, referral rewards, and
//               engine-driven incentives.
//
// The reconciliation rule below is what keeps the two honest: for any rep-week,
// the ledger's projected rows must re-sum to the statement's own `earned`.
// A drift is a bug in the projection, never a reason to change the statement.

export const EARNING_TYPES = [
  "PERSONAL_COMMISSION",
  "TEAM_LEAD_OVERRIDE",
  "MANAGER_OVERRIDE",
  "SPIFF",
  "TRAINING_BONUS",
  "REFERRAL_BONUS",
  "MILEAGE_REIMBURSEMENT",
  "HOURLY",
  "ADJUSTMENT",
  "CLAWBACK",
] as const;
export type EarningType = (typeof EARNING_TYPES)[number];

export type LedgerOrigin = "PROJECTED" | "NATIVE";

/** Where a row came from, so a rebuild can find it again. */
export type SourceType =
  | "commission_statement" | "commission_override" | "commission_adjustment"
  | "hourly_block" | "spiff" | "mileage_trip" | "referral";

/**
 * Origin is a property of the SOURCE, never of the earning type.
 *
 * This distinction is load-bearing and easy to get wrong. A CLAWBACK row can
 * arise two ways: from an approved negative `commission_adjustment` (which the
 * statement already counted, so it is PROJECTED) or from the incentive engine
 * reversing one of its own awards (which the statement never saw, so it is
 * NATIVE). Deriving origin from the earning type would classify both the same
 * way — and since reconciliation only sums PROJECTED rows, a mis-classified
 * adjustment silently drops out of the comparison and every week with a
 * negative adjustment reports a false drift.
 *
 * HOURLY is projected rather than native even though it is simple, because
 * `hourlyPay` already folds into the statement and a second authority for it
 * would be the same double-truth problem in miniature.
 */
export const SOURCE_ORIGIN: Record<SourceType, LedgerOrigin> = {
  commission_statement: "PROJECTED",
  commission_override: "PROJECTED",
  commission_adjustment: "PROJECTED",
  hourly_block: "PROJECTED",
  // Engine spiffs, mileage and referral rewards are money the platform had no
  // home for before this ledger, so it can be their home without displacing
  // anything.
  spiff: "NATIVE",
  mileage_trip: "NATIVE",
  referral: "NATIVE",
};

export function originOf(sourceType: SourceType): LedgerOrigin {
  return SOURCE_ORIGIN[sourceType];
}
export function isNativeSource(sourceType: SourceType): boolean {
  return SOURCE_ORIGIN[sourceType] === "NATIVE";
}

export const LEDGER_STATUSES = ["PENDING", "APPROVED", "PAID", "REVERSED"] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export interface EarningsLedgerRow {
  id: number;
  tenantId: number;
  recipientUserId: number | null;
  recipientRepId: number;
  sourceType: SourceType;
  sourceId: number;
  earningType: EarningType;
  origin: LedgerOrigin;
  grossCents: number;
  adjustmentCents: number;
  netCents: number;
  status: LedgerStatus;
  /** The date that puts this earning in a pay period (YYYY-MM-DD). */
  effectiveDate: string;
  /** Which comp plan version priced it, when one applies. */
  compensationPlanVersion: number | null;
  /** Frozen inputs, so the number can be explained years later. */
  calculationSnapshot: Record<string, unknown> | null;
  idempotencyKey: string;
  createdAt: string;
}

/** Net is always gross + adjustment. Stated once, here, so no caller invents
 *  its own arithmetic and drifts. */
export function netOf(grossCents: number, adjustmentCents: number): number {
  return Math.trunc(grossCents || 0) + Math.trunc(adjustmentCents || 0);
}

/**
 * The idempotency key for a ledger row.
 *
 * `(sourceType, sourceId, earningType)` is the natural identity: one override
 * row produces one TEAM_LEAD_OVERRIDE earning, one trip produces one
 * MILEAGE_REIMBURSEMENT. The earning type is part of it because a single source
 * can legitimately produce two kinds of row — a statement produces both a
 * PERSONAL_COMMISSION and (separately) an HOURLY line.
 */
export function ledgerKey(sourceType: SourceType, sourceId: number, earningType: EarningType): string {
  return `${sourceType}:${sourceId}:${earningType}`;
}

// ── Summaries ───────────────────────────────────────────────────────────────

export interface EarningsSummary {
  /** Per earning type, net cents. Only types actually present appear. */
  byType: Partial<Record<EarningType, number>>;
  /** Everything not yet approved — a claim, not a debt. */
  pendingCents: number;
  /** Approved and owed. */
  approvedCents: number;
  paidCents: number;
  reversedCents: number;
  /** Approved + paid: what the worker has actually earned. */
  earnedCents: number;
  rowCount: number;
}

/**
 * Roll ledger rows into the numbers a dashboard shows.
 *
 * PENDING is reported separately from APPROVED throughout, for the same reason
 * the mileage summary does it: blending a claim with a debt overstates what is
 * owed, and a rep shown one number that mixes them will read the larger one as
 * a promise.
 */
export function summarizeEarnings(rows: readonly Pick<EarningsLedgerRow, "earningType" | "netCents" | "status">[]): EarningsSummary {
  const out: EarningsSummary = {
    byType: {}, pendingCents: 0, approvedCents: 0, paidCents: 0,
    reversedCents: 0, earnedCents: 0, rowCount: rows.length,
  };
  for (const r of rows) {
    const net = Math.trunc(r.netCents || 0);
    out.byType[r.earningType] = (out.byType[r.earningType] ?? 0) + net;
    switch (r.status) {
      case "PENDING": out.pendingCents += net; break;
      case "APPROVED": out.approvedCents += net; break;
      case "PAID": out.paidCents += net; break;
      case "REVERSED": out.reversedCents += net; break;
    }
  }
  out.earnedCents = out.approvedCents + out.paidCents;
  return out;
}

// ── Reconciliation ──────────────────────────────────────────────────────────

export interface ReconciliationResult {
  ok: boolean;
  /** Sum of the ledger's PROJECTED rows for the period. */
  ledgerCents: number;
  /** What the statement itself says the rep earned. */
  statementCents: number;
  /** ledger − statement. Non-zero means the PROJECTION is wrong. */
  driftCents: number;
  /** Which types contributed, for pinpointing a drift. */
  byType: Partial<Record<EarningType, number>>;
}

/**
 * Does the ledger's projection of a rep-week agree with the statement?
 *
 * Deliberately compares ONLY projected rows: native rows (mileage, referral,
 * engine spiffs) are earnings the statement never knew about, so including them
 * would report a drift on every correct week.
 *
 * A non-zero drift is always a bug HERE — the statement is the authority for
 * projected money, and this function exists to prove the mirror is faithful,
 * never to correct the thing it mirrors.
 */
export function reconcile(
  rows: readonly Pick<EarningsLedgerRow, "earningType" | "netCents" | "origin">[],
  statementEarnedCents: number,
): ReconciliationResult {
  const byType: Partial<Record<EarningType, number>> = {};
  let ledgerCents = 0;
  for (const r of rows) {
    if (r.origin !== "PROJECTED") continue;
    const net = Math.trunc(r.netCents || 0);
    ledgerCents += net;
    byType[r.earningType] = (byType[r.earningType] ?? 0) + net;
  }
  const statementCents = Math.trunc(statementEarnedCents || 0);
  const driftCents = ledgerCents - statementCents;
  return { ok: driftCents === 0, ledgerCents, statementCents, driftCents, byType };
}

/** Money that has moved and must never be edited in place. */
export function isLedgerLocked(status: LedgerStatus): boolean {
  return status === "PAID";
}
