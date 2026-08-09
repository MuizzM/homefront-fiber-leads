import { ChevronRight } from "lucide-react";
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
      aria-label={`Warm up before your first door: ${total} cards, about 2 minutes`}
      className={cn(
        "flex items-center gap-3 rounded-xl bg-card border border-border px-4 py-3",
        "active:scale-[.99] transition-transform hover:border-primary/30",
        FOCUS,
      )}
    >
      
      <span className="flex-1 min-w-0">
        <span className="block text-[14px] font-semibold text-foreground tabular-nums">
          {total} card{total === 1 ? "" : "s"} before your first door
        </span>
        <span className="block text-[12px] text-muted-foreground">2-minute warmup · your opener, loaded</span>
      </span>
      <span className="shrink-0 inline-flex min-h-11 items-center gap-1 rounded-xl bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground">
        Start
        <ChevronRight className="w-4 h-4" aria-hidden="true" />
      </span>
    </Link>
  );
}
