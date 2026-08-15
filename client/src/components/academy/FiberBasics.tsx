// ── Fiber 101 ─────────────────────────────────────────────────────────────────
//
// The underground journey and the glossary, from shared/academyFiberBasics.ts.
// Each section renders two ways:
//
//   GUIDED (an onComplete handler is present, i.e. opened as a path activity):
//     the journey is a six-step walk with one step on screen at a time, and the
//     glossary is an answer-before-reveal drill: read the term, say what it is
//     out loud, THEN reveal. Same mechanic as the objection dojo, for the same
//     reason: production teaches, recognition only reassures.
//
//   BROWSE (no handler, i.e. opened from Reference):
//     everything on screen at once, searchable, scannable one-handed on a porch.
//
// Mid-drill position autosaves through the same activity-state plumbing every
// other activity uses, so a rep interrupted at term 12 resumes at term 12.

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { Chip, Panel, PrimaryButton, QuietButton } from "./primitives";
import { useActivityAutosave } from "@/lib/useAcademy";
import {
  FIBER_GLOSSARY, GLOSSARY_CATEGORIES, GLOSSARY_CATEGORY_TITLES, UNDERGROUND_JOURNEY,
  searchGlossary, type GlossaryCategory, type GlossaryTerm, type JourneyStep,
} from "@shared/academyFiberBasics";

export type FiberBasicsState = { pos: number };

export default function FiberBasics({
  section, activityId = null, resume = null, onComplete,
}: {
  section: "journey" | "glossary" | "all";
  activityId?: string | null;
  resume?: FiberBasicsState | null;
  onComplete?: () => void;
}) {
  const [tab, setTab] = useState<"journey" | "glossary">(section === "glossary" ? "glossary" : "journey");
  const guided = !!onComplete;
  const active = section === "all" ? tab : section;

  return (
    <div className="space-y-4" data-testid="fiber-basics">
      {section === "all" && (
        <div className="flex gap-2">
          <QuietButton pressed={tab === "journey"} onClick={() => setTab("journey")} testId="fiber-tab-journey">
            The journey
          </QuietButton>
          <QuietButton pressed={tab === "glossary"} onClick={() => setTab("glossary")} testId="fiber-tab-glossary">
            The glossary
          </QuietButton>
        </div>
      )}

      {active === "journey" && (
        guided
          ? <JourneyWalk activityId={activityId} resume={resume} onComplete={onComplete!} />
          : <JourneyList />
      )}
      {active === "glossary" && (
        guided
          ? <GlossaryDrill activityId={activityId} resume={resume} onComplete={onComplete!} />
          : <GlossaryBrowse />
      )}
    </div>
  );
}

// ── The journey, one step at a time ───────────────────────────────────────────

function JourneyWalk({ activityId, resume, onComplete }: {
  activityId: string | null;
  resume: FiberBasicsState | null;
  onComplete: () => void;
}) {
  const clamp = (n: number) => Math.min(Math.max(n, 0), UNDERGROUND_JOURNEY.length - 1);
  const [pos, setPos] = useState(() => clamp(resume?.pos ?? 0));
  useActivityAutosave(activityId, useMemo(() => ({ pos }), [pos]));

  const step = UNDERGROUND_JOURNEY[pos];
  const last = pos === UNDERGROUND_JOURNEY.length - 1;

  return (
    <div className="space-y-4" data-testid="fiber-journey-walk">
      <ProgressLine label={`Step ${pos + 1} of ${UNDERGROUND_JOURNEY.length}`} done={pos + 1} total={UNDERGROUND_JOURNEY.length} />
      <StepCard step={step} />
      <div className="flex flex-wrap gap-2">
        <QuietButton onClick={() => setPos((p) => clamp(p - 1))} disabled={pos === 0} testId="fiber-journey-back">
          Back
        </QuietButton>
        {last ? (
          <PrimaryButton onClick={onComplete} testId="fiber-journey-done">I can tell this story</PrimaryButton>
        ) : (
          <PrimaryButton onClick={() => setPos((p) => clamp(p + 1))} testId="fiber-journey-next">Next step</PrimaryButton>
        )}
      </div>
    </div>
  );
}

function JourneyList() {
  return (
    <div className="space-y-3" data-testid="fiber-journey-list">
      <p className="px-1 text-[13px] leading-relaxed text-muted-foreground">
        The trip a bit of light makes to reach a living room, in the order it happens on a real street. A rep who can
        walk a homeowner from the hut to the wall sounds like someone who knows the build, because at that point they do.
      </p>
      {UNDERGROUND_JOURNEY.map((step) => <StepCard key={step.step} step={step} />)}
    </div>
  );
}

function StepCard({ step }: { step: JourneyStep }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4" data-testid={`fiber-step-${step.step}`}>
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary text-sm font-bold tabular-nums text-primary-foreground"
        >
          {step.step}
        </span>
        <h3 className="text-[15px] font-bold leading-snug tracking-tight text-foreground">{step.title}</h3>
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-foreground">{step.what}</p>
      <div className="mt-3 rounded-xl bg-secondary/60 p-3">
        <SectionLabel>The picture</SectionLabel>
        <p className="mt-1 text-[13px] leading-relaxed text-foreground">{step.analogy}</p>
      </div>
      <div className="mt-2 rounded-xl border border-primary/25 bg-primary/[0.06] p-3">
        <SectionLabel className="text-primary">At the door</SectionLabel>
        <p className="mt-1 text-[13px] leading-relaxed text-foreground">{step.atTheDoor}</p>
      </div>
    </div>
  );
}

// ── The glossary, drilled ─────────────────────────────────────────────────────

function GlossaryDrill({ activityId, resume, onComplete }: {
  activityId: string | null;
  resume: FiberBasicsState | null;
  onComplete: () => void;
}) {
  const clamp = (n: number) => Math.min(Math.max(n, 0), FIBER_GLOSSARY.length - 1);
  const [pos, setPos] = useState(() => clamp(resume?.pos ?? 0));
  const [revealed, setRevealed] = useState(false);
  useActivityAutosave(activityId, useMemo(() => ({ pos }), [pos]));

  const term = FIBER_GLOSSARY[pos];
  const last = pos === FIBER_GLOSSARY.length - 1;

  function next() {
    setRevealed(false);
    setPos((p) => clamp(p + 1));
  }

  return (
    <div className="space-y-4" data-testid="fiber-glossary-drill">
      <ProgressLine label={`Term ${pos + 1} of ${FIBER_GLOSSARY.length}`} done={pos + 1} total={FIBER_GLOSSARY.length} />

      <div className="rounded-2xl border border-border bg-card p-4">
        <Chip tone="neutral">{GLOSSARY_CATEGORY_TITLES[term.category]}</Chip>
        <h3 className="mt-2 text-lg font-bold leading-snug tracking-tight text-foreground">{term.term}</h3>

        {!revealed ? (
          <div className="mt-3 rounded-xl border border-primary/25 bg-primary/[0.06] p-3" data-testid="fiber-term-prompt">
            <SectionLabel className="text-primary">Say it before you see it</SectionLabel>
            <p className="mt-1 text-[13px] leading-relaxed text-foreground">
              Out loud, in your own words: what is it, and what picture would you hand a homeowner? Then reveal.
            </p>
            <div className="mt-3">
              <PrimaryButton onClick={() => setRevealed(true)} testId="fiber-term-reveal">Show me</PrimaryButton>
            </div>
          </div>
        ) : (
          <div className="mt-3 space-y-2" data-testid="fiber-term-reveal-body">
            <p className="text-[13px] leading-relaxed text-foreground">{term.plain}</p>
            <div className="rounded-xl bg-secondary/60 p-3">
              <SectionLabel>The picture</SectionLabel>
              <p className="mt-1 text-[13px] leading-relaxed text-foreground">{term.analogy}</p>
            </div>
            {term.atTheDoor && (
              <div className="rounded-xl border border-primary/25 bg-primary/[0.06] p-3">
                <SectionLabel className="text-primary">At the door</SectionLabel>
                <p className="mt-1 text-[13px] leading-relaxed text-foreground">{term.atTheDoor}</p>
              </div>
            )}
            <div className="pt-1">
              {last ? (
                <PrimaryButton onClick={onComplete} testId="fiber-glossary-done">That is all of them. Done</PrimaryButton>
              ) : (
                <PrimaryButton onClick={next} testId="fiber-term-next">Next term</PrimaryButton>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function GlossaryBrowse() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<GlossaryCategory | null>(null);

  const results = useMemo(() => {
    const found = searchGlossary(query);
    return category ? found.filter((t) => t.category === category) : found;
  }, [query, category]);

  return (
    <div className="space-y-3" data-testid="fiber-glossary-browse">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search a term, a word, an analogy"
        aria-label="Search the glossary"
        data-testid="fiber-glossary-search"
        className={cn(
          "min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground",
          FOCUS,
        )}
      />
      <div className="flex flex-wrap gap-2">
        <QuietButton pressed={category === null} onClick={() => setCategory(null)} testId="fiber-category-all">
          All
        </QuietButton>
        {GLOSSARY_CATEGORIES.map((c) => (
          <QuietButton key={c} pressed={category === c} onClick={() => setCategory((cur) => (cur === c ? null : c))} testId={`fiber-category-${c}`}>
            {GLOSSARY_CATEGORY_TITLES[c]}
          </QuietButton>
        ))}
      </div>
      {results.length === 0 && (
        <Panel testId="fiber-glossary-empty">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Nothing matches that. Try a shorter word, or clear the search.
          </p>
        </Panel>
      )}
      <div className="space-y-2">
        {results.map((term) => <TermCard key={term.id} term={term} />)}
      </div>
    </div>
  );
}

function TermCard({ term }: { term: GlossaryTerm }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4" data-testid={`fiber-term-${term.id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[15px] font-bold leading-snug tracking-tight text-foreground">{term.term}</h3>
        <Chip tone="neutral">{GLOSSARY_CATEGORY_TITLES[term.category]}</Chip>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-foreground">{term.plain}</p>
      <div className="mt-2 rounded-xl bg-secondary/60 p-3">
        <SectionLabel>The picture</SectionLabel>
        <p className="mt-1 text-[13px] leading-relaxed text-foreground">{term.analogy}</p>
      </div>
      {term.atTheDoor && (
        <div className="mt-2 rounded-xl border border-primary/25 bg-primary/[0.06] p-3">
          <SectionLabel className="text-primary">At the door</SectionLabel>
          <p className="mt-1 text-[13px] leading-relaxed text-foreground">{term.atTheDoor}</p>
        </div>
      )}
    </div>
  );
}

// ── Shared ────────────────────────────────────────────────────────────────────

function ProgressLine({ label, done, total }: { label: string; done: number; total: number }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 px-1">
        <span className="text-xs font-semibold tabular-nums text-muted-foreground">{label}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${Math.round((done / total) * 100)}%` }}
        />
      </div>
    </div>
  );
}
