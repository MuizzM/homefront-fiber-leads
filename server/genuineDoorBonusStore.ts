// ── Genuine-door day bonus — counters, clocks, and paying exactly once ──────
// The verdict is pure and lives in shared/genuineDoors.ts. This file does the
// three things it deliberately cannot: pull the day's doors, decide WHICH CLOCK
// to time them by, and record an award exactly once.
//
// ── THE CLOCK PROBLEM, WHICH IS THE WHOLE PROBLEM ───────────────────────────
//
// Every anti-gaming rule in the pure module is a statement about time, so the
// timestamps it reads have to be ones a rep cannot choose. There are two
// clocks on every knock and neither is right on its own:
//
//   server_ts   Unforgeable — we stamped it. But an offline day syncs in one
//               burst at 5pm, so a rep who genuinely walked six hours with no
//               signal looks, on this clock, exactly like a rep who fabricated
//               sixty doors in ninety seconds. Timing everything by server_ts
//               would deny the bonus to the reps working the worst coverage.
//
//   device_ts   What the rep experienced, and the only clock an offline knock
//               has. It is also client-supplied, which means forgeable.
//
// So: a knock the server received LIVE is timed by the server clock, and only a
// knock that genuinely sat in the offline queue falls back to its device clock.
// `SYNC_GRACE_MS` is the line between them. That gives the unforgeable clock
// authority over the normal case while keeping the offline case payable.
//
// The fallback is not a hole, because the device clock is not the only defence:
// a device-timed door still had to pass the server's geo check (physically at
// the address, accurate fix, no mock-location flag, no impossible travel from
// the previous knock — shared/geoVerify.ts). Forging spread on a knock you
// nonetheless had to physically stand at buys very little. And every day that
// leans on device timing is COUNTED and logged with the award, so a rep whose
// every day is "offline" is visible rather than invisible.
//
// ── PAYING ONCE ─────────────────────────────────────────────────────────────
// The award key is the local day (`doorday:D2026-08-06:rep:12`) in the
// UNIQUE-indexed `sale_ref` column. Door 61 re-evaluates the same day and the
// insert is ignored. Money that can be re-earned by knocking one more door is
// not a rounding bug.

import { rawDb } from "./db";
import { storage } from "./storage";
import {
  DEFAULT_DOOR_DAY_CONFIG, doorDayProgress, evaluateDoorDay, validateDoorDayConfig,
  type DoorDayConfig, type DoorDayDecision, type DoorEvent,
} from "@shared/genuineDoors";
import { DEFAULT_WORKWEEK, localWallToUtcMs, localYmdParts } from "@shared/workweek";

const CONFIG_SETTING = "spiff.door_day_bonus";
const KEY_PREFIX = "doorday:";

/** How far a knock's server receipt may trail the device time before we treat
 *  it as a live knock rather than an offline flush. Five minutes covers a slow
 *  request and a retry; it does not cover a rep who was out of signal. */
const SYNC_GRACE_MS = 5 * 60_000;

function orgTimezone(tenantId: number): string {
  try {
    const row = rawDb.prepare(`SELECT commission_timezone AS tz FROM tenants WHERE id = ?`).get(tenantId) as any;
    return row?.tz || DEFAULT_WORKWEEK.timezone;
  } catch { return DEFAULT_WORKWEEK.timezone; }
}

/** UTC bounds of the org's LOCAL day, plus the key that makes the award
 *  unrepeatable inside it. A day that rolls over at 7pm Pacific is not a day. */
export function localDay(tenantId: number, nowMs: number): {
  startIso: string; endIso: string; key: string; label: string;
} {
  const tz = orgTimezone(tenantId);
  const { y, mo, d } = localYmdParts(nowMs, tz);
  const label = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const startMs = localWallToUtcMs(y, mo, d, 0, 0, tz);
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(startMs + 86_400_000).toISOString(),
    key: `D${label}`,
    label,
  };
}

export function getDoorDayConfig(tenantId: number): DoorDayConfig {
  try {
    const raw = storage.getSetting(CONFIG_SETTING, tenantId);
    if (!raw) return DEFAULT_DOOR_DAY_CONFIG;
    const parsed = JSON.parse(raw);
    // A malformed stored value falls back rather than throwing — a bad settings
    // row must never be able to break a knock.
    if (validateDoorDayConfig({ ...DEFAULT_DOOR_DAY_CONFIG, ...parsed })) return DEFAULT_DOOR_DAY_CONFIG;
    return { ...DEFAULT_DOOR_DAY_CONFIG, ...parsed };
  } catch { return DEFAULT_DOOR_DAY_CONFIG; }
}

export function setDoorDayConfig(tenantId: number, actorId: number | null, cfg: DoorDayConfig): DoorDayConfig {
  const merged = { ...DEFAULT_DOOR_DAY_CONFIG, ...cfg };
  const problem = validateDoorDayConfig(merged);
  if (problem) throw Object.assign(new Error(problem), { httpStatus: 400 });
  storage.setSetting(CONFIG_SETTING, JSON.stringify(merged), actorId, tenantId);
  storage.logActivity(actorId, "incentive.door_day.configured", "tenant", tenantId, {
    enabled: merged.enabled, doors: merged.doors, rewardCents: merged.rewardCents,
    minSpanMinutes: merged.minSpanMinutes, maxPerRollingHour: merged.maxPerRollingHour,
    minGapSeconds: merged.minGapSeconds, voidOnTamper: merged.voidOnTamper,
  }, undefined);
  return merged;
}

interface RawDoor {
  leadId: number;
  serverTs: string | null;
  deviceTs: string | null;
  knockedAt: string;
}

/**
 * The day's verified doors, with BOTH clocks, so the caller can pick.
 *
 * The filters are the same three every incentive counter in this app uses, and
 * none is optional:
 *
 *   verification_status = 'verified' — the verdict is computed server-side from
 *   the door's own coordinates, so a knock logged from the couch is not here.
 *   `needs_review` and legacy NULL do not count either: an unverifiable knock
 *   is not evidence of work, and paying for one teaches the whole floor exactly
 *   which way to hold the phone.
 *
 *   NOT superseded — a stale offline knock that lost the outcome CAS was
 *   applied to nothing, so it should not buy a bonus either.
 *
 *   the lead's tenant — money never crosses an org boundary.
 *
 * Note it does NOT de-duplicate addresses in SQL. The pure counter does that,
 * because it also has to TELL the rep how many doors were dropped and why; a
 * counter that silently discards work reads as a broken counter.
 */
function dayDoors(tenantId: number, repId: number, startIso: string, endIso: string): RawDoor[] {
  return rawDb.prepare(
    `SELECT k.lead_id AS leadId, k.server_ts AS serverTs, k.device_ts AS deviceTs, k.knocked_at AS knockedAt
       FROM knock_log k
       JOIN leads l ON l.id = k.lead_id
      WHERE k.rep_id = ? AND l.tenant_id = ?
        AND k.knocked_at >= ? AND k.knocked_at < ?
        AND k.verification_status = 'verified'
        AND COALESCE(k.superseded, 0) = 0
      ORDER BY k.knocked_at ASC`,
  ).all(repId, tenantId, startIso, endIso) as RawDoor[];
}

/** Knocks the SERVER rated `invalid` today — mock location, a device clock
 *  reporting the future, or travel no human could make. Not `needs_review`:
 *  an unverifiable knock is merely uncounted, but a fabricated one is evidence
 *  about the whole day. */
function tamperedToday(tenantId: number, repId: number, startIso: string, endIso: string): number {
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS n
       FROM knock_log k
       JOIN leads l ON l.id = k.lead_id
      WHERE k.rep_id = ? AND l.tenant_id = ?
        AND k.knocked_at >= ? AND k.knocked_at < ?
        AND k.verification_status = 'invalid'`,
  ).get(repId, tenantId, startIso, endIso) as any;
  return Number(row?.n ?? 0);
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export interface TimedDoors {
  events: DoorEvent[];
  /** Doors whose spacing came from the DEVICE clock because they were flushed
   *  from the offline queue. Recorded with the award so a rep whose every day
   *  is "offline" is visible. */
  deviceTimed: number;
}

/**
 * Choose each door's clock. Server receipt wins whenever it is close enough to
 * the device time to be a live knock; otherwise the door sat in the offline
 * queue and the device clock is the only record of when it happened.
 *
 * Exported for the unit tests, which is the only way to prove the offline rep
 * and the fabricating rep are treated differently.
 */
export function timeDoors(rows: RawDoor[]): TimedDoors {
  const events: DoorEvent[] = [];
  let deviceTimed = 0;
  for (const r of rows) {
    const serverMs = ms(r.serverTs);
    const deviceMs = ms(r.deviceTs) ?? ms(r.knockedAt);
    if (serverMs != null && (deviceMs == null || serverMs - deviceMs <= SYNC_GRACE_MS)) {
      events.push({ leadId: Number(r.leadId), atMs: serverMs });
    } else if (deviceMs != null) {
      events.push({ leadId: Number(r.leadId), atMs: deviceMs });
      deviceTimed += 1;
    }
    // A row with neither clock is unusable and simply does not count. It cannot
    // happen through the knock route (server_ts is stamped there), only through
    // a legacy row, and guessing a timestamp for it would be inventing evidence.
  }
  return { events, deviceTimed };
}

export interface DoorDayEvaluation {
  decision: DoorDayDecision;
  deviceTimed: number;
  tamperedKnocks: number;
  dayKey: string;
  dayLabel: string;
}

/** Evaluate one rep's day without writing anything. Shared by the award path
 *  and the rep's card, so the bar the card promises is the bar the ledger
 *  pays — they cannot drift, because there is only one of them. */
export function evaluateDoorDayForRep(tenantId: number, repId: number, nowMs: number): DoorDayEvaluation {
  const cfg = getDoorDayConfig(tenantId);
  const day = localDay(tenantId, nowMs);
  const rows = dayDoors(tenantId, repId, day.startIso, day.endIso);
  const { events, deviceTimed } = timeDoors(rows);
  const tampered = cfg.voidOnTamper ? tamperedToday(tenantId, repId, day.startIso, day.endIso) : 0;
  return {
    decision: evaluateDoorDay(events, tampered, cfg),
    deviceTimed,
    tamperedKnocks: tampered,
    dayKey: day.key,
    dayLabel: day.label,
  };
}

export interface DoorDayAward {
  amountCents: number;
  doors: number;
  reason: string;
  /** False when the award already existed — a retry, not a second payment. */
  inserted: boolean;
}

/**
 * Evaluate the day and book the bonus if it is earned.
 *
 * Called after every applied knock, so a rep crossing the bar is told at the
 * door. Safe to call as often as you like: the unique index stops a double
 * award, not the caller's discipline.
 *
 * A day that goes tampered AFTER the bonus was already booked does not silently
 * stand: the award is still `earned` (an admin approves it before it reaches
 * payroll — see server/hourlyPay.ts sumWeekSpiffsByRep, which sums only
 * approved/paid), and this logs the contradiction so the approver sees it.
 */
export function awardDoorDayForRep(tenantId: number, repId: number, nowMs: number): DoorDayAward | null {
  const cfg = getDoorDayConfig(tenantId);
  if (!cfg.enabled) return null;

  const evaluation = evaluateDoorDayForRep(tenantId, repId, nowMs);
  const { decision } = evaluation;
  const key = `${KEY_PREFIX}${evaluation.dayKey}:rep:${repId}`;

  if (!decision.qualifies) {
    // Tamper found on a day that ALREADY paid — flag it once so the approval
    // queue is not the last place anyone finds out.
    if (decision.blockedBy === "tamper") {
      const existing = rawDb.prepare(
        `SELECT id, status FROM spiffs WHERE tenant_id = ? AND sale_ref = ?`,
      ).get(tenantId, key) as any;
      if (existing && existing.status === "earned") {
        storage.logActivity(null, "incentive.door_day.tamper_after_award", "team_member", repId, {
          spiffId: existing.id, tamperedKnocks: evaluation.tamperedKnocks,
          day: evaluation.dayLabel, idemKey: key,
        }, undefined);
      }
    }
    return null;
  }

  const info = rawDb.prepare(
    `INSERT OR IGNORE INTO spiffs (tenant_id, rep_id, sale_ref, amount_cents, reason, status, created_at)
     VALUES (?,?,?,?,?,'earned',?)`,
  ).run(tenantId, repId, key, decision.awardCents, decision.reason, new Date(nowMs).toISOString());

  const inserted = info.changes === 1;
  if (inserted) {
    storage.logActivity(null, "incentive.door_day.awarded", "team_member", repId, {
      amountCents: decision.awardCents,
      doorsCounted: decision.count.counted,
      doorsSubmitted: decision.count.submitted,
      rejected: decision.count.rejected,
      spanMinutes: decision.count.spanMinutes,
      deviceTimedDoors: evaluation.deviceTimed,
      day: evaluation.dayLabel,
      idemKey: key,
    }, undefined);
  }
  return {
    amountCents: decision.awardCents,
    doors: decision.count.counted,
    reason: decision.reason,
    inserted,
  };
}

/** What the rep sees. Disabled orgs get `enabled: false` and the client renders
 *  nothing — never an empty bar implying a bonus that does not exist. */
export function repDoorDayCard(tenantId: number, repId: number, nowMs: number) {
  const cfg = getDoorDayConfig(tenantId);
  const evaluation = evaluateDoorDayForRep(tenantId, repId, nowMs);
  return {
    ...doorDayProgress(evaluation.decision, cfg),
    dayLabel: evaluation.dayLabel,
    minGapSeconds: cfg.minGapSeconds,
    maxPerRollingHour: cfg.maxPerRollingHour,
  };
}

/**
 * What the bonus is costing the org today, and what it COULD cost.
 *
 * `rewardCents × active reps` is the number a manager needs before turning it
 * on and the one nobody works out by hand — $50 across 20 reps is $1,000 a day
 * if everybody clears it.
 */
export function doorDayExposure(tenantId: number, nowMs: number) {
  const cfg = getDoorDayConfig(tenantId);
  const day = localDay(tenantId, nowMs);
  const row = rawDb.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS s, COUNT(*) AS n FROM spiffs
      WHERE tenant_id = ? AND status IN ('earned','approved','paid') AND sale_ref LIKE ?`,
  ).get(tenantId, `${KEY_PREFIX}${day.key}:%`) as any;
  const reps = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM team_members WHERE tenant_id = ? AND active = 1`,
  ).get(tenantId) as any;

  const activeReps = Number(reps?.n ?? 0);
  return {
    enabled: cfg.enabled,
    dayLabel: day.label,
    awardedCents: Number(row?.s ?? 0),
    awardCount: Number(row?.n ?? 0),
    perRepCents: cfg.rewardCents,
    activeReps,
    worstCaseCents: cfg.rewardCents * activeReps,
  };
}
