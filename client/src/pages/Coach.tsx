// ── Coach — the field coaching engine ────────────────────────────────────────
// Thirty seconds at a time: a 2-minute pre-knock warmup, a 30-second card
// between doors, a 5-minute post-shift debrief, and a deterministic "what to
// say next" lookup — all offline-first, all re-cut from the same curriculum
// the Library (Training.tsx) teaches. This page NEVER shows connectivity:
// the deck comes from the persisted snapshot or the bundled corpus, grades
// ride the trainingReviewQueue outbox, and the numbers stay honest.
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Zap, MessageSquare, BookOpen, Flame } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { PageHeader, SectionLabel } from "@/components/ui/page-scaffold";
import { Skeleton } from "@/components/ui/skeleton";
import { ModeStrip } from "@/components/training/ModeStrip";
import { FlashcardDeck } from "@/components/training/FlashcardDeck";
import { WhatNextSheet } from "@/components/training/WhatNextSheet";
import { LadderBar } from "@/components/training/LadderBar";
import { DebriefCard } from "@/components/training/DebriefCard";
import {
  useDueCards,
  useRecordReviews,
  useCoachSummary,
  type DeckMode,
} from "@/lib/useTrainingEngine";
import { cardsByStage, type DrillCard } from "@shared/trainingCards";
import type { Grade } from "@shared/trainingSchedule";

function hashQueryMode(): DeckMode | null {
  const raw = new URLSearchParams(window.location.hash.split("?")[1] || "").get("mode");
  return raw === "warmup" || raw === "refresher" || raw === "debrief" ? raw : null;
}

/** Refresher is ONE card between doors — due first, then new, so a rep with a
 *  clear pile still gets the 30-second rep. */
function refresherDeck(due: DrillCard[], newCards: DrillCard[]): DrillCard[] {
  return [...due, ...newCards].slice(0, 3);
}

/** Debrief is the objection gauntlet when nothing is due: 5 objection cards
 *  rotated deterministically by the day-of-year (no RNG, offline-safe). */
function debriefDeck(due: DrillCard[]): DrillCard[] {
  if (due.length > 0) return due.slice(0, 10);
  const gauntlet = cardsByStage("objection");
  if (gauntlet.length <= 5) return gauntlet;
  const start = Math.floor(Date.now() / 86_400_000) % gauntlet.length;
  return Array.from({ length: 5 }, (_, i) => gauntlet[(start + i) % gauntlet.length]);
}

export default function Coach() {
  const [, navigate] = useLocation();
  const [mode, setMode] = useState<DeckMode | null>(() => hashQueryMode());
  const [whatNextOpen, setWhatNextOpen] = useState(false);
  const [deckRunCount, setDeckRunCount] = useState(0);
  const [debriefDone, setDebriefDone] = useState(false);

  const deck = useDueCards();
  const { recordReview } = useRecordReviews();
  const { summary, isLoading: summaryLoading } = useCoachSummary();

  const cards = useMemo(() => {
    switch (mode) {
      case "warmup":
        return [...deck.due, ...deck.newCards].slice(0, 12);
      case "refresher":
        return refresherDeck(deck.due, deck.newCards);
      case "debrief":
        return debriefDeck(deck.due);
      default:
        return [];
    }
  }, [mode, deck.due, deck.newCards]);

  const onGrade = (card: DrillCard, grade: Grade, _m: DeckMode) => {
    recordReview(card, grade);
    setDeckRunCount((n) => n + 1);
  };

  // ── Deck runner takes the whole screen ─────────────────────────────────────
  if (mode) {
    if (deck.isLoading) {
      return (
        <div className="min-h-full bg-background pb-24">
          <div className="mx-auto w-full max-w-lg px-4 pt-5" role="status" aria-label="Loading your deck">
            <Skeleton className="h-[240px] w-full rounded-2xl" />
            <Skeleton className="mt-4 h-12 w-full rounded-xl" />
          </div>
        </div>
      );
    }
    if (mode === "debrief" && debriefDone) {
      return (
        <div className="min-h-full bg-background pb-24">
          <div className="mx-auto w-full max-w-lg px-4 pt-5">
            <DebriefCard reviewedCount={deckRunCount} onDone={() => { setDebriefDone(false); setMode(null); }} />
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-full bg-background pb-24">
        <FlashcardDeck
          cards={cards}
          mode={mode}
          onGrade={onGrade}
          onExit={() => setMode(null)}
          onDone={() => {
            if (mode === "debrief") setDebriefDone(true);
            else if (mode === "warmup") navigate("/today");
            else setMode(null);
          }}
        />
      </div>
    );
  }

  // ── Coach home ─────────────────────────────────────────────────────────────
  return (
    <div className="min-h-full bg-background pb-24">
      <div className="mx-auto w-full max-w-lg px-4 pt-5">
        <PageHeader icon={Zap} title="Coach" subtitle="Thirty seconds at a time." />

        {/* Due hero: N cards due · M-day streak — honest numbers, no confetti. */}
        <div className="mt-4 rounded-2xl border border-border bg-card p-5" data-testid="coach-hero">
          {summaryLoading ? (
            <div role="status" aria-label="Loading coach summary">
              <Skeleton className="h-7 w-40" />
              <Skeleton className="mt-2 h-4 w-56" />
            </div>
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-[27px] font-bold tabular-nums leading-none text-foreground" data-testid="coach-due-count">
                  {summary.dueCount + summary.newCount}
                </span>
                <span className="text-sm-minus text-muted-foreground">
                  card{summary.dueCount + summary.newCount === 1 ? "" : "s"} to drill
                  {summary.newCount > 0 && ` · ${summary.newCount} new`}
                </span>
              </div>
              {summary.streakDays > 0 && (
                <div className="mt-1.5 inline-flex items-center gap-1.5 text-sm-minus text-muted-foreground" data-testid="coach-streak">
                  <Flame className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                  <span className="tabular-nums">{summary.streakDays} day{summary.streakDays === 1 ? "" : "s"} in a row</span>
                </div>
              )}
              {summary.streakDays === 0 && (
                <div className="mt-1.5 text-sm-minus text-muted-foreground" data-testid="coach-streak">
                  Pick up where you left off.
                </div>
              )}
            </>
          )}
        </div>

        <div className="mt-4">
          <ModeStrip dueCount={summary.dueCount + summary.newCount} onSelect={setMode} />
        </div>

        {/* What to say next — two taps to the verbatim words, fully offline. */}
        <button
          type="button"
          onClick={() => setWhatNextOpen(true)}
          data-testid="what-next-open"
          className={cn(
            "mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 text-[15px] font-semibold text-primary-foreground active:scale-[.98]",
            FOCUS,
          )}
        >
          <MessageSquare className="h-4 w-4" aria-hidden="true" />
          What to say next
        </button>

        {/* Progress: the ladder coverage bar + the bridge back to the Library. */}
        <div className="mt-6">
          <div className="mb-1.5 flex items-center justify-between px-1">
            <SectionLabel>Your ladder</SectionLabel>
            <span className="text-2xs tabular-nums text-muted-foreground">
              {summary.cardsReviewedTotal} review{summary.cardsReviewedTotal === 1 ? "" : "s"} all time
            </span>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4">
            {summaryLoading ? (
              <div role="status" aria-label="Loading ladder coverage">
                <Skeleton className="h-2.5 w-full rounded-full" />
                <Skeleton className="mt-2 h-3 w-2/3" />
              </div>
            ) : (
              <LadderBar coverage={summary.ladderCoverage} totalCards={summary.totalCards} />
            )}
          </div>
          <button
            type="button"
            onClick={() => navigate("/training")}
            data-testid="open-library"
            className={cn(
              "mt-3 inline-flex min-h-11 items-center gap-1.5 px-1 text-sm font-semibold text-primary",
              FOCUS,
            )}
          >
            <BookOpen className="h-4 w-4" aria-hidden="true" />
            Open the full course
          </button>
        </div>
      </div>

      <WhatNextSheet open={whatNextOpen} onOpenChange={setWhatNextOpen} />
    </div>
  );
}
