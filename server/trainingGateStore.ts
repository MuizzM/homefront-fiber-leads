// ── Training gate — persistence and the one authoritative check ─────────────
// The decision logic is pure and lives in shared/trainingGate.ts. This file
// owns the flag, the org's threshold, and the completed-lesson count the rule
// reads.
//
// ── THE FLAG DEFAULTS ON, THEN IS BACKFILLED OFF ONCE ───────────────────────
// `users.training_required` defaults to 1, so every account created from now on
// owes training. A one-time backfill sets it to 0 for every user that already
// existed when this shipped, which is what keeps a rep who has been selling for
// months from being locked out of their own route on a Tuesday.
//
// The backfill is guarded by its own marker row rather than by "did the column
// just get added", because an ALTER that partially applied and re-ran would
// otherwise re-grandfather accounts an admin had deliberately re-gated.

import { rawDb } from "./db";
import { storage } from "./storage";
import {
  isTrainingGated, isRoleExempt, gateProgress, validateRequiredLessons,
  type TrainingGateState,
} from "@shared/trainingGate";
import { TOTAL_TRAINING_LESSONS } from "@shared/trainingContent";

const REQUIRED_SETTING = "training.required_lessons";
const BACKFILL_MARKER = "training.gate_backfilled_v1";

export function ensureTrainingGateSchema(): void {
  // The column itself is declared in server/storage.ts alongside the other user
  // migrations, so it exists as soon as runMigrations() has run — before any
  // seed or fixture creates an account. Only the one-time backfill lives here.
  try { rawDb.exec(`ALTER TABLE users ADD COLUMN training_required INTEGER NOT NULL DEFAULT 1`); }
  catch (e: any) { if (!/duplicate column/i.test(e?.message ?? "")) throw e; }

  // Grandfather everyone who already exists — exactly once, ever.
  //
  // The marker is stored at tenant_id = 0, not NULL: app_settings is UNIQUE on
  // (tenant_id, key), and SQLite treats NULLs as distinct in a unique index, so
  // a NULL-tenant marker would insert a fresh row every boot and the backfill
  // would re-run forever — silently un-gating anyone an admin had re-gated.
  const done = rawDb.prepare(
    `SELECT value FROM app_settings WHERE tenant_id = 0 AND key = ? LIMIT 1`,
  ).get(BACKFILL_MARKER) as any;
  if (!done) {
    const n = rawDb.prepare(`UPDATE users SET training_required = 0`).run().changes;
    rawDb.prepare(
      `INSERT INTO app_settings (tenant_id, key, value, updated_at) VALUES (0,?,?,datetime('now'))
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
    ).run(BACKFILL_MARKER, String(n));
    console.log(`[training-gate] grandfathered ${n} existing account(s); new accounts require training`);
  }
}
ensureTrainingGateSchema();

/** How many lessons this org requires. Defaults to the whole curriculum, which
 *  is what "they have to finish training" means; an admin can lower it without a
 *  deploy when the full course is more than a first week needs. */
export function requiredLessons(tenantId: number | null | undefined): number {
  try {
    const raw = storage.getSetting(REQUIRED_SETTING, tenantId ?? null);
    if (raw == null || raw === "") return TOTAL_TRAINING_LESSONS;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > TOTAL_TRAINING_LESSONS) return TOTAL_TRAINING_LESSONS;
    return n;
  } catch { return TOTAL_TRAINING_LESSONS; }
}

export function setRequiredLessons(tenantId: number, actorId: number | null, value: number): number {
  const problem = validateRequiredLessons(value, TOTAL_TRAINING_LESSONS);
  if (problem) throw Object.assign(new Error(problem), { httpStatus: 400 });
  storage.setSetting(REQUIRED_SETTING, String(Math.trunc(value)), actorId, tenantId);
  storage.logActivity(actorId, "training.gate.threshold_set", "tenant", tenantId,
    { requiredLessons: Math.trunc(value), totalAvailable: TOTAL_TRAINING_LESSONS }, undefined);
  return Math.trunc(value);
}

/** Distinct lessons this user has completed. */
export function completedLessons(userId: number, tenantId: number | null | undefined): number {
  const row = rawDb.prepare(
    `SELECT COUNT(DISTINCT lesson_id) AS n FROM training_progress
      WHERE user_id = ? AND tenant_id = ?`,
  ).get(userId, tenantId ?? 0) as any;
  return Number(row?.n ?? 0);
}

export function trainingRequiredFor(userId: number): boolean {
  const row = rawDb.prepare(`SELECT training_required AS r FROM users WHERE id = ?`).get(userId) as any;
  return Number(row?.r ?? 0) === 1;
}

/** Assemble the state the pure rule reads for one signed-in user. */
export function gateStateFor(user: { id: number; role?: string | null; tenantId?: number | null }): TrainingGateState {
  return {
    role: user.role ?? null,
    trainingRequired: trainingRequiredFor(user.id),
    completedLessons: completedLessons(user.id, user.tenantId ?? null),
    requiredLessons: requiredLessons(user.tenantId ?? null),
  };
}

/** THE check. One call site for the middleware, one for the rep's own status. */
export function isGated(user: { id: number; role?: string | null; tenantId?: number | null }): boolean {
  return isTrainingGated(gateStateFor(user));
}

export interface GateStatus {
  gated: boolean;
  exempt: boolean;
  trainingRequired: boolean;
  progress: ReturnType<typeof gateProgress>;
  totalAvailable: number;
}

export function statusFor(user: { id: number; role?: string | null; tenantId?: number | null }): GateStatus {
  const state = gateStateFor(user);
  return {
    gated: isTrainingGated(state),
    exempt: !state.trainingRequired || ["admin", "super_admin", "manager", "team_lead"].includes(String(state.role ?? "")),
    trainingRequired: state.trainingRequired,
    progress: gateProgress(state),
    totalAvailable: TOTAL_TRAINING_LESSONS,
  };
}

/**
 * Turn the requirement on or off for one account.
 *
 * The manual unlock exists because reality outruns policy: a rep who trained in
 * person, a rehire, a transfer from another team. An admin can clear it without
 * anyone faking 91 lesson completions.
 */
export function setTrainingRequired(
  tenantId: number, actorId: number | null, targetUserId: number, required: boolean,
): boolean {
  const target = rawDb.prepare(`SELECT id, tenant_id FROM users WHERE id = ?`).get(targetUserId) as any;
  // Cross-tenant reads as not-found, never as a refusal that confirms the id.
  if (!target || Number(target.tenant_id) !== tenantId) return false;
  rawDb.prepare(`UPDATE users SET training_required = ? WHERE id = ?`).run(required ? 1 : 0, targetUserId);
  storage.logActivity(actorId, required ? "training.gate.required" : "training.gate.cleared",
    "user", targetUserId, { required }, undefined);
  return true;
}

export interface RosterRow {
  userId: number;
  name: string;
  email: string;
  role: string;
  completed: number;
  required: number;
  /** Is the requirement switched ON for this account? */
  trainingRequired: boolean;
  /** Is this account actually locked out right now? */
  gated: boolean;
}

/**
 * EVERY active person in the org with their training state — the admin's
 * lock/unlock console.
 *
 * Deliberately not just the currently-gated ones. An admin's most common need is
 * to LOCK someone who is presently unlocked (a rep grandfathered in when the
 * gate shipped, or one who needs re-training after a bad month), and you cannot
 * act on a person who is not on the list. Returning only the locked reps made
 * the one control an admin reaches for unreachable.
 *
 * Exempt roles are included but flagged, so it is visible WHY a manager has no
 * lock toggle rather than them being silently absent.
 */
export function trainingRoster(tenantId: number): RosterRow[] {
  const need = requiredLessons(tenantId);
  const rows = rawDb.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.training_required AS req,
            (SELECT COUNT(DISTINCT tp.lesson_id) FROM training_progress tp
              WHERE tp.user_id = u.id AND tp.tenant_id = u.tenant_id) AS completed
       FROM users u
      WHERE u.tenant_id = ? AND u.active = 1
      ORDER BY u.name ASC`,
  ).all(tenantId) as any[];

  return rows.map(r => {
    const completed = Number(r.completed ?? 0);
    const trainingRequired = Number(r.req ?? 0) === 1;
    const role = String(r.role ?? "");
    return {
      userId: Number(r.id), name: String(r.name), email: String(r.email), role,
      completed, required: need, trainingRequired,
      // The same rule the middleware enforces: exempt roles are never gated, and
      // neither is anyone who has cleared the bar.
      gated: trainingRequired && !isRoleExempt(role) && completed < need,
    };
  });
}

/** Back-compat: just the people currently locked out. */
export function gatedRoster(tenantId: number): RosterRow[] {
  return trainingRoster(tenantId).filter(r => r.gated);
}
