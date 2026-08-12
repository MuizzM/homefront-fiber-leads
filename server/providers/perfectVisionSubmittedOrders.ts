// ── PerfectVision POE: Total Submitted Orders by Program ─────────────────────
//
// Every PerfectVision-specific fact in this integration lives in this file. The
// pipeline around it knows only OrderStatusSourceProvider, so a second carrier
// feed is a sibling file and nothing downstream changes.
//
// AUTHORIZATION POSTURE, AND WHY fetchOrderReport DOES NOT SCRAPE.
//
// The source is an authenticated Salesforce Experience Cloud report:
//   https://perfectvisionpoe.my.site.com/poe/s/report/00O5f000008aWTiEAM/...
//
// A report page behind a session is not an API. Driving it server-side would
// mean storing a dealer's portal password, replaying their session cookie and
// CSRF token, and parsing HTML that PerfectVision may restructure without
// notice. That is credential-sharing against a vendor system, it is the kind of
// automated access a portal's terms typically prohibit, and it produces an
// integration that breaks silently and looks like a compromised account while
// it does.
//
// So this provider will not do it, and the code is arranged so that it cannot
// be turned on by accident:
//
//   • MANUAL UPLOAD is the supported path, and it is complete. An admin exports
//     the report from the portal themselves and uploads the CSV or XLSX.
//   • fetchOrderReport refuses unless PERFECTVISION_ORDER_SYNC_ENABLED is
//     explicitly "true" AND the connection is in an authorized automated mode.
//     Even then, there is no scraping branch to reach - the automated modes are
//     an official export endpoint, an SFTP drop, or a scheduled report email,
//     and each one is wired only once PerfectVision has authorized it in
//     writing for that dealer.
//   • Nothing here ever runs in a request handler, and nothing here ever
//     returns provider HTML, headers, cookies or tokens to a caller.
//
// This is the same shape docs/CALLING_COMPLIANCE.md records for DNC data and
// the same one server/fccImportStore.ts records for the FCC files: where a
// source cannot be fetched under authorization, the operator brings the file
// and the pipeline is built around that rather than around a scraper nobody
// will admit to running.

import { isBlankCsvRow, parseCsvRows } from "../csv";
import { readXlsxFirstSheet, XlsxError, MAX_XLSX_ROWS } from "../xlsx";
import { sha256Hex } from "../vendorOrderCrypto";
import {
  DEFAULT_REPORT_TIMEZONE,
  normalizeOrderStatus as normalizeStatus,
  type ConnectionTestResult,
  type FetchOrderReportInput,
  type IntegrationConnection,
  type MappingValidationResult,
  type NormalizeOrderRowInput,
  type NormalizedOrderStatus,
  type NormalizedVendorOrder,
  type OrderColumnMapping,
  type OrderStatusSourceProvider,
  type ParseOrderReportInput,
  type ParsedOrderReport,
  type RawOrderReport,
} from "@shared/orderStatusSource";
import {
  applyOrderMapping, validateOrderColumnMapping, withRowHash,
} from "@shared/orderColumnMapping";

/** The report this provider is built for. Recorded so an import's provenance
 *  survives the connection row being edited later. */
export const SOURCE_REPORT_NAME = "Total Submitted Orders by Program";
export const SOURCE_REPORT_ID = "00O5f000008aWTiEAM";
export const SOURCE_REPORT_URL =
  "https://perfectvisionpoe.my.site.com/poe/s/report/00O5f000008aWTiEAM/total-submitted-orders-by-program";

/** Read at CALL time, never captured at module load: this is the kill switch,
 *  and it has to take effect on the next job rather than the next restart.
 *  Same device as fccImportStore.kinetic2026Enabled. */
export function orderSyncEnabled(): boolean {
  return process.env.PERFECTVISION_ORDER_SYNC_ENABLED === "true";
}

export function recoveryMessagingEnabled(): boolean {
  return process.env.PERFECTVISION_ORDER_RECOVERY_MESSAGING_ENABLED === "true";
}

/** Modes that would mean an automated pull. Manual upload is not one of them,
 *  which is why an org left on the default can never trip the sync path. */
const AUTOMATED_MODES = new Set(["scheduled_export", "sftp", "api"]);

/** Rows an upload may carry. Above this the file is refused rather than
 *  truncated: a silently truncated import looks like a complete one, and the
 *  orders it dropped are exactly the ones nobody chases. */
export const MAX_IMPORT_ROWS = 100_000;

export class ProviderError extends Error {
  readonly safeMessage: string;
  constructor(safeMessage: string) {
    super(safeMessage);
    this.name = "ProviderError";
    // Named separately from `message` so a caller never has to wonder whether
    // the string it is about to show an admin came from us or from a vendor
    // response body.
    this.safeMessage = safeMessage;
  }
}

class PerfectVisionSubmittedOrdersByProgramProvider implements OrderStatusSourceProvider {
  readonly providerName = "perfectvision_submitted_orders";

  /**
   * What this connection can do right now.
   *
   * Deliberately does NOT contact PerfectVision. There is nothing to contact -
   * the supported path is an upload - and a "test" that logged into a dealer's
   * portal to prove a password works is precisely the behaviour this
   * integration refuses. The result reports configuration readiness, which is
   * the question an admin is actually asking.
   */
  async testConnection(connection: IntegrationConnection): Promise<ConnectionTestResult> {
    const syncOn = orderSyncEnabled();
    const automated = AUTOMATED_MODES.has(connection.mode);

    if (!automated) {
      return {
        ok: true,
        message: `Manual upload is ready. Export "${SOURCE_REPORT_NAME}" from the PerfectVision portal and upload the CSV or XLSX here.`,
        checkedAt: new Date(),
        capabilities: { canFetchReport: false, canParseUpload: true },
      };
    }
    if (!syncOn) {
      return {
        ok: false,
        message: "Automated retrieval is turned off. It stays off until PerfectVision authorizes it for this dealer and an administrator enables the sync flag on the server.",
        checkedAt: new Date(),
        capabilities: { canFetchReport: false, canParseUpload: true },
      };
    }
    return {
      ok: false,
      message: "Automated retrieval is enabled but no authorized delivery is configured. Add an approved export endpoint, an SFTP drop, or a scheduled report delivery before turning this on.",
      checkedAt: new Date(),
      capabilities: { canFetchReport: false, canParseUpload: true },
    };
  }

  /**
   * The automated path. It refuses, on purpose, and in three separate places.
   *
   * When PerfectVision authorizes a delivery for a dealer, the implementation
   * goes in the branch below - an official export endpoint, an SFTP fetch, or
   * a mailbox poll. None of them is a browser session, and none of them is
   * written here on the assumption that it will be allowed.
   */
  async fetchOrderReport(input: FetchOrderReportInput): Promise<RawOrderReport[]> {
    if (!orderSyncEnabled()) {
      throw new ProviderError(
        "Automated report retrieval is disabled. Upload the report export instead.",
      );
    }
    if (!AUTOMATED_MODES.has(input.connection.mode)) {
      throw new ProviderError(
        "This connection is set to manual upload. Change it to an authorized automated delivery first.",
      );
    }
    if (!input.connection.enabled) {
      throw new ProviderError("This connection is disabled.");
    }
    throw new ProviderError(
      "No authorized PerfectVision delivery is configured. Automated retrieval requires written authorization from PerfectVision and an approved export endpoint, SFTP drop, or scheduled report delivery.",
    );
  }

  /**
   * Bytes to header-keyed rows.
   *
   * The format is sniffed rather than taken from the file name, and the header
   * row is the FIRST non-blank row - a Salesforce export often carries a title
   * line and a filter line above the real headers, and the caller can skip
   * those by trimming before it gets here. Duplicate headers are disambiguated
   * rather than silently collapsed, because a report with two "Date" columns
   * would otherwise lose one of them without saying so.
   */
  async parseOrderReport(input: ParseOrderReportInput): Promise<ParsedOrderReport> {
    const { report } = input;
    const cap = Math.min(Math.max(1, input.maxRows), MAX_IMPORT_ROWS);

    let grid: string[][];
    if (report.format === "xlsx") {
      try {
        grid = readXlsxFirstSheet(report.content).rows;
      } catch (e) {
        throw new ProviderError(e instanceof XlsxError ? e.message : "This spreadsheet could not be read.");
      }
      if (grid.length >= MAX_XLSX_ROWS) {
        throw new ProviderError("This spreadsheet has too many rows to import. Split the report by date range and import each part.");
      }
    } else {
      const text = stripBom(report.content.toString("utf8"));
      if (!text.trim()) throw new ProviderError("This file is empty.");
      grid = parseCsvRows(text);
    }

    const nonBlank = grid.filter((r) => !isBlankCsvRow(r));
    if (nonBlank.length === 0) throw new ProviderError("This file has no rows.");

    const headerRow = nonBlank[0];
    const columns = dedupeHeaders(headerRow);
    if (columns.every((c) => !c.trim())) {
      throw new ProviderError("The first row of this file has no column names.");
    }

    const rows: Record<string, unknown>[] = [];
    let skipped = 0;
    let truncated = false;

    for (let i = 1; i < nonBlank.length; i += 1) {
      if (rows.length >= cap) { truncated = true; break; }
      const raw = nonBlank[i];
      // A row with more cells than headers is a malformed line, usually an
      // unescaped comma. Counted and skipped rather than silently truncated to
      // the header width, which would shift every value after the break.
      if (raw.length > columns.length) { skipped += 1; continue; }
      const record: Record<string, unknown> = {};
      for (let c = 0; c < columns.length; c += 1) record[columns[c]] = raw[c] ?? "";
      rows.push(record);
    }

    return { columns, rows, skippedRows: skipped, truncated };
  }

  async normalizeOrderRow(input: NormalizeOrderRowInput): Promise<NormalizedVendorOrder> {
    return withRowHash(applyOrderMapping({
      ...input,
      timeZone: input.timeZone || input.mapping.timeZone || DEFAULT_REPORT_TIMEZONE,
    }), sha256Hex);
  }

  normalizeOrderStatus(sourceStatus: string | null): NormalizedOrderStatus {
    return normalizeStatus(sourceStatus);
  }

  validateColumnMapping(
    mapping: OrderColumnMapping,
    sampleRows: Record<string, unknown>[],
    organizationId = 0,
  ): MappingValidationResult {
    return validateOrderColumnMapping(mapping, sampleRows, organizationId, sha256Hex);
  }
}

export const perfectVisionSubmittedOrdersProvider = new PerfectVisionSubmittedOrdersByProgramProvider();

/** The registry. One entry today; the point is that the pipeline resolves a
 *  provider by name rather than importing one. */
const PROVIDERS: Readonly<Record<string, OrderStatusSourceProvider>> = {
  perfectvision_submitted_orders: perfectVisionSubmittedOrdersProvider,
};

export function getOrderStatusProvider(name: string): OrderStatusSourceProvider {
  const provider = PROVIDERS[name];
  if (!provider) throw new ProviderError(`No order feed named "${String(name).slice(0, 40)}" is configured.`);
  return provider;
}

export function listOrderStatusProviders(): { name: string; label: string; reportName: string; sourceUrl: string }[] {
  return [{
    name: "perfectvision_submitted_orders",
    label: "PerfectVision - Total Submitted Orders by Program",
    reportName: SOURCE_REPORT_NAME,
    sourceUrl: SOURCE_REPORT_URL,
  }];
}

// ── helpers ──────────────────────────────────────────────────────────────────

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Make every header unique and non-empty.
 *
 * A mapping binds a field to a header LABEL, so two columns called "Date" would
 * make one of them unreachable and the other ambiguous. They become "Date" and
 * "Date (2)", which is what an admin sees in the mapping screen, so the choice
 * they make is the choice that gets applied.
 */
function dedupeHeaders(row: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return row.map((cell, i) => {
    const base = String(cell ?? "").trim() || `Column ${i + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}
