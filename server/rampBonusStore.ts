// ── Ramp bonus — counting a new hire's training day, and paying it once ─────
// The decision is pure and lives in shared/rampBonus.ts. This file supplies the
// counters and records the awards:
//
//   ramp:D2026-08-06:rep:12      one qualifying training day  ($50)
//   ramp-complete:rep:12         finishing the curriculum, once ever
//
// Both keys go in the UNIQUE-indexed `sale_ref` column, so the second review
// batch of the day re-evaluates the same day and the insert is ignored. Awards
// ride the existing spiff ledger, which is what puts them on the rep's
// commission statement without a new money path to reconcile.
//
// ── TWO IDENTITIES, AND WHY BOTH ARE HERE ───────────────────────────────────
// The training tables are keyed by USER id (that is who logs in and drills);
// the money ledger is keyed by REP id (team_members — that is who gets paid).
// Every function here takes both rather than looking one up from the other,
// because the caller already holds both on the session and a lookup would be a
// place for them to silently disagree.
//
// ── THE CLOCK, AGAIN ────────────────────────────────────────────────────────
// `training_review_log.reviewed_at` is the CLIENT clock by design — an offline
// review keeps the time the rep actually did it. That makes it the right clock
// for bucketing a day and the wrong one for proving a drill took real minutes.
// So the span check uses the same rule as the door bonus: a review the server
// received live is timed by the server clock, and only one that genuinely sat
// in the outbox falls back to its own. See server/genuineDoorBonusStore.ts for
// the full argument.

import { rawDb } from "./db";
import { storage } from "./storage";
import {
  DEFAULT_RAMP_BONUS_CONFIG, evaluateRampDay, evaluateTrainingCompletion, isRampRep,
  rampCeilingCentsPerHire, validateRampConfig,
  type RampBonusConfig, type RampDecision, type CompletionDecision,
} from "@shared/rampBonus";
import { TRAINING_MODULES } from "@shared/trainingContent";
import { DEFAULT_WORKWEEK, localWallToUtcMs, localYmdParts } from "@shared/workweek";

const CONFIG_SETTING = "spiff.ramp_bonus";
const DAY_PREFIX = "ramp:";
const COMPLETE_PREFIX = "ramp-complete:";

/** Same five-minute line the door bonus draws between a live submission and an
 *  offline flush. */
const SYNC_GRACE_MS = 5 * 60_000;

/** Lessons in the curriculum. Computed once — the content module is frozen. */
let LESSON_TOTAL = 0;
export function curriculumLessonCount(): number {
  if (LESSON_TOTAL === 0) {
    LESSON_TOTAL = TRAINING_MODULES.reduce((n, m) => n + (m.lessons?.length ?? 0), 0);
  }
  return LESSON_TOTAL;
}

function orgTimezone(tenantId: number): string {
  try {
    const row = rawDb.prepare(`SELECT commission_timezone AS tz FROM tenants WHERE id = ?`).get(tenantId) as any;
    return row?.tz || DEFAULT_WORKWEEK.timezone;
  } catch { return DEFAULT_WORKWEEK.timezone; }
}

/** The training tables normalize a missing tenant to 0 so their UNIQUE
 *  conflict targets are real (SQLite treats NULLs as distinct) — the
 *  training_progress convention, mirrored here so the counters read the same
 *  rows the engine wrote. */
function ttid(tenantId: number | null | undefined): number {
  return tenantId ?? 0;
}

export function localDay(tenantId: number, nowMs: number): {
  startIso: string; endIso: string; key: string; label: string; startMs: number;
} {
  const tz = orgTimezone(tenantId);
  const { y, mo, d } = localYmdParts(nowMs, tz);
  const label = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const startMs = localWallToUtcMs(y, mo, d, 0, 0, tz);
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(startMs + 86_400_000).toISOString(),
    key: `D${label}`, label, startMs,
  };
}

export function getRampConfig(tenantId: number): RampBonusConfig {
  try {
    const raw = storage.getSetting(CONFIG_SETTING, tenantId);
    if (!raw) return DEFAULT_RAMP_BONUS_CONFIG;
    const parsed = JSON.parse(raw);
    if (validateRampConfig({ ...DEFAULT_RAMP_BONUS_CONFIG, ...parsed })) return DEFAULT_RAMP_BONUS_CONFIG;
    return { ...DEFAULT_RAMP_BONUS_CONFIG, ...parsed };
  } catch { return DEFAULT_RAMP_BONUS_CONFIG; }
}

export function setRampConfig(tenantId: number, actorId: number | null, cfg: RampBonusConfig): RampBonusConfig {
  const merged = { ...DEFAULT_RAMP_BONUS_CONFIG, ...cfg };
  const problem = validateRampConfig(merged);
  if (problem) throw Object.assign(new Error(problem), { httpStatus: 400 });
  storage.setSetting(CONFIG_SETTING, JSON.stringify(merged), actorId, tenantId);
  storage.logActivity(actorId, "incentive.ramp.configured", "tenant", tenantId, {
    enabled: merged.enabled, windowDays: merged.windowDays, rewardCents: merged.rewardCents,
    minCardsPerDay: merged.minCardsPerDay, completionRewardCents: merged.completionRewardCents,
    ceilingPerHireCents: rampCeilingCentsPerHire(merged),
  }, undefined);
  return merged;
}

// ── The two timestamp formats, and why every query here carries a strftime ──
// This codebase stores timestamps two ways (see server/sqlTime.ts for the full
// account): ISO from JS (`2026-08-06T13:28:23.283Z`) and SQLite's own default
// (`2026-08-06 13:28:23`). TEXT compares lexicographically, and 'T' (0x54)
// sorts after ' ' (0x20), so an ISO day bound tested against a SQLite-format
// column is not slightly wrong — it is wrong for the whole day.
//
// `training_review_log.reviewed_at` is ISO (the route normalizes it);
// `created_at` and `training_progress.completed_at` are SQLite-format. So both
// of those are folded into the ISO shape before they are compared or parsed.
// `%f` emits SS.SSS, which lines up with toISOString() exactly.
//
// sqlTime.ts warns that a function on a COLUMN discards the index. It does not
// bite here: every one of these queries is already pinned to one (tenant, user)
// by an equality match on the leading index columns, so the strftime only runs
// over that rep's own handful of rows.
const ISO = (col: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${col})`;

/** Where a rep's hire date came from — carried to the API so nobody has to
 *  guess which clock a ramp window is running on. */
export type HireDateSource =
  | "portal_activation"
  | "last_signature"
  | "roster_created"
  /** Has a packet, has not finished it. Not hired yet — no clock runs. */
  | "not_activated";

export interface HireDate {
  iso: string | null;
  source: HireDateSource | null;
}

/**
 * When did this rep actually start?
 *
 * `team_members.created_at` is the wrong answer, and the gap is not academic:
 * the roster row is written when the agreement packet is ISSUED. A rep who
 * takes nine days to sign has nine days of a fourteen-day ramp window burned
 * before they could log in once.
 *
 * The onboarding pipeline already records the real moment. `syncRepActivation`
 * (server/onboardingPipeline.ts) fires only when EVERY required document is
 * `completed`; it flips `team_members.active` and stamps
 * `rep_applications.activated_at` under a COALESCE, so the value is the FIRST
 * activation and never moves afterwards. Signed and able to log in — that is a
 * start date, and in the live data it lands within a second of the last
 * signature.
 *
 * Resolution order, each a genuinely different situation:
 *
 *   portal_activation  the pipeline completed. The real answer.
 *   last_signature     every document is signed but no application row carries
 *                      the stamp (a rep created by hand, an application that
 *                      predates the field). The packet still says when they
 *                      finished.
 *   roster_created     neither exists — a rep who predates the pipeline
 *                      entirely. Falls back to the old behaviour rather than
 *                      refusing to give them a ramp window at all.
 */
export function hireDateFor(tenantId: number, repId: number): HireDate {
  // The same join the pipeline itself uses to find a rep's application, so the
  // two cannot disagree about which application belongs to which rep.
  const activated = rawDb.prepare(
    `SELECT a.activated_at AS at
       FROM rep_applications a
       JOIN users u ON u.id = a.user_id
      WHERE a.tenant_id = ? AND u.team_member_id = ? AND a.activated_at IS NOT NULL
      ORDER BY a.id DESC LIMIT 1`,
  ).get(tenantId, repId) as any;
  if (activated?.at) return { iso: String(activated.at), source: "portal_activation" };

  // No stamp: fall back to the packet. Only `completed` documents count — a
  // `delivered` one is paperwork sitting in an inbox, not a start date.
  const signed = rawDb.prepare(
    `SELECT MAX(${ISO("completed_at")}) AS at
       FROM onboarding_signing_documents
      WHERE tenant_id = ? AND rep_id = ? AND status = 'completed' AND completed_at IS NOT NULL`,
  ).get(tenantId, repId) as any;
  if (signed?.at) return { iso: String(signed.at), source: "last_signature" };

  // Before falling back to the roster row, ask whether this rep went through
  // the pipeline AT ALL. One that did — a packet issued, documents sitting in
  // an inbox — has not started; they cannot even log in (syncRepActivation is
  // what flips `active`). Handing them the roster date would start the ramp
  // clock on the day the packet was ISSUED, which is the exact failure this
  // function exists to remove, just wearing a different hat: a rep who signs
  // nine days later would open the app already on day ten.
  //
  // So they get no clock. It starts when they activate.
  const packet = rawDb.prepare(
    `SELECT
       (SELECT COUNT(*) FROM rep_applications a JOIN users u ON u.id = a.user_id
         WHERE a.tenant_id = ? AND u.team_member_id = ?) AS applications,
       (SELECT COUNT(*) FROM onboarding_signing_documents
         WHERE tenant_id = ? AND rep_id = ?) AS documents`,
  ).get(tenantId, repId, tenantId, repId) as any;
  if (Number(packet?.applications ?? 0) > 0 || Number(packet?.documents ?? 0) > 0) {
    return { iso: null, source: "not_activated" };
  }

  // No packet anywhere: a rep who predates the onboarding pipeline, or one an
  // admin created by hand. The roster row is the only date that exists.
  const roster = rawDb.prepare(
    `SELECT ${ISO("created_at")} AS at FROM team_members WHERE id = ? AND tenant_id = ?`,
  ).get(repId, tenantId) as any;
  if (roster?.at) return { iso: String(roster.at), source: "roster_created" };

  return { iso: null, source: null };
}

/**
 * 1-based day of tenure in the org's local calendar; 0 when the hire date is
 * unknown or still in the future.
 *
 * Both ends are snapped to LOCAL midnight before the subtraction, so a rep
 * activated at 11pm is on day 2 the next morning rather than 26 hours into
 * "day 1" — the ramp is counted in days worked, not in elapsed hours.
 */
export function tenureDay(tenantId: number, repId: number, nowMs: number): number {
  const hired = hireDateFor(tenantId, repId);
  const hiredMs = hired.iso ? Date.parse(hired.iso) : NaN;
  if (!Number.isFinite(hiredMs)) return 0;

  const tz = orgTimezone(tenantId);
  const h = localYmdParts(hiredMs, tz);
  const n = localYmdParts(nowMs, tz);
  const hireMidnight = localWallToUtcMs(h.y, h.mo, h.d, 0, 0, tz);
  const todayMidnight = localWallToUtcMs(n.y, n.mo, n.d, 0, 0, tz);
  const days = Math.round((todayMidnight - hireMidnight) / 86_400_000);
  return days < 0 ? 0 : days + 1;
}

interface RawReview {
  cardId: string;
  reviewedAt: string;
  createdAt: string | null;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};


/** Today's reviews, bucketed by the CLIENT day (so an offline drill counts on
 *  the day it happened, matching the streak the coach summary already shows). */
function reviewsToday(userId: number, tenantId: number | null | undefined, day: { startIso: string; endIso: string }): RawReview[] {
  return rawDb.prepare(
    `SELECT card_id AS cardId, reviewed_at AS reviewedAt, ${ISO("created_at")} AS createdAt
       FROM training_review_log
      WHERE tenant_id = ? AND user_id = ? AND reviewed_at >= ? AND reviewed_at < ?
      ORDER BY reviewed_at ASC`,
  ).all(ttid(tenantId), userId, day.startIso, day.endIso) as RawReview[];
}

/** Distinct cards drilled, and how long the drilling actually took. Ten
 *  re-grades of one card is one card; ten cards inside forty seconds is not a
 *  drill. */
export function summarizeReviews(rows: RawReview[]): { distinctCards: number; spanMinutes: number } {
  const cards = new Set<string>();
  const times: number[] = [];
  for (const r of rows) {
    if (r.cardId) cards.add(r.cardId);
    const deviceMs = ms(r.reviewedAt);
    const serverMs = ms(r.createdAt);
    // Live submission → the server's clock. Genuine outbox flush → the device's.
    if (serverMs != null && (deviceMs == null || serverMs - deviceMs <= SYNC_GRACE_MS)) times.push(serverMs);
    else if (deviceMs != null) times.push(deviceMs);
  }
  if (times.length === 0) return { distinctCards: cards.size, spanMinutes: 0 };
  times.sort((a, b) => a - b);
  return {
    distinctCards: cards.size,
    spanMinutes: Math.floor((times[times.length - 1] - times[0]) / 60_000),
  };
}

function lessonsCompletedToday(userId: number, tenantId: number | null | undefined, day: { startIso: string; endIso: string }): number {
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM training_progress
      WHERE tenant_id = ? AND user_id = ?
        AND ${ISO("completed_at")} >= ? AND ${ISO("completed_at")} < ?`,
  ).get(ttid(tenantId), userId, day.startIso, day.endIso) as any;
  return Number(row?.n ?? 0);
}

function lessonsCompletedTotal(userId: number, tenantId: number | null | undefined): number {
  const row = rawDb.prepare(
    `SELECT COUNT(DISTINCT lesson_id) AS n FROM training_progress WHERE tenant_id = ? AND user_id = ?`,
  ).get(ttid(tenantId), userId) as any;
  return Number(row?.n ?? 0);
}

function dueRemaining(userId: number, tenantId: number | null | undefined, nowIso: string): number {
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM training_card_state
      WHERE tenant_id = ? AND user_id = ? AND due_at IS NOT NULL AND due_at <= ?`,
  ).get(ttid(tenantId), userId, nowIso) as any;
  return Number(row?.n ?? 0);
}

export interface RampIdentity {
  tenantId: number;
  /** Who logs in and drills — the training tables' key. */
  userId: number;
  /** Who gets paid — the ledger's key. */
  repId: number;
}

export interface RampEvaluation {
  decision: RampDecision;
  completion: CompletionDecision;
  tenureDay: number;
  dayKey: string;
  dayLabel: string;
  distinctCardsToday: number;
  lessonsCompleted: number;
  lessonsTotal: number;
}

/** Evaluate without writing. Shared by the award path and the rep's card, so
 *  the bar the card promises is the bar the ledger pays. */
export function evaluateRampForRep(id: RampIdentity, nowMs: number): RampEvaluation {
  const cfg = getRampConfig(id.tenantId);
  const day = localDay(id.tenantId, nowMs);
  const tenure = tenureDay(id.tenantId, id.repId, nowMs);
  const reviews = summarizeReviews(reviewsToday(id.userId, id.tenantId, day));
  const lessonsToday = lessonsCompletedToday(id.userId, id.tenantId, day);
  const lessonsDone = lessonsCompletedTotal(id.userId, id.tenantId);
  const due = dueRemaining(id.userId, id.tenantId, new Date(nowMs).toISOString());

  return {
    decision: evaluateRampDay({
      tenureDay: tenure,
      distinctCardsToday: reviews.distinctCards,
      lessonsCompletedToday: lessonsToday,
      dueRemaining: due,
      spanMinutes: reviews.spanMinutes,
    }, cfg),
    completion: evaluateTrainingCompletion({
      lessonsCompleted: lessonsDone,
      lessonsTotal: curriculumLessonCount(),
      tenureDay: tenure,
    }, cfg),
    tenureDay: tenure,
    dayKey: day.key,
    dayLabel: day.label,
    distinctCardsToday: reviews.distinctCards,
    lessonsCompleted: lessonsDone,
    lessonsTotal: curriculumLessonCount(),
  };
}

export interface RampAward {
  kind: "day" | "completion";
  amountCents: number;
  reason: string;
  /** False when the award already existed — a retry, not a second payment. */
  inserted: boolean;
}

function book(
  tenantId: number, repId: number, key: string, amountCents: number, reason: string, nowMs: number,
): boolean {
  const info = rawDb.prepare(
    `INSERT OR IGNORE INTO spiffs (tenant_id, rep_id, sale_ref, amount_cents, reason, status, created_at)
     VALUES (?,?,?,?,?,'earned',?)`,
  ).run(tenantId, repId, key, amountCents, reason, new Date(nowMs).toISOString());
  return info.changes === 1;
}

/**
 * Evaluate and book whatever this rep has newly earned from training.
 *
 * Called after every review batch and every lesson completion, so a rep is told
 * the moment they finish. Safe to call as often as you like: the unique index
 * stops a double award, not the caller's discipline.
 */
export function awardRampForRep(id: RampIdentity, nowMs: number): RampAward[] {
  const cfg = getRampConfig(id.tenantId);
  const out: RampAward[] = [];
  const evaluation = evaluateRampForRep(id, nowMs);

  if (cfg.enabled !== false && evaluation.decision.qualifies) {
    const key = `${DAY_PREFIX}${evaluation.dayKey}:rep:${id.repId}`;
    const inserted = book(id.tenantId, id.repId, key, evaluation.decision.awardCents, evaluation.decision.reason, nowMs);
    if (inserted) {
      storage.logActivity(null, "incentive.ramp.day_awarded", "team_member", id.repId, {
        amountCents: evaluation.decision.awardCents, tenureDay: evaluation.tenureDay,
        distinctCards: evaluation.distinctCardsToday, day: evaluation.dayLabel, idemKey: key,
      }, undefined);
    }
    out.push({ kind: "day", amountCents: evaluation.decision.awardCents, reason: evaluation.decision.reason, inserted });
  }

  // Finishing pays whether or not the daily bonus is on: a rep who completes
  // the curriculum in week five still finished it.
  if (evaluation.completion.qualifies) {
    const key = `${COMPLETE_PREFIX}rep:${id.repId}`;
    const inserted = book(id.tenantId, id.repId, key, evaluation.completion.awardCents, evaluation.completion.reason, nowMs);
    if (inserted) {
      storage.logActivity(null, "incentive.ramp.completion_awarded", "team_member", id.repId, {
        amountCents: evaluation.completion.awardCents,
        baseCents: evaluation.completion.baseCents, kickerCents: evaluation.completion.kickerCents,
        tenureDay: evaluation.tenureDay, lessons: evaluation.lessonsTotal, idemKey: key,
      }, undefined);
    }
    out.push({ kind: "completion", amountCents: evaluation.completion.awardCents, reason: evaluation.completion.reason, inserted });
  }

  return out;
}

/** Has this rep already been paid for finishing? Read by the card so a rep who
 *  finished last month sees "earned", not a bonus dangled a second time. */
function completionPaid(tenantId: number, repId: number): boolean {
  const row = rawDb.prepare(
    `SELECT 1 AS x FROM spiffs WHERE tenant_id = ? AND sale_ref = ? LIMIT 1`,
  ).get(tenantId, `${COMPLETE_PREFIX}rep:${repId}`) as any;
  return !!row;
}

function paidDaysThisWindow(tenantId: number, repId: number): number {
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM spiffs
      WHERE tenant_id = ? AND rep_id = ? AND status IN ('earned','approved','paid')
        AND sale_ref LIKE ?`,
  ).get(tenantId, repId, `${DAY_PREFIX}%:rep:${repId}`) as any;
  return Number(row?.n ?? 0);
}

/** What the rep sees. A rep past the window with the curriculum finished gets
 *  `visible: false` and the client renders nothing — never a bonus that cannot
 *  be earned. */
export function repRampCard(id: RampIdentity, nowMs: number) {
  const cfg = getRampConfig(id.tenantId);
  const e = evaluateRampForRep(id, nowMs);
  const finished = completionPaid(id.tenantId, id.repId);
  const inWindow = isRampRep(e.tenureDay, cfg);

  return {
    visible: (cfg.enabled !== false && inWindow) || (cfg.completionEnabled !== false && !finished && e.lessonsTotal > 0),
    inWindow,
    tenureDay: e.tenureDay,
    // Which clock this window is running on. A rep asking "why does it say day
    // 9?" deserves an answer, and an admin needs to see when a ramp is being
    // measured from a roster row rather than a real activation.
    hiredAt: hireDateFor(id.tenantId, id.repId),
    windowDays: cfg.windowDays,
    daysLeft: e.decision.daysLeft,
    rewardCents: cfg.rewardCents,
    earnedToday: e.decision.qualifies,
    blockedBy: e.decision.blockedBy,
    headline: e.decision.headline,
    cardsToday: e.distinctCardsToday,
    minCardsPerDay: cfg.minCardsPerDay,
    daysPaid: paidDaysThisWindow(id.tenantId, id.repId),
    completion: {
      enabled: cfg.completionEnabled !== false,
      paid: finished,
      lessonsCompleted: e.lessonsCompleted,
      lessonsTotal: e.lessonsTotal,
      remaining: e.completion.lessonsRemaining,
      awardCents: e.completion.baseCents + (inWindow ? e.completion.kickerCents : 0),
      headline: finished ? "Training finished" : e.completion.headline,
    },
  };
}

/** What the ramp is costing the org, and what it could cost: every rep still
 *  inside their window, times the per-hire ceiling. */
export function rampExposure(tenantId: number, nowMs: number) {
  const cfg = getRampConfig(tenantId);
  const spent = rawDb.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS s, COUNT(*) AS n FROM spiffs
      WHERE tenant_id = ? AND status IN ('earned','approved','paid')
        AND (sale_ref LIKE ? OR sale_ref LIKE ?)`,
  ).get(tenantId, `${DAY_PREFIX}%`, `${COMPLETE_PREFIX}%`) as any;

  // Reps whose hire date still falls inside the window. Computed in the org's
  // timezone one rep at a time rather than in SQL, because "14 local days ago"
  // is not something SQLite can work out for a named zone.
  const reps = rawDb.prepare(
    `SELECT id FROM team_members WHERE tenant_id = ? AND active = 1`,
  ).all(tenantId) as Array<{ id: number }>;
  const inWindow = reps.filter(r => isRampRep(tenureDay(tenantId, r.id, nowMs), cfg)).length;

  return {
    enabled: cfg.enabled,
    windowDays: cfg.windowDays,
    perHireCeilingCents: rampCeilingCentsPerHire(cfg),
    repsInWindow: inWindow,
    awardedCents: Number(spent?.s ?? 0),
    awardCount: Number(spent?.n ?? 0),
    worstCaseCents: rampCeilingCentsPerHire(cfg) * inWindow,
  };
}
