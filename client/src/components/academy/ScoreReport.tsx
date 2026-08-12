// ── Coaching report ───────────────────────────────────────────────────────────
//
// What a rep sees after a role-play: the eleven dimensions, the specific
// coaching, stronger wording, and the transcript with the scored turns marked.
//
// ORDERING IS DELIBERATE
//   Coaching first, then strengths, then the dimension grid, then the
//   transcript. A rep who reads only the top of this screen should come away
//   with the two things to change, not with a number. The overall score is
//   present but small, because it is a trend line for them and nothing else.
//
// FLAGS ARE NEVER COLLAPSED
//   Compliance and ethics flags render above everything, expanded, every time.
//   They are the one part of this report that is not optional reading.

import { useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { Chip, Panel, QuietButton } from "./primitives";
import { getPersona } from "@shared/academyPersonas";
import { BAND_LABELS, DIMENSION_LABELS, UNSCORED_BEHAVIOURS, type SessionScore } from "@shared/academyScoring";
import type { RolePlaySession } from "@shared/academyRolePlay";

const OUTCOME_LABEL: Record<string, string> = {
  advanced: "They moved forward",
  polite_exit: "Clean exit",
  door_closed: "Door closed",
  walked_away: "They walked away",
  in_progress: "Ended early",
};

export default function ScoreReport({
  score, session, onRunAgain, onDone,
}: {
  score: SessionScore;
  session: RolePlaySession;
  onRunAgain?: () => void;
  onDone?: () => void;
}) {
  const [showTranscript, setShowTranscript] = useState(false);
  const persona = getPersona(score.personaId);

  return (
    <div className="space-y-4" data-testid="score-report">
      {/* Flags. Above everything, always expanded. */}
      {score.flags.length > 0 && (
        <div
          role="alert"
          data-testid="score-flags"
          className="rounded-2xl border border-destructive/30 bg-destructive/[0.06] p-4"
        >
          <SectionLabel className="text-destructive">Worth stopping on</SectionLabel>
          <ul className="mt-2 space-y-1.5">
            {score.flags.map((flag, i) => (
              <li key={i} className="text-[13px] leading-relaxed text-foreground">{flag}</li>
            ))}
          </ul>
        </div>
      )}

      <Panel testId="score-header">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <SectionLabel>{persona?.label ?? "Role-play"}</SectionLabel>
            <div className="mt-0.5 text-[15px] font-bold leading-snug text-foreground">
              {OUTCOME_LABEL[session.outcome] ?? "Session complete"}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {session.turns.filter((t) => t.role === "rep").length} turns, {score.dimensions.length} things looked at.
            </p>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-2xl font-bold tabular-nums leading-none text-foreground" data-testid="score-overall">
              {score.overall}
            </div>
            <div className="mt-0.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              your average
            </div>
          </div>
        </div>
      </Panel>

      {/* Coaching. The part that changes behaviour. */}
      <Panel tone="accent" testId="score-coaching">
        <SectionLabel className="text-primary">Work on this next</SectionLabel>
        <ol className="mt-2 space-y-2">
          {score.coaching.map((line, i) => (
            <li key={i} className="flex items-start gap-2.5 text-[13px] leading-relaxed text-foreground">
              <span
                aria-hidden="true"
                className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary text-2xs font-bold tabular-nums text-primary-foreground"
              >
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">{line}</span>
            </li>
          ))}
        </ol>
      </Panel>

      {score.strengths.length > 0 && (
        <Panel testId="score-strengths">
          <SectionLabel>What worked</SectionLabel>
          <ul className="mt-2 space-y-1.5">
            {score.strengths.map((line, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px] leading-relaxed text-foreground">
                <Check aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                <span className="min-w-0 flex-1">{line}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* Stronger wording, pulled out of the dimensions that carry one. */}
      {score.dimensions.some((d) => d.betterWording) && (
        <div data-testid="score-wording">
          <SectionLabel className="mb-1.5 px-1">Say it like this instead</SectionLabel>
          <div className="space-y-2">
            {score.dimensions.filter((d) => d.betterWording).map((d) => (
              <div key={d.dimension} className="overflow-hidden rounded-2xl border border-border bg-card">
                <div className="border-b border-border px-4 py-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {DIMENSION_LABELS[d.dimension]}
                  </span>
                </div>
                <div className="space-y-2 p-3.5">
                  <div className="rounded-xl border border-destructive/25 bg-destructive/[0.05] p-3">
                    <Chip tone="bad">Instead of</Chip>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{d.betterWording!.instead}</p>
                  </div>
                  <div className="rounded-xl border border-success/30 bg-success/[0.06] p-3">
                    <Chip tone="good">Say</Chip>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-foreground">{d.betterWording!.say}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* The eleven. */}
      <div data-testid="score-dimensions">
        <SectionLabel className="mb-1.5 px-1">The eleven</SectionLabel>
        <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
          {score.dimensions.map((d) => (
            <div key={d.dimension} className="px-4 py-3" data-testid={`score-dimension-${d.dimension}`}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] font-semibold text-foreground">{DIMENSION_LABELS[d.dimension]}</span>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[13px] font-bold tabular-nums text-foreground">{d.score}</span>
                  <Chip tone={d.band === "strong" ? "good" : d.band === "developing" ? "warn" : "bad"}>
                    {BAND_LABELS[d.band]}
                  </Chip>
                </div>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-500 ease-out",
                    d.band === "strong" ? "bg-success" : d.band === "developing" ? "bg-warning" : "bg-destructive",
                  )}
                  style={{ width: `${d.score}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{d.note}</p>
            </div>
          ))}
        </div>
      </div>

      {/* The promise, stated on the screen where it matters. */}
      <div className="rounded-2xl border border-border bg-secondary/40 p-4" data-testid="score-unscored">
        <SectionLabel>Not scored here, on purpose</SectionLabel>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {UNSCORED_BEHAVIOURS.map((b) => b.replace(/_/g, " ")).join(", ")}. Pushing harder can never raise a number on
          this page. Pressure shows up only as a deduction and a note.
        </p>
      </div>

      {/* Transcript, collapsed by default. */}
      <div>
        <QuietButton
          onClick={() => setShowTranscript((v) => !v)}
          pressed={showTranscript}
          testId="score-transcript-toggle"
          full
        >
          {showTranscript ? "Hide the transcript" : "Read the transcript"}
        </QuietButton>
        {showTranscript && (
          <div className="mt-2 space-y-2.5 rounded-2xl border border-border bg-card p-4" data-testid="score-transcript">
            {session.turns.map((turn, i) => (
              <div key={i} className={cn("max-w-[85%]", turn.role === "rep" && "ml-auto")}>
                <div className="mb-0.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {turn.role === "rep" ? "You" : persona?.name ?? "Customer"}
                </div>
                <div
                  className={cn(
                    "rounded-2xl border px-3 py-2 text-[13px] leading-relaxed",
                    turn.role === "rep"
                      ? "rounded-tr-sm border-primary/25 bg-primary/[0.07] text-foreground"
                      : "rounded-tl-sm border-border bg-secondary/60 text-foreground",
                  )}
                >
                  {turn.text}
                </div>
                {turn.role === "rep" && turn.violations.length > 0 && (
                  <div className="mt-1 space-y-1">
                    {turn.violations.map((v, vi) => (
                      <p key={vi} className="text-[11px] leading-snug text-destructive">{v.message}</p>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2 pb-2">
        {onRunAgain && <QuietButton onClick={onRunAgain} testId="score-run-again">Run it again</QuietButton>}
        {onDone && <QuietButton onClick={onDone} testId="score-done">Back to practice</QuietButton>}
      </div>
    </div>
  );
}
