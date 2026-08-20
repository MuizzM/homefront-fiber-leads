// ── Rep field metrics — the one definition of every number ────────────────────
//
// PURE and framework-free, like shared/knock.ts and shared/territoryMetrics.ts.
// The rollup job, the API, the coaching engine and the client all compute from
// THIS file, so a metric cannot mean one thing on the rep's phone and another
// on the manager's table. That is not a style preference: this module's output
// is used to decide who gets coached, and two screens disagreeing about a
// rep's contact rate is how somebody gets a conversation they did not earn.
//
// Four rules carry most of the weight.
//
//   1. A RATE WITH NO DENOMINATOR IS NULL, NOT ZERO.
//      A rep who knocked no doors has an UNDEFINED contact rate. Reporting 0%
//      would sort them below a rep who genuinely converted badly, and every
//      "needs coaching" rule downstream would fire on someone who simply had a
//      day off. `null` renders as "—" and is excluded from every comparison.
//      This is the single most load-bearing decision in the file.
//
//   2. RATES ARE NEVER AVERAGED ACROSS PERIODS.
//      A week's contact rate is recomputed from the SUMMED numerator and the
//      SUMMED denominator, never as the mean of seven daily rates. A day with
//      one door and one contact is not a 100% day that should drag a week up.
//      Everything persisted in rep_daily_metrics is therefore a COUNT or a
//      DURATION - both additive - and every rate is derived at read time.
//
//   3. TIME BETWEEN DOORS EXCLUDES BREAKS.
//      A lunch hour is not a slow walk to the next house. Gaps longer than
//      INTER_DOOR_GAP_CAP_MS are removed from the pace sample and counted as
//      inactivity instead. Without this, one break makes a fast rep look like
//      the slowest on the team, which is exactly the false accusation the
//      privacy brief says this feature must not manufacture.
//
//   4. MEDIAN LEADS, AVERAGE FOLLOWS.
//      Pace is reported median-first. One 40-minute drive between neighbourhoods
//      moves a mean far more than it moves the rep's actual routine, and the
//      mean is what a manager would otherwise read as "slow".
//
// Nothing here reads a database, a clock, or a request. Everything is a pure
// function of values passed in, so all of it is testable without fixtures.

import { haversineMeters, type KnockOutcome } from "./knock";
import { INACTIVE_AFTER_MS } from "./liveOps";

// ── Thresholds ───────────────────────────────────────────────────────────────

/**
 * The longest gap still counted as "moving to the next door".
 *
 * Above this, the rep was doing something else - lunch, a drive to another
 * neighbourhood, an appointment - and folding it into pace would slander the
 * whole day. 45 minutes is deliberately generous: a long conversation on a
 * porch followed by a walk to the far end of a street is real door-to-door
 * work, and the cost of excluding a genuine gap is a slightly smaller sample,
 * while the cost of including a break is a coaching flag nobody earned.
 */
export const INTER_DOOR_GAP_CAP_MS = 45 * 60_000;

/**
 * A gap this long inside an active shift is an INACTIVE PERIOD.
 *
 * Reuses the live-ops threshold rather than inventing a second one, so the
 * dashboard's "inactive" dot and this metric's "longest inactive period" can
 * never disagree on screen.
 */
export const INACTIVITY_THRESHOLD_MS = INACTIVE_AFTER_MS;

/**
 * Movement faster than this between two fixes is discarded from the distance
 * total. ~90 mph. It is a GPS jump or a mis-stamped point, and one of them adds
 * tens of kilometres to a rep's "distance travelled" - a number that would then
 * be read as driving around instead of knocking.
 */
export const MAX_PLAUSIBLE_SPEED_MPS = 40;

/** Coordinates outside these bounds are rejected outright, never clamped. */
export const MAX_ABS_LAT = 90;
export const MAX_ABS_LNG = 180;

// ── Verification ─────────────────────────────────────────────────────────────

/**
 * How confident we are that the rep was physically at the door.
 *
 * `unavailable` is NOT a failure state. A rep in a basement, a dead phone, an
 * OS permission the org never asked for - all land here, and the brief is
 * explicit that none of them may block a disposition or imply the rep was not
 * working. It is excluded from VERIFIED counts and included in ATTEMPTED ones.
 */
export const VERIFICATION_STATES = ["verified", "approximate", "unavailable", "outside_radius"] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

export function isVerified(state: VerificationState | string | null | undefined): boolean {
  return state === "verified";
}

// ── Safe arithmetic ──────────────────────────────────────────────────────────

/**
 * A ratio in 0..1, or null when the denominator is zero/absent.
 *
 * Returning null rather than 0 is rule 1 at the top of this file. Callers that
 * want a percentage use formatRate(); callers that want to compare use
 * `rate == null ? skip : compare`.
 */
export function rate(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator <= 0) return null;
  return numerator / denominator;
}

/** "24%" / "—". One place decides how an absent rate reads. */
export function formatRate(r: number | null | undefined, digits = 0): string {
  if (r == null || !Number.isFinite(r)) return "—";
  return `${(r * 100).toFixed(digits)}%`;
}

/** Per-hour figure from a count and a duration, null when no time elapsed. */
export function perHour(count: number, seconds: number): number | null {
  if (!Number.isFinite(count) || !Number.isFinite(seconds) || seconds <= 0) return null;
  return count / (seconds / 3600);
}

/** Median of a numeric sample. null on an empty sample - never 0. */
export function median(values: readonly number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** Arithmetic mean. null on an empty sample - never 0. */
export function mean(values: readonly number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

/**
 * One door interaction, as the rollup reads it out of knock_log.
 *
 * `superseded` rows are field history whose outcome LOST the compare-and-swap
 * (a newer disposition already stood). They count as an ATTEMPT - the rep did
 * walk up to that door - and contribute NOTHING to outcome counts, because the
 * outcome they carried was never applied. Counting them twice is how offline
 * sync would otherwise inflate a rep's sales.
 */
export interface DoorEventInput {
  leadId: number;
  /** knock_log.knocked_at as epoch ms. */
  atMs: number;
  outcome: KnockOutcome | string;
  wasHome: boolean;
  verification: VerificationState | string | null;
  superseded: boolean;
  /** Set when the rep booked a specific return - this is what an appointment IS
   *  in this product. See APPOINTMENT_DEFINITION below. */
  callbackDate: string | null;
  territoryId: number | null;
  /** Metres from the door, when the device offered a usable fix. */
  distanceFromLeadM: number | null;
  /** Seconds spent at the door, when the client measured it. Usually null. */
  dwellSeconds: number | null;
}

/** A clocked-in window. `endMs` null = still open. */
export interface ShiftWindowInput {
  startMs: number;
  endMs: number | null;
}

/** One accepted location fix, ordered by capture time. */
export interface TrackPointInput {
  atMs: number;
  lat: number;
  lng: number;
  accuracyM: number | null;
  insideTerritory: boolean | null;
}

/** The assignment picture at the end of the day. */
export interface AssignmentInput {
  /** Doors currently assigned to this rep. */
  assignedDoors: number;
  /** Assigned MINUS do-not-knock and terminal-no doors: the honest denominator
   *  for utilization. A door nobody may knock is not a door the rep failed to
   *  knock. */
  eligibleDoors: number;
  /** Newly lit / priority doors assigned, and how many have been attempted. */
  freshAssigned: number;
  freshAttempted: number;
  /** Distinct doors with at least one knock EVER (not just today) - the
   *  utilization numerator. Utilization is a stock, not a flow. */
  everWorkedDoors: number;
  /** Assigned doors nobody may knock. A compliance fact about the territory,
   *  not something a rep did, which is why it lives here and not on an event. */
  doNotKnockDoors: number;
  /** Oldest still-open assignment, epoch ms, for assignment aging. */
  oldestAssignedAtMs: number | null;
  /** First knock after that assignment, epoch ms. null = never started. */
  firstActivityAtMs: number | null;
}

/** Money and order lifecycle for the period, already scoped to the rep. */
export interface OrderInput {
  submittedOrders: number;
  acceptedOrders: number;
  installedOrders: number;
  paidOrders: number;
  canceledOrders: number;
  chargebacks: number;
  /** Follow-ups the rep completed, and how many produced an order. */
  followUpsCreated: number;
  followUpsCompleted: number;
  ordersFromFollowUp: number;
  estimatedCommissionCents: number;
  paidCommissionCents: number;
}

// ── Appointments ─────────────────────────────────────────────────────────────

/**
 * THE APPOINTMENT DEFINITION, stated once.
 *
 * shared/territoryMetrics.ts records that this product has no `appointment`
 * disposition and refuses to map `interested` onto one - folding a soft
 * "interested" into a booked appointment would both overstate appointments and
 * corrupt contact_rate. That decision stands, and this module does not reopen it.
 *
 * What this module counts instead is a fact the schema genuinely persists: a
 * knock that set a CALLBACK DATE. The rep and the occupant agreed on a specific
 * time to come back. That is an appointment in every sense a manager cares
 * about, it is a discrete recorded event rather than a re-reading of a mood,
 * and it is exactly the thing "appointment completion rate" needs in order to
 * mean anything.
 */
export function isAppointment(e: Pick<DoorEventInput, "outcome" | "callbackDate">): boolean {
  if (!e.callbackDate) return false;
  return e.outcome === "follow_up" || e.outcome === "callback";
}

/** Someone answered the door. `wasHome` is derived server-side from the
 *  outcome (shared/knock.deriveWasHome), so it cannot contradict it. */
export function isContact(e: Pick<DoorEventInput, "wasHome">): boolean {
  return e.wasHome === true;
}

export function isInterested(e: Pick<DoorEventInput, "outcome">): boolean {
  return e.outcome === "interested";
}

export function isSale(e: Pick<DoorEventInput, "outcome">): boolean {
  return e.outcome === "sold";
}

// ── Pace ─────────────────────────────────────────────────────────────────────

export interface PaceResult {
  /** Gaps that count as door-to-door movement, in seconds. */
  gapsSeconds: number[];
  medianSecondsBetweenDoors: number | null;
  averageSecondsBetweenDoors: number | null;
  /** Gaps ABOVE the inactivity threshold, in seconds. */
  inactivePeriodsSeconds: number[];
  longestInactiveSeconds: number;
  inactivePeriodCount: number;
}

/**
 * Split the day's door timeline into "walking to the next door" and "not".
 *
 * Only consecutive events INSIDE the same shift are compared. Two doors either
 * side of a clock-out are not a nine-hour gap between doors; they are two
 * different days' work, and treating the overnight as a pace sample - or as an
 * inactive period - would be nonsense in both directions.
 *
 * Events are assumed pre-sorted by time; the function sorts defensively anyway,
 * because an offline queue flushing out of order is normal here.
 */
export function computePace(
  events: readonly DoorEventInput[],
  shifts: readonly ShiftWindowInput[],
  nowMs?: number,
): PaceResult {
  const gaps: number[] = [];
  const inactive: number[] = [];

  const windows = shifts.length > 0
    ? shifts
    // No shift recorded: treat the whole day as one window rather than dropping
    // every gap. A rep whose clock-in failed still walked the street, and their
    // pace is still their pace.
    : [{ startMs: Number.NEGATIVE_INFINITY, endMs: null as number | null }];

  for (const w of windows) {
    const end = w.endMs ?? nowMs ?? Number.POSITIVE_INFINITY;
    const inWindow = events
      .filter((e) => Number.isFinite(e.atMs) && e.atMs >= w.startMs && e.atMs <= end)
      .slice()
      .sort((a, b) => a.atMs - b.atMs);

    for (let i = 1; i < inWindow.length; i++) {
      const deltaMs = inWindow[i].atMs - inWindow[i - 1].atMs;
      if (deltaMs < 0) continue; // defensive; the sort above should prevent it
      if (deltaMs > INTER_DOOR_GAP_CAP_MS) {
        // Not a walk to the next door. It is only INACTIVITY if it also clears
        // the inactivity threshold - which, with the current constants, it
        // always does. Kept as two separate checks so tuning one does not
        // silently move the other.
        if (deltaMs >= INACTIVITY_THRESHOLD_MS) inactive.push(deltaMs / 1000);
        continue;
      }
      gaps.push(deltaMs / 1000);
      // A gap can be short enough to be door-to-door movement and still long
      // enough to be worth flagging. With today's constants this branch is
      // unreachable (20min < 45min means it was captured above), and it is
      // written out anyway so that lowering INTER_DOOR_GAP_CAP_MS below the
      // inactivity threshold does not quietly stop counting inactive periods.
      if (deltaMs >= INACTIVITY_THRESHOLD_MS) inactive.push(deltaMs / 1000);
    }
  }

  return {
    gapsSeconds: gaps,
    medianSecondsBetweenDoors: median(gaps),
    averageSecondsBetweenDoors: mean(gaps),
    inactivePeriodsSeconds: inactive,
    longestInactiveSeconds: inactive.length > 0 ? Math.max(...inactive) : 0,
    inactivePeriodCount: inactive.length,
  };
}

// ── Distance ─────────────────────────────────────────────────────────────────

export interface DistanceResult {
  totalMeters: number;
  /** Points dropped as implausible - surfaced so a bad device is visible as a
   *  data-quality note rather than as a rep who "travelled 400 km". */
  rejectedPoints: number;
}

/**
 * Path length over accepted fixes, with teleports removed.
 *
 * A single bad fix creates TWO implausible legs (out and back). Rejecting the
 * leg rather than the point means the rep's real movement either side is still
 * counted, and the excursion contributes nothing.
 */
export function computeDistance(points: readonly TrackPointInput[]): DistanceResult {
  const sorted = points
    .filter((p) =>
      Number.isFinite(p.atMs) &&
      Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
      Math.abs(p.lat) <= MAX_ABS_LAT && Math.abs(p.lng) <= MAX_ABS_LNG)
    .slice()
    .sort((a, b) => a.atMs - b.atMs);

  let total = 0;
  let rejected = 0;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const meters = haversineMeters({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
    const seconds = (b.atMs - a.atMs) / 1000;
    if (seconds <= 0) { rejected++; continue; }
    if (meters / seconds > MAX_PLAUSIBLE_SPEED_MPS) { rejected++; continue; }
    total += meters;
  }
  return { totalMeters: total, rejectedPoints: rejected };
}

// ── Shift time ───────────────────────────────────────────────────────────────

export interface ShiftTimeResult {
  activeSeconds: number;
  firstActivityAtMs: number | null;
  lastActivityAtMs: number | null;
}

/**
 * Total clocked-in seconds, with overlapping shifts merged.
 *
 * Overlaps are real: a phone that failed to clock out and a manual correction
 * can leave two open windows on one day. Summing them would report 16 hours of
 * an 8-hour day, and every "doors per active hour" would then halve.
 */
export function computeShiftTime(
  shifts: readonly ShiftWindowInput[],
  nowMs: number,
): ShiftTimeResult {
  const windows = shifts
    .filter((s) => Number.isFinite(s.startMs))
    .map((s) => ({ start: s.startMs, end: Math.max(s.startMs, s.endMs ?? nowMs) }))
    .sort((a, b) => a.start - b.start);

  let total = 0;
  let cursorStart: number | null = null;
  let cursorEnd = 0;
  for (const w of windows) {
    if (cursorStart == null) { cursorStart = w.start; cursorEnd = w.end; continue; }
    if (w.start <= cursorEnd) { cursorEnd = Math.max(cursorEnd, w.end); continue; }
    total += cursorEnd - cursorStart;
    cursorStart = w.start;
    cursorEnd = w.end;
  }
  if (cursorStart != null) total += cursorEnd - cursorStart;

  return {
    activeSeconds: Math.max(0, Math.round(total / 1000)),
    firstActivityAtMs: windows.length > 0 ? windows[0].start : null,
    lastActivityAtMs: windows.length > 0 ? Math.max(...windows.map((w) => w.end)) : null,
  };
}

/**
 * Split active time by whether the rep was inside their assigned territory.
 *
 * Attributed by the SEGMENT between two fixes, using the earlier fix's verdict:
 * a rep who is inside at 10:00 and outside at 10:05 was inside for most of that
 * leg, and the alternative (attributing to the later fix) would credit the
 * territory they had just left. Unknown verdicts are attributed to NEITHER
 * bucket, so the two never sum past the active total on missing data.
 */
export function splitTerritoryTime(
  points: readonly TrackPointInput[],
  activeSeconds: number,
): { insideSeconds: number; outsideSeconds: number; unknownSeconds: number } {
  const sorted = points
    .filter((p) => Number.isFinite(p.atMs))
    .slice()
    .sort((a, b) => a.atMs - b.atMs);

  let inside = 0;
  let outside = 0;
  for (let i = 1; i < sorted.length; i++) {
    const seconds = (sorted[i].atMs - sorted[i - 1].atMs) / 1000;
    if (seconds <= 0) continue;
    // A gap longer than the sampling cadence allows is not evidence of standing
    // anywhere; skip it rather than credit a whole lunch break to a polygon.
    if (seconds > INTER_DOOR_GAP_CAP_MS / 1000) continue;
    const verdict = sorted[i - 1].insideTerritory;
    if (verdict === true) inside += seconds;
    else if (verdict === false) outside += seconds;
  }

  inside = Math.round(inside);
  outside = Math.round(outside);
  // Clamp: sampling noise must never report more territory time than the rep
  // was clocked in for.
  const capped = Math.min(inside + outside, activeSeconds);
  const scale = inside + outside > 0 ? capped / (inside + outside) : 0;
  const insideS = Math.round(inside * scale);
  const outsideS = Math.round(outside * scale);
  return {
    insideSeconds: insideS,
    outsideSeconds: outsideS,
    unknownSeconds: Math.max(0, activeSeconds - insideS - outsideS),
  };
}

// ── The daily fact row ───────────────────────────────────────────────────────

/**
 * Everything persisted for one rep for one day. COUNTS AND DURATIONS ONLY -
 * every one of these is additive across days, which is what makes rule 2
 * (never average a rate) mechanically enforceable rather than a convention.
 */
export interface RepDailyFacts {
  assignedDoors: number;
  eligibleDoors: number;
  doorsAttempted: number;
  doorsVisited: number;
  verifiedDoors: number;
  doorsCompleted: number;
  everWorkedDoors: number;
  freshAssigned: number;
  freshAttempted: number;
  contacts: number;
  interestedLeads: number;
  followUps: number;
  followUpsCompleted: number;
  ordersFromFollowUp: number;
  appointments: number;
  appointmentsCompleted: number;
  submittedOrders: number;
  acceptedOrders: number;
  installedOrders: number;
  paidOrders: number;
  canceledOrders: number;
  chargebacks: number;
  doNotKnockRecords: number;
  noAnswerRecords: number;
  notInterestedRecords: number;
  revisits: number;
  activeSeconds: number;
  territorySeconds: number;
  outsideTerritorySeconds: number;
  distanceMeters: number;
  /** Sum and count, so the period average is a true weighted average rather
   *  than a mean of daily means. Same reason as rule 2. */
  interDoorGapSecondsTotal: number;
  interDoorGapSamples: number;
  medianSecondsBetweenDoors: number | null;
  dwellSecondsTotal: number;
  dwellSamples: number;
  longestInactiveSeconds: number;
  inactivePeriodCount: number;
  estimatedCommissionCents: number;
  paidCommissionCents: number;
  firstActivityAtMs: number | null;
  lastActivityAtMs: number | null;
  assignmentAgeSeconds: number | null;
}

/** Everything the rollup needs for one rep-day. */
export interface DailyComputeInput {
  events: readonly DoorEventInput[];
  shifts: readonly ShiftWindowInput[];
  points: readonly TrackPointInput[];
  assignment: AssignmentInput;
  orders: OrderInput;
  /** Doors this rep already knocked BEFORE today, for revisit detection. */
  previouslyKnockedLeadIds?: ReadonlySet<number>;
  /** Doors with a non-superseded callback due by this day. */
  previouslyBookedLeadIds?: ReadonlySet<number>;
  /** Organization-local date for due-date comparisons (`YYYY-MM-DD`). */
  metricDate?: string;
  nowMs: number;
}

export function computeDailyFacts(input: DailyComputeInput): RepDailyFacts {
  const { events, shifts, points, assignment, orders, nowMs } = input;

  // Attempts count every knock; doors visited counts DISTINCT doors. A rep who
  // goes back three times attempted three times but visited one door, and
  // conflating the two is how doors-knocked inflates without anyone lying.
  const distinctDoors = new Set<number>();
  const distinctVerified = new Set<number>();
  const distinctCompleted = new Set<number>();
  let contacts = 0, interested = 0, appointments = 0, appointmentsCompleted = 0;
  let noAnswer = 0, notInterested = 0, revisits = 0;
  let dwellTotal = 0, dwellSamples = 0;
  const previously = input.previouslyKnockedLeadIds ?? new Set<number>();
  const booked = new Set(input.previouslyBookedLeadIds ?? []);
  const seenToday = new Set<number>();

  for (const e of [...events].sort((a, b) => a.atMs - b.atMs)) {
    distinctDoors.add(e.leadId);
    if (isVerified(e.verification)) distinctVerified.add(e.leadId);
    if (e.dwellSeconds != null && Number.isFinite(e.dwellSeconds) && e.dwellSeconds >= 0) {
      dwellTotal += e.dwellSeconds;
      dwellSamples++;
    }
    // A revisit is a door this rep had already knocked - before today, or
    // earlier in the same day. Both are "went back", which is what the metric
    // is for.
    if (previously.has(e.leadId) || seenToday.has(e.leadId)) revisits++;
    seenToday.add(e.leadId);

    // Superseded rows are attempts and nothing else - see DoorEventInput.
    if (e.superseded) continue;

    if (isContact(e)) contacts++;
    else noAnswer++;
    if (isInterested(e)) interested++;
    const appointment = isAppointment(e);
    if (appointment) appointments++;
    if (e.outcome === "not_interested" || e.outcome === "already_customer") notInterested++;
    if (e.outcome === "not_home") { /* already counted in noAnswer */ }
    // A door is COMPLETE for this pass once it carries a worked outcome.
    if (e.outcome !== "not_home" && e.outcome !== "prospect") distinctCompleted.add(e.leadId);
    // Completion requires an actual prior callback booking, not merely any
    // earlier knock on the door. Count one completion per booked door even if
    // the rep logs more than one follow-on contact that day.
    if (booked.has(e.leadId) && !appointment && isContact(e)) {
      appointmentsCompleted++;
      booked.delete(e.leadId);
    }
    // A same-day booking can become eligible for a later return only when its
    // persisted due date is this local day (or earlier).
    const callbackDate = e.callbackDate?.slice(0, 10);
    if (appointment && callbackDate && (!input.metricDate || callbackDate <= input.metricDate)) {
      booked.add(e.leadId);
    }
  }

  const pace = computePace(events, shifts, nowMs);
  const shiftTime = computeShiftTime(shifts, nowMs);
  const territory = splitTerritoryTime(points, shiftTime.activeSeconds);
  const distance = computeDistance(points);

  const assignmentAgeSeconds =
    assignment.oldestAssignedAtMs != null
      ? Math.max(0, Math.round(
          ((assignment.firstActivityAtMs ?? nowMs) - assignment.oldestAssignedAtMs) / 1000))
      : null;

  return {
    assignedDoors: assignment.assignedDoors,
    eligibleDoors: assignment.eligibleDoors,
    doorsAttempted: events.length,
    doorsVisited: distinctDoors.size,
    verifiedDoors: distinctVerified.size,
    doorsCompleted: distinctCompleted.size,
    everWorkedDoors: assignment.everWorkedDoors,
    freshAssigned: assignment.freshAssigned,
    freshAttempted: assignment.freshAttempted,
    contacts,
    interestedLeads: interested,
    followUps: orders.followUpsCreated,
    followUpsCompleted: orders.followUpsCompleted,
    ordersFromFollowUp: orders.ordersFromFollowUp,
    appointments,
    appointmentsCompleted,
    submittedOrders: orders.submittedOrders,
    acceptedOrders: orders.acceptedOrders,
    installedOrders: orders.installedOrders,
    paidOrders: orders.paidOrders,
    canceledOrders: orders.canceledOrders,
    chargebacks: orders.chargebacks,
    doNotKnockRecords: assignment.doNotKnockDoors,
    noAnswerRecords: noAnswer,
    notInterestedRecords: notInterested,
    revisits,
    activeSeconds: shiftTime.activeSeconds,
    territorySeconds: territory.insideSeconds,
    outsideTerritorySeconds: territory.outsideSeconds,
    distanceMeters: Math.round(distance.totalMeters),
    interDoorGapSecondsTotal: Math.round(pace.gapsSeconds.reduce((a, b) => a + b, 0)),
    interDoorGapSamples: pace.gapsSeconds.length,
    medianSecondsBetweenDoors: pace.medianSecondsBetweenDoors,
    dwellSecondsTotal: Math.round(dwellTotal),
    dwellSamples,
    longestInactiveSeconds: Math.round(pace.longestInactiveSeconds),
    inactivePeriodCount: pace.inactivePeriodCount,
    estimatedCommissionCents: orders.estimatedCommissionCents,
    paidCommissionCents: orders.paidCommissionCents,
    firstActivityAtMs: shiftTime.firstActivityAtMs,
    lastActivityAtMs: shiftTime.lastActivityAtMs,
    assignmentAgeSeconds,
  };
}

// ── Aggregation across days ──────────────────────────────────────────────────

const ADDITIVE_KEYS = [
  "doorsAttempted", "doorsVisited", "verifiedDoors", "doorsCompleted",
  "freshAttempted", "contacts", "interestedLeads", "followUps",
  "followUpsCompleted", "ordersFromFollowUp", "appointments",
  "appointmentsCompleted", "submittedOrders", "acceptedOrders",
  "installedOrders", "paidOrders", "canceledOrders", "chargebacks",
  "doNotKnockRecords", "noAnswerRecords", "notInterestedRecords", "revisits",
  "activeSeconds", "territorySeconds", "outsideTerritorySeconds",
  "distanceMeters", "interDoorGapSecondsTotal", "interDoorGapSamples",
  "dwellSecondsTotal", "dwellSamples", "inactivePeriodCount",
  "estimatedCommissionCents", "paidCommissionCents",
] as const;

/**
 * Fold a period's daily rows into one fact row.
 *
 * Counts and durations SUM. Stock figures (assigned/eligible/ever-worked, which
 * describe a state rather than a flow) take the LATEST day's value - summing
 * them would report a rep with 80 assigned doors as having 560 across a week.
 * Medians take the median of the daily medians, which is an approximation and
 * is labelled as one; the true period median needs the raw gap sample, and
 * carrying that for every rep-day is not worth the storage.
 */
export function aggregateFacts(days: readonly RepDailyFacts[]): RepDailyFacts {
  const empty = emptyFacts();
  if (days.length === 0) return empty;

  const out: RepDailyFacts = { ...empty };
  for (const key of ADDITIVE_KEYS) {
    out[key] = days.reduce((sum, d) => sum + (Number(d[key]) || 0), 0);
  }

  const last = days[days.length - 1];
  out.assignedDoors = last.assignedDoors;
  out.eligibleDoors = last.eligibleDoors;
  out.everWorkedDoors = last.everWorkedDoors;
  out.freshAssigned = last.freshAssigned;
  out.assignmentAgeSeconds = last.assignmentAgeSeconds;

  out.longestInactiveSeconds = Math.max(0, ...days.map((d) => d.longestInactiveSeconds || 0));
  out.medianSecondsBetweenDoors = median(
    days.map((d) => d.medianSecondsBetweenDoors).filter((v): v is number => v != null),
  );
  const firsts = days.map((d) => d.firstActivityAtMs).filter((v): v is number => v != null);
  const lasts = days.map((d) => d.lastActivityAtMs).filter((v): v is number => v != null);
  out.firstActivityAtMs = firsts.length > 0 ? Math.min(...firsts) : null;
  out.lastActivityAtMs = lasts.length > 0 ? Math.max(...lasts) : null;
  return out;
}

/**
 * Fold the already-periodized facts for several reps into one team fact row.
 *
 * `aggregateFacts` deliberately takes the latest stock snapshot when its input
 * is several DAYS for one rep. At the team boundary those same stocks describe
 * different inventories, so they must SUM: rep A's 100 eligible doors and rep
 * B's 50 are 150 team doors, not whichever rep happened to be iterated last.
 * Flow counts still use the ordinary additive fold and the team's oldest
 * assignment age is the maximum non-null per-rep age.
 */
export function aggregateTeamFacts(reps: readonly RepDailyFacts[]): RepDailyFacts {
  const out = aggregateFacts(reps);
  if (reps.length === 0) return out;

  out.assignedDoors = reps.reduce((sum, r) => sum + (Number(r.assignedDoors) || 0), 0);
  out.eligibleDoors = reps.reduce((sum, r) => sum + (Number(r.eligibleDoors) || 0), 0);
  out.everWorkedDoors = reps.reduce((sum, r) => sum + (Number(r.everWorkedDoors) || 0), 0);
  out.freshAssigned = reps.reduce((sum, r) => sum + (Number(r.freshAssigned) || 0), 0);

  const ages = reps
    .map((r) => r.assignmentAgeSeconds)
    .filter((v): v is number => v != null && Number.isFinite(v));
  out.assignmentAgeSeconds = ages.length > 0 ? Math.max(...ages) : null;
  return out;
}

export function emptyFacts(): RepDailyFacts {
  return {
    assignedDoors: 0, eligibleDoors: 0, doorsAttempted: 0, doorsVisited: 0,
    verifiedDoors: 0, doorsCompleted: 0, everWorkedDoors: 0, freshAssigned: 0,
    freshAttempted: 0, contacts: 0, interestedLeads: 0, followUps: 0,
    followUpsCompleted: 0, ordersFromFollowUp: 0, appointments: 0,
    appointmentsCompleted: 0, submittedOrders: 0, acceptedOrders: 0,
    installedOrders: 0, paidOrders: 0, canceledOrders: 0, chargebacks: 0,
    doNotKnockRecords: 0, noAnswerRecords: 0, notInterestedRecords: 0,
    revisits: 0, activeSeconds: 0, territorySeconds: 0,
    outsideTerritorySeconds: 0, distanceMeters: 0, interDoorGapSecondsTotal: 0,
    interDoorGapSamples: 0, medianSecondsBetweenDoors: null, dwellSecondsTotal: 0,
    dwellSamples: 0, longestInactiveSeconds: 0, inactivePeriodCount: 0,
    estimatedCommissionCents: 0, paidCommissionCents: 0,
    firstActivityAtMs: null, lastActivityAtMs: null, assignmentAgeSeconds: null,
  };
}

// ── Derived metrics ──────────────────────────────────────────────────────────

/**
 * Every rate and pace figure, derived from a fact row.
 *
 * Because the input is always summed COUNTS, this function produces the same
 * answer for a day, a week or a quarter - and a week's contact rate is the
 * week's contacts over the week's attempts, never an average of seven rates.
 */
export interface DerivedMetrics {
  contactRate: number | null;
  interestRate: number | null;
  appointmentRate: number | null;
  appointmentCompletionRate: number | null;
  submissionRate: number | null;
  closeRate: number | null;
  installRate: number | null;
  paidConversionRate: number | null;
  cancellationRate: number | null;
  chargebackRate: number | null;
  followUpConversionRate: number | null;
  callbackCompletionRate: number | null;
  utilizationRate: number | null;
  coverageRate: number | null;
  freshUtilizationRate: number | null;
  doorRevisitRate: number | null;
  doorsPerHour: number | null;
  doorsPerActiveHour: number | null;
  verifiedDoorsPerActiveHour: number | null;
  averageSecondsBetweenDoors: number | null;
  medianSecondsBetweenDoors: number | null;
  averageDwellSeconds: number | null;
  activeWorkRatio: number | null;
  territoryTimeRatio: number | null;
  distancePerDoorMeters: number | null;
  untouchedAssignedDoors: number;
  verifiedShare: number | null;
}

/**
 * Chargeback denominator. The spec allows either paid or submitted orders; the
 * choice changes the number materially, so it is a named parameter with an
 * explicit default rather than a silent decision buried in a division.
 *
 * Default is `paid`: a chargeback can only happen against money that was
 * actually paid, so dividing by submissions would understate the rate for a rep
 * whose orders mostly never installed - which is the opposite of informative.
 */
export type ChargebackBasis = "paid" | "submitted";

export function deriveMetrics(
  f: RepDailyFacts,
  opts: { chargebackBasis?: ChargebackBasis } = {},
): DerivedMetrics {
  const basis = opts.chargebackBasis ?? "paid";
  return {
    contactRate: rate(f.contacts, f.doorsAttempted),
    interestRate: rate(f.interestedLeads, f.contacts),
    appointmentRate: rate(f.appointments, f.contacts),
    // Created-in-period appointments and completed-in-period appointments are
    // not the same cohort. Until the rollup persists a due-period denominator,
    // exposing a percentage can exceed 100% and is less honest than unavailable.
    appointmentCompletionRate: null,
    submissionRate: rate(f.submittedOrders, f.doorsAttempted),
    closeRate: rate(f.submittedOrders, f.contacts),
    installRate: rate(f.installedOrders, f.submittedOrders),
    paidConversionRate: rate(f.paidOrders, f.submittedOrders),
    cancellationRate: rate(f.canceledOrders, f.submittedOrders),
    chargebackRate: rate(f.chargebacks, basis === "paid" ? f.paidOrders : f.submittedOrders),
    followUpConversionRate: rate(f.ordersFromFollowUp, f.followUpsCompleted),
    callbackCompletionRate: null,
    // Utilization is a STOCK: doors ever worked over doors eligible. Using the
    // day's attempts here would report a rep who finished their area yesterday
    // as 0% utilized today, which is the reading that gets territory reclaimed
    // from someone who did the work.
    utilizationRate: rate(f.everWorkedDoors, f.eligibleDoors),
    coverageRate: rate(f.doorsVisited, f.eligibleDoors),
    freshUtilizationRate: rate(f.freshAttempted, f.freshAssigned),
    doorRevisitRate: rate(f.revisits, f.doorsAttempted),
    doorsPerHour: perHour(f.doorsAttempted, f.activeSeconds),
    doorsPerActiveHour: perHour(f.doorsAttempted, f.activeSeconds),
    verifiedDoorsPerActiveHour: perHour(f.verifiedDoors, f.activeSeconds),
    averageSecondsBetweenDoors: f.interDoorGapSamples > 0
      ? f.interDoorGapSecondsTotal / f.interDoorGapSamples
      : null,
    medianSecondsBetweenDoors: f.medianSecondsBetweenDoors,
    averageDwellSeconds: f.dwellSamples > 0 ? f.dwellSecondsTotal / f.dwellSamples : null,
    // Productive field activity over clocked-in time. Productive time is the
    // active total MINUS the inactive gaps, so it never exceeds 1.
    activeWorkRatio: f.activeSeconds > 0
      ? Math.max(0, Math.min(1,
          (f.activeSeconds - sumInactive(f)) / f.activeSeconds))
      : null,
    territoryTimeRatio: rate(f.territorySeconds, f.activeSeconds),
    distancePerDoorMeters: f.doorsAttempted > 0 ? f.distanceMeters / f.doorsAttempted : null,
    untouchedAssignedDoors: Math.max(0, f.eligibleDoors - f.everWorkedDoors),
    verifiedShare: rate(f.verifiedDoors, f.doorsVisited),
  };
}

/** Total seconds sitting in inactive periods. Only the longest is persisted per
 *  day, so this is a floor, not the exact total - and it is used only as the
 *  numerator of a ratio that is explicitly labelled approximate. */
function sumInactive(f: RepDailyFacts): number {
  return f.longestInactiveSeconds;
}

// ── The funnel ───────────────────────────────────────────────────────────────

export interface FunnelStage {
  key: string;
  label: string;
  value: number;
  /** Conversion from the PREVIOUS stage. null at the top, and null wherever the
   *  previous stage is zero. */
  fromPrevious: number | null;
}

/**
 * Assigned → Attempted → Contacted → Interested → Appointment → Submitted →
 * Installed → Paid.
 *
 * Every stage is a count already in the fact row, so the funnel cannot disagree
 * with the KPI cards above it - a class of bug that is otherwise guaranteed the
 * moment two components each do their own division.
 */
export function buildFunnel(f: RepDailyFacts): FunnelStage[] {
  const raw: Array<[string, string, number]> = [
    ["assigned", "Assigned", f.eligibleDoors],
    ["attempted", "Attempted", f.doorsAttempted],
    ["contacted", "Contacted", f.contacts],
    ["interested", "Interested", f.interestedLeads],
    ["appointment", "Appointment", f.appointments],
    ["submitted", "Submitted", f.submittedOrders],
    ["installed", "Installed", f.installedOrders],
    ["paid", "Paid", f.paidOrders],
  ];
  return raw.map(([key, label, value], i) => ({
    key,
    label,
    value,
    fromPrevious: i === 0 ? null : rate(value, raw[i - 1][2]),
  }));
}

// ── The definition catalog ───────────────────────────────────────────────────

/**
 * Every metric's human-readable formula, rendered as the tooltip beside it.
 *
 * The spec asks for a tooltip on each metric explaining exactly how it is
 * calculated. Putting the text HERE rather than in the component is what makes
 * that promise keepable: the number and its explanation ship from one module,
 * so a formula change that forgets the tooltip is a change to this file that
 * fails review, not a stale sentence nobody notices for a year.
 */
export interface MetricDef {
  label: string;
  formula: string;
  /** Why the metric is defined this way, where the choice was not obvious. */
  note?: string;
  /** Higher is better, lower is better, or neither. Drives trend colouring -
   *  a rising cancellation rate must not render green. */
  direction: "up" | "down" | "neutral";
  unit: "count" | "rate" | "seconds" | "meters" | "perHour" | "money";
}

export const METRIC_DEFS: Record<string, MetricDef> = {
  doorsAttempted: {
    label: "Doors attempted", direction: "up", unit: "count",
    formula: "Every knock logged, including repeat visits to the same door.",
    note: "Attempts, not doors. A door knocked three times is three attempts and one visit.",
  },
  doorsVisited: {
    label: "Doors visited", direction: "up", unit: "count",
    formula: "Distinct doors with at least one knock.",
  },
  verifiedDoors: {
    label: "Verified doors", direction: "up", unit: "count",
    formula: "Distinct doors where the device fix placed the rep within the org's grace radius.",
    note: "A door is not unverified because the rep did not knock it - a weak GPS fix lands here too, and never counts against the rep.",
  },
  contactRate: {
    label: "Contact rate", direction: "up", unit: "rate",
    formula: "Contacts ÷ doors attempted.",
    note: "A contact is any knock where somebody answered.",
  },
  interestRate: {
    label: "Interest rate", direction: "up", unit: "rate",
    formula: "Interested leads ÷ contacts.",
  },
  appointmentRate: {
    label: "Appointment rate", direction: "up", unit: "rate",
    formula: "Appointments ÷ contacts.",
    note: "An appointment is a knock that booked a specific callback date, not a door marked 'interested'.",
  },
  submissionRate: {
    label: "Submission rate", direction: "up", unit: "rate",
    formula: "Submitted orders ÷ doors attempted.",
  },
  closeRate: {
    label: "Close rate", direction: "up", unit: "rate",
    formula: "Submitted orders ÷ contacts.",
    note: "Measured against people the rep actually spoke to, so a bad-luck day of empty houses does not read as a closing problem.",
  },
  installRate: {
    label: "Install rate", direction: "up", unit: "rate",
    formula: "Installed orders ÷ submitted orders.",
  },
  paidConversionRate: {
    label: "Paid conversion", direction: "up", unit: "rate",
    formula: "Paid orders ÷ submitted orders.",
  },
  cancellationRate: {
    label: "Cancellation rate", direction: "down", unit: "rate",
    formula: "Canceled orders ÷ submitted orders.",
  },
  chargebackRate: {
    label: "Chargeback rate", direction: "down", unit: "rate",
    formula: "Chargebacks ÷ paid orders (org-configurable to submitted orders).",
  },
  followUpConversionRate: {
    label: "Follow-up conversion", direction: "up", unit: "rate",
    formula: "Orders from follow-up ÷ follow-ups completed.",
  },
  callbackCompletionRate: {
    label: "Callback completion", direction: "up", unit: "rate",
    formula: "Unavailable until a due-period callback cohort is persisted.",
    note: "Created and completed activity counts remain visible separately; they are not divided across mismatched cohorts.",
  },
  utilizationRate: {
    label: "Territory utilization", direction: "up", unit: "rate",
    formula: "Doors ever worked ÷ eligible assigned doors.",
    note: "A stock, not a daily flow: finishing an area yesterday still counts today. Do-not-knock doors are removed from the denominator.",
  },
  coverageRate: {
    label: "Coverage rate", direction: "up", unit: "rate",
    formula: "Doors visited in the period ÷ eligible assigned doors.",
  },
  freshUtilizationRate: {
    label: "Fresh-lead utilization", direction: "up", unit: "rate",
    formula: "Newly lit or priority doors worked ÷ newly lit or priority doors assigned.",
  },
  doorsPerActiveHour: {
    label: "Doors per active hour", direction: "up", unit: "perHour",
    formula: "Doors attempted ÷ clocked-in hours.",
    note: "Overlapping shifts are merged before dividing, so a missed clock-out cannot halve the figure.",
  },
  medianSecondsBetweenDoors: {
    label: "Time between doors (median)", direction: "down", unit: "seconds",
    formula: "Median gap between consecutive knocks in the same shift.",
    note: "Gaps over 45 minutes are excluded - they are breaks or drives, not a walk to the next house - and counted as inactivity instead.",
  },
  averageSecondsBetweenDoors: {
    label: "Time between doors (average)", direction: "down", unit: "seconds",
    formula: "Total counted gap time ÷ number of gaps.",
    note: "The median is the honest figure. One long drive moves this average far more than it moves the rep's routine.",
  },
  averageDwellSeconds: {
    label: "Time on door", direction: "neutral", unit: "seconds",
    formula: "Total measured dwell ÷ doors where dwell was measured.",
    note: "Neither direction is 'good': a long dwell is a real conversation or a rep stuck on a bad door.",
  },
  longestInactiveSeconds: {
    label: "Longest inactive period", direction: "down", unit: "seconds",
    formula: "Largest gap between knocks inside one shift, above the 20-minute threshold.",
    note: "Inactive is not idle. Driving between neighbourhoods, an appointment, and a break all land here.",
  },
  activeWorkRatio: {
    label: "Active work ratio", direction: "up", unit: "rate",
    formula: "(Clocked-in time − inactive gaps) ÷ clocked-in time.",
    note: "Approximate: only the longest inactive gap per day is stored, so the real ratio is at or below this.",
  },
  territoryTimeRatio: {
    label: "Time in assigned territory", direction: "up", unit: "rate",
    formula: "Seconds inside the assigned polygon ÷ clocked-in seconds.",
    note: "Time with no usable fix is in neither bucket, so this can be below 100% without any time being spent outside.",
  },
  distancePerDoorMeters: {
    label: "Distance per door", direction: "down", unit: "meters",
    formula: "Distance travelled ÷ doors attempted.",
    note: "Legs implying over 90 mph are dropped as GPS jumps.",
  },
  activeSeconds: {
    label: "Active field time", direction: "up", unit: "seconds",
    formula: "Clocked-in time, with overlapping shifts merged.",
  },
  distanceMeters: {
    label: "Distance travelled", direction: "neutral", unit: "meters",
    formula: "Path length over accepted location fixes during the shift.",
  },
  untouchedAssignedDoors: {
    label: "Untouched assigned doors", direction: "down", unit: "count",
    formula: "Eligible assigned doors − doors ever worked.",
  },
  doorRevisitRate: {
    label: "Door revisit rate", direction: "neutral", unit: "rate",
    formula: "Repeat knocks ÷ doors attempted.",
    note: "Revisits are how no-answer doors get converted; a high rate is not automatically waste.",
  },
  estimatedCommissionCents: {
    label: "Estimated commission", direction: "up", unit: "money",
    formula: "Commission booked but not yet paid.",
  },
  paidCommissionCents: {
    label: "Paid commission", direction: "up", unit: "money",
    formula: "Commission actually paid out.",
  },
};

/** Tooltip text for a metric: formula, plus the note when there is one. */
export function metricTooltip(key: string): string | null {
  const def = METRIC_DEFS[key];
  if (!def) return null;
  return def.note ? `${def.formula}\n\n${def.note}` : def.formula;
}

// ── Comparison ───────────────────────────────────────────────────────────────

export type TrendTone = "up" | "down" | "neutral";

/**
 * How a value compares to a baseline, expressed as a tone the UI can colour.
 *
 * Respects the metric's DIRECTION: a rising cancellation rate is `down` (bad),
 * not `up`. Getting this wrong paints a worsening number green, which is worse
 * than showing no trend at all.
 */
export function compareToBaseline(
  key: string,
  value: number | null,
  baseline: number | null,
  minRelativeChange = 0.05,
): { tone: TrendTone; deltaRatio: number | null } {
  if (value == null || baseline == null || baseline === 0) return { tone: "neutral", deltaRatio: null };
  const deltaRatio = (value - baseline) / Math.abs(baseline);
  if (Math.abs(deltaRatio) < minRelativeChange) return { tone: "neutral", deltaRatio };
  const direction = METRIC_DEFS[key]?.direction ?? "neutral";
  if (direction === "neutral") return { tone: "neutral", deltaRatio };
  const better = direction === "up" ? deltaRatio > 0 : deltaRatio < 0;
  return { tone: better ? "up" : "down", deltaRatio };
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** "4m 20s" / "1h 05m" / "—". Durations are read at a glance, so the unit
 *  changes with the magnitude rather than always being seconds. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "1.2 mi" / "340 m". The field is US, so distance reads in miles once it is
 *  far enough that metres stop being meaningful. */
export function formatDistance(meters: number | null | undefined): string {
  if (meters == null || !Number.isFinite(meters) || meters < 0) return "—";
  if (meters < 800) return `${Math.round(meters)} m`;
  return `${(meters / 1609.344).toFixed(1)} mi`;
}

export function formatPerHour(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(1);
}
