// ── The ramp bonus — paying a new hire to learn, for two weeks ───────────────
// A new rep's first fortnight is the only stretch where the highest-value thing
// they can do is NOT knock. They do not know the pitch, so every door they burn
// is a door burned. The floor knows this and the incentive plan usually does
// not: commission pays for sales a new hire cannot yet make, so week one pays
// nothing and the new hire quits in week two.
//
// So: for the first 14 days, $50 a day for doing the day's training and
// coaching work. Not $50 for existing — $50 for finishing the cards that are
// due, which is the same work the coaching engine (server/trainingEngine.ts)
// already tracks card by card.
//
// It expires. That is deliberate and it is the point: the ramp bonus is a
// bridge to the first commission cheque, not a salary. On day 15 the rep moves
// onto the sales-achievement ladder (shared/salesAchievements.ts) like everyone
// else, and by then they can actually clear it.
//
// ── WHAT "COMPLETING THE DAILY CARDS" HAS TO MEAN ───────────────────────────
//
// The naive rule — "reviewed a card today" — pays $50 for one tap. The rule
// here is three things at once, and all three are needed:
//
//   nothing left due    The rep cleared the queue the scheduler set for them,
//                       so the bar rises as their deck grows instead of being a
//                       fixed toll they can pay early and walk away from.
//   distinct cards      Ten reviews of ONE card is one card. The counter is
//                       distinct cards, so re-grading the same flashcard ten
//                       times earns exactly what it is worth.
//   a real stretch      Ten cards graded inside forty seconds is a rep tapping
//                       "easy" down a list, not a rep drilling. The day's
//                       reviews must span a few real minutes.
//
// Day one is the deliberate exception. A brand-new rep has no cards yet — the
// deck seeds off COMPLETED lessons — so a day where they finished lessons and
// have nothing due qualifies on the lesson count alone. Otherwise the bonus
// would be unreachable on exactly the day it matters most.
//
// PURE: no clock, no database. The caller supplies the day's counters.

export interface RampBonusConfig {
  enabled: boolean;
  /** Days of tenure the bonus covers, counted from the hire date inclusive:
   *  day 1 is the rep's first day. */
  windowDays: number;
  /** Flat award for a qualifying day, integer cents. */
  rewardCents: number;
  /** Distinct drill cards that make a day's coaching work. */
  minCardsPerDay: number;
  /** Lessons that make a day's work when the deck is still empty. */
  minLessonsPerDay: number;
  /** The day's training activity must span at least this long. */
  minSpanMinutes: number;
  /** The rep must have cleared everything the scheduler had due for them. */
  requireQueueCleared: boolean;

  // ── Finishing the whole curriculum ─────────────────────────────────────────
  /** One-time award for completing EVERY lesson in the curriculum, integer
   *  cents. Paid once per rep, ever. */
  completionRewardCents: number;
  /** Whether finishing pays at all. */
  completionEnabled: boolean;
  /** Finishing inside the ramp window pays a bonus on top of the completion
   *  award — the difference between "I got through it eventually" and "I got
   *  through it before I was expected to". 0 disables the kicker. */
  completionInWindowBonusCents: number;
}

// $50 × 14 days = $700 a head, worst case, for a rep who does the work every
// single day of their first fortnight — which is the outcome being bought.
export const DEFAULT_RAMP_BONUS_CONFIG: RampBonusConfig = {
  enabled: true,
  windowDays: 14,
  rewardCents: 5_000,      // $50
  minCardsPerDay: 10,
  minLessonsPerDay: 1,
  minSpanMinutes: 5,
  requireQueueCleared: true,
  completionRewardCents: 5_000,        // $50 for finishing the curriculum
  completionEnabled: true,
  completionInWindowBonusCents: 5_000, // …and $50 again for finishing inside the ramp
};

/** One rep's training day, as the decision sees it. */
export interface RampDayInput {
  /** 1-based day of tenure in the org's local calendar. Day 1 is the hire date;
   *  0 or negative means the hire date is unknown or in the future. */
  tenureDay: number;
  /** DISTINCT drill cards reviewed today. Not review events — cards. */
  distinctCardsToday: number;
  /** Training lessons completed today. */
  lessonsCompletedToday: number;
  /** Cards still due at the end of the day's work. */
  dueRemaining: number;
  /** Minutes between the day's first and last training action. */
  spanMinutes: number;
}

export type RampBlock =
  | "disabled"
  | "not_a_new_hire"   // outside the two-week window (or before day 1)
  | "no_work"          // nothing done today
  | "too_few_cards"    // some work, not a day's work
  | "queue_open"       // cards still due
  | "too_fast";        // a day's cards tapped through in seconds

export interface RampDecision {
  qualifies: boolean;
  awardCents: number;
  blockedBy: RampBlock | null;
  /** True while the rep is inside the window — drives whether the card renders
   *  at all. A veteran should never see a bonus they cannot earn. */
  inWindow: boolean;
  /** Days of the window left, including today. 0 once it has expired. */
  daysLeft: number;
  reason: string;
  headline: string;
}

function int(n: unknown, fallback = 0): number {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) ? v : fallback;
}

/** Integer cents → "$50" / "$47.50". */
export function usd(c: number): string {
  const v = Math.trunc(Number.isFinite(c) ? c : 0);
  const whole = Math.floor(Math.abs(v) / 100).toLocaleString("en-US");
  const rem = Math.abs(v) % 100;
  const body = rem === 0 ? `$${whole}` : `$${whole}.${String(rem).padStart(2, "0")}`;
  return v < 0 ? `-${body}` : body;
}

/** Is this rep still inside the ramp window? The one question the achievement
 *  ladder also asks, so it lives here rather than being re-derived there. */
export function isRampRep(tenureDay: number, config: RampBonusConfig = DEFAULT_RAMP_BONUS_CONFIG): boolean {
  const cfg = { ...DEFAULT_RAMP_BONUS_CONFIG, ...config };
  const day = int(tenureDay, 0);
  return cfg.enabled !== false && day >= 1 && day <= Math.max(0, int(cfg.windowDays, 0));
}

/**
 * Decide one new hire's training day.
 *
 * PURE + DETERMINISTIC. Same counters → same verdict, which is what lets the
 * award be recomputed on every review batch and inserted exactly once.
 */
export function evaluateRampDay(
  input: RampDayInput,
  config: RampBonusConfig = DEFAULT_RAMP_BONUS_CONFIG,
): RampDecision {
  const cfg = { ...DEFAULT_RAMP_BONUS_CONFIG, ...config };
  const day = int(input?.tenureDay, 0);
  const windowDays = Math.max(0, int(cfg.windowDays, 0));
  const reward = Math.max(0, int(cfg.rewardCents, 0));
  const inWindow = isRampRep(day, cfg);
  const daysLeft = inWindow ? windowDays - day + 1 : 0;
  const reason = `Training day ${Math.max(1, day)} of ${windowDays}`;

  const no = (blockedBy: RampBlock, headline: string): RampDecision => ({
    qualifies: false, awardCents: 0, blockedBy, inWindow, daysLeft, reason, headline,
  });

  if (cfg.enabled === false || reward <= 0) return no("disabled", "");
  if (!inWindow) return no("not_a_new_hire", "");

  const cards = Math.max(0, int(input?.distinctCardsToday, 0));
  const lessons = Math.max(0, int(input?.lessonsCompletedToday, 0));
  const due = Math.max(0, int(input?.dueRemaining, 0));
  const span = Math.max(0, int(input?.spanMinutes, 0));
  const minCards = Math.max(0, int(cfg.minCardsPerDay, 0));
  const minLessons = Math.max(1, int(cfg.minLessonsPerDay, 1));

  if (cards === 0 && lessons === 0) {
    return no("no_work", `Do today's cards for ${usd(reward)} - ${daysLeft} day${daysLeft === 1 ? "" : "s"} of the ramp bonus left`);
  }

  // The lesson path is what makes day one reachable: a rep whose deck is still
  // empty cannot clear cards that do not exist yet.
  const didADaysWork = cards >= minCards || lessons >= minLessons;
  if (!didADaysWork) {
    const short = Math.max(0, minCards - cards);
    return no("too_few_cards", `${short} more card${short === 1 ? "" : "s"} today for ${usd(reward)}`);
  }

  if (cfg.requireQueueCleared && due > 0) {
    return no("queue_open", `${due} card${due === 1 ? "" : "s"} still due - clear them for ${usd(reward)}`);
  }

  // Only meaningful once real cards were drilled; a lesson-only day has no
  // review timestamps to span and must not be failed for it.
  if (cards >= minCards && span < Math.max(0, int(cfg.minSpanMinutes, 0))) {
    return no("too_fast", "Those went by too fast to count as a drill. Work them properly and it pays.");
  }

  return {
    qualifies: true,
    awardCents: reward,
    blockedBy: null,
    inWindow,
    daysLeft,
    reason,
    headline: `Training done - ${usd(reward)} earned today`,
  };
}

// ── Finishing the curriculum ────────────────────────────────────────────────
// The daily bonus pays for showing up to the training. This pays for FINISHING
// it, which is a different behaviour and needs its own money: a rep who does
// nine cards a day forever collects the daily bonus every day and never reaches
// the end of the material. One award, once per rep, for completing every
// lesson — plus a kicker for getting there inside the ramp window, because the
// point of the fortnight is to come out the other side of it trained.

export interface TrainingCompletionInput {
  /** Lessons the rep has completed. */
  lessonsCompleted: number;
  /** Lessons in the curriculum. A curriculum of 0 lessons can never be
   *  "finished" — that reads as content not loaded, not as an instant payout. */
  lessonsTotal: number;
  /** 1-based day of tenure on the day they finished. */
  tenureDay: number;
}

export interface CompletionDecision {
  qualifies: boolean;
  awardCents: number;
  /** Split out so the ledger line can say WHY it was $100 and not $50. */
  baseCents: number;
  kickerCents: number;
  /** True when they finished inside the ramp window. */
  inWindow: boolean;
  lessonsRemaining: number;
  reason: string;
  headline: string;
}

/**
 * Decide the one-time completion award.
 *
 * PURE. The caller books it against a per-rep key, so this can be re-evaluated
 * on every lesson completion and pays exactly once.
 */
export function evaluateTrainingCompletion(
  input: TrainingCompletionInput,
  config: RampBonusConfig = DEFAULT_RAMP_BONUS_CONFIG,
): CompletionDecision {
  const cfg = { ...DEFAULT_RAMP_BONUS_CONFIG, ...config };
  const total = Math.max(0, int(input?.lessonsTotal, 0));
  const done = Math.max(0, int(input?.lessonsCompleted, 0));
  const remaining = Math.max(0, total - done);
  const inWindow = isRampRep(int(input?.tenureDay, 0), cfg);
  const base = Math.max(0, int(cfg.completionRewardCents, 0));
  const kicker = inWindow ? Math.max(0, int(cfg.completionInWindowBonusCents, 0)) : 0;

  const no = (headline: string): CompletionDecision => ({
    qualifies: false, awardCents: 0, baseCents: base, kickerCents: kicker,
    inWindow, lessonsRemaining: remaining, reason: "Training complete", headline,
  });

  if (cfg.completionEnabled === false || base + kicker <= 0) return no("");
  // A curriculum with no lessons is content that has not loaded, not a course
  // somebody finished. Paying on it would hand every rep the award at once.
  if (total <= 0) return no("");
  if (done < total) {
    return no(`${remaining} lesson${remaining === 1 ? "" : "s"} left to finish training - ${usd(base + (inWindow ? kicker : 0))}`);
  }

  return {
    qualifies: true,
    awardCents: base + kicker,
    baseCents: base,
    kickerCents: kicker,
    inWindow,
    lessonsRemaining: 0,
    reason: kicker > 0 ? "Finished training inside the ramp window" : "Finished training",
    headline: `Training finished - ${usd(base + kicker)} earned`,
  };
}

/** Shared by the API and the admin form. Returns null when valid. */
export function validateRampConfig(input: unknown): string | null {
  const c = input as RampBonusConfig | null;
  if (!c || typeof c !== "object") return "The ramp bonus config is missing.";

  const days = Number(c.windowDays);
  if (!Number.isInteger(days) || days < 1 || days > 180) {
    return "The ramp window must be between 1 and 180 days.";
  }
  const reward = Number(c.rewardCents);
  if (!Number.isInteger(reward) || reward < 1) return "The bonus must be a whole number of cents above zero.";
  if (reward > 100_000) return "A daily bonus cannot pay more than $1,000.";

  const cards = Number(c.minCardsPerDay);
  if (!Number.isInteger(cards) || cards < 1 || cards > 200) {
    return "A day's cards must be between 1 and 200.";
  }
  const lessons = Number(c.minLessonsPerDay);
  if (!Number.isInteger(lessons) || lessons < 1 || lessons > 20) {
    return "A day's lessons must be between 1 and 20.";
  }
  const span = Number(c.minSpanMinutes);
  if (!Number.isInteger(span) || span < 0 || span > 480) {
    return "The minimum drill span must be between 0 minutes and 8 hours.";
  }

  for (const [label, value] of [
    ["completion award", c.completionRewardCents],
    ["in-window kicker", c.completionInWindowBonusCents],
  ] as const) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) return `The ${label} must be a whole number of cents, zero or above.`;
    if (n > 100_000) return `The ${label} cannot pay more than $1,000.`;
  }
  if (c.completionEnabled !== false
      && Number(c.completionRewardCents) === 0 && Number(c.completionInWindowBonusCents) === 0) {
    return "Set a completion award before turning the finishing bonus on.";
  }
  return null;
}

/** The org's worst-case exposure per new hire — the number a manager needs
 *  before turning this on, and the one nobody works out by hand: every day of
 *  the window paid, plus finishing the curriculum inside it. */
export function rampCeilingCentsPerHire(config: RampBonusConfig = DEFAULT_RAMP_BONUS_CONFIG): number {
  const cfg = { ...DEFAULT_RAMP_BONUS_CONFIG, ...config };
  const daily = Math.max(0, int(cfg.rewardCents, 0)) * Math.max(0, int(cfg.windowDays, 0));
  const completion = cfg.completionEnabled === false
    ? 0
    : Math.max(0, int(cfg.completionRewardCents, 0)) + Math.max(0, int(cfg.completionInWindowBonusCents, 0));
  return daily + completion;
}
