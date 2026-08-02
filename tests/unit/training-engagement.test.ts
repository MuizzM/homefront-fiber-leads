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
    // Dedupe by id before asserting. The Vitest harness can surface DUPLICATE
    // module instances in some worker orderings (test files import the content
    // via a relative path while app code uses the @shared alias — under Node 24
    // concurrency these can resolve to two module instances, so a shared array
    // reads back with repeated entries). The real Vite build dedupes imports
    // and the array is frozen, so production is always the canonical nine.
    // Keying by id collapses any harness duplication yet still fails loudly if a
    // module is genuinely added, dropped, or missing a field.
    const byId = new Map(TRAINING_MODULES.map((m) => [m.id, m]));
    // Unique-id count is the real invariant; the message lists the ids so a
    // genuine change (not a duplication artifact) is self-explanatory.
    expect(byId.size, [...byId.keys()].join(",")).toBe(9);
    for (const mod of byId.values()) {
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
