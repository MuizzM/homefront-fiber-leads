// ── Feature to outcome flashcards ─────────────────────────────────────────────
//
// The one translation every rep has to make automatically: a specification on
// one side, the thing a household actually feels on the other. Front is the
// feature, back is the outcome plus the sentence to say.
//
// Flip is a real 3D transform using the shared .hf-flip vocabulary already in
// index.css, which swaps faces instantly under reduced motion. The whole card
// is the button, so it works from the keyboard without a separate control.
//
// Grading is self-report, two buttons. It feeds a score for the path activity
// and nothing else: this is not the spaced-repetition ladder, which lives in
// the Coach tab and has its own server state.

import { useState } from "react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { Chip, Panel, PrimaryButton, QuietButton } from "./primitives";

type Card = {
  /** The specification, as it appears on a plan sheet. */
  feature: string;
  /** What it means for a person in a house. */
  outcome: string;
  /** The line to actually say. */
  say: string;
};

const CARDS: readonly Card[] = [
  {
    feature: "Symmetrical upload",
    outcome: "Video calls that do not freeze, and files that go out as fast as they come in.",
    say: "When your camera freezes and someone says you're breaking up, that's upload. It's the same number both ways on this.",
  },
  {
    feature: "Dedicated line to the house",
    outcome: "It does not sag at eight at night when the whole street is home.",
    say: "Cable is shared with the street. A fiber line doesn't have neighbors on it.",
  },
  {
    feature: "Low, steady latency",
    outcome: "Games and calls feel immediate rather than a beat behind.",
    say: "Download speed isn't what you feel in a match. Latency is, and that's what changes.",
  },
  {
    feature: "High device capacity",
    outcome: "Everyone in the house on at once without anyone noticing.",
    say: "The test isn't one device. It's the evening when the TV, two phones and a console are all going.",
  },
  {
    feature: "No term commitment",
    outcome: "Nothing to be stuck in if it does not do what was promised.",
    say: "There's no term on it. If it doesn't do what I said, you're not stuck with it.",
  },
  {
    feature: "Equipment included in the plan price",
    outcome: "One number on the bill, with nothing appearing in month two.",
    say: "That's the whole monthly number, equipment included. Nothing else lands on the bill.",
  },
  {
    feature: "Scheduled professional install",
    outcome: "One appointment window, and no work for the customer.",
    say: "A tech comes out in a two hour window. You don't have to do anything except let them in.",
  },
  {
    feature: "Fiber is immune to electrical noise and heat",
    outcome: "The speed holds instead of drifting through the day.",
    say: "It's light down glass, so it doesn't degrade the way copper does in the heat.",
  },
];

export default function FeatureToOutcome({ onComplete, onExit }: {
  onComplete: (score: number) => void;
  onExit: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState(0);
  const [seen, setSeen] = useState(0);

  const card = CARDS[index];
  const finished = seen >= CARDS.length;
  const score = seen ? Math.round((known / seen) * 100) : 0;

  function grade(gotIt: boolean) {
    setKnown((k) => k + (gotIt ? 1 : 0));
    setSeen((s) => s + 1);
    setFlipped(false);
    setIndex((i) => Math.min(CARDS.length - 1, i + 1));
  }

  if (finished) {
    return (
      <div className="space-y-4" data-testid="flashcards-done">
        <Panel tone="accent">
          <SectionLabel className="text-primary">Deck finished</SectionLabel>
          <div className="mt-1 text-xl font-bold tabular-nums tracking-tight text-foreground">{score}%</div>
          <p className="mt-1 text-[13px] leading-relaxed text-foreground">
            You had {known} of {CARDS.length} cold. The ones you missed are the translations that will stall you at a
            door, so run the deck again before your next shift.
          </p>
        </Panel>
        <div className="flex flex-wrap gap-2">
          <PrimaryButton onClick={() => onComplete(score)} testId="flashcards-save">Save and continue</PrimaryButton>
          <QuietButton
            onClick={() => { setIndex(0); setKnown(0); setSeen(0); setFlipped(false); }}
            testId="flashcards-again"
          >
            Run it again
          </QuietButton>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="flashcards">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>Feature to outcome</SectionLabel>
        <span className="text-xs tabular-nums text-muted-foreground">{seen + 1} of {CARDS.length}</span>
      </div>

      <div className="hf-flip-scene">
        <button
          type="button"
          aria-pressed={flipped}
          onClick={() => setFlipped((v) => !v)}
          data-testid="flashcard"
          className={cn("block w-full text-left", FOCUS)}
        >
          <div className={cn("hf-flip-inner relative min-h-[190px]", flipped && "is-flipped")}>
            {/* Front */}
            <div
              className={cn(
                "hf-flip-face rounded-2xl border border-border bg-card p-5",
                flipped && "invisible",
              )}
            >
              <Chip tone="neutral">The feature</Chip>
              <p className="mt-3 text-lg font-bold leading-snug tracking-tight text-foreground">{card.feature}</p>
              <p className="mt-3 text-xs text-muted-foreground">
                What does a household actually feel? Say it out loud, then tap to check.
              </p>
            </div>
            {/* Back */}
            <div
              className={cn(
                "hf-flip-face hf-flip-back absolute inset-0 rounded-2xl border border-primary/25 bg-primary/[0.06] p-5",
                !flipped && "invisible",
              )}
            >
              <Chip tone="info">What they feel</Chip>
              <p className="mt-3 text-[15px] font-semibold leading-snug text-foreground">{card.outcome}</p>
              <div className="mt-3 rounded-xl border border-border bg-card p-3">
                <SectionLabel>Say it like this</SectionLabel>
                <p className="mt-1 text-[13px] leading-relaxed text-foreground">{card.say}</p>
              </div>
            </div>
          </div>
        </button>
      </div>

      {flipped ? (
        <div className="flex flex-wrap gap-2">
          <PrimaryButton onClick={() => grade(true)} testId="flashcard-known">I had that</PrimaryButton>
          <QuietButton onClick={() => grade(false)} testId="flashcard-missed">I did not</QuietButton>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <QuietButton onClick={() => setFlipped(true)} testId="flashcard-flip">Show the outcome</QuietButton>
          <QuietButton onClick={onExit} testId="flashcard-exit">Leave for now</QuietButton>
        </div>
      )}
    </div>
  );
}
