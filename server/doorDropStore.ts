// ── Door drops — counters, and paying a surprise exactly once ───────────────
// The roll is pure and lives in shared/doorDrop.ts. This file supplies the
// signals it reads and records the award.
//
// IDEMPOTENCY IS THE WHOLE GAME HERE. A drop is decided by a deterministic hash
// of the knock id, so a retry re-computes the SAME verdict — but "same verdict"
// still has to mean "same single payment". The ledger key is the knock
// (`drop:knock:8412`) in the UNIQUE-indexed sale_ref column, so an offline
// replay, a double-tapped submit, or two servers racing all collide on the index
// and the second insert is ignored.
//
// Between them, those two properties mean a rep cannot re-roll a losing door OR
// double-collect a winning one.

import { rawDb } from "./db";
import { storage } from "./storage";
import {
  DEFAULT_DOOR_DROP_CONFIG, evaluateDoorDrop, dropStatusLine, dropChance,
  validateDoorDropConfig, expectedDailyCostCents, usd,
  type DoorDropConfig,
} from "@shared/doorDrop";
import { DEFAULT_WORKWEEK, localWallToUtcMs, localYmdParts } from "@shared/workweek";

const CONFIG_SETTING = "spiff.door_drops";

function orgTimezone(tenantId: number): string {
  try {
    const row = rawDb.prepare(`SELECT commission_timezone AS tz FROM tenants WHERE id = ?`).get(tenantId) as any;
    return row?.tz || DEFAULT_WORKWEEK.timezone;
  } catch { return DEFAULT_WORKWEEK.timezone; }
}

/** UTC bounds of the org's LOCAL day — a cap that rolls over at 7pm Pacific is
 *  not a daily cap. */
function localDayBounds(tenantId: number, nowMs: number): { startIso: string; endIso: string } {
  const tz = orgTimezone(tenantId);
  const { y, mo, d } = localYmdParts(nowMs, tz);
  const startMs = localWallToUtcMs(y, mo, d, 0, 0, tz);
  return { startIso: new Date(startMs).toISOString(), endIso: new Date(startMs + 86_400_000).toISOString() };
}

export function getDoorDropConfig(tenantId: number): DoorDropConfig {
  try {
    const raw = storage.getSetting(CONFIG_SETTING, tenantId);
    if (!raw) return DEFAULT_DOOR_DROP_CONFIG;
    const parsed = JSON.parse(raw);
    // A malformed stored value falls back rather than throwing — a bad settings
    // row must never be able to break a knock.
    if (validateDoorDropConfig(parsed)) return DEFAULT_DOOR_DROP_CONFIG;
    return { ...DEFAULT_DOOR_DROP_CONFIG, ...parsed };
  } catch { return DEFAULT_DOOR_DROP_CONFIG; }
}

export function setDoorDropConfig(tenantId: number, actorId: number | null, cfg: DoorDropConfig): DoorDropConfig {
  const merged = { ...DEFAULT_DOOR_DROP_CONFIG, ...cfg };
  const problem = validateDoorDropConfig(merged);
  if (problem) throw Object.assign(new Error(problem), { httpStatus: 400 });
  storage.setSetting(CONFIG_SETTING, JSON.stringify(merged), actorId, tenantId);
  storage.logActivity(actorId, "spiff.door_drops.configured", "tenant", tenantId, {
    enabled: merged.enabled, oddsOneIn: merged.oddsOneIn,
    band: [merged.minCents, merged.maxCents], caps: {
      perRepPerDay: merged.maxPerRepPerDay,
      centsPerRepPerDay: merged.maxCentsPerRepPerDay,
      centsPerOrgPerDay: merged.maxCentsPerOrgPerDay,
    },
  }, undefined);
  return merged;
}

const DROP_PREFIX = "drop:knock:";

function dropsToday(tenantId: number, repId: number | null, nowMs: number): { count: number; cents: number } {
  const { startIso, endIso } = localDayBounds(tenantId, nowMs);
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS c FROM spiffs
      WHERE tenant_id = ? AND sale_ref LIKE '${DROP_PREFIX}%'
        AND status IN ('earned','approved','paid')
        AND created_at >= ? AND created_at < ?
        ${repId != null ? "AND rep_id = ?" : ""}`,
  ).get(...(repId != null ? [tenantId, startIso, endIso, repId] : [tenantId, startIso, endIso])) as any;
  return { count: Number(row?.n ?? 0), cents: Number(row?.c ?? 0) };
}

/**
 * Verified distinct doors this rep has worked since their last drop.
 *
 * Same anti-farming rule as every other counter here: one address counts once,
 * and only when the server's own geo check rated the knock `verified`. Without
 * the DISTINCT, standing at one house and tapping would walk the pity curve
 * straight to a guaranteed payout.
 */
export function doorsSinceLastDrop(tenantId: number, repId: number): number {
  const last = rawDb.prepare(
    `SELECT MAX(created_at) AS t FROM spiffs
      WHERE tenant_id = ? AND rep_id = ? AND sale_ref LIKE '${DROP_PREFIX}%'
        AND status IN ('earned','approved','paid')`,
  ).get(tenantId, repId) as any;
  // No drop ever → count from the rep's first verified door. A brand-new rep
  // starts at the base odds, not at the pity ceiling.
  const since = last?.t ?? "1970-01-01T00:00:00.000Z";
  const row = rawDb.prepare(
    `SELECT COUNT(DISTINCT k.lead_id) AS n
       FROM knock_log k
       JOIN leads l ON l.id = k.lead_id
      WHERE k.rep_id = ? AND l.tenant_id = ?
        AND k.knocked_at > ?
        AND k.verification_status = 'verified'
        AND COALESCE(k.superseded, 0) = 0`,
  ).get(repId, tenantId, since) as any;
  return Number(row?.n ?? 0);
}

export interface DoorDropResult {
  amountCents: number;
  headline: string;
  reason: string;
  /** False when the award already existed — a replay, not a second payment. */
  inserted: boolean;
}

/**
 * Roll this door. Called after a verified knock is applied.
 *
 * Returns null for the overwhelming majority of doors — that is the mechanic
 * working, not a failure.
 */
export function rollDoorDrop(
  tenantId: number, repId: number, knockId: number, nowMs: number,
): DoorDropResult | null {
  const cfg = getDoorDropConfig(tenantId);
  if (!cfg.enabled) return null;

  const key = `${DROP_PREFIX}${knockId}`;

  // ── Replay first, evaluate second ────────────────────────────────────────
  // The ROLL is deterministic, but the SIGNALS it reads are not stable across a
  // retry: winning resets doorsSinceLastDrop and moves the daily totals, so
  // re-evaluating an already-paid knock now correctly says "no drop". The ledger
  // is safe either way (UNIQUE sale_ref), but returning null there would mean a
  // retry whose first response never reached the phone leaves the rep paid and
  // never told. Reporting the existing award instead makes this idempotent in
  // its RETURN VALUE, not merely in its side effect.
  const existing = rawDb.prepare(
    `SELECT amount_cents AS c, reason FROM spiffs WHERE tenant_id = ? AND sale_ref = ? LIMIT 1`,
  ).get(tenantId, key) as any;
  if (existing) {
    return {
      amountCents: Number(existing.c),
      headline: `Door drop - ${usd(Number(existing.c))}`,
      reason: String(existing.reason),
      inserted: false,
    };
  }

  const mine = dropsToday(tenantId, repId, nowMs);
  const org = dropsToday(tenantId, null, nowMs);
  const verdict = evaluateDoorDrop({
    repId, knockId,
    doorsSinceLastDrop: doorsSinceLastDrop(tenantId, repId),
    dropsToday: mine.count,
    awardedToRepTodayCents: mine.cents,
    awardedOrgTodayCents: org.cents,
  }, cfg);
  if (!("drop" in verdict)) return null;

  const info = rawDb.prepare(
    `INSERT OR IGNORE INTO spiffs (tenant_id, rep_id, sale_ref, amount_cents, reason, status, created_at)
     VALUES (?,?,?,?,?,'earned',?)`,
  ).run(tenantId, repId, key, verdict.drop.amountCents, verdict.drop.reason, new Date(nowMs).toISOString());

  const inserted = info.changes === 1;
  if (inserted) {
    storage.logActivity(null, "spiff.door_drop.awarded", "team_member", repId, {
      knockId, amountCents: verdict.drop.amountCents, idemKey: key,
    }, undefined);
  }
  return { ...verdict.drop, inserted };
}

export interface DoorDropCard {
  enabled: boolean;
  /** The honest shape of it, in words — never a percentage or a countdown. */
  statusLine: string;
  doorsSinceLastDrop: number;
  dropsToday: number;
  earnedTodayCents: number;
  band: { minCents: number; maxCents: number };
}

/** What the rep sees. Shown even when nothing has dropped, because a mechanic
 *  nobody knows about cannot motivate anyone. */
export function repDoorDropCard(tenantId: number, repId: number, nowMs: number): DoorDropCard {
  const cfg = getDoorDropConfig(tenantId);
  if (!cfg.enabled) {
    return {
      enabled: false, statusLine: "", doorsSinceLastDrop: 0, dropsToday: 0,
      earnedTodayCents: 0, band: { minCents: 0, maxCents: 0 },
    };
  }
  const since = doorsSinceLastDrop(tenantId, repId);
  const mine = dropsToday(tenantId, repId, nowMs);
  return {
    enabled: true,
    statusLine: dropStatusLine(since, cfg),
    doorsSinceLastDrop: since,
    dropsToday: mine.count,
    earnedTodayCents: mine.cents,
    band: { minCents: cfg.minCents, maxCents: cfg.maxCents },
  };
}

/** Live spend plus what the programme is expected to cost — the figure a
 *  manager needs before switching it on. */
export function doorDropExposure(tenantId: number, nowMs: number, doorsPerRepPerDay = 70): {
  enabled: boolean;
  awardedTodayCents: number; dropsToday: number;
  activeReps: number; expectedDailyCents: number;
  worstCaseDailyCents: number;
  currentChanceAtDoors: Array<{ doors: number; pct: number }>;
} {
  const cfg = getDoorDropConfig(tenantId);
  const org = dropsToday(tenantId, null, nowMs);
  const reps = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM team_members WHERE tenant_id = ? AND active = 1`,
  ).get(tenantId) as any;
  const activeReps = Number(reps?.n ?? 0);

  return {
    enabled: cfg.enabled,
    awardedTodayCents: org.cents,
    dropsToday: org.count,
    activeReps,
    expectedDailyCents: expectedDailyCostCents(doorsPerRepPerDay, activeReps, cfg),
    // What it costs if every rep hits their personal ceiling on the same day —
    // bounded by the org cap, which is why that cap exists.
    worstCaseDailyCents: cfg.maxCentsPerOrgPerDay > 0
      ? Math.min(cfg.maxCentsPerRepPerDay * activeReps, cfg.maxCentsPerOrgPerDay)
      : cfg.maxCentsPerRepPerDay * activeReps,
    // The curve, so a manager can see what they are actually setting rather than
    // trusting a single odds number.
    currentChanceAtDoors: [1, 10, 25, 50, 100, cfg.pityAtDoors].map(doors => ({
      doors, pct: Math.round(dropChance(doors, cfg) * 100),
    })),
  };
}
