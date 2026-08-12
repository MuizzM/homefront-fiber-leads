// ── Rep metrics and field performance - schema ───────────────────────────────
//
// WHAT THIS FILE DELIBERATELY DOES NOT CREATE, and why.
//
// The brief asks for `field_shifts`, `field_location_points` and
// `door_visit_events`. All three already exist here under other names, holding
// live production data:
//
//   field_shifts         → `clock_sessions`   (rep, user, tenant, in, out,
//                          duration, date). Already written by /clock, already
//                          referenced by hourly pay and punch corrections.
//   field_location_points → `location_pings`  (extended by liveOpsMigrations
//                          with tenant_id, captured_at, source, speed, heading,
//                          low_confidence and clock_session_id). Already
//                          retention-swept by dbPrune.
//   door_visit_events    → `knock_log`        (lead, rep, outcome, device fix,
//                          server-side distance_m and verification_status).
//
// Creating parallel tables would mean double-writing every knock and every fix,
// and the two copies WOULD diverge - an offline queue flush that lands in one
// and not the other is not a hypothetical, it is the normal failure mode of the
// sync path this feature depends on. Worse, the metrics would then be computed
// from the copy while pay, territory and compliance kept using the original,
// so a rep's dashboard and their commission statement could disagree about
// whether a sale happened.
//
// So the existing tables ARE the event model, extended where they were genuinely
// missing something:
//
//   knock_log.clock_session_id  which shift a door belongs to. Previously
//                               inferred by comparing timestamps, which is
//                               wrong across a missed clock-out.
//   knock_log.dwell_seconds     time on the door, from the arrival event below.
//
// `door_arrivals` IS new, because "the rep walked up to this door" is the one
// event in the brief that nothing currently records, and dwell time cannot be
// computed without it. It is deliberately thin and carries the same retention
// stamp as a location point: an arrival is a position fix in all but name.

import { rawDb } from "./db";
import { VERIFICATION_STATES } from "@shared/repMetrics";
import { INSIGHT_SEVERITIES } from "@shared/coachingInsights";
import { TERRITORY_STATUSES } from "@shared/territoryHealth";

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const VERIFICATION_CHECK = list(VERIFICATION_STATES);
const SEVERITY_CHECK = list(INSIGHT_SEVERITIES);
const TERRITORY_STATUS_CHECK = list(TERRITORY_STATUSES);

/**
 * Additive columns, run one at a time OUTSIDE the transaction.
 *
 * SQLite aborts an entire transaction on a duplicate-column error, so a single
 * already-applied ALTER inside BEGIN IMMEDIATE would roll back every table
 * created alongside it. Same tolerate-per-statement shape as
 * liveOpsMigrations and runMigrations().
 */
const ADDITIVE: readonly string[] = [
  // Which shift a door belongs to. Stamped server-side at knock time from the
  // rep's open session; never client-supplied. Without it, attributing a knock
  // to a shift means comparing timestamps, and a missed clock-out silently
  // attributes the next morning's doors to yesterday's shift.
  `ALTER TABLE knock_log ADD COLUMN clock_session_id INTEGER`,
  // Seconds between arriving at the door and saving the disposition. NULL for
  // every historical row and for any knock with no matching arrival - which is
  // most of them, and is why every dwell metric carries its own sample count
  // rather than assuming the door count is the denominator.
  `ALTER TABLE knock_log ADD COLUMN dwell_seconds INTEGER`,

  // ── Field Activity & Privacy settings, on the policy table that already
  // holds mode/retention/disclosure. Kept on ONE row per tenant so there is a
  // single answer to "what is this org's location policy", and one audit
  // record when it changes.
  `ALTER TABLE field_location_policy ADD COLUMN capture_interval TEXT NOT NULL DEFAULT 'standard'`,
  `ALTER TABLE field_location_policy ADD COLUMN require_acknowledgment INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE field_location_policy ADD COLUMN require_active_shift INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE field_location_policy ADD COLUMN allow_team_lead_live INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE field_location_policy ADD COLUMN allow_manager_live INTEGER NOT NULL DEFAULT 1`,
  // Verification is a LABEL on the record, never a gate on saving it. This
  // setting decides whether an unverified door is flagged for review, and can
  // never decide whether the disposition is accepted - see the write path.
  `ALTER TABLE field_location_policy ADD COLUMN require_location_for_disposition INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE field_location_policy ADD COLUMN grace_radius_m INTEGER NOT NULL DEFAULT 75`,
  `ALTER TABLE field_location_policy ADD COLUMN min_dwell_seconds INTEGER NOT NULL DEFAULT 0`,
  // 0 = supervisors see summarized metrics only, never the raw trail. Ships 0:
  // the brief's default is that historical location is summarized.
  `ALTER TABLE field_location_policy ADD COLUMN raw_trails_visible INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE field_location_policy ADD COLUMN privacy_notice_text TEXT`,
  `ALTER TABLE field_location_policy ADD COLUMN require_reacknowledge_on_change INTEGER NOT NULL DEFAULT 1`,
  // Which denominator the chargeback rate uses. A per-org choice because it
  // changes the number materially - see ChargebackBasis in shared/repMetrics.
  `ALTER TABLE field_location_policy ADD COLUMN chargeback_basis TEXT NOT NULL DEFAULT 'paid'`,
  `ALTER TABLE field_location_policy ADD COLUMN leaderboards_enabled INTEGER NOT NULL DEFAULT 1`,
  // Whether reps may see team medians at all. Off = a rep sees only their own
  // numbers and their own history.
  `ALTER TABLE field_location_policy ADD COLUMN rep_sees_team_benchmarks INTEGER NOT NULL DEFAULT 1`,
];

export function runRepMetricsMigrations(): void {
  for (const sql of ADDITIVE) {
    try {
      rawDb.exec(sql);
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      if (!/duplicate column|already exists|no such table/i.test(msg)) {
        console.warn("[migration] rep-metrics additive:", msg);
      }
    }
  }

  rawDb.exec("BEGIN IMMEDIATE");
  try {
    rawDb.exec(`
      -- ── Door arrivals ──────────────────────────────────────────────────────
      -- The one event the existing model does not have. Written when a rep
      -- opens a door card in Field Mode; consumed when they save a disposition,
      -- which stamps knock_log.dwell_seconds and closes the arrival.
      --
      -- Carries retention_expires_at because it holds a position: an arrival is
      -- a location point with a lead id attached, and it must expire on the
      -- same schedule as location_pings rather than living forever because it
      -- happens to sit in a different table.
      CREATE TABLE IF NOT EXISTS door_arrivals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER,
        rep_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        lead_id INTEGER NOT NULL,
        clock_session_id INTEGER,
        arrived_at TEXT NOT NULL DEFAULT (datetime('now')),
        lat REAL,
        lng REAL,
        accuracy_m REAL,
        distance_from_lead_m REAL,
        verification_status TEXT CHECK(verification_status IS NULL OR verification_status IN (${VERIFICATION_CHECK})),
        -- Idempotency key from the offline queue. A retried flush with the same
        -- client_id updates nothing and creates nothing.
        client_id TEXT,
        dispositioned_at TEXT,
        knock_id INTEGER,
        retention_expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_door_arrivals_client
        ON door_arrivals(tenant_id, client_id) WHERE client_id IS NOT NULL;
      -- The open-arrival lookup the knock write does: newest unclosed arrival
      -- for this rep at this door.
      CREATE INDEX IF NOT EXISTS idx_door_arrivals_open
        ON door_arrivals(rep_id, lead_id, dispositioned_at);
      CREATE INDEX IF NOT EXISTS idx_door_arrivals_retention
        ON door_arrivals(retention_expires_at);

      -- ── Daily rollup ───────────────────────────────────────────────────────
      -- COUNTS AND DURATIONS ONLY. Every rate is derived at read time from
      -- summed numerators and denominators (shared/repMetrics rule 2), which is
      -- why there is no contact_rate column here: storing one would invite a
      -- week's rate to be computed as the mean of seven daily rates, and that
      -- number is wrong in a way nobody notices.
      CREATE TABLE IF NOT EXISTS rep_daily_metrics (
        tenant_id INTEGER NOT NULL,
        rep_id INTEGER NOT NULL,
        metric_date TEXT NOT NULL,          -- 'YYYY-MM-DD' in the org timezone
        timezone TEXT,
        assigned_doors INTEGER NOT NULL DEFAULT 0,
        eligible_doors INTEGER NOT NULL DEFAULT 0,
        do_not_knock_doors INTEGER NOT NULL DEFAULT 0,
        doors_attempted INTEGER NOT NULL DEFAULT 0,
        doors_visited INTEGER NOT NULL DEFAULT 0,
        verified_doors INTEGER NOT NULL DEFAULT 0,
        doors_completed INTEGER NOT NULL DEFAULT 0,
        ever_worked_doors INTEGER NOT NULL DEFAULT 0,
        fresh_assigned INTEGER NOT NULL DEFAULT 0,
        fresh_attempted INTEGER NOT NULL DEFAULT 0,
        contacts INTEGER NOT NULL DEFAULT 0,
        interested_leads INTEGER NOT NULL DEFAULT 0,
        follow_ups INTEGER NOT NULL DEFAULT 0,
        follow_ups_completed INTEGER NOT NULL DEFAULT 0,
        orders_from_follow_up INTEGER NOT NULL DEFAULT 0,
        appointments INTEGER NOT NULL DEFAULT 0,
        appointments_completed INTEGER NOT NULL DEFAULT 0,
        submitted_orders INTEGER NOT NULL DEFAULT 0,
        accepted_orders INTEGER NOT NULL DEFAULT 0,
        installed_orders INTEGER NOT NULL DEFAULT 0,
        paid_orders INTEGER NOT NULL DEFAULT 0,
        canceled_orders INTEGER NOT NULL DEFAULT 0,
        chargebacks INTEGER NOT NULL DEFAULT 0,
        no_answer_records INTEGER NOT NULL DEFAULT 0,
        not_interested_records INTEGER NOT NULL DEFAULT 0,
        revisits INTEGER NOT NULL DEFAULT 0,
        active_seconds INTEGER NOT NULL DEFAULT 0,
        territory_seconds INTEGER NOT NULL DEFAULT 0,
        outside_territory_seconds INTEGER NOT NULL DEFAULT 0,
        distance_meters INTEGER NOT NULL DEFAULT 0,
        -- Sum + sample count, so a period average is a true weighted average
        -- and not a mean of daily means.
        inter_door_gap_seconds_total INTEGER NOT NULL DEFAULT 0,
        inter_door_gap_samples INTEGER NOT NULL DEFAULT 0,
        median_seconds_between_doors INTEGER,
        dwell_seconds_total INTEGER NOT NULL DEFAULT 0,
        dwell_samples INTEGER NOT NULL DEFAULT 0,
        longest_inactive_seconds INTEGER NOT NULL DEFAULT 0,
        inactive_period_count INTEGER NOT NULL DEFAULT 0,
        estimated_commission_cents INTEGER NOT NULL DEFAULT 0,
        paid_commission_cents INTEGER NOT NULL DEFAULT 0,
        first_activity_at TEXT,
        last_activity_at TEXT,
        assignment_age_seconds INTEGER,
        computed_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (tenant_id, rep_id, metric_date)
      );
      -- The team table's query: one tenant, one date window, every rep.
      CREATE INDEX IF NOT EXISTS idx_rep_daily_metrics_tenant_date
        ON rep_daily_metrics(tenant_id, metric_date DESC);
      -- The rep's own trend query: one rep, ordered by date.
      CREATE INDEX IF NOT EXISTS idx_rep_daily_metrics_rep_date
        ON rep_daily_metrics(rep_id, metric_date DESC);

      -- ── Territory rollup ───────────────────────────────────────────────────
      -- Same reasoning as above, one row per territory per day. Lets the
      -- territory board render from an indexed read instead of re-aggregating
      -- every lead in the org on each request.
      CREATE TABLE IF NOT EXISTS territory_daily_metrics (
        tenant_id INTEGER NOT NULL,
        territory_id INTEGER NOT NULL,
        metric_date TEXT NOT NULL,
        eligible_doors INTEGER NOT NULL DEFAULT 0,
        assigned_doors INTEGER NOT NULL DEFAULT 0,
        unassigned_doors INTEGER NOT NULL DEFAULT 0,
        doors_attempted INTEGER NOT NULL DEFAULT 0,
        verified_visits INTEGER NOT NULL DEFAULT 0,
        ever_worked_doors INTEGER NOT NULL DEFAULT 0,
        contacts INTEGER NOT NULL DEFAULT 0,
        submitted_orders INTEGER NOT NULL DEFAULT 0,
        installed_orders INTEGER NOT NULL DEFAULT 0,
        paid_orders INTEGER NOT NULL DEFAULT 0,
        fresh_assigned INTEGER NOT NULL DEFAULT 0,
        fresh_attempted INTEGER NOT NULL DEFAULT 0,
        active_rep_count INTEGER NOT NULL DEFAULT 0,
        callbacks_due INTEGER NOT NULL DEFAULT 0,
        open_recovery_cases INTEGER NOT NULL DEFAULT 0,
        estimated_commission_cents INTEGER NOT NULL DEFAULT 0,
        paid_commission_cents INTEGER NOT NULL DEFAULT 0,
        last_activity_at TEXT,
        assigned_at TEXT,
        status TEXT CHECK(status IS NULL OR status IN (${TERRITORY_STATUS_CHECK})),
        reclaim_recommended INTEGER NOT NULL DEFAULT 0,
        reclaim_rationale TEXT,
        computed_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (tenant_id, territory_id, metric_date)
      );
      CREATE INDEX IF NOT EXISTS idx_territory_daily_metrics_tenant_date
        ON territory_daily_metrics(tenant_id, metric_date DESC);

      -- ── Coaching insights ──────────────────────────────────────────────────
      -- One row per (rep, insight_type, period). Regenerating a period UPDATES
      -- rather than appends, so a dismissal is not undone by the next run and
      -- the list does not grow by thirteen rows every night.
      CREATE TABLE IF NOT EXISTS rep_coaching_insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        rep_id INTEGER NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        insight_type TEXT NOT NULL,
        severity TEXT NOT NULL CHECK(severity IN (${SEVERITY_CHECK})),
        title TEXT NOT NULL,
        explanation TEXT NOT NULL,
        suggested_action TEXT NOT NULL,
        supporting_metrics_json TEXT,
        data_link TEXT,
        acknowledged_at TEXT,
        dismissed_at TEXT,
        dismissed_by_user_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rep_coaching_insights_key
        ON rep_coaching_insights(tenant_id, rep_id, insight_type, period_start, period_end);
      CREATE INDEX IF NOT EXISTS idx_rep_coaching_insights_open
        ON rep_coaching_insights(tenant_id, dismissed_at, severity);

      -- ── Coaching notes and goals ───────────────────────────────────────────
      -- A supervisor's own record. shared_with_rep ships 0: the brief says a
      -- manager's note is not visible to the rep unless explicitly shared, and
      -- defaulting the other way would retroactively publish notes written on
      -- the assumption of privacy.
      CREATE TABLE IF NOT EXISTS rep_coaching_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        rep_id INTEGER NOT NULL,
        author_user_id INTEGER NOT NULL,
        insight_id INTEGER,
        body TEXT NOT NULL,
        shared_with_rep INTEGER NOT NULL DEFAULT 0,
        -- A goal turns a note into something measurable: which metric, what
        -- target, by when.
        goal_metric TEXT,
        goal_target REAL,
        goal_due_date TEXT,
        goal_status TEXT NOT NULL DEFAULT 'open' CHECK(goal_status IN ('open','met','missed','canceled')),
        review_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rep_coaching_notes_rep
        ON rep_coaching_notes(tenant_id, rep_id, created_at DESC);

      -- ── Territory reclaim reviews ──────────────────────────────────────────
      -- The audit record the brief requires: a recommendation, and what a human
      -- decided about it. Nothing writes here automatically; a row exists only
      -- because somebody with the capability made a decision.
      CREATE TABLE IF NOT EXISTS territory_reclaim_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        territory_id INTEGER NOT NULL,
        recommended_at TEXT NOT NULL,
        rationale TEXT NOT NULL,
        supporting_metrics_json TEXT,
        decision TEXT CHECK(decision IS NULL OR decision IN ('reclaimed','reassigned','kept','deferred')),
        decided_by_user_id INTEGER,
        decided_at TEXT,
        decision_note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_territory_reclaim_reviews_open
        ON territory_reclaim_reviews(tenant_id, decision, recommended_at DESC);

      -- ── Rollup cursor ──────────────────────────────────────────────────────
      -- Which rep-days are known dirty, so the aggregator recomputes exactly
      -- what changed instead of re-scanning the org every night. Written by the
      -- knock/clock/order write paths; drained by the background job.
      CREATE TABLE IF NOT EXISTS rep_metrics_dirty_days (
        tenant_id INTEGER NOT NULL,
        rep_id INTEGER NOT NULL,
        metric_date TEXT NOT NULL,
        marked_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (tenant_id, rep_id, metric_date)
      );
      CREATE INDEX IF NOT EXISTS idx_rep_metrics_dirty_marked
        ON rep_metrics_dirty_days(marked_at);

      CREATE TABLE IF NOT EXISTS rep_metrics_state (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    rawDb.exec("COMMIT");
  } catch (e) {
    try { rawDb.exec("ROLLBACK"); } catch { /* already unwound */ }
    throw e;
  }
}
