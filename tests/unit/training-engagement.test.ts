// Integrity for the additive engagement layer: the optional module fields
// (hook, fieldStory, sayThisNotThat), the optional lesson pitchDrill, and the
// fast-start track. The invariants here are that everything new stays emoji-free,
// the fast-start track only references real lesson ids, and every existing lesson
// still carries its required fields (nothing additive broke the base contract).
import { describe, expect, it } from "vitest";
import {
  TRAINING_MODULES,
  TRAINING_LESSONS,
  TRAINING_FAST_START,
  FAST_START_LESSON_IDS,
  getFastStartLessons,
  isTrainingLessonId,
} from "../../shared/trainingContent";

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}]/u;

describe("training engagement layer", () => {
  it("every module carries a punchy hook, a field story, and a say-this-not-that swap", () => {
    // Guard the count first so a merge that drops/duplicates a module fails
    // with a clear number rather than a cryptic per-field undefined.
    expect(TRAINING_MODULES.length).toBe(9);
    // These are optional in the type for back-compat, but the tone pass adds
    // them to all nine — pin that so a regression that drops them is caught.
    for (const mod of TRAINING_MODULES) {
      expect(mod.hook?.trim().length, `module ${mod.id} hook`).toBeGreaterThan(0);
      expect(mod.fieldStory?.trim().length, `module ${mod.id} fieldStory`).toBeGreaterThan(0);
      expect(mod.sayThisNotThat, `module ${mod.id} sayThisNotThat`).toBeTruthy();
      expect(mod.sayThisNotThat!.instead.trim().length, mod.id).toBeGreaterThan(0);
      expect(mod.sayThisNotThat!.say.trim().length, mod.id).toBeGreaterThan(0);
    }
  });

  it("the engagement fields contain no emoji", () => {
    for (const mod of TRAINING_MODULES) {
      const blob = JSON.stringify([mod.hook, mod.fieldStory, mod.sayThisNotThat]);
      expect(blob, `module ${mod.id}`).not.toMatch(EMOJI);
    }
  });

  it("pitchDrill, where present, is a non-empty emoji-free string", () => {
    const withDrill = TRAINING_LESSONS.filter((l) => l.pitchDrill != null);
    // The recorder needs somewhere to live — at least a handful of lessons.
    expect(withDrill.length).toBeGreaterThanOrEqual(4);
    for (const lesson of withDrill) {
      expect(typeof lesson.pitchDrill, lesson.id).toBe("string");
      expect(lesson.pitchDrill!.trim().length, lesson.id).toBeGreaterThan(0);
      expect(lesson.pitchDrill!, lesson.id).not.toMatch(EMOJI);
    }
  });

  it("spans the key pitch modules (m2, m3, m7, m9) with practice drills", () => {
    const modulesWithDrill = new Set(
      TRAINING_LESSONS.filter((l) => l.pitchDrill).map((l) => l.id.split("-")[0]),
    );
    for (const m of ["m2", "m3", "m7", "m9"]) {
      expect(modulesWithDrill.has(m), `expected a pitch drill in ${m}`).toBe(true);
    }
  });

  it("the fast-start track lists ~5 steps, each referencing a real lesson id, in order", () => {
    expect(TRAINING_FAST_START.length).toBeGreaterThanOrEqual(4);
    expect(TRAINING_FAST_START.length).toBeLessThanOrEqual(6);
    for (const step of TRAINING_FAST_START) {
      expect(isTrainingLessonId(step.lessonId), step.lessonId).toBe(true);
      expect(step.why.trim().length, step.lessonId).toBeGreaterThan(0);
      expect(step.why, step.lessonId).not.toMatch(EMOJI);
    }
    // No duplicates.
    expect(new Set(FAST_START_LESSON_IDS).size).toBe(FAST_START_LESSON_IDS.length);
  });

  it("resolves every fast-start step to a real lesson and module", () => {
    const resolved = getFastStartLessons();
    expect(resolved.length).toBe(TRAINING_FAST_START.length);
    for (const { step, lesson, module } of resolved) {
      expect(lesson.id).toBe(step.lessonId);
      expect(module.lessons.some((l) => l.id === lesson.id)).toBe(true);
    }
  });

  it("every lesson still has its required base fields after the additive pass", () => {
    for (const lesson of TRAINING_LESSONS) {
      expect(lesson.title.trim().length, lesson.id).toBeGreaterThan(0);
      expect(lesson.summary.trim().length, lesson.id).toBeGreaterThan(0);
      expect(lesson.minutes, lesson.id).toBeGreaterThan(0);
      expect(lesson.sections.length, lesson.id).toBeGreaterThanOrEqual(2);
      expect(lesson.keyTakeaways.length, lesson.id).toBeGreaterThanOrEqual(3);
      expect(lesson.drillPrompt.trim().length, lesson.id).toBeGreaterThan(0);
      expect(lesson.quiz.length, lesson.id).toBeGreaterThanOrEqual(3);
    }
  });
});
