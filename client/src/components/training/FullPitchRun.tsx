// ── Full Pitch Run — the whole pitch as one rehearsal, not fragments ──────────
//
// The lesson list teaches the pitch in pieces; nothing made a rep perform the
// COMPLETE arc under door conditions. This is that: a staged session in the
// shape field reps already know from Duolingo — one thing per screen, a thin
// progress bar, an exit that never traps you, feedback anchored at the bottom,
// and a stat-tile finish.
//
// Four stages:
//   1. The four beats, one screen each: name, time budget, a sayable script
//      line, and why the beat works. Study pass, fast.
//   2. The full run: record all four beats as ONE take against the 30-second
//      door budget, on the existing PitchRecorder (playback teaches delivery).
//   3. The door talks back: three random objections from the canonical
//      taxonomy. The rep answers OUT LOUD before revealing the counter, then
//      self-grades. Honest grading is the drill; nothing is submitted.
//   4. Stat tiles + run-it-again. Repetition is the product.
//
// All strings live HERE, composed for speech: one breath per line, no em
// dashes anywhere. The objection cues come from the shared taxonomy so this
// screen can never drift from the drill decks' vocabulary.

import { useMemo, useState } from "react";
import { Check, ChevronRight, X } from "lucide-react";
import { FOCUS } from "@/lib/a11y";
import { cn } from "@/lib/utils";
import { SectionLabel } from "@/components/ui/page-scaffold";
import PitchRecorder from "@/components/training/PitchRecorder";
import { OBJECTION_TAXONOMY, type ObjectionKey } from "@shared/trainingObjections";

// ── The four beats ────────────────────────────────────────────────────────────
// Structure from the curriculum's pitch skeleton (m3): hook, credibility,
// value, micro-commitment, in that order, in half a minute.

type Beat = {
  name: string;
  seconds: number;
  script: string;
  why: string;
};

const BEATS: readonly Beat[] = [
  {
    name: "The hook",
    seconds: 5,
    script:
      "You've seen the orange flags along the road? I'm with the fiber build. That's what those are.",
    why:
      "A stranger gets five seconds. Tie yourself to something they can see from the porch and you stop being a salesman and start being the guy from the build.",
  },
  {
    name: "Credibility",
    seconds: 5,
    script:
      "We connected six houses on Maple last week. The corner house is already running on it.",
    why:
      "A million customers nationwide moves nobody. Three houses on this street moves almost everybody. Name real streets and real counts.",
  },
  {
    name: "Value",
    seconds: 15,
    script:
      "Evenings, when everyone's on it at once, does it hold up? Most folks on this street are paying about 30 a month more than they need to for buffering.",
    why:
      "Start at their pain, not your product. One question, then one specific number. Specifics signal real calculation and stick in memory.",
  },
  {
    name: "Micro-commitment",
    seconds: 5,
    script:
      "I've got Thursday at 10 or Saturday at 9. Which fits your week better?",
    why:
      "Never ask whether. Ask which. A small yes is a down payment on a bigger one, and two install slots is the smallest yes on the porch.",
  },
];

// ── One-breath counters, keyed to the canonical taxonomy ─────────────────────
// Every ObjectionKey has a counter, so the random draw can never land on a
// cue this screen cannot answer.

const COUNTERS: Readonly<Record<ObjectionKey, string>> = {
  not_interested:
    "Totally fair. Most of your neighbors said the same thing right before they saw the number. Thirty seconds?",
  happy_provider:
    "That's great to hear. The only reason we're out here is that the infrastructure finally changed. Thirty seconds and you'll know if it matters.",
  price:
    "Fair. Before we call it expensive, what's the bill now? Most folks on this street guess twenty low.",
  spouse:
    "Totally fair. We can push the install out so you two can talk it over. If she's home tonight I can swing back at 7 for five minutes, and a no then is a fine answer.",
  think_about_it:
    "Sure. Usually that means the price or the switching hassle. Which one is it for you?",
  too_busy:
    "Perfect. I only need the busy version: thirty seconds, then I'm gone either way.",
  scam:
    "Good instinct. Here's my badge, and the install trucks are two streets over. Don't sign anything today; just check the number.",
  bad_experience:
    "I hear you. What happened? Then listen to the whole story before you say one more word.",
  competitor_fiber:
    "Nice. What are you paying for what speed? If I can't beat it, I'll tell you to keep it.",
  renter:
    "Even easier. There's no equipment to return and it moves with you. Who handles the internet, you or the landlord?",
  no_card:
    "Smart. You don't need one today. I'm just showing you the number so you can compare bills.",
  leave_something:
    "Happy to. And the thirty-second version is faster than reading it. Evenings, does your internet hold up?",
  already_have:
    "Fine is what cable feels like at noon. Run a speed test at 7 tonight and I'll swing back tomorrow for the number.",
  hoa:
    "Understood, and I follow the HOA rules here. One question and I'm gone: evenings, does the internet keep up?",
};

const OBJECTION_ROUNDS = 3;

/** Fisher-Yates over a copy; returns the first n entries. */
function drawObjections(n: number) {
  const pool = [...OBJECTION_TAXONOMY];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

const FULL_SCRIPT = BEATS.map((b) => b.script).join(" ");

// Stage order: one index walks beats, then the recording, then objections,
// then the finish. Deriving everything from one number keeps the progress bar
// honest by construction.
const TOTAL_STAGES = BEATS.length + 1 + OBJECTION_ROUNDS + 1;

export default function FullPitchRun({ onBack }: { onBack: () => void }) {
  const [stage, setStage] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [hadIt, setHadIt] = useState<boolean[]>([]);
  // Drawn once per run; "Run it again" bumps the seed for a fresh draw.
  const [runSeed, setRunSeed] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const objections = useMemo(() => drawObjections(OBJECTION_ROUNDS), [runSeed]);

  const recordStage = BEATS.length;
  const firstObjection = recordStage + 1;
  const doneStage = firstObjection + OBJECTION_ROUNDS;

  const advance = () => { setRevealed(false); setStage((s) => Math.min(s + 1, doneStage)); };

  return (
    <div className="space-y-5" data-testid="full-pitch-run">
      {/* Session chrome: exit + progress. The bar moves every screen, and the
          X always works — a drill that traps you is a drill you never reopen. */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Exit the pitch run"
          data-testid="pitch-run-exit"
          className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground", FOCUS)}
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
        <div
          className="h-2 flex-1 overflow-hidden rounded-full bg-secondary"
          role="progressbar"
          aria-valuenow={stage + 1}
          aria-valuemin={1}
          aria-valuemax={TOTAL_STAGES}
          aria-label={`Step ${stage + 1} of ${TOTAL_STAGES}`}
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${((stage + 1) / TOTAL_STAGES) * 100}%` }}
          />
        </div>
      </div>

      {stage < recordStage && (() => {
        const beat = BEATS[stage];
        return (
          <div className="space-y-4" data-testid={`pitch-run-beat-${stage}`}>
            <div>
              <SectionLabel>Beat {stage + 1} of {BEATS.length} · about {beat.seconds} seconds</SectionLabel>
              <h2 className="mt-1 text-xl font-bold tracking-tight text-foreground">{beat.name}</h2>
            </div>
            {/* The sayable line gets the visual weight; it is the thing to
                memorize. The why is context, quieter on purpose. */}
            <div className="rounded-2xl border border-primary/25 bg-primary/[0.06] p-4">
              <SectionLabel className="text-primary">Say it like this</SectionLabel>
              <p className="mt-2 text-[17px] font-semibold leading-snug text-foreground">"{beat.script}"</p>
            </div>
            <div className="rounded-2xl border border-border bg-card p-4">
              <div className="flex items-center gap-2">
                
                <SectionLabel>Why it works</SectionLabel>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{beat.why}</p>
            </div>
            <button
              type="button"
              onClick={advance}
              data-testid="pitch-run-continue"
              className={cn("inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground transition-transform active:scale-[.98]", FOCUS)}
            >
              {stage + 1 < BEATS.length ? "Next beat" : "Put it together"} <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        );
      })()}

      {stage === recordStage && (
        <div className="space-y-4" data-testid="pitch-run-record">
          <div>
            <SectionLabel>The full run</SectionLabel>
            <h2 className="mt-1 text-xl font-bold tracking-tight text-foreground">All four beats. One take. Thirty seconds.</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A door gives you about half a minute. Record the whole pitch, then play it back and
              listen for the beat you rushed.
            </p>
          </div>
          <PitchRecorder prompt={FULL_SCRIPT} persistKey="full-pitch-run" title="Record the full pitch" />
          <button
            type="button"
            onClick={advance}
            data-testid="pitch-run-continue"
            className={cn("inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground transition-transform active:scale-[.98]", FOCUS)}
          >
            The door talks back <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {stage >= firstObjection && stage < doneStage && (() => {
        const round = stage - firstObjection;
        const objection = objections[round];
        return (
          <div className="space-y-4" data-testid={`pitch-run-objection-${round}`}>
            <SectionLabel>The door talks back · {round + 1} of {OBJECTION_ROUNDS}</SectionLabel>
            {/* The homeowner's line, big, in their voice. The rep's job is to
                answer OUT LOUD before looking. Reading a counter is easy;
                producing one with a stranger staring at you is the skill. */}
            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="flex items-center gap-2">
                
                <SectionLabel>{objection.chip}</SectionLabel>
              </div>
              <p className="mt-2 text-xl font-bold leading-snug text-foreground">"{objection.cue}"</p>
            </div>
            {!revealed ? (
              <>
                <div className="flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/[0.06] p-3 text-sm text-foreground">
                  
                  Answer out loud first. Then check the counter.
                </div>
                <button
                  type="button"
                  onClick={() => setRevealed(true)}
                  data-testid="pitch-run-reveal"
                  className={cn("inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground transition-transform active:scale-[.98]", FOCUS)}
                >
                  Show the counter
                </button>
              </>
            ) : (
              <>
                <div className="rounded-2xl border border-primary/25 bg-primary/[0.06] p-4">
                  <SectionLabel className="text-primary">One breath</SectionLabel>
                  <p className="mt-2 text-[15px] font-semibold leading-snug text-foreground">"{COUNTERS[objection.key]}"</p>
                </div>
                {/* Self-grade. Honest grading is what makes the rep better;
                    there is nothing to game because nothing is submitted. */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => { setHadIt((h) => [...h, true]); advance(); }}
                    data-testid="pitch-run-had-it"
                    className={cn("inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-success/30 bg-success/8 px-4 text-sm font-semibold text-success transition-transform active:scale-[.98] dark:text-emerald-400", FOCUS)}
                  >
                    <Check className="h-4 w-4" aria-hidden="true" /> Had it
                  </button>
                  <button
                    type="button"
                    onClick={() => { setHadIt((h) => [...h, false]); advance(); }}
                    data-testid="pitch-run-needs-work"
                    className={cn("inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-border bg-secondary px-4 text-sm font-semibold text-foreground transition-transform active:scale-[.98]", FOCUS)}
                  >
                     Needs work
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })()}

      {stage === doneStage && (
        <div className="space-y-4" data-testid="pitch-run-done">
          <div className="rounded-2xl border border-success/25 bg-success/[0.07] p-5 text-center">
            
            <h2 className="mt-2 text-xl font-bold tracking-tight text-foreground">Full run complete</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The pitch only feels like this smooth at a door after it is boring in practice.
            </p>
          </div>
          <dl className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl border border-border bg-card py-3">
              <dt className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Beats</dt>
              <dd className="text-lg font-bold tabular-nums text-foreground">{BEATS.length}</dd>
            </div>
            <div className="rounded-xl border border-border bg-card py-3">
              <dt className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Objections</dt>
              <dd className="text-lg font-bold tabular-nums text-foreground">{OBJECTION_ROUNDS}</dd>
            </div>
            <div className="rounded-xl border border-border bg-card py-3" data-testid="pitch-run-score">
              <dt className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Had it</dt>
              <dd className="text-lg font-bold tabular-nums text-foreground">{hadIt.filter(Boolean).length} of {OBJECTION_ROUNDS}</dd>
            </div>
          </dl>
          {hadIt.some((h) => !h) && (
            <p className="text-center text-xs text-muted-foreground">
              The ones you missed live in the drill deck on Today. They will come back until they are yours.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => { setStage(0); setRevealed(false); setHadIt([]); setRunSeed((s) => s + 1); }}
              data-testid="pitch-run-again"
              className={cn("inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition-transform active:scale-[.98]", FOCUS)}
            >
               Run it again
            </button>
            <button
              type="button"
              onClick={onBack}
              data-testid="pitch-run-back"
              className={cn("inline-flex min-h-12 items-center justify-center rounded-xl border border-border bg-secondary px-4 text-sm font-semibold text-foreground transition-transform active:scale-[.98]", FOCUS)}
            >
              Back to training
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
