// Path progress, resume, certifications, achievements and team gaps.
//
// The load-bearing tests here are the pass rule (one place, so a tick and a
// rollup can never disagree), the resume point (the single most valuable thing
// the tab does on a phone between houses), and the shape of the team view,
// which must never become a ranking of people.
import { describe, expect, it } from "vitest";
import {
  achievementsFor, assignmentSatisfied, certificationStatuses, computePathProgress,
  isActivityPassed, openAssignments, practiceAreas, teamGaps,
  type ActivityRecord, type Assignment,
} from "../../shared/academyProgress";
import { ALL_ACTIVITIES, CERTIFICATIONS, PATH_STAGES, TOTAL_ACTIVITIES, getActivity } from "../../shared/academyPath";
import { SCORE_DIMENSIONS, scoreSession } from "../../shared/academyScoring";
import { respond, startSession } from "../../shared/academyRolePlay";

function record(activityId: string, score: number | null = null, at = "2026-08-01T00:00:00Z"): ActivityRecord {
  return { activityId, completedAt: at, score };
}

/** Every activity in a stage, passed. */
function passStage(stageId: string): ActivityRecord[] {
  const stage = PATH_STAGES.find((s) => s.id === stageId)!;
  return stage.activities.map((a) => record(a.id, a.passScore ?? 100));
}

describe("the pass rule", () => {
  it("counts an unscored activity as done once it has a record", () => {
    const activity = ALL_ACTIVITIES.find((a) => a.passScore == null)!;
    expect(isActivityPassed(activity, [])).toBe(false);
    expect(isActivityPassed(activity, [record(activity.id)])).toBe(true);
  });

  it("does not count a scored activity below its bar", () => {
    const activity = ALL_ACTIVITIES.find((a) => a.passScore != null)!;
    expect(isActivityPassed(activity, [record(activity.id, activity.passScore! - 1)])).toBe(false);
    expect(isActivityPassed(activity, [record(activity.id, activity.passScore!)])).toBe(true);
  });

  it("does not count a scored activity recorded with no score", () => {
    const activity = ALL_ACTIVITIES.find((a) => a.passScore != null)!;
    expect(isActivityPassed(activity, [record(activity.id, null)])).toBe(false);
  });

  it("agrees with the rollup, always", () => {
    const activity = ALL_ACTIVITIES.find((a) => a.passScore != null)!;
    const records = [record(activity.id, activity.passScore! - 10)];
    const progress = computePathProgress(records);
    // Not passed by the helper, and not counted by the rollup either.
    expect(isActivityPassed(activity, records)).toBe(false);
    expect(progress.done).toBe(0);
  });
});

describe("path progress", () => {
  it("starts at zero with everything after the first stage locked", () => {
    const progress = computePathProgress([]);
    expect(progress.done).toBe(0);
    expect(progress.total).toBe(TOTAL_ACTIVITIES);
    expect(progress.percent).toBe(0);
    expect(progress.stages[0].locked).toBe(false);
    expect(progress.stages[1].locked).toBe(true);
  });

  it("unlocks the next stage when the one before it completes", () => {
    const progress = computePathProgress(passStage("stage-product"));
    expect(progress.stages[0].complete).toBe(true);
    expect(progress.stages[1].locked).toBe(false);
    expect(progress.stages[2].locked).toBe(true);
  });

  it("reports a per-stage percentage", () => {
    const stage = PATH_STAGES[0];
    const half = stage.activities.slice(0, 2).map((a) => record(a.id, 100));
    const progress = computePathProgress(half);
    const first = progress.stages[0];
    expect(first.done).toBe(2);
    expect(first.percent).toBe(Math.round((2 / first.total) * 100));
  });

  it("reaches 100 percent when everything passes", () => {
    const all = ALL_ACTIVITIES.map((a) => record(a.id, 100));
    const progress = computePathProgress(all);
    expect(progress.done).toBe(TOTAL_ACTIVITIES);
    expect(progress.percent).toBe(100);
    expect(progress.resume).toBeNull();
  });
});

describe("resume", () => {
  it("points at the very first activity for a new rep", () => {
    const progress = computePathProgress([]);
    expect(progress.resume?.activity.id).toBe(PATH_STAGES[0].activities[0].id);
    expect(progress.resume?.stage.id).toBe(PATH_STAGES[0].id);
  });

  it("skips what is done and lands on the first gap, in path order", () => {
    const stage = PATH_STAGES[0];
    const progress = computePathProgress([record(stage.activities[0].id, 100)]);
    expect(progress.resume?.activity.id).toBe(stage.activities[1].id);
  });

  it("resumes into a scored activity the rep failed rather than skipping past it", () => {
    const scored = ALL_ACTIVITIES.find((a) => a.passScore != null)!;
    const before = ALL_ACTIVITIES.slice(0, ALL_ACTIVITIES.indexOf(scored)).map((a) => record(a.id, 100));
    const progress = computePathProgress([...before, record(scored.id, scored.passScore! - 20)]);
    expect(progress.resume?.activity.id).toBe(scored.id);
  });

  it("carries the stage alongside the activity so the UI can label it", () => {
    const progress = computePathProgress([]);
    expect(progress.resume?.stage.activities).toContain(progress.resume?.activity);
  });
});

describe("certifications", () => {
  it("is unearned at the start, and says what is outstanding", () => {
    const statuses = certificationStatuses([], []);
    expect(statuses).toHaveLength(CERTIFICATIONS.length);
    for (const status of statuses) {
      expect(status.earned, status.certification.id).toBe(false);
      expect(status.remaining.length, status.certification.id).toBeGreaterThan(0);
      expect(status.earnedAt).toBeNull();
    }
  });

  it("earns door-ready when its four stages are complete", () => {
    const cert = CERTIFICATIONS.find((c) => c.id === "cert-door-ready")!;
    const records = cert.stageIds.flatMap(passStage);
    const status = certificationStatuses(records, []).find((s) => s.certification.id === cert.id)!;
    expect(status.earned).toBe(true);
    expect(status.earnedAt).toBeTruthy();
  });

  it("withholds an objection certification until the role-play average clears the bar", () => {
    const cert = CERTIFICATIONS.find((c) => c.id === "cert-objection")!;
    const records = cert.stageIds.flatMap(passStage);

    const noSessions = certificationStatuses(records, []).find((s) => s.certification.id === cert.id)!;
    expect(noSessions.earned).toBe(false);
    expect(noSessions.remaining.join(" ")).toContain("at least one role-play");

    const tooLow = certificationStatuses(records, [40, 50]).find((s) => s.certification.id === cert.id)!;
    expect(tooLow.earned).toBe(false);
    expect(tooLow.remaining.join(" ")).toContain("needs 65");

    const good = certificationStatuses(records, [80, 70]).find((s) => s.certification.id === cert.id)!;
    expect(good.earned).toBe(true);
  });

  it("earns the full certification only with the whole path plus role-plays", () => {
    const all = ALL_ACTIVITIES.map((a) => record(a.id, 100));
    expect(certificationStatuses(all, []).find((s) => s.certification.id === "cert-full")!.earned).toBe(false);
    expect(certificationStatuses(all, [90]).find((s) => s.certification.id === "cert-full")!.earned).toBe(true);
  });
});

describe("achievements", () => {
  it("are milestones against a fixed bar, so everybody can hold the same one", () => {
    const a = achievementsFor([record("act-product-card")], []);
    const b = achievementsFor([record("act-product-card")], []);
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    expect(a.map((x) => x.id)).toContain("first-step");
  });

  it("gives nothing before anything is done", () => {
    expect(achievementsFor([], [])).toEqual([]);
  });

  it("recognises a clean compliance run across three sessions", () => {
    const clean = ["a", "b", "c"].map((id) => {
      const s = respond(
        startSession({ id, personaId: "busy_homeowner", market: "" }),
        "Hi, my name is Sam, I'm with the Kinetic fiber crew on your street. Thirty seconds and I'm gone.",
      );
      return scoreSession(s);
    });
    expect(achievementsFor([record("act-product-card")], clean).map((a) => a.id)).toContain("clean-compliance");
  });
});

describe("practice areas", () => {
  it("is empty with no sessions", () => {
    expect(practiceAreas([])).toEqual([]);
  });

  it("names the weakest dimensions and points each at something to do", () => {
    const s = respond(startSession({ id: "weak", personaId: "gamer", market: "" }), "Yeah.");
    const areas = practiceAreas([scoreSession(s)], 3);
    expect(areas).toHaveLength(3);
    for (const area of areas) {
      expect(SCORE_DIMENSIONS as readonly string[]).toContain(area.dimension);
      expect(area.suggestion.length).toBeGreaterThan(20);
      if (area.suggestedActivityId) expect(getActivity(area.suggestedActivityId), area.suggestedActivityId).toBeTruthy();
    }
    expect(areas[0].average).toBeLessThanOrEqual(areas[1].average);
  });
});

describe("team gaps", () => {
  function repWith(userId: number, line: string) {
    const s = respond(startSession({ id: `t${userId}`, personaId: "gamer", market: "" }), line);
    return { userId, sessions: [scoreSession(s)] };
  }

  it("aggregates by dimension, never by person", () => {
    const gaps = teamGaps([repWith(1, "Yeah."), repWith(2, "Uh huh.")], 4);
    expect(gaps).toHaveLength(4);
    for (const gap of gaps) {
      expect(SCORE_DIMENSIONS as readonly string[]).toContain(gap.dimension);
      // A gap describes a skill and a count, and carries no user identity.
      expect(Object.keys(gap).sort()).toEqual(["average", "dimension", "label", "repsBelow", "suggestion"]);
    }
  });

  it("orders the weakest dimension first", () => {
    const gaps = teamGaps([repWith(1, "Yeah."), repWith(2, "Uh huh.")], 5);
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i].average).toBeGreaterThanOrEqual(gaps[i - 1].average);
    }
  });

  it("ignores reps with no sessions rather than counting them as zero", () => {
    const gaps = teamGaps([repWith(1, "Yeah."), { userId: 2, sessions: [] }], 3);
    expect(gaps.every((g) => g.repsBelow <= 1)).toBe(true);
  });

  it("returns nothing for a team that has never practised", () => {
    expect(teamGaps([{ userId: 1, sessions: [] }])).toEqual([]);
  });
});

describe("assignments", () => {
  function assignment(over: Partial<Assignment> = {}): Assignment {
    return {
      id: 1, userId: 5, targetId: "stage-product", targetKind: "stage", note: "",
      assignedBy: 2, assignedAt: "2026-08-01T00:00:00Z", dueOn: null, completedAt: null,
      ...over,
    };
  }

  it("tolerates a missing list, because an older server may not send one", () => {
    expect(openAssignments(undefined)).toEqual([]);
    expect(openAssignments(null)).toEqual([]);
  });

  it("hides completed assignments", () => {
    expect(openAssignments([assignment({ completedAt: "2026-08-02T00:00:00Z" })])).toEqual([]);
  });

  it("sorts soonest due first and undated last", () => {
    const list = openAssignments([
      assignment({ id: 1, dueOn: null }),
      assignment({ id: 2, dueOn: "2026-09-01" }),
      assignment({ id: 3, dueOn: "2026-08-15" }),
    ]);
    expect(list.map((a) => a.id)).toEqual([3, 2, 1]);
  });

  it("knows when an activity assignment is satisfied", () => {
    const a = assignment({ targetKind: "activity", targetId: "act-product-card" });
    expect(assignmentSatisfied(a, [])).toBe(false);
    expect(assignmentSatisfied(a, [record("act-product-card")])).toBe(true);
  });

  it("knows when a stage assignment is satisfied", () => {
    const a = assignment({ targetKind: "stage", targetId: "stage-product" });
    expect(assignmentSatisfied(a, [])).toBe(false);
    expect(assignmentSatisfied(a, passStage("stage-product"))).toBe(true);
  });
});
