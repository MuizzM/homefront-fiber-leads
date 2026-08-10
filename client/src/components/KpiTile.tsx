import { Skeleton } from "@/components/ui/skeleton";

// ── Shared KPI card ───────────────────────────────────────────────────────────
// One consistent stat card across the portal: a semantic top-accent hairline,
// the number, the label. `loading` swaps the value for a skeleton so cards can
// paint their frame instantly while the number streams in (no layout shift, no
// blocking spinner).
//
// The rail takes a MEANING, not a colour. Callers used to pass literal Tailwind
// classes (`accent="bg-amber-500"`, `tone="text-emerald-400"`), which had three
// costs: the -400/-500 steps were picked against the old dark ground and go
// muddy or low-contrast on the white default; two of Dashboard's five tiles
// ended up amber and yellow, indistinguishable at 3px; and one passed
// `bg-muted-foreground/40`, a dishwater grey that reads as disabled rather than
// neutral. Naming the meaning lets the theme own the colour, so both themes and
// any future palette change stay correct at one edit.
export type KpiTone = "neutral" | "primary" | "info" | "success" | "warning";

// Full literal class strings - the Tailwind JIT only keeps classes it can see.
const RAIL: Record<KpiTone, string> = {
  // Inventory and totals: real numbers, but no signal to act on. The card's own
  // border colour, so the tile reads as a plain surface rather than a status.
  neutral: "bg-border",
  // Structural / in-play counts.
  primary: "bg-primary",
  // Work in flight or completed activity.
  info:    "bg-info",
  // Wins.
  success: "bg-success",
  // Owed work. Kept rare on purpose: if several tiles are amber, none of them
  // mean anything.
  warning: "bg-warning",
};

export function KpiTile({ label, value, tone = "neutral", className = "", loading = false }: {
  label: string;
  value: number | string;
  tone?: KpiTone;
  className?: string;
  loading?: boolean;
}) {
  return (
    <div
      className={`relative shrink-0 rounded-2xl bg-card border border-border px-3.5 pt-3.5 pb-3 overflow-hidden ${className}`}
      data-testid={`kpi-${String(label).toLowerCase().replace(/\s/g, "-")}`}
    >
      <span className={`absolute inset-x-0 top-0 h-[3px] ${RAIL[tone]}`} aria-hidden="true" />

      <div className="text-[26px] font-bold leading-none tracking-tight tabular-nums text-foreground">
        {loading ? <Skeleton className="h-6 w-12" /> : value}
      </div>
      <div className="text-[11px] text-muted-foreground font-medium mt-1.5">{label}</div>
    </div>
  );
}
