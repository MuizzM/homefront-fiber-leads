// Deck runner for all three field modes. Reviews go to the offline outbox via
// the parent's onGrade (useRecordReviews); grading applies the SHARED ladder
// optimistically so a dead-zone session stays correct. An "again" grade
// re-queues the card at the tail of THIS session's pile — the ladder's rung-0
// "see it in 10 minutes" rendered as the deck's own retry loop, offline-safe.
import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import type { DrillCard } from "@shared/trainingCards";
import type { Grade } from "@shared/trainingSchedule";
import type { DeckMode } from "@/lib/useTrainingEngine";
import { DailyDrillCard } from "./DailyDrillCard";
import { PitchDrillCard } from "./PitchDrillCard";

export type { DeckMode };

const FOUR_GRADES: { grade: Grade; label: string; cls: string }[] = [
  { grade: "again", label: "Again", cls: "border-destructive/40 bg-destructive/10 text-foreground" },
  { grade: "hard", label: "Hard", cls: "border-border bg-secondary text-foreground" },
  { grade: "good", label: "Good", cls: "border-primary/40 bg-primary/[0.12] text-foreground" },
  { grade: "easy", label: "Easy", cls: "border-primary/40 bg-primary text-primary-foreground" },
];

// Refresher is the 30-second mode: two taps max, mapped onto real grades.
const TWO_GRADES = FOUR_GRADES.filter((g) => g.grade === "again" || g.grade === "good").map((g) =>
  g.grade === "good" ? { ...g, label: "Got it" } : g,
);

export function FlashcardDeck({
  cards,
  mode,
  onGrade,
  onExit,
  onDone,
}: {
  cards: DrillCard[];
  mode: DeckMode;
  /** (card, grade, mode) → outbox + optimistic query update (useRecordReviews). */
  onGrade: (card: DrillCard, grade: Grade, mode: DeckMode) => void;
  onExit: () => void;
  onDone: () => void;
}) {
  // queue holds the cards still to run; index walks it; "again" re-appends.
  const [queue, setQueue] = useState<DrillCard[]>(cards);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const grades = mode === "refresher" ? TWO_GRADES : FOUR_GRADES;
  const card = queue[index];
  const total = queue.length;
  const done = index >= total;

  function grade(g: Grade) {
    if (!card) return;
    onGrade(card, g, mode);
    setFlipped(false);
    if (g === "again" && mode !== "refresher") {
      // Rung 0 is the same-session retry rung — re-deal the card at the tail
      // (bounded: a card the rep keeps missing resurfaces, never blocks exit;
      // the outbox already recorded each grade durably).
      setQueue((q) => (q.length - index > 1 ? [...q, card] : q));
    }
    setIndex((i) => i + 1);
  }

  return (
    <div className="mx-auto w-full max-w-lg px-4 pt-5 pb-[max(6rem,env(safe-area-inset-bottom))]" data-testid={`deck-${mode}`}>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onExit}
          aria-label="Exit deck"
          data-testid="deck-exit"
          className={cn("grid min-h-11 w-11 place-items-center rounded-xl text-muted-foreground", FOCUS)}
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
        <span className="text-2xs tabular-nums text-muted-foreground" data-testid="deck-progress" role="status">
          {done ? `${total} of ${total}` : `${index + 1} of ${total}`}
        </span>
      </div>

      {done ? (
        <div className="mt-10 rounded-2xl border border-border bg-card p-6 text-center" data-testid="deck-finished">
          <div className="text-[15px] font-semibold text-foreground">
            {mode === "warmup" ? "Warm — first door's waiting." : mode === "debrief" ? "Debrief done — data collected." : "Deck clear."}
          </div>
          <div className="mt-1 text-sm-minus text-muted-foreground">
            {mode === "warmup" ? "Your opener is loaded. Go get the first yes." : "Pick up where you left off anytime."}
          </div>
          <button
            type="button"
            onClick={onDone}
            data-testid="deck-done"
            className={cn(
              "mt-4 inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground active:scale-[.98]",
              FOCUS,
            )}
          >
            {mode === "warmup" ? "Back to Today" : "Done"}
          </button>
        </div>
      ) : queue.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-border bg-card p-6 text-center" data-testid="deck-empty">
          <div className="text-[15px] font-semibold text-foreground">Nothing due right now</div>
          <div className="mt-1 text-sm-minus text-muted-foreground">New cards land here as you work the course.</div>
          <button
            type="button"
            onClick={onExit}
            className={cn(
              "mt-4 inline-flex min-h-11 items-center rounded-xl bg-secondary border border-border px-5 text-sm font-semibold text-foreground active:scale-[.98]",
              FOCUS,
            )}
          >
            Back
          </button>
        </div>
      ) : (
        <>
          <div className="mt-4">
            {card.kind === "script" ? (
              <PitchDrillCard card={card} flipped={flipped} onFlip={() => setFlipped((f) => !f)} />
            ) : (
              <DailyDrillCard card={card} flipped={flipped} onFlip={() => setFlipped((f) => !f)} />
            )}
          </div>
          {/* Grade bar lives in the thumb zone, OutcomeSheet-style. Reveal
              before judging — recall, not skim. */}
          <div className="mt-4 grid gap-2.5" style={{ gridTemplateColumns: `repeat(${grades.length}, 1fr)` }} data-testid="grade-bar">
            {grades.map((g) => (
              <button
                key={g.grade}
                type="button"
                disabled={!flipped}
                onClick={() => grade(g.grade)}
                data-testid={`grade-${g.grade}`}
                aria-label={`Grade this card: ${g.label}`}
                className={cn(
                  "min-h-12 rounded-xl border text-sm font-semibold transition-transform active:scale-[.97] disabled:opacity-40",
                  g.cls,
                  FOCUS,
                )}
              >
                {g.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
