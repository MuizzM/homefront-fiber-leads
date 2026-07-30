// The chargeback reserve (holdback) split. The one invariant everything else
// leans on: reserve + net === earned, exactly, at every input.
import { describe, expect, it } from "vitest";
import { computeHoldback, rollupReserve } from "../../shared/commissionReserve";

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

  it("clamps a nonsensical rate to 0..100 — never reserves more than the whole", () => {
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
