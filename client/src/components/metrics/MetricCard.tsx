// ── Metric card — a number that can explain itself ───────────────────────────
//
// The spec asks for a tooltip on every metric explaining exactly how it is
// calculated. This component takes a METRIC KEY, not a label and a tooltip
// string, and reads both from shared/repMetrics.METRIC_DEFS. That is what makes
// the promise keepable: the number and its explanation ship from one module, so
// changing a formula without updating its explanation is a change to one file
// that fails review rather than a stale sentence nobody notices for a year.
//
// The trend chip respects the metric's DIRECTION. A rising cancellation rate
// renders red, not green - compareToBaseline in the shared module owns that
// decision, and this component never re-derives it.

import { useState, type ReactNode } from "react";
import {
  compareToBaseline,
  formatDistance,
  formatDuration,
  formatPerHour,
  formatRate,
  METRIC_DEFS,
  metricTooltip,
} from "@shared/repMetrics";

/** Format a raw metric value according to its declared unit. One place decides,
 *  so a rate never renders as "0.24" on one screen and "24%" on another. */
export function formatMetric(key: string, value: number | null | undefined): string {
  const def = METRIC_DEFS[key];
  if (value == null || !Number.isFinite(value)) return "—";
  switch (def?.unit) {
    case "rate": return formatRate(value);
    case "seconds": return formatDuration(value);
    case "meters": return formatDistance(value);
    case "perHour": return formatPerHour(value);
    case "money": return `$${(value / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    default: return Math.round(value).toLocaleString();
  }
}

export function MetricCard({
  metricKey, value, baseline, baselineLabel, accent = false, footer,
}: {
  metricKey: string;
  value: number | null | undefined;
  /** What to compare against. Null renders no chip - an absent baseline is not
   *  a flat trend, and a grey "0%" would imply we measured something. */
  baseline?: number | null;
  baselineLabel?: string;
  accent?: boolean;
  footer?: ReactNode;
}) {
  const def = METRIC_DEFS[metricKey];
  const cmp = compareToBaseline(metricKey, value ?? null, baseline ?? null);
  // The explanation's open state lives HERE rather than inside the button, so
  // the expanded text can render as the LAST child of the card. Owned by the
  // button, it landed as the grid item straight after the label and pushed the
  // number itself below the paragraph - the one thing on the card nobody should
  // have to scroll past an explanation to read.
  const [whyOpen, setWhyOpen] = useState(false);
  const why = metricTooltip(metricKey);

  const chipTone = {
    up: "bg-success/15 text-success",
    down: "bg-destructive/15 text-destructive",
    neutral: "bg-secondary text-muted-foreground",
  }[cmp.tone];

  return (
    <div
      className={`grid grid-cols-[1fr_auto] items-start gap-x-2 rounded-2xl border border-border p-3.5 ${accent ? "bg-secondary" : "bg-card"}`}
      data-testid={`metric-${metricKey}`}
    >
      <span className="truncate text-[11px] font-medium text-muted-foreground">
        {def?.label ?? metricKey}
      </span>
      {/* A button, not a hover target: this is a phone-first product and a
          hover tooltip does not exist on a touch screen. Toggling inline also
          makes it keyboard reachable and screen-reader legible with no ARIA
          gymnastics. */}
      {why ? (
        <button
          type="button"
          onClick={() => setWhyOpen((v) => !v)}
          aria-expanded={whyOpen}
          aria-label={`How ${def?.label ?? metricKey} is calculated`}
          className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-border text-[10px] font-bold text-muted-foreground transition-colors hover:border-primary hover:text-primary"
          data-testid={`why-${metricKey}`}
        >
          ?
        </button>
      ) : <span />}

      <div className="col-span-full mt-1.5 flex flex-wrap items-baseline gap-2">
        <span className={`text-2xl font-bold leading-none tracking-tight tabular-nums ${accent ? "text-primary" : "text-foreground"}`}>
          {formatMetric(metricKey, value)}
        </span>
        {cmp.deltaRatio != null && (
          <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${chipTone}`}>
            {cmp.deltaRatio > 0 ? "+" : ""}{Math.round(cmp.deltaRatio * 100)}%
          </span>
        )}
      </div>

      {baselineLabel && baseline != null && (
        <div className="col-span-full mt-1 text-[11px] text-muted-foreground">
          {baselineLabel} {formatMetric(metricKey, baseline)}
        </div>
      )}
      {footer && <div className="col-span-full mt-1.5">{footer}</div>}

      {whyOpen && why && (
        <p className="col-span-full mt-2.5 whitespace-pre-line rounded-lg bg-secondary px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
          {why}
        </p>
      )}
    </div>
  );
}

/** A plain count with no baseline and no formula - used for raw tallies where a
 *  tooltip would say nothing the label does not already. */
export function CountCard({ label, value, tone = "neutral" }: {
  label: string;
  value: number | string;
  tone?: "neutral" | "primary" | "success" | "warning";
}) {
  const rail = {
    neutral: "bg-border", primary: "bg-primary", success: "bg-success", warning: "bg-warning",
  }[tone];
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card px-3.5 pb-3 pt-3.5"
         data-testid={`count-${String(label).toLowerCase().replace(/\s/g, "-")}`}>
      <span className={`absolute inset-x-0 top-0 h-[3px] ${rail}`} aria-hidden="true" />
      <div className="text-[26px] font-bold leading-none tracking-tight tabular-nums text-foreground">{value}</div>
      <div className="mt-1.5 text-[11px] font-medium text-muted-foreground">{label}</div>
    </div>
  );
}
