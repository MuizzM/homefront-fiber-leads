// ── Ranks: the commission ladder with names on it ────────────────────────────
// Bronze / Silver / Gold / Platinum are NOT a parallel system — they are the
// rep's existing retroactive bands, named. Rank 1 IS band 1. That derivation is
// the whole design: a rank system with its own thresholds would eventually
// disagree with pay, and a badge that says Gold while the paycheck says Silver
// is worse than no badge at all. Everything here is a pure projection of the
// same CommissionTier[] the money engine pays from.
//
// PURE and framework-free (the shared-module rule): imported by the rep's
// commission screen, the manager's tier editor, and tests. No colors here —
// presentation lives in the client; this module owns names and math only.

import {
  calculateRetroactiveCommission,
  validateTiers,
  type CommissionTier,
} from "./commissionTiers";

// Metal names in ladder order. A 2-band ladder is Bronze→Silver (everyone
// starts at Bronze — a ladder that opens on Platinum has nowhere to go and
// reads as a participation trophy). Ladders deeper than the named metals
// extend as Diamond II, Diamond III… rather than inventing fake metals.
const RANK_NAMES = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"] as const;

export function rankNameForBand(bandIndex: number, totalBands: number): string {
  void totalBands; // names count up from Bronze regardless of ladder depth
  if (bandIndex < RANK_NAMES.length) return RANK_NAMES[bandIndex];
  return `Diamond ${bandIndex - RANK_NAMES.length + 2}`; // 5→"Diamond 2", 6→"Diamond 3"
}

export interface Rank {
  name: string;
  bandIndex: number;          // 0-based position in the validated ladder
  minimumSales: number;
  maximumSales: number | null;
  rateCents: number;
  /** The week's TOTAL pay at the first sale of this rank — the retroactive
   *  number, not the marginal one. Entering Silver at 7 sales on a $225 band
   *  is $1,575, and that is the number that moves a rep. */
  weekPayAtEntryCents: number;
}

export interface RankProgress {
  /** Every rank on this rep's ladder, in order — the rail the UI renders. */
  ladder: Rank[];
  /** The rank the current qualified count lands in; null before the first sale. */
  current: Rank | null;
  /** The next rank up; null at the top of the ladder. */
  next: Rank | null;
  salesToNext: number | null;
  /** Week pay now vs. week pay at the next rank's first sale. */
  weekPayNowCents: number;
  weekPayAtNextCents: number | null;
  /** The full retroactive jump: next-entry pay minus pay now. This is the
   *  incentive number — it prices the remaining sales AND the reprice of
   *  every sale already made. */
  gainAtNextCents: number | null;
  /** 0..1 progress from the current position toward the next rank's entry. */
  progressToNext: number | null;
  atTop: boolean;
}

/**
 * Project a validated ladder + this week's qualified count into ranks.
 *
 * Returns null when the ladder does not validate — a rank rail computed from
 * a broken ladder would show thresholds nobody can actually be paid at, so
 * refusing is the honest output (same contract as the money engine, which
 * throws on the same validator).
 */
export function rankProgress(tiers: CommissionTier[], qualifiedCount: number): RankProgress | null {
  const v = validateTiers(tiers ?? []);
  if (!v.ok) return null;
  const rows = v.normalized;
  const count = Number.isInteger(qualifiedCount) && qualifiedCount > 0 ? qualifiedCount : 0;

  const ladder: Rank[] = rows.map((t, i) => ({
    name: rankNameForBand(i, rows.length),
    bandIndex: i,
    minimumSales: t.minimumSales,
    maximumSales: t.maximumSales,
    rateCents: t.rateCents,
    weekPayAtEntryCents: calculateRetroactiveCommission(t.minimumSales, rows).grossCommissionCents,
  }));

  const currentIdx = rows.findIndex(
    t => count >= t.minimumSales && (t.maximumSales == null || count <= t.maximumSales),
  );
  const current = currentIdx >= 0 ? ladder[currentIdx] : null;
  const next = currentIdx >= 0
    ? (ladder[currentIdx + 1] ?? null)
    : ladder[0] ?? null;                        // pre-first-sale: Bronze is next

  const weekPayNowCents = count > 0
    ? calculateRetroactiveCommission(count, rows).grossCommissionCents
    : 0;

  if (!next) {
    return {
      ladder, current, next: null, salesToNext: null,
      weekPayNowCents, weekPayAtNextCents: null, gainAtNextCents: null,
      progressToNext: null, atTop: true,
    };
  }

  const salesToNext = Math.max(1, next.minimumSales - count);
  const weekPayAtNextCents = next.weekPayAtEntryCents;
  // Progress runs from the floor of the CURRENT rank (or 0 before Bronze) to
  // the NEXT RANK'S ENTRY sale. The endpoint must be the entry itself: with a
  // span ending one short, count = entry - 1 rendered a 100% bar beside the
  // text "1 sale to go" — a full bar that is not full is the one lie a
  // progress bar can tell.
  const floor = current ? current.minimumSales - 1 : 0;
  const span = next.minimumSales - floor;
  const progressToNext = span > 0 ? Math.min(1, Math.max(0, (count - floor) / span)) : 0;

  return {
    ladder, current, next, salesToNext,
    weekPayNowCents, weekPayAtNextCents,
    gainAtNextCents: weekPayAtNextCents - weekPayNowCents,
    progressToNext, atTop: false,
  };
}
