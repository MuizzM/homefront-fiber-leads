// Post-shift debrief: what you actually heard today (objection chips), the
// cards you just re-drilled, and a one-line reflection. Everything persists
// locally under today's date — the debrief is a private field habit, not a
// server round-trip, and it works in a dead zone at 9 PM. Copy follows the
// rejection-math voice: lapsed cards are data collected, never failure.
import { useState } from "react";
import { Moon, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { localDayISO } from "@/lib/useTrainingEngine";
import { ObjectionChips } from "./ObjectionChips";
import type { ObjectionKey } from "@shared/trainingObjections";

function heardKey(day: string): string {
  return `hf.trainingHeard.v1.${day}`;
}
function reflectionKey(day: string): string {
  return `hf.trainingReflection.v1.${day}`;
}

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key: string, value: unknown): void {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode — session-only is fine */
  }
}

export function DebriefCard({
  reviewedCount,
  onDone,
}: {
  /** Cards graded in the debrief deck that just ran. */
  reviewedCount: number;
  onDone?: () => void;
}) {
  const today = localDayISO();
  const [heard, setHeard] = useState<ObjectionKey[]>(() => loadJSON(heardKey(today), []));
  const [reflection, setReflection] = useState<string>(() => loadJSON(reflectionKey(today), ""));
  const [saved, setSaved] = useState(false);

  const toggleHeard = (key: ObjectionKey) => {
    setHeard((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      saveJSON(heardKey(today), next);
      return next;
    });
  };

  const saveReflection = () => {
    saveJSON(reflectionKey(today), reflection.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-5" data-testid="debrief-card">
      <div className="flex items-center gap-2">
        <Moon className="h-4 w-4 text-primary" aria-hidden="true" />
        <SectionLabel>Shift debrief</SectionLabel>
      </div>

      <div className="mt-2 text-[15px] font-semibold text-foreground tabular-nums" data-testid="debrief-reviewed">
        {reviewedCount} card{reviewedCount === 1 ? "" : "s"} drilled — data collected
      </div>

      <div className="mt-4">
        <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          What did you hear at doors today?
        </div>
        <div className="mt-2">
          <ObjectionChips
            selected={new Set(heard)}
            onSelect={toggleHeard}
          />
        </div>
        {heard.length > 0 && (
          <div className="mt-2 text-xs text-muted-foreground" data-testid="debrief-heard-count">
            {heard.length} objection{heard.length === 1 ? "" : "s"} logged — they&apos;ll be back in the deck.
          </div>
        )}
      </div>

      <div className="mt-4">
        <label
          htmlFor="debrief-reflection"
          className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          One line for tomorrow&apos;s you
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id="debrief-reflection"
            type="text"
            value={reflection}
            onChange={(e) => setReflection(e.target.value)}
            onBlur={saveReflection}
            maxLength={140}
            placeholder="What will you say differently tomorrow?"
            data-testid="debrief-reflection"
            className={cn(
              "min-h-11 flex-1 rounded-xl border border-border bg-background px-3 text-sm text-foreground",
              "placeholder:text-muted-foreground",
              FOCUS,
            )}
          />
          <button
            type="button"
            onClick={saveReflection}
            aria-label="Save reflection"
            data-testid="debrief-save"
            className={cn(
              "grid min-h-11 w-11 shrink-0 place-items-center rounded-xl border border-border bg-secondary text-muted-foreground active:scale-[.97]",
              saved && "border-primary/40 text-primary",
              FOCUS,
            )}
          >
            <Check className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {onDone && (
        <button
          type="button"
          onClick={onDone}
          data-testid="debrief-done"
          className={cn(
            "mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground active:scale-[.98]",
            FOCUS,
          )}
        >
          Done — see you at the first door
        </button>
      )}
    </div>
  );
}
