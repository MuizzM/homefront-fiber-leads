// ── Commission money: the vocabulary an order-status plane does not have ─────
// PURE and framework-free. Composes with shared/orderStatusSource.ts rather
// than duplicating it - that module owns the ORDER lifecycle (submitted,
// install_scheduled, installed, canceled), and this one owns what happens to
// the MONEY afterwards.
//
// WHY THIS IS A SEPARATE VOCABULARY AND NOT MORE ORDER STATUSES.
//
// An order and its commission are on different clocks and can disagree for
// months. An order reaches `installed` in July and stays there forever; the
// commission on it goes pending -> approved -> paid in August and can then be
// charged back in October without the order changing at all. Worse, the two
// most important money outcomes - chargeback and reversal - have NO order-status
// equivalent: the install still happened, the customer is still connected, and
// the dealership simply had the money taken back.
//
// Folding those into ORDER_STATUSES would mean an order flipping from
// `installed` to `chargeback`, which is false: the install is a fact and it did
// not un-happen. So the planes stay separate and are joined per order, which is
// also what makes "installed but never paid" a question the product can answer.
//
// This is the money HALF of the PerfectVision DealerAccounting Commission File.
// The order half comes from the POE Submitted Orders report.

import { cleanText } from "./orderStatusSource";

/** The commission lifecycle, roughly ordered. `unknown` is an expected outcome,
 *  never an error - see normalizeCommissionStatus. */
export const COMMISSION_STATUSES = [
  "pending_commission",
  "approved",
  "paid",
  "chargeback",
  "reversed",
  "denied",
  "unknown",
] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

export function isCommissionStatus(value: unknown): value is CommissionStatus {
  return typeof value === "string" && (COMMISSION_STATUSES as readonly string[]).includes(value);
}

/** Money was taken back. A chargeback and a reversal differ in origin
 *  (customer-side vs vendor-side correction), not in sign. */
export const NEGATIVE_COMMISSION_STATUSES: readonly CommissionStatus[] = ["chargeback", "reversed"];
/** The dealership has the money. */
export const SETTLED_COMMISSION_STATUSES: readonly CommissionStatus[] = ["paid"];
/** Still owed: expected, not received. */
export const OPEN_COMMISSION_STATUSES: readonly CommissionStatus[] = ["pending_commission", "approved"];

export function isNegativeCommissionStatus(status: CommissionStatus): boolean {
  return NEGATIVE_COMMISSION_STATUSES.includes(status);
}

export const COMMISSION_STATUS_LABELS: Readonly<Record<CommissionStatus, string>> = {
  pending_commission: "Pending",
  approved: "Approved",
  paid: "Paid",
  chargeback: "Chargeback",
  reversed: "Reversed",
  denied: "Denied",
  unknown: "Unknown",
};

// ── Status normalization ──────────────────────────────────────────────────────
// Ordered most-specific-first, and NEGATIVE BEFORE POSITIVE, because vendor
// phrases routinely contain both words. "Chargeback - commission paid back"
// must never read as `paid`, and "Reversal of approved commission" must never
// read as `approved`. Getting this backwards puts money in a rep's statement
// that the carrier already took away.
//
// Anything unrecognised is `unknown`, never a guess. Unknown rows still import
// and still show up for review; they simply carry no money meaning until an
// admin maps them. Guessing "paid" from an unfamiliar phrase would credit a
// number no vendor ever promised.

interface StatusRule { status: CommissionStatus; patterns: readonly RegExp[] }

const STATUS_RULES: readonly StatusRule[] = [
  { status: "chargeback", patterns: [/charge\s*-?\s*back/i, /\bcb\b/i, /claw\s*-?\s*back/i] },
  { status: "reversed", patterns: [/revers/i, /\bvoid/i, /recoup/i, /debit\s*memo/i, /\bbackout\b/i] },
  { status: "denied", patterns: [/deni|denied/i, /\breject/i, /disqualif/i, /not\s*payable/i, /ineligible/i] },
  { status: "paid", patterns: [/\bpaid\b/i, /payment\s*(sent|issued|made)/i, /remitted/i, /\bsettled\b/i, /\bcheck\s*(sent|issued)/i] },
  { status: "approved", patterns: [/approv/i, /\bcleared\b/i, /validated/i, /\bpayable\b/i] },
  { status: "pending_commission", patterns: [/pending/i, /awaiting/i, /in\s*review/i, /\bheld?\b/i, /on\s*hold/i, /processing/i, /\bopen\b/i] },
];

export function normalizeCommissionStatus(sourceStatus: unknown): CommissionStatus {
  const text = cleanText(sourceStatus);
  if (!text) return "unknown";
  // An exact hit on our own vocabulary wins outright, so re-importing data this
  // product exported round-trips losslessly.
  const exact = text.toLowerCase().replace(/[\s-]+/g, "_");
  if (isCommissionStatus(exact)) return exact;
  for (const rule of STATUS_RULES) {
    if (rule.patterns.some((p) => p.test(text))) return rule.status;
  }
  return "unknown";
}

// ── Money ─────────────────────────────────────────────────────────────────────

/**
 * Money text to integer cents, or null.
 *
 * Returns null - never 0 - when the text carries no number. Zero and "we could
 * not read this" are different facts and only one of them may be summed into a
 * commission total.
 *
 * Handles what a dealer report actually contains:
 *   "$1,234.56"  "300"  "-300.00"  "1.234,56" (EU decimal comma)  46.5 (numeric)
 *   "(300.00)"   -> accounting notation for NEGATIVE three hundred. Reading this
 *                   as +300 is a 600-dollar error per row, in the direction that
 *                   overpays.
 */
export function parseMoneyToCents(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 100) : null;
  }
  let text = String(value).trim();
  if (!text) return null;

  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  text = text.replace(/[$\s ]/g, "").replace(/[A-Za-z]/g, "");
  if (text.startsWith("-")) { negative = true; text = text.slice(1); }
  if (!text) return null;

  // Which separator is the decimal point? If both appear, the LAST one is.
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSep = lastComma > lastDot ? "," : ".";
    const groupSep = decimalSep === "," ? "." : ",";
    text = text.split(groupSep).join("").replace(decimalSep, ".");
  } else if (lastComma >= 0) {
    // A lone comma is decimal only when it looks like one ("1,50"). "1,234" is a
    // thousands group.
    text = /,\d{1,2}$/.test(text) ? text.replace(",", ".") : text.split(",").join("");
  }

  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return negative ? -cents : cents;
}

/**
 * The amount with the sign its status implies.
 *
 * Vendors are inconsistent: some export a chargeback as -300.00, some as 300.00
 * with the status carrying the meaning. Summing the raw column across a mixed
 * report is therefore wrong in one direction or the other, silently. This is the
 * ONE place that decides, so every total in the product agrees.
 *
 * Sum THIS, never the raw column.
 */
export function signedCommissionCents(input: {
  commissionStatus: CommissionStatus;
  grossCommissionCents?: number | null;
}): number {
  const raw = input.grossCommissionCents;
  if (raw == null || !Number.isFinite(raw)) return 0;
  const magnitude = Math.abs(Math.trunc(raw));
  return isNegativeCommissionStatus(input.commissionStatus) ? -magnitude : magnitude;
}

/** Format cents for display. Negative renders with a leading minus, not
 *  parentheses - the house style forbids accounting notation in UI copy, and a
 *  rep reading "(300.00)" on a phone does not read it as negative. */
export function formatCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "-";
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const text = `$${(abs / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return negative ? `-${text}` : text;
}

// ── Rollup ────────────────────────────────────────────────────────────────────

export interface CommissionTotals {
  /** Expected but not yet received: pending + approved. */
  openCents: number;
  /** Received. */
  paidCents: number;
  /** Taken back. Always <= 0. */
  negativeCents: number;
  /** paid + negative - what the dealership actually kept. */
  netCents: number;
  counts: Record<CommissionStatus, number>;
}

/**
 * Roll a set of commission rows into the five numbers a dashboard shows.
 *
 * One function so the rep card, the finance board and any export cannot disagree
 * about what "paid" means - the failure this repo already guards against in
 * shared/territoryMetrics.ts by having one place define the buckets.
 */
export function rollUpCommissions(
  rows: readonly { commissionStatus: CommissionStatus; grossCommissionCents?: number | null }[],
): CommissionTotals {
  const counts = Object.fromEntries(COMMISSION_STATUSES.map((s) => [s, 0])) as Record<CommissionStatus, number>;
  let openCents = 0, paidCents = 0, negativeCents = 0;

  for (const row of rows) {
    counts[row.commissionStatus] += 1;
    const signed = signedCommissionCents(row);
    if (isNegativeCommissionStatus(row.commissionStatus)) negativeCents += signed;
    else if (SETTLED_COMMISSION_STATUSES.includes(row.commissionStatus)) paidCents += signed;
    else if (OPEN_COMMISSION_STATUSES.includes(row.commissionStatus)) openCents += signed;
    // `denied` and `unknown` deliberately contribute to NO total. A denied row
    // is not money owed, and an unknown one is not money at all until a human
    // says what it is - counting it would put a number on screen that nobody
    // can defend.
  }

  return { openCents, paidCents, negativeCents, netCents: paidCents + negativeCents, counts };
}
