// The shared page grammar — the pieces every screen builds from, so screens
// stop inventing their own headers, section labels, stat tiles, and list rows.
//
// The grammar is lifted from two shipped systems (via Mobbin), chosen because
// they map exactly onto what this app is:
//
//   * Revolut (money surfaces): a small quiet EYEBROW label above a large
//     tabular number, deltas as tinted chips beside the number rather than
//     colored numbers, and sections led by small eyebrow headings. Reps read
//     these screens for one number; everything else stays out of its way.
//   * Linear (settings/config surfaces): a row is a TITLE plus a one-line
//     muted description with the control at the trailing edge, sections
//     separated by whitespace rather than boxes-inside-boxes. Managers read
//     these screens to make one decision; the description is what lets them
//     make it without opening a doc.
//
// Nothing here owns data. These are layout primitives with the app's type
// scale baked in, so "increase every screen" means adopting a component, not
// re-deriving eleven Tailwind classes and getting three of them wrong.

import { type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Page title block: one per screen, title + optional subtitle + trailing
 *  actions. The h1 is the ONLY text at this size on a page. */
export function PageHeader({ title, subtitle, icon: Icon, actions, className }: {
  title: string;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4", className)} data-testid="page-header">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-foreground">
          {Icon && <Icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className="truncate">{title}</span>
        </h1>
        {subtitle && <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5 pt-1">{actions}</div>}
    </div>
  );
}

/** Revolut-style section eyebrow: small, quiet, all-caps. Announces a group
 *  without competing with the numbers inside it. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("text-[11px] font-semibold uppercase tracking-wide text-muted-foreground", className)}>
      {children}
    </div>
  );
}

/** Delta/status chip beside a stat — tinted pill, never a bare colored number.
 *  A number that is itself green reads as a different UNIT, not a trend. */
export function StatDelta({ tone, children }: { tone: "up" | "down" | "neutral"; children: ReactNode }) {
  const tones = {
    up: "bg-emerald-500/15 text-emerald-400",
    down: "bg-red-500/15 text-red-400",
    neutral: "bg-secondary text-muted-foreground",
  } as const;
  return (
    <span className={cn("inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold", tones[tone])}>
      {children}
    </span>
  );
}

/** Revolut-style stat tile: eyebrow label above a large tabular number.
 *  Label ABOVE the number, always — a rep scanning four tiles reads the
 *  labels once and the numbers forever after. */
export function StatTile({ label, value, icon: Icon, delta, accent = false, className, testId }: {
  label: string;
  value: ReactNode;
  icon?: LucideIcon;
  delta?: ReactNode;
  /** The one tile the screen is FOR (sales, pay). One per row at most. */
  accent?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "min-w-0 bg-card p-3",
        accent && "bg-primary/[0.07]",
        className,
      )}
    >
      <div className="flex items-center gap-1.5">
        {Icon && <Icon className={cn("h-3.5 w-3.5 shrink-0", accent ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />}
        <span className="truncate text-[11px] font-medium text-muted-foreground">{label}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className={cn("text-xl font-bold tabular-nums leading-none tracking-tight", accent ? "text-primary" : "text-foreground")}>
          {value}
        </span>
        {delta}
      </div>
    </div>
  );
}

/** The strip that holds StatTiles: hairline-separated cells in one rounded
 *  container (gap-px over a border-colored track), not four floating boxes. */
export function StatStrip({ children, columns = 4, className }: {
  children: ReactNode;
  columns?: 2 | 3 | 4;
  className?: string;
}) {
  const cols = { 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-2 sm:grid-cols-4" }[columns];
  return (
    <div className={cn("grid gap-px overflow-hidden rounded-2xl border border-border bg-border", cols, className)}>
      {children}
    </div>
  );
}

/** Linear-style list row: title + one-line description, control at the
 *  trailing edge, 48px minimum so it is a touch target and not just a line. */
export function ListRow({ title, description, icon: Icon, trailing, onClick, className, testId }: {
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  trailing?: ReactNode;
  onClick?: () => void;
  className?: string;
  testId?: string;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      {...(onClick ? { type: "button" as const, onClick } : {})}
      data-testid={testId}
      className={cn(
        "flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left",
        onClick && "transition-colors hover:bg-secondary/50 active:bg-secondary/70",
        className,
      )}
    >
      {Icon && (
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-secondary text-muted-foreground">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-foreground">{title}</span>
        {description && <span className="block truncate text-xs text-muted-foreground">{description}</span>}
      </span>
      {trailing && <span className="flex shrink-0 items-center gap-2">{trailing}</span>}
    </Tag>
  );
}

/** The container ListRows live in: one bordered rounded group, rows divided
 *  by hairlines — Linear's grouped list, not floating cards per row. */
export function ListGroup({ children, label, className }: {
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      {label && <SectionLabel className="mb-1.5 px-1">{label}</SectionLabel>}
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {children}
      </div>
    </div>
  );
}
