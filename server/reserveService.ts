// ── Chargeback reserve — ledger, policy resolution, admin actions ─────────────
//
// A percentage of every rep's weekly pay is withheld as a chargeback reserve.
// It builds to a per-rep cap ($2,500 by default) and then STOPS. Two product
// decisions are baked in here and must not be "improved" on:
//
//   • Chargebacks are applied MANUALLY by an admin. The reserve NEVER auto-draws
//     when a sale reverses — a human decides what a chargeback is worth.
//   • Release is MANUAL. Nothing auto-releases on a timer, on termination, or on
//     any other event. An admin explicitly returns a balance.
//
// `reserve_entries` is the ONE source of truth for a balance, and it is
// APPEND-ONLY (DB triggers ABORT any UPDATE/DELETE — server/storage.ts). The
// balance is SUM(amount_cents) computed in SQL, never folded in JS floats.
// Corrections are new rows, so a rep's reserve history can be replayed forever.
//
// The split arithmetic lives in the PURE shared/commissionReserve; nothing in
// this file re-derives it.

import { rawDb } from "./db";
import { storage } from "./storage";
import {
  computeHoldback, normalizeReserveCap, DEFAULT_RESERVE_CAP_CENTS, type Holdback,
} from "@shared/commissionReserve";

// ── Errors ────────────────────────────────────────────────────────────────────
// Same shape as CommissionError (code + httpStatus) so the shared route `fail`
// helper maps both. Cross-tenant is 404, never 403 — repo convention: a tenant
// must not be able to probe another tenant's id space.
export type ReserveErrorCode =
  | "RESERVE_REP_NOT_FOUND" | "RESERVE_INVALID_CONFIG" | "RESERVE_INVALID_AMOUNT"
  | "RESERVE_REASON_REQUIRED" | "RESERVE_INSUFFICIENT_BALANCE";

export class ReserveError extends Error {
  constructor(public code: ReserveErrorCode, message: string, public httpStatus = 400) {
    super(message);
    this.name = "ReserveError";
  }
}

/** Upper bound on a single manual movement / a configured cap ($1,000,000).
 *  A fat-fingered extra zero is a support ticket, not a payroll incident. */
const MAX_RESERVE_CENTS = 100_000_000;

export type ReserveEntryKind = "hold" | "drawdown" | "release";

export interface RepReserveConfig {
  /** The percent actually applied this week. */
  reservePercent: number;
  /** The ceiling actually applied. `null` = uncapped. */
  reserveCapCents: number | null;
  /** The rep's raw overrides — `null` means "inherit". Drives the editor. */
  repReservePercent: number | null;
  repReserveCapCents: number | null;
  /** The org defaults the overrides fall back to. */
  orgReservePercent: number;
  orgReserveCapCents: number | null;
  /** Which level supplied each effective value (for the admin UI's "inherited"). */
  percentSource: "rep" | "org";
  capSource: "rep" | "org" | "default";
}

/** Tenant-scoped rep lookup. Cross-tenant (or unknown) → 404, never 403. */
function requireRep(tenantId: number, repId: number): { id: number; reserve_percent: number | null; reserve_cap_cents: number | null } {
  const row = rawDb.prepare(
    `SELECT id, reserve_percent, reserve_cap_cents FROM team_members WHERE id = ? AND tenant_id = ?`
  ).get(repId, tenantId) as any;
  if (!row) throw new ReserveError("RESERVE_REP_NOT_FOUND", "Rep not found.", 404);
  return row;
}

/**
 * Resolve the reserve policy in force for one rep:
 *   percent = rep override ?? org percent (0 = disabled)
 *   cap     = rep override ?? org cap ?? $2,500 default;  0 = uncapped
 * A NULL override inherits — which is what every pre-existing row is, so an org
 * that never touches this screen keeps exactly the behaviour it has today.
 */
export function resolveRepReserveConfig(tenantId: number, repId: number): RepReserveConfig {
  const rep = requireRep(tenantId, repId);
  const org = rawDb.prepare(
    `SELECT commission_reserve_percent AS pct, commission_reserve_cap_cents AS cap FROM tenants WHERE id = ?`
  ).get(tenantId) as any;

  const orgReservePercent = clampPercent(org?.pct ?? 0);
  const orgReserveCapRaw: number | null = org?.cap == null ? null : Math.trunc(org.cap);

  const repPct = rep.reserve_percent == null ? null : clampPercent(rep.reserve_percent);
  const repCap = rep.reserve_cap_cents == null ? null : Math.trunc(rep.reserve_cap_cents);

  const effectiveCapRaw = repCap != null ? repCap : orgReserveCapRaw != null ? orgReserveCapRaw : DEFAULT_RESERVE_CAP_CENTS;

  return {
    reservePercent: repPct != null ? repPct : orgReservePercent,
    reserveCapCents: normalizeReserveCap(effectiveCapRaw),
    repReservePercent: repPct,
    repReserveCapCents: repCap,
    orgReservePercent,
    orgReserveCapCents: orgReserveCapRaw,
    percentSource: repPct != null ? "rep" : "org",
    capSource: repCap != null ? "rep" : orgReserveCapRaw != null ? "org" : "default",
  };
}

function clampPercent(v: any): number {
  return Math.min(100, Math.max(0, Math.trunc(Number(v) || 0)));
}

// ── Balance (SQL, never JS folding) ───────────────────────────────────────────
/** The rep's reserve balance = SUM(amount_cents) over the append-only ledger.
 *  Tenant-scoped. Integer cents; SQLite SUM over INTEGERs is exact. */
export function getReserveBalanceCents(tenantId: number, repId: number): number {
  const row = rawDb.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS bal FROM reserve_entries WHERE tenant_id = ? AND rep_id = ?`
  ).get(tenantId, repId) as any;
  return Number(row?.bal ?? 0);
}

export interface ReserveEntryDTO {
  id: number; kind: ReserveEntryKind; amountCents: number;
  statementId: number | null; weekStartUtc: string | null; weekLabel: string | null;
  reason: string; actorUserId: number | null; createdAt: string;
}

export function listReserveEntries(tenantId: number, repId: number, limit = 200): ReserveEntryDTO[] {
  const rows = rawDb.prepare(
    `SELECT id, kind, amount_cents AS amountCents, statement_id AS statementId,
            week_start_utc AS weekStartUtc, week_label AS weekLabel, reason,
            actor_user_id AS actorUserId, created_at AS createdAt
       FROM reserve_entries WHERE tenant_id = ? AND rep_id = ?
      ORDER BY id DESC LIMIT ?`
  ).all(tenantId, repId, Math.min(1000, Math.max(1, Math.trunc(limit)))) as any[];
  return rows as ReserveEntryDTO[];
}

// ── Weekly hold (idempotent per rep + week) ───────────────────────────────────

export interface HoldResult {
  /** True only when THIS call appended the row. A repeat call returns false. */
  inserted: boolean;
  /** The split that was (or already had been) applied for this week. */
  holdback: Holdback;
  balanceCents: number;
}

/**
 * Append the week's `hold` for a rep, cap-aware, EXACTLY ONCE.
 *
 * Idempotency is a UNIQUE partial index on (tenant, rep, week_start_utc) WHERE
 * kind='hold' — the DB, not a JS check, is what guarantees a recalculated or
 * re-finalized statement cannot double-hold. The second insert is ignored and
 * the already-recorded amount is returned.
 *
 * The hold is computed INSIDE the transaction against the live balance so two
 * concurrent settles can never both see the same headroom and jointly overshoot
 * the cap. A zero/negative earned week, a 0% rate, or a balance already at the
 * cap all append nothing at all (an amount-0 row is rejected by trigger anyway).
 */
export function recordWeeklyHold(input: {
  tenantId: number; repId: number; statementId: number | null;
  weekStartUtc: string; weekLabel?: string | null;
  earnedCents: number; actorId: number | null;
}): HoldResult {
  const { tenantId, repId, weekStartUtc } = input;
  const cfg = resolveRepReserveConfig(tenantId, repId);

  const run = rawDb.transaction((): HoldResult => {
    const existing = rawDb.prepare(
      `SELECT amount_cents AS amountCents FROM reserve_entries
        WHERE tenant_id = ? AND rep_id = ? AND kind = 'hold' AND week_start_utc = ?`
    ).get(tenantId, repId, weekStartUtc) as any;

    const balanceCents = getReserveBalanceCents(tenantId, repId);
    if (existing) {
      // Already held for this week. Report the RECORDED amount — never recompute
      // it, or a display could disagree with the ledger that actually paid.
      const held = Number(existing.amountCents || 0);
      return {
        inserted: false,
        holdback: computeHoldback({
          earnedCents: Math.trunc(input.earnedCents || 0),
          reservePercent: cfg.reservePercent,
          reserveCapCents: cfg.reserveCapCents,
          currentBalanceCents: balanceCents - held,   // the balance the hold was taken against
        }),
        balanceCents,
      };
    }

    const holdback = computeHoldback({
      earnedCents: Math.trunc(input.earnedCents || 0),
      reservePercent: cfg.reservePercent,
      reserveCapCents: cfg.reserveCapCents,
      currentBalanceCents: balanceCents,
    });
    if (holdback.reserveCents <= 0) return { inserted: false, holdback, balanceCents };

    const info = rawDb.prepare(
      `INSERT OR IGNORE INTO reserve_entries
         (tenant_id, rep_id, kind, amount_cents, statement_id, week_start_utc, week_label, reason, actor_user_id, created_at)
       VALUES (?,?,'hold',?,?,?,?,?,?,?)`
    ).run(
      tenantId, repId, holdback.reserveCents, input.statementId ?? null, weekStartUtc,
      input.weekLabel ?? null,
      `Weekly chargeback reserve — ${holdback.reservePercent}% of ${holdback.earnedCents} cents earned`,
      input.actorId ?? null, new Date().toISOString(),
    );
    // changes === 0 means a concurrent writer won the unique index. Not an error:
    // the week is held exactly once, which is the whole contract.
    const inserted = info.changes > 0;
    return { inserted, holdback, balanceCents: getReserveBalanceCents(tenantId, repId) };
  });

  const result = run();
  if (result.inserted) {
    storage.logActivity(input.actorId, "reserve.hold.recorded", "team_member", repId, {
      tenantId, repId, weekStartUtc, statementId: input.statementId ?? null,
      earnedCents: Math.trunc(input.earnedCents || 0),
      heldCents: result.holdback.reserveCents,
      reservePercent: result.holdback.reservePercent,
      reserveCapCents: result.holdback.reserveCapCents,
      balanceCents: result.balanceCents,
    }, undefined, tenantId);
  }
  return result;
}

/**
 * Backfill holds for every SETTLED (FINALIZED/PAID) week that has none yet, in
 * chronological order so the cap is applied in the order the money was actually
 * earned. Idempotent by the same unique index — a no-op after the first pass, and
 * the reason a tenant that enables the reserve today still gets a truthful
 * balance for weeks already locked.
 *
 * OPEN weeks are deliberately excluded: an open week is live-recomputed on every
 * knock, so holding against it would accrue off money that has not been paid.
 */
export function ensureHoldsForSettledStatements(tenantId: number, repId: number, actorId: number | null): number {
  const cfg = resolveRepReserveConfig(tenantId, repId);
  if (cfg.reservePercent <= 0) return 0;      // reserve disabled → nothing to accrue
  const rows = rawDb.prepare(
    `SELECT s.id, s.week_start_utc AS weekStartUtc, s.local_week_label AS weekLabel,
            s.final_commission_cents AS finalCents
       FROM commission_statements s
      WHERE s.tenant_id = ? AND s.rep_id = ? AND s.status IN ('FINALIZED','PAID')
        AND NOT EXISTS (
          SELECT 1 FROM reserve_entries r
           WHERE r.tenant_id = s.tenant_id AND r.rep_id = s.rep_id
             AND r.kind = 'hold' AND r.week_start_utc = s.week_start_utc)
      ORDER BY s.week_start_utc ASC`
  ).all(tenantId, repId) as any[];
  let created = 0;
  for (const r of rows) {
    const res = recordWeeklyHold({
      tenantId, repId, statementId: Number(r.id), weekStartUtc: String(r.weekStartUtc),
      weekLabel: r.weekLabel ?? null, earnedCents: Number(r.finalCents || 0), actorId,
    });
    if (res.inserted) created++;
  }
  return created;
}

// ── Manual admin movements ────────────────────────────────────────────────────

function validateMovement(amountCents: any, reason: any): { amount: number; reason: string } {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new ReserveError("RESERVE_INVALID_AMOUNT", "Amount must be a whole number of cents above zero.");
  }
  if (amountCents > MAX_RESERVE_CENTS) {
    throw new ReserveError("RESERVE_INVALID_AMOUNT", "Amount is implausibly large — check the number.");
  }
  const r = typeof reason === "string" ? reason.trim() : "";
  if (!r) throw new ReserveError("RESERVE_REASON_REQUIRED", "A reason is required.");
  return { amount: amountCents, reason: r.slice(0, 500) };
}

/** Shared writer for the two NEGATIVE movements. The non-negative guard and the
 *  insert happen in ONE transaction against the SQL balance, so no interleaving
 *  of two admins can drive a rep's reserve below zero. */
function appendNegativeEntry(input: {
  tenantId: number; repId: number; kind: "drawdown" | "release";
  amountCents: number; reason: string; actorId: number | null;
}): { entry: ReserveEntryDTO; balanceCents: number; previousBalanceCents: number } {
  const { tenantId, repId, kind } = input;
  requireRep(tenantId, repId);
  const { amount, reason } = validateMovement(input.amountCents, input.reason);

  const run = rawDb.transaction(() => {
    const previousBalanceCents = getReserveBalanceCents(tenantId, repId);
    if (amount > previousBalanceCents) {
      throw new ReserveError("RESERVE_INSUFFICIENT_BALANCE",
        kind === "drawdown"
          ? "That chargeback is larger than the rep's reserve balance. The reserve can never go negative — reduce the amount or use a commission adjustment for the remainder."
          : "That release is larger than the rep's reserve balance. The reserve can never go negative.");
    }
    const now = new Date().toISOString();
    const info = rawDb.prepare(
      `INSERT INTO reserve_entries (tenant_id, rep_id, kind, amount_cents, reason, actor_user_id, created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(tenantId, repId, kind, -amount, reason, input.actorId ?? null, now);
    const entry = rawDb.prepare(
      `SELECT id, kind, amount_cents AS amountCents, statement_id AS statementId,
              week_start_utc AS weekStartUtc, week_label AS weekLabel, reason,
              actor_user_id AS actorUserId, created_at AS createdAt
         FROM reserve_entries WHERE id = ?`
    ).get(Number(info.lastInsertRowid)) as ReserveEntryDTO;
    return { entry, balanceCents: getReserveBalanceCents(tenantId, repId), previousBalanceCents };
  });

  const out = run();
  storage.logActivity(input.actorId, `reserve.${kind}.applied`, "team_member", repId, {
    tenantId, repId, entryId: out.entry.id, amountCents: -amount, reason,
    balanceBeforeCents: out.previousBalanceCents, balanceAfterCents: out.balanceCents,
  }, undefined, tenantId);
  return out;
}

/** Apply a chargeback against the rep's reserve. MANUAL by product decision —
 *  a reversed sale never draws this down on its own. */
export function applyDrawdown(input: {
  tenantId: number; repId: number; amountCents: number; reason: string; actorId: number | null;
}) {
  return appendNegativeEntry({ ...input, kind: "drawdown" });
}

/** Return reserve to the rep. MANUAL by product decision — nothing releases on a
 *  timer or on departure. `amountCents: null` releases the FULL balance. */
export function releaseReserve(input: {
  tenantId: number; repId: number; amountCents: number | null; reason: string; actorId: number | null;
}) {
  requireRep(input.tenantId, input.repId);
  const amount = input.amountCents == null ? getReserveBalanceCents(input.tenantId, input.repId) : input.amountCents;
  if (input.amountCents == null && amount <= 0) {
    throw new ReserveError("RESERVE_INSUFFICIENT_BALANCE", "There is no reserve balance to release.");
  }
  return appendNegativeEntry({ ...input, amountCents: amount, kind: "release" });
}

// ── Config write (comp editor + onboarding) ───────────────────────────────────

/**
 * Set (or clear) a rep's reserve overrides. `undefined` leaves a field alone;
 * `null` clears it back to "inherit the org default". Audited with the exact
 * before/after so a pay-affecting change is never anonymous.
 */
export function setRepReserveConfig(
  tenantId: number, repId: number, actorId: number | null,
  patch: { reservePercent?: number | null; reserveCapCents?: number | null },
): RepReserveConfig {
  const before = resolveRepReserveConfig(tenantId, repId);

  const sets: string[] = []; const params: any[] = [];
  if (patch.reservePercent !== undefined) {
    if (patch.reservePercent !== null) {
      if (!Number.isInteger(patch.reservePercent) || patch.reservePercent < 0 || patch.reservePercent > 100) {
        throw new ReserveError("RESERVE_INVALID_CONFIG", "Reserve percent must be a whole number from 0 to 100.");
      }
    }
    sets.push("reserve_percent = ?"); params.push(patch.reservePercent);
  }
  if (patch.reserveCapCents !== undefined) {
    if (patch.reserveCapCents !== null) {
      if (!Number.isInteger(patch.reserveCapCents) || patch.reserveCapCents < 0 || patch.reserveCapCents > MAX_RESERVE_CENTS) {
        throw new ReserveError("RESERVE_INVALID_CONFIG", "Reserve cap must be a whole number of cents from 0 to $1,000,000.");
      }
    }
    sets.push("reserve_cap_cents = ?"); params.push(patch.reserveCapCents);
  }
  if (sets.length === 0) return before;

  params.push(repId, tenantId);
  rawDb.prepare(`UPDATE team_members SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`).run(...params);
  const after = resolveRepReserveConfig(tenantId, repId);

  storage.logActivity(actorId, "reserve.config.updated", "team_member", repId, {
    tenantId, repId,
    before: { reservePercent: before.repReservePercent, reserveCapCents: before.repReserveCapCents, effectivePercent: before.reservePercent, effectiveCapCents: before.reserveCapCents },
    after: { reservePercent: after.repReservePercent, reserveCapCents: after.repReserveCapCents, effectivePercent: after.reservePercent, effectiveCapCents: after.reserveCapCents },
  }, undefined, tenantId);
  return after;
}

// ── Read model ────────────────────────────────────────────────────────────────

export interface ReserveSummary {
  repId: number;
  reservePercent: number;
  reserveCapCents: number | null;
  balanceCents: number;
  /** Room left under the cap. `null` when uncapped. */
  capRemainingCents: number | null;
  /** 0..100, integer percent of the cap reached. `null` when uncapped. */
  capProgressPercent: number | null;
  /** True when the balance has reached the cap — nothing more is being held. */
  atCap: boolean;
  heldToDateCents: number;
  drawnDownToDateCents: number;
  releasedToDateCents: number;
  /** The most recent `hold`, i.e. "this week's hold" once the week settles. */
  latestHold: ReserveEntryDTO | null;
  entries: ReserveEntryDTO[];
  config: RepReserveConfig;
}

/** Summary + history for one rep. `ensureHolds` backfills any settled week that
 *  predates the ledger so the balance shown is complete; it is idempotent. */
export function getReserveSummary(
  tenantId: number, repId: number,
  opts: { actorId?: number | null; ensureHolds?: boolean; historyLimit?: number } = {},
): ReserveSummary {
  const config = resolveRepReserveConfig(tenantId, repId);
  if (opts.ensureHolds !== false) ensureHoldsForSettledStatements(tenantId, repId, opts.actorId ?? null);

  const totals = rawDb.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS balance,
            COALESCE(SUM(CASE WHEN kind = 'hold'     THEN amount_cents ELSE 0 END), 0) AS held,
            COALESCE(SUM(CASE WHEN kind = 'drawdown' THEN -amount_cents ELSE 0 END), 0) AS drawn,
            COALESCE(SUM(CASE WHEN kind = 'release'  THEN -amount_cents ELSE 0 END), 0) AS released
       FROM reserve_entries WHERE tenant_id = ? AND rep_id = ?`
  ).get(tenantId, repId) as any;

  const balanceCents = Number(totals?.balance ?? 0);
  const cap = config.reserveCapCents;
  const capRemainingCents = cap == null ? null : Math.max(0, cap - balanceCents);
  const entries = listReserveEntries(tenantId, repId, opts.historyLimit ?? 50);
  // Queried independently of the (windowed) history so "this week's hold" is
  // still right for a rep with a long drawdown/release trail.
  const latestHold = rawDb.prepare(
    `SELECT id, kind, amount_cents AS amountCents, statement_id AS statementId,
            week_start_utc AS weekStartUtc, week_label AS weekLabel, reason,
            actor_user_id AS actorUserId, created_at AS createdAt
       FROM reserve_entries WHERE tenant_id = ? AND rep_id = ? AND kind = 'hold'
      ORDER BY week_start_utc DESC, id DESC LIMIT 1`
  ).get(tenantId, repId) as ReserveEntryDTO | undefined;

  return {
    repId,
    reservePercent: config.reservePercent,
    reserveCapCents: cap,
    balanceCents,
    capRemainingCents,
    // Integer math only: (balance * 100) / cap, floored, clamped to 0..100.
    capProgressPercent: cap == null || cap <= 0 ? null : Math.min(100, Math.floor((balanceCents * 100) / cap)),
    atCap: cap != null && balanceCents >= cap,
    heldToDateCents: Number(totals?.held ?? 0),
    drawnDownToDateCents: Number(totals?.drawn ?? 0),
    releasedToDateCents: Number(totals?.released ?? 0),
    latestHold: latestHold ?? null,
    entries,
    config,
  };
}
