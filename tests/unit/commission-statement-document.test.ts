// The statement document is the ONE place that decides what a pay document
// says, and both the PDF and the on-screen statement render from it. These
// tests pin the two properties a rep's trust actually rests on:
//
//   1. the per-door commission column re-sums to the week's gross, to the cent;
//   2. "earned" on the statement equals the payroll CSV's per-row total, so the
//      number a rep reads and the number the payroll provider ingests are the
//      same money.
import { describe, expect, it } from "vitest";
import {
  allocateCents, buildStatementDocument, formatCents, planLabelFor,
  type StatementDocInput, type StatementSaleInput,
} from "@shared/commissionStatement";

const door = (i: number, over: Partial<StatementSaleInput> = {}): StatementSaleInput => ({
  saleId: 100 + i,
  externalId: `HF-${100 + i}`,
  status: "QUALIFIED",
  countedAtIso: `2026-07-2${(i % 5) + 1}T14:00:00.000Z`,
  address: `${100 + i} Maple Ave`,
  city: "Charlotte",
  houseAmountCents: 49900,
  ...over,
});

const base = (over: Partial<StatementDocInput> = {}): StatementDocInput => ({
  company: { name: "Home Front Solutions LLC", supportEmail: "pay@example.test" },
  rep: { id: 7, name: "Jose Q. Rodriguez" },
  period: { label: "Jul 27 – Aug 2, 2026", startUtc: "2026-07-27T04:00:00.000Z", nextStartUtc: "2026-08-03T04:00:00.000Z", timezone: "America/New_York" },
  statement: { id: 42, status: "FINALIZED", calculationVersion: 2, tierLabel: "Tier 2", rateCents: 12000, structure: "TIERED" },
  sales: [door(1), door(2), door(3)],
  money: {
    grossCommissionCents: 36000, adjustmentCents: 0, spiffCents: 0,
    hourlyPayCents: 0, hourlyMinutes: 0, hourlyRateCents: null, finalCommissionCents: 36000,
  },
  holdback: { reservePercent: 10, reserveCents: 3600, netPayableCents: 32400, earnedCents: 36000 },
  reserve: { balanceCents: 120000, capCents: 250000 },
  adjustments: [],
  issuedAtIso: "2026-08-03T12:00:00.000Z",
  ...over,
});

describe("allocateCents — parts always re-sum to the whole", () => {
  it("splits evenly when it divides", () => {
    expect(allocateCents(30000, 3)).toEqual([10000, 10000, 10000]);
  });

  it("spreads an indivisible remainder one cent at a time, never rounding money away", () => {
    const parts = allocateCents(10000, 3);
    expect(parts).toEqual([3334, 3333, 3333]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it("re-sums exactly for every count from 1..60 at an awkward total", () => {
    for (let n = 1; n <= 60; n += 1) {
      const parts = allocateCents(105_007, n);
      expect(parts).toHaveLength(n);
      expect(parts.reduce((a, b) => a + b, 0), `count ${n}`).toBe(105_007);
    }
  });

  it("keeps the property for a negative total (a week that went net-negative)", () => {
    const parts = allocateCents(-1000, 3);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(-1000);
  });

  it("returns nothing for a zero or negative count", () => {
    expect(allocateCents(5000, 0)).toEqual([]);
    expect(allocateCents(5000, -2)).toEqual([]);
  });
});

describe("buildStatementDocument", () => {
  it("allocates gross across the counted doors and re-sums to gross", () => {
    // 5 doors, $1,000.07 gross — deliberately indivisible.
    const doc = buildStatementDocument(base({
      sales: [1, 2, 3, 4, 5].map(i => door(i)),
      money: { ...base().money, grossCommissionCents: 100_007, finalCommissionCents: 100_007 },
    }));
    const counted = doc.lines.filter(l => l.counted);
    expect(counted).toHaveLength(5);
    expect(counted.reduce((s, l) => s + l.repCommissionCents, 0)).toBe(100_007);
    expect(doc.totals.grossCommissionCents).toBe(100_007);
  });

  it("earned matches the payroll CSV formula: hourly + gross + adjustments + spiffs", () => {
    // Same arithmetic as GET /api/commission/week-export.csv's rowMoney(), so a
    // rep's statement can never disagree with the payroll file.
    const doc = buildStatementDocument(base({
      money: {
        grossCommissionCents: 105_000, adjustmentCents: -7_500, spiffCents: 4_000,
        hourlyPayCents: 18_000, hourlyMinutes: 960, hourlyRateCents: 1_125, finalCommissionCents: 97_500,
      },
      holdback: { reservePercent: 10, reserveCents: 9_750, netPayableCents: 87_750, earnedCents: 97_500 },
    }));
    expect(doc.totals.earnedCents).toBe(18_000 + 105_000 - 7_500 + 4_000);
    // …and net pay is that earned amount less the reserve, which is exactly what
    // the CSV's Total column computes.
    expect(doc.payout.netPayCents).toBe(119_500 - 9_750);
  });

  it("separates doors that did not pay, and still lists them", () => {
    const doc = buildStatementDocument(base({
      sales: [door(1), door(2, { status: "REVERSED" }), door(3, { status: "PENDING" })],
      money: { ...base().money, grossCommissionCents: 12_000, finalCommissionCents: 12_000 },
    }));
    expect(doc.totals.countedSaleCount).toBe(1);
    expect(doc.totals.otherSaleCount).toBe(2);
    // A rep who knows they knocked three doors is owed three rows.
    expect(doc.lines).toHaveLength(3);
    expect(doc.lines.filter(l => !l.counted).every(l => l.repCommissionCents === 0)).toBe(true);
    // The whole gross lands on the one door that counted.
    expect(doc.lines.find(l => l.counted)!.repCommissionCents).toBe(12_000);
  });

  it("sums the house amount over COUNTED doors only, and reports the margin", () => {
    const doc = buildStatementDocument(base({
      sales: [door(1), door(2), door(3, { status: "REVERSED" })],
      money: { ...base().money, grossCommissionCents: 24_000, finalCommissionCents: 24_000 },
    }));
    expect(doc.totals.houseAmountCents).toBe(2 * 49_900);
    expect(doc.totals.houseAmountComplete).toBe(true);
    expect(doc.totals.houseMarginCents).toBe(2 * 49_900 - 24_000);
  });

  it("refuses to report a margin when a counted door has no house amount", () => {
    // A partial house sum minus the FULL commission would understate what the
    // company kept — better to show no margin than a wrong one.
    const doc = buildStatementDocument(base({
      sales: [door(1), door(2, { houseAmountCents: null })],
      money: { ...base().money, grossCommissionCents: 24_000, finalCommissionCents: 24_000 },
    }));
    expect(doc.totals.houseAmountCents).toBe(49_900);
    expect(doc.totals.houseAmountComplete).toBe(false);
    expect(doc.totals.houseMarginCents).toBeNull();
    expect(doc.showHouseColumn).toBe(true);
  });

  it("hides the house column entirely when the org books no house amount", () => {
    // Never $0.00 beside every door — that reads as "this sale was worth
    // nothing" rather than "not configured".
    const doc = buildStatementDocument(base({
      sales: [door(1, { houseAmountCents: null }), door(2, { houseAmountCents: null })],
    }));
    expect(doc.showHouseColumn).toBe(false);
    expect(doc.totals.houseAmountCents).toBeNull();
    expect(doc.totals.houseMarginCents).toBeNull();
  });

  it("orders counted doors oldest-first so the page reads as the week happened", () => {
    const doc = buildStatementDocument(base({
      sales: [
        door(1, { countedAtIso: "2026-07-31T10:00:00.000Z" }),
        door(2, { countedAtIso: "2026-07-27T10:00:00.000Z" }),
        door(3, { countedAtIso: "2026-07-29T10:00:00.000Z" }),
      ],
    }));
    const dates = doc.lines.filter(l => l.counted).map(l => l.countedAtIso);
    expect(dates).toEqual([...dates].sort());
  });

  it("reports the reserve cap state so a rep can see the end of the holdback", () => {
    expect(buildStatementDocument(base({ reserve: { balanceCents: 250_000, capCents: 250_000 } })).payout.reserveAtCap).toBe(true);
    expect(buildStatementDocument(base({ reserve: { balanceCents: 249_999, capCents: 250_000 } })).payout.reserveAtCap).toBe(false);
    // No cap configured yet (the reserve ledger reports none) — not "at cap".
    expect(buildStatementDocument(base({ reserve: { balanceCents: 900_000, capCents: null } })).payout.reserveAtCap).toBe(false);
  });

  it("survives a week with no sales at all", () => {
    const doc = buildStatementDocument(base({
      sales: [],
      money: { ...base().money, grossCommissionCents: 0, finalCommissionCents: 0 },
      holdback: { reservePercent: 10, reserveCents: 0, netPayableCents: 0, earnedCents: 0 },
    }));
    expect(doc.lines).toHaveLength(0);
    expect(doc.totals.earnedCents).toBe(0);
    expect(doc.payout.netPayCents).toBe(0);
  });

  it("carries the tenant's own company name — never a hardcoded one", () => {
    const doc = buildStatementDocument(base({ company: { name: "Rockwell Fiber Partners", supportEmail: null } }));
    expect(doc.company.name).toBe("Rockwell Fiber Partners");
  });
});

describe("formatCents / planLabelFor", () => {
  it("formats money with a thousands separator and a signed negative", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(-1200)).toBe("-$12.00");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
  });

  it("names the plan the way the rep's agreement does", () => {
    expect(planLabelFor({ structure: "TIERED", tierLabel: "Tier 3 (7+)", rateCents: 15000 })).toBe("Tier 3 (7+) — $150.00 per sale");
    expect(planLabelFor({ structure: "FLAT", tierLabel: null, rateCents: 5000 })).toBe("Flat — $50.00 per sale");
    expect(planLabelFor({ structure: null, tierLabel: null, rateCents: 0 })).toBe("—");
  });
});
