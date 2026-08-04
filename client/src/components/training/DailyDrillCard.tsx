// One drill card: tap anywhere to flip, stage chip up top, source link on the
// back. The whole card is the flip target (44px floor is trivially met), the
// grade buttons — not this card — are the only saturated elements on screen.
import { RotateCcw, BookOpen } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import type { DrillCard, DoorStage } from "@shared/trainingCards";

export const STAGE_LABEL: Record<DoorStage, string> = {
  opener: "Opener",
  discovery: "Discovery",
  pitch: "Pitch",
  objection: "Objection",
  close: "Close",
  followup: "Follow-up",
  mindset: "Mindset",
  compliance: "Compliance",
};

export function DailyDrillCard({
  card,
  flipped,
  onFlip,
}: {
  card: DrillCard;
  flipped: boolean;
  onFlip: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onFlip}
      data-testid={`drill-card-${card.id}`}
      aria-label={flipped ? "Card back — tap to see prompt" : "Card front — tap to reveal"}
      aria-pressed={flipped}
      className={cn(
        "relative flex min-h-[240px] w-full flex-col rounded-2xl border bg-card p-5 text-left",
        "transition-transform active:scale-[.99]",
        // Compliance cards carry the warning accent strip; every other card is
        // neutral ink — hue never carries meaning alone (the chip is labeled).
        card.stage === "compliance" ? "border-warning/40" : "border-border",
        FOCUS,
      )}
    >
      <span className="inline-flex w-fit items-center gap-1.5">
        <span className="inline-flex items-center rounded-full bg-secondary px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          {STAGE_LABEL[card.stage]}
        </span>
        <span className="inline-flex items-center rounded-full bg-secondary px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          {card.kind === "say-this" ? "Say this" : card.kind}
        </span>
      </span>
      {!flipped ? (
        <span className="mt-4 block text-[17px] font-semibold leading-snug text-foreground" data-testid="drill-card-front">
          {card.front}
        </span>
      ) : (
        <span className="mt-4 block space-y-3" data-testid="drill-card-back">
          {/* Verbatim lines earn foreground contrast — they get read aloud. */}
          <span className="block whitespace-pre-line text-[15px] leading-relaxed text-foreground">{card.back}</span>
          {card.note && (
            <span className="block text-sm-minus leading-relaxed text-muted-foreground">{card.note}</span>
          )}
        </span>
      )}
      <span className="mt-auto flex items-center justify-between pt-4">
        <span className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground">
          <RotateCcw className="h-3 w-3" aria-hidden="true" />
          {flipped ? "Tap to see prompt" : "Tap to reveal"}
        </span>
        {flipped && (
          <Link
            href="/training"
            data-testid={`drill-card-source-${card.id}`}
            className={cn("inline-flex min-h-11 items-center gap-1 text-2xs font-semibold text-primary", FOCUS)}
            onClick={(e) => e.stopPropagation()}
          >
            <BookOpen className="h-3 w-3" aria-hidden="true" /> Full lesson
          </Link>
        )}
      </span>
    </button>
  );
}
