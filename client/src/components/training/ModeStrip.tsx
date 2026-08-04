// The three field modes: pre-knock warmup (2 min), between-doors refresher
// (30 s), post-shift debrief (5 min). The suggested mode is a time-of-day
// heuristic only — never a lock. Identity via icons (Sun/Zap/Moon), the one
// teal accent marks the suggestion; rows follow the Today card idiom.
import { Sun, Zap, Moon, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";
import type { DeckMode } from "@/lib/useTrainingEngine";

const MODES: { mode: DeckMode; label: string; time: string; icon: typeof Sun; hint: string }[] = [
  { mode: "warmup", label: "Warm up", time: "2 min", icon: Sun, hint: "Cards due + one pitch rep before your first door" },
  { mode: "refresher", label: "Quick card", time: "30 s", icon: Zap, hint: "One card between doors. Flip, grade, go" },
  { mode: "debrief", label: "Debrief", time: "5 min", icon: Moon, hint: "What you heard today, drilled before tomorrow" },
];

/** Time-of-day suggestion: morning = pre-knock warmup, midday = between-doors
 *  refresher, evening = post-shift debrief. Heuristic only — every mode is
 *  always tappable. */
export function suggestedMode(hour = new Date().getHours()): DeckMode {
  return hour < 12 ? "warmup" : hour < 17 ? "refresher" : "debrief";
}

export function ModeStrip({
  dueCount,
  onSelect,
}: {
  dueCount: number;
  onSelect: (mode: DeckMode) => void;
}) {
  const suggested = suggestedMode();
  return (
    <div data-testid="mode-strip">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <SectionLabel>Field modes</SectionLabel>
        <span className="text-2xs tabular-nums text-muted-foreground" data-testid="mode-strip-due">
          {dueCount} card{dueCount === 1 ? "" : "s"} due
        </span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card divide-y divide-border">
        {MODES.map(({ mode, label, time, icon: Icon, hint }) => (
          <button
            key={mode}
            type="button"
            onClick={() => onSelect(mode)}
            data-testid={`mode-${mode}`}
            aria-label={`${label} (${time}) — ${hint}`}
            className={cn(
              "relative flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/50",
              FOCUS,
              mode === suggested && "bg-primary/[0.06]",
            )}
          >
            {mode === suggested && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1.5 bg-primary" />}
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold text-foreground">
                {label}{" "}
                <span className="ml-1 text-2xs font-medium tabular-nums text-muted-foreground">{time}</span>
              </span>
              <span className="block truncate text-xs text-muted-foreground">{hint}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}
