// ── PerfectVision: the Commission File ───────────────────────────────────────
//
// Every PerfectVision-specific fact about the MONEY feed lives here, the way
// perfectVisionSubmittedOrders.ts holds every fact about the LIFECYCLE feed.
//
// The source is the "Commission File" page under My Account on the dealer site
// (https://www.perfect-vision.com, dealer HF336): an HTML table with a
// date-range filter, exported or captured as CSV. It is a page the vendor
// renders with FIXED columns, not a report an admin composed, which is why
// this provider binds headers by name and refuses on a mismatch instead of
// carrying the submitted-orders plane's per-organization mapping editor - see
// shared/commissionSource.ts for that reasoning in full.
//
// AUTHORIZATION POSTURE: identical to the submitted-orders provider, and for
// the same reasons. The page sits behind a dealer login; there is no fetch
// path, no scraping branch, and no credential storage. An operator exports the
// page themselves and uploads the file. Nothing here ever opens a connection
// to PerfectVision.
//
// THE ONE JOIN FACT THAT SHAPES EVERYTHING DOWNSTREAM: this file carries NO
// Chuzo order number. vendor_orders rows carry external_order_id (013xxxxx)
// but the POE report has no account-number column, so on first contact the two
// planes share NO machine identity. The bridge is built by people: a human
// confirms a line against a sale once, the confirmation stamps the Windstream
// account number onto the sale and the vendor order, and every later file
// matches that account exactly. server/commissionMatching.ts implements that
// discipline.

import { isBlankCsvRow, parseCsvRows } from "../csv";
import { readXlsxFirstSheet, XlsxError, MAX_XLSX_ROWS } from "../xlsx";
import { sha256Hex } from "../vendorOrderCrypto";
import { ProviderError } from "./perfectVisionSubmittedOrders";
import { parseVendorDate, DEFAULT_REPORT_TIMEZONE } from "@shared/orderStatusSource";
import {
  bindCommissionHeaders, canonicalCommissionRowString, commissionLineKey,
  commissionProductFamily, normalizeCommissionCategory, normalizeCommissionId,
  normalizeCommissionLineStatus, parseCommissionComment, parseMoneyCents,
  type CommissionField, type NormalizedCommissionLine,
} from "@shared/commissionSource";

export const COMMISSION_PROVIDER = "perfectvision_commission_file";
export const COMMISSION_SOURCE_NAME = "Commission File";
export const COMMISSION_SOURCE_URL = "https://www.perfect-vision.com/my-account/commission-file";

/** Rows an upload may carry. The page is a per-dealer commission ledger - a
 *  QUARTER of a busy dealer is hundreds of rows, not tens of thousands - so
 *  the cap is far above any real file and far below anything hostile. Refused
 *  above it, never truncated: a silently truncated commission file is missing
 *  exactly the money nobody reconciles. */
export const MAX_COMMISSION_IMPORT_ROWS = 50_000;

export interface ParsedCommissionReport {
  columns: string[];
  byField: Record<CommissionField, string>;
  rows: Record<string, unknown>[];
  skippedRows: number;
}

/**
 * Bytes to header-keyed rows, bound to the page's own column names.
 *
 * Format sniffed by the caller the same way order uploads are. The header row
 * is the first non-blank row; a captured page sometimes carries a title line
 * above it, so the reader scans forward until a row BINDS rather than
 * anointing row one. A file whose headers never bind is refused with the
 * missing names spelled out.
 */
export function parseCommissionReport(input: {
  content: Buffer;
  format: "csv" | "xlsx";
  maxRows?: number;
}): ParsedCommissionReport {
  const cap = Math.min(Math.max(1, input.maxRows ?? MAX_COMMISSION_IMPORT_ROWS), MAX_COMMISSION_IMPORT_ROWS);

  let grid: string[][];
  if (input.format === "xlsx") {
    try {
      grid = readXlsxFirstSheet(input.content).rows;
    } catch (e) {
      throw new ProviderError(e instanceof XlsxError ? e.message : "This spreadsheet could not be read.");
    }
    if (grid.length >= MAX_XLSX_ROWS) {
      throw new ProviderError("This spreadsheet has too many rows to import. Narrow the date range and export again.");
    }
  } else {
    const text = stripBom(input.content.toString("utf8"));
    if (!text.trim()) throw new ProviderError("This file is empty.");
    grid = parseCsvRows(text);
  }

  const nonBlank = grid.filter((r) => !isBlankCsvRow(r));
  if (nonBlank.length === 0) throw new ProviderError("This file has no rows.");

  // Find the header row: the first row every expected column name binds to.
  let headerIndex = -1;
  let columns: string[] = [];
  let binding: ReturnType<typeof bindCommissionHeaders> | null = null;
  for (let i = 0; i < Math.min(nonBlank.length, 10); i += 1) {
    const candidate = nonBlank[i].map((c) => String(c ?? "").trim());
    const bound = bindCommissionHeaders(candidate);
    if (bound.ok) { headerIndex = i; columns = candidate; binding = bound; break; }
    if (binding == null || bound.missing.length < binding.missing.length) {
      binding = bound; columns = candidate;
    }
  }
  if (headerIndex < 0 || !binding?.ok) {
    const missing = binding?.missing ?? [];
    throw new ProviderError(
      `This does not look like the Commission File export. Missing column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. ` +
      "Export the Commission File page again without editing its columns.",
    );
  }

  if (nonBlank.length - headerIndex - 1 > cap) {
    throw new ProviderError(
      `This file has more than ${cap.toLocaleString()} rows. Narrow the date range and import each part.`,
    );
  }

  const rows: Record<string, unknown>[] = [];
  let skipped = 0;
  for (let i = headerIndex + 1; i < nonBlank.length; i += 1) {
    const raw = nonBlank[i];
    // More cells than headers is a malformed line (usually an unescaped
    // comma). Counted and skipped, never silently squeezed to fit.
    if (raw.length > columns.length) { skipped += 1; continue; }
    const record: Record<string, unknown> = {};
    for (let c = 0; c < columns.length; c += 1) record[columns[c]] = raw[c] ?? "";
    rows.push(record);
  }

  return {
    columns,
    byField: binding.byField as Record<CommissionField, string>,
    rows,
    skippedRows: skipped,
  };
}

/**
 * One raw row to one normalized line. Pure given its inputs; the hash is over
 * the canonical string so a re-export with reordered columns is not a change.
 */
export function normalizeCommissionRow(input: {
  organizationId: number;
  row: Record<string, unknown>;
  byField: Record<CommissionField, string>;
  timeZone?: string;
}): NormalizedCommissionLine {
  const tz = input.timeZone || DEFAULT_REPORT_TIMEZONE;
  const cell = (field: CommissionField): unknown => input.row[input.byField[field]];
  const text = (field: CommissionField): string | null => {
    const v = cell(field);
    if (v == null) return null;
    const t = String(v).trim();
    return t || null;
  };

  const accountNumber = text("accountNumber");
  const documentNumber = text("documentNumber");
  const accountKey = normalizeCommissionId(accountNumber);
  const documentKey = normalizeCommissionId(documentNumber);
  const category = normalizeCommissionCategory(cell("category"), {
    hasOrderIdentity: Boolean(accountKey || documentKey),
  });

  const comments = text("comments");
  const commentFacts = parseCommissionComment(comments);
  const product = text("product");
  const customerName = text("customerName") ?? commentFacts.customerName;

  const line: Omit<NormalizedCommissionLine, "rawRowHash" | "lineKey"> = {
    provider: "perfectvision_commission_file",
    organizationId: input.organizationId,
    accountNumber, documentNumber, accountKey, documentKey,
    product,
    productKey: normalizeCommissionId(product),
    productFamily: commissionProductFamily(product ?? commentFacts.productText),
    category,
    lineStatus: normalizeCommissionLineStatus(cell("lineStatus")),
    program: text("program"),
    customerName,
    salesAgentName: text("salesAgentName"),
    comments,
    firstChargeback: commentFacts.firstChargeback,
    pendingAmountCents: parseMoneyCents(cell("pendingAmount")),
    paidAmountCents: parseMoneyCents(cell("paidAmount")),
    actDeactDate: parseVendorDate(cell("actDeactDate"), tz),
    uploadDate: parseVendorDate(cell("uploadDate"), tz),
    paymentDate: parseVendorDate(cell("paymentDate"), tz),
    sourceRowPayload: input.row,
  };

  const lineKey = commissionLineKey(line);
  const rawRowHash = sha256Hex(canonicalCommissionRowString({ ...line, lineKey }));
  return { ...line, lineKey, rawRowHash };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
