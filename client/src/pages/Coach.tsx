// ── Coach — the field coaching engine ────────────────────────────────────────
// Thirty seconds at a time: a 2-minute pre-knock warmup, a 30-second card
// between doors, a 5-minute post-shift debrief, and a deterministic "what to
// say next" lookup — all offline-first, all re-cut from the same curriculum
// the Library (Training.tsx) teaches. This page NEVER shows connectivity:
// the deck comes from the persisted snapshot or the bundled corpus, grades
// ride the trainingReviewQueue outbox, and the numbers stay honest.
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Zap } from "lucide-react";
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
import type { DrillCard } from "@shared/trainingCards";
import { useTrainingCorpus } from "@/lib/trainingCorpus";
import type { Grade } from "@shared/trainingSchedule";

// Where the mode actually lands depends on how you got here, and both places
// are real. wouter's hash navigate() splits a link's query OFF the hash and
// assigns it to location.search — `<Link href="/coach?mode=warmup">` (Today's
// WarmupStrip) produces `/?mode=warmup#/coach`, NOT `#/coach?mode=warmup`. A
// hand-typed or shared `#/coach?mode=warmup` URL keeps it in the hash. Read
// both, hash first, exactly as PropertyDetail does for its own param.
function queryMode(): DeckMode | null {
  const hashQuery = window.location.hash.split("?")[1] ?? "";
  const raw = new URLSearchParams(hashQuery).get("mode")
    ?? new URLSearchParams(window.location.search).get("mode");
  return raw === "warmup" || raw === "refresher" || raw === "debrief" ? raw : null;
}

/** Drop the consumed `mode` param so it cannot silently re-open the deck on a
 *  later visit. wouter's navigate() only ASSIGNS location.search when the next
 *  link carries one, so a stale `?mode=warmup` otherwise rides along through
 *  every subsequent navigation. */
function clearQueryMode(): void {
  const url = new URL(window.location.href);
  let touched = false;
  if (url.searchParams.has("mode")) { url.searchParams.delete("mode"); touched = true; }
  const [hashPath, hashQuery] = url.hash.split("?");
  if (hashQuery) {
    const params = new URLSearchParams(hashQuery);
    if (params.has("mode")) {
      params.delete("mode");
      const rest = params.toString();
      url.hash = rest ? `${hashPath}?${rest}` : hashPath;
      touched = true;
    }
  }
  if (touched) window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

/** Refresher is ONE card between doors — due first, then new, so a rep with a
 *  clear pile still gets the 30-second rep. */
function refresherDeck(due: DrillCard[], newCards: DrillCard[]): DrillCard[] {
  return [...due, ...newCards].slice(0, 3);
}

/** Debrief is the objection gauntlet when nothing is due: 5 objection cards
 *  rotated deterministically by the day-of-year (no RNG, offline-safe).
 *  `corpus` is null only while the curriculum chunk is still in flight. */
function debriefDeck(due: DrillCard[], corpus: CorpusModule): DrillCard[] {
  if (due.length > 0) return due.slice(0, 10);
  if (!corpus) return [];
  const gauntlet = corpus.cardsByStage("objection");
  if (gauntlet.length <= 5) return gauntlet;
  const start = Math.floor(Date.now() / 86_400_000) % gauntlet.length;
  return Array.from({ length: 5 }, (_, i) => gauntlet[(start + i) % gauntlet.length]);
}

type CorpusModule = ReturnType<typeof useTrainingCorpus>;

export default function Coach() {
  const [, navigate] = useLocation();
  const [mode, setMode] = useState<DeckMode | null>(() => queryMode());
  // Consumed on mount — the deck is open now, so the param has done its job.
  useEffect(() => { clearQueryMode(); }, []);
  const [whatNextOpen, setWhatNextOpen] = useState(false);
  const [deckRunCount, setDeckRunCount] = useState(0);
  const [debriefDone, setDebriefDone] = useState(false);

  const deck = useDueCards();
  // Warm the curriculum as soon as Coach opens, but OUT of the route's static
  // graph: this page used to statically import @shared/trainingCards, which put
  // the 139 KB gzipped corpus in front of first paint even though only the
  // debrief deck and the what-to-say-next sheet ever read it. Loading it here
  // means the hub paints immediately and the corpus streams in behind it — and
  // by the time a rep taps into a deck or the sheet, it is there. Offline is
  // unaffected: it is still bundled, and cached after one visit.
  const corpus = useTrainingCorpus();
  const { recordReview } = useRecordReviews();
  const { summary, isLoading: summaryLoading } = useCoachSummary();

  const cards = useMemo(() => {
    switch (mode) {
      case "warmup":
        return [...deck.due, ...deck.newCards].slice(0, 12);
      case "refresher":
        return refresherDeck(deck.due, deck.newCards);
      case "debrief":
        return debriefDeck(deck.due, corpus);
      default:
        return [];
    }
  }, [mode, deck.due, deck.newCards, corpus]);

  const onGrade = (card: DrillCard, grade: Grade, _m: DeckMode) => {
    recordReview(card, grade);
    setDeckRunCount((n) => n + 1);
  };

  // ── Deck runner takes the whole screen ─────────────────────────────────────
  if (mode) {
    // Debrief with an empty due pile needs the corpus before it has a deck.
    if (deck.isLoading || (mode === "debrief" && deck.due.length === 0 && !corpus)) {
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
            
            Open the full course
          </button>
        </div>
      </div>

      <WhatNextSheet open={whatNextOpen} onOpenChange={setWhatNextOpen} />
    </div>
  );
}
