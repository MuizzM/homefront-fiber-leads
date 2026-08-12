// ── External order-status sources - the contract ──────────────────────────────
// PURE and framework-free. The vocabulary every provider order feed speaks, so
// the pipeline (fetch -> parse -> normalize -> match -> record -> recover) never
// learns anything vendor-specific. PerfectVision's "Total Submitted Orders by
// Program" is the first feed; a carrier's own order API implements the same
// interface and changes nothing downstream.
//
// WHAT THIS PLANE IS, AND IS NOT.
//
// This is ORDER TRUTH: what the provider's order system says is happening to a
// submitted order right now. It is NOT commission truth and it is NOT a payout
// engine. shared/commissionSource.ts owns vendor MONEY; this file owns vendor
// LIFECYCLE. The two are linked only by external order / transaction identity,
// and the direction of authority is fixed:
//
//   • `installed` here advances the CRM funnel and closes a recovery case.
//   • `installed` here NEVER means a commission was earned or paid. Paid comes
//     from the Commission File plane, and nowhere else.
//
// Keeping them apart is the whole point. A submitted-orders report is a
// dealer-portal view that gets restated hourly; a commission file is an
// accounting document. Letting the first write money would give payroll a
// second, faster, less careful answer to a question it has already settled.
//
// IMMUTABILITY. A provider restates rows constantly - submitted in June,
// scheduled in July, missed in July, installed in August - and every one of
// those arrives as the SAME order id in a later export. `vendor_orders` holds
// the CURRENT state and `vendor_order_events` holds the history; a status change
// appends an event rather than overwriting one, so the timeline is the audit.

// ── The normalized status vocabulary ─────────────────────────────────────────

/** Every state a provider order row can normalize to. Ordered roughly by
 *  lifecycle so a UI can sort on it. `unknown` is an expected outcome, never an
 *  error - see normalizeOrderStatus. */
export const ORDER_STATUSES = [
  "submitted",
  "accepted",
  "pending_customer_action",
  "pending_documents",
  "install_scheduled",
  "installed",
  "failed_install",
  "missed_appointment",
  "canceled",
  "rejected",
  "on_hold",
  "unknown",
] as const;
export type NormalizedOrderStatus = (typeof ORDER_STATUSES)[number];

export function isOrderStatus(value: unknown): value is NormalizedOrderStatus {
  return typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);
}

/** The order reached the customer's home. The funnel advances; money does not. */
export const INSTALLED_STATUSES: readonly NormalizedOrderStatus[] = ["installed"];

/** Dead ends. No install will follow without a NEW order, so these never enter
 *  the recovery queue on their own - a canceled order does, but only under an
 *  explicit admin policy that says its cancellation reason is recoverable. */
export const TERMINAL_STATUSES: readonly NormalizedOrderStatus[] = ["canceled", "rejected"];

/** In flight and healthy: the provider is working the order and nobody is
 *  waiting on us. These become recovery candidates only by going STALE. */
export const IN_FLIGHT_STATUSES: readonly NormalizedOrderStatus[] = [
  "submitted", "accepted", "install_scheduled",
];

/** Something is wrong RIGHT NOW and a human can fix it. These are the states
 *  the recovery engine acts on immediately rather than after a stall window. */
export const ATTENTION_STATUSES: readonly NormalizedOrderStatus[] = [
  "pending_customer_action", "pending_documents", "failed_install",
  "missed_appointment", "on_hold",
];

export function isTerminalOrderStatus(status: NormalizedOrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isInstalledOrderStatus(status: NormalizedOrderStatus): boolean {
  return INSTALLED_STATUSES.includes(status);
}

/** Where a status sits in the lifecycle, for ordering and for deciding whether
 *  a restatement is forward progress or a regression. Higher = further along.
 *  `unknown` deliberately sorts BELOW submitted: an unrecognised status must
 *  never look like progress. */
export const ORDER_STATUS_RANK: Readonly<Record<NormalizedOrderStatus, number>> = {
  unknown: 0,
  submitted: 10,
  accepted: 20,
  pending_documents: 25,
  pending_customer_action: 26,
  on_hold: 27,
  install_scheduled: 30,
  missed_appointment: 31,
  failed_install: 32,
  installed: 90,
  rejected: 95,
  canceled: 96,
};

// ── Status normalization ─────────────────────────────────────────────────────
//
// Providers write status in prose, in whatever casing the report author used,
// and they change the wording between report versions. The mapping below is
// deliberately CONSERVATIVE and ordered most-specific-first:
//
//   • Anything unrecognised becomes `unknown`, never a guess. Unknown rows are
//     imported, counted, and shown for review - they simply never trigger an
//     automatic action. Guessing "installed" from an unfamiliar phrase would
//     close a recovery case on an order that never got installed.
//   • Failure states are matched BEFORE success states, because provider phrases
//     routinely contain both words: "install failed - reschedule required" must
//     never read as `installed`, and "canceled after install scheduled" must
//     never read as `install_scheduled`.
//   • Scheduling is matched before plain "install", for the same reason.

interface StatusRule { status: NormalizedOrderStatus; patterns: readonly RegExp[] }

/** Order matters. First match wins. */
const STATUS_RULES: readonly StatusRule[] = [
  // Dead ends first - their phrasing almost always contains a healthy word too.
  { status: "canceled", patterns: [
    /cancel/i, /\bcxl\b/i, /\bcanx\b/i, /withdraw/i, /rescind/i,
    /customer\s*(cancel|declin)/i, /disconnect/i, /\bdisco\b/i,
  ] },
  { status: "rejected", patterns: [
    /reject/i, /\bdenied\b/i, /\bdecline[sd]?\b/i, /not\s*qualified/i,
    /disqualif/i, /credit\s*(fail|decline)/i, /\bineligible\b/i, /\bvoid/i,
  ] },
  // Failure and no-show, before any "install" or "scheduled" rule can claim them.
  { status: "missed_appointment", patterns: [
    /no\s*-?\s*show/i, /missed\s*(install|appt|appointment|visit)/i,
    /customer\s*(not\s*home|unavailable|absent)/i, /\bnot\s*home\b/i,
    /tech\s*(no\s*-?\s*show|missed)/i, /appointment\s*missed/i,
  ] },
  { status: "failed_install", patterns: [
    /install\w*\s*(fail|unsuccessful|incomplete|aborted|not\s*complete)/i,
    /fail\w*\s*install/i, /\bnot\s*installed\b/i, /install\s*issue/i,
    /\bjeopardy\b/i, /construction\s*(required|needed)/i,
    /\bfacilit\w*\s*(issue|required|needed)\b/i, /unable\s*to\s*(install|complete)/i,
  ] },
  // Waiting on somebody. Documents before the broader customer-action rule, so
  // "customer must upload ID" reads as documents rather than generic action.
  { status: "pending_documents", patterns: [
    /\bdocument/i, /\bdocs?\b/i, /\bpaperwork\b/i, /missing\s*(info|information|id|proof)/i,
    /\bcontract\s*(missing|required|needed|pending)/i, /\bsignature\b/i, /\bunsigned\b/i,
    /\bid\s*verification\b/i, /proof\s*of\s*(address|residence|income)/i,
  ] },
  { status: "pending_customer_action", patterns: [
    /customer\s*action/i, /action\s*(required|needed)/i, /awaiting\s*customer/i,
    /pending\s*customer/i, /customer\s*(response|callback|confirm)/i,
    /needs?\s*customer/i, /customer\s*to\s*(call|contact|confirm)/i,
    /\bunreachable\b/i, /\bno\s*contact\b/i,
  ] },
  { status: "on_hold", patterns: [
    /\bon\s*hold\b/i, /\bheld\b/i, /\bhold\b/i, /\bsuspend/i, /\bpaused?\b/i,
    /\bescalat/i, /\bin\s*review\b/i, /under\s*review/i, /\bpending\s*review\b/i,
  ] },
  // Healthy states, most specific first.
  { status: "installed", patterns: [
    /\binstalled\b/i, /install\s*(complete|completed|done)/i, /\bactivated?\b/i,
    /\bservice\s*(active|live|turned\s*up)\b/i, /\bcompleted?\b/i, /\bfulfilled\b/i,
    /\bconnected\b/i,
  ] },
  { status: "install_scheduled", patterns: [
    /schedul/i, /\bappointment\b/i, /\bappt\b/i, /\bdispatch/i, /\bbooked\b/i,
    /install\s*date\s*set/i, /\bpending\s*install\b/i, /\bawaiting\s*install\b/i,
  ] },
  { status: "accepted", patterns: [
    /accept/i, /\bapproved?\b/i, /\bconfirmed\b/i, /\bqualified\b/i, /\bverified\b/i,
    /\bvalidated\b/i, /\bclean\b/i, /\bprocessed\b/i,
  ] },
  { status: "submitted", patterns: [
    /submit/i, /\bpending\b/i, /\bnew\b/i, /\bopen\b/i, /\bentered\b/i,
    /\border\s*(ed|placed|received)?\b/i, /\bin\s*progress\b/i, /\bworking\b/i,
  ] },
];

/**
 * Map a provider's status text onto the normalized vocabulary.
 *
 * Returns `unknown` for anything unrecognised, empty, or non-string. That is a
 * supported outcome, not a failure: the row still imports and still shows up
 * for an admin, it just drives no automatic action until someone maps it.
 */
export function normalizeOrderStatus(sourceStatus: string | null | undefined): NormalizedOrderStatus {
  if (typeof sourceStatus !== "string") return "unknown";
  const text = sourceStatus.trim();
  if (!text) return "unknown";
  // An exact match against our own vocabulary wins outright - this is what lets
  // a re-import of our own exported data round-trip losslessly.
  const exact = text.toLowerCase().replace(/[\s-]+/g, "_");
  if (isOrderStatus(exact)) return exact;
  for (const rule of STATUS_RULES) {
    if (rule.patterns.some((p) => p.test(text))) return rule.status;
  }
  return "unknown";
}

/** Human label for a normalized status. One source, so a dashboard, an export
 *  and an email never disagree about what a state is called. */
export const ORDER_STATUS_LABELS: Readonly<Record<NormalizedOrderStatus, string>> = {
  submitted: "Submitted",
  accepted: "Accepted",
  pending_customer_action: "Customer action needed",
  pending_documents: "Missing documents",
  install_scheduled: "Install scheduled",
  installed: "Installed",
  failed_install: "Failed install",
  missed_appointment: "Missed appointment",
  canceled: "Canceled",
  rejected: "Rejected",
  on_hold: "On hold",
  unknown: "Unrecognized",
};

// ── Date and time handling ───────────────────────────────────────────────────
//
// A report exported from a browser carries local dates with no offset, so a
// naive `new Date(text)` on a server running UTC silently shifts an evening
// install appointment onto the previous day. Every date here is resolved
// against an explicit report timezone instead:
//
//   • date-only values become UTC midnight of that calendar day, so "days
//     stalled" arithmetic is exact and never off by a timezone,
//   • date+time values with no offset are interpreted in the report timezone,
//   • values that already carry Z or +hh:mm are taken as given.

/** The timezone a report's naive timestamps are read in when an organization
 *  has not configured one. Matches tenants.commission_timezone's default. */
export const DEFAULT_REPORT_TIMEZONE = "America/New_York";

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * The UTC instant for a wall-clock time in a named zone.
 *
 * Intl gives us the zone's offset only for an instant we already have, so this
 * guesses (treat the wall clock as UTC), measures the error, corrects, and
 * measures once more. Two passes is enough for every real zone including the
 * ones with 30 and 45 minute offsets; the second pass exists for the hour
 * either side of a DST transition, where the first correction can land on the
 * far side of the jump.
 */
export function zonedWallClockToUtc(
  y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string,
): Date {
  let ms = Date.UTC(y, mo - 1, d, h, mi, s);
  for (let pass = 0; pass < 2; pass += 1) {
    const offset = zoneOffsetMs(ms, timeZone);
    const next = Date.UTC(y, mo - 1, d, h, mi, s) - offset;
    if (next === ms) break;
    ms = next;
  }
  return new Date(ms);
}

/** The zone's UTC offset in milliseconds at a given instant. Falls back to 0
 *  for an unknown zone name rather than throwing - a bad tenant setting must
 *  degrade to UTC, not fail an entire import. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = dtf.formatToParts(new Date(instantMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
    // Intl renders midnight as hour 24 in some engines; normalize it to 0.
    const hour = get("hour") % 24;
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
    return asUtc - instantMs;
  } catch {
    return 0;
  }
}

/** Excel/Sheets serial day numbers. Anything outside this band is a plain
 *  number that happens to sit in a date column, not a date - refusing it is how
 *  an account number in the wrong column stops becoming the year 1902. */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30); // Excel's 1900 leap-year bug baked in
const EXCEL_MIN_SERIAL = 20_000;  // 1954-10-03
const EXCEL_MAX_SERIAL = 80_000;  // 2119-01-27

/**
 * Parse whatever a provider report put in a date column.
 *
 * Handles ISO dates and datetimes (with or without an offset), US M/D/YYYY and
 * M/D/YY, D-Mon-YYYY, "YYYY-MM-DD HH:mm:ss", 12-hour clocks with AM/PM, and
 * Excel serial numbers. Returns null for anything else - a date the pipeline
 * cannot read is a validation error an admin gets to see, never a silent
 * epoch-zero that would make an order look 56 years stale.
 */
export function parseVendorDate(
  raw: unknown,
  timeZone: string = DEFAULT_REPORT_TIMEZONE,
): Date | null {
  if (raw == null) return null;
  if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? raw : null;

  if (typeof raw === "number" && Number.isFinite(raw)) return excelSerialToDate(raw);

  const text = String(raw).trim();
  if (!text) return null;

  // A bare number in a date column: Excel serial, or nothing.
  if (/^\d+(\.\d+)?$/.test(text)) return excelSerialToDate(Number(text));

  // Explicit offset or Z - the value already knows what instant it means.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const d = new Date(text.replace(" ", "T"));
    return Number.isFinite(d.getTime()) ? d : null;
  }

  // ISO date-only -> UTC midnight of that calendar day.
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (isoDate) return utcMidnight(+isoDate[1], +isoDate[2], +isoDate[3]);

  // ISO-ish datetime with no offset -> the report's timezone.
  const isoDateTime = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (isoDateTime) {
    return zonedWallClockToUtc(
      +isoDateTime[1], +isoDateTime[2], +isoDateTime[3],
      +isoDateTime[4], +isoDateTime[5], +(isoDateTime[6] ?? 0), timeZone,
    );
  }

  // US M/D/YYYY [time] - the shape a Salesforce report export uses.
  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(text);
  if (us) {
    const year = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    const month = Number(us[1]);
    const day = Number(us[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (us[4] == null) return utcMidnight(year, month, day);
    const hour = to24Hour(Number(us[4]), us[7]);
    if (hour == null) return null;
    return zonedWallClockToUtc(year, month, day, hour, Number(us[5]), Number(us[6] ?? 0), timeZone);
  }

  // D-Mon-YYYY / Mon D, YYYY.
  const dMon = /^(\d{1,2})[\s-]([A-Za-z]{3,})[\s-](\d{2}|\d{4})$/.exec(text);
  if (dMon) {
    const month = MONTHS[dMon[2].slice(0, 3).toLowerCase()];
    if (!month) return null;
    const year = dMon[3].length === 2 ? 2000 + Number(dMon[3]) : Number(dMon[3]);
    return utcMidnight(year, month, Number(dMon[1]));
  }
  const monD = /^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (monD) {
    const month = MONTHS[monD[1].slice(0, 3).toLowerCase()];
    if (!month) return null;
    return utcMidnight(Number(monD[3]), month, Number(monD[2]));
  }

  return null;
}

function to24Hour(hour: number, meridiem: string | undefined): number | null {
  if (!meridiem) return hour >= 0 && hour <= 23 ? hour : null;
  if (hour < 1 || hour > 12) return null;
  const pm = /p/i.test(meridiem);
  if (hour === 12) return pm ? 12 : 0;
  return pm ? hour + 12 : hour;
}

function utcMidnight(y: number, mo: number, d: number): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // Rejects 2026-02-31 and friends: Date.UTC rolls them forward silently.
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return back;
}

function excelSerialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial) || serial < EXCEL_MIN_SERIAL || serial > EXCEL_MAX_SERIAL) return null;
  return new Date(EXCEL_EPOCH_UTC + Math.round(serial * 86_400_000));
}

/** Storage form: the ISO instant, or null. Every date column in this plane is
 *  written through here so nothing ever stores a locale string. */
export function toIsoOrNull(value: Date | null | undefined): string | null {
  if (!value || !Number.isFinite(value.getTime())) return null;
  return value.toISOString();
}

/** The calendar day of an instant in a named zone, as YYYY-MM-DD. What a
 *  dashboard means by "installs scheduled today". */
export function localDayOf(value: Date, timeZone: string = DEFAULT_REPORT_TIMEZONE): string {
  try {
    const dtf = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    return dtf.format(value);
  } catch {
    return value.toISOString().slice(0, 10);
  }
}

/** Whole days between two instants, floored and never negative. The single
 *  definition of "days stalled" so the queue, the dashboard and an SMS all
 *  quote the same number. */
export function wholeDaysBetween(from: Date | null | undefined, to: Date): number {
  if (!from || !Number.isFinite(from.getTime())) return 0;
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

// ── Text and identity normalization ──────────────────────────────────────────

/** Collapse a source cell to trimmed text, or null. Empty, whitespace-only and
 *  the placeholder strings report builders emit all become null - so a column
 *  full of "N/A" never looks like a populated identity field. */
export function cleanText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (/^(n\/?a|none|null|undefined|-{1,3}|#n\/a)$/i.test(text)) return null;
  return text;
}

/** An external identity, comparable. Providers reformat their own ids between
 *  exports (leading zeros, dashes, spaces, casing), so identity is compared on
 *  this form while the raw string is kept for display. */
export function normalizeExternalId(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  const compact = text.replace(/[\s._-]+/g, "").toUpperCase();
  return compact || null;
}

/** Address identity for matching. Deliberately its own function rather than the
 *  field map's canonical key: a provider report carries a single free-text
 *  address line with no city/state/zip split, so the field map's premise key
 *  cannot be built from it. This is the weaker key that CAN be, and every
 *  address-based match rule is scored lower because of it. */
export function normalizeServiceAddress(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  const expanded = text
    .toUpperCase()
    .replace(/[.,#]/g, " ")
    .replace(/\b(STREET)\b/g, "ST")
    .replace(/\b(AVENUE|AVENU)\b/g, "AVE")
    .replace(/\b(ROAD)\b/g, "RD")
    .replace(/\b(DRIVE)\b/g, "DR")
    .replace(/\b(LANE)\b/g, "LN")
    .replace(/\b(COURT)\b/g, "CT")
    .replace(/\b(CIRCLE)\b/g, "CIR")
    .replace(/\b(BOULEVARD)\b/g, "BLVD")
    .replace(/\b(PLACE)\b/g, "PL")
    .replace(/\b(TERRACE)\b/g, "TER")
    .replace(/\b(PARKWAY)\b/g, "PKWY")
    .replace(/\b(HIGHWAY)\b/g, "HWY")
    .replace(/\b(NORTH)\b/g, "N").replace(/\b(SOUTH)\b/g, "S")
    .replace(/\b(EAST)\b/g, "E").replace(/\b(WEST)\b/g, "W")
    .replace(/\b(APARTMENT|APT|UNIT|SUITE|STE)\b/g, "UNIT")
    .replace(/\s+/g, " ")
    .trim();
  return expanded || null;
}

/** A person's name, comparable. Used only by the lowest-confidence match rule,
 *  which never auto-matches. */
export function normalizePersonName(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  return text.toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim() || null;
}

// ── The normalized order row ─────────────────────────────────────────────────

/**
 * One provider order, after column mapping and normalization.
 *
 * Every field is optional except the ones the pipeline cannot function without,
 * because a provider report is not a schema we control. `organizationId` is the
 * tenant id this repo scopes everything by (`tenant_id` in SQL); the name here
 * follows the integration contract.
 */
export interface NormalizedVendorOrder {
  provider: "perfectvision_submitted_orders";
  organizationId: number;

  /** The provider's own report identity, when the export carries one. */
  sourceReportId?: string | null;
  /** The provider's own row identity within the report, when present. */
  sourceRowId?: string | null;
  /** When the PROVIDER last touched this record, not when we imported it. */
  sourceLastUpdatedAt?: Date | null;

  externalOrderId?: string | null;
  externalTransactionId?: string | null;
  customerAccountNumber?: string | null;

  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;

  serviceAddress?: string | null;
  normalizedServiceAddress?: string | null;

  carrier?: string | null;
  productSold?: string | null;
  program?: string | null;

  repExternalName?: string | null;
  repExternalId?: string | null;
  managerExternalName?: string | null;

  saleDate?: Date | null;
  submittedDate?: Date | null;
  installScheduledAt?: Date | null;
  installDate?: Date | null;
  cancellationDate?: Date | null;

  sourceStatus?: string | null;
  normalizedStatus: NormalizedOrderStatus;
  failureReason?: string | null;
  requiredCustomerAction?: string | null;

  /** SHA-256 of canonicalOrderRowString(row), computed server-side. */
  rawRowHash: string;
  /** The source record as parsed, before mapping. Persisted ENCRYPTED - it is
   *  the only thing that can answer "what did the report actually say" months
   *  later, and it is full of customer PII. */
  sourceRowPayload: Record<string, unknown>;
}

/** True when the row carries at least one identity a machine can match on
 *  without guessing. The mapping validator and the matcher both ask this, so
 *  "we will not import a report we cannot match" is one rule, not two. */
export function hasStableIdentity(
  row: Pick<NormalizedVendorOrder, "externalOrderId" | "externalTransactionId" | "customerAccountNumber">,
): boolean {
  return Boolean(
    normalizeExternalId(row.externalOrderId) ??
    normalizeExternalId(row.externalTransactionId) ??
    normalizeExternalId(row.customerAccountNumber),
  );
}

// ── Row identity ─────────────────────────────────────────────────────────────

/** The fields that make a row's CONTENT identity. Deliberately excludes the
 *  organization and provider (they scope the hash elsewhere) and the raw
 *  payload (a provider reordering its columns is not a change). */
const HASH_FIELDS = [
  "sourceReportId", "sourceRowId",
  "externalOrderId", "externalTransactionId", "customerAccountNumber",
  "customerName", "customerEmail", "customerPhone",
  "normalizedServiceAddress",
  "carrier", "productSold", "program",
  "repExternalName", "repExternalId", "managerExternalName",
  "saleDate", "submittedDate", "installScheduledAt", "installDate", "cancellationDate",
  "normalizedStatus", "sourceStatus", "failureReason", "requiredCustomerAction",
] as const;

/**
 * The exact string a row's SHA-256 is taken over.
 *
 * Kept here, pure and unit-tested, rather than inline at the hashing call site:
 * the hash is the change-detection key, so if its input ever changes shape then
 * every previously imported row looks changed at once and the whole history
 * fills with phantom events. Dates are reduced to their ISO instant so a
 * provider re-exporting "8/1/2026" as "2026-08-01" is not a change.
 */
export function canonicalOrderRowString(
  row: Omit<NormalizedVendorOrder, "rawRowHash" | "sourceRowPayload"> & { rawRowHash?: string },
): string {
  const parts: string[] = [];
  for (const field of HASH_FIELDS) {
    const value = (row as Record<string, unknown>)[field];
    if (value == null) { parts.push(`${field}=`); continue; }
    if (value instanceof Date) { parts.push(`${field}=${toIsoOrNull(value) ?? ""}`); continue; }
    parts.push(`${field}=${String(value)}`);
  }
  return parts.join("");
}

// ── The provider interface ───────────────────────────────────────────────────

/** A stored, server-side-only connection to a provider. Secrets never appear on
 *  this object in a client-bound response - see redactConnection. */
export interface IntegrationConnection {
  id: number;
  organizationId: number;
  provider: string;
  /** Human label an admin gave the connection. */
  label: string;
  /** Where the report lives. Recorded for the runbook; never fetched while the
   *  sync flag is off. */
  sourceUrl: string | null;
  /** "manual_upload" until an authorized automated retrieval exists. */
  mode: "manual_upload" | "scheduled_export" | "sftp" | "api";
  /** Opaque, encrypted at rest, decrypted only inside the worker process. */
  encryptedCredentials: string | null;
  enabled: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Safe to show an admin. Never contains a credential, cookie, token, header,
   *  or a fragment of the provider's HTML. */
  message: string;
  checkedAt: Date;
  /** What the provider can actually do right now, given flags and config. */
  capabilities: {
    canFetchReport: boolean;
    canParseUpload: boolean;
  };
}

export interface FetchOrderReportInput {
  connection: IntegrationConnection;
  periodStart: Date | null;
  periodEnd: Date | null;
  /** Set by the caller when an operator explicitly asked for a fetch. Automated
   *  callers leave it false so the provider's flag check is the only gate. */
  requestedByUserId: number | null;
}

export interface RawOrderReport {
  /** "csv" | "xlsx". What arrived, sniffed rather than trusted. */
  format: "csv" | "xlsx";
  /** File bytes. Held in memory only for the length of a parse. */
  content: Buffer;
  fileName: string;
  sourceReportId: string | null;
  retrievedAt: Date;
}

export interface ParseOrderReportInput {
  report: RawOrderReport;
  /** Rows to read at most. Bounds a hostile or accidental 2 GB upload. */
  maxRows: number;
}

export interface ParsedOrderReport {
  /** Header labels exactly as the report wrote them, in column order. */
  columns: string[];
  /** Every data row as a header-keyed record. Values are strings or numbers -
   *  never Dates, because interpretation belongs to normalizeOrderRow. */
  rows: Record<string, unknown>[];
  /** Rows the reader could not tokenize. Counted, never silently dropped. */
  skippedRows: number;
  truncated: boolean;
}

export interface NormalizeOrderRowInput {
  organizationId: number;
  mapping: OrderColumnMapping;
  row: Record<string, unknown>;
  sourceRowNumber: number;
  sourceReportId: string | null;
  /** Zone the report's naive timestamps are read in. */
  timeZone: string;
}

// ── Column mapping ───────────────────────────────────────────────────────────

/** Every normalized field an admin can bind a source column to. Deliberately
 *  NOT derived from NormalizedVendorOrder's keys: a field only becomes mappable
 *  when the pipeline knows what to do with it, and that is a decision, not a
 *  consequence of a type. */
export const MAPPABLE_ORDER_FIELDS = [
  "externalOrderId",
  "externalTransactionId",
  "customerAccountNumber",
  "customerName",
  "customerEmail",
  "customerPhone",
  "serviceAddress",
  "carrier",
  "productSold",
  "program",
  "repExternalName",
  "repExternalId",
  "managerExternalName",
  "saleDate",
  "submittedDate",
  "installScheduledAt",
  "installDate",
  "cancellationDate",
  "sourceStatus",
  "failureReason",
  "requiredCustomerAction",
  "sourceLastUpdatedAt",
  "sourceRowId",
] as const;
export type MappableOrderField = (typeof MAPPABLE_ORDER_FIELDS)[number];

/** Admin-facing label per field. Kept beside the field list so the mapping UI
 *  and the validation messages cannot drift apart. */
export const ORDER_FIELD_LABELS: Readonly<Record<MappableOrderField, string>> = {
  externalOrderId: "Order ID",
  externalTransactionId: "Transaction ID",
  customerAccountNumber: "Customer account number",
  customerName: "Customer name",
  customerEmail: "Customer email",
  customerPhone: "Customer phone",
  serviceAddress: "Service address",
  carrier: "Carrier",
  productSold: "Product sold",
  program: "Program",
  repExternalName: "Rep name",
  repExternalId: "Rep ID",
  managerExternalName: "Manager or team name",
  saleDate: "Sale date",
  submittedDate: "Submitted date",
  installScheduledAt: "Install scheduled date",
  installDate: "Install date",
  cancellationDate: "Cancellation date",
  sourceStatus: "Order status",
  failureReason: "Failure or cancellation reason",
  requiredCustomerAction: "Required customer action",
  sourceLastUpdatedAt: "Source last updated",
  sourceRowId: "Source row ID",
};

/** The three fields that can identify an order without guessing. At least one
 *  must be bound before a mapping may be saved. */
export const IDENTITY_ORDER_FIELDS: readonly MappableOrderField[] = [
  "externalOrderId", "externalTransactionId", "customerAccountNumber",
];

/**
 * A saved, per-organization, per-provider mapping.
 *
 * `columns` binds a normalized field to a SOURCE HEADER LABEL, not a column
 * index: a report that gains a column at the front would otherwise silently
 * re-point every field one place to the left.
 *
 * `statusOverrides` is the escape hatch for a provider phrase the normalizer
 * reads as `unknown`. It is per-organization and explicit, because the right
 * answer to "what does PROJECT HOLD mean" is a human's, not a regex's.
 */
export interface OrderColumnMapping {
  version: number;
  columns: Partial<Record<MappableOrderField, string>>;
  /** Raw source status text (compared case-insensitively, trimmed) -> our
   *  vocabulary. Wins over the pattern rules. */
  statusOverrides: Record<string, NormalizedOrderStatus>;
  /** Zone the report's naive timestamps are read in. */
  timeZone: string;
  /** Constant applied to every row when the report does not carry the column -
   *  a program-specific export is often single-carrier with no carrier column. */
  defaults: {
    carrier?: string | null;
    program?: string | null;
    productSold?: string | null;
  };
}

export function emptyOrderColumnMapping(timeZone = DEFAULT_REPORT_TIMEZONE): OrderColumnMapping {
  return { version: 1, columns: {}, statusOverrides: {}, timeZone, defaults: {} };
}

export interface MappingValidationIssue {
  /** "error" blocks saving and importing. "warning" is allowed through, but is
   *  shown to the admin and recorded on the import. */
  severity: "error" | "warning";
  field: MappableOrderField | null;
  code: string;
  message: string;
}

export interface MappingValidationResult {
  ok: boolean;
  issues: MappingValidationIssue[];
  /** Rows from the sample that normalized cleanly, for the preview table. PII
   *  is masked by the caller before this crosses the wire. */
  sampleNormalized: NormalizedVendorOrder[];
  /** Distinct source status strings in the sample and what each normalized to,
   *  so an admin can see every `unknown` before importing rather than after. */
  statusPreview: { sourceStatus: string; normalized: NormalizedOrderStatus; count: number }[];
}

/**
 * What every order-status source must implement.
 *
 * `fetchOrderReport` exists on the interface because a provider that HAS an
 * authorized export endpoint should use it. PerfectVision's implementation
 * refuses while the sync flag is off, which is the default and stays the
 * default until the vendor authorizes retrieval in writing.
 */
export interface OrderStatusSourceProvider {
  providerName: string;

  testConnection(connection: IntegrationConnection): Promise<ConnectionTestResult>;

  fetchOrderReport(input: FetchOrderReportInput): Promise<RawOrderReport[]>;

  parseOrderReport(input: ParseOrderReportInput): Promise<ParsedOrderReport>;

  normalizeOrderRow(input: NormalizeOrderRowInput): Promise<NormalizedVendorOrder>;

  normalizeOrderStatus(sourceStatus: string | null): NormalizedOrderStatus;

  validateColumnMapping(
    mapping: OrderColumnMapping,
    sampleRows: Record<string, unknown>[],
  ): MappingValidationResult;
}

/** The client-safe view of a connection. The only shape a browser ever sees. */
export function redactConnection(c: IntegrationConnection): Omit<IntegrationConnection, "encryptedCredentials"> & {
  hasCredentials: boolean;
} {
  const { encryptedCredentials, ...rest } = c;
  return { ...rest, hasCredentials: Boolean(encryptedCredentials) };
}
