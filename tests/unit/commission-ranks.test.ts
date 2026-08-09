// Ranks are the commission bands with names on them — a pure projection of the
// SAME ladder the money engine pays from. The one invariant that matters: a
// rank can never disagree with pay, because it is derived from pay.
import { describe, expect, it } from "vitest";
import { rankNameForBand, rankProgress } from "../../shared/commissionRanks";
import type { CommissionTier } from "../../shared/commissionTiers";

const t = (min: number, max: number | null, rate: number, i: number): CommissionTier =>
  ({ position: i, minimumSales: min, maximumSales: max, rateCents: rate, label: "" });

/** The operator's real ladder: 1-6 $175 (Bronze), 7+ $225 (Silver). */
const TWO = [t(1, 6, 17500, 0), t(7, null, 22500, 1)];
/** The standard four-band ladder → Bronze/Silver/Gold/Platinum exactly. */
const FOUR = [t(1, 7, 15000, 0), t(8, 12, 20000, 1), t(13, 16, 25000, 2), t(17, null, 30000, 3)];

describe("names count up from Bronze", () => {
  it("a two-band ladder is Bronze then Silver - never opening on Platinum", () => {
    const p = rankProgress(TWO, 3)!;
    expect(p.ladder.map(r => r.name)).toEqual(["Bronze", "Silver"]);
  });

  it("the standard four-band ladder is the full metal run", () => {
    const p = rankProgress(FOUR, 1)!;
    expect(p.ladder.map(r => r.name)).toEqual(["Bronze", "Silver", "Gold", "Platinum"]);
  });

  it("ladders deeper than the metals extend as Diamond II, III - no fake metals", () => {
    expect(rankNameForBand(4, 6)).toBe("Diamond");
    expect(rankNameForBand(5, 6)).toBe("Diamond 2");
    expect(rankNameForBand(6, 7)).toBe("Diamond 3");
  });
});

describe("the incentive number is the RETROACTIVE jump, not the marginal rate", () => {
  it("prices the next rank as the whole week's reprice", () => {
    // 5 sales at Bronze $175 = $875 now. Silver entry (7) pays 7 x $225 = $1,575.
    // The gain is $700 — two more sales AND the reprice of the five already made.
    const p = rankProgress(TWO, 5)!;
    expect(p.current!.name).toBe("Bronze");
    expect(p.next!.name).toBe("Silver");
    expect(p.salesToNext).toBe(2);
    expect(p.weekPayNowCents).toBe(5 * 17500);
    expect(p.weekPayAtNextCents).toBe(7 * 22500);
    expect(p.gainAtNextCents).toBe(7 * 22500 - 5 * 17500);
  });

  it("entry pay is precomputed for every rung of the rail", () => {
    const p = rankProgress(FOUR, 1)!;
    expect(p.ladder.map(r => r.weekPayAtEntryCents)).toEqual([
      1 * 15000, 8 * 20000, 13 * 25000, 17 * 30000,
    ]);
  });
});

describe("edges a real week hits", () => {
  it("before the first sale: no current rank, Bronze is next, one sale away", () => {
    const p = rankProgress(TWO, 0)!;
    expect(p.current).toBeNull();
    expect(p.next!.name).toBe("Bronze");
    expect(p.salesToNext).toBe(1);
    expect(p.weekPayNowCents).toBe(0);
  });

  it("top of the ladder: atTop, nothing dangling", () => {
    const p = rankProgress(TWO, 9)!;
    expect(p.current!.name).toBe("Silver");
    expect(p.atTop).toBe(true);
    expect(p.next).toBeNull();
    expect(p.salesToNext).toBeNull();
    expect(p.gainAtNextCents).toBeNull();
  });

  it("the boundary sale itself lands IN the new rank", () => {
    const p = rankProgress(TWO, 7)!;
    expect(p.current!.name).toBe("Silver");
  });

  it("progress resets at each rank floor instead of inheriting the last bar", () => {
    // 8 sales on the four-band ladder: one into Silver's 8-12 span.
    const p = rankProgress(FOUR, 8)!;
    expect(p.current!.name).toBe("Silver");
    expect(p.progressToNext!).toBeGreaterThan(0);
    expect(p.progressToNext!).toBeLessThan(0.5);
  });

  it("never shows a full bar while sales remain - the one lie a bar can tell", () => {
    // The confirmed review finding: at count = entry - 1 the old span rendered
    // 100% beside the text "1 sale to go". Reproduced on both ladder shapes.
    expect(rankProgress(FOUR, 12)!.progressToNext!).toBeLessThan(1);   // Silver 8-12, Gold at 13
    expect(rankProgress(TWO, 6)!.progressToNext!).toBeLessThan(1);     // Bronze 1-6, Silver at 7
    // …and a one-wide band still cannot divide by zero or overflow.
    const ONE_WIDE = [t(1, 1, 10000, 0), t(2, null, 20000, 1)];
    const p = rankProgress(ONE_WIDE, 1)!;
    expect(p.progressToNext!).toBeGreaterThan(0);
    expect(p.progressToNext!).toBeLessThan(1);
  });

  it("refuses a broken ladder rather than naming thresholds nobody is paid at", () => {
    expect(rankProgress([t(2, null, 15000, 0)], 3)).toBeNull();  // starts at 2
    expect(rankProgress([], 3)).toBeNull();
  });

  it("treats junk counts as zero", () => {
    expect(rankProgress(TWO, -4)!.current).toBeNull();
    expect(rankProgress(TWO, NaN as any)!.current).toBeNull();
  });
});
