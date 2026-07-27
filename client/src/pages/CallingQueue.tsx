import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Clock3, PhoneCall, Search, ShieldAlert } from "lucide-react";
import { CallingAvailability, CallingChrome, CallingPageSkeleton, CallingUnknownState } from "@/components/calling/CallingChrome";
import { formatDecision, formatStage, getCallingQueue, getCallingStatus, getCallingCallbacks, type CallingCallback, type CallingCandidate } from "@/lib/callingApi";
import { cn } from "@/lib/utils";

const STAGE_FILTERS = [
  { value: "", label: "Open" },
  { value: "ELIGIBLE_MANUAL_CALL", label: "Eligible" },
  { value: "CALLBACK_SCHEDULED", label: "Callbacks" },
  { value: "COMPLIANCE_REVIEW", label: "Review" },
] as const;

function stageTone(stage: string): string {
  if (stage === "ELIGIBLE_MANUAL_CALL") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  if (stage === "COMPLIANCE_BLOCKED" || stage === "SUPPRESSED") return "border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-400";
  if (stage === "COMPLIANCE_REVIEW") return "border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400";
  if (stage === "CALLBACK_SCHEDULED") return "border-sky-500/25 bg-sky-500/10 text-sky-600 dark:text-sky-400";
  return "border-border bg-secondary text-muted-foreground";
}

/** Compact display names for common stages so pills stay one word on mobile;
 *  unknown stages fall back to the full humanized stage name. */
const STAGE_LABELS: Record<string, string> = {
  ELIGIBLE_MANUAL_CALL: "Eligible",
  CALLBACK_SCHEDULED: "Callback",
  COMPLIANCE_REVIEW: "Review",
  COMPLIANCE_BLOCKED: "Blocked",
  AWAITING_ENRICHMENT: "Enrichment",
  AWAITING_PHONE_VALIDATION: "Phone validation",
  AWAITING_DNC_CHECK: "DNC check",
  FRESH_FIBER_DETECTED: "Fresh fiber",
  SUPPRESSED: "Suppressed",
  ATTEMPTED: "Attempted",
  INTERESTED: "Interested",
  CONVERTED: "Converted",
};

function callbackDueLabel(dueAt: string, timeZone: string): string {
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) return "unscheduled";
  const now = Date.now();
  try {
    if (due < now) {
      const hrs = Math.floor((now - due) / 3_600_000);
      return hrs < 24 ? `${hrs || 1}h late` : `${Math.floor(hrs / 24)}d late`;
    }
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(due));
  } catch {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(due));
  }
}

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? formatStage(stage);
}

function stageDot(stage: string): string {
  if (stage === "ELIGIBLE_MANUAL_CALL") return "bg-emerald-500";
  if (stage === "COMPLIANCE_BLOCKED" || stage === "SUPPRESSED") return "bg-red-500";
  if (stage === "COMPLIANCE_REVIEW") return "bg-amber-500";
  if (stage === "CALLBACK_SCHEDULED") return "bg-sky-500";
  return "bg-muted-foreground/40";
}

function CandidateRow({ candidate }: { candidate: CallingCandidate }) {
  const eligible = candidate.queueStage === "ELIGIBLE_MANUAL_CALL";
  return (
    <li className="render-lazy">
      <Link href={`/calling/lead/${candidate.leadId}`} data-testid={`calling-lead-${candidate.leadId}`}
        className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-secondary/40 active:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60">
        <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", stageDot(candidate.queueStage))} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[13px] font-medium leading-5 text-foreground">{candidate.address}</span>
            <span className={cn("inline-flex max-w-[50%] shrink-0 items-center rounded-full border px-2 py-px text-2xs font-medium uppercase tracking-wide", stageTone(candidate.queueStage))}>
              <span className="truncate">{stageLabel(candidate.queueStage)}</span>
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">
            {candidate.city}, {candidate.state} {candidate.zip}
            {" "}<span aria-hidden="true">·</span> {candidate.contactName ?? "Not enriched"}
            {candidate.maskedPhone ? <> <span aria-hidden="true">·</span> <span className="font-mono text-[11px] tabular-nums">{candidate.maskedPhone}</span></> : null}
            {candidate.lastDecisionStatus ? <> <span aria-hidden="true">·</span> Last check: {formatDecision(candidate.lastDecisionStatus)}</> : null}
          </p>
        </div>
        {eligible
          ? <PhoneCall aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-primary" />
          : <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground/50 transition group-hover:translate-x-0.5 group-hover:text-muted-foreground" />}
      </Link>
    </li>
  );
}

const SKELETON_WIDTHS = ["w-2/5", "w-1/2", "w-1/3", "w-3/5", "w-2/5", "w-1/2"] as const;

function QueueRowsSkeleton() {
  return (
    <div role="status" aria-label="Loading calling queue" aria-busy="true" className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="border-b border-border px-4 py-2.5">
        <div className="app-skeleton my-0.5 h-3 w-28 rounded" />
      </div>
      <div className="divide-y divide-border/60">
        {SKELETON_WIDTHS.map((width, index) => (
          <div key={index} className="flex items-center gap-3 px-4 py-3">
            <div className="app-skeleton h-1.5 w-1.5 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className={cn("app-skeleton h-3.5 rounded", width)} />
              <div className="app-skeleton h-3 w-4/5 rounded" />
            </div>
            <div className="app-skeleton h-5 w-16 shrink-0 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricCell({ label, value, dot }: { label: string; value: number | null; dot?: string }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {dot && <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", dot)} />}
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold leading-6 tabular-nums text-foreground">{value ?? "—"}</div>
    </div>
  );
}

export default function CallingQueue() {
  const [stage, setStage] = useState("");
  const [search, setSearch] = useState("");
  const statusQuery = useQuery({
    queryKey: ["/api/v1/calling/status"],
    queryFn: getCallingStatus,
    staleTime: 15_000,
    retry: 1,
  });
  const queueQuery = useQuery({
    queryKey: ["/api/v1/calling/queue", stage],
    queryFn: () => getCallingQueue({ stage: stage || undefined, limit: 150 }),
    enabled: statusQuery.isSuccess,
    staleTime: 10_000,
    retry: 1,
  });
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return queueQuery.data ?? [];
    return (queueQuery.data ?? []).filter(item =>
      [item.address, item.city, item.state, item.zip, item.contactName].some(value => value?.toLowerCase().includes(needle)),
    );
  }, [queueQuery.data, search]);
  const eligible = (queueQuery.data ?? []).filter(item => item.queueStage === "ELIGIBLE_MANUAL_CALL").length;
  const callbacks = (queueQuery.data ?? []).filter(item => item.queueStage === "CALLBACK_SCHEDULED").length;
  // AUDIT FIX: real due-callbacks view (overdue/today/upcoming, in the stored
  // timezone) on the previously client-less endpoint.
  const callbacksQuery = useQuery({
    queryKey: ["/api/v1/calling/callbacks"],
    queryFn: () => getCallingCallbacks(100),
    enabled: statusQuery.isSuccess,
    staleTime: 30_000,
    retry: 1,
  });
  const callbackGroups = useMemo(() => {
    const rows = callbacksQuery.data ?? [];
    const now = Date.now();
    const overdue: CallingCallback[] = [];
    const today: CallingCallback[] = [];
    const upcoming: CallingCallback[] = [];
    const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
    for (const cb of rows) {
      const due = Date.parse(cb.dueAt);
      if (!Number.isFinite(due)) upcoming.push(cb);
      else if (due < now) overdue.push(cb);
      else if (due <= endOfToday.getTime()) today.push(cb);
      else upcoming.push(cb);
    }
    return { overdue, today, upcoming };
  }, [callbacksQuery.data]);

  return (
    <CallingChrome>
      <div className="flex-1 space-y-5 px-4 pb-24 pt-4 md:px-6 md:pb-8">
        {statusQuery.isLoading ? <CallingPageSkeleton /> : statusQuery.isError || !statusQuery.data ? (
          <CallingUnknownState retry={() => void statusQuery.refetch()} />
        ) : (
          <>
            <CallingAvailability status={statusQuery.data} />

            <section aria-label="Calling queue metrics" className="grid grid-cols-3 divide-x divide-border overflow-hidden rounded-2xl border border-border bg-card">
              <MetricCell label="Open" value={queueQuery.data?.length ?? null} />
              <MetricCell label="Eligible" value={queueQuery.data ? eligible : null} dot="bg-emerald-500" />
              <MetricCell label="Callbacks" value={queueQuery.data ? callbacks : null} dot="bg-sky-500" />
            </section>

            {(callbackGroups.overdue.length + callbackGroups.today.length) > 0 && (
              <section aria-label="Due callbacks" className="overflow-hidden rounded-2xl border border-sky-500/25 bg-card" data-testid="due-callbacks">
                <div className="border-b border-border px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-sky-600 dark:text-sky-400">
                  Due callbacks — {callbackGroups.overdue.length} overdue · {callbackGroups.today.length} today
                </div>
                <ul className="divide-y divide-border/60">
                  {[...callbackGroups.overdue, ...callbackGroups.today].slice(0, 8).map(cb => {
                    const overdue = Date.parse(cb.dueAt) < Date.now();
                    return (
                      <li key={cb.id}>
                        <Link href={`/calling/lead/${cb.leadId}`} className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-secondary/40">
                          <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${overdue ? "bg-red-500" : "bg-sky-500"}`} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-[13px] font-medium text-foreground">{cb.address}</span>
                              <span className={`shrink-0 text-2xs font-semibold uppercase tracking-wide ${overdue ? "text-red-500" : "text-sky-500"}`}>
                                {overdue ? "Overdue" : "Today"} · {callbackDueLabel(cb.dueAt, cb.timeZone)}
                              </span>
                            </div>
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                              {cb.city}, {cb.state} {cb.zip}
                              {cb.maskedPhone ? <> · <span className="font-mono text-[11px]">{cb.maskedPhone}</span></> : null}
                            </p>
                          </div>
                          <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground/50 transition group-hover:translate-x-0.5" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <div className="space-y-2.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search address or resident" aria-label="Search calling queue"
                  className="h-10 w-full rounded-xl border border-border bg-card pl-9 pr-3 text-[13px] text-foreground transition-colors placeholder:text-muted-foreground/70 focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-ring/30" />
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Filter calling queue">
                {STAGE_FILTERS.map(filter => (
                  <button key={filter.value} type="button" onClick={() => setStage(filter.value)} aria-pressed={stage === filter.value}
                    className={cn("inline-flex min-h-10 shrink-0 items-center rounded-full border px-4 text-xs font-medium transition-colors",
                      stage === filter.value
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border bg-card text-muted-foreground hover:bg-secondary/40 hover:text-foreground")}>
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>

            {queueQuery.isLoading ? <QueueRowsSkeleton /> : queueQuery.isError ? (
              <div role="alert" className="rounded-2xl border border-red-500/25 bg-card p-5 text-center">
                <span className="mx-auto grid h-9 w-9 place-items-center rounded-full bg-red-500/10">
                  <ShieldAlert aria-hidden="true" className="h-[18px] w-[18px] text-red-600 dark:text-red-400" />
                </span>
                <h2 className="mt-2.5 text-[13px] font-semibold text-foreground">Queue unavailable</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">No lead can be opened for calling while the queue is unknown.</p>
                <button type="button" onClick={() => void queueQuery.refetch()}
                  className="mt-4 min-h-10 rounded-xl border border-border bg-card px-4 text-[13px] font-semibold transition-colors hover:bg-secondary/60">Retry</button>
              </div>
            ) : filtered.length ? (
              <section aria-label="Calling queue" className="overflow-hidden rounded-2xl border border-border bg-card">
                <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-2.5">
                  <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Fresh-fiber leads</h2>
                  <span className="text-[11px] tabular-nums text-muted-foreground">{filtered.length}</span>
                </header>
                <ul className="divide-y divide-border/60">
                  {filtered.map(item => <CandidateRow key={item.queueId} candidate={item} />)}
                </ul>
              </section>
            ) : (
              <div className="rounded-2xl border border-dashed border-border p-8 text-center">
                <span className="mx-auto grid h-9 w-9 place-items-center rounded-full bg-secondary">
                  <Clock3 aria-hidden="true" className="h-[18px] w-[18px] text-muted-foreground" />
                </span>
                <h2 className="mt-2.5 text-[13px] font-semibold text-foreground">No leads in this view</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Fresh-fiber leads appear here only after the calling pipeline accepts them.</p>
              </div>
            )}
          </>
        )}
      </div>
    </CallingChrome>
  );
}
