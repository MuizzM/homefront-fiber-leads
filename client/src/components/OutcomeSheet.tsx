// ── OutcomeSheet — the one-tap disposition sheet (shared) ─────────────────────
// Current field outcomes as big color-coded targets (Sold emphasized) plus an
// optional note. Used by Today and Property Detail so logging is identical.
import { useState, useEffect } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { FIELD_OUTCOMES, pinDisplayState, STATE_COLORS, type KnockOutcome } from "@shared/knock";
import { X } from "lucide-react";
import type { LogOpts } from "@/lib/useKnockLogger";

const GRID = FIELD_OUTCOMES;

export interface SheetLead {
  id: number; address: string; city?: string | null; zip?: string | null;
  contactName?: string | null; leadStatus: string; visited?: boolean | number | null; lastOutcome?: string | null;
}

export function OutcomeSheet({ lead, onClose, onLog }: {
  lead: SheetLead | null;
  onClose: () => void;
  onLog: (outcome: KnockOutcome, opts: LogOpts) => void;
}) {
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);

  // Reset every time a new lead opens the sheet.
  useEffect(() => {
    if (lead) { setNote(""); setNoteOpen(false); }
  }, [lead?.id]);

  const fire = (o: KnockOutcome) => {
    onLog(o, {
      notes: note.trim() || null,
      callbackDate: null,
      callbackTime: null,
    });
  };

  return (
    <Sheet open={!!lead} onOpenChange={o => { if (!o) onClose(); }}>
      <SheetContent side="bottom" className="rounded-t-2xl border-border bg-card p-0 max-h-[92dvh] overflow-y-auto" data-testid="outcome-sheet">
        {lead && (
          <div className="flex flex-col">
            <div className="flex items-start gap-3 px-5 pt-5 pb-3 border-b border-border">
              <span className="w-2.5 h-2.5 rounded-full mt-1.5 shrink-0" style={{ background: STATE_COLORS[pinDisplayState(lead)] }} />
              <div className="flex-1 min-w-0">
                {/* SheetTitle gives the dialog its accessible name — without it
                    a screen reader announced this sheet as just "dialog". */}
                <SheetTitle className="text-[16px] font-bold text-foreground leading-tight">{lead.address}</SheetTitle>
                <div className="text-[12px] text-muted-foreground">{lead.city}{lead.zip ? ` ${lead.zip}` : ""}{lead.contactName ? ` · ${lead.contactName}` : ""}</div>
              </div>
              <button onClick={onClose} aria-label="Close" className="w-11 h-11 -mr-2 -mt-2 flex items-center justify-center text-muted-foreground"><X className="w-5 h-5" /></button>
            </div>

            <div className="px-5 pt-4 pb-2 grid grid-cols-2 gap-2.5">
              {GRID.map(o => {
                const win = o.key === "sold";
                return (
                  <button
                    key={o.key} onClick={() => fire(o.key)} data-testid={`outcome-${o.key}`}
                    className="h-14 rounded-xl font-semibold text-[14px] flex items-center justify-center gap-2 active:scale-95 transition-transform border-2"
                    style={win
                      ? { background: o.color, color: "#04120d", borderColor: o.color }
                      // Text is the always-AA card-foreground; the outcome HUE is carried
                      // by a saturated dot + border, not the (low-contrast) text color.
                      : { background: `${o.color}1f`, color: "hsl(var(--card-foreground))", borderColor: `${o.color}99` }}
                  >
                    {win && null}
                    {!win && <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: o.color }} />}
                    {o.label}
                  </button>
                );
              })}
            </div>

            <div className="px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
              {noteOpen ? (
                <textarea autoFocus aria-label="Quick note" value={note} onChange={e => setNote(e.target.value)} rows={2}
                  placeholder="Quick note (optional)…" data-testid="outcome-note"
                  className="w-full rounded-xl bg-background border border-border px-3 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground resize-none focus:border-primary focus:outline-none" />
              ) : (
                <button onClick={() => setNoteOpen(true)} className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground font-medium">
                   Add a note
                </button>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
