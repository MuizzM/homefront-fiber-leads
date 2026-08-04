// The 5-rung ladder coverage bar: how many cards sit on each rung of the
// 1/3/7/16-day schedule. One honest glance at deck health — the weekly-loop
// stat ("84 of 250 cards on rung ≥ 3"). Tabular numbers, labeled rungs (hue
// never carries meaning alone), the teal accent reserved for progress made.
import { MAX_RUNG } from "@shared/trainingSchedule";

const RUNG_LABELS = ["New", "1d", "3d", "7d", "16d"] as const;

export function LadderBar({
  coverage,
  totalCards,
}: {
  /** rung index (as string key) → card count, from coach-summary. */
  coverage: Record<string, number>;
  totalCards: number;
}) {
  const counts = RUNG_LABELS.map((_, r) => coverage[String(r)] ?? 0);
  const covered = counts.reduce((a, b) => a + b, 0);
  const onUpperRungs = counts.slice(3).reduce((a, b) => a + b, 0);
  const ariaLabel = `Ladder coverage: ${counts
    .map((c, r) => `${c} cards on rung ${RUNG_LABELS[r]}`)
    .join(", ")}.`;

  return (
    <div data-testid="ladder-bar">
      <div
        className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={ariaLabel}
      >
        {counts.map((count, r) => {
          // Width is the rung's share of the WHOLE corpus, so uncovered cards
          // show as empty track — the honest shape of deck debt.
          const pct = totalCards > 0 ? (count / totalCards) * 100 : 0;
          return (
            <span
              key={r}
              aria-hidden="true"
              className={r >= MAX_RUNG - 1 ? "bg-primary" : "bg-primary/50"}
              style={{ width: `${pct}%` }}
            />
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between text-2xs text-muted-foreground">
        {RUNG_LABELS.map((label, r) => (
          <span key={label} className="tabular-nums" data-testid={`ladder-rung-${r}`}>
            <span className="font-semibold text-foreground">{counts[r]}</span> {label}
          </span>
        ))}
      </div>
      <div className="mt-1 text-2xs tabular-nums text-muted-foreground" data-testid="ladder-summary">
        {covered} of {totalCards} cards on the ladder · {onUpperRungs} past a week
      </div>
    </div>
  );
}
