// ── Academy progress ──────────────────────────────────────────────────────────
//
// Pure progress arithmetic: what is done, what unlocks next, where to resume,
// which certifications are earned, and which areas need practice. Shared so the
// client can render optimistically and the server can validate the same rules
// without either re-deriving them differently.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
//   It does not rank reps. There is no ordering function, no percentile, and
//   no export shaped like a leaderboard. Coaching scores are private to the rep
//   and their chain of command by design (see server/academyRoutes.ts for the
//   enforcement), and a public board of who is worst at empathy would destroy
//   the honesty the role-play scoring depends on. Achievements are per-rep
//   milestones against a fixed bar, so two reps can both earn one and nobody
//   earns one by beating somebody else.
//
// RESUME IS THE FEATURE
//   A rep opens this on a phone, between houses, for four minutes. The single
//   most valuable thing the page can do is put them back exactly where they
//   stopped. `resumePoint` is that: the first unfinished activity in path
//   order, with its stage, so the UI can deep-link straight to it.

import {
  ALL_ACTIVITIES, CERTIFICATIONS, PATH_STAGES, TOTAL_ACTIVITIES,
  type Activity, type Certification, type PathStage,
} from "./academyPath";
import {
  DIMENSION_LABELS, SCORE_DIMENSIONS, weakestDimensions,
  type ScoreDimension, type SessionScore,
} from "./academyScoring";

/** One stored completion. `score` is null for activities that do not produce one. */
export type ActivityRecord = {
  activityId: string;
  completedAt: string;
  score: number | null;
};

/** Saved mid-activity state, so a rep resumes inside a quiz, not at its start. */
export type ActivityResumeState = {
  activityId: string;
  /** Opaque to this module: each activity kind defines its own shape. */
  state: unknown;
  updatedAt: string;
};

export type StageProgress = {
  stage: PathStage;
  done: number;
  total: number;
  complete: boolean;
  /** Advisory only. The UI dims a locked stage; it never blocks navigation. */
  locked: boolean;
  /** Percent 0 to 100, rounded. */
  percent: number;
};

export type PathProgress = {
  stages: StageProgress[];
  done: number;
  total: number;
  percent: number;
  /** Where to send the rep when they tap Continue. Null when everything is done. */
  resume: { activity: Activity; stage: PathStage } | null;
};

/**
 * The pass rule, in ONE place.
 *
 * An activity counts as done when it has a completion record and, where it
 * carries a passScore, when that record's score met the bar. Everything that
 * renders a tick, a ring, or a stage total reads this function, so a rep can
 * never see an activity ticked in the list and unticked in the rollup.
 */
export function isActivityPassed(activity: Activity, records: ActivityRecord[]): boolean {
  const record = records.find((r) => r.activityId === activity.id);
  if (!record) return false;
  if (activity.passScore == null) return true;
  return record.score != null && record.score >= activity.passScore;
}

/**
 * Compute the whole path against a set of completions.
 *
 * A stage is complete when every activity in it has passed. A stage is locked
 * when the previous stage is not complete, which is the progressive-disclosure
 * nudge and nothing more.
 */
export function computePathProgress(records: ActivityRecord[]): PathProgress {
  const byId = new Map(records.map((r) => [r.activityId, r]));

  const passed = (a: Activity): boolean => {
    const rec = byId.get(a.id);
    if (!rec) return false;
    if (a.passScore == null) return true;
    return rec.score != null && rec.score >= a.passScore;
  };

  let previousComplete = true;
  const stages: StageProgress[] = PATH_STAGES.map((stage) => {
    const done = stage.activities.filter(passed).length;
    const total = stage.activities.length;
    const complete = done === total;
    const locked = !previousComplete;
    previousComplete = complete;
    return { stage, done, total, complete, locked, percent: total ? Math.round((done / total) * 100) : 0 };
  });

  const done = ALL_ACTIVITIES.filter(passed).length;

  let resume: PathProgress["resume"] = null;
  for (const stage of PATH_STAGES) {
    const next = stage.activities.find((a) => !passed(a));
    if (next) { resume = { activity: next, stage }; break; }
  }

  return {
    stages,
    done,
    total: TOTAL_ACTIVITIES,
    percent: TOTAL_ACTIVITIES ? Math.round((done / TOTAL_ACTIVITIES) * 100) : 0,
    resume,
  };
}

// ── Certifications ────────────────────────────────────────────────────────────

export type CertificationStatus = {
  certification: Certification;
  earned: boolean;
  /** Requirements still outstanding, in plain words. */
  remaining: string[];
  /** ISO timestamp of the last completion that satisfied it, when earned. */
  earnedAt: string | null;
};

export function certificationStatuses(
  records: ActivityRecord[],
  rolePlayScores: number[] = [],
): CertificationStatus[] {
  const progress = computePathProgress(records);
  const stageById = new Map(progress.stages.map((s) => [s.stage.id, s]));
  const byId = new Map(records.map((r) => [r.activityId, r]));
  const avgRolePlay = rolePlayScores.length
    ? Math.round(rolePlayScores.reduce((a, b) => a + b, 0) / rolePlayScores.length)
    : null;

  return CERTIFICATIONS.map((certification) => {
    const remaining: string[] = [];
    const satisfyingTimes: string[] = [];

    for (const stageId of certification.stageIds) {
      const s = stageById.get(stageId);
      if (!s) continue;
      if (!s.complete) {
        remaining.push(`${s.stage.title}: ${s.total - s.done} of ${s.total} left`);
      } else {
        for (const a of s.stage.activities) {
          const rec = byId.get(a.id);
          if (rec) satisfyingTimes.push(rec.completedAt);
        }
      }
    }
    for (const activityId of certification.activityIds ?? []) {
      const rec = byId.get(activityId);
      if (!rec) remaining.push(`One activity still outstanding`);
      else satisfyingTimes.push(rec.completedAt);
    }
    if (certification.minRolePlayScore != null) {
      if (avgRolePlay == null) {
        remaining.push("Run at least one role-play session");
      } else if (avgRolePlay < certification.minRolePlayScore) {
        remaining.push(`Role-play average is ${avgRolePlay}, needs ${certification.minRolePlayScore}`);
      }
    }

    const earned = remaining.length === 0;
    const earnedAt = earned && satisfyingTimes.length
      ? satisfyingTimes.sort().at(-1) ?? null
      : null;
    return { certification, earned, remaining, earnedAt };
  });
}

// ── Achievements ──────────────────────────────────────────────────────────────
// Milestones against a fixed bar. Every one of these can be earned by everybody
// on the team at the same time, which is exactly the point.

export type Achievement = {
  id: string;
  title: string;
  /** What earned it, stated so it reads as a fact rather than a trophy. */
  detail: string;
};

export function achievementsFor(
  records: ActivityRecord[],
  sessions: SessionScore[],
): Achievement[] {
  const out: Achievement[] = [];
  const progress = computePathProgress(records);

  if (records.length >= 1) out.push({ id: "first-step", title: "Started", detail: "You opened the path and finished something." });
  if (progress.stages[0]?.complete) out.push({ id: "product-known", title: "Product known", detail: "You can explain what fiber is without reading anything." });
  if (progress.done >= 10) out.push({ id: "ten-done", title: "Ten activities", detail: "Ten pieces of the path finished." });
  if (progress.percent >= 50) out.push({ id: "halfway", title: "Halfway", detail: "Half the path behind you." });

  const complianceScores = sessions.flatMap((s) => s.dimensions.filter((d) => d.dimension === "compliance").map((d) => d.score));
  if (complianceScores.length >= 3 && complianceScores.every((s) => s === 100)) {
    out.push({ id: "clean-compliance", title: "Clean sheet", detail: "Three role-plays with nothing on the compliance line." });
  }
  const politeExits = sessions.filter((s) => s.dimensions.some((d) => d.dimension === "closing" && d.note.includes("left well")));
  if (politeExits.length >= 1) {
    out.push({ id: "good-exit", title: "Left well", detail: "You ended a conversation cleanly when the answer was no." });
  }
  const empathy = sessions.flatMap((s) => s.dimensions.filter((d) => d.dimension === "empathy").map((d) => d.score));
  if (empathy.length >= 3 && empathy.slice(-3).every((s) => s >= 80)) {
    out.push({ id: "heard-them", title: "Heard them", detail: "Three sessions running where every concern was acknowledged before it was answered." });
  }
  return out;
}

// ── Areas needing practice ────────────────────────────────────────────────────

export type PracticeArea = {
  dimension: ScoreDimension;
  label: string;
  average: number;
  /** What to do about it, pointing at a real activity where one exists. */
  suggestion: string;
  suggestedActivityId?: string;
};

const DIMENSION_REMEDY: Readonly<Record<ScoreDimension, { text: string; activityId?: string }>> = {
  introduction: { text: "Run the timed ten-second practice until it fits without rushing.", activityId: "act-timed-intro" },
  clarity: { text: "Rebuild your pitch in the Pitch Lab and cut it under thirty seconds.", activityId: "act-pitch-lab" },
  discovery: { text: "Pick two discovery questions and commit to asking one before any benefit.", activityId: "act-discovery-blocks" },
  listening: { text: "Stop the pitch the moment they mention something specific, and ask about that instead.", activityId: "act-three-sins" },
  empathy: { text: "Work the objection drills. Every one starts with acknowledgement.", activityId: "act-objection-too_busy" },
  benefitAlignment: { text: "Role-play the remote worker and lead with the outcome she already feels, not the specification.", activityId: "act-roleplay-remote" },
  objectionHandling: { text: "Run the objection drills back to back.", activityId: "act-objection-not_interested" },
  accuracy: { text: "Open today's offer card before every shift and quote nothing else.", activityId: "act-claims-card" },
  compliance: { text: "Re-read the never-say list and the compliance scenarios.", activityId: "act-never-say" },
  closing: { text: "Practise the two-slot ask, and the respectful exit that is also a close.", activityId: "act-closes" },
  professionalism: { text: "Role-play the satisfied customer. Pressure shows up first where there is nothing to win.", activityId: "act-roleplay-satisfied" },
};

/** The dimensions this rep is weakest at, with something to do about each. */
export function practiceAreas(sessions: SessionScore[], take = 3): PracticeArea[] {
  return weakestDimensions(sessions, take).map(({ dimension, average }) => {
    const remedy = DIMENSION_REMEDY[dimension];
    return {
      dimension,
      label: DIMENSION_LABELS[dimension],
      average,
      suggestion: remedy.text,
      suggestedActivityId: remedy.activityId,
    };
  });
}

// ── Team gaps ─────────────────────────────────────────────────────────────────
// A supervisor view of where the TEAM is weak, aggregated. Deliberately shaped
// as dimensions and activities, never as a list of people sorted by score.

export type TeamGap = {
  dimension: ScoreDimension;
  label: string;
  average: number;
  /** How many reps in the sample are below the developing threshold. */
  repsBelow: number;
  suggestion: string;
};

export function teamGaps(
  perRep: { userId: number; sessions: SessionScore[] }[],
  take = 4,
): TeamGap[] {
  const totals = new Map<ScoreDimension, number[]>();
  const belowCount = new Map<ScoreDimension, number>();

  for (const rep of perRep) {
    if (!rep.sessions.length) continue;
    for (const dimension of SCORE_DIMENSIONS) {
      const scores = rep.sessions.flatMap((s) => s.dimensions.filter((d) => d.dimension === dimension).map((d) => d.score));
      if (!scores.length) continue;
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      const list = totals.get(dimension) ?? [];
      list.push(avg);
      totals.set(dimension, list);
      if (avg < 55) belowCount.set(dimension, (belowCount.get(dimension) ?? 0) + 1);
    }
  }

  return [...totals.entries()]
    .map(([dimension, list]) => ({
      dimension,
      label: DIMENSION_LABELS[dimension],
      average: Math.round(list.reduce((a, b) => a + b, 0) / list.length),
      repsBelow: belowCount.get(dimension) ?? 0,
      suggestion: DIMENSION_REMEDY[dimension].text,
    }))
    .sort((a, b) => a.average - b.average)
    .slice(0, take);
}

// ── Assignments ───────────────────────────────────────────────────────────────

export type Assignment = {
  id: number;
  /** Rep this was assigned to. */
  userId: number;
  /** Activity or stage id. */
  targetId: string;
  targetKind: "activity" | "stage";
  /** Why, in the supervisor's own words. Shown to the rep. */
  note: string;
  assignedBy: number;
  assignedAt: string;
  /** ISO date, or null for no deadline. */
  dueOn: string | null;
  completedAt: string | null;
};

/** Assignments still outstanding, soonest due first, undated last. Tolerates a
 *  missing list, because the caller may hold a payload from an older server. */
export function openAssignments(assignments: Assignment[] | undefined | null): Assignment[] {
  return (assignments ?? [])
    .filter((a) => !a.completedAt)
    .sort((a, b) => {
      if (a.dueOn && b.dueOn) return a.dueOn.localeCompare(b.dueOn);
      if (a.dueOn) return -1;
      if (b.dueOn) return 1;
      return a.assignedAt.localeCompare(b.assignedAt);
    });
}

/** True when the assignment's target is satisfied by these records. */
export function assignmentSatisfied(assignment: Assignment, records: ActivityRecord[]): boolean {
  if (assignment.targetKind === "activity") {
    return records.some((r) => r.activityId === assignment.targetId);
  }
  const progress = computePathProgress(records);
  return progress.stages.find((s) => s.stage.id === assignment.targetId)?.complete ?? false;
}
