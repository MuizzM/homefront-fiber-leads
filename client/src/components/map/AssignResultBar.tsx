// ── Assignment result bar ─────────────────────────────────────────────────────
// The structured record of what a bulk assignment just did, and the one place
// its undo lives. It replaces the old success toast, which any two subsequent
// toasts evicted - taking the only Undo affordance with it after 30 seconds,
// while the server honors the token for a full 10 minutes. The bar stays until
// the manager dismisses it (or undoes and reads the receipt), so "what
// happened, and can I take it back" survives the next three notifications.
import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { FOCUS } from "@/lib/a11y";

export interface AssignResultState {
  repName: string;
  updated: number;
  /** Doors the resolver refused to move (out of the caller's scope). */
  skipped: number;
  /** Doors already the target's - matched, deliberately untouched. */
  alreadyAssignedToTarget?: number;
  /** Doors that changed hands from OTHER reps - what makes this a reassignment. */
  movedFromOthers: number;
  undoToken?: string;
  /** Epoch ms; from the server's undoExpiresAt. */
  undoExpiresAt?: number;
  undoPending?: boolean;
  /** Set after a successful undo - the bar becomes the put-back receipt. */
  undone?: { restored: number; skipped: number };
  /** A failed undo spends the single-use token; there is no retry to offer. */
  undoError?: string | null;
}

function minutesLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60_000));
}

export function AssignResultBar({
  result,
  onUndo,
  onDismiss,
}: {
  result: AssignResultState;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  // Coarse clock for the undo window: a 30s tick keeps "N min" honest without
  // a per-second re-render, and flips the bar to "window ended" on expiry.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!result.undoToken || result.undone) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [result.undoToken, result.undone]);

  // Announce AFTER the live region exists in the DOM (a region inserted with
  // its text already present is silent on most screen readers).
  const [announced, setAnnounced] = useState("");
  const headline = result.undone
    ? `${result.undone.restored} put back${result.undone.skipped ? ` · ${result.undone.skipped} left as someone else moved them` : ""}`
    : `${result.updated} assigned to ${result.repName}${result.skipped ? ` · ${result.skipped} skipped (out of scope)` : ""}`;
  const announceRef = useRef(headline);
  announceRef.current = headline;
  useEffect(() => {
    const t = setTimeout(() => setAnnounced(announceRef.current), 80);
    return () => clearTimeout(t);
  }, [headline]);

  const expired = result.undoExpiresAt != null && result.undoExpiresAt <= now;
  const canUndo = !!result.undoToken && !result.undone && !result.undoError && !expired;
  const mins = result.undoExpiresAt != null ? minutesLeft(result.undoExpiresAt, now) : null;

  const detail = result.undone
    ? "Their previous owners have them again."
    : result.undoError
      ? result.undoError
      : expired && result.undoToken
        ? "The undo window has ended."
        : [
            result.movedFromOthers > 0
              ? `${result.movedFromOthers} changed hands from other reps`
              : result.updated > 0
                ? "All were unassigned before this"
                : null,
            (result.alreadyAssignedToTarget ?? 0) > 0
              ? `${result.alreadyAssignedToTarget} already theirs - untouched`
              : null,
            canUndo && mins != null ? `undo for ${mins} min` : null,
          ]
            .filter(Boolean)
            .join(" · ");

  return (
    <div
      data-testid="assign-result-bar"
      role="status"
      className="pointer-events-auto fixed inset-x-3 bottom-[max(1rem,env(safe-area-inset-bottom))] z-status mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-border bg-card p-3 pl-4 shadow-xl"
    >
      <span className="sr-only" aria-live="polite">{announced}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm-minus font-semibold text-foreground" data-testid="assign-result-headline">
          {headline}
        </div>
        {detail && (
          <div
            className={`mt-0.5 text-2xs ${result.undoError ? "text-destructive" : "text-muted-foreground"}`}
            data-testid="assign-result-detail"
          >
            {detail}
          </div>
        )}
      </div>
      {canUndo && (
        <button
          type="button"
          onClick={onUndo}
          disabled={result.undoPending}
          data-testid="assign-result-undo"
          className={`inline-flex min-h-tap shrink-0 items-center gap-1.5 rounded-xl border border-border bg-secondary px-3.5 text-xs font-semibold text-foreground transition-transform hover:bg-secondary/70 active:scale-95 disabled:opacity-60 ${FOCUS}`}
        >
          {result.undoPending && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          Undo
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss assignment result"
        data-testid="assign-result-dismiss"
        className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground ${FOCUS}`}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export default AssignResultBar;
