// ── Metrics charts — hand-rolled SVG ─────────────────────────────────────────
//
// There is no charting library in this project's dependencies, and adding one
// for six charts would put ~50 KB gzipped on a page reps open on LTE at a
// doorstep. Every chart here is a few dozen lines of SVG instead.
//
// Three rules they all follow:
//
//   COLOUR COMES FROM TOKENS, NEVER FROM A HEX.
//   `hsl(var(--chart-1))` and the semantic tokens resolve per theme, so these
//   are correct in light and dark at zero extra markup. A literal hex here is
//   the bug docs/DESIGN_SYSTEM.md describes twice.
//
//   AN EMPTY SERIES RENDERS AN EMPTY STATE, NOT AN EMPTY BOX.
//   A chart axis with no bars reads as a broken component. Every chart below
//   returns a labelled placeholder instead.
//
//   NOTHING SCROLLS THE PAGE SIDEWAYS.
//   Charts use viewBox with preserveAspectRatio and scale to their container,
//   so a 320px phone gets a smaller chart rather than a horizontal scrollbar.

import { type ReactNode } from "react";
import { formatRate, type FunnelStage } from "@shared/repMetrics";

function EmptyChart({ label, height = 120 }: { label: string; height?: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-xl border border-dashed border-border bg-secondary/30 text-xs text-muted-foreground"
      style={{ height }}
      data-testid="chart-empty"
    >
      {label}
    </div>
  );
}

// ── Bar chart ────────────────────────────────────────────────────────────────

export interface BarDatum {
  label: string;
  value: number;
  /** Optional second series drawn as a lighter overlay inside the same bar -
   *  used for "doors, of which contacts", where a grouped bar would double the
   *  width and halve the readability on a phone. */
  secondary?: number;
}

export function BarChart({ data, height = 140, emptyLabel = "No activity in this period", format }: {
  data: readonly BarDatum[];
  height?: number;
  emptyLabel?: string;
  format?: (v: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0 || max <= 0) return <EmptyChart label={emptyLabel} height={height} />;

  // Bars are drawn in a percentage-based flex row rather than an SVG grid: it
  // reflows on a narrow screen for free, and the labels stay real text (so they
  // are selectable and screen-reader legible) instead of <text> nodes.
  return (
    <div className="w-full" data-testid="chart-bar">
      <div className="flex items-end gap-1" style={{ height }}>
        {data.map((d, i) => {
          const pct = (d.value / max) * 100;
          const secPct = d.secondary != null ? (d.secondary / max) * 100 : null;
          return (
            <div key={`${d.label}-${i}`} className="group relative flex min-w-0 flex-1 flex-col justify-end">
              <div
                className="relative w-full rounded-t-md bg-chart-1/85 transition-[height]"
                style={{ height: `${Math.max(pct, d.value > 0 ? 3 : 0)}%` }}
              >
                {secPct != null && (
                  <div
                    className="absolute inset-x-0 bottom-0 rounded-t-md bg-chart-2"
                    style={{ height: `${max > 0 ? (d.secondary! / d.value || 0) * 100 : 0}%` }}
                  />
                )}
              </div>
              {/* Native tooltip: no portal, no library, works on desktop hover
                  and is announced by screen readers. */}
              <span className="sr-only">{`${d.label}: ${format ? format(d.value) : d.value}`}</span>
              <title>{`${d.label}: ${format ? format(d.value) : d.value}`}</title>
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-1">
        {data.map((d, i) => (
          <div key={`l-${d.label}-${i}`} className="min-w-0 flex-1 truncate text-center text-2xs text-muted-foreground">
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Line / trend ─────────────────────────────────────────────────────────────

export function LineChart({ points, height = 120, emptyLabel = "Not enough history yet", format }: {
  points: readonly { label: string; value: number | null }[];
  height?: number;
  emptyLabel?: string;
  format?: (v: number) => string;
}) {
  const real = points.filter((p): p is { label: string; value: number } => p.value != null);
  if (real.length < 2) return <EmptyChart label={emptyLabel} height={height} />;

  const values = real.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const W = 100, H = 40;

  // Nulls BREAK the line rather than interpolating across them. A day with no
  // data is not a day with an average value, and drawing straight through it
  // invents a number the rep never produced.
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (p.value == null) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      return;
    }
    const x = (i / Math.max(1, points.length - 1)) * W;
    const y = H - ((p.value - min) / span) * H;
    current.push(`${current.length === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`);
  });
  if (current.length > 1) segments.push(current.join(" "));

  const last = real[real.length - 1];

  return (
    <div className="w-full" data-testid="chart-line">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height, width: "100%" }} role="img"
           aria-label={`Trend, latest ${format ? format(last.value) : last.value}`}>
        {segments.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="hsl(var(--chart-1))" strokeWidth={1.5}
                vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-2xs text-muted-foreground">
        <span>{points[0]?.label}</span>
        <span className="tabular-nums">{format ? format(last.value) : last.value}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </div>
  );
}

// ── Funnel ───────────────────────────────────────────────────────────────────

/**
 * Assigned to Paid, as horizontal bars.
 *
 * Widths are relative to the TOP stage, so the shape shows real attrition
 * rather than each row being normalised to its own predecessor. The
 * stage-to-stage conversion is printed beside each row, which is the number a
 * manager actually acts on.
 */
export function FunnelChart({ stages }: { stages: readonly FunnelStage[] }) {
  const top = stages[0]?.value ?? 0;
  if (top <= 0) return <EmptyChart label="No assigned doors in this period" height={180} />;

  return (
    <div className="space-y-1.5" data-testid="chart-funnel">
      {stages.map((s) => {
        const pct = Math.max(0, Math.min(100, (s.value / top) * 100));
        return (
          <div key={s.key} className="flex items-center gap-2">
            <div className="w-20 shrink-0 truncate text-[11px] font-medium text-muted-foreground">{s.label}</div>
            <div className="relative h-6 min-w-0 flex-1 overflow-hidden rounded-md bg-secondary">
              <div
                className="h-full rounded-md bg-chart-1/80"
                style={{ width: `${Math.max(pct, s.value > 0 ? 1.5 : 0)}%` }}
              />
              <span className="absolute inset-y-0 left-2 flex items-center text-[11px] font-semibold tabular-nums text-foreground">
                {s.value.toLocaleString()}
              </span>
            </div>
            <div className="w-12 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
              {s.fromPrevious == null ? "" : formatRate(s.fromPrevious)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Activity calendar ────────────────────────────────────────────────────────

/**
 * One cell per day, shaded by relative volume.
 *
 * Five steps, not a continuous gradient: a rep reads "busy / quiet", not a
 * precise value, and a continuous ramp makes neighbouring days indistinguishable
 * while still failing contrast at the light end.
 */
export function ActivityCalendar({ days }: {
  days: readonly { date: string; value: number }[];
}) {
  if (days.length === 0) return <EmptyChart label="No days in this period" height={80} />;
  const max = Math.max(1, ...days.map((d) => d.value));
  const step = (v: number) => {
    if (v <= 0) return "bg-secondary";
    const r = v / max;
    if (r > 0.75) return "bg-chart-1";
    if (r > 0.5) return "bg-chart-1/75";
    if (r > 0.25) return "bg-chart-1/50";
    return "bg-chart-1/30";
  };
  return (
    <div className="flex flex-wrap gap-1" data-testid="chart-calendar">
      {days.map((d) => (
        <div
          key={d.date}
          className={`h-5 w-5 rounded ${step(d.value)}`}
          title={`${d.date}: ${d.value} doors`}
          aria-label={`${d.date}: ${d.value} doors`}
        />
      ))}
    </div>
  );
}

// ── Small helpers used by several views ──────────────────────────────────────

export function ChartFrame({ title, hint, children, action }: {
  title: string;
  hint?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-foreground">{title}</h3>
          {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

