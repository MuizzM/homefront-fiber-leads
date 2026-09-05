// ── Academy store ─────────────────────────────────────────────────────────────
//
// Every query here is tenant-scoped and takes its user id from the caller, and
// the caller takes it from the session. No function accepts a user id from a
// request body, which is the whole reason rep A can never read rep B's coaching
// record through this layer.
//
// Lesson completions are NOT stored here. A path activity of kind "lesson"
// writes training_progress through the existing route, so the Academy path and
// the module library can never disagree about what a rep has read.

import { rawDb } from "./db";
import {
  DEFAULT_OFFER_CATALOG, validateOffer,
  type AcademyOffer, type CompetitorOffer, type OfferCatalog,
} from "@shared/academyOffers";
import { getActivity, isActivityId } from "@shared/academyPath";
import type { ActivityRecord, Assignment } from "@shared/academyProgress";
import type { SessionScore } from "@shared/academyScoring";
import type { RolePlaySession } from "@shared/academyRolePlay";

/** tenant_id is normalized to 0 for legacy users, the training_progress rule. */
function tid(tenantId: number | null | undefined): number {
  return tenantId ?? 0;
}

/** Resume blobs are small by design. A state larger than this is a bug or an
 *  abuse, and either way it does not belong in the row. */
export const MAX_STATE_BYTES = 16_384;
/** Transcripts are bounded too: a drill that ran to 200 turns is not a drill. */
export const MAX_TRANSCRIPT_BYTES = 262_144;
/** How many stored sessions a rep's own history returns. */
export const HISTORY_LIMIT = 50;

// ── Activity progress ─────────────────────────────────────────────────────────

export function listActivityProgress(userId: number, tenantId: number | null): ActivityRecord[] {
  return rawDb.prepare(
    `SELECT activity_id AS activityId, completed_at AS completedAt, score
       FROM academy_activity_progress
      WHERE tenant_id = ? AND user_id = ?
      ORDER BY completed_at ASC`,
  ).all(tid(tenantId), userId) as ActivityRecord[];
}

/**
 * Record a completion. Re-completing an activity keeps the BEST score rather
 * than the latest: a rep who runs a scenario again and does worse has not
 * un-learned it, and dropping their record would teach them not to practise.
 */
export function completeActivity(
  userId: number,
  tenantId: number | null,
  activityId: string,
  score: number | null,
  nowIso = new Date().toISOString(),
): ActivityRecord {
  if (!isActivityId(activityId)) throw new Error("unknown activity");
  const activity = getActivity(activityId)!;
  const clean = score == null ? null : Math.max(0, Math.min(100, Math.round(score)));
  // A scored activity that arrives with no score is a client bug; store null
  // rather than inventing a zero, and let the pass rule treat it as unpassed.
  if (activity.passScore != null && clean == null) {
    // no throw: the record still means "they did it", which the resume logic uses
  }
  rawDb.prepare(
    `INSERT INTO academy_activity_progress (tenant_id, user_id, activity_id, completed_at, score)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, user_id, activity_id) DO UPDATE SET
       completed_at = excluded.completed_at,
       score = CASE
         WHEN excluded.score IS NULL THEN academy_activity_progress.score
         WHEN academy_activity_progress.score IS NULL THEN excluded.score
         ELSE MAX(academy_activity_progress.score, excluded.score)
       END`,
  ).run(tid(tenantId), userId, activityId, nowIso, clean);

  return rawDb.prepare(
    `SELECT activity_id AS activityId, completed_at AS completedAt, score
       FROM academy_activity_progress
      WHERE tenant_id = ? AND user_id = ? AND activity_id = ?`,
  ).get(tid(tenantId), userId, activityId) as ActivityRecord;
}

// ── Resume state ──────────────────────────────────────────────────────────────

export type StoredState = { activityId: string; state: unknown; updatedAt: string };

export function listActivityStates(userId: number, tenantId: number | null): StoredState[] {
  const rows = rawDb.prepare(
    `SELECT activity_id AS activityId, state_json AS stateJson, updated_at AS updatedAt
       FROM academy_activity_state WHERE tenant_id = ? AND user_id = ?`,
  ).all(tid(tenantId), userId) as { activityId: string; stateJson: string; updatedAt: string }[];
  const out: StoredState[] = [];
  for (const row of rows) {
    try { out.push({ activityId: row.activityId, state: JSON.parse(row.stateJson), updatedAt: row.updatedAt }); }
    catch { /* skip corrupt */ }
  }
  return out;
}

export function saveActivityState(
  userId: number,
  tenantId: number | null,
  activityId: string,
  state: unknown,
  nowIso = new Date().toISOString(),
): StoredState {
  if (!isActivityId(activityId)) throw new Error("unknown activity");
  const json = JSON.stringify(state ?? null);
  if (json.length > MAX_STATE_BYTES) throw new Error("state too large");
  rawDb.prepare(
    `INSERT INTO academy_activity_state (tenant_id, user_id, activity_id, state_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, user_id, activity_id) DO UPDATE SET
       state_json = excluded.state_json, updated_at = excluded.updated_at`,
  ).run(tid(tenantId), userId, activityId, json, nowIso);
  return { activityId, state, updatedAt: nowIso };
}

export function clearActivityState(userId: number, tenantId: number | null, activityId: string): void {
  rawDb.prepare(
    `DELETE FROM academy_activity_state WHERE tenant_id = ? AND user_id = ? AND activity_id = ?`,
  ).run(tid(tenantId), userId, activityId);
}

// ── Role-play sessions ────────────────────────────────────────────────────────

export type StoredRolePlay = {
  sessionId: string;
  personaId: string;
  market: string;
  mode: string;
  outcome: string;
  overall: number;
  createdAt: string;
  transcript: RolePlaySession;
  score: SessionScore;
};

export type RolePlaySummary = Omit<StoredRolePlay, "transcript" | "score"> & { score: SessionScore };

/**
 * Store a completed drill. Idempotent on (user, sessionId): a retried submit
 * from a phone that lost signal mid-post must not create a second coaching
 * record, and must not double-count toward a certification average.
 */
export function saveRolePlaySession(
  userId: number,
  tenantId: number | null,
  input: { session: RolePlaySession; score: SessionScore; mode: string },
  nowIso = new Date().toISOString(),
): StoredRolePlay {
  const transcriptJson = JSON.stringify(input.session);
  if (transcriptJson.length > MAX_TRANSCRIPT_BYTES) throw new Error("transcript too large");
  const scoreJson = JSON.stringify(input.score);
  const mode = input.mode === "voice" ? "voice" : "text";

  rawDb.prepare(
    `INSERT INTO academy_roleplay_sessions
       (tenant_id, user_id, session_id, persona_id, market, mode, outcome, overall,
        transcript_json, score_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, user_id, session_id) DO NOTHING`,
  ).run(
    tid(tenantId), userId, input.session.id, input.session.personaId, input.session.market ?? "",
    mode, input.session.outcome, input.score.overall, transcriptJson, scoreJson, nowIso,
  );

  return getRolePlaySession(userId, tenantId, input.session.id)!;
}

export function getRolePlaySession(userId: number, tenantId: number | null, sessionId: string): StoredRolePlay | null {
  const row = rawDb.prepare(
    `SELECT session_id AS sessionId, persona_id AS personaId, market, mode, outcome, overall,
            transcript_json AS transcriptJson, score_json AS scoreJson, created_at AS createdAt
       FROM academy_roleplay_sessions
      WHERE tenant_id = ? AND user_id = ? AND session_id = ?`,
  ).get(tid(tenantId), userId, sessionId) as any;
  if (!row) return null;
  try {
    return {
      sessionId: row.sessionId, personaId: row.personaId, market: row.market, mode: row.mode,
      outcome: row.outcome, overall: row.overall, createdAt: row.createdAt,
      transcript: JSON.parse(row.transcriptJson),
      score: JSON.parse(row.scoreJson),
    };
  } catch {
    return null;
  }
}

/** A rep's own history, newest first. Transcripts are omitted: the list view
 *  does not need them and a phone should not download fifty of them. */
export function listRolePlayHistory(userId: number, tenantId: number | null, limit = HISTORY_LIMIT): RolePlaySummary[] {
  const rows = rawDb.prepare(
    `SELECT session_id AS sessionId, persona_id AS personaId, market, mode, outcome, overall,
            score_json AS scoreJson, created_at AS createdAt
       FROM academy_roleplay_sessions
      WHERE tenant_id = ? AND user_id = ?
      ORDER BY created_at DESC LIMIT ?`,
  ).all(tid(tenantId), userId, Math.max(1, Math.min(HISTORY_LIMIT, limit))) as any[];
  const out: RolePlaySummary[] = [];
  for (const row of rows) {
    try {
      out.push({
        sessionId: row.sessionId, personaId: row.personaId, market: row.market, mode: row.mode,
        outcome: row.outcome, overall: row.overall, createdAt: row.createdAt,
        score: JSON.parse(row.scoreJson),
      });
    } catch { /* skip corrupt */ }
  }
  return out;
}

/** Role-play scores for a rep, newest first, for certification averages. */
export function rolePlayScores(userId: number, tenantId: number | null, limit = HISTORY_LIMIT): number[] {
  return (rawDb.prepare(
    `SELECT overall FROM academy_roleplay_sessions
      WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).all(tid(tenantId), userId, limit) as { overall: number }[]).map((r) => r.overall);
}

// ── Assignments ───────────────────────────────────────────────────────────────

export function listAssignmentsFor(userId: number, tenantId: number | null): Assignment[] {
  return rawDb.prepare(
    `SELECT id, user_id AS userId, target_id AS targetId, target_kind AS targetKind,
            note, assigned_by AS assignedBy, assigned_at AS assignedAt,
            due_on AS dueOn, completed_at AS completedAt
       FROM academy_assignments
      WHERE tenant_id = ? AND user_id = ?
      ORDER BY assigned_at DESC`,
  ).all(tid(tenantId), userId) as Assignment[];
}

export function createAssignment(
  tenantId: number | null,
  input: { userId: number; targetId: string; targetKind: "activity" | "stage"; note: string; assignedBy: number; dueOn: string | null },
  nowIso = new Date().toISOString(),
): Assignment {
  const info = rawDb.prepare(
    `INSERT INTO academy_assignments
       (tenant_id, user_id, target_id, target_kind, note, assigned_by, assigned_at, due_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tid(tenantId), input.userId, input.targetId, input.targetKind,
    input.note.slice(0, 500), input.assignedBy, nowIso, input.dueOn,
  );
  return rawDb.prepare(
    `SELECT id, user_id AS userId, target_id AS targetId, target_kind AS targetKind,
            note, assigned_by AS assignedBy, assigned_at AS assignedAt,
            due_on AS dueOn, completed_at AS completedAt
       FROM academy_assignments WHERE id = ?`,
  ).get(Number(info.lastInsertRowid)) as Assignment;
}

/** Mark an assignment done. Scoped by tenant AND assignee so a stray id from
 *  another org can never be closed through this path. */
export function completeAssignment(
  tenantId: number | null,
  userId: number,
  assignmentId: number,
  nowIso = new Date().toISOString(),
): boolean {
  const info = rawDb.prepare(
    `UPDATE academy_assignments SET completed_at = ?
      WHERE id = ? AND tenant_id = ? AND user_id = ? AND completed_at IS NULL`,
  ).run(nowIso, assignmentId, tid(tenantId), userId);
  return info.changes > 0;
}

export function deleteAssignment(tenantId: number | null, assignmentId: number): boolean {
  const info = rawDb.prepare(
    `DELETE FROM academy_assignments WHERE id = ? AND tenant_id = ?`,
  ).run(assignmentId, tid(tenantId));
  return info.changes > 0;
}

// ── Offer catalog ─────────────────────────────────────────────────────────────

/** The tenant's catalog, or the seed when they have never configured one. */
export function getOfferCatalog(tenantId: number | null): OfferCatalog {
  const row = rawDb.prepare(
    `SELECT catalog_json AS catalogJson, version FROM academy_offer_catalog WHERE tenant_id = ?`,
  ).get(tid(tenantId)) as { catalogJson: string; version: number } | undefined;
  if (!row) return DEFAULT_OFFER_CATALOG;
  try {
    const parsed = JSON.parse(row.catalogJson) as OfferCatalog;
    return {
      version: row.version,
      offers: Array.isArray(parsed.offers) ? parsed.offers : [],
      competitors: Array.isArray(parsed.competitors) ? parsed.competitors : [],
    };
  } catch {
    // A corrupt catalog must not quietly become "no offers", which would let a
    // rep believe their market has nothing to sell. Fall back to the seed and
    // let the console show the supervisor that it needs saving again.
    return DEFAULT_OFFER_CATALOG;
  }
}

export type CatalogWrite = { offers: AcademyOffer[]; competitors: CompetitorOffer[] };

/** Replace the tenant's catalog. Every offer is validated first; one bad offer
 *  rejects the whole write rather than saving a half-valid catalog. */
export function saveOfferCatalog(
  tenantId: number | null,
  input: CatalogWrite,
  updatedBy: number,
  nowIso = new Date().toISOString(),
): { catalog: OfferCatalog; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const offer of input.offers) {
    const problems = validateOffer(offer);
    if (problems.length) errors.push(`${offer.id ?? "(no id)"}: ${problems.join(" ")}`);
    if (offer.id) {
      if (seen.has(offer.id)) errors.push(`${offer.id}: duplicate id.`);
      seen.add(offer.id);
    }
  }
  if (errors.length) return { catalog: getOfferCatalog(tenantId), errors };

  const current = rawDb.prepare(
    `SELECT version FROM academy_offer_catalog WHERE tenant_id = ?`,
  ).get(tid(tenantId)) as { version: number } | undefined;
  const version = (current?.version ?? 0) + 1;
  const catalog: OfferCatalog = { version, offers: input.offers, competitors: input.competitors ?? [] };

  rawDb.prepare(
    `INSERT INTO academy_offer_catalog (tenant_id, catalog_json, version, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       catalog_json = excluded.catalog_json, version = excluded.version,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(tid(tenantId), JSON.stringify(catalog), version, updatedBy, nowIso);

  return { catalog, errors: [] };
}

// ── Team rollup ───────────────────────────────────────────────────────────────

export type TeamMemberProgress = {
  userId: number;
  name: string;
  role: string;
  activitiesDone: number;
  rolePlayCount: number;
  rolePlayAverage: number | null;
  lastActivityAt: string | null;
};

/** Per-rep rollup for the supervisor dashboard. Counts and averages only: the
 *  transcripts and per-dimension coaching stay behind the per-rep endpoint,
 *  which checks the caller's authority over that specific rep. */
export function teamProgress(tenantId: number | null, userIds: number[]): TeamMemberProgress[] {
  if (!userIds.length) return [];
  const placeholders = userIds.map(() => "?").join(",");
  return rawDb.prepare(
    `SELECT u.id AS userId, u.name AS name, u.role AS role,
            (SELECT COUNT(*) FROM academy_activity_progress p
              WHERE p.tenant_id = ? AND p.user_id = u.id) AS activitiesDone,
            (SELECT COUNT(*) FROM academy_roleplay_sessions r
              WHERE r.tenant_id = ? AND r.user_id = u.id) AS rolePlayCount,
            (SELECT CAST(ROUND(AVG(r.overall)) AS INTEGER) FROM academy_roleplay_sessions r
              WHERE r.tenant_id = ? AND r.user_id = u.id) AS rolePlayAverage,
            (SELECT MAX(p.completed_at) FROM academy_activity_progress p
              WHERE p.tenant_id = ? AND p.user_id = u.id) AS lastActivityAt
       FROM users u
      WHERE u.id IN (${placeholders})
      ORDER BY u.name COLLATE NOCASE ASC`,
  ).all(tid(tenantId), tid(tenantId), tid(tenantId), tid(tenantId), ...userIds) as TeamMemberProgress[];
}

/** Every stored score for a set of reps, for the team gap computation. */
export function teamScores(tenantId: number | null, userIds: number[]): { userId: number; sessions: SessionScore[] }[] {
  if (!userIds.length) return [];
  const placeholders = userIds.map(() => "?").join(",");
  const rows = rawDb.prepare(
    `SELECT user_id AS userId, score_json AS scoreJson
       FROM academy_roleplay_sessions
      WHERE tenant_id = ? AND user_id IN (${placeholders})
      ORDER BY created_at DESC`,
  ).all(tid(tenantId), ...userIds) as { userId: number; scoreJson: string }[];

  const byUser = new Map<number, SessionScore[]>();
  for (const row of rows) {
    try {
      const list = byUser.get(row.userId) ?? [];
      list.push(JSON.parse(row.scoreJson));
      byUser.set(row.userId, list);
    } catch { /* skip corrupt */ }
  }
  return [...byUser.entries()].map(([userId, sessions]) => ({ userId, sessions }));
}
