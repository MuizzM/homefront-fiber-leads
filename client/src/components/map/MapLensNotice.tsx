// ── Lens-hiding notice chip ──────────────────────────────────────────────────
// The map's source lens ("Latest fiber" by default) exists for speed: it drops
// the established FCC footprint import so a big org paints ~51k pins instead of
// ~174k. The cost is that it filters SILENTLY — an owner assigned a block of
// footprint doors to a rep, the rep opened the map, and the street was empty.
// Nothing was wrong with the assignment; the lens simply removed it, and a
// filtered map and an empty assignment look identical from the field.
//
// So whenever the active lens is hiding doors inside the viewer's own scope,
// this chip says how many and offers the one tap that shows them. Informational
// rather than alarming (the lens is a legitimate choice) — hence primary tint,
// not the amber of MapViewportNotice, which reports a real under-show.
import { EyeOff } from "lucide-react";
import { FOCUS } from "@/lib/a11y";

export interface MapLensNoticeProps {
  /** Doors the lens is suppressing in the caller's scope. Render only when > 0. */
  hiddenCount: number;
  /** Human name of the active lens, e.g. "Latest fiber". */
  lensLabel: string;
  /** Clear the lens — the map shows everything the viewer is allowed to see. */
  onShowAll: () => void;
  onDismiss: () => void;
  testId?: string;
}

export function MapLensNotice({
  hiddenCount, lensLabel, onShowAll, onDismiss, testId = "map-lens-notice",
}: MapLensNoticeProps) {
  if (hiddenCount <= 0) return null;
  const doors = `${hiddenCount.toLocaleString()} door${hiddenCount === 1 ? "" : "s"}`;
  return (
    <div
      role="status"
      data-testid={testId}
      style={{ top: "calc(env(safe-area-inset-top) + 3.25rem)" }}
      className="glass-capsule glass-opaque absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 pl-3 pr-1.5 h-9 max-w-[92vw] border border-primary/40"
    >
      <EyeOff className="w-3.5 h-3.5 shrink-0 text-primary" aria-hidden="true" />
      <span className="text-[12px] font-semibold text-foreground truncate whitespace-nowrap">
        {doors} hidden by {lensLabel}
      </span>
      <button
        type="button"
        onClick={onShowAll}
        data-testid={`${testId}-show-all`}
        className={`shrink-0 h-7 px-2.5 rounded-full bg-primary text-primary-foreground text-[11px] font-bold active:scale-95 transition ${FOCUS}`}
      >
        Show all
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notice"
        data-testid={`${testId}-dismiss`}
        className={`relative w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-white/10 transition after:absolute after:-inset-2 ${FOCUS}`}
      >
        <span aria-hidden="true" className="text-[15px] leading-none">×</span>
      </button>
    </div>
  );
}

export default MapLensNotice;
