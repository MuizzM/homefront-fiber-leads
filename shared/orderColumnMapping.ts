// ── Order-report column mapping - the layer that refuses to guess ────────────
// PURE and framework-free.
//
// The brief's hardest constraint lives here: DO NOT ASSUME THE POE REPORT'S
// COLUMNS. A Salesforce report export is not an API. Its headers depend on who
// built the report, which columns they left in, whether they renamed any, and
// which version of the report they ran. A provider that pattern-matches
// "Order Status" ships broken the first time an admin adds a grouping column.
//
// So the mapping is DATA: stored per organization, edited by an admin who is
// looking at their own export. This module owns three jobs and nothing else.
//
//   1. SUGGEST  - given the real headers, propose a mapping. A suggestion is a
//                 convenience for the admin's first visit, never an assumption.
//                 Nothing imports off a suggestion a human did not save.
//   2. VALIDATE - say precisely why a mapping cannot be used yet, with every
//                 problem at once rather than one per attempt.
//   3. APPLY    - turn one raw record into a normalized order.
//
// The split matters. Auto-detection that silently becomes the live mapping is
// the failure this design exists to prevent: it works on the sample, then
// quietly binds "Install Date" to the SCHEDULED date on a later export and
// every order in the org looks installed.

import {
  DEFAULT_REPORT_TIMEZONE,
  IDENTITY_ORDER_FIELDS,
  MAPPABLE_ORDER_FIELDS,
  ORDER_FIELD_LABELS,
  canonicalOrderRowString,
  cleanText,
  isOrderStatus,
  normalizeExternalId,
  normalizeOrderStatus,
  normalizeServiceAddress,
  parseVendorDate,
  type MappableOrderField,
  type MappingValidationIssue,
  type MappingValidationResult,
  type NormalizeOrderRowInput,
  type NormalizedOrderStatus,
  type NormalizedVendorOrder,
  type OrderColumnMapping,
} from "./orderStatusSource";
import { isPlausibleEmail, normalizePhoneE164 } from "./contactConsent";

/** Hash injection. The canonical string is pure; SHA-256 is not available in
 *  every runtime this module is imported into, so the caller supplies it. */
export type Sha256 = (input: string) => string;

// ── 1. SUGGEST ───────────────────────────────────────────────────────────────

/**
 * Header patterns per field, most specific first.
 *
 * Ordering inside a field matters as much as ordering between fields:
 * "Scheduled Install Date" must bind to installScheduledAt, not installDate,
 * and the only way to guarantee that is to test the specific phrase before the
 * general one and to consume each header exactly once.
 */
const HEADER_HINTS: Readonly<Record<MappableOrderField, readonly RegExp[]>> = {
  externalOrderId: [/^order\s*(id|number|no|#)$/i, /\border\s*(id|number|no|#)\b/i, /^wo\s*#?$/i, /work\s*order/i],
  externalTransactionId: [/^transaction\s*(id|number|no|#)$/i, /\btransaction\s*(id|number|no|#)\b/i, /\btxn\b/i, /\bconfirmation\s*(id|number|#)\b/i],
  customerAccountNumber: [/^account\s*(number|no|#|id)$/i, /\bcustomer\s*account\b/i, /\baccount\s*(number|no|#)\b/i, /\bbtn\b/i, /\bcust\s*acct\b/i],
  customerName: [/^customer\s*name$/i, /\bcustomer\s*(full\s*)?name\b/i, /^subscriber\s*name$/i, /^account\s*name$/i, /^end\s*user$/i],
  customerEmail: [/^customer\s*email$/i, /\bemail\b/i, /\be-?mail\s*address\b/i],
  customerPhone: [/^customer\s*phone$/i, /\bphone\b/i, /\bmobile\b/i, /\bcontact\s*number\b/i, /\btelephone\b/i],
  serviceAddress: [/^service\s*address$/i, /\bservice\s*(address|location)\b/i, /\binstall(ation)?\s*address\b/i, /^address$/i, /\bstreet\s*address\b/i],
  carrier: [/^carrier$/i, /\bcarrier\b/i, /\bprovider\b/i, /\bvendor\b/i, /\bnetwork\b/i],
  productSold: [/^product$/i, /\bproduct\s*(sold|name|type)?\b/i, /\bpackage\b/i, /\bplan\s*name\b/i, /\boffer\b/i, /\bservice\s*type\b/i],
  program: [/^program$/i, /\bprogram\s*(name)?\b/i, /\bcampaign\b/i, /\bchannel\b/i],
  repExternalName: [/^rep\s*name$/i, /\b(sales)?\s*rep\s*name\b/i, /\bagent\s*name\b/i, /\bsalesperson\b/i, /\bseller\b/i, /\bsubmitted\s*by\b/i],
  repExternalId: [/^rep\s*(id|#|number)$/i, /\b(sales)?\s*rep\s*(id|#|number)\b/i, /\bagent\s*(id|#)\b/i, /\bseller\s*id\b/i],
  managerExternalName: [/^manager$/i, /\bmanager\s*(name)?\b/i, /\bteam\s*(name|lead)\b/i, /\bsupervisor\b/i, /\boffice\b/i, /\bdealer\b/i],
  saleDate: [/^sale\s*date$/i, /\bsale\s*date\b/i, /\bsold\s*(on|date)\b/i, /\border\s*date\b/i],
  submittedDate: [/^submitted?\s*date$/i, /\bsubmit(ted)?\s*(date|on)\b/i, /\bdate\s*submitted\b/i, /\bcreated\s*date\b/i],
  installScheduledAt: [/scheduled?\s*install/i, /install\w*\s*scheduled?/i, /\bappointment\s*(date|time)?\b/i, /\bappt\s*(date|time)?\b/i, /\bdispatch\s*date\b/i, /\bscheduled?\s*(date|time)\b/i],
  installDate: [/^install(ed|ation)?\s*date$/i, /\bdate\s*installed\b/i, /\binstall(ed|ation)?\s*(date|completed)\b/i, /\bactivation\s*date\b/i, /\bcompletion\s*date\b/i],
  cancellationDate: [/\bcancel\w*\s*date\b/i, /\bdate\s*cancel\w*\b/i, /\bdisconnect\s*date\b/i],
  sourceStatus: [/^order\s*status$/i, /^status$/i, /\border\s*status\b/i, /\bcurrent\s*status\b/i, /\bstage\b/i, /\bdisposition\b/i],
  failureReason: [/\bfail\w*\s*reason\b/i, /\breason\b/i, /\bcancel\w*\s*reason\b/i, /\bstatus\s*reason\b/i, /\bnotes?\b/i, /\bjeopardy\b/i],
  requiredCustomerAction: [/\bcustomer\s*action\b/i, /\baction\s*(required|needed)\b/i, /\bnext\s*step\b/i, /\bpending\s*action\b/i],
  sourceLastUpdatedAt: [/\blast\s*(modified|updated)\b/i, /\bupdated\s*(date|at)\b/i, /\bmodified\s*(date|at)\b/i],
  sourceRowId: [/^row\s*(id|#)$/i, /\brecord\s*id\b/i, /^id$/i, /\bsalesforce\s*id\b/i],
};

/**
 * Propose a mapping from the report's real headers.
 *
 * Every header binds to at most ONE field and every field takes at most ONE
 * header. Passes run by hint specificity so an exact-anchor pattern claims its
 * header before a looser one in another field can: with columns "Install Date"
 * and "Scheduled Install Date" present, the anchored `^install date$` hint wins
 * the first, and installScheduledAt is left free to take the second.
 */
export function suggestOrderMapping(columns: readonly string[]): Partial<Record<MappableOrderField, string>> {
  const out: Partial<Record<MappableOrderField, string>> = {};
  const takenHeaders = new Set<string>();
  const maxHints = Math.max(...MAPPABLE_ORDER_FIELDS.map((f) => HEADER_HINTS[f].length));

  for (let rank = 0; rank < maxHints; rank += 1) {
    for (const field of MAPPABLE_ORDER_FIELDS) {
      if (out[field]) continue;
      const pattern = HEADER_HINTS[field][rank];
      if (!pattern) continue;
      const header = columns.find((c) => !takenHeaders.has(c) && pattern.test(String(c).trim()));
      if (header) {
        out[field] = header;
        takenHeaders.add(header);
      }
    }
  }
  return out;
}

// ── 2. VALIDATE ──────────────────────────────────────────────────────────────

/** How many sample rows a preview normalizes. Enough to catch a bad date
 *  format or an unmapped status; small enough that validation is instant and
 *  that a preview response is never a bulk PII export. */
export const MAPPING_SAMPLE_ROWS = 25;

/** Below this share of parseable dates in a bound date column, the column is
 *  almost certainly not a date - refusing it is what stops "days stalled" from
 *  being computed off an account number. */
const MIN_DATE_PARSE_RATE = 0.6;
/** Same idea for phone and email columns, but a WARNING rather than an error:
 *  a genuinely sparse contact column is normal, and messaging is gated
 *  per-row anyway. */
const MIN_CONTACT_VALID_RATE = 0.5;

const DATE_FIELDS: readonly MappableOrderField[] = [
  "saleDate", "submittedDate", "installScheduledAt", "installDate",
  "cancellationDate", "sourceLastUpdatedAt",
];

/**
 * Say precisely why a mapping cannot be used, and show what it would produce.
 *
 * Errors block saving and importing. Warnings do not: they are the cases where
 * the mapping is usable but an admin should know what they are giving up -
 * address-only matching, an unmapped status, a sparse phone column.
 */
export function validateOrderColumnMapping(
  mapping: OrderColumnMapping,
  sampleRows: readonly Record<string, unknown>[],
  organizationId: number,
  sha256: Sha256,
): MappingValidationResult {
  const issues: MappingValidationIssue[] = [];
  const bound = (f: MappableOrderField) => mapping.columns[f];
  const rows = sampleRows.slice(0, MAPPING_SAMPLE_ROWS);

  // A header bound to a column the report does not have is the single most
  // common failure after a report is edited, and it must not surface as
  // "everything is empty" three screens later.
  const headers = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) headers.add(key);
  if (headers.size > 0) {
    for (const field of MAPPABLE_ORDER_FIELDS) {
      const header = bound(field);
      if (header && !headers.has(header)) {
        issues.push({
          severity: "error", field, code: "COLUMN_NOT_IN_REPORT",
          message: `${ORDER_FIELD_LABELS[field]} is mapped to "${header}", which is not a column in this file.`,
        });
      }
    }
  }

  // Identity. Without one of these the pipeline can only guess, and a guess
  // becomes an automated message to somebody who is not our customer.
  const hasIdentity = IDENTITY_ORDER_FIELDS.some((f) => bound(f));
  if (!hasIdentity) {
    issues.push({
      severity: "error", field: null, code: "NO_STABLE_IDENTITY",
      message: `Map at least one of ${IDENTITY_ORDER_FIELDS.map((f) => ORDER_FIELD_LABELS[f]).join(", ")}. Without a stable identity an order cannot be matched or updated on a later import.`,
    });
  }

  if (!bound("sourceStatus")) {
    issues.push({
      severity: "error", field: "sourceStatus", code: "NO_STATUS",
      message: "Map the order status column. Every recovery rule reads it.",
    });
  }

  if (!bound("serviceAddress")) {
    issues.push({
      severity: "warning", field: "serviceAddress", code: "NO_ADDRESS",
      message: "Without a service address, orders can only be matched by ID and the recovery queue cannot show a location.",
    });
  }

  if (!bound("submittedDate") && !bound("saleDate")) {
    issues.push({
      severity: "warning", field: "submittedDate", code: "NO_SUBMITTED_DATE",
      message: "Without a submitted or sale date, stale-order detection cannot run for these rows.",
    });
  }

  if (!bound("repExternalName") && !bound("repExternalId")) {
    issues.push({
      severity: "warning", field: "repExternalName", code: "NO_REP",
      message: "Without a rep column, recovery cases cannot be routed back to the rep who sold the order.",
    });
  }

  if (hasIdentity && !bound("externalOrderId") && !bound("externalTransactionId")) {
    issues.push({
      severity: "warning", field: "customerAccountNumber", code: "ACCOUNT_ONLY_IDENTITY",
      message: "Account number is the only identity mapped. It is stable enough to update an order, but order or transaction ID matches internal sales far more reliably.",
    });
  }

  // Column-shape checks against the real sample.
  for (const field of DATE_FIELDS) {
    const header = bound(field);
    if (!header || !headers.has(header)) continue;
    const present = rows.map((r) => r[header]).filter((v) => cleanText(v) != null);
    if (present.length === 0) continue;
    const parsed = present.filter((v) => parseVendorDate(v, mapping.timeZone) != null).length;
    if (parsed / present.length < MIN_DATE_PARSE_RATE) {
      const example = present.find((v) => parseVendorDate(v, mapping.timeZone) == null);
      issues.push({
        severity: "error", field, code: "UNPARSEABLE_DATES",
        message: `${ORDER_FIELD_LABELS[field]} is mapped to "${header}" but only ${parsed} of ${present.length} sample values read as a date${example != null ? ` (for example "${String(example).slice(0, 32)}")` : ""}.`,
      });
    }
  }

  // Contact-column shape. Deliberately reports RATES, never the values: an
  // admin validating a mapping does not need to see customer phone numbers,
  // and this response crosses the wire to a browser.
  const phoneHeader = bound("customerPhone");
  if (phoneHeader && headers.has(phoneHeader)) {
    const present = rows.map((r) => r[phoneHeader]).filter((v) => cleanText(v) != null);
    const valid = present.filter((v) => normalizePhoneE164(v) != null).length;
    if (present.length > 0 && valid / present.length < MIN_CONTACT_VALID_RATE) {
      issues.push({
        severity: "warning", field: "customerPhone", code: "PHONE_FORMAT",
        message: `Only ${valid} of ${present.length} sample values in "${phoneHeader}" read as a US phone number. Rows without a valid number can never be texted.`,
      });
    }
  }
  const emailHeader = bound("customerEmail");
  if (emailHeader && headers.has(emailHeader)) {
    const present = rows.map((r) => r[emailHeader]).filter((v) => cleanText(v) != null);
    const valid = present.filter((v) => isPlausibleEmail(v)).length;
    if (present.length > 0 && valid / present.length < MIN_CONTACT_VALID_RATE) {
      issues.push({
        severity: "warning", field: "customerEmail", code: "EMAIL_FORMAT",
        message: `Only ${valid} of ${present.length} sample values in "${emailHeader}" read as an email address. Rows without one can never be emailed.`,
      });
    }
  }

  // Status coverage. Every distinct source status in the sample, and what it
  // became - the one screen where an admin can see an `unknown` before it is
  // sitting in their dashboard.
  const statusHeader = bound("sourceStatus");
  const statusCounts = new Map<string, number>();
  if (statusHeader && headers.has(statusHeader)) {
    for (const row of sampleRows) {
      const text = cleanText(row[statusHeader]);
      if (!text) continue;
      statusCounts.set(text, (statusCounts.get(text) ?? 0) + 1);
    }
  }
  const statusPreview = [...statusCounts.entries()]
    .map(([sourceStatus, count]) => ({
      sourceStatus,
      normalized: resolveStatus(sourceStatus, mapping),
      count,
    }))
    .sort((a, b) => b.count - a.count);

  const unknownStatuses = statusPreview.filter((s) => s.normalized === "unknown");
  if (unknownStatuses.length > 0) {
    issues.push({
      severity: "warning", field: "sourceStatus", code: "UNMAPPED_STATUS",
      message: `${unknownStatuses.length} status value${unknownStatuses.length === 1 ? "" : "s"} did not map to a known state (${unknownStatuses.slice(0, 5).map((s) => `"${s.sourceStatus}"`).join(", ")}). These orders import and are visible, but no recovery rule will fire for them until you map them.`,
    });
  }

  // Overrides pointing at a status that no longer exists is a data error an
  // admin cannot see any other way.
  for (const [raw, target] of Object.entries(mapping.statusOverrides ?? {})) {
    if (!isOrderStatus(target)) {
      issues.push({
        severity: "error", field: "sourceStatus", code: "BAD_STATUS_OVERRIDE",
        message: `The override for "${raw}" points at "${String(target)}", which is not a known order state.`,
      });
    }
  }

  if (!mapping.timeZone) {
    issues.push({
      severity: "error", field: null, code: "NO_TIMEZONE",
      message: "Choose the timezone the report's dates are written in. Without it, an evening install appointment can land on the wrong day.",
    });
  }

  const sampleNormalized = rows.map((row, i) => withRowHash(applyOrderMapping({
    organizationId,
    mapping,
    row,
    sourceRowNumber: i + 1,
    sourceReportId: null,
    timeZone: mapping.timeZone || DEFAULT_REPORT_TIMEZONE,
  }), sha256));

  return {
    ok: !issues.some((i) => i.severity === "error"),
    issues,
    sampleNormalized,
    statusPreview,
  };
}

// ── 3. APPLY ─────────────────────────────────────────────────────────────────

/** The organization's own override wins over the pattern rules. That is the
 *  whole reason overrides exist: a provider phrase we read as `unknown` (or,
 *  worse, read wrongly) is corrected by the person who knows what it means. */
export function resolveStatus(sourceStatus: string | null, mapping: OrderColumnMapping): NormalizedOrderStatus {
  const text = cleanText(sourceStatus);
  if (!text) return "unknown";
  const override = (mapping.statusOverrides ?? {})[text.toLowerCase()]
    ?? (mapping.statusOverrides ?? {})[text];
  if (override && isOrderStatus(override)) return override;
  return normalizeOrderStatus(text);
}

/**
 * Turn one raw record into a normalized order.
 *
 * Returns the row WITHOUT its hash: the hash is SHA-256 over the canonical
 * string and this module is runtime-agnostic. Callers pair it with
 * withRowHash, which is the only place a hash is ever attached.
 */
export function applyOrderMapping(input: NormalizeOrderRowInput): Omit<NormalizedVendorOrder, "rawRowHash"> {
  const { mapping, row } = input;
  const tz = input.timeZone || mapping.timeZone || DEFAULT_REPORT_TIMEZONE;
  const raw = (field: MappableOrderField): unknown => {
    const header = mapping.columns[field];
    return header == null ? null : row[header];
  };
  const text = (field: MappableOrderField): string | null => cleanText(raw(field));
  const date = (field: MappableOrderField): Date | null => parseVendorDate(raw(field), tz);

  const sourceStatus = text("sourceStatus");
  const serviceAddress = text("serviceAddress");
  const submittedDate = date("submittedDate");
  const saleDate = date("saleDate");

  return {
    provider: "perfectvision_submitted_orders",
    organizationId: input.organizationId,

    sourceReportId: input.sourceReportId,
    sourceRowId: text("sourceRowId") ?? String(input.sourceRowNumber),
    sourceLastUpdatedAt: date("sourceLastUpdatedAt"),

    externalOrderId: text("externalOrderId"),
    externalTransactionId: text("externalTransactionId"),
    customerAccountNumber: text("customerAccountNumber"),

    customerName: text("customerName"),
    // Contact details are normalized HERE, at the boundary, so nothing
    // downstream ever has to decide whether a phone string is dialable. A value
    // that will not normalize becomes null rather than being carried forward as
    // a string somebody might later try to message.
    customerEmail: normalizeEmailOrNull(text("customerEmail")),
    customerPhone: normalizePhoneE164(text("customerPhone")),

    serviceAddress,
    normalizedServiceAddress: normalizeServiceAddress(serviceAddress),

    carrier: text("carrier") ?? mapping.defaults?.carrier ?? null,
    productSold: text("productSold") ?? mapping.defaults?.productSold ?? null,
    program: text("program") ?? mapping.defaults?.program ?? null,

    repExternalName: text("repExternalName"),
    repExternalId: text("repExternalId"),
    managerExternalName: text("managerExternalName"),

    saleDate,
    // A report that carries only one of the two dates still needs both to mean
    // something: stale-order detection measures from submitted, and the sale
    // date is what a rep recognises. Each falls back to the other rather than
    // leaving a hole that reads as "never submitted".
    submittedDate: submittedDate ?? saleDate,
    installScheduledAt: date("installScheduledAt"),
    installDate: date("installDate"),
    cancellationDate: date("cancellationDate"),

    sourceStatus,
    normalizedStatus: resolveStatus(sourceStatus, mapping),
    failureReason: text("failureReason"),
    requiredCustomerAction: text("requiredCustomerAction"),

    // The whole source record, kept verbatim. This is what answers "what did
    // the report actually say" in six months, and it is exactly why the column
    // it lands in is encrypted at rest.
    sourceRowPayload: { ...row },
  };
}

function normalizeEmailOrNull(value: string | null): string | null {
  if (!value) return null;
  const lower = value.trim().toLowerCase();
  return isPlausibleEmail(lower) ? lower : null;
}

/** Attach the content hash. The ONE place a rawRowHash is produced. */
export function withRowHash(
  row: Omit<NormalizedVendorOrder, "rawRowHash">,
  sha256: Sha256,
): NormalizedVendorOrder {
  return { ...row, rawRowHash: sha256(canonicalOrderRowString(row)) };
}

/** Identity triple used by the matcher and by the unique index. Normalized, so
 *  a provider reformatting its own ids between exports does not create a second
 *  order. */
export function orderIdentityKeys(row: Pick<NormalizedVendorOrder,
  "externalOrderId" | "externalTransactionId" | "customerAccountNumber">): {
  orderKey: string | null; transactionKey: string | null; accountKey: string | null;
} {
  return {
    orderKey: normalizeExternalId(row.externalOrderId),
    transactionKey: normalizeExternalId(row.externalTransactionId),
    accountKey: normalizeExternalId(row.customerAccountNumber),
  };
}
