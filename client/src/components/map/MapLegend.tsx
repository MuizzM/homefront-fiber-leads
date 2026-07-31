// ── Pin-colors key — the rep's at-a-glance legend ────────────────────────────
// A compact, dismissible card that says what each pin color/glyph means, built
// verbatim from STATE_COLORS/STATE_LABELS via the caller (MapView passes the
// canonical display-state palette plus live counts), so this key, the map pins,
// and the Filters sheet can never disagree on a color or a word. Opt-in from
// the More menu — nothing new sits on the map at rest (minimal-chrome rule).
// Managers keep their richer "Legend & rep areas" panel; this is the field
// rep's (and new hire's) answer to "what does a yellow dot mean?".
import { X } from "lucide-react";
import { FOCUS } from "@/lib/a11y";

export interface MapLegendItem {
  key: string;
  label: string;
  /** Exact STATE_COLORS hex — the dot fallback when no glyph sprite exists. */
  color: string;
  count: number;
  /** Data-URL of the EXACT map glyph (spriteDataUrl) when glyph pins are on. */
  glyph?: string;
}

export interface MapLegendProps {
  open: boolean;
  onClose: () => void;
  items: MapLegendItem[];
  className?: string;
  style?: React.CSSProperties;
}

export function MapLegend({ open, onClose, items, className, style }: MapLegendProps) {
  if (!open) return null;

  return (
    <div
      role="region"
      aria-label="Pin colors"
      data-testid="map-legend"
      style={style}
      className={`w-[196px] rounded-xl border border-border bg-card/95 shadow-sm p-2.5 animate-in fade-in slide-in-from-bottom-1 duration-150 ${className ?? ""}`}
    >
      <div className="flex items-center justify-between gap-2 pl-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Pin colors
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close pin colors"
          data-testid="map-legend-close"
          className={`relative w-8 h-8 -my-1 -mr-1 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary/70 transition-colors after:absolute after:-inset-1.5 ${FOCUS}`}
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
      <ul className="mt-1">
        {items.map((it) => (
          <li
            key={it.key}
            data-testid={`map-legend-row-${it.key}`}
            className="flex items-center gap-2 h-7 px-1"
          >
            {it.glyph ? (
              <img
                src={it.glyph}
                alt=""
                aria-hidden="true"
                className="w-[16px] h-[16px] shrink-0"
              />
            ) : (
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: it.color }}
                aria-hidden="true"
              />
            )}
            <span className="flex-1 min-w-0 truncate text-[12px] text-foreground">
              {it.label}
            </span>
            <span
              className={`shrink-0 text-[11px] tabular-nums ${it.count > 0 ? "text-muted-foreground" : "text-muted-foreground/50"}`}
            >
              {it.count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default MapLegend;
