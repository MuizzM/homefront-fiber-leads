// ── Mileage (PURE) — trips, rates, and what a trip is worth ─────────────────
//
// Everything a mileage decision depends on lives here as a deterministic
// function: the status machine, the effective-dated rate lookup, duplicate
// detection, and the reimbursement arithmetic. No clock, no database, no
// network. server/mileageStore.ts supplies the rows and the timestamps.
//
// ── TWO INTEGER UNITS, AND WHY NEITHER IS A FLOAT ───────────────────────────
// Distance is `milesHundredths` — 12.34 miles is 1234. Rate is
// `rateMilliCentsPerMile` — $0.655/mile is 65,500 (65.5 cents × 1000).
//
// A per-mile rate genuinely needs sub-cent precision: the common US business
// rates land on half-cents ($0.655, $0.625), and storing 65.5 as a float then
// multiplying by a distance is how a reimbursement report stops re-summing to
// its own total. Milli-cents make every intermediate an integer and the final
// rounding a single, explicit step — the same discipline the commission plane
// already applies with integer cents.
//
// ── THE RATE IS NEVER HARD-CODED ────────────────────────────────────────────
// There is deliberately no DEFAULT_MILEAGE_RATE constant in this file. An org
// with no configured rate reimburses NOTHING and says so (`rate: null`), rather
// than quietly applying a federal figure that may be wrong for the year, wrong
// for the jurisdiction, or wrong for how that org's CPA treats contractor
// mileage. A number nobody chose is worse than a blank the operator must fill.

import { haversineMeters, type LatLng } from "./knock";

// ── Status machine ──────────────────────────────────────────────────────────

export const MILEAGE_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "PAID"] as const;
export type MileageStatus = (typeof MILEAGE_STATUSES)[number];

/**
 * Legal transitions. Two properties are load-bearing:
 *
 *   * APPROVED never returns to DRAFT or SUBMITTED. Once a manager has approved
 *     a trip, the numbers behind it are frozen; a correction is an ADJUSTMENT
 *     row, never an edit. This is the same rule `punch_corrections` applies to
 *     recorded time and the same reason `commission_statements` refuses to
 *     recalculate once FINALIZED.
 *   * REJECTED returns to DRAFT. A rejection is feedback, not a death sentence —
 *     the rep fixes the trip and resubmits, and that resubmission is a NEW fact
 *     (which is why MILEAGE_SUBMITTED is a repeatable domain event).
 */
const MILEAGE_TRANSITIONS: Record<MileageStatus, readonly MileageStatus[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["APPROVED", "REJECTED", "DRAFT"], // DRAFT = the rep withdraws it
  APPROVED: ["PAID"],
  REJECTED: ["DRAFT"],
  PAID: [],
};

export function canMileageTransition(from: MileageStatus, to: MileageStatus): boolean {
  if (from === to) return true;
  return (MILEAGE_TRANSITIONS[from] ?? []).includes(to);
}

/** Statuses whose numbers are frozen — an edit must become an adjustment. */
export function isMileageLocked(status: MileageStatus): boolean {
  return status === "APPROVED" || status === "PAID";
}

/** Statuses that owe the worker money once a rate exists. */
export function isMileagePayable(status: MileageStatus): boolean {
  return status === "APPROVED";
}

export const MILEAGE_SOURCES = ["MANUAL", "GPS", "IMPORT"] as const;
export type MileageSource = (typeof MILEAGE_SOURCES)[number];

// ── Rates ───────────────────────────────────────────────────────────────────

/**
 * One org rate, effective from a date forward. Rates are never edited: a new
 * figure is a NEW row with a later `effectiveFrom`, so a trip taken in March is
 * still priced at March's rate after an April change. That is the same
 * effective-dating `rep_commission_assignments` and `commission_plan_versions`
 * already use, and it is what makes a re-run of last quarter's mileage report
 * reproduce last quarter's numbers.
 */
export interface MileageRate {
  id: number;
  tenantId: number;
  rateMilliCentsPerMile: number;
  /** ISO date (YYYY-MM-DD), inclusive. */
  effectiveFrom: string;
  note: string | null;
}

/**
 * The rate governing a trip on `tripDate`, or null when the org had none yet.
 *
 * Picks the latest rate whose `effectiveFrom` is on or before the trip date —
 * NOT the newest rate overall, which would retroactively re-price history the
 * moment an admin sets a new figure.
 *
 * Ties on the same date resolve to the highest id (the later-entered row), so
 * correcting a same-day mistake is possible without deleting anything.
 */
export function resolveRateForDate(rates: readonly MileageRate[], tripDate: string): MileageRate | null {
  let best: MileageRate | null = null;
  for (const r of rates) {
    if (r.effectiveFrom > tripDate) continue;
    if (!best) { best = r; continue; }
    if (r.effectiveFrom > best.effectiveFrom) best = r;
    else if (r.effectiveFrom === best.effectiveFrom && r.id > best.id) best = r;
  }
  return best;
}

/**
 * What a trip is worth, in integer cents.
 *
 * `milesHundredths × rateMilliCentsPerMile` is an exact integer count of
 * hundredth-mile-milli-cents; dividing by 100 × 1000 converts to cents, and the
 * single rounding happens once, at the end. Rounding half away from zero keeps
 * the result symmetric for the (rare, correction-driven) negative case.
 */
export function reimbursementCents(milesHundredths: number, rateMilliCentsPerMile: number): number {
  const miles = Math.trunc(Number(milesHundredths) || 0);
  const rate = Math.trunc(Number(rateMilliCentsPerMile) || 0);
  if (miles === 0 || rate === 0) return 0;
  const scaled = miles * rate;                 // hundredth-mile · milli-cents
  const sign = scaled < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(scaled) / 100_000);
}

/** `12.34 mi` from the integer hundredths — one formatter for every surface. */
export function formatMiles(milesHundredths: number): string {
  const n = Math.trunc(Number(milesHundredths) || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")} mi`;
}

/** `$0.655/mi` — the rate as an operator reads it. */
export function formatRate(rateMilliCentsPerMile: number): string {
  const n = Math.max(0, Math.trunc(Number(rateMilliCentsPerMile) || 0));
  // milli-cents → dollars, keeping three decimals so a half-cent rate is visible.
  return `$${(n / 100_000).toFixed(3)}/mi`;
}

/** Parse an operator's "0.655" into milli-cents. Returns null on nonsense so a
 *  bad form value can never become a silent $0.00 rate. */
export function parseRateDollars(input: unknown): number | null {
  const n = typeof input === "number" ? input : Number(String(input ?? "").trim());
  if (!Number.isFinite(n) || n < 0) return null;
  // Two-dollar-per-mile is already absurd for vehicle reimbursement; refusing it
  // catches a cents-entered-as-dollars typo (65.5 meaning $0.655) before it
  // multiplies across a quarter of trips.
  if (n > 2) return null;
  return Math.round(n * 100_000);
}

/** Parse a rep's "12.3" miles into integer hundredths. */
export function parseMiles(input: unknown): number | null {
  const n = typeof input === "number" ? input : Number(String(input ?? "").trim());
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > MAX_TRIP_MILES) return null;
  return Math.round(n * 100);
}

/** A single trip longer than this is a data-entry error, not a day's driving.
 *  Bounding it here stops one fat-fingered entry from dominating an org's
 *  liability report. */
export const MAX_TRIP_MILES = 2000;

// ── GPS-assisted trips ──────────────────────────────────────────────────────

/**
 * Straight-line distance between two points, in integer hundredths of a mile.
 *
 * This is the FLOOR of a trip's real distance, never its true length: roads are
 * not straight. It is used as a plausibility bound and as the fallback when no
 * routing provider is configured — `computeTripDistance` documents the
 * difference and the store records which one was used, so a report never
 * implies a routed number it did not get.
 */
export function straightLineMilesHundredths(a: LatLng, b: LatLng): number {
  const meters = haversineMeters(a, b);
  return Math.round((meters / 1609.344) * 100);
}

export type DistanceMethod = "ROUTED" | "STRAIGHT_LINE" | "MANUAL";

export interface DistanceResult {
  milesHundredths: number;
  method: DistanceMethod;
}

/**
 * Resolve a trip's distance from whatever the caller actually has.
 *
 * Precedence is deliberate: a rep's own odometer reading beats a provider, and
 * a provider beats a straight line. The rep is the one who drove it, and a
 * routing engine that picks a different road than the one taken is not more
 * truthful than the person in the car — it is only more precise.
 *
 * `routedMilesHundredths` is whatever a configured routing provider returned;
 * null means none is configured or it failed, which must degrade to a usable
 * trip rather than a blocked one.
 */
export function computeTripDistance(input: {
  manualMilesHundredths?: number | null;
  routedMilesHundredths?: number | null;
  start?: LatLng | null;
  end?: LatLng | null;
}): DistanceResult | null {
  const manual = input.manualMilesHundredths;
  if (manual != null && Number.isFinite(manual) && manual > 0) {
    return { milesHundredths: Math.trunc(manual), method: "MANUAL" };
  }
  const routed = input.routedMilesHundredths;
  if (routed != null && Number.isFinite(routed) && routed > 0) {
    return { milesHundredths: Math.trunc(routed), method: "ROUTED" };
  }
  if (input.start && input.end) {
    const straight = straightLineMilesHundredths(input.start, input.end);
    if (straight > 0) return { milesHundredths: straight, method: "STRAIGHT_LINE" };
  }
  return null;
}

// ── Location consent ────────────────────────────────────────────────────────

/**
 * GPS tracking is OFF unless the worker turned it on, and even then it is
 * per-trip, never continuous.
 *
 * Two separate flags because they are two separate consents, and collapsing
 * them is exactly the failure the spec warns about: agreeing to have a trip
 * measured is not agreeing to be followed all day. `backgroundOptIn` gates only
 * whether the client may keep sampling while the app is backgrounded DURING an
 * explicitly started trip; there is no state in this model in which location is
 * sampled without an open trip.
 */
export interface LocationConsent {
  /** The worker accepted the in-app disclosure. Timestamped by the store. */
  disclosureAcceptedAt: string | null;
  /** The worker additionally opted into background sampling during a trip. */
  backgroundOptIn: boolean;
}

/**
 * The org-level switch an admin holds over GPS trips.
 *
 * There are deliberately only two positions, and there is no third that forces
 * tracking ON. An admin can take the capability away from the whole org, or
 * leave the choice with each worker — but consent that an administrator can
 * grant on someone else's behalf is not consent, and a "locked on" position
 * would contradict the disclosure every rep is shown.
 */
export const GPS_POLICIES = ["REP_CHOICE", "LOCKED_OFF"] as const;
export type GpsPolicy = (typeof GPS_POLICIES)[number];

export function isGpsPolicy(v: unknown): v is GpsPolicy {
  return typeof v === "string" && (GPS_POLICIES as readonly string[]).includes(v);
}

/**
 * May this worker start a GPS trip right now?
 *
 * Both gates must pass: the org must allow GPS at all, and the worker must have
 * accepted the disclosure. `LOCKED_OFF` wins over an existing consent rather
 * than deleting it — an org that turns GPS back on should not silently
 * re-enable tracking for everyone who once agreed, but neither should it have
 * to make them re-consent if the lock is lifted the same afternoon. The stored
 * consent stays; the policy simply overrides it while it is in force.
 */
export function mayStartGpsTrip(
  consent: LocationConsent | null | undefined,
  policy: GpsPolicy = "REP_CHOICE",
): boolean {
  if (policy === "LOCKED_OFF") return false;
  return !!consent?.disclosureAcceptedAt;
}

/**
 * May the WORKER change their own tracking setting?
 *
 * False when the org has locked GPS off (there is nothing left to choose) or
 * when an admin has pinned this individual's setting. A pin can only ever hold
 * a setting where it already is — see `applyConsentLock`.
 */
export function mayChangeOwnConsent(
  consent: (LocationConsent & { adminLocked?: boolean }) | null | undefined,
  policy: GpsPolicy = "REP_CHOICE",
): boolean {
  if (policy === "LOCKED_OFF") return false;
  return !consent?.adminLocked;
}

/**
 * What an admin lock does to a stored consent.
 *
 * A lock FREEZES; it never grants. Locking a worker who has not accepted the
 * disclosure keeps them at "off" — it does not opt them in on their behalf.
 * That asymmetry is the whole reason this is a function rather than a boolean
 * column the routes set directly.
 */
export function applyConsentLock(
  consent: LocationConsent,
  locked: boolean,
): { adminLocked: boolean; disclosureAcceptedAt: string | null } {
  return {
    adminLocked: locked,
    disclosureAcceptedAt: consent.disclosureAcceptedAt,
  };
}

/** May the client sample location while backgrounded? Requires BOTH the
 *  disclosure and the explicit background opt-in, and an open trip — which the
 *  caller proves by passing `tripIsOpen`. */
export function maySampleInBackground(consent: LocationConsent | null | undefined, tripIsOpen: boolean): boolean {
  return mayStartGpsTrip(consent) && !!consent?.backgroundOptIn && tripIsOpen;
}

// ── Duplicate detection ─────────────────────────────────────────────────────

/** The minimum a trip must look like for duplicate comparison. */
export interface TripFingerprint {
  id?: number;
  tripDate: string;
  startLocation: string | null;
  endLocation: string | null;
  startLat?: number | null;
  startLng?: number | null;
  endLat?: number | null;
  endLng?: number | null;
  milesHundredths: number;
}

/** Endpoints within this many metres are "the same place" for duplicate
 *  purposes — roughly a large parking lot, so two logs of the same visit match
 *  even when the phone settled on different corners of it. */
export const DUPLICATE_RADIUS_M = 250;

/** Distances within this fraction of each other are "the same length". */
const DUPLICATE_MILES_TOLERANCE = 0.1;

function normalizePlace(s: string | null | undefined): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,#]/g, "");
}

function coordsClose(a: TripFingerprint, b: TripFingerprint): boolean {
  const have = (t: TripFingerprint) =>
    Number.isFinite(t.startLat) && Number.isFinite(t.startLng) &&
    Number.isFinite(t.endLat) && Number.isFinite(t.endLng);
  if (!have(a) || !have(b)) return false;
  const startM = haversineMeters(
    { lat: a.startLat as number, lng: a.startLng as number },
    { lat: b.startLat as number, lng: b.startLng as number },
  );
  const endM = haversineMeters(
    { lat: a.endLat as number, lng: a.endLng as number },
    { lat: b.endLat as number, lng: b.endLng as number },
  );
  return startM <= DUPLICATE_RADIUS_M && endM <= DUPLICATE_RADIUS_M;
}

function milesClose(a: number, b: number): boolean {
  const big = Math.max(Math.abs(a), Math.abs(b));
  if (big === 0) return true;
  return Math.abs(a - b) / big <= DUPLICATE_MILES_TOLERANCE;
}

/**
 * Trips on the same day that look like the same drive logged twice.
 *
 * Returns the MATCHES rather than a boolean, because this is a warning, not a
 * refusal: a rep genuinely can drive the same route twice in a day (a return
 * visit, a forgotten document), and blocking that outright teaches people to
 * fudge the address to get past the check. The store surfaces the matches, the
 * rep confirms, and the confirmation is recorded.
 *
 * Matching is either address-shaped OR coordinate-shaped — a manual entry has
 * no coordinates and a GPS trip often has no typed address, and a duplicate
 * that crosses those two sources is exactly the one worth catching.
 */
export function findDuplicateTrips(
  candidate: TripFingerprint,
  sameDayTrips: readonly TripFingerprint[],
): TripFingerprint[] {
  const candStart = normalizePlace(candidate.startLocation);
  const candEnd = normalizePlace(candidate.endLocation);

  return sameDayTrips.filter(t => {
    if (t.id != null && candidate.id != null && t.id === candidate.id) return false;
    if (t.tripDate !== candidate.tripDate) return false;
    if (!milesClose(t.milesHundredths, candidate.milesHundredths)) return false;

    const sameAddresses = candStart !== "" && candEnd !== ""
      && normalizePlace(t.startLocation) === candStart
      && normalizePlace(t.endLocation) === candEnd;

    return sameAddresses || coordsClose(candidate, t);
  });
}

// ── Trip validation ─────────────────────────────────────────────────────────

export interface TripInput {
  tripDate: string;
  startLocation: string | null;
  endLocation: string | null;
  milesHundredths: number;
  purpose: string | null;
  source: MileageSource;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Problems with a trip, as a list. Empty means valid.
 *
 * `todayIso` is supplied so the future-date rule stays pure — and the rule is
 * one-sided on purpose: a trip logged for tomorrow has not happened, but a trip
 * logged for last month is ordinary catch-up paperwork and must not be refused.
 * Age limits are org policy, enforced at the store with the org's window.
 */
export function validateTrip(input: Partial<TripInput>, todayIso: string): string[] {
  const problems: string[] = [];

  if (typeof input.tripDate !== "string" || !ISO_DATE.test(input.tripDate)) {
    problems.push("tripDate must be a YYYY-MM-DD date");
  } else if (input.tripDate > todayIso) {
    problems.push("tripDate cannot be in the future");
  }

  const miles = input.milesHundredths;
  if (!Number.isInteger(miles) || (miles as number) <= 0) {
    problems.push("miles must be greater than zero");
  } else if ((miles as number) > MAX_TRIP_MILES * 100) {
    problems.push(`miles cannot exceed ${MAX_TRIP_MILES} for a single trip`);
  }

  // A purpose is what makes the record defensible to a tax professional. It is
  // required for exactly that reason, not as form hygiene.
  if (!String(input.purpose ?? "").trim()) {
    problems.push("purpose is required");
  }

  if (!input.source || !(MILEAGE_SOURCES as readonly string[]).includes(input.source)) {
    problems.push("source must be MANUAL, GPS, or IMPORT");
  }

  // A MANUAL trip must name where it went; a GPS trip proves it with
  // coordinates instead, and demanding typed addresses there would make the
  // start-trip button useless.
  if (input.source === "MANUAL") {
    if (!String(input.startLocation ?? "").trim()) problems.push("startLocation is required for a manual trip");
    if (!String(input.endLocation ?? "").trim()) problems.push("endLocation is required for a manual trip");
  }

  return problems;
}

// ── Summaries ───────────────────────────────────────────────────────────────

export interface MileageSummaryRow {
  status: MileageStatus;
  milesHundredths: number;
  reimbursementCents: number;
}

export interface MileageSummary {
  tripCount: number;
  totalMilesHundredths: number;
  /** Money already committed: APPROVED and PAID. */
  approvedCents: number;
  paidCents: number;
  /** Not yet money: what a pending queue would cost if all of it cleared. */
  pendingMilesHundredths: number;
  pendingEstimateCents: number;
}

/**
 * Roll trips into the numbers a dashboard and a liability report both need.
 *
 * Pending is reported SEPARATELY from approved rather than summed into a single
 * "total", because they are different kinds of fact: approved mileage is a
 * liability the org owes, pending mileage is a claim that may still be rejected.
 * An admin liability figure that blends them overstates what is owed.
 */
export function summarizeMileage(rows: readonly MileageSummaryRow[]): MileageSummary {
  const out: MileageSummary = {
    tripCount: rows.length,
    totalMilesHundredths: 0,
    approvedCents: 0,
    paidCents: 0,
    pendingMilesHundredths: 0,
    pendingEstimateCents: 0,
  };
  for (const r of rows) {
    out.totalMilesHundredths += r.milesHundredths;
    if (r.status === "APPROVED") out.approvedCents += r.reimbursementCents;
    else if (r.status === "PAID") out.paidCents += r.reimbursementCents;
    else if (r.status === "SUBMITTED") {
      out.pendingMilesHundredths += r.milesHundredths;
      out.pendingEstimateCents += r.reimbursementCents;
    }
  }
  return out;
}
