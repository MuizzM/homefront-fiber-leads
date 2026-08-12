// ── Commission money, pinned ──────────────────────────────────────────────────
// This module is the money half of the PerfectVision integration: the order
// plane (shared/orderStatusSource.ts) tracks whether an install happened, and
// this tracks whether the dealership got paid and kept it.
//
// Three things here decide whether a number on a rep's screen is true:
//
//   normalizeCommissionStatus - a phrase that reads as "paid" when it means
//     "charged back" credits money the carrier already took away. The
//     negative-before-positive rule ordering is the guard, and it is easy to
//     break by adding a rule in the wrong place.
//   parseMoneyToCents - "(300.00)" is MINUS three hundred in accounting
//     notation. Reading it as +300 is a 600-dollar error per row, in the
//     direction that overpays.
//   rollUpCommissions - one definition of each bucket, so the rep card and the
//     finance board cannot disagree about what "paid" means.
import { describe, expect, it } from "vitest";
import {
  COMMISSION_STATUSES, COMMISSION_STATUS_LABELS, formatCents, isCommissionStatus,
  isNegativeCommissionStatus, normalizeCommissionStatus, parseMoneyToCents,
  rollUpCommissions, signedCommissionCents, type CommissionStatus,
} from "@shared/commissionMoney";
import { ORDER_STATUSES } from "@shared/orderStatusSource";

describe("the two vocabularies stay separate", () => {
  it("does not duplicate any order status - these planes answer different questions", () => {
    // An order reaching `installed` is a fact that never un-happens; the
    // commission on it can still be charged back in October. Folding the two
    // together would make an installed order flip to `chargeback`, which is
    // false. Only the genuinely shared words may overlap.
    const overlap = COMMISSION_STATUSES.filter((s) => (ORDER_STATUSES as readonly string[]).includes(s));
    expect(overlap).toEqual(["unknown"]);
  });

  it("carries the two outcomes an order-status vocabulary cannot express", () => {
    expect(COMMISSION_STATUSES).toContain("chargeback");
    expect(COMMISSION_STATUSES).toContain("reversed");
    expect(ORDER_STATUSES as readonly string[]).not.toContain("chargeback");
    expect(ORDER_STATUSES as readonly string[]).not.toContain("reversed");
  });

  it("labels every status, so no screen renders a raw key", () => {
    for (const status of COMMISSION_STATUSES) expect(COMMISSION_STATUS_LABELS[status]).toBeTruthy();
  });
});

describe("normalizeCommissionStatus", () => {
  it("round-trips its own vocabulary, so re-importing an export is lossless", () => {
    for (const status of COMMISSION_STATUSES) expect(normalizeCommissionStatus(status)).toBe(status);
    expect(normalizeCommissionStatus("Pending Commission")).toBe("pending_commission");
    expect(normalizeCommissionStatus("pending-commission")).toBe("pending_commission");
  });

  it("reads the common vendor phrasings", () => {
    expect(normalizeCommissionStatus("Paid")).toBe("paid");
    expect(normalizeCommissionStatus("PAYMENT ISSUED")).toBe("paid");
    expect(normalizeCommissionStatus("Approved for payment")).toBe("approved");
    expect(normalizeCommissionStatus("Pending review")).toBe("pending_commission");
    expect(normalizeCommissionStatus("On Hold")).toBe("pending_commission");
    expect(normalizeCommissionStatus("Denied")).toBe("denied");
  });

  it("NEVER reads a negative outcome as a positive one", () => {
    // Every one of these contains a positive word. Each is a real phrasing.
    expect(normalizeCommissionStatus("Chargeback - commission paid back")).toBe("chargeback");
    expect(normalizeCommissionStatus("Reversal of approved commission")).toBe("reversed");
    expect(normalizeCommissionStatus("CB (previously paid)")).toBe("chargeback");
    expect(normalizeCommissionStatus("Clawback of paid commission")).toBe("chargeback");
    expect(normalizeCommissionStatus("Void - was approved")).toBe("reversed");
    expect(normalizeCommissionStatus("Debit memo against paid commission")).toBe("reversed");
  });

  it("returns unknown rather than guessing", () => {
    expect(normalizeCommissionStatus("Zorblatt tier 3")).toBe("unknown");
    expect(normalizeCommissionStatus("")).toBe("unknown");
    expect(normalizeCommissionStatus("   ")).toBe("unknown");
    expect(normalizeCommissionStatus(null)).toBe("unknown");
    expect(normalizeCommissionStatus(undefined)).toBe("unknown");
    expect(normalizeCommissionStatus(42)).toBe("unknown");
  });

  it("treats the placeholders a vendor exports for nothing as unknown", () => {
    // cleanText is shared with the order plane, so "N/A" collapses identically.
    expect(normalizeCommissionStatus("N/A")).toBe("unknown");
    expect(normalizeCommissionStatus("-")).toBe("unknown");
  });

  it("classifies which statuses took money back", () => {
    expect(isNegativeCommissionStatus("chargeback")).toBe(true);
    expect(isNegativeCommissionStatus("reversed")).toBe(true);
    expect(isNegativeCommissionStatus("denied")).toBe(false); // never paid, nothing taken
    expect(isNegativeCommissionStatus("paid")).toBe(false);
  });

  it("isCommissionStatus rejects anything outside the vocabulary", () => {
    expect(isCommissionStatus("paid")).toBe(true);
    expect(isCommissionStatus("Paid")).toBe(false);
    expect(isCommissionStatus("installed")).toBe(false); // an ORDER status
  });
});

describe("parseMoneyToCents", () => {
  it("reads the shapes a dealer report actually contains", () => {
    expect(parseMoneyToCents("$1,234.56")).toBe(123456);
    expect(parseMoneyToCents("300")).toBe(30000);
    expect(parseMoneyToCents("-300.00")).toBe(-30000);
    expect(parseMoneyToCents(" $ 75.50 ")).toBe(7550);
    expect(parseMoneyToCents(300.5)).toBe(30050);
    expect(parseMoneyToCents("0")).toBe(0);
  });

  it("reads accounting negatives - (300.00) is MINUS three hundred dollars", () => {
    expect(parseMoneyToCents("(300.00)")).toBe(-30000);
    expect(parseMoneyToCents("($1,234.56)")).toBe(-123456);
  });

  it("reads a European decimal comma without mangling US thousands groups", () => {
    expect(parseMoneyToCents("1.234,56")).toBe(123456);
    expect(parseMoneyToCents("1,234.56")).toBe(123456);
    expect(parseMoneyToCents("1,234")).toBe(123400);
    expect(parseMoneyToCents("1,50")).toBe(150);
  });

  it("returns null - never 0 - when there is no number to read", () => {
    for (const v of ["", "   ", null, undefined, "N/A", "pending", NaN]) {
      expect(parseMoneyToCents(v)).toBeNull();
    }
  });
});

describe("signedCommissionCents", () => {
  it("gives a negative status a negative amount whatever sign the vendor used", () => {
    // Vendors are inconsistent; both spellings must total the same.
    expect(signedCommissionCents({ commissionStatus: "chargeback", grossCommissionCents: 30000 })).toBe(-30000);
    expect(signedCommissionCents({ commissionStatus: "chargeback", grossCommissionCents: -30000 })).toBe(-30000);
    expect(signedCommissionCents({ commissionStatus: "reversed", grossCommissionCents: 12345 })).toBe(-12345);
  });

  it("keeps a positive status positive even if the vendor exported a negative", () => {
    expect(signedCommissionCents({ commissionStatus: "paid", grossCommissionCents: -30000 })).toBe(30000);
  });

  it("treats an absent amount as zero rather than NaN", () => {
    for (const v of [null, undefined, NaN]) {
      expect(signedCommissionCents({ commissionStatus: "paid", grossCommissionCents: v as number })).toBe(0);
    }
  });
});

describe("rollUpCommissions", () => {
  const rows: Array<{ commissionStatus: CommissionStatus; grossCommissionCents: number }> = [
    { commissionStatus: "paid", grossCommissionCents: 30000 },
    { commissionStatus: "paid", grossCommissionCents: 15000 },
    { commissionStatus: "approved", grossCommissionCents: 20000 },
    { commissionStatus: "pending_commission", grossCommissionCents: 10000 },
    { commissionStatus: "chargeback", grossCommissionCents: 30000 },
    { commissionStatus: "denied", grossCommissionCents: 99900 },
    { commissionStatus: "unknown", grossCommissionCents: 88800 },
  ];

  it("splits the five numbers a dashboard shows", () => {
    const t = rollUpCommissions(rows);
    expect(t.paidCents).toBe(45000);
    expect(t.openCents).toBe(30000);      // approved + pending
    expect(t.negativeCents).toBe(-30000);
    expect(t.netCents).toBe(15000);       // 45000 paid - 30000 clawed back
  });

  it("counts denied and unknown but puts their money in NO total", () => {
    // A denied row is not money owed; an unknown row is not money at all until a
    // human says what it is. Either one in a total is a number nobody can defend.
    const t = rollUpCommissions(rows);
    expect(t.counts.denied).toBe(1);
    expect(t.counts.unknown).toBe(1);
    expect(t.paidCents + t.openCents + Math.abs(t.negativeCents)).toBe(45000 + 30000 + 30000);
  });

  it("a chargeback cancels its own payment exactly", () => {
    const t = rollUpCommissions([
      { commissionStatus: "paid", grossCommissionCents: 30000 },
      { commissionStatus: "chargeback", grossCommissionCents: 30000 },
    ]);
    expect(t.netCents).toBe(0);
  });

  it("handles an empty set without NaN", () => {
    const t = rollUpCommissions([]);
    expect(t).toMatchObject({ openCents: 0, paidCents: 0, negativeCents: 0, netCents: 0 });
    for (const status of COMMISSION_STATUSES) expect(t.counts[status]).toBe(0);
  });

  it("tolerates rows with no amount", () => {
    const t = rollUpCommissions([{ commissionStatus: "paid", grossCommissionCents: null }]);
    expect(t.paidCents).toBe(0);
    expect(t.counts.paid).toBe(1);
  });
});

describe("formatCents", () => {
  it("renders a negative with a minus, not accounting parentheses", () => {
    // House style: a rep reading "(300.00)" on a phone does not read it as
    // negative, and the repo bans dash-family glyphs but not the ASCII hyphen.
    expect(formatCents(-30000)).toBe("-$300.00");
    expect(formatCents(30000)).toBe("$300.00");
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(0)).toBe("$0.00");
  });

  it("renders an absent amount as a dash rather than $0.00", () => {
    expect(formatCents(null)).toBe("-");
    expect(formatCents(undefined)).toBe("-");
    expect(formatCents(NaN)).toBe("-");
  });

  it("uses no dash-family glyphs", () => {
    for (const v of [-30000, 30000, null]) {
      expect(formatCents(v)).not.toMatch(/[‒-―−]/);
    }
  });
});
