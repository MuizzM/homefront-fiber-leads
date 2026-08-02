// Content integrity for the D2D training curriculum. The content file is data
// the server validates against and the client renders blindly — these tests pin
// the invariants both sides rely on: unique stable ids, valid quiz answers,
// module/lesson counts in spec, and the house rule of no emoji anywhere.
import { describe, expect, it } from "vitest";
import {
  TRAINING_MODULES,
  TRAINING_LESSONS,
  TOTAL_TRAINING_LESSONS,
  isTrainingLessonId,
  getTrainingLesson,
  getTrainingModuleForLesson,
} from "../../shared/trainingContent";

describe("training content integrity", () => {
  it("has exactly 9 modules, each with 3-6 lessons", () => {
    expect(TRAINING_MODULES).toHaveLength(9);
    for (const mod of TRAINING_MODULES) {
      expect(mod.lessons.length, `module ${mod.id}`).toBeGreaterThanOrEqual(3);
      expect(mod.lessons.length, `module ${mod.id}`).toBeLessThanOrEqual(6);
    }
  });

  it("has globally unique lesson ids, and module ids prefix their lessons", () => {
    const ids = TRAINING_LESSONS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const mod of TRAINING_MODULES) {
      for (const lesson of mod.lessons) {
        expect(lesson.id.startsWith(`${mod.id}-`), `${lesson.id} should start with ${mod.id}-`).toBe(true);
      }
    }
    expect(TOTAL_TRAINING_LESSONS).toBe(ids.length);
  });

  it("every quiz has 3-4 questions and every answer index points at a real option", () => {
    for (const lesson of TRAINING_LESSONS) {
      expect(lesson.quiz.length, lesson.id).toBeGreaterThanOrEqual(3);
      expect(lesson.quiz.length, lesson.id).toBeLessThanOrEqual(4);
      for (const q of lesson.quiz) {
        expect(q.options.length, `${lesson.id}: ${q.question}`).toBeGreaterThanOrEqual(2);
        expect(Number.isInteger(q.answerIndex), lesson.id).toBe(true);
        expect(q.answerIndex, `${lesson.id}: ${q.question}`).toBeGreaterThanOrEqual(0);
        expect(q.answerIndex, `${lesson.id}: ${q.question}`).toBeLessThan(q.options.length);
        expect(q.explanation.trim().length, lesson.id).toBeGreaterThan(0);
      }
    }
  });

  it("every lesson carries sections, takeaways, and a drill prompt", () => {
    for (const lesson of TRAINING_LESSONS) {
      expect(lesson.title.trim().length, lesson.id).toBeGreaterThan(0);
      expect(lesson.summary.trim().length, lesson.id).toBeGreaterThan(0);
      expect(lesson.minutes, lesson.id).toBeGreaterThan(0);
      expect(lesson.sections.length, lesson.id).toBeGreaterThanOrEqual(2);
      for (const s of lesson.sections) {
        expect(s.heading.trim().length, lesson.id).toBeGreaterThan(0);
        expect(s.body.length, lesson.id).toBeGreaterThanOrEqual(1);
      }
      expect(lesson.keyTakeaways.length, lesson.id).toBeGreaterThanOrEqual(3);
      expect(lesson.drillPrompt.trim().length, lesson.id).toBeGreaterThan(0);
    }
  });

  it("contains no emoji anywhere in the curriculum", () => {
    const everything = JSON.stringify(TRAINING_MODULES);
    // Extended_Pictographic covers emoji + pictographs; the variation selector
    // catches emoji-styled text characters slipping through.
    expect(everything).not.toMatch(/[\p{Extended_Pictographic}\u{FE0F}]/u);
  });

  it("validates lesson ids for the server route", () => {
    expect(isTrainingLessonId("m1-rejection-math")).toBe(true);
    expect(isTrainingLessonId("m7-referral-close")).toBe(true);
    expect(isTrainingLessonId("m9-not-real")).toBe(false);
    expect(isTrainingLessonId("")).toBe(false);
    expect(getTrainingLesson("m1-rejection-math")?.id).toBe("m1-rejection-math");
    expect(getTrainingModuleForLesson("m1-rejection-math")?.id).toBe("m1");
    expect(getTrainingModuleForLesson("nope")).toBeUndefined();
  });
});
