import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { FOCUS } from "@/lib/a11y";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FREEZE_REASON_LABELS, FREEZE_REASON_HELP,
  type FreezeReason, type TerritoryPassAction,
} from "@shared/territoryPass";

// "Knock this area again." The dialog's whole job is to make the consequences
// legible BEFORE the manager commits, because a pass reset clears outcomes an
// entire team recorded and there is no undo button for it.
//
// Two things it must never do:
//   - imply history is being deleted (it isn't — knocks are kept forever)
//   - hide that live callback commitments are about to be dropped
//
// Surface grammar matches ReclaimAllDialog exactly (scrim, z, card tokens):
// this dialog opens over the dark glass territory panel, and an off-token
// bg-background card rendered as a stark white sheet there in light theme.

export interface PassPreview {
  currentPass: number;
  nextPass: number;
  territoryName?: string;
  totals: { total: number; reset: number; frozen: number };
  frozenByReason: Partial<Record<FreezeReason, number>>;
  callbacksAtRisk: number;
  stats?: { knocks: number; sold: number; doorsAnswered: number } | null;
}

export interface StartNextPassDialogProps {
  open: boolean;
  territoryId: number;
  /** Loads the dry run. Injected so the dialog is testable without a network. */
  fetchPreview: (territoryId: number, keepPendingCallbacks: boolean) => Promise<PassPreview>;
  onConfirm: (opts: {
    territoryAction: TerritoryPassAction;
    newRepId?: number;
    keepPendingCallbacks: boolean;
    note?: string;
  }) => Promise<void> | void;
  onCancel: () => void;
  /** Reps who can take the area on, for the reassign option. */
  reps?: Array<{ id: number; name: string }>;
  busy?: boolean;
}

const ACTION_COPY: Record<TerritoryPassAction, { label: string; help: string }> = {
  keep: { label: "Same rep knocks it again", help: "The area stays assigned exactly as it is." },
  return_to_pool: { label: "Put the area back in the pool", help: "Unassigns everyone. You'll pick who gets it later." },
  reassign: { label: "Hand it to someone else", help: "Assigns the whole area to a different rep." },
};

export function StartNextPassDialog({
  open, territoryId, fetchPreview, onConfirm, onCancel, reps = [], busy = false,
}: StartNextPassDialogProps) {
  const [action, setAction] = useState<TerritoryPassAction>("keep");
  const [newRepId, setNewRepId] = useState<number | undefined>(undefined);
  const [keepCallbacks, setKeepCallbacks] = useState(false);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<PassPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-previews when the callback option changes, because that option moves
  // doors between the two columns — showing stale counts next to a toggle the
  // manager just flipped is how you get a confident click on wrong numbers.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError(null);
    fetchPreview(territoryId, keepCallbacks)
      .then(p => { if (!cancelled) setPreview(p); })
      .catch(e => { if (!cancelled) setError(e?.message ?? "Could not load the preview"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, territoryId, keepCallbacks, fetchPreview]);

  // Escape cancels, matching the scrim and the Cancel button — and stays locked
  // while the reset is committing, for the same reason they do.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const frozenEntries = Object.entries(preview?.frozenByReason ?? {})
    .filter(([, n]) => (n ?? 0) > 0) as Array<[FreezeReason, number]>;
  const canConfirm = !busy && !loading && !error && (action !== "reassign" || newRepId != null);

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="next-pass-title"
         data-testid="next-pass-dialog"
         className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center">
      {/* Scrim — same grammar as ReclaimAllDialog: a real button, so a tap
          outside the card is Cancel, not a dead zone. Locked while committing. */}
      <button
        type="button"
        aria-label="Close"
        onClick={onCancel}
        disabled={busy}
        data-testid="next-pass-scrim"
        className="absolute inset-0 bg-black/60"
      />

      <div
        data-testid="next-pass-card"
        className="relative w-full sm:max-w-md max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-border bg-card text-foreground p-5 shadow-xl animate-in fade-in slide-in-from-bottom-4 sm:slide-in-from-bottom-0 duration-200"
      >
        <div className="space-y-4">
          <header className="space-y-1">
            <h2 id="next-pass-title" className="text-lg font-semibold text-foreground flex items-center gap-2">
              
              Start pass {preview?.nextPass ?? "…"}
              {preview?.territoryName ? <span className="font-normal text-muted-foreground">· {preview.territoryName}</span> : null}
            </h2>
            <p className="text-sm text-muted-foreground">
              Doors that were already worked go back to unknocked so the area can be swept again.
              Everything that happened stays on record.
            </p>
          </header>

          {loading ? (
            // While the dry run loads: proper skeleton tiles in the exact slots
            // the real counts will occupy — never bare outlined boxes with
            // nothing in them, which read as a component that failed to render.
            <div role="status" className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Skeleton className="h-[76px] rounded-xl" data-testid="pass-preview-skeleton" />
                <Skeleton className="h-[76px] rounded-xl" data-testid="pass-preview-skeleton" />
              </div>
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                Working out what this will change…
              </p>
            </div>
          ) : error ? (
            <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground">
              {error}
            </div>
          ) : preview ? (
            <>
              {/* The two columns are the whole decision, so they lead. Zero is a
                  real answer and renders as 0 — never an empty tile. */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-border bg-secondary/40 p-3" data-testid="pass-reset-tile">
                  <div data-testid="pass-reset-count" className="text-2xl font-semibold tabular-nums text-foreground">
                    {preview.totals.reset}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {preview.totals.reset === 1 ? "door re-opens" : "doors re-open"}
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-secondary/40 p-3" data-testid="pass-frozen-tile">
                  <div className="text-2xl font-semibold tabular-nums text-foreground flex items-center gap-1.5" data-testid="pass-frozen-count">
                    
                    {preview.totals.frozen}
                  </div>
                  <div className="text-xs text-muted-foreground">left alone</div>
                </div>
              </div>

              {frozenEntries.length > 0 && (
                <ul className="space-y-1.5 text-sm">
                  {frozenEntries.map(([reason, n]) => (
                    <li key={reason} className="flex gap-2">
                      <span className="tabular-nums font-medium shrink-0">{n}</span>
                      <span>
                        <span className="font-medium">{FREEZE_REASON_LABELS[reason]}</span>
                        <span className="text-muted-foreground"> - {FREEZE_REASON_HELP[reason]}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {/* Never silently drop a promise a rep made to a homeowner. */}
              {preview.callbacksAtRisk > 0 && (
                <div role="alert" data-testid="pass-callbacks-tile"
                     className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground space-y-1">
                  <div className="flex gap-2">
                    
                    <span>
                      {preview.callbacksAtRisk === 1
                        ? "1 door has a callback scheduled that this will clear."
                        : `${preview.callbacksAtRisk} doors have callbacks scheduled that this will clear.`}
                    </span>
                  </div>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={keepCallbacks}
                      onChange={e => setKeepCallbacks(e.target.checked)}
                      className={`h-4 w-4 accent-[hsl(var(--primary))] ${FOCUS}`}
                    />
                    <span>Keep scheduled callbacks</span>
                  </label>
                </div>
              )}

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium mb-1">Who knocks it next?</legend>
                {(Object.keys(ACTION_COPY) as TerritoryPassAction[]).map(a => (
                  <label
                    key={a}
                    data-testid={`pass-action-row-${a}`}
                    className={`flex min-h-11 cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition-colors ${
                      action === a ? "border-primary bg-primary/[0.07]" : "border-border hover:border-primary/25"
                    }`}
                  >
                    <input
                      type="radio" name="territoryAction" value={a} checked={action === a}
                      onChange={() => setAction(a)}
                      data-testid={`pass-action-${a}`}
                      className={`mt-1 accent-[hsl(var(--primary))] ${FOCUS}`}
                    />
                    <span className="text-sm">
                      <span className="font-medium block text-foreground">{ACTION_COPY[a].label}</span>
                      <span className="text-muted-foreground">{ACTION_COPY[a].help}</span>
                    </span>
                  </label>
                ))}
                {action === "reassign" && (
                  <select
                    aria-label="Rep to hand the area to"
                    data-testid="pass-reassign-select"
                    className={`h-11 w-full rounded-lg border border-border bg-secondary px-3 text-sm text-foreground ${FOCUS}`}
                    value={newRepId ?? ""}
                    onChange={e => setNewRepId(e.target.value ? Number(e.target.value) : undefined)}
                  >
                    <option value="">Choose a rep…</option>
                    {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                )}
              </fieldset>

              <label className="block text-sm space-y-1">
                <span className="font-medium">Note <span className="text-muted-foreground font-normal">(optional)</span></span>
                <input value={note} onChange={e => setNote(e.target.value)} maxLength={500}
                       placeholder="e.g. Spring sweep done, revisit after the build-out"
                       data-testid="pass-note-input"
                       className={`h-11 w-full rounded-lg border border-border bg-secondary px-3 text-sm text-foreground placeholder:text-muted-foreground ${FOCUS}`} />
              </label>

              <p className="text-xs text-muted-foreground">
                Pass {preview.currentPass} stays in this area's history - every knock, who made it, and what came of it.
              </p>
            </>
          ) : null}

          <div className="flex gap-2.5 pt-1">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              data-testid="next-pass-cancel"
              className={`h-11 flex-1 rounded-xl border border-border bg-secondary text-sm font-semibold text-foreground transition-colors hover:bg-secondary/70 disabled:opacity-50 ${FOCUS}`}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canConfirm}
              data-testid="next-pass-confirm"
              onClick={() => onConfirm({
                territoryAction: action,
                newRepId: action === "reassign" ? newRepId : undefined,
                keepPendingCallbacks: keepCallbacks,
                note: note.trim() || undefined,
              })}
              className={`h-11 flex-1 rounded-xl bg-primary text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 inline-flex items-center justify-center gap-2 ${FOCUS}`}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {preview ? `Start pass ${preview.nextPass}` : "Start next pass"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default StartNextPassDialog;
