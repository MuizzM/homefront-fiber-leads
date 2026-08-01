// ── Viewport-mode notice chip ────────────────────────────────────────────────
// ONE amber affordance for the two ways a bbox window can under-show pins:
//   - the window hit the server's 25k row cap ("Showing a sample — zoom in
//     for all pins"), or
//   - the view is zoomed out past the server's 3° span guard, so no window
//     was fetched at all ("Zoom in to load pins").
// Dismissible per condition — dismissal resets when the condition clears, so
// the next dense window (or the next zoom-out) warns again. Pure presentation:
// the map page owns the conditions and the dismiss state.
import { X, AlertTriangle } from "lucide-react";
import { FOCUS } from "@/lib/a11y";

export interface MapViewportNoticeProps {
  message: string;
  onDismiss: () => void;
  testId?: string;
}

export function MapViewportNotice({ message, onDismiss, testId = "map-viewport-notice" }: MapViewportNoticeProps) {
  return (
    <div
      role="status"
      data-testid={testId}
      style={{ top: "calc(env(safe-area-inset-top) + 3.25rem)" }}
      className="glass-capsule glass-opaque absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 pl-3 pr-1 h-9 max-w-[80vw] border border-amber-400/40"
    >
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-400" aria-hidden="true" />
      <span className="text-[12px] font-semibold text-amber-300 truncate whitespace-nowrap">
        {message}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notice"
        data-testid={`${testId}-dismiss`}
        className={`relative w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-amber-300/70 hover:text-amber-200 hover:bg-white/10 transition after:absolute after:-inset-2 ${FOCUS}`}
      >
        <X className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

export default MapViewportNotice;
