import type { LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

// ── Shared KPI card ───────────────────────────────────────────────────────────
// One consistent stat card across the portal (Dashboard, Leads, …): a tinted icon
// chip, a colored top-accent hairline, the number, the label. `chip`/`accent`/
// `tone` are literal Tailwind class strings so the JIT keeps them in the bundle.
// `loading` swaps the value for a skeleton so cards can paint their frame instantly
// while the number streams in (no layout shift, no blocking spinner).
export function KpiTile({ label, value, tone, icon: Icon, chip, accent, className = "", loading = false }: {
  label: string;
  value: number | string;
  tone: string;      // text color, e.g. "text-emerald-400"
  icon: LucideIcon;
  chip: string;      // icon-chip bg tint, e.g. "bg-emerald-500/15"
  accent: string;    // top-accent bar bg, e.g. "bg-emerald-500"
  className?: string;
  loading?: boolean;
}) {
  return (
    <div
      className={`relative shrink-0 rounded-2xl bg-card border border-border px-3.5 pt-3.5 pb-3 overflow-hidden ${className}`}
      data-testid={`kpi-${String(label).toLowerCase().replace(/\s/g, "-")}`}
    >
      <span className={`absolute inset-x-0 top-0 h-[3px] ${accent}`} aria-hidden="true" />
      <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg mb-2.5 ${chip}`}>
        <Icon className={`w-4 h-4 ${tone}`} />
      </span>
      <div className={`text-[24px] font-bold leading-none tabular-nums ${tone}`}>
        {loading ? <Skeleton className="h-6 w-12" /> : value}
      </div>
      <div className="text-[11px] text-muted-foreground font-medium mt-1.5">{label}</div>
    </div>
  );
}
