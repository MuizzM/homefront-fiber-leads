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
    // role=group, not listbox: these are independent toggle buttons, and the
    // listbox/option contract (single tab stop, arrow-key navigation, real
    // selection state) was never implemented — screen readers announced a
    // widget whose keyboard model did not exist. aria-pressed on each button
    // is the truthful contract for a toggle.
    <div
      className="flex flex-wrap gap-2"
      role="group"
      aria-label="Objections"
      data-testid="objection-chips"
    >
      {OBJECTION_TAXONOMY.map(({ key, chip }) => {
        const gap = gapKeys?.has(key) ?? false;
        const active = isSelected(key);
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
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
            {/* The dimmed style alone says nothing to a screen reader. */}
            {gap && !active && <span className="sr-only"> (no card yet)</span>}
          </button>
        );
      })}
    </div>
  );
}
