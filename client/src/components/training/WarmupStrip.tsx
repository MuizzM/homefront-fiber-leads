// The Today-page entry card for the coaching engine: due count + a 2-minute
// Start, in the same compact card idiom as MilestoneCard. Renders nothing when
// there's nothing due (today's warmup is graded) or while the deck loads —
// no layout shift, no fake zero. Offline it reads the persisted deck snapshot,
// so a dead-zone morning still gets its warmup.
import { Sun, ChevronRight } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { useDueCards } from "@/lib/useTrainingEngine";

export function WarmupStrip() {
  const { dueCount, newCount, isLoading } = useDueCards();
  const total = dueCount + newCount;
  if (isLoading || total === 0) return null;

  return (
    <Link
      href="/coach?mode=warmup"
      data-testid="warmup-strip"
      aria-label={`Warm up before your first door — ${total} cards, about 2 minutes`}
      className={cn(
        "flex items-center gap-3 rounded-xl bg-card border border-border px-4 py-3",
        "active:scale-[.99] transition-transform hover:border-primary/30",
        FOCUS,
      )}
    >
      <span className="w-9 h-9 rounded-lg bg-primary/15 text-primary flex items-center justify-center shrink-0">
        <Sun className="w-5 h-5" aria-hidden="true" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[14px] font-semibold text-foreground tabular-nums">
          {total} card{total === 1 ? "" : "s"} before your first door
        </span>
        <span className="block text-[12px] text-muted-foreground">2-minute warmup — your opener, loaded</span>
      </span>
      <span className="shrink-0 inline-flex min-h-11 items-center gap-1 rounded-xl bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground">
        Start
        <ChevronRight className="w-4 h-4" aria-hidden="true" />
      </span>
    </Link>
  );
}
