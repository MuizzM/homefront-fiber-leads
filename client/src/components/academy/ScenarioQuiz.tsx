// ── Scenario quiz ─────────────────────────────────────────────────────────────
//
// Situational judgement, one question per screen. The screen-per-question shape
// is deliberate: a scrolling list of five questions lets a rep skim, and the
// whole point is that they sit with one door at a time.
//
// Answers lock on selection and the explanation appears immediately, including
// on a correct answer, because the explanation says why the TEMPTING wrong
// answer is wrong and that is the part worth reading either way.
//
// Progress autosaves after every answer, so closing the app at question two
// and reopening between houses resumes at question three.

import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { Chip, Panel, PrimaryButton, QuietButton } from "./primitives";
import { useActivityAutosave } from "@/lib/useAcademy";
import type { ScenarioSet } from "@shared/academyPath";

export type ScenarioProgressState = { answers: Record<number, number> };

export default function ScenarioQuiz({
  set, activityId, resume, passScore, onComplete, onExit,
}: {
  set: ScenarioSet;
  activityId: string;
  resume: ScenarioProgressState | null;
  passScore?: number;
  onComplete: (score: number) => void;
  onExit: () => void;
}) {
  const [answers, setAnswers] = useState<Record<number, number>>(() => resume?.answers ?? {});
  const [index, setIndex] = useState(() => {
    const answered = Object.keys(resume?.answers ?? {}).length;
    return Math.min(answered, set.questions.length - 1);
  });

  useActivityAutosave(activityId, { answers }, true);

  const question = set.questions[index];
  const picked = answers[index];
  const answered = picked !== undefined;
  const answeredCount = Object.keys(answers).length;
  const allAnswered = answeredCount === set.questions.length;

  const correctCount = useMemo(
    () => set.questions.reduce((acc, q, i) => acc + (answers[i] === q.answerIndex ? 1 : 0), 0),
    [answers, set.questions],
  );
  const score = Math.round((correctCount / set.questions.length) * 100);

  const passed = passScore == null || score >= passScore;

  // Announce the result to assistive tech when the last answer lands.
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (allAnswered) setAnnouncement(`Scenario complete. Score ${score} percent.`);
  }, [allAnswered, score]);

  function choose(optionIndex: number) {
    if (answered) return;
    setAnswers((prev) => ({ ...prev, [index]: optionIndex }));
  }

  return (
    <div className="space-y-4" data-testid={`scenario-${set.id}`}>
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>{set.title}</SectionLabel>
        <span className="text-xs tabular-nums text-muted-foreground" data-testid="scenario-progress">
          {index + 1} of {set.questions.length}
        </span>
      </div>

      {/* Thin progress rail. Duration comes from the shared motion vocabulary,
          which the global reduced-motion block already collapses. */}
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
          style={{ width: `${Math.round((answeredCount / set.questions.length) * 100)}%` }}
        />
      </div>

      <Panel testId="scenario-question">
        <p className="text-[15px] font-semibold leading-snug text-foreground">{question.situation}</p>
        <div className="mt-4 space-y-2" role="radiogroup" aria-label="Choose the best response">
          {question.options.map((option, oi) => {
            const isCorrect = oi === question.answerIndex;
            const isPicked = picked === oi;
            return (
              <button
                key={oi}
                type="button"
                role="radio"
                aria-checked={isPicked}
                disabled={answered}
                onClick={() => choose(oi)}
                data-testid={`scenario-q${index}-opt${oi}`}
                className={cn(
                  "flex min-h-11 w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left text-[13px] leading-snug transition-colors",
                  FOCUS,
                  !answered && "border-border bg-background hover:border-primary/40 hover:bg-secondary/50",
                  answered && isCorrect && "border-success/50 bg-success/[0.08] text-foreground",
                  answered && isPicked && !isCorrect && "border-destructive/50 bg-destructive/[0.08] text-foreground",
                  answered && !isPicked && !isCorrect && "border-border bg-background opacity-55",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full border text-2xs font-bold",
                    answered && isCorrect ? "border-success bg-success text-success-foreground"
                      : answered && isPicked ? "border-destructive bg-destructive text-white"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {answered && isCorrect ? <Check className="h-3 w-3" /> : String.fromCharCode(65 + oi)}
                </span>
                <span className="min-w-0 flex-1">{option}</span>
              </button>
            );
          })}
        </div>

        {answered && (
          <div
            className={cn(
              "mt-3 rounded-xl px-3 py-2.5 text-xs leading-relaxed",
              picked === question.answerIndex ? "bg-success/[0.08]" : "bg-destructive/[0.08]",
            )}
            data-testid={`scenario-q${index}-feedback`}
          >
            <span className={cn("font-semibold", picked === question.answerIndex ? "text-success" : "text-destructive")}>
              {picked === question.answerIndex ? "Correct. " : "Not quite. "}
            </span>
            <span className="text-muted-foreground">{question.explanation}</span>
          </div>
        )}
      </Panel>

      <div className="flex flex-wrap items-center gap-2">
        {index > 0 && (
          <QuietButton onClick={() => setIndex(index - 1)} testId="scenario-prev">Back</QuietButton>
        )}
        {answered && index < set.questions.length - 1 && (
          <PrimaryButton onClick={() => setIndex(index + 1)} testId="scenario-next">Next situation</PrimaryButton>
        )}
        {allAnswered && index === set.questions.length - 1 && (
          <>
            <PrimaryButton onClick={() => onComplete(score)} testId="scenario-finish">
              {passed ? `Finish with ${score}%` : `Save ${score}% and retry`}
            </PrimaryButton>
            {!passed && (
              <QuietButton
                onClick={() => { setAnswers({}); setIndex(0); }}
                testId="scenario-restart"
              >
                Run it again
              </QuietButton>
            )}
          </>
        )}
        <QuietButton onClick={onExit} testId="scenario-exit">Leave for now</QuietButton>
      </div>

      {allAnswered && passScore != null && !passed && (
        <Panel tone="warn" testId="scenario-below-pass">
          <p className="text-[13px] leading-relaxed text-foreground">
            This one needs {passScore}% to count as done. Your answers are saved, so run it again whenever you have a
            few minutes.
          </p>
        </Panel>
      )}

      {allAnswered && (
        <div className="flex items-center gap-2" data-testid="scenario-result">
          <Chip tone={passed ? "good" : "warn"}>{score}%</Chip>
          <span className="text-xs text-muted-foreground">
            {correctCount} of {set.questions.length} right
          </span>
        </div>
      )}

      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </div>
  );
}
