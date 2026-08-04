// A script drill card with spoken rehearsal built in: flip to the script, tap
// the Mic row to open the existing PitchRecorder (audio never leaves the
// device), then self-rate the take — rushed / clear / landed. Self-judged,
// honest, instant: the practice-mirror philosophy, no new recording machinery.
import { useState } from "react";
import { Mic, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import type { DrillCard } from "@shared/trainingCards";
import PitchRecorder, { isPitchRecorderSupported } from "./PitchRecorder";
import { DailyDrillCard } from "./DailyDrillCard";

export type TakeRating = "rushed" | "clear" | "landed";

const RATINGS: { rating: TakeRating; label: string }[] = [
  { rating: "rushed", label: "Rushed" },
  { rating: "clear", label: "Clear" },
  { rating: "landed", label: "Landed" },
];

function ratingKey(cardId: string): string {
  return `pitch-rating:${cardId}`;
}

function loadRating(cardId: string): TakeRating | null {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(ratingKey(cardId)) : null;
    return raw === "rushed" || raw === "clear" || raw === "landed" ? raw : null;
  } catch {
    return null;
  }
}

function saveRating(cardId: string, rating: TakeRating): void {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(ratingKey(cardId), rating);
  } catch {
    /* private mode — session-only rating is fine */
  }
}

export function PitchDrillCard({
  card,
  flipped,
  onFlip,
}: {
  card: DrillCard;
  flipped: boolean;
  onFlip: () => void;
}) {
  const [recorderOpen, setRecorderOpen] = useState(false);
  const [rating, setRating] = useState<TakeRating | null>(() => loadRating(card.id));
  const recorderSupported = isPitchRecorderSupported();

  return (
    <div data-testid={`pitch-drill-${card.id}`}>
      <DailyDrillCard card={card} flipped={flipped} onFlip={onFlip} />
      {flipped && (
        <div className="mt-3 rounded-2xl border border-border bg-card p-4">
          {recorderSupported ? (
            <>
              <button
                type="button"
                onClick={() => setRecorderOpen((o) => !o)}
                aria-expanded={recorderOpen}
                data-testid="pitch-recorder-toggle"
                className={cn(
                  "flex min-h-11 w-full items-center gap-2 rounded-xl bg-secondary px-3 text-sm font-semibold text-foreground active:scale-[.98]",
                  FOCUS,
                )}
              >
                <Mic className="h-4 w-4 text-primary" aria-hidden="true" />
                <span className="flex-1 text-left">Record yourself saying it</span>
                {recorderOpen ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                )}
              </button>
              {recorderOpen && (
                <div className="mt-3">
                  <PitchRecorder prompt={card.back} title="Rehearse the script" persistKey={card.id} />
                </div>
              )}
            </>
          ) : (
            <div className="text-sm-minus text-muted-foreground" data-testid="pitch-recorder-unsupported">
              Say the script out loud twice — once reading it, once from memory.
            </div>
          )}
          {/* 3-take self-rating: the rep judges their own delivery, honestly. */}
          <div className="mt-3">
            <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              How did the take sound?
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Rate your take">
              {RATINGS.map(({ rating: r, label }) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={rating === r}
                  data-testid={`rate-${r}`}
                  onClick={() => {
                    setRating(r);
                    saveRating(card.id, r);
                  }}
                  className={cn(
                    "min-h-11 rounded-xl border text-sm font-semibold transition-colors active:scale-[.97]",
                    FOCUS,
                    rating === r
                      ? "border-primary/40 bg-primary/[0.12] text-foreground"
                      : "border-border bg-secondary text-muted-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
