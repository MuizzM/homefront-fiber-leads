// ── External commission sources - the contract ───────────────────────────────
// PURE and framework-free. The vocabulary the provider MONEY feed speaks, the
// way shared/orderStatusSource.ts is the vocabulary the provider LIFECYCLE feed
// speaks. PerfectVision's "Commission File" page is the first source; a second
// carrier's commission export would implement the same shapes and change
// nothing downstream.
//
// WHAT THIS PLANE IS, AND IS NOT.
//
// This is PROVIDER-PAID TRUTH: what the provider's accounting says it has paid,
// is about to pay, or has clawed back, per order line. It is recorded ALONGSIDE
// the internal commission engine (docs/COMMISSIONS.md), never into it:
//
//   • A paid line here never books a sale, prices a statement, or moves a
//     payout. server/commissionService.ts owns what a REP is paid; this plane
//     owns what the PROVIDER paid the dealership, and the two are reconciled by
//     a human, not by a write.
//   • What it writes is `vendor_order_commission_links` - the seam the order
//     plane already reads for "has commission truth said anything about this
//     order" - plus its own line ledger as evidence.
//
// THE FILE ITSELF. The PerfectVision dealer site renders the Commission File
// as an HTML table with a date-range filter, with FIXED columns the vendor
// controls. That is why there is no per-organization column-mapping editor
// here, where the submitted-orders plane has one: that plane reads a
// Salesforce report whose headers depend on whoever built the report, and the
// mapping screen exists to absorb that variance. This page's headers are the
// vendor's own and stable; if they ever change, the right behaviour is to
// refuse loudly with the missing names, not to let an admin re-bind "Paid
// Amount" to something else. Header binding below is tolerant of case and
// spacing and nothing more.
//
// THE ROW MODEL, and its three traps, all real in captured files:
//
//   • The same Account + Document appears on SEVERAL rows at once - one per
//     product line of the order (the fiber plan, the security add-on, tech
//     support) - and appears AGAIN in later weeks as its status moves Open ->
//     Closed. Row identity is therefore (account, document, product, category),
//     and the NEWEST upload date wins; an older restatement is evidence, never
//     a regression.
//   • Money renders for spreadsheets, not machines: negatives as "($45.00)",
//     thousands as "$2,405.00". parseMoneyCents below is the one reader.
//   • Two kinds of row are not order lines at all. A batch "Payment" row
//     (empty account, document and agent) is the weekly payout TOTAL, and a
//     "PAYMENT" row with an account but no customer column is a manual spiff
//     whose customer name lives only inside the Comments string.

// ── Category vocabulary ──────────────────────────────────────────────────────

/** What a commission row IS. Distinguished before anything else, because the
 *  batch-total and manual-payment shapes carry their facts in different
 *  columns than an order line does. */
export const COMMISSION_CATEGORIES = [
  "activation",      // an order line earning; Open (pending) then Closed (paid)
  "chargeback",      // a clawback against an earlier activation; amount negative
  "manual_payment",  // a spiff or correction keyed by hand; customer in Comments
  "payment_batch",   // the weekly payout total; not an order line at all
  "unknown",
] as const;
export type CommissionCategory = (typeof COMMISSION_CATEGORIES)[number];

/** Open/Closed as the page renders it. `open` means the provider still owes or
 *  still holds the amount; `closed` means the money moved (or finished moving
 *  back, for a chargeback). */
export const COMMISSION_LINE_STATUSES = ["open", "closed", "unknown"] as const;
export type CommissionLineStatus = (typeof COMMISSION_LINE_STATUSES)[number];

/** What this plane writes into vendor_order_commission_links.commission_status.
 *  `paid` is the value the recovery engine's hard block already queries for
 *  (vendorOrderStore.commissionPaidForOrder), so it is load-bearing. */
export const COMMISSION_LINK_STATUSES = ["pending", "paid", "chargeback"] as const;
export type CommissionLinkStatus = (typeof COMMISSION_LINK_STATUSES)[number];

/**
 * Normalize the Category cell.
 *
 * The captured files write the weekly total as "Payment" and the manual spiff
 * as "PAYMENT", but casing is a rendering accident nothing should hang on. The
 * distinction that holds is structural: the weekly total is the row with no
 * account and no document, and a payment WITH an order identity is a manual
 * payment against that order.
 */
export function normalizeCommissionCategory(
  raw: unknown,
  opts: { hasOrderIdentity: boolean },
): CommissionCategory {
  const text = cleanCell(raw)?.toLowerCase() ?? "";
  if (!text) return opts.hasOrderIdentity ? "unknown" : "payment_batch";
  if (text.includes("charge")) return "chargeback";
  if (text.includes("activ")) return "activation";
  if (text.includes("payment") || text.includes("paid")) {
    return opts.hasOrderIdentity ? "manual_payment" : "payment_batch";
  }
  return "unknown";
}

export function normalizeCommissionLineStatus(raw: unknown): CommissionLineStatus {
  const text = cleanCell(raw)?.toLowerCase() ?? "";
  if (text === "open") return "open";
  if (text === "closed") return "closed";
  return "unknown";
}

// ── Money ────────────────────────────────────────────────────────────────────

/**
 * Read a rendered money cell into integer cents.
 *
 * Handles "$625.00", "$2,405.00", "($45.00)" (accounting negative), "-$45.00",
 * and bare numbers. Returns null for empty or unreadable text - a cell the
 * parser cannot read is a row error an admin gets to see, never a silent zero
 * that would make a chargeback look free. Arithmetic is done on the digit
 * strings, not on floats, so $0.10 is 10 and stays 10.
 */
export function parseMoneyCents(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return Math.round(raw * 100);
  }
  let text = String(raw).trim();
  if (!text) return null;
  let negative = false;
  const parens = /^\((.*)\)$/.exec(text);
  if (parens) { negative = true; text = parens[1].trim(); }
  if (text.startsWith("-")) { negative = true; text = text.slice(1).trim(); }
  text = text.replace(/[$,\s]/g, "");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

// ── Comments ─────────────────────────────────────────────────────────────────

export interface CommissionCommentFacts {
  /** The customer named inside "WI: NAME - PRODUCT/SUFFIX". For a manual
   *  payment this is the ONLY place the customer appears. */
  customerName: string | null;
  /** The product text after the first " - ". Kept for display; matching uses
   *  the Product column when it has one. */
  productText: string | null;
  /** "/FCHB" - first chargeback. "/ACTV" and absence both mean not one. */
  firstChargeback: boolean;
}

/**
 * Read the Comments cell: "WI: BARBARA BRUCE - HSI SOLO FIBER MAX-THE WORKS/ACTV".
 *
 * The FIRST " - " (space, hyphen, space) splits name from product, because the
 * product half routinely contains hyphens of its own ("MAX-THE WORKS"). The
 * trailing "/XXXX" marker is stripped from the product and read for FCHB.
 */
export function parseCommissionComment(raw: unknown): CommissionCommentFacts {
  const none: CommissionCommentFacts = { customerName: null, productText: null, firstChargeback: false };
  const text = cleanCell(raw);
  if (!text) return none;
  const firstChargeback = /\/FCHB\s*$/i.test(text);
  const m = /^WI:\s*(.+)$/i.exec(text);
  if (!m) return { ...none, firstChargeback };
  const body = m[1];
  const split = body.indexOf(" - ");
  if (split < 0) return { ...none, firstChargeback };
  const customerName = body.slice(0, split).trim() || null;
  const productText = body.slice(split + 3).replace(/\/\w+\s*$/, "").trim() || null;
  return { customerName, productText, firstChargeback };
}

// ── Product families ─────────────────────────────────────────────────────────

/** Coarse product buckets, for CORROBORATION only. An order's product column
 *  carries the headline plan while the commission file itemizes every add-on
 *  line under the same account and document, so a family disagreement must
 *  never exclude a candidate - the security line really does belong to the
 *  fiber order. */
export const COMMISSION_PRODUCT_FAMILIES = [
  "internet", "security", "tech_support", "video", "voice", "spiff", "other",
] as const;
export type CommissionProductFamily = (typeof COMMISSION_PRODUCT_FAMILIES)[number];

export function commissionProductFamily(product: unknown): CommissionProductFamily | null {
  const text = cleanCell(product)?.toUpperCase() ?? "";
  if (!text) return null;
  if (/SPIFF|MANUAL PAYMENT/.test(text)) return "spiff";
  if (/TECH\s*SUPPORT/.test(text)) return "tech_support";
  if (/SECURE|SECURITY/.test(text)) return "security";
  if (/FIBER|HSI|GIG|INTERNET|BROADBAND|SOLO/.test(text)) return "internet";
  if (/\bTV\b|VIDEO|STREAM/.test(text)) return "video";
  if (/VOICE|PHONE|\bLINE\b/.test(text)) return "voice";
  return "other";
}

// ── Header binding ───────────────────────────────────────────────────────────

/** The Commission File page's own column names, one per normalized field. */
export const COMMISSION_FILE_HEADERS = {
  accountNumber: "Account Number",
  documentNumber: "Document Number",
  actDeactDate: "Act/Deact Date",
  uploadDate: "Upload Date",
  paymentDate: "Payment Date",
  lineStatus: "Status",
  pendingAmount: "Pending Amount",
  paidAmount: "Paid Amount",
  category: "Category",
  program: "Program",
  product: "Product",
  customerName: "Customer Name",
  salesAgentName: "Sales Agent Name",
  comments: "Comments",
} as const;
export type CommissionField = keyof typeof COMMISSION_FILE_HEADERS;

const headerKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Bind the file's headers to fields, tolerating case and spacing and nothing
 * else. EVERY expected header must be present: a missing "Comments" column
 * would silently lose first-chargeback markers and manual-payment customer
 * names, which is worse than a refusal that names what changed.
 */
export function bindCommissionHeaders(columns: readonly string[]): {
  ok: boolean;
  byField: Partial<Record<CommissionField, string>>;
  missing: string[];
} {
  const byKey = new Map<string, string>();
  for (const col of columns) {
    const key = headerKey(String(col ?? ""));
    if (key && !byKey.has(key)) byKey.set(key, String(col));
  }
  const byField: Partial<Record<CommissionField, string>> = {};
  const missing: string[] = [];
  for (const [field, label] of Object.entries(COMMISSION_FILE_HEADERS) as [CommissionField, string][]) {
    const found = byKey.get(headerKey(label));
    if (found == null) missing.push(label);
    else byField[field] = found;
  }
  return { ok: missing.length === 0, byField, missing };
}

// ── The normalized line ──────────────────────────────────────────────────────

/** One commission row, after normalization. `organizationId` is this repo's
 *  tenant id, named for the integration contract like NormalizedVendorOrder. */
export interface NormalizedCommissionLine {
  provider: "perfectvision_commission_file";
  organizationId: number;

  accountNumber: string | null;
  documentNumber: string | null;
  /** Comparable forms of the identities, the way orderIdentityKeys builds
   *  them: compacted and uppercased, so a provider reformatting its own ids
   *  cannot fork a line. */
  accountKey: string | null;
  documentKey: string | null;

  product: string | null;
  productKey: string | null;
  productFamily: CommissionProductFamily | null;

  category: CommissionCategory;
  lineStatus: CommissionLineStatus;

  program: string | null;
  /** From the Customer Name column, or recovered from Comments for a manual
   *  payment row whose column is empty. */
  customerName: string | null;
  salesAgentName: string | null;
  comments: string | null;
  firstChargeback: boolean;

  pendingAmountCents: number | null;
  paidAmountCents: number | null;

  actDeactDate: Date | null;
  uploadDate: Date | null;
  paymentDate: Date | null;

  /** The natural row identity: (account, document, product, category), or the
   *  batch/manual fallbacks. What "newest upload date wins" is keyed by, and
   *  what the commission link's source_reference records. */
  lineKey: string;

  /** SHA-256 of canonicalCommissionRowString, computed server-side. */
  rawRowHash: string;
  /** The source record as parsed. Persisted ENCRYPTED, same as the order
   *  plane's rows: it is the only later answer to "what did the file say". */
  sourceRowPayload: Record<string, unknown>;
}

/** Identity normalization, matching shared/orderStatusSource.normalizeExternalId
 *  (duplicated two-liner rather than an import so this module stays free of
 *  order-plane coupling; the tests pin them equal). */
export function normalizeCommissionId(value: unknown): string | null {
  const text = cleanCell(value);
  if (!text) return null;
  const compact = text.replace(/[\s._-]+/g, "").toUpperCase();
  return compact || null;
}

/**
 * The natural key of a line.
 *
 * Order lines: account:document:product:category. A batch payment row has no
 * order identity, so its key is its category, its upload day and its amount -
 * one weekly total per weekly statement. Anything else missing both identities
 * keys on what it has, so two unrelated defective rows do not collapse.
 */
export function commissionLineKey(line: {
  accountKey: string | null; documentKey: string | null; productKey: string | null;
  category: CommissionCategory; uploadDate: Date | null; paymentDate: Date | null;
  paidAmountCents: number | null; customerName: string | null; actDeactDate: Date | null;
}): string {
  if (line.accountKey || line.documentKey) {
    return [
      line.accountKey ?? "-", line.documentKey ?? "-", line.productKey ?? "-", line.category,
    ].join(":");
  }
  if (line.category === "payment_batch") {
    const day = isoDay(line.uploadDate) ?? isoDay(line.paymentDate) ?? "-";
    return ["payment_batch", day, String(line.paidAmountCents ?? 0)].join(":");
  }
  const day = isoDay(line.actDeactDate) ?? isoDay(line.uploadDate) ?? "-";
  const name = (line.customerName ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "") || "-";
  return [line.category, name, line.productKey ?? "-", day].join(":");
}

// ── Row hashing ──────────────────────────────────────────────────────────────

const HASH_FIELDS = [
  "accountNumber", "documentNumber", "product", "category", "lineStatus",
  "program", "customerName", "salesAgentName", "comments",
  "pendingAmountCents", "paidAmountCents",
  "actDeactDate", "uploadDate", "paymentDate",
] as const;

/** The exact string a row's SHA-256 is taken over. Same contract as
 *  canonicalOrderRowString: change its shape and every previously imported row
 *  looks changed at once, so it does not change shape. */
export function canonicalCommissionRowString(
  line: Omit<NormalizedCommissionLine, "rawRowHash" | "sourceRowPayload" | "lineKey"> & { lineKey?: string },
): string {
  const parts: string[] = [];
  for (const field of HASH_FIELDS) {
    const value = (line as Record<string, unknown>)[field];
    if (value == null) { parts.push(`${field}=`); continue; }
    if (value instanceof Date) {
      parts.push(`${field}=${Number.isFinite(value.getTime()) ? value.toISOString() : ""}`);
      continue;
    }
    parts.push(`${field}=${String(value)}`);
  }
  return parts.join("");
}

// ── The money verdict of a line ──────────────────────────────────────────────

export interface CommissionLinkFacts {
  status: CommissionLinkStatus;
  amountCents: number;
  /** The provider's event date for the timeline: the act/deact date, falling
   *  back to payment then upload date. */
  effectiveAt: Date | null;
  /** The statement week the money belongs to, as the payment day (or upload
   *  day while still pending). */
  periodLabel: string | null;
}

/**
 * What a line means in vendor_order_commission_links terms, or null for the
 * rows that are not order money at all (the weekly batch total, unknowns).
 *
 * A chargeback's amount comes out NEGATIVE - the file renders it "($45.00)"
 * and parseMoneyCents keeps the sign - and a chargeback row that has not paid
 * out yet still reports as a chargeback with the pending amount negated, so a
 * clawback in flight is never mistaken for money earned.
 */
export function commissionLinkFacts(line: {
  category: CommissionCategory;
  lineStatus: CommissionLineStatus;
  pendingAmountCents: number | null;
  paidAmountCents: number | null;
  actDeactDate: Date | null;
  uploadDate: Date | null;
  paymentDate: Date | null;
}): CommissionLinkFacts | null {
  if (line.category === "payment_batch" || line.category === "unknown") return null;
  const effectiveAt = line.actDeactDate ?? line.paymentDate ?? line.uploadDate;
  const paid = line.paidAmountCents ?? 0;
  const pending = line.pendingAmountCents ?? 0;
  if (line.category === "chargeback") {
    const amount = paid !== 0 ? paid : -Math.abs(pending);
    return {
      status: "chargeback", amountCents: amount, effectiveAt,
      periodLabel: isoDay(line.paymentDate) ?? isoDay(line.uploadDate),
    };
  }
  if (line.lineStatus === "closed") {
    return {
      status: "paid", amountCents: paid, effectiveAt,
      periodLabel: isoDay(line.paymentDate) ?? isoDay(line.uploadDate),
    };
  }
  return {
    status: "pending", amountCents: pending, effectiveAt,
    periodLabel: isoDay(line.uploadDate),
  };
}

/**
 * Which of two restatements of the same line is CURRENT.
 *
 * Newest upload date wins; ties break Closed over Open (progress), then a row
 * that knows its payment date over one that does not. Returns true when `a`
 * supersedes `b`. Equal scores are the caller's tiebreak (last read wins
 * within one file, which is deterministic for given bytes).
 */
export function commissionRestatementSupersedes(
  a: { uploadDate: Date | null; lineStatus: CommissionLineStatus; paymentDate: Date | null },
  b: { uploadDate: Date | null; lineStatus: CommissionLineStatus; paymentDate: Date | null },
): boolean {
  const score = (x: typeof a): [number, number, number] => [
    x.uploadDate && Number.isFinite(x.uploadDate.getTime()) ? x.uploadDate.getTime() : 0,
    x.lineStatus === "closed" ? 1 : 0,
    x.paymentDate ? 1 : 0,
  ];
  const [a0, a1, a2] = score(a);
  const [b0, b1, b2] = score(b);
  if (a0 !== b0) return a0 > b0;
  if (a1 !== b1) return a1 > b1;
  return a2 > b2;
}

// ── Small shared helpers ─────────────────────────────────────────────────────

/** Trimmed cell text or null; the report-builder placeholders become null the
 *  same way orderStatusSource.cleanText treats them. */
function cleanCell(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (/^(n\/?a|none|null|undefined|-{1,3}|#n\/a)$/i.test(text)) return null;
  return text;
}

function isoDay(value: Date | null | undefined): string | null {
  if (!value || !Number.isFinite(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}
