import { useEffect, useState } from "react";
import { AlertTriangle, Lock, RotateCcw, Loader2 } from "lucide-react";
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

  if (!open) return null;

  const frozenEntries = Object.entries(preview?.frozenByReason ?? {})
    .filter(([, n]) => (n ?? 0) > 0) as Array<[FreezeReason, number]>;
  const canConfirm = !busy && !loading && !error && (action !== "reassign" || newRepId != null);

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="next-pass-title"
         className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
      <div className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-background border shadow-xl">
        <div className="p-5 space-y-4">
          <header className="space-y-1">
            <h2 id="next-pass-title" className="text-lg font-semibold flex items-center gap-2">
              <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" />
              Start pass {preview?.nextPass ?? "…"}
              {preview?.territoryName ? <span className="font-normal text-muted-foreground">· {preview.territoryName}</span> : null}
            </h2>
            <p className="text-sm text-muted-foreground">
              Doors that were already worked go back to unknocked so the area can be swept again.
              Everything that happened stays on record.
            </p>
          </header>

          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Working out what this will change…
            </div>
          ) : error ? (
            <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
              {error}
            </div>
          ) : preview ? (
            <>
              {/* The two columns are the whole decision, so they lead. */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border p-3">
                  <div className="text-2xl font-semibold tabular-nums">{preview.totals.reset}</div>
                  <div className="text-xs text-muted-foreground">
                    {preview.totals.reset === 1 ? "door re-opens" : "doors re-open"}
                  </div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-2xl font-semibold tabular-nums flex items-center gap-1.5">
                    <Lock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
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
                        <span className="text-muted-foreground"> — {FREEZE_REASON_HELP[reason]}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {/* Never silently drop a promise a rep made to a homeowner. */}
              {preview.callbacksAtRisk > 0 && (
                <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm space-y-2">
                  <div className="flex gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
                    <span>
                      {preview.callbacksAtRisk === 1
                        ? "1 door has a callback scheduled that this will clear."
                        : `${preview.callbacksAtRisk} doors have callbacks scheduled that this will clear.`}
                    </span>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={keepCallbacks}
                           onChange={e => setKeepCallbacks(e.target.checked)} />
                    <span>Keep scheduled callbacks</span>
                  </label>
                </div>
              )}

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium mb-1">Who knocks it next?</legend>
                {(Object.keys(ACTION_COPY) as TerritoryPassAction[]).map(a => (
                  <label key={a} className="flex gap-2.5 items-start rounded-lg border p-2.5 cursor-pointer has-[:checked]:border-primary">
                    <input type="radio" name="territoryAction" value={a} checked={action === a}
                           onChange={() => setAction(a)} className="mt-1" />
                    <span className="text-sm">
                      <span className="font-medium block">{ACTION_COPY[a].label}</span>
                      <span className="text-muted-foreground">{ACTION_COPY[a].help}</span>
                    </span>
                  </label>
                ))}
                {action === "reassign" && (
                  <select
                    aria-label="Rep to hand the area to"
                    className="w-full rounded-lg border p-2 text-sm bg-background"
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
                       className="w-full rounded-lg border p-2 bg-background" />
              </label>

              <p className="text-xs text-muted-foreground">
                Pass {preview.currentPass} stays in this area's history — every knock, who made it, and what came of it.
              </p>
            </>
          ) : null}

          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onCancel} disabled={busy}
                    className="rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50">
              Cancel
            </button>
            <button
              type="button"
              disabled={!canConfirm}
              onClick={() => onConfirm({
                territoryAction: action,
                newRepId: action === "reassign" ? newRepId : undefined,
                keepPendingCallbacks: keepCallbacks,
                note: note.trim() || undefined,
              })}
              className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium disabled:opacity-50 inline-flex items-center gap-2"
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
