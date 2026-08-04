// The 14-key objection chip row — the frozen taxonomy (shared/trainingObjections)
// rendered as 44px-floor chips. Reused by WhatNextSheet (pick an objection to
// drill) and the debrief card (log what you actually heard today). Chips are
// labeled, never color-only; keys are stable identifiers, display order is the
// taxonomy's own order.
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { OBJECTION_TAXONOMY, type ObjectionKey } from "@shared/trainingObjections";

export function ObjectionChips({
  selected,
  onSelect,
  gapKeys,
}: {
  /** Single pick (WhatNextSheet) or a multi-pick set (debrief "heard today"). */
  selected: ObjectionKey | null | ReadonlySet<ObjectionKey>;
  onSelect: (key: ObjectionKey) => void;
  /** Keys with no objection card yet (named content gaps) — rendered dimmed so
   *  the chip row stays honest instead of promising an empty answer. */
  gapKeys?: ReadonlySet<ObjectionKey>;
}) {
  const isSelected = (key: ObjectionKey) =>
    selected instanceof Set ? selected.has(key) : selected === key;
  return (
    <div
      className="flex flex-wrap gap-2"
      role="listbox"
      aria-label="Objections"
      aria-multiselectable={selected instanceof Set || undefined}
      data-testid="objection-chips"
    >
      {OBJECTION_TAXONOMY.map(({ key, chip }) => {
        const gap = gapKeys?.has(key) ?? false;
        const active = isSelected(key);
        return (
          <button
            key={key}
            type="button"
            role="option"
            aria-selected={active}
            data-testid={`objection-chip-${key}`}
            onClick={() => onSelect(key)}
            className={cn(
              "min-h-11 rounded-xl border px-3 text-[13px] font-semibold transition-colors active:scale-[.97]",
              FOCUS,
              active
                ? "border-primary/40 bg-primary/[0.12] text-foreground"
                : "border-border bg-secondary text-foreground",
              gap && !active && "opacity-60",
            )}
          >
            {chip}
          </button>
        );
      })}
    </div>
  );
}
