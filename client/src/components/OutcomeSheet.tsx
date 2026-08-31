// ── OutcomeSheet — the one-tap disposition sheet (shared) ─────────────────────
// Used by Today and Property Detail so logging is identical — and now the SAME
// two-tier surface the map card carries: the four most likely reads as big
// color-coded cells (Sold emphasized), every other disposition as a compact
// status-coded disc in one scrollable strip, plus the appointment composer.
// One disposition vocabulary, one layout grammar, three surfaces.
//
// This sheet lives in the THEMED world (shadcn Sheet, semantic tokens), so the
// discs render on their "card" surface — chrome from --border/--ring, labels
// from the foreground scale — and hold AA in light and dark alike.
import { useState, useEffect } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  OUTCOME_META, pinDisplayState, todayISO,
  STATE_COLORS, DS_TO_OUTCOME, type KnockOutcome,
} from "@shared/knock";
import { X, CalendarPlus } from "lucide-react";
import { DispositionGrid } from "@/components/lead-sheet/OutcomeButton";
import { ProximityChip, useLiveProximity } from "@/components/ProximityChip";
import { QuickSlotRow } from "@/components/lead-sheet/QuickSlots";
import { describeAppointment } from "@shared/schedule";
import type { LogOpts } from "@/lib/useKnockLogger";


export interface SheetLead {
  id: number; address: string; city?: string | null; zip?: string | null;
  contactName?: string | null; leadStatus: string; visited?: boolean | number | null; lastOutcome?: string | null;
  // Door coordinates power the live proximity chip; optional so surfaces
  // without them (imports mid-geocode) simply render no chip.
  lat?: number | null; lng?: number | null;
}

export function OutcomeSheet({ lead, onClose, onLog }: {
  lead: SheetLead | null;
  onClose: () => void;
  onLog: (outcome: KnockOutcome, opts: LogOpts) => void;
}) {
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [apptOpen, setApptOpen] = useState(false);
  const [apptDate, setApptDate] = useState("");
  const [apptTime, setApptTime] = useState("");

  // Reset every time a new lead opens the sheet.
  useEffect(() => {
    if (lead) { setNote(""); setNoteOpen(false); setApptOpen(false); setApptDate(""); setApptTime(""); }
  }, [lead?.id]);

  const ds = lead ? pinDisplayState(lead) : null;
  const activeOutcome = ds ? (DS_TO_OUTCOME[ds] ?? null) : null;

  // Live rep-to-door distance — the same chip the map card carries, so a rep
  // logging from Today or Follow-ups sees the same honesty signal.
  const { repFix, locating, requestFix } = useLiveProximity(lead?.id);

  const fire = (o: KnockOutcome, schedule?: { callbackDate: string; callbackTime: string | null }) => {
    onLog(o, {
      notes: note.trim() || null,
      callbackDate: schedule?.callbackDate ?? null,
      callbackTime: schedule?.callbackTime ?? null,
    });
  };
  // A Go Back door keeps GB when scheduled; everything else becomes Follow-up —
  // the same rule as the map card, so the pin never changes meaning by surface.
  const apptOutcome: KnockOutcome = activeOutcome === "go_back" ? "go_back" : "follow_up";
  const commitAppointment = () => {
    if (!apptDate) return;
    fire(apptOutcome, { callbackDate: apptDate, callbackTime: apptTime || null });
  };

  return (
    <Sheet open={!!lead} onOpenChange={o => { if (!o) onClose(); }}>
      <SheetContent side="bottom" hideClose className="rounded-t-2xl border-border bg-card p-0 max-h-[92dvh] overflow-y-auto" data-testid="outcome-sheet">
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
              <ProximityChip leadId={lead.id} lat={lead.lat} lng={lead.lng} repFix={repFix} locating={locating} onRefresh={requestFix} />
              <button onClick={onClose} aria-label="Close" className="w-11 h-11 -mr-2 -mt-2 flex items-center justify-center text-muted-foreground"><X className="w-5 h-5" /></button>
            </div>

            {/* Every disposition as the same status disc, fixed order (the
                map card's surface in the themed tokens). The pressed disc
                mirrors the door's CURRENT state in place. */}
            <div className="px-5 pt-3 pb-1">
              <DispositionGrid
                data-testid="outcome-grid"
                surface="card"
                testIdPrefix="outcome-"
                activeOutcome={activeOutcome}
                onTap={key => fire(key)}
              />
            </div>

            {/* Appointment — a follow-up with a real date, exactly the map
                card's composer in the themed primitives. */}
            <div className="px-5 pt-3" data-testid="outcome-appointment">
              {!apptOpen ? (
                <Button
                  type="button"
                  variant="secondary"
                  data-testid="outcome-appt-open"
                  onClick={() => setApptOpen(true)}
                  className="h-11 rounded-full font-semibold"
                >
                  <CalendarPlus aria-hidden="true" className="w-4 h-4 mr-1.5" />
                  Set appointment
                </Button>
              ) : (
                <div data-testid="outcome-appt-editor" className="rounded-xl border border-border bg-secondary/50 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Appointment</span>
                    <button
                      type="button"
                      data-testid="outcome-appt-cancel"
                      onClick={() => setApptOpen(false)}
                      className="min-h-tap text-[12px] font-semibold text-muted-foreground hover:text-foreground transition px-1 -mr-1 -my-2"
                    >
                      Cancel
                    </button>
                  </div>
                  <QuickSlotRow
                    date={apptDate}
                    time={apptTime}
                    onPick={(slot) => { setApptDate(slot.date); setApptTime(slot.time); }}
                    surface="card"
                  />
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="flex-1 min-w-[150px]">
                      <Label htmlFor="outcome-appt-date" className="text-[11px] text-muted-foreground">Date</Label>
                      <Input
                        id="outcome-appt-date"
                        type="date"
                        data-testid="outcome-appt-date"
                        value={apptDate}
                        min={todayISO()}
                        onChange={e => setApptDate(e.target.value)}
                        className="mt-1 h-11 text-[16px] bg-background border-input"
                      />
                    </div>
                    <div className="w-[132px]">
                      <Label htmlFor="outcome-appt-time" className="text-[11px] text-muted-foreground">
                        Time <span className="font-normal opacity-70">(optional)</span>
                      </Label>
                      <Input
                        id="outcome-appt-time"
                        type="time"
                        data-testid="outcome-appt-time"
                        value={apptTime}
                        onChange={e => setApptTime(e.target.value)}
                        className="mt-1 h-11 text-[16px] bg-background border-input"
                      />
                    </div>
                    <Button
                      type="button"
                      data-testid="outcome-appt-save"
                      disabled={!apptDate}
                      onClick={commitAppointment}
                      className="ml-auto h-11 font-semibold"
                    >
                      {apptDate ? `Set for ${describeAppointment(apptDate, apptTime)}` : "Set"}
                    </Button>
                  </div>
                  <p className="mt-2 text-[11.5px] leading-snug text-muted-foreground">
                    Saves a {OUTCOME_META[apptOutcome].label} on this date. It lands on your Schedule, with a reminder 30 minutes before a timed visit.
                  </p>
                </div>
              )}
            </div>

            <div className="px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
              {noteOpen ? (
                <textarea autoFocus aria-label="Quick note" value={note} onChange={e => setNote(e.target.value)} rows={2}
                  placeholder="Quick note (optional)…" data-testid="outcome-note"
                  className="w-full rounded-xl bg-background border border-border px-3 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground resize-none focus:border-primary focus:outline-none" />
              ) : (
                <button type="button" onClick={() => setNoteOpen(true)} className="inline-flex min-h-tap items-center gap-1.5 text-[13px] text-muted-foreground font-medium">
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
