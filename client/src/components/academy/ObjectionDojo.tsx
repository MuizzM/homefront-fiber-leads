// ── Objection dojo ────────────────────────────────────────────────────────────
//
// The ten objections a residential fiber rep actually hears, each as a drill:
// read the cue, say your answer OUT LOUD before revealing anything, then compare
// against the weak / better / excellent ladder and the technique behind it.
//
// ANSWER-BEFORE-REVEAL IS THE WHOLE MECHANIC
//   Reading a good answer teaches recognition. Producing one, badly, and then
//   reading a good one teaches production. The reveal is gated behind an
//   explicit tap for exactly that reason, and the drill says so.
//
// The technique notes are the curriculum: every entry names which ethical
// technique it uses, and the closed list has no room for pressure dressed up
// as a technique.

import { useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { BackLink, Chip, Panel, PrimaryButton, QuietButton, WordingLadderCard } from "./primitives";
import {
  ACADEMY_OBJECTIONS, ETHICAL_TECHNIQUES, TECHNIQUE_LABELS, TECHNIQUE_NOTES,
  type AcademyObjection,
} from "@shared/academyObjections";
import { personasRaising } from "@shared/academyPersonas";
import type { PersonaId } from "@shared/academyPersonas";

export default function ObjectionDojo({
  focusKey, completedKeys, onComplete, onPractise,
}: {
  /** Opens straight into one objection, from a path activity or a deep link. */
  focusKey?: string;
  completedKeys: Set<string>;
  onComplete?: (objectionKey: string) => void;
  /** Jump into a live role-play against a persona who raises this objection. */
  onPractise?: (personaId: PersonaId) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(focusKey ?? null);
  const [showTechniques, setShowTechniques] = useState(false);
  const open = openKey ? ACADEMY_OBJECTIONS.find((o) => o.key === openKey) : undefined;

  if (open) {
    return (
      <ObjectionDrill
        objection={open}
        onBack={() => setOpenKey(null)}
        onComplete={onComplete ? () => onComplete(open.key) : undefined}
        onPractise={onPractise}
      />
    );
  }

  return (
    <div className="space-y-4" data-testid="objection-dojo">
      <Panel tone="accent">
        <SectionLabel className="text-primary">How to use this</SectionLabel>
        <p className="mt-1 text-[13px] leading-relaxed text-foreground">
          Open one, read the cue, and say your answer out loud before you reveal anything. The reveal is behind a tap on
          purpose. Reading a good answer teaches you to recognise one; producing a bad one first is what teaches you to
          say a good one.
        </p>
      </Panel>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-3 px-1">
          <SectionLabel>The ten you will actually hear</SectionLabel>
          <span className="text-xs tabular-nums text-muted-foreground">
            {ACADEMY_OBJECTIONS.filter((o) => completedKeys.has(o.key)).length} of {ACADEMY_OBJECTIONS.length}
          </span>
        </div>
        <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
          {ACADEMY_OBJECTIONS.map((objection) => {
            const done = completedKeys.has(objection.key);
            return (
              <button
                key={objection.key}
                type="button"
                onClick={() => setOpenKey(objection.key)}
                data-testid={`objection-${objection.key}`}
                className={cn(
                  "flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary/50",
                  FOCUS,
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] font-bold",
                    done ? "border-success bg-success text-white" : "border-border bg-background text-muted-foreground",
                  )}
                >
                  {done && <Check className="h-3.5 w-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold leading-snug text-foreground">
                    &ldquo;{objection.cue}&rdquo;
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {objection.techniques.map((t) => TECHNIQUE_LABELS[t]).join(", ")}
                  </span>
                </span>
                <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">&rsaquo;</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* The technique reference, collapsed. Progressive disclosure: a rep
          drilling objections does not need the theory in front of them. */}
      <div>
        <QuietButton
          onClick={() => setShowTechniques((v) => !v)}
          pressed={showTechniques}
          testId="objection-techniques-toggle"
          full
        >
          {showTechniques ? "Hide the techniques" : "The seven ethical techniques"}
        </QuietButton>
        {showTechniques && (
          <div className="mt-2 space-y-2" data-testid="objection-techniques">
            {ETHICAL_TECHNIQUES.map((technique) => (
              <Panel key={technique}>
                <SectionLabel>{TECHNIQUE_LABELS[technique]}</SectionLabel>
                <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{TECHNIQUE_NOTES[technique]}</p>
              </Panel>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ObjectionDrill({
  objection, onBack, onComplete, onPractise,
}: {
  objection: AcademyObjection;
  onBack: () => void;
  onComplete?: () => void;
  onPractise?: (personaId: PersonaId) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const personas = personasRaising((objection.taxonomyKey ?? "not_interested") as any);

  return (
    <div className="space-y-4" data-testid={`objection-drill-${objection.key}`}>
      <BackLink label="All objections" onClick={onBack} />

      <div>
        <SectionLabel>They say</SectionLabel>
        <h2 className="mt-1 text-lg font-bold leading-snug tracking-tight text-foreground">
          &ldquo;{objection.cue}&rdquo;
        </h2>
      </div>

      <Panel>
        <SectionLabel>What is really going on</SectionLabel>
        <p className="mt-1 text-[13px] leading-relaxed text-foreground">{objection.whatItMeans}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {objection.techniques.map((t) => <Chip key={t} tone="info">{TECHNIQUE_LABELS[t]}</Chip>)}
        </div>
      </Panel>

      {!revealed ? (
        <Panel tone="accent" testId="objection-answer-first">
          <SectionLabel className="text-primary">Say your answer out loud first</SectionLabel>
          <p className="mt-1 text-[13px] leading-relaxed text-foreground">
            Out loud, at door pace, right now. Then tap below. Doing it in your head does not count, and reading the
            good answer before you have produced a bad one is the reason most reps still fumble this at a real door.
          </p>
          <div className="mt-3">
            <PrimaryButton onClick={() => setRevealed(true)} testId="objection-reveal">
              I said it. Show me the ladder
            </PrimaryButton>
          </div>
        </Panel>
      ) : (
        <>
          <div>
            <SectionLabel className="mb-1.5 px-1">Three ways to answer it</SectionLabel>
            <WordingLadderCard ladder={objection.ladder} testId={`objection-ladder-${objection.key}`} />
          </div>

          <Panel tone="warn" testId="objection-trap">
            <SectionLabel className="text-warning">The trap</SectionLabel>
            <p className="mt-1 text-[13px] leading-relaxed text-foreground">{objection.trap}</p>
          </Panel>

          {objection.reopener && (
            <Panel testId="objection-reopener">
              <SectionLabel>The question that reopens it</SectionLabel>
              <p className="mt-1 text-[13px] leading-relaxed text-foreground">{objection.reopener}</p>
            </Panel>
          )}

          <div className="flex flex-wrap gap-2 pb-2">
            {onComplete && (
              <PrimaryButton onClick={onComplete} testId="objection-complete">Mark this drilled</PrimaryButton>
            )}
            {onPractise && personas.length > 0 && (
              <QuietButton onClick={() => onPractise(personas[0].id)} testId="objection-practise">
                Practise on {personas[0].name}
              </QuietButton>
            )}
            <QuietButton onClick={onBack} testId="objection-back">Back to the list</QuietButton>
          </div>
        </>
      )}
    </div>
  );
}
