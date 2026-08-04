// ── Drill-Card Review Ladder ──────────────────────────────────────────────────
// The spaced-repetition schedule for drill cards (lane CE-3 contract). Pure
// functions over a 5-rung ladder; the coaching engine stores one rung + due
// timestamp per (rep, card) and calls these after each review.
//
// The ladder: rung indexes into LADDER_DAYS. A card at rung r is due again
// LADDER_DAYS[r] days after review — except rung 0, which means "see it again
// in 10 minutes" (same-session retry), not "due now".

/** Days between reviews per rung. Rung 0 is the same-session retry rung. */
export const LADDER_DAYS = [0, 1, 3, 7, 16] as const;

/** The four self-grades a rep can give after seeing a card's back. */
export type Grade = "again" | "hard" | "good" | "easy";

export const GRADES: readonly Grade[] = ["again", "hard", "good", "easy"];

/** Highest valid rung index. */
export const MAX_RUNG = LADDER_DAYS.length - 1;

/** Same-session retry delay for rung 0, in milliseconds (10 minutes). */
export const AGAIN_DELAY_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

function clampRung(rung: number): number {
  if (!Number.isFinite(rung)) return 0;
  return Math.min(Math.max(Math.trunc(rung), 0), MAX_RUNG);
}

/** The rung a card moves to after a review graded `grade`.
 *    again → 0 (back to the retry rung)
 *    hard  → same rung
 *    good  → +1 rung
 *    easy  → +2 rungs
 *  Clamped to [0, MAX_RUNG]; out-of-range input rungs are clamped first. */
export function nextRung(rung: number, grade: Grade): number {
  const current = clampRung(rung);
  switch (grade) {
    case "again":
      return 0;
    case "hard":
      return current;
    case "good":
      return Math.min(current + 1, MAX_RUNG);
    case "easy":
      return Math.min(current + 2, MAX_RUNG);
  }
}

/** When the card is next due after a review at time `from`.
 *  The schedule is computed from the NEW rung (post-grade): rung 0 means
 *  +10 minutes (same-session retry); any other rung r means +LADDER_DAYS[r]
 *  whole days. Accepts a Date or epoch ms; always returns a Date. */
export function nextDueAt(rung: number, grade: Grade, from: Date | number): Date {
  const next = nextRung(rung, grade);
  const base = typeof from === "number" ? from : from.getTime();
  const delta = next === 0 ? AGAIN_DELAY_MS : LADDER_DAYS[next] * DAY_MS;
  return new Date(base + delta);
}
