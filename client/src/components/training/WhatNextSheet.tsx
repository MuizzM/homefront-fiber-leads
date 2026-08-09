// "What to say next" — a deterministic stage → objection → card lookup. Two
// taps from anywhere to the verbatim words. No network, no AI: the corpus is
// bundled and indexed in shared/trainingCards, so this works fully offline in
// a dead zone, which is exactly when a rep needs it.
//
// The corpus is pulled through lib/trainingCorpus rather than imported
// statically, so this sheet does not drag 139 KB gzipped into the route graph
// of every screen that renders it. Coach warms it on mount, so by the time the
// sheet opens it is already there — and it stays bundled, so offline holds.
import { useMemo, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import type { DoorStage, DrillCard } from "@shared/trainingCards";
import { useTrainingCorpus } from "@/lib/trainingCorpus";
import { OBJECTION_CARD_GAPS, type ObjectionKey } from "@shared/trainingObjections";
import { ObjectionChips } from "./ObjectionChips";

const STAGES: { stage: DoorStage; label: string }[] = [
  { stage: "opener", label: "Opener" },
  { stage: "discovery", label: "Discovery" },
  { stage: "pitch", label: "Pitch" },
  { stage: "objection", label: "Objection" },
  { stage: "close", label: "Close" },
  { stage: "followup", label: "Follow-up" },
];

const GAP_KEYS: ReadonlySet<ObjectionKey> = new Set(
  (Object.keys(OBJECTION_CARD_GAPS) as ObjectionKey[]).filter((k) => OBJECTION_CARD_GAPS[k] != null),
);

function AnswerCard({ card }: { card: DrillCard }) {
  return (
    <div className="rounded-xl border border-border bg-background p-4" data-testid={`what-next-card-${card.id}`}>
      <div className="text-sm-minus font-semibold text-muted-foreground">{card.front}</div>
      {/* Verbatim line earns foreground contrast — it gets read aloud. */}
      <div className="mt-2 whitespace-pre-line text-[15px] leading-relaxed text-foreground">{card.back}</div>
      {card.note && <div className="mt-2 text-xs leading-relaxed text-muted-foreground">{card.note}</div>}
    </div>
  );
}

export function WhatNextSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [stage, setStage] = useState<DoorStage>("objection");
  const [picked, setPicked] = useState<ObjectionKey | null>(null);

  // Non-objection stages render their strongest cards straight; objections go
  // through the 14-key row first. Everything is an in-memory index hit.
  const corpus = useTrainingCorpus(open);
  const stageCards = useMemo(
    () => (stage === "objection" || !corpus ? [] : corpus.cardsByStage(stage).slice(0, 4)),
    [stage, corpus],
  );
  const answers = useMemo(
    () => (picked && corpus ? corpus.cardsByObjection(picked) : []),
    [picked, corpus],
  );
  const gapNote = picked ? OBJECTION_CARD_GAPS[picked] : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[92dvh] overflow-y-auto rounded-t-2xl border-border bg-card p-0"
        data-testid="what-next-sheet"
      >
        <div className="p-4 pb-8">
          <div className="flex items-center gap-2 pr-10">
            
            <SheetTitle className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              What to say next
            </SheetTitle>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            {STAGES.map((s) => (
              <button
                key={s.stage}
                type="button"
                onClick={() => {
                  setStage(s.stage);
                  setPicked(null);
                }}
                data-testid={`stage-${s.stage}`}
                aria-pressed={stage === s.stage}
                className={cn(
                  "min-h-11 rounded-xl border text-[13px] font-semibold transition-colors",
                  FOCUS,
                  stage === s.stage
                    ? "border-primary/40 bg-primary/[0.12] text-primary"
                    : "border-border bg-secondary text-foreground",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>

          {stage === "objection" && (
            <div className="mt-3">
              <ObjectionChips selected={picked} onSelect={setPicked} gapKeys={GAP_KEYS} />
            </div>
          )}

          {picked && (
            <div className="mt-3 space-y-3">
              <button
                type="button"
                onClick={() => setPicked(null)}
                className={cn("inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-muted-foreground", FOCUS)}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" /> All objections
              </button>
              {answers.map((card) => (
                <AnswerCard key={card.id} card={card} />
              ))}
              {answers.length === 0 && (
                <div className="rounded-xl border border-border bg-background p-4" data-testid="what-next-gap">
                  <div className="text-sm-minus font-semibold text-foreground">No drill card for this one yet</div>
                  <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{gapNote}</div>
                </div>
              )}
            </div>
          )}

          {stage !== "objection" && stageCards.length > 0 && (
            <div className="mt-3 space-y-3">
              {stageCards.map((card) => (
                <AnswerCard key={card.id} card={card} />
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
