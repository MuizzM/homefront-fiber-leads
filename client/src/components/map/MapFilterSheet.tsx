// ── Field Map filters — the SalesRabbit-style bottom sheet, in our system ────
// Controlled and PURE presentation: the map page owns filter state; this sheet
// only renders it and reports taps. Status chips are the canonical pin palette
// (STATE_COLORS/STATE_LABELS from shared/knock — the map, legend, and this
// sheet can never disagree on a color or a word). Tapping the active chip or
// rep row toggles back to "all", so one thumb can always get out of a filter.
// Container/scrim grammar matches ReclaimAllDialog exactly.
import { X } from "lucide-react";
import { STATE_COLORS, STATE_LABELS } from "@shared/knock";
import { FOCUS } from "@/lib/a11y";

export interface MapFilterSheetProps {
  open: boolean;
  onClose: () => void;
  statusOrder: string[];
  statusCounts: Record<string, number>;
  activeStatus: string;
  onStatus: (s: string) => void;
  reps?: Array<{ id: number; name: string; count: number }>;
  unassignedCount?: number;
  activeRep: string;
  onRep: (r: string) => void;
  onClearAll: () => void;
  shown: number;
  total: number;
}

// Deterministic rep-dot palette — reps have no assigned color, so the dot is a
// stable visual anchor per id, drawn from the same hue family as the map pins.
const REP_DOT_CLASSES = [
  "bg-sky-400", "bg-emerald-400", "bg-amber-400", "bg-violet-400",
  "bg-rose-400", "bg-cyan-400", "bg-lime-400", "bg-fuchsia-400",
];

const EYEBROW = "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

export function MapFilterSheet({
  open, onClose, statusOrder, statusCounts, activeStatus, onStatus,
  reps, unassignedCount, activeRep, onRep, onClearAll, shown, total,
}: MapFilterSheetProps) {
  if (!open) return null;

  const colors = STATE_COLORS as Record<string, string>;
  const labels = STATE_LABELS as Record<string, string>;
  const filtered = activeStatus !== "all" || activeRep !== "all";

  const repRow = (key: string, name: string, count: number, dot: React.ReactNode) => {
    const active = activeRep === key;
    return (
      <button
        key={key}
        type="button"
        onClick={() => onRep(active ? "all" : key)}
        aria-pressed={active}
        data-testid={`map-filter-rep-${key}`}
        className={`w-full h-11 flex items-center gap-2.5 px-3 text-left transition-colors ${active ? "bg-primary/10" : "hover:bg-secondary/40"} ${FOCUS}`}
      >
        {dot}
        <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-foreground">{name}</span>
        <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{count}</span>
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="map-filter-title" data-testid="map-filter-sheet">
      {/* Scrim */}
      <button aria-label="Close" onClick={onClose} className={`absolute inset-0 bg-black/60 ${FOCUS}`} data-testid="map-filter-scrim" />

      <div className="relative w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-border bg-card p-5 shadow-xl animate-in fade-in slide-in-from-bottom-4 sm:slide-in-from-bottom-0 duration-200">
        {/* Header */}
        <div className="flex items-center gap-1.5">
          <h2 id="map-filter-title" className="flex-1 min-w-0 text-[16px] font-bold text-foreground leading-tight">Filters</h2>
          {filtered && (
            <button
              type="button"
              onClick={onClearAll}
              data-testid="map-filter-clear-all"
              className={`h-11 px-3 rounded-lg text-[13px] font-semibold text-primary hover:bg-primary/10 active:scale-95 transition ${FOCUS}`}
            >
              Clear all
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close filters"
            data-testid="map-filter-close"
            className={`w-11 h-11 -mr-2 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/70 active:scale-95 transition ${FOCUS}`}
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Status — the pin palette, tappable */}
        <div className="mt-4">
          <div className={EYEBROW}>Status</div>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {statusOrder.map((s) => {
              const selected = activeStatus === s;
              const color = colors[s] ?? "#64748b";
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => onStatus(selected ? "all" : s)}
                  aria-pressed={selected}
                  data-testid={`map-filter-status-${s}`}
                  className={`min-h-11 flex flex-col items-center gap-1 rounded-xl px-1 py-2 active:scale-95 transition ${selected ? "bg-secondary/60" : "hover:bg-secondary/40"} ${FOCUS}`}
                >
                  <span
                    className={`w-9 h-9 rounded-full ring-2 flex items-center justify-center ${selected ? "ring-offset-2 ring-offset-card" : ""}`}
                    style={{ "--tw-ring-color": color, backgroundColor: selected ? color : "transparent" } as React.CSSProperties}
                    aria-hidden="true"
                  >
                    <span className={`w-3 h-3 rounded-full ${selected ? "bg-card" : ""}`} style={selected ? undefined : { backgroundColor: color }} />
                  </span>
                  <span className="max-w-full truncate text-[11px] leading-tight text-foreground">{labels[s] ?? s}</span>
                  <span className="text-[11px] leading-none tabular-nums text-muted-foreground">{statusCounts[s] ?? 0}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Rep — only when the caller has reps to filter by */}
        {reps && (
          <div className="mt-4">
            <div className={EYEBROW}>Rep</div>
            <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-border divide-y divide-border">
              {repRow(
                "unassigned", "Unassigned", unassignedCount ?? 0,
                <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-muted-foreground/50" aria-hidden="true" />,
              )}
              {reps.map((r) =>
                repRow(
                  String(r.id), r.name, r.count,
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${REP_DOT_CLASSES[Math.abs(r.id) % REP_DOT_CLASSES.length]}`} aria-hidden="true" />,
                ),
              )}
            </div>
          </div>
        )}

        {/* Footer — what the filters currently leave on the map */}
        <p className="mt-4 text-center text-[12px] tabular-nums text-muted-foreground" data-testid="map-filter-summary">
          Showing {shown} of {total} doors
        </p>
      </div>
    </div>
  );
}

export default MapFilterSheet;
