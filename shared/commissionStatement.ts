// ── Commission statement document (PURE) ─────────────────────────────────────
// The one place that decides WHAT a commission statement says. Both renderers —
// the PDF a rep downloads and the on-screen statement — build from this same
// document, so a rep who prints the page and a rep who saves the PDF can never
// be looking at two different numbers.
//
// Everything here is integer cents and free of I/O, clocks and randomness: the
// caller reads the statement row, the week's sales and the reserve ledger, and
// hands them in. That keeps the money arithmetic testable in isolation and
// keeps the renderers dumb (they format, they never compute).
//
// The invariant that matters most: the per-sale commission column is an
// ALLOCATION of the statement's gross, not a re-derivation of it. Tiered plans
// pay retroactively — hit tier 3 and every sale in the week re-prices — so
// "gross ÷ sales" is the only honest per-door number, and it must re-sum to
// gross to the cent. See allocateCents.

export type SaleStatus = "QUALIFIED" | "PENDING" | "REVERSED" | "DISQUALIFIED" | "CANCELLED";

export interface StatementSaleInput {
  saleId: number;
  externalId: string;
  status: string;
  /** The instant that put this sale in the week, per the org's qualification basis. */
  countedAtIso: string;
  address: string | null;
  city: string | null;
  /**
   * What the COMPANY books for this sale — the house amount. Null when the org
   * has never configured one (the column is then hidden rather than shown as
   * $0.00, which would read as "this door was worth nothing").
   */
  houseAmountCents: number | null;
}

export interface StatementMoneyInput {
  /** Commission earned on the week's qualified sales, before adjustments. */
  grossCommissionCents: number;
  /** Approved adjustments (signed: a clawback is negative). */
  adjustmentCents: number;
  /** Spiffs awarded in the week. */
  spiffCents: number;
  /** Hourly pay for the week (0 for a commission-only rep). */
  hourlyPayCents: number;
  hourlyMinutes: number;
  hourlyRateCents: number | null;
  /** The statement's authoritative final = gross + adjustments. */
  finalCommissionCents: number;
}

export interface StatementHoldbackInput {
  reservePercent: number;
  reserveCents: number;
  netPayableCents: number;
  earnedCents: number;
}

export interface StatementDocInput {
  company: { name: string; supportEmail?: string | null };
  rep: { id: number; name: string };
  period: { label: string; startUtc: string; nextStartUtc: string; timezone: string };
  statement: {
    id: number | null;
    status: string;
    calculationVersion: number;
    tierLabel: string | null;
    rateCents: number;
    structure: "FLAT" | "TIERED" | null;
  };
  sales: StatementSaleInput[];
  money: StatementMoneyInput;
  /** The period split, already computed by the caller (it owns the cap rules). */
  holdback: StatementHoldbackInput;
  /** Reserve accrued and still held across ALL settled periods, not just this one. */
  reserve: { balanceCents: number; capCents: number | null };
  adjustments: Array<{ id: number; amountCents: number; reason: string; approvedAtIso: string | null }>;
  /** ISO instant the document was produced. Supplied — this module has no clock. */
  issuedAtIso: string;
}

export interface StatementLine {
  saleId: number;
  externalId: string;
  status: string;
  countedAtIso: string;
  address: string;
  city: string | null;
  /** Whether this door contributed to the commission on this statement. */
  counted: boolean;
  houseAmountCents: number | null;
  /** This door's share of the week's gross commission. Sums to gross exactly. */
  repCommissionCents: number;
}

export interface StatementTotals {
  countedSaleCount: number;
  otherSaleCount: number;
  /** Summed house amount over counted doors; null when the org books none. */
  houseAmountCents: number | null;
  /** False when at least one counted door has no house amount recorded. */
  houseAmountComplete: boolean;
  /** House amount − rep commission, only when every counted door has an amount. */
  houseMarginCents: number | null;
  grossCommissionCents: number;
  adjustmentCents: number;
  spiffCents: number;
  hourlyPayCents: number;
  /** Everything the rep earned this period, before the reserve is withheld. */
  earnedCents: number;
}

export interface StatementPayout {
  earnedCents: number;
  reservePercent: number;
  reserveCents: number;
  /** What actually gets paid this period = earned − reserve. */
  netPayCents: number;
  /** Reserve held across all settled periods, after this one. */
  reserveBalanceCents: number;
  reserveCapCents: number | null;
  /** True once the balance has reached the cap — nothing further is withheld. */
  reserveAtCap: boolean;
}

export interface StatementDocument {
  company: { name: string; supportEmail: string | null };
  rep: { id: number; name: string };
  period: StatementDocInput["period"];
  statement: StatementDocInput["statement"] & { issuedAtIso: string };
  planLabel: string;
  lines: StatementLine[];
  totals: StatementTotals;
  payout: StatementPayout;
  adjustments: StatementDocInput["adjustments"];
  /** Present only when the org books house amounts — drives column visibility. */
  showHouseColumn: boolean;
}

/** A sale in one of these states put money on this statement. */
const COUNTED_STATUSES = new Set(["QUALIFIED"]);

const cents = (n: unknown): number => Math.trunc(Number(n) || 0);

/**
 * Split `totalCents` across `count` slots so the parts re-sum to the total
 * EXACTLY, with no lost or invented cent.
 *
 * Each slot gets the floor of the even share; the remainder (always < count) is
 * spread one cent at a time over the leading slots. Deterministic, so the same
 * statement renders identically every time — a rep comparing last week's PDF to
 * this week's screen must not see a door drift by a penny.
 *
 * Negative totals (a week that went net-negative) floor toward negative
 * infinity, which keeps the same "parts sum to whole" property.
 */
export function allocateCents(totalCents: number, count: number): number[] {
  const total = cents(totalCents);
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  const out = new Array<number>(count).fill(base);
  let remainder = total - base * count; // 0 ≤ remainder < count
  for (let i = 0; i < count && remainder > 0; i += 1) { out[i] += 1; remainder -= 1; }
  return out;
}

/** A human label for the comp plan that produced this statement. */
export function planLabelFor(input: Pick<StatementDocInput["statement"], "structure" | "tierLabel" | "rateCents">): string {
  const rate = `$${(cents(input.rateCents) / 100).toFixed(2)} per sale`;
  if (input.structure === "TIERED") return input.tierLabel ? `${input.tierLabel} — ${rate}` : `Tiered — ${rate}`;
  if (input.structure === "FLAT") return `Flat — ${rate}`;
  return input.tierLabel ?? "—";
}

/**
 * Build the statement document.
 *
 * `earned` mirrors the payroll CSV's per-row total exactly
 * (hourly + gross + adjustments + spiffs), so the statement a rep reads and the
 * file the payroll provider ingests can never disagree — the same money, named
 * the same way, in both places. The reserve is then withheld from that earned
 * amount and the remainder is the net pay.
 */
export function buildStatementDocument(input: StatementDocInput): StatementDocument {
  const counted = input.sales.filter(s => COUNTED_STATUSES.has(String(s.status).toUpperCase()));
  const others = input.sales.filter(s => !COUNTED_STATUSES.has(String(s.status).toUpperCase()));

  // Sort counted doors oldest-first so the allocation's leading-cent remainder
  // lands on a stable door, and so the page reads as the week actually happened.
  const countedSorted = [...counted].sort((a, b) =>
    a.countedAtIso === b.countedAtIso ? a.saleId - b.saleId : (a.countedAtIso < b.countedAtIso ? -1 : 1));

  const gross = cents(input.money.grossCommissionCents);
  const shares = allocateCents(gross, countedSorted.length);

  const toLine = (s: StatementSaleInput, isCounted: boolean, share: number): StatementLine => ({
    saleId: s.saleId,
    externalId: s.externalId,
    status: String(s.status).toUpperCase(),
    countedAtIso: s.countedAtIso,
    address: s.address?.trim() || "(address not recorded)",
    city: s.city?.trim() || null,
    counted: isCounted,
    houseAmountCents: s.houseAmountCents == null ? null : cents(s.houseAmountCents),
    repCommissionCents: share,
  });

  const lines: StatementLine[] = [
    ...countedSorted.map((s, i) => toLine(s, true, shares[i] ?? 0)),
    // Doors that did NOT pay are still listed — a rep who knows they sold five
    // and sees four is owed the reason, not a shorter table.
    ...others
      .sort((a, b) => (a.countedAtIso < b.countedAtIso ? -1 : 1))
      .map(s => toLine(s, false, 0)),
  ];

  const houseKnown = countedSorted.filter(s => s.houseAmountCents != null);
  const houseAmountComplete = countedSorted.length > 0 && houseKnown.length === countedSorted.length;
  const houseAmountCents = houseKnown.length > 0
    ? houseKnown.reduce((sum, s) => sum + cents(s.houseAmountCents), 0)
    : null;

  const adjustmentCents = cents(input.money.adjustmentCents);
  const spiffCents = cents(input.money.spiffCents);
  const hourlyPayCents = cents(input.money.hourlyPayCents);
  const earnedCents = hourlyPayCents + gross + adjustmentCents + spiffCents;

  const totals: StatementTotals = {
    countedSaleCount: countedSorted.length,
    otherSaleCount: others.length,
    houseAmountCents,
    houseAmountComplete,
    // Margin is only honest when EVERY counted door has an amount — a partial
    // sum minus the full commission would understate what the house kept.
    houseMarginCents: houseAmountComplete && houseAmountCents != null ? houseAmountCents - gross : null,
    grossCommissionCents: gross,
    adjustmentCents,
    spiffCents,
    hourlyPayCents,
    earnedCents,
  };

  const reserveCents = cents(input.holdback.reserveCents);
  const balance = cents(input.reserve.balanceCents);
  const cap = input.reserve.capCents == null ? null : cents(input.reserve.capCents);

  const payout: StatementPayout = {
    earnedCents,
    reservePercent: Math.min(100, Math.max(0, Math.trunc(input.holdback.reservePercent || 0))),
    reserveCents,
    netPayCents: earnedCents - reserveCents,
    reserveBalanceCents: balance,
    reserveCapCents: cap,
    reserveAtCap: cap != null && balance >= cap,
  };

  return {
    company: { name: input.company.name, supportEmail: input.company.supportEmail ?? null },
    rep: input.rep,
    period: input.period,
    statement: { ...input.statement, issuedAtIso: input.issuedAtIso },
    planLabel: planLabelFor(input.statement),
    lines,
    totals,
    payout,
    adjustments: input.adjustments,
    showHouseColumn: houseKnown.length > 0,
  };
}

/** `$1,234.56` / `-$12.00` — one money formatter for every surface. */
export function formatCents(value: number): string {
  const n = cents(value);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}
