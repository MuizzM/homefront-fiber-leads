// ── Hourly Pay service — hours → pay for the hybrid hourly+commission plane ──
// Hours come from clock_sessions (append-only — raw rows are NEVER edited),
// folded with signed punch_corrections, priced at the rep's hourly rate
// EFFECTIVE AT THE WEEK START (a mid-week rate change never re-prices the
// running week; prior rates are reconstructed from the 'pay.hourly_rate.changed'
// audit events). All times UTC (clock rows are written with toISOString), all
// money integer cents. Tenant-scoped; routes stay thin over these functions.
//
// Import direction matters: commissionService imports THIS module for the
// statement hourly block, so this module must never import commissionService.

import { rawDb } from "./db";
import { storage } from "./storage";

// ── Typed domain errors (mapped to HTTP by the routes module) ────────────────
export type HourlyPayErrorCode =
  | "CROSS_TENANT_ACCESS" | "UNAUTHORIZED_PAY_ACTION" | "INVALID_HOURLY_RATE"
  | "INVALID_PUNCH_CORRECTION" | "INVALID_PAY_DISPUTE" | "DISPUTE_NOT_OPEN";

export class HourlyPayError extends Error {
  constructor(public code: HourlyPayErrorCode, message: string, public httpStatus = 400) {
    super(message);
    this.name = "HourlyPayError";
  }
}

const DAY_MS = 86_400_000;
const MAX_DAY_MINUTES = 16 * 60; // 16h/day sanity cap — exceeded days are FLAGGED

// ── Hours aggregation ─────────────────────────────────────────────────────────
export interface WeekHoursResult {
  minutes: number;             // billable minutes after per-day floor at 0
  hours: number;               // minutes / 60, 2dp
  sessionMinutes: number;      // from clock_sessions only (before corrections/floors)
  correctionMinutes: number;   // signed sum of in-week punch corrections
  openSessionCount: number;    // open sessions overlapping the week (blocks finalize)
  weekEnded: boolean;          // now >= weekEnd
  finalizable: boolean;        // weekEnded AND no open sessions remain
  dailyCapFlags: Array<{ date: string; minutes: number }>; // UTC days over 16h
}

// Accumulate [startMs, endMs) into per-UTC-day minute buckets (a session that
// crosses midnight splits so the per-day floor + 16h cap see true days).
function splitIntoUtcDays(acc: Map<string, number>, startMs: number, endMs: number) {
  let s = startMs;
  while (s < endMs) {
    const dayStart = Math.floor(s / DAY_MS) * DAY_MS;
    const e = Math.min(endMs, dayStart + DAY_MS);
    const key = new Date(dayStart).toISOString().slice(0, 10);
    acc.set(key, (acc.get(key) ?? 0) + (e - s) / 60_000);
    s = e;
  }
}

/**
 * Sum a rep's hours for the half-open week [weekStartUtc, weekEndUtc).
 * Closed sessions are clamped to the week boundary; OPEN sessions count through
 * min(now, weekEnd) so the live week accrues, but they keep the week
 * non-finalizable (a week is final only when it has ended AND no open session
 * remains — finalization is blocked with the OPEN_CLOCK_SESSION exception).
 * Punch corrections are folded in per UTC day with a floor at 0/day; days over
 * 16h are counted but flagged.
 */
export function hoursWorkedThisWeek(
  tenantId: number, repId: number, weekStartUtc: string, weekEndUtc: string, now: Date = new Date(),
): WeekHoursResult {
  const wkS = Date.parse(weekStartUtc);
  const wkE = Date.parse(weekEndUtc);
  const nowMs = now.getTime();
  const daySessions = new Map<string, number>();
  const dayCorrections = new Map<string, number>();

  const sessions = rawDb.prepare(
    `SELECT id, clocked_in AS inTs, clocked_out AS outTs FROM clock_sessions
     WHERE rep_id = ? AND (tenant_id = ? OR tenant_id IS NULL)
       AND clocked_in < ? AND (clocked_out IS NULL OR clocked_out > ?)`,
  ).all(repId, tenantId, weekEndUtc, weekStartUtc) as Array<{ id: number; inTs: string; outTs: string | null }>;

  let openSessionCount = 0;
  for (const s of sessions) {
    const inMs = Date.parse(s.inTs);
    if (!Number.isFinite(inMs)) continue;
    const start = Math.max(inMs, wkS);
    if (s.outTs == null) {
      // Open session: accrues through min(now, weekEnd) for the live read;
      // its mere presence blocks finalization of an ended week.
      openSessionCount++;
      const end = Math.min(nowMs, wkE);
      if (end > start) splitIntoUtcDays(daySessions, start, end);
    } else {
      const outMs = Date.parse(s.outTs);
      if (!Number.isFinite(outMs)) continue;
      const end = Math.min(outMs, wkE);
      if (end > start) splitIntoUtcDays(daySessions, start, end);
    }
  }

  // Signed corrections, attributed to a UTC day (the session's clock-in day
  // when the correction names a session, else the correction's created day).
  // Only corrections whose attributed day falls inside the week count.
  const corrections = rawDb.prepare(
    `SELECT pc.minutes_delta AS delta, pc.created_at AS createdAt, cs.clocked_in AS sessionIn
     FROM punch_corrections pc LEFT JOIN clock_sessions cs ON cs.id = pc.session_id
     WHERE pc.tenant_id = ? AND pc.rep_id = ?`,
  ).all(tenantId, repId) as Array<{ delta: number; createdAt: string; sessionIn: string | null }>;

  const firstDay = weekStartUtc.slice(0, 10);
  const endDay = weekEndUtc.slice(0, 10); // exclusive (week end is a day boundary)
  let correctionMinutes = 0;
  for (const c of corrections) {
    const dayKey = (c.sessionIn ?? c.createdAt ?? "").slice(0, 10);
    if (!dayKey || dayKey < firstDay || dayKey >= endDay) continue;
    const delta = Math.trunc(Number(c.delta) || 0);
    dayCorrections.set(dayKey, (dayCorrections.get(dayKey) ?? 0) + delta);
    correctionMinutes += delta;
  }

  const days = new Set([...daySessions.keys(), ...dayCorrections.keys()]);
  let minutes = 0;
  let sessionMinutes = 0;
  const dailyCapFlags: Array<{ date: string; minutes: number }> = [];
  for (const day of days) {
    const sess = daySessions.get(day) ?? 0;
    sessionMinutes += sess;
    const total = Math.max(0, sess + (dayCorrections.get(day) ?? 0)); // floor at 0/day
    minutes += total;
    if (total > MAX_DAY_MINUTES) {
      dailyCapFlags.push({ date: day, minutes: Math.round(total) });
    }
  }
  dailyCapFlags.sort((a, b) => a.date.localeCompare(b.date));
  minutes = Math.round(minutes);
  const weekEnded = nowMs >= wkE;
  return {
    minutes,
    hours: Math.round((minutes / 60) * 100) / 100,
    sessionMinutes: Math.round(sessionMinutes),
    correctionMinutes,
    openSessionCount,
    weekEnded,
    finalizable: weekEnded && openSessionCount === 0,
    dailyCapFlags,
  };
}

// ── Rate resolution (effective-at-week-start) ─────────────────────────────────
// The team_members row holds only the CURRENT rate; the full timeline lives in
// the 'pay.hourly_rate.changed' audit events (each carries newRateCents +
// effectiveFrom). The rate for a week is the one with the LATEST effectiveFrom
// at or before the week start — so a mid-week change keeps the old rate for the
// running week and prices the next.
export function hourlyRateEffectiveAt(repId: number, atUtc: string): { rateCents: number | null; effectiveFrom: string | null } {
  const atMs = Date.parse(atUtc);
  const entries: Array<{ rateCents: number | null; effMs: number; seq: number }> = [];
  const events = rawDb.prepare(
    `SELECT id, details FROM activity_log
     WHERE action = 'pay.hourly_rate.changed' AND entity_type = 'team_member' AND entity_id = ?
     ORDER BY id ASC`,
  ).all(repId) as Array<{ id: number; details: string | null }>;
  for (const ev of events) {
    try {
      const d = JSON.parse(ev.details ?? "{}");
      const effMs = Date.parse(d?.effectiveFrom ?? "");
      if (Number.isFinite(effMs)) {
        entries.push({ rateCents: d?.newRateCents ?? null, effMs, seq: ev.id });
      }
    } catch { /* a malformed audit row never breaks pay */ }
  }
  // The current row mirrors the latest change (and may be the ONLY record for a
  // rate written before the audit stream existed). A null effective_from means
  // "always effective" (legacy seed) — lowest precedence.
  const rep = storage.getTeamMemberById(repId) as any;
  if (rep && rep.hourlyRateCents != null) {
    const effMs = rep.hourlyRateEffectiveFrom ? Date.parse(rep.hourlyRateEffectiveFrom) : Number.NEGATIVE_INFINITY;
    entries.push({ rateCents: rep.hourlyRateCents, effMs: Number.isFinite(effMs) ? effMs : Number.NEGATIVE_INFINITY, seq: Number.MAX_SAFE_INTEGER });
  }
  let best: { rateCents: number | null; effMs: number; seq: number } | null = null;
  for (const e of entries) {
    if (e.effMs <= atMs && (!best || e.effMs > best.effMs || (e.effMs === best.effMs && e.seq > best.seq))) best = e;
  }
  return {
    rateCents: best?.rateCents ?? null,
    effectiveFrom: best && Number.isFinite(best.effMs) ? new Date(best.effMs).toISOString() : null,
  };
}

export interface WeekHourlyPay extends WeekHoursResult {
  rateCents: number | null;    // rate effective at weekStartUtc (null = commission-only)
  payCents: number;            // round(minutes × rate / 60) — integer cents
}

// The weekly hourly block: hours × the rate effective at week start.
export function hourlyPayForWeek(
  tenantId: number, repId: number, weekStartUtc: string, weekEndUtc: string, now?: Date,
): WeekHourlyPay {
  const hours = hoursWorkedThisWeek(tenantId, repId, weekStartUtc, weekEndUtc, now);
  const rate = hourlyRateEffectiveAt(repId, weekStartUtc);
  const payCents = rate.rateCents != null ? Math.round((hours.minutes * rate.rateCents) / 60) : 0;
  return { ...hours, rateCents: rate.rateCents, payCents };
}

// The statement-JSON hourly block ({hours, rateCents, hourlyPayCents}) from a
// persisted commission_statements row. NULL minutes = a statement generated
// before the hourly plane existed → no block.
export function hourlyBlockForStatement(stmt: any): { hours: number; rateCents: number | null; hourlyPayCents: number } | null {
  if (!stmt || stmt.hourly_minutes == null) return null;
  return {
    hours: Math.round((Number(stmt.hourly_minutes) / 60) * 100) / 100,
    rateCents: stmt.hourly_rate_cents ?? null,
    hourlyPayCents: Number(stmt.hourly_pay_cents ?? 0),
  };
}

// ── Rate management ───────────────────────────────────────────────────────────
const MAX_HOURLY_RATE_CENTS = 1_000_000; // $10,000/hr — fat-finger sanity bound

export function setHourlyRate(
  tenantId: number, actorId: number | null, repId: number, rateCents: number | null, effectiveFrom?: string | null,
): any {
  const rep = storage.getTeamMemberById(repId) as any;
  if (!rep || rep.tenantId !== tenantId) throw new HourlyPayError("CROSS_TENANT_ACCESS", "Rep not found in tenant.", 404);
  if (rateCents !== null && (!Number.isInteger(rateCents) || rateCents < 0)) {
    throw new HourlyPayError("INVALID_HOURLY_RATE", "rateCents must be null (commission-only) or a non-negative integer.");
  }
  if (rateCents !== null && rateCents > MAX_HOURLY_RATE_CENTS) {
    throw new HourlyPayError("INVALID_HOURLY_RATE", "rateCents exceeds the sanity bound.");
  }
  const effMs = effectiveFrom ? Date.parse(effectiveFrom) : Date.now();
  if (!Number.isFinite(effMs)) throw new HourlyPayError("INVALID_HOURLY_RATE", "effectiveFrom must be a parseable date/time.");
  const effectiveIso = new Date(effMs).toISOString();

  const oldRate = rep.hourlyRateCents ?? null;
  const oldEff = rep.hourlyRateEffectiveFrom ?? null;
  if (oldRate === rateCents && oldEff === effectiveIso) {
    return storage.getTeamMemberById(repId); // no-op — no write, no audit noise
  }
  rawDb.prepare(`UPDATE team_members SET hourly_rate_cents = ?, hourly_rate_effective_from = ? WHERE id = ?`)
    .run(rateCents, effectiveIso, repId);
  // The audit event doubles as the rate HISTORY (newRateCents + effectiveFrom)
  // that hourlyRateEffectiveAt reconstructs prior-week rates from.
  storage.logActivity(actorId, "pay.hourly_rate.changed", "team_member", repId,
    { repId, oldRateCents: oldRate, newRateCents: rateCents, effectiveFrom: effectiveIso, actor: actorId }, undefined, tenantId);
  return storage.getTeamMemberById(repId);
}

// ── Punch corrections (append-only — clock_sessions rows are never edited) ────
export const PUNCH_CORRECTION_KINDS = ["missed_in", "missed_out", "adjust"] as const;
const MAX_CORRECTION_MINUTES = 7 * 24 * 60; // one week of minutes

export function addPunchCorrection(tenantId: number, actorId: number | null, input: {
  repId: number; sessionId?: number | null; kind: string; minutesDelta: number; reason: string;
}): any {
  const rep = storage.getTeamMemberById(input.repId) as any;
  if (!rep || rep.tenantId !== tenantId) throw new HourlyPayError("CROSS_TENANT_ACCESS", "Rep not found in tenant.", 404);
  if (!(PUNCH_CORRECTION_KINDS as readonly string[]).includes(input.kind)) {
    throw new HourlyPayError("INVALID_PUNCH_CORRECTION", `kind must be one of ${PUNCH_CORRECTION_KINDS.join("|")}.`);
  }
  if (!Number.isInteger(input.minutesDelta) || input.minutesDelta === 0) {
    throw new HourlyPayError("INVALID_PUNCH_CORRECTION", "minutesDelta must be a non-zero integer.");
  }
  if (Math.abs(input.minutesDelta) > MAX_CORRECTION_MINUTES) {
    throw new HourlyPayError("INVALID_PUNCH_CORRECTION", "minutesDelta exceeds the one-week sanity bound.");
  }
  if (!input.reason || !input.reason.trim()) throw new HourlyPayError("INVALID_PUNCH_CORRECTION", "A reason is required.");
  let sessionId: number | null = null;
  if (input.sessionId != null) {
    const s = rawDb.prepare(`SELECT id, rep_id AS repId, tenant_id AS tenantId FROM clock_sessions WHERE id = ?`).get(Number(input.sessionId)) as any;
    if (!s || Number(s.repId) !== Number(input.repId) || (s.tenantId != null && s.tenantId !== tenantId)) {
      throw new HourlyPayError("CROSS_TENANT_ACCESS", "Session not found for this rep.", 404);
    }
    sessionId = Number(s.id);
  }
  const info = rawDb.prepare(
    `INSERT INTO punch_corrections (tenant_id, rep_id, session_id, kind, minutes_delta, reason, actor_user_id, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(tenantId, input.repId, sessionId, input.kind, input.minutesDelta, input.reason.trim().slice(0, 500), actorId, new Date().toISOString());
  const row = rawDb.prepare(`SELECT * FROM punch_corrections WHERE id = ?`).get(info.lastInsertRowid);
  storage.logActivity(actorId, "pay.punch_correction.created", "punch_correction", Number(info.lastInsertRowid),
    { repId: input.repId, sessionId, kind: input.kind, minutesDelta: input.minutesDelta }, undefined, tenantId);
  return row;
}

// ── Pay disputes (rep-facing) ─────────────────────────────────────────────────
export type DisputeLine = "hourly" | "commission";

function markLegacyCommissionDisputed(tenantId: number, commissionId: number) {
  // pending|approved → disputed is legal in the legacy lifecycle; paid is
  // terminal and is left alone. Idempotent ("if it isn't already").
  rawDb.prepare(
    `UPDATE commissions SET status = 'disputed' WHERE id = ? AND tenant_id = ? AND status IN ('pending','approved')`,
  ).run(commissionId, tenantId);
}

export function openPayDispute(tenantId: number, actorId: number | null, input: {
  repId: number; weekStartUtc: string; line: DisputeLine | number;
  message: string; idemKey?: string | null;
}): { dispute: any; duplicate: boolean } {
  const rep = storage.getTeamMemberById(input.repId) as any;
  if (!rep || rep.tenantId !== tenantId) throw new HourlyPayError("CROSS_TENANT_ACCESS", "Rep not found in tenant.", 404);
  if (!Date.parse(input.weekStartUtc)) throw new HourlyPayError("INVALID_PAY_DISPUTE", "weekStart must be a parseable date/time.");
  if (!input.message || !input.message.trim()) throw new HourlyPayError("INVALID_PAY_DISPUTE", "A message is required.");

  let lineKind: DisputeLine;
  let commissionId: number | null = null;
  if (input.line === "hourly" || input.line === "commission") {
    lineKind = input.line;
  } else if (Number.isInteger(Number(input.line)) && Number(input.line) > 0) {
    // A specific legacy commission row — it must belong to THIS rep + tenant
    // (a rep never disputes another rep's row, and a foreign id is a 404).
    const c = storage.getCommissionById(Number(input.line), tenantId) as any;
    if (!c || Number(c.repId) !== Number(input.repId)) {
      throw new HourlyPayError("CROSS_TENANT_ACCESS", "Commission not found for this rep.", 404);
    }
    lineKind = "commission";
    commissionId = Number(input.line);
  } else {
    throw new HourlyPayError("INVALID_PAY_DISPUTE", "line must be 'hourly', 'commission', or a commission id.");
  }

  const idemKey = input.idemKey ? String(input.idemKey).slice(0, 128) : null;
  if (idemKey) {
    const prior = rawDb.prepare(`SELECT * FROM pay_disputes WHERE tenant_id = ? AND idem_key = ?`).get(tenantId, idemKey);
    if (prior) return { dispute: prior, duplicate: true };
  }
  let dispute: any;
  try {
    const info = rawDb.prepare(
      `INSERT INTO pay_disputes (tenant_id, rep_id, week_start, line_kind, commission_id, message, status, idem_key, created_at)
       VALUES (?,?,?,?,?,?, 'open', ?, ?)`,
    ).run(tenantId, input.repId, input.weekStartUtc, lineKind, commissionId, input.message.trim().slice(0, 5000), idemKey, new Date().toISOString());
    dispute = rawDb.prepare(`SELECT * FROM pay_disputes WHERE id = ?`).get(info.lastInsertRowid);
  } catch (e: any) {
    // Unique-index race on the idempotency key → return the existing row.
    if (idemKey && String(e?.message ?? "").includes("UNIQUE")) {
      const prior = rawDb.prepare(`SELECT * FROM pay_disputes WHERE tenant_id = ? AND idem_key = ?`).get(tenantId, idemKey);
      if (prior) return { dispute: prior, duplicate: true };
    }
    throw e;
  }
  // The disputed commission is now visibly under dispute (legal, idempotent).
  if (commissionId != null) markLegacyCommissionDisputed(tenantId, commissionId);
  storage.logActivity(actorId, "pay.dispute.opened", "pay_dispute", dispute.id,
    { repId: input.repId, weekStart: input.weekStartUtc, lineKind, commissionId }, undefined, tenantId);
  return { dispute, duplicate: false };
}

export function listPayDisputes(tenantId: number, filter: { repIds?: number[] | null; status?: string | null }): any[] {
  const clauses: string[] = ["tenant_id = ?"];
  const params: any[] = [tenantId];
  if (filter.repIds) {
    if (filter.repIds.length === 0) return [];
    clauses.push(`rep_id IN (${filter.repIds.map(() => "?").join(",")})`);
    params.push(...filter.repIds);
  }
  if (filter.status) { clauses.push("status = ?"); params.push(filter.status); }
  return rawDb.prepare(`SELECT * FROM pay_disputes WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC`).all(...params) as any[];
}

export function getPayDispute(tenantId: number, id: number): any {
  return rawDb.prepare(`SELECT * FROM pay_disputes WHERE id = ? AND tenant_id = ?`).get(id, tenantId);
}

export function resolvePayDispute(tenantId: number, actorId: number | null, id: number, input: {
  resolution: "upheld" | "adjusted"; note: string; adjustmentId?: number | null;
}): any {
  const dispute = getPayDispute(tenantId, id);
  if (!dispute) throw new HourlyPayError("CROSS_TENANT_ACCESS", "Dispute not found in tenant.", 404);
  if (dispute.status !== "open") throw new HourlyPayError("DISPUTE_NOT_OPEN", `Dispute is already ${dispute.status}.`, 409);
  if (input.resolution !== "upheld" && input.resolution !== "adjusted") {
    throw new HourlyPayError("INVALID_PAY_DISPUTE", "resolution must be 'upheld' or 'adjusted'.");
  }
  if (!input.note || !input.note.trim()) throw new HourlyPayError("INVALID_PAY_DISPUTE", "A resolution note is required.");

  let adjustmentId: number | null = null;
  if (input.resolution === "adjusted") {
    // The money math is NEVER duplicated here — an 'adjusted' resolution points
    // at an adjustment already created through the existing adjustments flow
    // (same tenant, same rep), which feeds the statement through decideAdjustment.
    if (input.adjustmentId == null || !Number.isInteger(Number(input.adjustmentId)) || Number(input.adjustmentId) <= 0) {
      throw new HourlyPayError("INVALID_PAY_DISPUTE", "An 'adjusted' resolution requires adjustmentId.");
    }
    const adj = rawDb.prepare(`SELECT * FROM commission_adjustments WHERE id = ? AND tenant_id = ?`).get(Number(input.adjustmentId), tenantId) as any;
    if (!adj) throw new HourlyPayError("CROSS_TENANT_ACCESS", "Adjustment not found in tenant.", 404);
    if (Number(adj.rep_id) !== Number(dispute.rep_id)) {
      throw new HourlyPayError("INVALID_PAY_DISPUTE", "Adjustment belongs to a different rep.");
    }
    adjustmentId = Number(adj.id);
  }
  rawDb.prepare(
    `UPDATE pay_disputes SET status = 'resolved', resolution = ?, resolution_note = ?, adjustment_id = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`,
  ).run(input.resolution, input.note.trim().slice(0, 5000), adjustmentId, actorId, new Date().toISOString(), id);
  if (dispute.commission_id != null) markLegacyCommissionDisputed(tenantId, dispute.commission_id);
  storage.logActivity(actorId, "pay.dispute.resolved", "pay_dispute", id,
    { repId: dispute.rep_id, resolution: input.resolution, adjustmentId }, undefined, tenantId);
  return rawDb.prepare(`SELECT * FROM pay_disputes WHERE id = ?`).get(id);
}

// ── Week spiff rollup (for the payroll CSV 'Spiffs' column) ───────────────────
// Approved/paid spiffs created inside the week. The spiffs table is created by
// spiffStore on import; if it doesn't exist on this DB yet, the column is 0.
export function sumWeekSpiffsByRep(tenantId: number, weekStartUtc: string, weekEndUtc: string): Map<number, number> {
  const out = new Map<number, number>();
  try {
    const rows = rawDb.prepare(
      `SELECT rep_id AS repId, SUM(amount_cents) AS s FROM spiffs
       WHERE tenant_id = ? AND status IN ('approved','paid') AND created_at >= ? AND created_at < ?
       GROUP BY rep_id`,
    ).all(tenantId, weekStartUtc, weekEndUtc) as Array<{ repId: number; s: number }>;
    for (const r of rows) out.set(Number(r.repId), Number(r.s ?? 0));
  } catch { /* spiffs ledger not initialized on this DB */ }
  return out;
}
