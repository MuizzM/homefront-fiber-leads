// ── OutcomeSheet — the one-tap disposition sheet (shared) ─────────────────────
// The 7 real outcomes as big color-coded targets (Sold emphasized), an optional
// note, and — when Callback is chosen — an inline schedule (native date/time =
// zero typing on iOS). Used by Today and Property Detail so logging is identical
// everywhere. Pure UI: the parent owns the actual log via useKnockLogger.
import { useState, useEffect } from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { OUTCOMES, pinDisplayState, STATE_COLORS, type KnockOutcome } from "@shared/knock";
import { X, StickyNote, CheckCircle2, CalendarClock } from "lucide-react";
import type { LogOpts } from "@/lib/useKnockLogger";

const GRID = OUTCOMES.filter(o => o.key !== "needs_verification"); // 7 one-tap outcomes

export interface SheetLead {
  id: number; address: string; city?: string | null; zip?: string | null;
  contactName?: string | null; leadStatus: string; visited?: boolean | number | null; lastOutcome?: string | null;
}

function tomorrowISO(): string {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function OutcomeSheet({ lead, onClose, onLog }: {
  lead: SheetLead | null;
  onClose: () => void;
  onLog: (outcome: KnockOutcome, opts: LogOpts) => void;
}) {
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [cbOpen, setCbOpen] = useState(false);
  const [cbDate, setCbDate] = useState(tomorrowISO());
  const [cbTime, setCbTime] = useState("17:00");

  // Reset every time a new lead opens the sheet.
  useEffect(() => {
    if (lead) { setNote(""); setNoteOpen(false); setCbOpen(false); setCbDate(tomorrowISO()); setCbTime("17:00"); }
  }, [lead?.id]);

  const fire = (o: KnockOutcome) => {
    if (o === "callback" && !cbOpen) { setCbOpen(true); return; } // reveal the schedule first
    onLog(o, {
      notes: note.trim() || null,
      callbackDate: o === "callback" ? cbDate : null,
      callbackTime: o === "callback" ? cbTime : null,
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
                <div className="text-[16px] font-bold text-foreground leading-tight">{lead.address}</div>
                <div className="text-[12px] text-muted-foreground">{lead.city}{lead.zip ? ` ${lead.zip}` : ""}{lead.contactName ? ` · ${lead.contactName}` : ""}</div>
              </div>
              <button onClick={onClose} aria-label="Close" className="w-9 h-9 -mr-2 -mt-1 flex items-center justify-center text-muted-foreground"><X className="w-5 h-5" /></button>
            </div>

            <div className="px-5 pt-4 pb-2 grid grid-cols-2 gap-2.5">
              {GRID.map(o => {
                const win = o.key === "sold";
                const armed = o.key === "callback" && cbOpen;
                return (
                  <button
                    key={o.key} onClick={() => fire(o.key)} data-testid={`outcome-${o.key}`}
                    className="h-14 rounded-xl font-semibold text-[14px] flex items-center justify-center gap-2 active:scale-95 transition-transform border"
                    style={win
                      ? { background: o.color, color: "#04120d", borderColor: o.color }
                      : { background: `${o.color}${armed ? "33" : "1f"}`, color: o.color, borderColor: `${o.color}${armed ? "aa" : "55"}` }}
                  >
                    {win && <CheckCircle2 className="w-4 h-4" />}{o.key === "callback" && <CalendarClock className="w-4 h-4" />}{o.label}
                  </button>
                );
              })}
            </div>

            {/* Inline callback schedule — native pickers (no keyboard) */}
            {cbOpen && (
              <div className="mx-5 mt-2 rounded-xl border border-cyan-500/30 bg-cyan-500/[0.06] p-3" data-testid="callback-schedule">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-cyan-400 mb-2">Schedule the callback</div>
                <div className="flex gap-2">
                  <input type="date" value={cbDate} onChange={e => setCbDate(e.target.value)} data-testid="cb-date"
                    className="flex-1 min-w-0 rounded-lg bg-background border border-border px-3 py-2.5 text-[14px] text-foreground focus:border-cyan-500 focus:outline-none" />
                  <input type="time" value={cbTime} onChange={e => setCbTime(e.target.value)} data-testid="cb-time"
                    className="w-28 rounded-lg bg-background border border-border px-3 py-2.5 text-[14px] text-foreground focus:border-cyan-500 focus:outline-none" />
                </div>
                <button onClick={() => onLog("callback", { notes: note.trim() || null, callbackDate: cbDate, callbackTime: cbTime })}
                  data-testid="cb-confirm" className="mt-2.5 w-full h-11 rounded-lg font-semibold text-[14px] bg-cyan-500 text-[#04121a] active:scale-95 transition-transform">
                  Schedule callback
                </button>
              </div>
            )}

            <div className="px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
              {noteOpen ? (
                <textarea autoFocus value={note} onChange={e => setNote(e.target.value)} rows={2}
                  placeholder="Quick note (optional)…" data-testid="outcome-note"
                  className="w-full rounded-xl bg-background border border-border px-3 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground resize-none focus:border-primary focus:outline-none" />
              ) : (
                <button onClick={() => setNoteOpen(true)} className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground font-medium">
                  <StickyNote className="w-4 h-4" /> Add a note
                </button>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
