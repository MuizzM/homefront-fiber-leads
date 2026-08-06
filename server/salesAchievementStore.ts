// ── Sales achievements — counting sales, and paying each rung once ──────────
// The ladder is pure and lives in shared/salesAchievements.ts. This file counts
// the sales and books the awards:
//
//   achv:D2026-08-06:rep:12:day:2    "2 sales in a day", once per local day
//   achv:rep:12:career:50            "50 career sales", once ever
//
// Both keys ride the UNIQUE-indexed `sale_ref` column on the existing spiff
// ledger, so the third sale of the day re-proposes the 2-sale rung and the
// insert is ignored — and the award lands on the rep's commission statement
// with no new money path to reconcile.
//
// ── WHAT COUNTS AS A SALE, AND WHY THAT QUESTION IS ALREADY ANSWERED ────────
// A QUALIFIED row in `commission_sales`, which is the same definition the
// commission statement itself pays on. That matters more than it looks:
//
//   * one row per DOOR (external_id is the lead), so re-marking a house sold
//     cannot mint a second sale;
//   * the sale's owner and pay-week FREEZE once qualified, so a teammate
//     re-knocking a sold door cannot steal the credit or re-time it;
//   * `sold_at` is placed by SERVER-RECEIVED time, clamped to the correction
//     window, so a backdated client clock cannot move a sale into a day where
//     it would clear a rung.
//
// All three guards live in commissionService.recordFieldSaleFromKnock. Reusing
// that table instead of counting `outcome = 'sold'` knocks is what makes this
// ladder inherit every one of them for free.
//
// A sale reversed later drops out of the counts, but a rung it already paid
// stays booked as `earned` — an admin approves before it reaches payroll (see
// sumWeekSpiffsByRep), which is the right place for a human to unwind it.

import { rawDb } from "./db";
import { storage } from "./storage";
import {
  DEFAULT_SALES_ACHIEVEMENT_CONFIG, achievementCeilingCents, achievementProgress,
  achievementsCleared, normalizeAchievementConfig, validateAchievementConfig,
  type AchievementAward, type SalesAchievementConfig,
} from "@shared/salesAchievements";
import { isRampRep } from "@shared/rampBonus";
import { getRampConfig, localDay, tenureDay } from "./rampBonusStore";

const CONFIG_SETTING = "spiff.sales_achievements";
const PREFIX = "achv:";

export function getAchievementConfig(tenantId: number): SalesAchievementConfig {
  try {
    const raw = storage.getSetting(CONFIG_SETTING, tenantId);
    if (!raw) return DEFAULT_SALES_ACHIEVEMENT_CONFIG;
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_SALES_ACHIEVEMENT_CONFIG, ...parsed };
    // A malformed stored value falls back rather than throwing — a bad settings
    // row must never be able to break a sale.
    if (validateAchievementConfig(merged)) return DEFAULT_SALES_ACHIEVEMENT_CONFIG;
    return normalizeAchievementConfig(merged);
  } catch { return DEFAULT_SALES_ACHIEVEMENT_CONFIG; }
}

export function setAchievementConfig(
  tenantId: number, actorId: number | null, cfg: SalesAchievementConfig,
): SalesAchievementConfig {
  const merged = { ...DEFAULT_SALES_ACHIEVEMENT_CONFIG, ...cfg };
  const problem = validateAchievementConfig(merged);
  if (problem) throw Object.assign(new Error(problem), { httpStatus: 400 });
  const norm = normalizeAchievementConfig(merged);
  storage.setSetting(CONFIG_SETTING, JSON.stringify(norm), actorId, tenantId);
  storage.logActivity(actorId, "incentive.achievements.configured", "tenant", tenantId, {
    enabled: norm.enabled, daily: norm.daily, career: norm.career,
    excludeRampReps: norm.excludeRampReps, maxCentsPerRepPerDay: norm.maxCentsPerRepPerDay,
    perRepDailyCeilingCents: achievementCeilingCents(norm),
  }, undefined);
  return norm;
}

/** QUALIFIED sales in the org's local day. */
function dailySales(tenantId: number, repId: number, startIso: string, endIso: string): number {
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM commission_sales
      WHERE tenant_id = ? AND rep_id = ? AND status = 'QUALIFIED'
        AND sold_at >= ? AND sold_at < ?`,
  ).get(tenantId, repId, startIso, endIso) as any;
  return Number(row?.n ?? 0);
}

/** Lifetime QUALIFIED sales. */
function careerSales(tenantId: number, repId: number): number {
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM commission_sales
      WHERE tenant_id = ? AND rep_id = ? AND status = 'QUALIFIED'`,
  ).get(tenantId, repId) as any;
  return Number(row?.n ?? 0);
}

/** Achievement cents this rep already banked today — what makes the daily cap
 *  hold ACROSS calls rather than only inside one evaluation. */
function achievementCentsToday(tenantId: number, repId: number, startIso: string, endIso: string): number {
  const row = rawDb.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM spiffs
      WHERE tenant_id = ? AND rep_id = ? AND status IN ('earned','approved','paid')
        AND sale_ref LIKE ? AND created_at >= ? AND created_at < ?`,
  ).get(tenantId, repId, `${PREFIX}%`, startIso, endIso) as any;
  return Number(row?.s ?? 0);
}

export interface AchievementEvaluation {
  cleared: AchievementAward[];
  dailySales: number;
  careerSales: number;
  centsAlreadyToday: number;
  isRampRep: boolean;
  dayKey: string;
  dayLabel: string;
}

/** Evaluate without writing. Shared by the award path and the rep's card. */
export function evaluateAchievementsForRep(tenantId: number, repId: number, nowMs: number): AchievementEvaluation {
  const cfg = getAchievementConfig(tenantId);
  const day = localDay(tenantId, nowMs);
  // A rep inside their first fortnight is on the ramp bonus instead — the
  // handover is a config flag, not a hardcoded rule, so an org that wants both
  // can have both.
  const onRamp = isRampRep(tenureDay(tenantId, repId, nowMs), getRampConfig(tenantId));
  const counts = {
    dailySales: dailySales(tenantId, repId, day.startIso, day.endIso),
    careerSales: careerSales(tenantId, repId),
    centsAlreadyToday: achievementCentsToday(tenantId, repId, day.startIso, day.endIso),
    isRampRep: onRamp,
  };
  return {
    cleared: achievementsCleared(counts, cfg),
    ...counts,
    dayKey: day.key,
    dayLabel: day.label,
  };
}

export interface BookedAchievement {
  scope: "day" | "career";
  sales: number;
  amountCents: number;
  reason: string;
  /** False when the award already existed — a retry, not a second payment. */
  inserted: boolean;
}

/**
 * Evaluate the ladder for one rep and book whatever they have newly cleared.
 *
 * Called after every applied sale, so a rep clearing a rung is told at the
 * door. Safe to call as often as you like: the unique index stops a double
 * award, not the caller's discipline.
 */
export function awardAchievementsForRep(tenantId: number, repId: number, nowMs: number): BookedAchievement[] {
  const cfg = getAchievementConfig(tenantId);
  if (!cfg.enabled) return [];

  const evaluation = evaluateAchievementsForRep(tenantId, repId, nowMs);
  const nowIso = new Date(nowMs).toISOString();
  const out: BookedAchievement[] = [];

  for (const award of evaluation.cleared) {
    // A daily rung is keyed to the day; a career rung fires once, ever.
    const key = award.scope === "day"
      ? `${PREFIX}${evaluation.dayKey}:rep:${repId}:${award.key}`
      : `${PREFIX}rep:${repId}:${award.key}`;

    const info = rawDb.prepare(
      `INSERT OR IGNORE INTO spiffs (tenant_id, rep_id, sale_ref, amount_cents, reason, status, created_at)
       VALUES (?,?,?,?,?,'earned',?)`,
    ).run(tenantId, repId, key, award.amountCents, award.reason, nowIso);

    const inserted = info.changes === 1;
    if (inserted) {
      storage.logActivity(null, "incentive.achievement.awarded", "team_member", repId, {
        scope: award.scope, sales: award.sales, amountCents: award.amountCents,
        dailySales: evaluation.dailySales, careerSales: evaluation.careerSales,
        day: evaluation.dayLabel, idemKey: key,
      }, undefined);
    }
    out.push({
      scope: award.scope, sales: award.sales, amountCents: award.amountCents,
      reason: award.reason, inserted,
    });
  }
  return out;
}

/** What the rep sees: the whole ladder plus where they stand on it. */
export function repAchievementCard(tenantId: number, repId: number, nowMs: number) {
  const cfg = getAchievementConfig(tenantId);
  const e = evaluateAchievementsForRep(tenantId, repId, nowMs);
  return {
    ...achievementProgress({
      dailySales: e.dailySales,
      careerSales: e.careerSales,
      centsAlreadyToday: e.centsAlreadyToday,
      isRampRep: e.isRampRep,
    }, cfg),
    onRamp: e.isRampRep,
    dayLabel: e.dayLabel,
    capCents: cfg.maxCentsPerRepPerDay,
  };
}

/** What the ladder is costing today, and its per-rep ceiling — the number a
 *  manager needs before turning it on. */
export function achievementExposure(tenantId: number, nowMs: number) {
  const cfg = getAchievementConfig(tenantId);
  const day = localDay(tenantId, nowMs);
  const today = rawDb.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS s, COUNT(*) AS n FROM spiffs
      WHERE tenant_id = ? AND status IN ('earned','approved','paid')
        AND sale_ref LIKE ? AND created_at >= ? AND created_at < ?`,
  ).get(tenantId, `${PREFIX}%`, day.startIso, day.endIso) as any;
  const reps = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM team_members WHERE tenant_id = ? AND active = 1`,
  ).get(tenantId) as any;

  const activeReps = Number(reps?.n ?? 0);
  const perRep = achievementCeilingCents(cfg);
  return {
    enabled: cfg.enabled,
    dayLabel: day.label,
    awardedTodayCents: Number(today?.s ?? 0),
    awardCountToday: Number(today?.n ?? 0),
    perRepDailyCeilingCents: perRep,
    activeReps,
    worstCaseDailyCents: perRep * activeReps,
  };
}
