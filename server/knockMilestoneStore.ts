// ── Knock milestones — counters and idempotent awards ───────────────────────
// The decision logic is pure and lives in shared/knockMilestones.ts. This file
// does the two things it deliberately cannot: count what a rep actually did, and
// record an award exactly once.
//
// AWARDS RIDE THE EXISTING SPIFF LEDGER, which is what makes them land on the
// commission report. A milestone award is a row in `spiffs`, and the statement
// builder already sums it:
//
//     earnedCents = hourlyPayCents + gross + adjustmentCents + spiffCents
//
// so "$25 for 100 verified doors" turns up as a line on the rep's statement and
// in the payroll CSV without a single new money path to reconcile.
//
// IDEMPOTENCY IS A DATABASE CONSTRAINT. Each award carries a deterministic key
// (`milestone:2026-W32:rep:12:doors:100`) written into the UNIQUE-indexed
// `sale_ref` column. The 101st verified door of the week re-evaluates the same
// rung and the insert is ignored. Money that can be re-earned by knocking one
// more door is not a rounding bug.

import { rawDb } from "./db";
import { storage } from "./storage";
import {
  DEFAULT_MILESTONE_LADDER, ladderCeilingCents, milestoneProgress, milestoneReason,
  normalizeLadder, rungsCleared, validateLadder,
  type MilestoneLadder, type MilestonePeriod,
} from "@shared/knockMilestones";
import {
  DEFAULT_WORKWEEK, localWallToUtcMs, localYmdParts, weekBoundsFor, type WorkweekConfig,
} from "@shared/workweek";

const LADDER_SETTING = "spiff.knock_milestones";

// PERF: every incentive counter in the app — milestones, campaign triggers, and
// momentum signals — asks the same shape of question: "this rep's verified doors
// between two instants". The existing indexes are `rep_id` alone and
// `knocked_at` alone, so SQLite picked the time index and scanned EVERY rep's
// knocks in the window to count one rep's doors. That cost grows with headcount,
// which is exactly the wrong way round.
//
// The composite makes it a single indexed range seek per rep. `verification_status`
// rides along so the filter is answered from the index without touching the row.
try {
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_knock_log_rep_time_verified
                ON knock_log(rep_id, knocked_at, verification_status)`);
} catch { /* index already present */ }

function orgTimezone(tenantId: number): string {
  try {
    const row = rawDb.prepare(`SELECT commission_timezone AS tz FROM tenants WHERE id = ?`).get(tenantId) as any;
    return row?.tz || DEFAULT_WORKWEEK.timezone;
  } catch { return DEFAULT_WORKWEEK.timezone; }
}

/** The org's ladder, or the default. A malformed stored value falls back rather
 *  than throwing — a bad settings row must never be able to break a knock. */
export function getLadder(tenantId: number): MilestoneLadder {
  try {
    const raw = storage.getSetting(LADDER_SETTING, tenantId);
    if (!raw) return DEFAULT_MILESTONE_LADDER;
    const parsed = JSON.parse(raw);
    if (validateLadder(parsed)) return DEFAULT_MILESTONE_LADDER;
    return normalizeLadder(parsed);
  } catch { return DEFAULT_MILESTONE_LADDER; }
}

export function setLadder(tenantId: number, actorId: number | null, ladder: MilestoneLadder): MilestoneLadder {
  const norm = normalizeLadder(ladder);
  storage.setSetting(LADDER_SETTING, JSON.stringify(norm), actorId, tenantId);
  storage.logActivity(actorId, "spiff.milestones.configured", "tenant", tenantId, {
    enabled: norm.enabled, period: norm.period, rungs: norm.rungs,
    perRepCeilingCents: ladderCeilingCents(norm),
  }, undefined);
  return norm;
}

/** The half-open [start, end) window the ladder counts over, plus the key that
 *  makes an award unrepeatable inside it. */
export function periodWindow(tenantId: number, period: MilestonePeriod, nowMs: number): {
  startIso: string; endIso: string; key: string; label: string;
} {
  const tz = orgTimezone(tenantId);
  if (period === "day") {
    const { y, mo, d } = localYmdParts(nowMs, tz);
    const label = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    // Local midnight to local midnight, DST-correct — a day boundary in UTC
    // would cut a Pacific rep's evening onto the wrong day's ladder.
    const startMs = localWallToUtcMs(y, mo, d, 0, 0, tz);
    return {
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(startMs + 86_400_000).toISOString(),
      key: `D${label}`, label,
    };
  }
  // The commission week, so the bonus lands in the same pay period as the work
  // that earned it — that is the entire reason it reads as "on my check".
  const cfg: WorkweekConfig = { ...DEFAULT_WORKWEEK, timezone: tz };
  const b = weekBoundsFor(nowMs, cfg);
  return {
    startIso: b.weekStartUtc, endIso: b.nextWeekStartUtc,
    key: `W${b.weekStartUtc.slice(0, 10)}`, label: b.localWeekLabel,
  };
}

/**
 * DISTINCT doors the rep worked in the window, counting only knocks the SERVER
 * rated `verified`.
 *
 * Both filters are load-bearing and neither is optional:
 *
 *   COUNT(DISTINCT lead_id) — the hundredth tap on the same house is worth
 *   zero, so a rep cannot stand at one door and farm the ladder.
 *
 *   verification_status = 'verified' — the verdict is computed server-side from
 *   the door's coordinates, so a rep cannot log a hundred doors from the couch.
 *   `needs_review` and `invalid` do NOT count, and neither does legacy NULL:
 *   an unverifiable knock is not evidence of work, and paying for one teaches
 *   the whole floor exactly which way to hold the phone.
 *
 *   NOT superseded — a stale offline knock that lost the outcome CAS was applied
 *   to nothing, so it should not buy a bonus either.
 */
export function verifiedDoorCount(tenantId: number, repId: number, startIso: string, endIso: string): number {
  const row = rawDb.prepare(
    `SELECT COUNT(DISTINCT k.lead_id) AS n
       FROM knock_log k
       JOIN leads l ON l.id = k.lead_id
      WHERE k.rep_id = ? AND l.tenant_id = ?
        AND k.knocked_at >= ? AND k.knocked_at < ?
        AND k.verification_status = 'verified'
        AND COALESCE(k.superseded, 0) = 0`,
  ).get(repId, tenantId, startIso, endIso) as any;
  return Number(row?.n ?? 0);
}

function awardedThisPeriod(tenantId: number, repId: number, periodKey: string): number {
  const row = rawDb.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM spiffs
      WHERE tenant_id = ? AND rep_id = ? AND status IN ('earned','approved','paid')
        AND sale_ref LIKE ?`,
  ).get(tenantId, repId, `milestone:${periodKey}:rep:${repId}:%`) as any;
  return Number(row?.s ?? 0);
}

export interface MilestoneAward {
  doors: number;
  amountCents: number;
  reason: string;
  /** False when the award already existed — a retry, not a second payment. */
  inserted: boolean;
}

/**
 * Evaluate the ladder for one rep and book whatever they have newly cleared.
 *
 * Called after every applied knock, so a rep crossing 100 doors is told at the
 * door. Safe to call as often as you like: the unique index stops a double
 * award, not the caller's discipline.
 */
export function awardMilestonesForRep(tenantId: number, repId: number, nowMs: number): MilestoneAward[] {
  const ladder = getLadder(tenantId);
  if (!ladder.enabled || ladder.rungs.length === 0) return [];

  const win = periodWindow(tenantId, ladder.period, nowMs);
  const doors = verifiedDoorCount(tenantId, repId, win.startIso, win.endIso);
  const out: MilestoneAward[] = [];

  for (const rung of rungsCleared(ladder, doors)) {
    const key = `milestone:${win.key}:rep:${repId}:doors:${rung.doors}`;
    const reason = milestoneReason(rung, ladder.period);
    const info = rawDb.prepare(
      `INSERT OR IGNORE INTO spiffs (tenant_id, rep_id, sale_ref, amount_cents, reason, status, created_at)
       VALUES (?,?,?,?,?,'earned',?)`,
    ).run(tenantId, repId, key, rung.rewardCents, reason, new Date(nowMs).toISOString());

    const inserted = info.changes === 1;
    if (inserted) {
      storage.logActivity(null, "spiff.milestone.awarded", "team_member", repId, {
        doors: rung.doors, amountCents: rung.rewardCents, period: ladder.period,
        periodKey: win.key, actualDoors: doors, idemKey: key,
      }, undefined);
    }
    out.push({ doors: rung.doors, amountCents: rung.rewardCents, reason, inserted });
  }
  return out;
}

export interface MilestoneCard {
  enabled: boolean;
  period: MilestonePeriod;
  periodLabel: string;
  rungs: MilestoneLadder["rungs"];
  progress: ReturnType<typeof milestoneProgress>;
}

/** What the rep sees. Disabled orgs get `enabled: false` and the client renders
 *  nothing — never an empty ladder implying a bonus that does not exist. */
export function repMilestoneCard(tenantId: number, repId: number, nowMs: number): MilestoneCard {
  const ladder = getLadder(tenantId);
  const win = periodWindow(tenantId, ladder.period, nowMs);
  const doors = ladder.enabled ? verifiedDoorCount(tenantId, repId, win.startIso, win.endIso) : 0;
  return {
    enabled: ladder.enabled && ladder.rungs.length > 0,
    period: ladder.period,
    periodLabel: win.label,
    rungs: ladder.rungs,
    progress: milestoneProgress(ladder, doors),
  };
}

/**
 * What the ladder is costing the org right now, and what it COULD cost.
 *
 * `perRepCeilingCents × active reps` is the number a manager needs before
 * turning a ladder on and the one nobody works out by hand — a $25/$50/$100
 * ladder across 20 reps is $3,500 a week if everyone tops out.
 */
export function milestoneExposure(tenantId: number, nowMs: number): {
  enabled: boolean; periodLabel: string;
  awardedCents: number; awardCount: number;
  perRepCeilingCents: number; activeReps: number; worstCaseCents: number;
} {
  const ladder = getLadder(tenantId);
  const win = periodWindow(tenantId, ladder.period, nowMs);
  const row = rawDb.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS s, COUNT(*) AS n FROM spiffs
      WHERE tenant_id = ? AND status IN ('earned','approved','paid') AND sale_ref LIKE ?`,
  ).get(tenantId, `milestone:${win.key}:%`) as any;
  const reps = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM team_members WHERE tenant_id = ? AND active = 1`,
  ).get(tenantId) as any;

  const perRepCeilingCents = ladderCeilingCents(ladder);
  const activeReps = Number(reps?.n ?? 0);
  return {
    enabled: ladder.enabled && ladder.rungs.length > 0,
    periodLabel: win.label,
    awardedCents: Number(row?.s ?? 0),
    awardCount: Number(row?.n ?? 0),
    perRepCeilingCents,
    activeReps,
    worstCaseCents: perRepCeilingCents * activeReps,
  };
}

export { awardedThisPeriod };
