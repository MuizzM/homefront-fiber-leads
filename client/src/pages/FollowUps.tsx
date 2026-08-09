// ── Follow-ups — the callbacks a rep owes ─────────────────────────────────────
// Closes the loop the OutcomeSheet opens: every scheduled callback surfaces here,
// grouped Overdue / Today / Upcoming (Apple Reminders / Todoist pattern). One tap
// opens the door; one more logs the outcome via the SAME shared sheet + offline
// queue, and the door drops off the list. 100% real data: GET /api/followups.
import { useMemo, useState } from "react";
import { FOCUS } from "@/lib/a11y";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useKnockLogger } from "@/lib/useKnockLogger";
import { OutcomeSheet, type SheetLead } from "@/components/OutcomeSheet";
import { EmptyState } from "@/components/EmptyState";
import { STATE_COLORS, pinDisplayState, todayISO } from "@shared/knock";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CalendarClock, ChevronRight, RefreshCw, WifiOff, CheckCircle2,
  Flame, Zap, StickyNote, Clock,
} from "lucide-react";


interface FollowUp {
  leadId: number; address: string; city: string; state?: string | null; zip?: string | null;
  lat?: number | null; lng?: number | null;
  leadStatus: string; leadTag?: string | null; leadScore?: number | null;
  contactName?: string | null; assignedRepId?: number | null;
  repId: number; callbackDate: string; callbackTime?: string | null; notes?: string | null; setAt: string;
}

// Friendly time: "5:00 PM" from "17:00"
function fmtTime(t?: string | null): string | null {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h)) return null;
  const ap = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m ?? 0).padStart(2, "0")} ${ap}`;
}

// Friendly date label relative to today: Today / Tomorrow / "Mon, Jul 14".
function fmtDay(iso: string, today: string): string {
  if (iso === today) return "Today";
  const d = new Date(iso + "T00:00:00");
  const t = new Date(today + "T00:00:00");
  const diff = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

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
  const groups = useMemo(() => {
    const list = [...(q.data ?? [])].sort((a, b) =>
      (a.callbackDate + (a.callbackTime ?? "99:99")).localeCompare(b.callbackDate + (b.callbackTime ?? "99:99")));
    return {
      overdue: list.filter(f => f.callbackDate < today),
      today: list.filter(f => f.callbackDate === today),
      upcoming: list.filter(f => f.callbackDate > today),
      total: list.length,
    };
  }, [q.data, today]);

  const offline = snap.online === false;

  return (
    <div className="min-h-full bg-background pb-24">
      <div className="mx-auto w-full max-w-lg px-4 pt-5">
        <header>
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <CalendarClock className="w-4 h-4 text-cyan-400" /> Follow-ups
          </div>
          <h1 className="text-[26px] font-bold tracking-tight text-foreground mt-0.5">Callbacks you owe</h1>
          {/* The one-glance read: how many owed, and whether any slipped. */}
          {!q.isLoading && !q.isError && groups.total > 0 && (
            <p className="text-[13px] text-muted-foreground mt-1" data-testid="followups-summary">
              <span className="font-semibold text-foreground tabular-nums">{groups.total}</span> scheduled
              {groups.overdue.length > 0 && <> · <span className="font-semibold text-rose-400 tabular-nums">{groups.overdue.length} overdue</span></>}
            </p>
          )}
        </header>

        {offline && (
          <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-border bg-muted px-3 py-2.5 text-[13px] text-muted-foreground">
            <WifiOff className="w-4 h-4 shrink-0" /> Offline - showing your last synced follow-ups
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
          <div className="mt-6 rounded-2xl border border-border bg-card p-6 text-center" data-testid="followups-error">
            <div className="text-[14px] font-semibold text-foreground">Couldn't load your follow-ups</div>
            <div className="text-[13px] text-muted-foreground mt-1">Check your connection and try again.</div>
            <button onClick={() => q.refetch()} className={`mt-4 inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-secondary border border-border text-[14px] font-semibold text-foreground active:scale-95 transition-transform hover:bg-secondary/70 ${FOCUS}`}>
              <RefreshCw className="w-4 h-4" aria-hidden="true" />Retry
            </button>
          </div>
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
        ) : (
          <div className="mt-5 space-y-5">
            {groups.overdue.length > 0 && (
              <Section title="Overdue" tone="text-rose-400" count={groups.overdue.length}>
                {groups.overdue.map(f => <Row key={f.leadId} f={f} today={today} overdue onOpen={() => navigate(`/lead/${f.leadId}`)} onLog={() => setSheet(f)} />)}
              </Section>
            )}
            {groups.today.length > 0 && (
              <Section title="Today" tone="text-cyan-400" count={groups.today.length}>
                {groups.today.map(f => <Row key={f.leadId} f={f} today={today} onOpen={() => navigate(`/lead/${f.leadId}`)} onLog={() => setSheet(f)} />)}
              </Section>
            )}
            {groups.upcoming.length > 0 && (
              <Section title="Upcoming" tone="text-muted-foreground" count={groups.upcoming.length}>
                {groups.upcoming.map(f => <Row key={f.leadId} f={f} today={today} onOpen={() => navigate(`/lead/${f.leadId}`)} onLog={() => setSheet(f)} />)}
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
            // The knock is durably queued (works offline), so reflect it here
            // immediately: a re-scheduled callback moves to its new date, any
            // other outcome drops the door off the list. Server reconciliation
            // after the queue flush re-syncs this cache with the truth.
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
  return { id: f.leadId, address: f.address, city: f.city, zip: f.zip, contactName: f.contactName, leadStatus: f.leadStatus, lastOutcome: "callback" };
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

function Row({ f, today, overdue, onOpen, onLog }: { f: FollowUp; today: string; overdue?: boolean; onOpen: () => void; onLog: () => void }) {
  const st = pinDisplayState({ leadStatus: f.leadStatus, visited: true, lastOutcome: "callback" } as any);
  const time = fmtTime(f.callbackTime);
  const hot = f.leadTag === "hot_lead";
  const newFiber = f.leadStatus === "new_fiber" || (f.leadScore ?? 0) >= 90;
  return (
    <div className="flex items-stretch">
      <button onClick={onOpen} data-testid={`followup-${f.leadId}`} className={`flex-1 min-w-0 flex items-center gap-3 px-4 py-3.5 text-left active:bg-secondary/60 transition-colors hover:bg-secondary/40 ${FOCUS}`}>
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: STATE_COLORS[st] }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-foreground truncate">{f.address}</span>
            {hot && <span className="shrink-0 text-2xs font-bold uppercase tracking-wide text-rose-400 bg-rose-500/15 rounded-full px-1.5 py-0.5 inline-flex items-center gap-0.5"><Flame className="w-2.5 h-2.5" />Hot</span>}
            {!hot && newFiber && <span className="shrink-0 text-cyan-400"><Zap className="w-3 h-3" /></span>}
          </div>
          <div className="text-[12px] text-muted-foreground truncate flex items-center gap-1.5">
            <span className={`inline-flex items-center gap-1 ${overdue ? "text-rose-400 font-medium" : ""}`}>
              <Clock className="w-3 h-3" />{fmtDay(f.callbackDate, today)}{time ? ` · ${time}` : ""}
            </span>
            {f.contactName ? <span className="truncate">· {f.contactName}</span> : null}
          </div>
          {f.notes ? <div className="text-[11.5px] text-muted-foreground/80 truncate mt-0.5 flex items-center gap-1"><StickyNote className="w-2.5 h-2.5 shrink-0" />{f.notes}</div> : null}
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
      </button>
      <button onClick={onLog} aria-label="Log outcome" data-testid={`followup-log-${f.leadId}`}
        className={`shrink-0 px-3 my-2 mr-2 rounded-lg bg-primary/10 text-primary text-[12px] font-semibold border border-primary/20 active:scale-95 transition-transform hover:bg-primary/15 ${FOCUS}`}>
        Log
      </button>
    </div>
  );
}
