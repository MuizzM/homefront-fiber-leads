// The chargeback reserve (holdback) split. The one invariant everything else
// leans on: reserve + net === earned, exactly, at every input.
import { describe, expect, it } from "vitest";
import {
  computeHoldback, rollupReserve, normalizeReserveCap, DEFAULT_RESERVE_CAP_CENTS,
} from "../../shared/commissionReserve";

describe("computeHoldback", () => {
  it("withholds 10% and pays the exact remainder", () => {
    const h = computeHoldback({ earnedCents: 157500, reservePercent: 10 });
    expect(h.reserveCents).toBe(15750);
    expect(h.netPayableCents).toBe(141750);
    expect(h.reserveCents + h.netPayableCents).toBe(157500);
  });

  it("reserve + net re-sum to earned at cent-losing amounts (no invented/lost cent)", () => {
    for (const earned of [8085, 8335, 5051, 1, 99, 100003, 333333]) {
      const h = computeHoldback({ earnedCents: earned, reservePercent: 10 });
      expect(h.reserveCents + h.netPayableCents).toBe(earned);
      expect(h.reserveCents).toBeGreaterThanOrEqual(0);
      expect(h.reserveCents).toBeLessThanOrEqual(earned);
    }
  });

  it("withholds nothing when the rate is 0 (holdback disabled)", () => {
    const h = computeHoldback({ earnedCents: 100000, reservePercent: 0 });
    expect(h.reserveCents).toBe(0);
    expect(h.netPayableCents).toBe(100000);
  });

  it("reserves nothing against a zero or negative earned week", () => {
    expect(computeHoldback({ earnedCents: 0, reservePercent: 10 }).reserveCents).toBe(0);
    const neg = computeHoldback({ earnedCents: -5000, reservePercent: 10 });
    expect(neg.reserveCents).toBe(0);          // never a negative "reserve" (= a payment)
    expect(neg.netPayableCents).toBe(-5000);
  });

  it("clamps a nonsensical rate to 0..100 - never reserves more than the whole", () => {
    expect(computeHoldback({ earnedCents: 1000, reservePercent: 250 }).reserveCents).toBe(1000);
    expect(computeHoldback({ earnedCents: 1000, reservePercent: -5 }).reserveCents).toBe(0);
  });
});

describe("rollupReserve", () => {
  it("accrues the balance as the sum of per-period reserves", () => {
    const l = rollupReserve([157500, 90000, 0, -2000], 10);
    // 15750 + 9000 + 0 + 0 = 24750
    expect(l.reserveBalanceCents).toBe(24750);
    expect(l.earnedToDateCents).toBe(l.reserveBalanceCents + l.netPaidCents);
  });

  it("is all net, zero reserve, when disabled", () => {
    const l = rollupReserve([100000, 50000], 0);
    expect(l.reserveBalanceCents).toBe(0);
    expect(l.netPaidCents).toBe(150000);
  });
});

// ── Cap arithmetic ───────────────────────────────────────────────────────────
// The reserve builds to a maximum and then STOPS. The hold is
//   min(round(earned × pct / 100), max(0, cap − currentBalance))
// and the trimmed cents are PAID to the rep, not lost — so reserve + net still
// equals earned at every input, cap or no cap.
describe("computeHoldback - cap", () => {
  const cap = 250_000;   // $2,500, the product default

  it("holds the full percentage while comfortably below the cap", () => {
    const h = computeHoldback({ earnedCents: 100_000, reservePercent: 10, reserveCapCents: cap, currentBalanceCents: 50_000 });
    expect(h.reserveCents).toBe(10_000);
    expect(h.balanceAfterCents).toBe(60_000);
    expect(h.atCap).toBe(false);
    expect(h.capRemainingCents).toBe(200_000);
  });

  it("holds exactly the remaining room when the week lands ON the cap", () => {
    // balance 240_000, room 10_000, 10% of 100_000 = 10_000 → exact fit.
    const h = computeHoldback({ earnedCents: 100_000, reservePercent: 10, reserveCapCents: cap, currentBalanceCents: 240_000 });
    expect(h.reserveCents).toBe(10_000);
    expect(h.balanceAfterCents).toBe(cap);
    expect(h.atCap).toBe(true);
    expect(h.netPayableCents).toBe(90_000);
  });

  it("TRIMS a hold that would overshoot - the cap is never exceeded", () => {
    // balance 245_000, room 5_000; 10% of 100_000 would be 10_000.
    const h = computeHoldback({ earnedCents: 100_000, reservePercent: 10, reserveCapCents: cap, currentBalanceCents: 245_000 });
    expect(h.reserveCents).toBe(5_000);              // trimmed to the room
    expect(h.balanceAfterCents).toBe(cap);
    expect(h.balanceAfterCents).toBeLessThanOrEqual(cap);
    expect(h.netPayableCents).toBe(95_000);          // the trimmed cents are PAID
    expect(h.reserveCents + h.netPayableCents).toBe(100_000);
    expect(h.atCap).toBe(true);
  });

  it("holds NOTHING once the balance is at the cap", () => {
    const h = computeHoldback({ earnedCents: 100_000, reservePercent: 10, reserveCapCents: cap, currentBalanceCents: cap });
    expect(h.reserveCents).toBe(0);
    expect(h.netPayableCents).toBe(100_000);
    expect(h.capRemainingCents).toBe(0);
    expect(h.atCap).toBe(true);
  });

  it("holds NOTHING when the balance is somehow already OVER the cap", () => {
    const h = computeHoldback({ earnedCents: 100_000, reservePercent: 10, reserveCapCents: cap, currentBalanceCents: cap + 12_345 });
    expect(h.reserveCents).toBe(0);
    expect(h.capRemainingCents).toBe(0);
    expect(h.balanceAfterCents).toBe(cap + 12_345);  // never rewritten downward
    expect(h.atCap).toBe(true);
  });

  it("keeps reserve + net === earned at every cap boundary (no lost/invented cent)", () => {
    for (const earned of [1, 99, 8085, 8335, 5051, 100_003, 333_333]) {
      for (const balance of [0, 100_000, 249_999, cap, cap + 1]) {
        const h = computeHoldback({ earnedCents: earned, reservePercent: 10, reserveCapCents: cap, currentBalanceCents: balance });
        expect(h.reserveCents + h.netPayableCents).toBe(earned);
        expect(h.reserveCents).toBeGreaterThanOrEqual(0);
        expect(h.balanceAfterCents).toBeLessThanOrEqual(Math.max(cap, balance));
      }
    }
  });

  it("holds nothing on a zero or negative week even with room under the cap", () => {
    expect(computeHoldback({ earnedCents: 0, reservePercent: 10, reserveCapCents: cap, currentBalanceCents: 0 }).reserveCents).toBe(0);
    const neg = computeHoldback({ earnedCents: -5_000, reservePercent: 10, reserveCapCents: cap, currentBalanceCents: 0 });
    expect(neg.reserveCents).toBe(0);
    expect(neg.netPayableCents).toBe(-5_000);
    expect(neg.balanceAfterCents).toBe(0);           // a negative week never DRAWS the reserve
  });

  it("still clamps the percent to 0..100 with a cap in play", () => {
    expect(computeHoldback({ earnedCents: 1_000, reservePercent: 250, reserveCapCents: cap, currentBalanceCents: 0 }).reserveCents).toBe(1_000);
    expect(computeHoldback({ earnedCents: 1_000, reservePercent: -5, reserveCapCents: cap, currentBalanceCents: 0 }).reserveCents).toBe(0);
  });

  it("treats a missing / zero / negative cap as UNCAPPED - the pre-cap behaviour", () => {
    const noCap = computeHoldback({ earnedCents: 100_000, reservePercent: 10, currentBalanceCents: 10_000_000 });
    expect(noCap.reserveCents).toBe(10_000);
    expect(noCap.reserveCapCents).toBeNull();
    expect(noCap.capRemainingCents).toBeNull();
    expect(noCap.atCap).toBe(false);
    expect(computeHoldback({ earnedCents: 100_000, reservePercent: 10, reserveCapCents: 0, currentBalanceCents: 10_000_000 }).reserveCents).toBe(10_000);
    expect(computeHoldback({ earnedCents: 100_000, reservePercent: 10, reserveCapCents: -1, currentBalanceCents: 10_000_000 }).reserveCents).toBe(10_000);
  });

  it("a negative balance can never manufacture headroom above the cap", () => {
    const h = computeHoldback({ earnedCents: 1_000_000, reservePercent: 100, reserveCapCents: cap, currentBalanceCents: -999_999 });
    expect(h.balanceBeforeCents).toBe(0);
    expect(h.reserveCents).toBe(cap);
    expect(h.balanceAfterCents).toBe(cap);
  });

  it("the ORIGINAL two-argument call is byte-for-byte unchanged", () => {
    for (const earned of [0, -1, 1, 157_500, 8_085, 999_999_999]) {
      for (const pct of [0, 10, 37, 100]) {
        const legacy = computeHoldback({ earnedCents: earned, reservePercent: pct });
        expect(legacy.reserveCents).toBe(earned <= 0 || pct === 0 ? 0 : Math.round((earned * pct) / 100));
        expect(legacy.netPayableCents).toBe(earned - legacy.reserveCents);
        expect(legacy.reserveCapCents).toBeNull();
      }
    }
  });
});

describe("normalizeReserveCap", () => {
  it("maps null/0/negative to uncapped and keeps a positive cap", () => {
    expect(normalizeReserveCap(null)).toBeNull();
    expect(normalizeReserveCap(undefined)).toBeNull();
    expect(normalizeReserveCap(0)).toBeNull();
    expect(normalizeReserveCap(-100)).toBeNull();
    expect(normalizeReserveCap(250_000)).toBe(250_000);
    expect(normalizeReserveCap(250_000.9)).toBe(250_000);   // truncated, never rounded up
  });

  it("the product default is $2,500", () => {
    expect(DEFAULT_RESERVE_CAP_CENTS).toBe(250_000);
  });
});
