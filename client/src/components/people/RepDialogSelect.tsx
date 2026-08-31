// ── Rep dialog select ────────────────────────────────────────────────────────
// The drop-in replacement for every `<select>` (or 300-item Radix Select) that
// enumerated the whole roster. A native select is fine for six names and
// unusable for three hundred: on iOS it becomes a full-screen wheel scrolled
// blind, on desktop an unsearchable dropdown. This keeps the call site's
// one-line ergonomics - a trigger where the select was - and opens the real
// picker (search past 8 reps, 60-row cap with an honest note, recents first)
// in a dialog that works identically on desktop and phone.
//
// The trigger inherits the site's existing data-testid, so muscle memory and
// test selectors keep pointing at the same control.
import { useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RepPicker, type RepOption } from "@/components/territory/RepPicker";
import { FOCUS } from "@/lib/a11y";

export interface RepDialogSelectProps {
  reps: RepOption[];
  /** Called with the picked rep; the dialog closes itself first. */
  onPick: (repId: number) => void;
  /** Text on the closed trigger - the same prompt the old select showed. */
  triggerLabel: string;
  /** Dialog heading; defaults to the trigger label. */
  title?: string;
  disabled?: boolean;
  /** The site's existing testid, kept on the trigger. */
  testId?: string;
  /** Mirrors the old control's aria-busy while a pick is saving. */
  busy?: boolean;
  /** Styling for the trigger so it sits where the old control sat. */
  triggerClassName?: string;
  value?: number | null;
  areaCounts?: Record<number, number>;
  /** When set, a row with this label appears above the list (e.g. "Unassigned")
   *  and picking it calls onNone - for controls whose old select had a null
   *  option. */
  noneLabel?: string;
  onNone?: () => void;
  /** Non-rep rows above the list ("All reps", "Unassigned") for filter-style
   *  controls whose old select had special values. */
  extraRows?: Array<{ key: string; label: string; active?: boolean; onPick: () => void }>;
}

export function RepDialogSelect({
  reps, onPick, triggerLabel, title, disabled = false, busy = false,
  testId, triggerClassName, value = null, areaCounts, noneLabel, onNone, extraRows,
}: RepDialogSelectProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-busy={busy || undefined}
        data-testid={testId}
        onClick={() => setOpen(true)}
        className={
          triggerClassName ??
          `inline-flex min-h-11 items-center justify-between gap-2 rounded-lg border border-border bg-secondary px-3 text-xs text-foreground disabled:opacity-50 ${FOCUS}`
        }
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm p-4">
          <DialogHeader>
            <DialogTitle className="text-base">{title ?? triggerLabel}</DialogTitle>
          </DialogHeader>
          {extraRows?.map((row) => (
            <button
              key={row.key}
              type="button"
              data-testid={`rep-dialog-extra-${row.key}`}
              onClick={() => { setOpen(false); row.onPick(); }}
              className={`w-full min-h-11 rounded-lg border px-3 text-left text-sm transition ${
                row.active ? "border-primary bg-primary/10" : "border-border text-muted-foreground hover:bg-secondary"
              } ${FOCUS}`}
            >
              {row.label}
            </button>
          ))}
          {noneLabel && (
            <button
              type="button"
              data-testid="rep-dialog-none"
              onClick={() => { setOpen(false); onNone?.(); }}
              className={`w-full min-h-11 rounded-lg border border-dashed border-border px-3 text-left text-sm text-muted-foreground hover:bg-secondary ${FOCUS}`}
            >
              {noneLabel}
            </button>
          )}
          <RepPicker
            reps={reps}
            value={value}
            areaCounts={areaCounts}
            onChange={(id) => {
              setOpen(false);
              onPick(id);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

export default RepDialogSelect;
