// ── Schedule — the appointments and callbacks a rep owes ──────────────────────
// Closes the loop the OutcomeSheet opens: every scheduled callback surfaces here.
// A week strip across the top shows where the bookings fall (one dot per booking
// in its status colour); the agenda below is time-first, the way a rep plans a
// day: Overdue / Today / Upcoming when today is selected, or a single day's
// bookings when another day in the strip is tapped. One tap opens the door; one
// more logs the outcome via the SAME shared sheet + offline queue, and the door
// drops off the list. 100% real data: GET /api/followups.
import { useEffect, useMemo, useState } from "react";
import { FOCUS } from "@/lib/a11y";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useKnockLogger } from "@/lib/useKnockLogger";
import { captureFieldFix } from "@/lib/geoFix";
import { OutcomeSheet, type SheetLead } from "@/components/OutcomeSheet";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { STATE_COLORS, pinDisplayState, todayISO, haversineMeters, distanceHint } from "@shared/knock";
import { weekOf, addDaysISO, type ScheduleFix } from "@shared/schedule";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronRight, CheckCircle2 } from "lucide-react";

interface FollowUp {
  leadId: number; address: string; city: string; state?: string | null; zip?: string | null;
  lat?: number | null; lng?: number | null;
  leadStatus: string; leadTag?: string | null; leadScore?: number | null;
  contactName?: string | null; assignedRepId?: number | null;
  repId: number; callbackDate: string; callbackTime?: string | null; notes?: string | null; setAt: string;
}

function fmtTime(t?: string | null): string | null {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h)) return null;
  const ap = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m ?? 0).padStart(2, "0")} ${ap}`;
}

function fmtDay(iso: string, today: string): string {
  if (iso === today) return "Today";
  const d = new Date(iso + "T00:00:00");
  const t = new Date(today + "T00:00:00");
  const diff = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function fmtMonthDay(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Sort key: date, then time (untimed bookings sink to the end of their day).
const sortKey = (f: FollowUp) => f.callbackDate + (f.callbackTime ?? "99:99");

export default function FollowUps() {
  const [, navigate] = useLocation();
  const { log, snap } = useKnockLogger();
  const qc = useQueryClient();
  const [sheet, setSheet] = useState<FollowUp | null>(null);

  const q = useQuery<FollowUp[]>({
    queryKey: ["/api/followups"],
    queryFn: () => apiRequest("GET", "/api/followups").then(r => r.json()),
    staleTime: 30_000,
  });

  const today = todayISO();
  const [selectedDay, setSelectedDay] = useState(today);
  const week = useMemo(() => weekOf(today), [today]);

  // One honest GPS fix for the "how far is this door" hint on each row. Read
  // once on open (not polled): the page is a plan, not a live tracker. Hidden
  // unless the fix is tight enough to mean something (300 m).
  const [fix, setFix] = useState<ScheduleFix | null>(null);
  useEffect(() => {
    let live = true;
    void captureFieldFix(3500).then(f => {
      if (!live) return;
      if (f.repLat == null || f.repLng == null) return;
      if (f.gpsAccuracy != null && f.gpsAccuracy > 300) return;
      setFix({ lat: f.repLat, lng: f.repLng });
    });
    return () => { live = false; };
  }, []);

  const list = useMemo(() => [...(q.data ?? [])].sort((a, b) => sortKey(a).localeCompare(sortKey(b))), [q.data]);
  const groups = useMemo(() => ({
    overdue: list.filter(f => f.callbackDate < today),
    today: list.filter(f => f.callbackDate === today),
    upcoming: list.filter(f => f.callbackDate > today),
    total: list.length,
  }), [list, today]);
  // Bookings per day for the strip's dots (status colour = the door's pin colour).
  const byDay = useMemo(() => {
    const m = new Map<string, FollowUp[]>();
    for (const f of list) m.set(f.callbackDate, [...(m.get(f.callbackDate) ?? []), f]);
    return m;
  }, [list]);

  const offline = snap.online === false;
  const dayView = selectedDay !== today;
  const dayRows = byDay.get(selectedDay) ?? [];

  const distanceFor = (f: FollowUp): string | null => {
    if (!fix || f.lat == null || f.lng == null) return null;
    return distanceHint(haversineMeters(fix, { lat: f.lat, lng: f.lng }));
  };
  const rowProps = (f: FollowUp) => ({
    f, today, distance: distanceFor(f),
    onOpen: () => navigate(`/lead/${f.leadId}`),
    onLog: () => setSheet(f),
  });

  return (
    <div className="min-h-full bg-background pb-24">
      <div className="mx-auto w-full max-w-lg px-4 pt-5">
        <header>
          <div className="text-[13px] text-muted-foreground" data-testid="schedule-week-label">
            Week of {fmtMonthDay(week[0])}
          </div>
          <h1 className="text-xl font-bold tracking-tight text-foreground mt-0.5">Appointments and callbacks</h1>
          {/* The one-glance read: how many owed, and whether any slipped. */}
          {!q.isLoading && !q.isError && groups.total > 0 && (
            <p className="text-[13px] text-muted-foreground mt-1" data-testid="followups-summary">
              <span className="font-semibold text-foreground tabular-nums">{groups.total}</span> scheduled
              {groups.overdue.length > 0 && <> · <span className="font-semibold text-destructive tabular-nums">{groups.overdue.length} overdue</span></>}
            </p>
          )}
        </header>

        {/* Week strip: seven days, one dot per booking in the door's status
            colour (capped at three so the row never grows). Tapping a day shows
            that day's agenda; tapping today restores the owed/today/upcoming view. */}
        {!q.isLoading && !q.isError && (
          <div role="tablist" aria-label={`Week of ${fmtMonthDay(week[0])}`} data-testid="schedule-week"
            className="mt-4 grid grid-cols-7 gap-1">
            {week.map((iso, i) => {
              const selected = iso === selectedDay;
              const isToday = iso === today;
              const dots = (byDay.get(iso) ?? []).slice(0, 3);
              return (
                <button key={iso} type="button" role="tab" aria-selected={selected} aria-label={fmtDay(iso, today)}
                  data-testid={`schedule-day-${iso}`}
                  onClick={() => setSelectedDay(iso)}
                  className={`flex min-h-tap flex-col items-center gap-[3px] rounded-xl border px-0 pt-1.5 pb-[7px] transition-colors ${FOCUS} ${
                    selected
                      ? "border-primary bg-primary"
                      : isToday ? "border-primary/40 bg-transparent hover:bg-secondary/60" : "border-transparent bg-transparent hover:bg-secondary/60"
                  }`}>
                  <span className={`text-[11px] font-semibold uppercase tracking-wide ${selected ? "text-primary-foreground/75" : "text-muted-foreground"}`}>{WEEKDAY[i]}</span>
                  <span className={`text-[15px] font-semibold tabular-nums ${selected ? "text-primary-foreground" : "text-foreground"}`}>{Number(iso.slice(8, 10))}</span>
                  <span className="flex h-[5px] gap-[2px]" aria-hidden="true">
                    {dots.map((f, j) => {
                      const st = pinDisplayState({ leadStatus: f.leadStatus, visited: true, lastOutcome: "callback" } as any);
                      return <span key={j} className="h-[5px] w-[5px] rounded-full" style={{ background: selected ? "hsl(var(--primary-foreground))" : STATE_COLORS[st] }} />;
                    })}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {offline && (
          <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-border bg-muted px-3 py-2.5 text-[13px] text-muted-foreground">
            Offline - showing your last synced follow-ups
          </div>
        )}

        {q.isLoading ? (
          <div className="mt-5 rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                <Skeleton className="w-2.5 h-2.5 rounded-full" />
                <div className="flex-1"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/3 mt-2" /></div>
              </div>
            ))}
          </div>
        ) : q.isError ? (
          <ErrorState
            testId="followups-error"
            title="Couldn't load your follow-ups"
            onRetry={() => q.refetch()}
            className="mt-6"
          />
        ) : groups.total === 0 ? (
          <div className="mt-6">
            <EmptyState
              testId="followups-empty"
              tone="positive"
              bordered
              icon={CheckCircle2}
              title="You're all caught up"
              description={'No callbacks scheduled. When you log "Follow-up" on a door, it shows up here so you never miss the second visit.'}
            />
          </div>
        ) : dayView ? (
          <div className="mt-5" data-testid="schedule-day-view">
            {dayRows.length > 0 ? (
              <Section title={fmtDay(selectedDay, today)} tone="text-info" count={dayRows.length}>
                {dayRows.map(f => <Row key={f.leadId} {...rowProps(f)} overdue={f.callbackDate < today} />)}
              </Section>
            ) : (
              <div className="rounded-xl border border-border bg-card px-4 py-5 text-center text-[13px] text-muted-foreground" data-testid="schedule-day-empty">
                Nothing booked for {fmtDay(selectedDay, today)}.
                <button type="button" onClick={() => setSelectedDay(today)}
                  className={`ml-2 inline-flex min-h-tap items-center font-semibold text-primary ${FOCUS}`}>
                  Back to today
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-5 space-y-5">
            {groups.overdue.length > 0 && (
              <Section title="Overdue" tone="text-destructive" count={groups.overdue.length}>
                {groups.overdue.map(f => <Row key={f.leadId} {...rowProps(f)} overdue />)}
              </Section>
            )}
            {groups.today.length > 0 && (
              <Section title="Today" tone="text-info" count={groups.today.length}>
                {groups.today.map(f => <Row key={f.leadId} {...rowProps(f)} />)}
              </Section>
            )}
            {groups.upcoming.length > 0 && (
              <Section title="Upcoming" tone="text-muted-foreground" count={groups.upcoming.length}>
                {groups.upcoming.map(f => <Row key={f.leadId} {...rowProps(f)} />)}
              </Section>
            )}
          </div>
        )}
      </div>

      <OutcomeSheet
        lead={sheet ? sheetLeadOf(sheet) : null}
        onClose={() => setSheet(null)}
        onLog={(outcome, opts) => {
          if (!sheet) return;
          const staged = log({ id: sheet.leadId, leadStatus: sheet.leadStatus, assignedRepId: sheet.assignedRepId }, outcome, opts);
          if (staged) {
            qc.setQueryData<FollowUp[]>(["/api/followups"], old => {
              if (!old) return old;
              return outcome === "callback" && opts.callbackDate
                ? old.map(f => f.leadId === sheet.leadId
                    ? { ...f, callbackDate: opts.callbackDate!, callbackTime: opts.callbackTime ?? null, notes: opts.notes ?? f.notes }
                    : f)
                : old.filter(f => f.leadId !== sheet.leadId);
            });
          }
          setSheet(null);
        }}
      />
    </div>
  );
}

function sheetLeadOf(f: FollowUp): SheetLead {
  return { id: f.leadId, address: f.address, city: f.city, zip: f.zip, contactName: f.contactName, leadStatus: f.leadStatus, lastOutcome: "callback", lat: f.lat, lng: f.lng };
}

function Section({ title, tone, count, children }: { title: string; tone: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className={`text-[11px] font-semibold uppercase tracking-wide ${tone}`}>{title}</h2>
        <span className="text-[11px] text-muted-foreground tabular-nums">{count}</span>
      </div>
      <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">{children}</div>
    </div>
  );
}

// Time-first row: the hour is the thing a rep plans around, so it leads; the
// status dot and address follow; the meta line carries the day (only when it
// is not the section's own day), who to ask for, and how far the door is.
function Row({ f, today, overdue, distance, onOpen, onLog }: {
  f: FollowUp; today: string; overdue?: boolean; distance: string | null; onOpen: () => void; onLog: () => void;
}) {
  const st = pinDisplayState({ leadStatus: f.leadStatus, visited: true, lastOutcome: "callback" } as any);
  const time = fmtTime(f.callbackTime);
  const hot = f.leadTag === "hot_lead";
  const newFiber = f.leadStatus === "new_fiber" || (f.leadScore ?? 0) >= 90;
  const meta: Array<{ key: string; node: React.ReactNode }> = [];
  if (f.callbackDate !== today) {
    meta.push({ key: "day", node: <span className={overdue ? "text-destructive font-medium" : ""}>{fmtDay(f.callbackDate, today)}</span> });
  }
  if (f.contactName) meta.push({ key: "name", node: <span className="break-words">{f.contactName}</span> });
  if (distance) meta.push({ key: "dist", node: <span className="tabular-nums" data-testid={`followup-distance-${f.leadId}`}>{distance}</span> });
  return (
    <div className="flex items-stretch">
      <button onClick={onOpen} data-testid={`followup-${f.leadId}`} className={`flex-1 min-w-0 flex items-center gap-3 px-4 py-3.5 text-left active:bg-secondary/60 transition-colors hover:bg-secondary/40 ${FOCUS}`}>
        <span className={`w-[62px] shrink-0 text-[13px] font-semibold leading-tight tabular-nums ${overdue ? "text-destructive" : time ? "text-foreground" : "text-muted-foreground"}`} data-testid={`followup-time-${f.leadId}`}>
          {time ?? "Any time"}
        </span>
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: STATE_COLORS[st] }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="line-clamp-2 text-[14px] font-semibold leading-snug text-foreground">{f.address}</span>
            {hot && <span className="shrink-0 text-2xs font-bold uppercase tracking-wide text-destructive bg-destructive/10 rounded-full px-1.5 py-0.5 inline-flex items-center gap-0.5">Hot</span>}
            {!hot && newFiber && <span className="shrink-0 text-2xs font-bold uppercase tracking-wide text-info bg-info/10 rounded-full px-1.5 py-0.5">New fiber</span>}
          </div>
          {meta.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
              {meta.map((m, i) => (
                <span key={m.key} className="inline-flex items-center gap-1.5">
                  {i > 0 && <span aria-hidden="true">·</span>}
                  {m.node}
                </span>
              ))}
            </div>
          )}
          {f.notes ? <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground/80">{f.notes}</div> : null}
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
      </button>
      <button onClick={onLog} aria-label="Log outcome" data-testid={`followup-log-${f.leadId}`}
        className={`shrink-0 min-h-tap px-3 my-2 mr-2 rounded-lg bg-primary/10 text-primary text-[12px] font-semibold border border-primary/20 active:scale-95 transition-transform hover:bg-primary/15 ${FOCUS}`}>
        Log
      </button>
    </div>
  );
}
