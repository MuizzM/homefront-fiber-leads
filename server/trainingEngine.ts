// ── CE-1 drill engine: card state, review capture, due computation, coach ────
// The server side of the field coaching engine. The card corpus is DERIVED —
// shared/trainingCards.ts flattens the authored curriculum into DrillCards, and
// shared/trainingSchedule.ts owns the 5-rung ladder math (pure, so the offline
// client and this server compute identical results). This module owns the
// state: one ladder row per (tenant, user, card) plus an append-only review
// log that powers the streak.
//
// Endpoints (all under /api/training, so the training gate's allowlist covers
// them — shared/trainingGate.ts TRAINING_GATE_ALLOWED_PREFIXES — and plain
// requireAuth is the whole auth story, same as the existing training routes):
//
//   GET  /api/training/deck          → the caller's due cards (due_at <= now)
//                                      + new cards seeded from completed
//                                      lessons (training_progress is the seed
//                                      signal — no schema change), capped
//                                      (30 due + 10 new) with totals.
//   POST /api/training/reviews       → idempotent batch [{cardId, grade,
//                                      reviewedAt, rungBefore?}]; the ladder
//                                      is computed SERVER-SIDE from the stored
//                                      rung (client rungBefore is informational
//                                      only and never trusted) with the CLIENT
//                                      reviewedAt as the ladder base, so a
//                                      review taken at 2 PM offline is not
//                                      pushed a day by a 6 PM sync.
//   GET  /api/training/coach-summary → { dueCount, newCount, streakDays,
//                                      ladderCoverage, totalCards,
//                                      cardsReviewedTotal }.
//
// Every query is own-scope and tenant-scoped: user id and tenant id come from
// the session, never the request; tenant is normalized to 0 for legacy users
// (the training_progress convention, so the UNIQUE conflict target is real).

import type { Express, Request, Response } from "express";
import { rawDb } from "./db";
import { buildDrillDeck, getDrillCard, isDrillCardId, type DrillCard } from "@shared/trainingCards";
import { GRADES, nextDueAt, nextRung, type Grade } from "@shared/trainingSchedule";

/** Rung new cards seed at when their source lesson is complete: the lesson
 *  read IS the first exposure, so the first review starts from rung 1. */
export const SEED_RUNG = 1;

/** Deck endpoint caps — a rep should never face more than this in one pull. */
export const DUE_CAP = 30;
export const NEW_CAP = 10;

/** Hard ceiling on one batch; the outbox syncs in small bursts. */
const MAX_BATCH = 500;

export type TrainingEngineAuth = {
  requireAuth: (req: Request, res: Response, next: () => void) => void;
};

export type CardStateRow = {
  cardId: string;
  rung: number;
  dueAt: string | null;
  lastGrade: string | null;
  reps: number;
  lapses: number;
  updatedAt: string;
};

export type AppliedReview = {
  cardId: string;
  grade: Grade;
  reviewedAt: string;
  rungBefore: number;
  rungAfter: number;
  dueAt: string;
  /** True when the exact (card, reviewedAt) was already logged — a replayed
   *  delivery. The state row is left untouched, so replays never double-step
   *  the ladder. */
  duplicate: boolean;
};

// tenant_id is normalized to 0 for legacy users with no tenant, so the
// UNIQUE(tenant_id, user_id, card_id) upsert always has a concrete conflict
// target (SQLite treats NULLs as distinct) — the training_progress rule.
function tid(tenantId: number | null | undefined): number {
  return tenantId ?? 0;
}

function getCardState(userId: number, tenantId: number | null | undefined, cardId: string): CardStateRow | null {
  const row = rawDb.prepare(
    `SELECT card_id AS cardId, rung, due_at AS dueAt, last_grade AS lastGrade,
            reps, lapses, updated_at AS updatedAt
       FROM training_card_state WHERE tenant_id = ? AND user_id = ? AND card_id = ?`,
  ).get(tid(tenantId), userId, cardId) as CardStateRow | undefined;
  return row ?? null;
}

function listDueStates(userId: number, tenantId: number | null | undefined, nowIso: string): CardStateRow[] {
  return rawDb.prepare(
    `SELECT card_id AS cardId, rung, due_at AS dueAt, last_grade AS lastGrade,
            reps, lapses, updated_at AS updatedAt
       FROM training_card_state
      WHERE tenant_id = ? AND user_id = ? AND due_at IS NOT NULL AND due_at <= ?
      ORDER BY due_at ASC, card_id ASC`,
  ).all(tid(tenantId), userId, nowIso) as CardStateRow[];
}

/** Lesson ids the rep has completed — the seed signal for new cards. */
function completedLessonIds(userId: number, tenantId: number | null | undefined): Set<string> {
  const rows = rawDb.prepare(
    `SELECT lesson_id AS lessonId FROM training_progress WHERE tenant_id = ? AND user_id = ?`,
  ).all(tid(tenantId), userId) as Array<{ lessonId: string }>;
  return new Set(rows.map((r) => r.lessonId));
}

/** New cards: the source lesson is complete (first exposure already happened
 *  — seed at SEED_RUNG) and no state row exists yet. Deck order. */
function listNewCards(userId: number, tenantId: number | null | undefined): DrillCard[] {
  const done = completedLessonIds(userId, tenantId);
  if (done.size === 0) return [];
  const stated = new Set(
    (rawDb.prepare(
      `SELECT card_id AS cardId FROM training_card_state WHERE tenant_id = ? AND user_id = ?`,
    ).all(tid(tenantId), userId) as Array<{ cardId: string }>).map((r) => r.cardId),
  );
  return buildDrillDeck().filter((c) => done.has(c.lessonId) && !stated.has(c.id));
}

/** The rung a review starts from, computed server-side: the stored rung when
 *  a state row exists; otherwise the seed rung for a card whose lesson is
 *  complete, or 0 (learn now) for a cold card. The client's rungBefore is
 *  never trusted. */
function rungBeforeFor(userId: number, tenantId: number | null | undefined, card: DrillCard, done: Set<string>): number {
  const state = getCardState(userId, tenantId, card.id);
  if (state) return state.rung;
  return done.has(card.lessonId) ? SEED_RUNG : 0;
}

type ReviewInput = { cardId: string; grade: Grade; reviewedAt: Date };

/** Apply one validated batch in a single transaction. Each review is logged
 *  first through the dedupe index (tenant, user, card, reviewed_at); a replay
 *  inserts nothing and the state row is NOT stepped again — that is what makes
 *  duplicate delivery harmless. */
function applyReviews(userId: number, tenantId: number | null | undefined, reviews: ReviewInput[]): AppliedReview[] {
  const t = tid(tenantId);
  const done = completedLessonIds(userId, t);
  const insertLog = rawDb.prepare(
    `INSERT OR IGNORE INTO training_review_log
       (tenant_id, user_id, card_id, grade, rung_before, rung_after, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertState = rawDb.prepare(
    `INSERT INTO training_card_state
       (tenant_id, user_id, card_id, rung, due_at, last_grade, reps, lapses, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))
     ON CONFLICT(tenant_id, user_id, card_id) DO UPDATE SET
       rung = excluded.rung,
       due_at = excluded.due_at,
       last_grade = excluded.last_grade,
       reps = training_card_state.reps + 1,
       lapses = training_card_state.lapses + excluded.lapses,
       updated_at = excluded.updated_at`,
  );

  return rawDb.transaction(() => {
    const results: AppliedReview[] = [];
    for (const review of reviews) {
      const card = getDrillCard(review.cardId)!; // validated at the route
      const reviewedAtIso = review.reviewedAt.toISOString();
      const rungBefore = rungBeforeFor(userId, t, card, done);
      const rungAfter = nextRung(rungBefore, review.grade);
      const dueAt = nextDueAt(rungBefore, review.grade, review.reviewedAt).toISOString();
      const lapse = review.grade === "again" ? 1 : 0;
      const logged = insertLog.run(t, userId, card.id, review.grade, rungBefore, rungAfter, reviewedAtIso).changes > 0;
      if (logged) {
        upsertState.run(t, userId, card.id, rungAfter, dueAt, review.grade, lapse);
      }
      results.push({
        cardId: card.id, grade: review.grade, reviewedAt: reviewedAtIso,
        rungBefore, rungAfter, dueAt, duplicate: !logged,
      });
    }
    return results;
  })();
}

/** Consecutive days with >= 1 review, ending today or yesterday (a streak is
 *  alive until a full day is missed). Days are the client-stamped day — the
 *  first 10 chars of reviewed_at — so an offline review counts on the day the
 *  rep actually did it, not the day it synced. */
function streakDays(userId: number, tenantId: number | null | undefined, now: Date): number {
  const rows = rawDb.prepare(
    `SELECT DISTINCT substr(reviewed_at, 1, 10) AS day
       FROM training_review_log WHERE tenant_id = ? AND user_id = ?
      ORDER BY day DESC`,
  ).all(tid(tenantId), userId) as Array<{ day: string }>;
  if (rows.length === 0) return 0;
  const dayMs = 86_400_000;
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - dayMs).toISOString().slice(0, 10);
  const first = rows[0].day;
  if (first !== today && first !== yesterday) return 0;
  let streak = 1;
  let cursor = Date.parse(`${first}T00:00:00.000Z`);
  for (let i = 1; i < rows.length; i++) {
    cursor -= dayMs;
    if (rows[i].day !== new Date(cursor).toISOString().slice(0, 10)) break;
    streak++;
  }
  return streak;
}

function ladderCoverage(userId: number, tenantId: number | null | undefined): Record<string, number> {
  const rows = rawDb.prepare(
    `SELECT rung, COUNT(*) AS n FROM training_card_state
      WHERE tenant_id = ? AND user_id = ? GROUP BY rung`,
  ).all(tid(tenantId), userId) as Array<{ rung: number; n: number }>;
  const coverage: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0 };
  for (const row of rows) coverage[String(row.rung)] = row.n;
  return coverage;
}

export function registerTrainingEngineRoutes(app: Express, auth: TrainingEngineAuth): void {
  const { requireAuth } = auth;

  // The caller's deck: due cards (oldest first) + new cards seeded from
  // completed lessons, each capped, with the uncapped totals alongside.
  app.get("/api/training/deck", requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const nowIso = new Date().toISOString();
    const dueStates = listDueStates(user.id, user.tenantId, nowIso);
    const newCards = listNewCards(user.id, user.tenantId);
    res.json({
      now: nowIso,
      due: dueStates.slice(0, DUE_CAP).map((state) => ({
        card: getDrillCard(state.cardId) ?? null,
        rung: state.rung,
        dueAt: state.dueAt,
        lastGrade: state.lastGrade,
        reps: state.reps,
        lapses: state.lapses,
      })),
      new: newCards.slice(0, NEW_CAP).map((card) => ({ card, rung: SEED_RUNG })),
      counts: {
        due: dueStates.length,
        new: newCards.length,
        dueReturned: Math.min(dueStates.length, DUE_CAP),
        newReturned: Math.min(newCards.length, NEW_CAP),
      },
    });
  });

  // Idempotent review batch. Validate EVERYTHING before writing anything —
  // one bad review fails the batch with a named error and no partial state.
  app.post("/api/training/reviews", requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const body = req.body ?? {};
    const rawReviews = body.reviews;
    if (!Array.isArray(rawReviews) || rawReviews.length === 0 || rawReviews.length > MAX_BATCH) {
      return res.status(400).json({
        error: `reviews must be an array of 1..${MAX_BATCH} entries`,
        code: "INVALID_REVIEWS",
      });
    }

    const validated: ReviewInput[] = [];
    for (let i = 0; i < rawReviews.length; i++) {
      const r = rawReviews[i] ?? {};
      if (!isDrillCardId(r.cardId)) {
        return res.status(400).json({ error: "Invalid card id", code: "INVALID_CARD_ID", index: i });
      }
      if (!getDrillCard(r.cardId)) {
        return res.status(400).json({ error: "Unknown card id", code: "UNKNOWN_CARD_ID", index: i, cardId: r.cardId });
      }
      if (typeof r.grade !== "string" || !(GRADES as readonly string[]).includes(r.grade)) {
        return res.status(400).json({
          error: `grade must be one of ${GRADES.join("|")}`,
          code: "INVALID_GRADE", index: i,
        });
      }
      const reviewedAt = new Date(r.reviewedAt);
      if (typeof r.reviewedAt !== "string" || !Number.isFinite(reviewedAt.getTime())) {
        return res.status(400).json({
          error: "reviewedAt must be an ISO timestamp",
          code: "INVALID_REVIEWED_AT", index: i,
        });
      }
      // rungBefore (if sent) is deliberately dropped — the ladder is computed
      // from the stored rung, never from the client's claim.
      validated.push({ cardId: r.cardId, grade: r.grade as Grade, reviewedAt });
    }

    const results = applyReviews(user.id, user.tenantId, validated);
    res.json({
      applied: results.filter((r) => !r.duplicate).length,
      duplicates: results.filter((r) => r.duplicate).length,
      results,
    });
  });

  // Coach home numbers: what's waiting, the streak, and how the ladder fills.
  app.get("/api/training/coach-summary", requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user;
    const now = new Date();
    const nowIso = now.toISOString();
    const dueRow = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM training_card_state
        WHERE tenant_id = ? AND user_id = ? AND due_at IS NOT NULL AND due_at <= ?`,
    ).get(tid(user.tenantId), user.id, nowIso) as { n: number };
    const reviewedRow = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM training_card_state WHERE tenant_id = ? AND user_id = ?`,
    ).get(tid(user.tenantId), user.id) as { n: number };
    res.json({
      dueCount: dueRow.n,
      newCount: listNewCards(user.id, user.tenantId).length,
      streakDays: streakDays(user.id, user.tenantId, now),
      ladderCoverage: ladderCoverage(user.id, user.tenantId),
      totalCards: buildDrillDeck().length,
      cardsReviewedTotal: reviewedRow.n,
    });
  });
}
