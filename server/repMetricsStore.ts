// ── Rep metrics - persistence and recomputation ──────────────────────────────
//
// Turns the existing event tables (knock_log, clock_sessions, location_pings,
// leads, commissions, vendor_orders) into one rep-day fact row, and reads those
// rows back scoped to whoever is asking.
//
// THE DAY BOUNDARY IS LOCAL, THE STORAGE IS UTC.
// `metric_date` is a calendar date in the ORG's timezone - the same timezone
// the commission week already uses (tenants.commission_timezone), so a rep's
// "today" on this dashboard and their "today" on their pay statement are the
// same day. Every comparison against the database is done in UTC against
// explicit bounds computed from that local date; nothing here compares a date
// string to a timestamp column, which is the bug shared/sqlTime.ts exists to
// document.
//
// NOTHING HERE RUNS ON THE REQUEST PATH.
// recomputeRepDay() is called by the background aggregator. The read functions
// at the bottom are the only things an HTTP handler touches, and every one of
// them is a bounded, indexed SELECT over the rollup - never an aggregate over
// knock_log. That separation is the whole reason the rollup table exists.

import { rawDb } from "./db";
import { localWallToUtcMs, localYmdParts } from "@shared/workweek";
import { polygonCovers } from "@shared/geo";
import { territoryHeldByAny } from "@shared/territory";
import {
  computeDailyFacts,
  emptyFacts,
  type AssignmentInput,
  type DoorEventInput,
  type OrderInput,
  type RepDailyFacts,
  type ShiftWindowInput,
  type TrackPointInput,
} from "@shared/repMetrics";

// ── Time helpers ─────────────────────────────────────────────────────────────

export const DEFAULT_TIMEZONE = "America/New_York";

/** The org's IANA timezone. Falls back to the product default rather than UTC:
 *  a US field org bucketed by UTC days would split every evening shift in two. */
export function tenantTimezone(tenantId: number | null): string {
  if (tenantId == null) return DEFAULT_TIMEZONE;
  try {
    const row = rawDb
      .prepare(`SELECT commission_timezone AS tz FROM tenants WHERE id = ?`)
      .get(tenantId) as { tz?: string } | undefined;
    return row?.tz || DEFAULT_TIMEZONE;
  } catch { return DEFAULT_TIMEZONE; }
}

/** Half-open UTC bounds [startMs, endMs) for one local calendar date. */
export function localDayBoundsMs(dateStr: string, timezone: string): { startMs: number; endMs: number } {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const startMs = localWallToUtcMs(y, mo, d, 0, 0, timezone);
  // Add a day via the calendar, not +86400000: a DST transition makes a local
  // day 23 or 25 hours long, and a fixed offset would drop or double an hour of
  // field work twice a year.
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const endMs = localWallToUtcMs(
    next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timezone,
  );
  return { startMs, endMs };
}

/** 'YYYY-MM-DD' for an instant, in the org's timezone. */
export function localDateString(utcMs: number, timezone: string): string {
  const { y, mo, d } = localYmdParts(utcMs, timezone);
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * SQLite stores timestamps two ways in this codebase (see server/sqlTime.ts).
 * Every comparison below therefore normalizes BOTH sides with
 * replace(col,'T',' ') and compares against a space-separated UTC string.
 * These aggregates are already unindexed scans over a bounded rep-day window,
 * so there is no index to protect and the exact form is free.
 */
function sqlTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

// ── Recomputing one rep-day ──────────────────────────────────────────────────

/** Doors this rep knocked on this local day. */
function loadDoorEvents(repId: number, startMs: number, endMs: number): DoorEventInput[] {
  const rows = rawDb.prepare(`
    SELECT k.lead_id AS leadId, k.knocked_at AS knockedAt, k.outcome AS outcome,
           k.was_home AS wasHome, k.verification_status AS verification,
           k.superseded AS superseded, k.callback_date AS callbackDate,
           k.distance_m AS distanceM, k.dwell_seconds AS dwellSeconds,
           l.assigned_territory_id AS territoryId
      FROM knock_log k
      LEFT JOIN leads l ON l.id = k.lead_id
     WHERE k.rep_id = ?
       AND replace(k.knocked_at,'T',' ') >= ?
       AND replace(k.knocked_at,'T',' ') <  ?
     ORDER BY k.knocked_at ASC
  `).all(repId, sqlTs(startMs), sqlTs(endMs)) as any[];

  return rows.map((r) => ({
    leadId: Number(r.leadId),
    atMs: Date.parse(String(r.knockedAt).replace(" ", "T") + (String(r.knockedAt).endsWith("Z") ? "" : "Z")),
    outcome: String(r.outcome ?? ""),
    wasHome: !!r.wasHome,
    verification: r.verification ?? null,
    superseded: !!r.superseded,
    callbackDate: r.callbackDate ?? null,
    territoryId: r.territoryId != null ? Number(r.territoryId) : null,
    distanceFromLeadM: r.distanceM != null ? Number(r.distanceM) : null,
    dwellSeconds: r.dwellSeconds != null ? Number(r.dwellSeconds) : null,
  })).filter((e) => Number.isFinite(e.atMs));
}

/**
 * Shifts OVERLAPPING this day, clipped to the day's bounds.
 *
 * Clipping matters: an overnight shift that ran 22:00-02:00 contributes two
 * hours to one day and two to the next. Attributing the whole session to its
 * clock-in date would report a four-hour day and a zero-hour day, and every
 * doors-per-active-hour on both would be wrong.
 */
function loadShifts(repId: number, startMs: number, endMs: number, nowMs: number): ShiftWindowInput[] {
  const rows = rawDb.prepare(`
    SELECT clocked_in AS clockedIn, clocked_out AS clockedOut
      FROM clock_sessions
     WHERE rep_id = ?
       AND replace(clocked_in,'T',' ') < ?
       AND (clocked_out IS NULL OR replace(clocked_out,'T',' ') > ?)
  `).all(repId, sqlTs(endMs), sqlTs(startMs)) as any[];

  const out: ShiftWindowInput[] = [];
  for (const r of rows) {
    const inMs = parseTs(r.clockedIn);
    if (inMs == null) continue;
    const rawOut = parseTs(r.clockedOut);
    // An open session is capped at NOW, never at the end of the day: an open
    // shift on a past date is a missed clock-out, and letting it run to
    // midnight would credit hours nobody worked.
    const outMs = rawOut ?? Math.min(nowMs, endMs);
    out.push({
      startMs: Math.max(inMs, startMs),
      endMs: Math.min(outMs, endMs),
    });
  }
  return out.filter((w) => w.endMs == null || w.endMs > w.startMs);
}

/** Accepted location fixes for this rep on this day, ordered. */
function loadTrackPoints(repId: number, startMs: number, endMs: number): TrackPointInput[] {
  const rows = rawDb.prepare(`
    SELECT COALESCE(captured_at, ping_at) AS at, lat, lng, accuracy AS accuracyM
      FROM location_pings
     WHERE rep_id = ?
       AND replace(COALESCE(captured_at, ping_at),'T',' ') >= ?
       AND replace(COALESCE(captured_at, ping_at),'T',' ') <  ?
     ORDER BY 1 ASC
  `).all(repId, sqlTs(startMs), sqlTs(endMs)) as any[];

  return rows.map((r) => ({
    atMs: parseTs(r.at) ?? NaN,
    lat: Number(r.lat),
    lng: Number(r.lng),
    accuracyM: r.accuracyM != null ? Number(r.accuracyM) : null,
    // Resolved below against the rep's assigned polygons, never trusted from a
    // client. Left null here and filled by loadTerritoryVerdicts.
    insideTerritory: null as boolean | null,
  })).filter((p) => Number.isFinite(p.atMs) && Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

/**
 * The assignment picture: how many doors this rep holds, how many are workable,
 * and how much of it has ever been touched.
 *
 * `eligible` removes do-not-knock doors from the denominator. A door nobody may
 * knock is not a door the rep failed to knock, and leaving it in makes a
 * compliant rep look under-utilized.
 */
function loadAssignment(repId: number): AssignmentInput {
  const row = rawDb.prepare(`
    SELECT
      COUNT(*)                                                        AS assigned,
      SUM(CASE WHEN COALESCE(do_not_knock,0) = 1 THEN 1 ELSE 0 END)    AS dnk,
      SUM(CASE WHEN COALESCE(is_new_fiber,0) = 1
                AND COALESCE(do_not_knock,0) = 0 THEN 1 ELSE 0 END)    AS freshAssigned,
      MIN(assigned_at)                                                 AS oldestAssignedAt
    FROM leads
    WHERE assigned_rep_id = ?
  `).get(repId) as any;

  const assigned = Number(row?.assigned ?? 0);
  const dnk = Number(row?.dnk ?? 0);
  const freshAssigned = Number(row?.freshAssigned ?? 0);

  // Doors this rep has EVER knocked among the ones they currently hold. The
  // join is what makes utilization a stock rather than a flow: finishing an
  // area yesterday still counts today.
  const worked = rawDb.prepare(`
    SELECT COUNT(DISTINCT k.lead_id) AS everWorked,
           SUM(CASE WHEN COALESCE(l.is_new_fiber,0) = 1 THEN 1 ELSE 0 END) AS freshWorkedRaw,
           MIN(k.knocked_at) AS firstActivityAt
      FROM knock_log k
      JOIN leads l ON l.id = k.lead_id
     WHERE k.rep_id = ?
       AND l.assigned_rep_id = ?
       AND COALESCE(l.do_not_knock,0) = 0
  `).get(repId, repId) as any;

  // Fresh doors WORKED needs its own distinct count - the sum above counts
  // knocks, not doors, and a rep who went back three times would otherwise
  // report more fresh doors worked than they hold.
  const freshWorked = rawDb.prepare(`
    SELECT COUNT(DISTINCT k.lead_id) AS n
      FROM knock_log k
      JOIN leads l ON l.id = k.lead_id
     WHERE k.rep_id = ?
       AND l.assigned_rep_id = ?
       AND COALESCE(l.is_new_fiber,0) = 1
       AND COALESCE(l.do_not_knock,0) = 0
  `).get(repId, repId) as any;

  return {
    assignedDoors: assigned,
    eligibleDoors: Math.max(0, assigned - dnk),
    doNotKnockDoors: dnk,
    freshAssigned,
    freshAttempted: Number(freshWorked?.n ?? 0),
    everWorkedDoors: Number(worked?.everWorked ?? 0),
    oldestAssignedAtMs: parseTs(row?.oldestAssignedAt),
    firstActivityAtMs: parseTs(worked?.firstActivityAt),
  };
}

/**
 * Orders and money for the day.
 *
 * Reads `vendor_orders` when the provider feed is live and falls back to
 * `commissions` for the submitted/paid counts when it is not. Both flags are
 * dark in this org today (docs/integrations), so the fallback is the live path
 * and has to be correct rather than a stub: a submitted order IS a sold knock
 * that minted a commission, and a paid order is one whose commission was paid.
 */
function loadOrders(repId: number, startMs: number, endMs: number): OrderInput {
  const lo = sqlTs(startMs), hi = sqlTs(endMs);

  const commission = rawDb.prepare(`
    SELECT
      COUNT(*)                                                             AS submitted,
      SUM(CASE WHEN status = 'paid'      THEN 1 ELSE 0 END)                 AS paid,
      SUM(CASE WHEN install_confirmed_at IS NOT NULL THEN 1 ELSE 0 END)     AS installed,
      SUM(CASE WHEN status IN ('pending','approved') THEN COALESCE(amount,0) * 100 ELSE 0 END) AS estimatedCents,
      SUM(CASE WHEN status = 'paid'      THEN COALESCE(amount,0) * 100 ELSE 0 END)             AS paidCents
    FROM commissions
    WHERE rep_id = ?
      AND replace(sale_date,'T',' ') >= ?
      AND replace(sale_date,'T',' ') <  ?
  `).get(repId, lo, hi) as any;

  // The provider feed, when it has rows for this rep and day. Preferred over
  // the commission fallback because it carries the real lifecycle - accepted,
  // failed install, cancellation - that a commission row cannot express.
  let vendor: any = null;
  try {
    vendor = rawDb.prepare(`
      SELECT
        COUNT(*)                                                                  AS submitted,
        SUM(CASE WHEN normalized_status = 'accepted'  THEN 1 ELSE 0 END)           AS accepted,
        SUM(CASE WHEN normalized_status = 'installed' THEN 1 ELSE 0 END)           AS installed,
        SUM(CASE WHEN normalized_status IN ('canceled','rejected') THEN 1 ELSE 0 END) AS canceled
      FROM vendor_orders
      WHERE rep_id = ?
        AND replace(COALESCE(submitted_date, sale_date),'T',' ') >= ?
        AND replace(COALESCE(submitted_date, sale_date),'T',' ') <  ?
    `).get(repId, lo, hi);
  } catch { vendor = null; /* table absent on an older build - fall back */ }

  const useVendor = vendor != null && Number(vendor.submitted ?? 0) > 0;

  // Follow-ups created today, and the ones completed today (a knock on a door
  // that already carried a callback date).
  const followUps = rawDb.prepare(`
    SELECT COUNT(*) AS created
      FROM knock_log
     WHERE rep_id = ? AND callback_date IS NOT NULL
       AND COALESCE(superseded,0) = 0
       AND replace(knocked_at,'T',' ') >= ? AND replace(knocked_at,'T',' ') < ?
  `).get(repId, lo, hi) as any;

  const completed = rawDb.prepare(`
    SELECT COUNT(DISTINCT k.lead_id) AS completed,
           SUM(CASE WHEN k.outcome = 'sold' THEN 1 ELSE 0 END) AS converted
      FROM knock_log k
     WHERE k.rep_id = ?
       AND replace(k.knocked_at,'T',' ') >= ? AND replace(k.knocked_at,'T',' ') < ?
       AND EXISTS (
         SELECT 1 FROM knock_log p
          WHERE p.lead_id = k.lead_id AND p.rep_id = k.rep_id
            AND p.callback_date IS NOT NULL
            AND replace(p.knocked_at,'T',' ') < replace(k.knocked_at,'T',' ')
       )
  `).get(repId, lo, hi) as any;

  return {
    submittedOrders: useVendor ? Number(vendor.submitted ?? 0) : Number(commission?.submitted ?? 0),
    acceptedOrders: useVendor ? Number(vendor.accepted ?? 0) : 0,
    installedOrders: useVendor ? Number(vendor.installed ?? 0) : Number(commission?.installed ?? 0),
    paidOrders: Number(commission?.paid ?? 0),
    canceledOrders: useVendor ? Number(vendor.canceled ?? 0) : 0,
    chargebacks: 0,
    followUpsCreated: Number(followUps?.created ?? 0),
    followUpsCompleted: Number(completed?.completed ?? 0),
    ordersFromFollowUp: Number(completed?.converted ?? 0),
    estimatedCommissionCents: Math.round(Number(commission?.estimatedCents ?? 0)),
    paidCommissionCents: Math.round(Number(commission?.paidCents ?? 0)),
  };
}

/** Doors this rep knocked BEFORE the day started - the revisit baseline. */
function loadPreviouslyKnocked(repId: number, startMs: number): ReadonlySet<number> {
  const rows = rawDb.prepare(`
    SELECT DISTINCT lead_id AS id
      FROM knock_log
     WHERE rep_id = ? AND replace(knocked_at,'T',' ') < ?
     LIMIT 50000
  `).all(repId, sqlTs(startMs)) as any[];
  return new Set(rows.map((r) => Number(r.id)));
}

/**
 * Mark each fix inside/outside the rep's assigned territory.
 *
 * Reuses `polygonCovers` and `territoryHeldByAny` rather than re-deriving
 * either. Two answers to "is this rep in their area" is exactly the drift the
 * shared modules exist to prevent, and `territoryHeldByAny` in particular
 * encodes the multi-assignee rule AND the legacy fallback (a null assignee_ids
 * means "old row, trust rep_id") that a hand-rolled query would get wrong.
 *
 * A rep with no assigned polygon gets `null` on every point, which lands the
 * time in NEITHER bucket rather than counting it as "outside" and implying they
 * were somewhere they should not have been.
 */
function markTerritory(repId: number, points: TrackPointInput[]): void {
  if (points.length === 0) return;
  let rings: Array<[number, number][]> = [];
  try {
    const rows = rawDb.prepare(`
      SELECT polygon, rep_id AS repId, assignee_ids AS assigneeIds
        FROM territories
       WHERE status NOT IN ('archived','draft')
    `).all() as any[];
    rings = rows
      .filter((t) => territoryHeldByAny(t, [repId]))
      .map((t) => { try { return JSON.parse(t.polygon ?? "[]"); } catch { return []; } })
      .filter((ring: any) => Array.isArray(ring) && ring.length >= 3);
  } catch { rings = []; }

  if (rings.length === 0) return; // every verdict stays null - see the doc above

  for (const p of points) {
    p.insideTerritory = rings.some((ring) => polygonCovers(p.lat, p.lng, ring));
  }
}

/**
 * Recompute one rep-day and write it to the rollup.
 *
 * Idempotent: re-running for the same day produces the same row. That is what
 * makes the dirty-day queue safe to retry, and what lets a backfill re-run over
 * a range without double-counting anything.
 */
export function recomputeRepDay(
  tenantId: number,
  repId: number,
  metricDate: string,
  nowMs: number = Date.now(),
): RepDailyFacts {
  const timezone = tenantTimezone(tenantId);
  const { startMs, endMs } = localDayBoundsMs(metricDate, timezone);

  const events = loadDoorEvents(repId, startMs, endMs);
  const shifts = loadShifts(repId, startMs, endMs, nowMs);
  const points = loadTrackPoints(repId, startMs, endMs);
  markTerritory(repId, points);
  const assignment = loadAssignment(repId);
  const orders = loadOrders(repId, startMs, endMs);
  const previouslyKnockedLeadIds = loadPreviouslyKnocked(repId, startMs);

  const facts = computeDailyFacts({
    events, shifts, points, assignment, orders, previouslyKnockedLeadIds, nowMs,
  });

  writeDailyFacts(tenantId, repId, metricDate, timezone, facts);
  return facts;
}

function writeDailyFacts(
  tenantId: number, repId: number, metricDate: string, timezone: string, f: RepDailyFacts,
): void {
  rawDb.prepare(`
    INSERT INTO rep_daily_metrics (
      tenant_id, rep_id, metric_date, timezone,
      assigned_doors, eligible_doors, do_not_knock_doors,
      doors_attempted, doors_visited, verified_doors, doors_completed, ever_worked_doors,
      fresh_assigned, fresh_attempted,
      contacts, interested_leads, follow_ups, follow_ups_completed, orders_from_follow_up,
      appointments, appointments_completed,
      submitted_orders, accepted_orders, installed_orders, paid_orders, canceled_orders, chargebacks,
      no_answer_records, not_interested_records, revisits,
      active_seconds, territory_seconds, outside_territory_seconds, distance_meters,
      inter_door_gap_seconds_total, inter_door_gap_samples, median_seconds_between_doors,
      dwell_seconds_total, dwell_samples, longest_inactive_seconds, inactive_period_count,
      estimated_commission_cents, paid_commission_cents,
      first_activity_at, last_activity_at, assignment_age_seconds, computed_at
    ) VALUES (
      ?,?,?,?,
      ?,?,?,
      ?,?,?,?,?,
      ?,?,
      ?,?,?,?,?,
      ?,?,
      ?,?,?,?,?,?,
      ?,?,?,
      ?,?,?,?,
      ?,?,?,
      ?,?,?,?,
      ?,?,
      ?,?,?, datetime('now')
    )
    ON CONFLICT(tenant_id, rep_id, metric_date) DO UPDATE SET
      timezone = excluded.timezone,
      assigned_doors = excluded.assigned_doors,
      eligible_doors = excluded.eligible_doors,
      do_not_knock_doors = excluded.do_not_knock_doors,
      doors_attempted = excluded.doors_attempted,
      doors_visited = excluded.doors_visited,
      verified_doors = excluded.verified_doors,
      doors_completed = excluded.doors_completed,
      ever_worked_doors = excluded.ever_worked_doors,
      fresh_assigned = excluded.fresh_assigned,
      fresh_attempted = excluded.fresh_attempted,
      contacts = excluded.contacts,
      interested_leads = excluded.interested_leads,
      follow_ups = excluded.follow_ups,
      follow_ups_completed = excluded.follow_ups_completed,
      orders_from_follow_up = excluded.orders_from_follow_up,
      appointments = excluded.appointments,
      appointments_completed = excluded.appointments_completed,
      submitted_orders = excluded.submitted_orders,
      accepted_orders = excluded.accepted_orders,
      installed_orders = excluded.installed_orders,
      paid_orders = excluded.paid_orders,
      canceled_orders = excluded.canceled_orders,
      chargebacks = excluded.chargebacks,
      no_answer_records = excluded.no_answer_records,
      not_interested_records = excluded.not_interested_records,
      revisits = excluded.revisits,
      active_seconds = excluded.active_seconds,
      territory_seconds = excluded.territory_seconds,
      outside_territory_seconds = excluded.outside_territory_seconds,
      distance_meters = excluded.distance_meters,
      inter_door_gap_seconds_total = excluded.inter_door_gap_seconds_total,
      inter_door_gap_samples = excluded.inter_door_gap_samples,
      median_seconds_between_doors = excluded.median_seconds_between_doors,
      dwell_seconds_total = excluded.dwell_seconds_total,
      dwell_samples = excluded.dwell_samples,
      longest_inactive_seconds = excluded.longest_inactive_seconds,
      inactive_period_count = excluded.inactive_period_count,
      estimated_commission_cents = excluded.estimated_commission_cents,
      paid_commission_cents = excluded.paid_commission_cents,
      first_activity_at = excluded.first_activity_at,
      last_activity_at = excluded.last_activity_at,
      assignment_age_seconds = excluded.assignment_age_seconds,
      computed_at = datetime('now')
  `).run(
    tenantId, repId, metricDate, timezone,
    f.assignedDoors, f.eligibleDoors, f.doNotKnockRecords,
    f.doorsAttempted, f.doorsVisited, f.verifiedDoors, f.doorsCompleted, f.everWorkedDoors,
    f.freshAssigned, f.freshAttempted,
    f.contacts, f.interestedLeads, f.followUps, f.followUpsCompleted, f.ordersFromFollowUp,
    f.appointments, f.appointmentsCompleted,
    f.submittedOrders, f.acceptedOrders, f.installedOrders, f.paidOrders, f.canceledOrders, f.chargebacks,
    f.noAnswerRecords, f.notInterestedRecords, f.revisits,
    f.activeSeconds, f.territorySeconds, f.outsideTerritorySeconds, f.distanceMeters,
    f.interDoorGapSecondsTotal, f.interDoorGapSamples,
    f.medianSecondsBetweenDoors == null ? null : Math.round(f.medianSecondsBetweenDoors),
    f.dwellSecondsTotal, f.dwellSamples, f.longestInactiveSeconds, f.inactivePeriodCount,
    f.estimatedCommissionCents, f.paidCommissionCents,
    f.firstActivityAtMs == null ? null : new Date(f.firstActivityAtMs).toISOString(),
    f.lastActivityAtMs == null ? null : new Date(f.lastActivityAtMs).toISOString(),
    f.assignmentAgeSeconds,
  );
}

// ── The dirty queue ──────────────────────────────────────────────────────────

/**
 * Mark a rep-day as needing recomputation.
 *
 * Called from the knock, clock and order write paths. Deliberately a tiny
 * INSERT OR IGNORE and nothing else: the write path's job is to record that
 * something changed, never to compute anything. Every failure is swallowed -
 * a metrics rollup must not be able to fail a rep's disposition save.
 */
export function markRepDayDirty(tenantId: number | null, repId: number, atMs: number = Date.now()): void {
  if (tenantId == null || !Number.isFinite(repId)) return;
  try {
    const date = localDateString(atMs, tenantTimezone(tenantId));
    rawDb.prepare(`
      INSERT OR IGNORE INTO rep_metrics_dirty_days (tenant_id, rep_id, metric_date)
      VALUES (?,?,?)
    `).run(tenantId, repId, date);
  } catch { /* never block the write that triggered this */ }
}

/**
 * Stamp a freshly written knock with the shift it belongs to, and close the
 * matching door arrival to produce dwell time.
 *
 * Called from storage.createKnock AFTER the row is durable. Everything here is
 * best-effort by design: an unstamped shift id costs one metric its precision,
 * while a throw would cost a rep their disposition. That trade is not close.
 *
 * The arrival lookup is deliberately narrow - same rep, same door, still open,
 * and arrived BEFORE the knock. A rep who opened a card, walked away, and came
 * back tomorrow does not get a 19-hour dwell time: an arrival older than
 * MAX_DWELL_SECONDS is left open and expires with retention instead.
 */
export const MAX_DWELL_SECONDS = 45 * 60;

export function attachShiftAndDwell(
  knockId: number, repId: number, leadId: number, knockedAtIso: string,
): void {
  const knockedMs = parseTs(knockedAtIso) ?? Date.now();

  // Which shift was open when this knock happened. Resolved by containment
  // rather than "the newest open session": an offline knock flushing hours
  // later must land in the shift it was TAKEN in, not the one running now.
  try {
    const shift = rawDb.prepare(`
      SELECT id FROM clock_sessions
       WHERE rep_id = ?
         AND replace(clocked_in,'T',' ') <= ?
         AND (clocked_out IS NULL OR replace(clocked_out,'T',' ') >= ?)
       ORDER BY clocked_in DESC LIMIT 1
    `).get(repId, sqlTs(knockedMs), sqlTs(knockedMs)) as any;
    if (shift?.id != null) {
      rawDb.prepare(`UPDATE knock_log SET clock_session_id = ? WHERE id = ?`)
        .run(Number(shift.id), knockId);
    }
  } catch { /* precision only */ }

  try {
    const arrival = rawDb.prepare(`
      SELECT id, arrived_at FROM door_arrivals
       WHERE rep_id = ? AND lead_id = ? AND dispositioned_at IS NULL
         AND replace(arrived_at,'T',' ') <= ?
       ORDER BY arrived_at DESC LIMIT 1
    `).get(repId, leadId, sqlTs(knockedMs)) as any;
    if (!arrival) return;
    const arrivedMs = parseTs(arrival.arrived_at);
    if (arrivedMs == null) return;
    const dwell = Math.round((knockedMs - arrivedMs) / 1000);
    if (dwell < 0 || dwell > MAX_DWELL_SECONDS) return; // left open; see the doc above
    rawDb.prepare(`
      UPDATE door_arrivals
         SET dispositioned_at = ?, knock_id = ?
       WHERE id = ?
    `).run(new Date(knockedMs).toISOString(), knockId, Number(arrival.id));
    rawDb.prepare(`UPDATE knock_log SET dwell_seconds = ? WHERE id = ?`).run(dwell, knockId);
  } catch { /* dwell is optional everywhere it is read */ }
}

export interface DirtyDay { tenantId: number; repId: number; metricDate: string }

export function claimDirtyDays(limit: number): DirtyDay[] {
  try {
    return rawDb.prepare(`
      SELECT tenant_id AS tenantId, rep_id AS repId, metric_date AS metricDate
        FROM rep_metrics_dirty_days
       ORDER BY marked_at ASC
       LIMIT ?
    `).all(limit) as DirtyDay[];
  } catch { return []; }
}

export function clearDirtyDay(d: DirtyDay): void {
  try {
    rawDb.prepare(`
      DELETE FROM rep_metrics_dirty_days
       WHERE tenant_id = ? AND rep_id = ? AND metric_date = ?
    `).run(d.tenantId, d.repId, d.metricDate);
  } catch { /* the row will be retried; harmless */ }
}

export function dirtyDayCount(): number {
  try {
    const r = rawDb.prepare(`SELECT COUNT(*) AS n FROM rep_metrics_dirty_days`).get() as any;
    return Number(r?.n ?? 0);
  } catch { return 0; }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface DailyRow extends RepDailyFacts {
  repId: number;
  metricDate: string;
}

function rowToFacts(r: any): DailyRow {
  return {
    repId: Number(r.rep_id),
    metricDate: String(r.metric_date),
    assignedDoors: Number(r.assigned_doors ?? 0),
    eligibleDoors: Number(r.eligible_doors ?? 0),
    doorsAttempted: Number(r.doors_attempted ?? 0),
    doorsVisited: Number(r.doors_visited ?? 0),
    verifiedDoors: Number(r.verified_doors ?? 0),
    doorsCompleted: Number(r.doors_completed ?? 0),
    everWorkedDoors: Number(r.ever_worked_doors ?? 0),
    freshAssigned: Number(r.fresh_assigned ?? 0),
    freshAttempted: Number(r.fresh_attempted ?? 0),
    contacts: Number(r.contacts ?? 0),
    interestedLeads: Number(r.interested_leads ?? 0),
    followUps: Number(r.follow_ups ?? 0),
    followUpsCompleted: Number(r.follow_ups_completed ?? 0),
    ordersFromFollowUp: Number(r.orders_from_follow_up ?? 0),
    appointments: Number(r.appointments ?? 0),
    appointmentsCompleted: Number(r.appointments_completed ?? 0),
    submittedOrders: Number(r.submitted_orders ?? 0),
    acceptedOrders: Number(r.accepted_orders ?? 0),
    installedOrders: Number(r.installed_orders ?? 0),
    paidOrders: Number(r.paid_orders ?? 0),
    canceledOrders: Number(r.canceled_orders ?? 0),
    chargebacks: Number(r.chargebacks ?? 0),
    doNotKnockRecords: Number(r.do_not_knock_doors ?? 0),
    noAnswerRecords: Number(r.no_answer_records ?? 0),
    notInterestedRecords: Number(r.not_interested_records ?? 0),
    revisits: Number(r.revisits ?? 0),
    activeSeconds: Number(r.active_seconds ?? 0),
    territorySeconds: Number(r.territory_seconds ?? 0),
    outsideTerritorySeconds: Number(r.outside_territory_seconds ?? 0),
    distanceMeters: Number(r.distance_meters ?? 0),
    interDoorGapSecondsTotal: Number(r.inter_door_gap_seconds_total ?? 0),
    interDoorGapSamples: Number(r.inter_door_gap_samples ?? 0),
    medianSecondsBetweenDoors: r.median_seconds_between_doors == null ? null : Number(r.median_seconds_between_doors),
    dwellSecondsTotal: Number(r.dwell_seconds_total ?? 0),
    dwellSamples: Number(r.dwell_samples ?? 0),
    longestInactiveSeconds: Number(r.longest_inactive_seconds ?? 0),
    inactivePeriodCount: Number(r.inactive_period_count ?? 0),
    estimatedCommissionCents: Number(r.estimated_commission_cents ?? 0),
    paidCommissionCents: Number(r.paid_commission_cents ?? 0),
    firstActivityAtMs: parseTs(r.first_activity_at),
    lastActivityAtMs: parseTs(r.last_activity_at),
    assignmentAgeSeconds: r.assignment_age_seconds == null ? null : Number(r.assignment_age_seconds),
  };
}

/**
 * Daily rows for a set of reps over a date range.
 *
 * `repIds` is ALWAYS supplied by the server from the caller's own scope - see
 * liveOpsScope. There is deliberately no "all reps in tenant" mode on this
 * function: a read that defaults to the whole org is a read that leaks the
 * whole org the first time a caller forgets to narrow it.
 */
export function readDailyRows(
  tenantId: number,
  repIds: readonly number[],
  from: string,
  to: string,
  rowCap = 20_000,
): DailyRow[] {
  if (repIds.length === 0) return [];
  const placeholders = repIds.map(() => "?").join(",");
  const rows = rawDb.prepare(`
    SELECT * FROM rep_daily_metrics
     WHERE tenant_id = ?
       AND rep_id IN (${placeholders})
       AND metric_date >= ? AND metric_date <= ?
     ORDER BY metric_date ASC
     LIMIT ?
  `).all(tenantId, ...repIds, from, to, rowCap) as any[];
  return rows.map(rowToFacts);
}

/** One rep's rows, unaggregated - the trend charts read this. */
export function readRepRows(tenantId: number, repId: number, from: string, to: string): DailyRow[] {
  return readDailyRows(tenantId, [repId], from, to);
}

/** Fold a rep's rows into one fact row per rep. */
export function groupByRep(rows: readonly DailyRow[]): Map<number, DailyRow[]> {
  const out = new Map<number, DailyRow[]>();
  for (const r of rows) {
    const list = out.get(r.repId);
    if (list) list.push(r); else out.set(r.repId, [r]);
  }
  return out;
}

export { emptyFacts };

// ── Shared parsing ───────────────────────────────────────────────────────────

/**
 * Parse either timestamp format this codebase writes.
 *
 * ISO strings carry their own zone. SQLite's `datetime('now')` output is UTC
 * with no zone marker, and Date.parse would read it as LOCAL - which on a
 * US-East server shifts every such timestamp by four or five hours and makes
 * every duration computed from it wrong. The 'Z' is appended explicitly.
 */
export function parseTs(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : null;
}
