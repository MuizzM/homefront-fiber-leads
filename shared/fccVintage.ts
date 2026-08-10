// ── FCC Broadband Data Collection vintages - the "as of when?" model ─────────
//
// Every claim this system makes about WHEN an address gained Kinetic fiber is
// bounded by the as-of date of the filing it came from. A BDC vintage is not
// "the data as of when we downloaded it"; it is a snapshot of what providers
// reported for one specific date, published roughly seven months later.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE
// You cannot prove a build happened during year Y from a filing whose as-of
// date is before Y ended. As of August 2026 the newest published filing is
// December 31, 2025 - so NO FCC file in existence can attest to a 2026 build.
// The June-2026 filing is expected around November 2026. Every surface that
// wants to say "2026 build" has to route through vintageCanAttestYear() and
// get told no, rather than quietly diffing the two newest files it can find
// and labelling the result with the current year.
//
// The second rule: a vintage diff yields an INTERVAL, never a date. A
// D24-to-D25 addition happened somewhere in the twelve months between those
// two as-of dates. windowQuarter() returns a quarter only when the whole
// interval fits inside one, which for a biannual filing diff it never does.
// That is deliberate - see shared/kineticBuild2026.ts for how a real quarter
// gets proven (a dated non-fiber observation and a dated fiber observation
// that land in the same quarter).

/** Filing codes as they appear in BDC file names: J = June 30, D = December 31. */
export type FccVintageCode =
  | "J22" | "D22" | "J23" | "D23" | "J24" | "D24" | "J25" | "D25" | "J26" | "D26" | "J27" | "D27";

export interface FccVintage {
  code: FccVintageCode;
  /** The last day the filing describes. NOT the publication date. */
  asOf: string;
  year: number;
  /** 1 = the June 30 filing, 2 = the December 31 filing. */
  half: 1 | 2;
  /** Human label for operator-facing surfaces. */
  label: string;
}

const VINTAGE_RE = /^([JD])(\d{2})$/;

/** BDC publishes roughly seven months after the as-of date. Used only to tell
 *  an operator when a missing vintage is expected - never to infer data. */
export const BDC_PUBLICATION_LAG_MONTHS = 7;

/** Vintages confirmed present on broadbandmap.fcc.gov. Verified 2026-08-10
 *  against /nbm/map/api/published/filing. This list is a convenience for
 *  operator messaging; the importer always re-reads the live filing index
 *  rather than trusting it. */
export const KNOWN_PUBLISHED_VINTAGES: readonly FccVintageCode[] = [
  "J22", "D22", "J23", "D23", "J24", "D24", "J25", "D25",
] as const;

export function parseVintageCode(raw: unknown): FccVintageCode | null {
  if (typeof raw !== "string") return null;
  const match = VINTAGE_RE.exec(raw.trim().toUpperCase());
  if (!match) return null;
  const [, half, yy] = match;
  const year = 2000 + Number(yy);
  // Guard rails: BDC began with June 2022, and a code more than two years past
  // the current decade boundary is far more likely a typo than a real filing.
  if (year < 2022 || year > 2027) return null;
  return `${half}${yy}` as FccVintageCode;
}

export function vintageOf(code: FccVintageCode): FccVintage {
  const match = VINTAGE_RE.exec(code)!;
  const half = match[1] === "J" ? 1 : 2;
  const year = 2000 + Number(match[2]);
  return {
    code,
    asOf: half === 1 ? `${year}-06-30` : `${year}-12-31`,
    year,
    half: half as 1 | 2,
    label: half === 1 ? `June 30, ${year}` : `December 31, ${year}`,
  };
}

/** Milliseconds at the END of the as-of day (23:59:59.999 UTC). A filing
 *  describes the state of the world through the close of its as-of date, so
 *  interval arithmetic has to include that whole day. */
export function vintageAsOfMs(code: FccVintageCode): number {
  return Date.parse(`${vintageOf(code).asOf}T23:59:59.999Z`);
}

/** Chronological ordering. Negative when a is older than b. */
export function compareVintages(a: FccVintageCode, b: FccVintageCode): number {
  return vintageAsOfMs(a) - vintageAsOfMs(b);
}

export function sortVintages(codes: readonly FccVintageCode[]): FccVintageCode[] {
  return [...codes].sort(compareVintages);
}

/**
 * THE GATE. Can a diff ending at `current` attest that a build happened
 * DURING calendar year `year`?
 *
 * Two conditions, both necessary:
 *   1. `current` must describe a date on or after the end of `year`. A filing
 *      as of 2025-12-31 says nothing about 2026, no matter how recently it was
 *      published or revised.
 *   2. `baseline` must describe a date on or before the last day of `year - 1`,
 *      so "did not have it before `year`" is actually established.
 *
 * Anything else is a diff over a window that straddles the year boundary, and
 * an addition inside it cannot be pinned to `year`.
 */
export function vintageCanAttestYear(
  baseline: FccVintageCode,
  current: FccVintageCode,
  year: number,
): boolean {
  const yearEndMs = Date.parse(`${year}-12-31T23:59:59.999Z`);
  const priorYearEndMs = Date.parse(`${year - 1}-12-31T23:59:59.999Z`);
  return vintageAsOfMs(current) >= yearEndMs && vintageAsOfMs(baseline) <= priorYearEndMs;
}

/** The newest published vintage that could attest to `year`, or null when none
 *  exists yet. Drives the honest empty state on the 2026 layer. */
export function attestingVintageFor(
  year: number,
  published: readonly FccVintageCode[] = KNOWN_PUBLISHED_VINTAGES,
): FccVintageCode | null {
  const yearEndMs = Date.parse(`${year}-12-31T23:59:59.999Z`);
  const eligible = sortVintages(published).filter((code) => vintageAsOfMs(code) >= yearEndMs);
  return eligible.length ? eligible[eligible.length - 1] : null;
}

export interface YearCoverage {
  /** A diff among these vintages proves builds inside `year` (possibly only
   *  part of it). This is the per-address question. */
  partial: boolean;
  /** The vintages hold the WHOLE year: a baseline on or before Dec 31 of
   *  year-1 and a current on or after Dec 31 of year. The completeness
   *  question - "is this list of 2026 builds exhaustive?" */
  complete: boolean;
  /** As-of date the year is covered through, or null when nothing covers it.
   *  A J26 holding covers 2026 through 2026-06-30 and no further. */
  coveredThrough: string | null;
}

/**
 * What a set of imported vintages can say about one calendar year.
 *
 * Splitting partial from complete matters and was originally missed: a
 * D25-to-J26 diff proves real H1-2026 builds while saying nothing about H2, so
 * treating "not complete" as "cannot report" would throw away the first six
 * months of genuine data. The classifier asks the partial question per
 * address; the operator UI shows both.
 */
export function yearCoverage(
  vintages: readonly FccVintageCode[],
  year: number,
): YearCoverage {
  const sorted = sortVintages(vintages);
  const yearStartMs = Date.parse(`${year}-01-01T00:00:00.000Z`);
  const yearEndMs = Date.parse(`${year}-12-31T23:59:59.999Z`);
  let partial = false;
  let coveredThroughMs: number | null = null;

  // Adjacent pairs only: those are the diffs the importer actually computes
  // (each vintage against the one before it).
  for (let i = 1; i < sorted.length; i++) {
    const window = additionWindow(sorted[i - 1], sorted[i]);
    if (windowYear(window) !== year) continue;
    partial = true;
    coveredThroughMs = Math.max(coveredThroughMs ?? 0, window!.toMs);
  }

  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];
  const complete = sorted.length > 1
    && vintageAsOfMs(oldest) <= yearStartMs
    && vintageAsOfMs(newest) >= yearEndMs;

  return {
    partial,
    complete,
    coveredThrough: coveredThroughMs == null ? null : new Date(coveredThroughMs).toISOString().slice(0, 10),
  };
}

/** When a not-yet-published vintage is expected. Operator messaging only. */
export function expectedPublicationDate(code: FccVintageCode): string {
  const asOf = new Date(`${vintageOf(code).asOf}T00:00:00.000Z`);
  asOf.setUTCMonth(asOf.getUTCMonth() + BDC_PUBLICATION_LAG_MONTHS);
  return asOf.toISOString().slice(0, 10);
}

export interface DetectionWindow {
  fromMs: number;
  toMs: number;
}

/**
 * The interval-censored window a vintage diff produces: the addition happened
 * some time after the baseline's as-of date and no later than the current
 * vintage's. Open at the start, closed at the end - the baseline filing
 * already told us the address did NOT have service at that instant.
 */
export function additionWindow(baseline: FccVintageCode, current: FccVintageCode): DetectionWindow | null {
  const fromMs = vintageAsOfMs(baseline);
  const toMs = vintageAsOfMs(current);
  return toMs > fromMs ? { fromMs, toMs } : null;
}

export type CalendarQuarter = `${number}Q${1 | 2 | 3 | 4}`;

function quarterOfMs(ms: number): { year: number; quarter: 1 | 2 | 3 | 4 } {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    quarter: (Math.floor(date.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4,
  };
}

/**
 * A quarter ONLY when the entire detection window sits inside one.
 *
 * This is the single function standing between "we know" and "we guessed".
 * A biannual filing diff spans two or four quarters and correctly returns
 * null every time; only a pair of dated address-level observations close
 * enough together can land inside one quarter. Callers must render null as
 * "quarter not established", never as a blank that reads like Q1.
 */
export function windowQuarter(window: DetectionWindow | null): CalendarQuarter | null {
  if (!window || !(window.toMs > window.fromMs)) return null;
  // The window is open at the start: an addition at exactly fromMs is excluded
  // (the baseline observed non-service then), so the first possible instant is
  // one millisecond later. Without this, a window that begins exactly on a
  // quarter boundary would be judged to span the previous quarter as well.
  const start = quarterOfMs(window.fromMs + 1);
  const end = quarterOfMs(window.toMs);
  if (start.year !== end.year || start.quarter !== end.quarter) return null;
  return `${start.year}Q${start.quarter}` as CalendarQuarter;
}

/** The build YEAR, provable on the same all-or-nothing basis as the quarter:
 *  only when the whole window lies inside one calendar year. */
export function windowYear(window: DetectionWindow | null): number | null {
  if (!window || !(window.toMs > window.fromMs)) return null;
  const startYear = new Date(window.fromMs + 1).getUTCFullYear();
  const endYear = new Date(window.toMs).getUTCFullYear();
  return startYear === endYear ? startYear : null;
}

/** Operator-facing explanation of why a quarter is or is not available.
 *  Surfaced on the lead card so a rep never has to wonder whether a blank
 *  quarter means Q1 or means unknown. */
export function quarterExplanation(window: DetectionWindow | null): string {
  if (!window) return "No dated evidence window - build quarter not established.";
  const quarter = windowQuarter(window);
  if (quarter) return `Build proven within ${quarter}.`;
  const from = new Date(window.fromMs).toISOString().slice(0, 10);
  const to = new Date(window.toMs).toISOString().slice(0, 10);
  return `Build occurred between ${from} and ${to} - too wide to prove a quarter.`;
}
