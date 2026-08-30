import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { CallingAvailability, CallingChrome, CallingUnknownState } from "@/components/calling/CallingChrome";
import { formatDecision, formatStage, getCallingQueue, getCallingStatus, getCallingCallbacks, startQueueTrace, getLatestQueueTraceRun, type CallingCallback, type CallingCandidate } from "@/lib/callingApi";
import { cn } from "@/lib/utils";
import { useTabActive } from "@/lib/tabActivity";
import { useCan } from "@/lib/capabilities";
import { useToast } from "@/hooks/use-toast";

const STAGE_FILTERS = [
  { value: "", label: "All" },
  { value: "ELIGIBLE_MANUAL_CALL", label: "Eligible" },
  { value: "CALLBACK_SCHEDULED", label: "Callbacks" },
  { value: "COMPLIANCE_BLOCKED", label: "Blocked" },
  { value: "COMPLIANCE_REVIEW", label: "Review" },
] as const;

function stageTone(stage: string): string {
  if (stage === "ELIGIBLE_MANUAL_CALL") return "border-emerald-500/25 bg-emerald-500/10 text-success";
  if (stage === "COMPLIANCE_BLOCKED" || stage === "SUPPRESSED") return "border-red-500/25 bg-red-500/10 text-destructive";
  if (stage === "COMPLIANCE_REVIEW") return "border-amber-500/25 bg-amber-500/10 text-warning";
  if (stage === "CALLBACK_SCHEDULED") return "border-sky-500/25 bg-sky-500/10 text-info";
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

/**
 * One traced door.
 *
 * The badge is the SCRUB verdict, not an authorization — a rep still gets the
 * full compliance evaluation when they open the lead. A blocked row stays
 * visible and inert rather than being dropped: the household is still a door
 * worth knocking, and a rep who cannot see that the number was suppressed
 * learns to distrust an empty list instead of the badge.
 */
function TracedRow({ candidate }: { candidate: CallingCandidate }) {
  const ready = candidate.tracedBadge?.ready ?? false;
  return (
    <li className="render-lazy">
      <Link href={`/calling/lead/${candidate.leadId}`} data-testid={`traced-lead-${candidate.leadId}`}
        aria-label={`${candidate.address} - ${candidate.tracedBadge?.label ?? "Traced"}`}
        className={cn("group flex items-center gap-3 px-4 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
          ready ? "hover:bg-secondary/40 active:bg-secondary/60" : "opacity-60 hover:bg-secondary/20")}>
        <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", ready ? "bg-emerald-500" : "bg-red-500")} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[13px] font-medium leading-5 text-foreground">{candidate.address}</span>
            <span className={cn("inline-flex max-w-[55%] shrink-0 items-center rounded-full border px-2 py-px text-2xs font-medium uppercase tracking-wide",
              ready ? "border-emerald-500/25 bg-emerald-500/10 text-success"
                : "border-red-500/25 bg-red-500/10 text-destructive")}>
              <span className="truncate">{ready ? "Ready to dial" : "Blocked"}</span>
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">
            {candidate.city}, {candidate.state} {candidate.zip}
            {" "}<span aria-hidden="true">·</span> {candidate.contactName ?? "Name not traced"}
            {candidate.maskedPhone ? <> <span aria-hidden="true">·</span> <span className="font-mono text-[11px] tabular-nums">{candidate.maskedPhone}</span></> : null}
          </p>
          {!ready && candidate.tracedBadge ? (
            <p className="mt-0.5 truncate text-[11px] leading-4 text-destructive">{candidate.tracedBadge.label}</p>
          ) : null}
        </div>
        {ready
          ? null
          : null}
      </Link>
    </li>
  );
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
            {" "}<span aria-hidden="true">·</span> {candidate.contactName ?? (candidate.maskedPhone ? "Name unknown" : "Not traced")}
            {candidate.maskedPhone ? <> <span aria-hidden="true">·</span> <span className="font-mono text-[11px] tabular-nums">{candidate.maskedPhone}</span></> : null}
            {candidate.lastDecisionStatus ? (
              Number.isFinite(Date.parse(candidate.lastDecisionExpiresAt ?? "")) && Date.parse(candidate.lastDecisionExpiresAt ?? "") <= Date.now()
                ? <> <span aria-hidden="true">·</span> <span className="text-amber-500">Last check expired</span></>
                : <> <span aria-hidden="true">·</span> Last check: {formatDecision(candidate.lastDecisionStatus)}</>
            ) : null}
          </p>
        </div>
        {eligible
          ? null
          : null}
      </Link>
    </li>
  );
}

// Rows the list asks the server for. The counts fetch above it takes the
// server's 250-row cap; the list shows the first 150 of that same ordering.
const QUEUE_LIST_LIMIT = 150;

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
      <div className="mt-1 text-lg font-semibold leading-6 tabular-nums text-foreground">{value ?? " - "}</div>
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
  // Every panel below fetches IN PARALLEL with the status check — the old
  // `enabled: statusQuery.isSuccess` gates serialized two network round trips
  // in front of every cold open of this tab (status, THEN everything else),
  // which is exactly the "tab shows a skeleton for seconds" complaint on
  // field connections. Status still gates what calling ACTIONS are allowed —
  // that enforcement is server-side and per-dial — but reading the queue was
  // never conditional on it. (The queue endpoint's sync is debounced
  // server-side, so the parallel reads share one scan.)
  //
  // Chip counts come from an UNFILTERED queue fetch — deriving them from the
  // stage-filtered result would zero out every other chip's count.
  const countsQuery = useQuery({
    queryKey: ["/api/v1/calling/queue", "counts", "fiber"],
    // Fiber-only, matching the list these chips filter — counting traced doors
    // here would put a number on the chip that the list below can never reach.
    queryFn: () => getCallingQueue({ limit: 250, source: "fiber" }), // server cap — chips must not undercount
    staleTime: 10_000,
    retry: 1,
  });
  // Fiber-only, like the counts above: traced doors get their own section, and
  // a lead that is both would otherwise render twice under two orderings.
  //
  // With no chip selected the list IS the head of the counts fetch: same
  // endpoint, same source, same server ordering, just a shorter limit. Asking
  // for it a second time re-ran the queue's server-side sync for rows we were
  // already holding — so on the "All" view the list is sliced off the counts
  // data (never a client-side stage filter, which would diverge from the
  // server's own stage query past the 250-row cap), and this fetch only runs
  // when a stage chip is actually selected. Coming back to "All" is then
  // instant and fetch-free.
  const queueQuery = useQuery({
    queryKey: ["/api/v1/calling/queue", stage, "fiber"],
    queryFn: () => getCallingQueue({ stage: stage || undefined, limit: QUEUE_LIST_LIMIT, source: "fiber" }),
    enabled: stage !== "",
    staleTime: 10_000,
    retry: 1,
  });
  // Loading/error/retry for the list follow whichever query is feeding it.
  const listQuery = stage === "" ? countsQuery : queueQuery;
  const listRows = useMemo(
    () => (stage === "" ? countsQuery.data?.slice(0, QUEUE_LIST_LIMIT) : queueQuery.data),
    [stage, countsQuery.data, queueQuery.data],
  );
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return listRows ?? [];
    return (listRows ?? []).filter(item =>
      [item.address, item.city, item.state, item.zip, item.contactName].some(value => value?.toLowerCase().includes(needle)),
    );
  }, [listRows, search]);
  const chipCounts = useMemo(() => {
    const rows = countsQuery.data;
    if (!rows) return null;
    const count = (stage: string) => rows.filter(item => item.queueStage === stage).length;
    return {
      "": rows.length,
      ELIGIBLE_MANUAL_CALL: count("ELIGIBLE_MANUAL_CALL"),
      CALLBACK_SCHEDULED: count("CALLBACK_SCHEDULED"),
      COMPLIANCE_BLOCKED: count("COMPLIANCE_BLOCKED"),
      COMPLIANCE_REVIEW: count("COMPLIANCE_REVIEW"),
    } as Record<string, number>;
  }, [countsQuery.data]);
  const eligible = chipCounts?.ELIGIBLE_MANUAL_CALL ?? 0;
  const callbacks = chipCounts?.CALLBACK_SCHEDULED ?? 0;
  // AUDIT FIX: real due-callbacks view (overdue/today/upcoming, in the stored
  // timezone) on the previously client-less endpoint.
  const callbacksQuery = useQuery({
    queryKey: ["/api/v1/calling/callbacks"],
    queryFn: () => getCallingCallbacks(100),
    staleTime: 30_000,
    retry: 1,
  });
  // Skip-traced doors, tenant-wide. A separate fetch rather than a slice of the
  // main queue: these are ranked by whether the scrub cleared them, not by the
  // queue stage, and mixing the two orderings made both unreadable.
  const tracedQuery = useQuery({
    queryKey: ["/api/v1/calling/queue", "traced"],
    queryFn: () => getCallingQueue({ source: "traced", limit: 250 }),
    staleTime: 10_000,
    retry: 1,
  });
  const tracedLeads = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rows = (tracedQuery.data ?? []).filter(item => !needle
      || [item.address, item.city, item.state, item.zip, item.contactName].some(value => value?.toLowerCase().includes(needle)));
    // Dialable first, then by address so the order is stable across refetches.
    return [...rows].sort((a, b) =>
      Number(b.tracedBadge?.ready ?? false) - Number(a.tracedBadge?.ready ?? false)
      || a.address.localeCompare(b.address));
  }, [tracedQuery.data, search]);
  const tracedReady = useMemo(
    () => tracedLeads.filter(item => item.tracedBadge?.ready).length,
    [tracedLeads],
  );

  // ── Bulk tracing ──────────────────────────────────────────────────────────
  // Tracing spends provider budget, so it rides lead.skip_trace.request - the
  // same permission as an area trace - not a calling.* capability. A rep who
  // may dial is not automatically someone who may spend.
  const canTrace = useCan("lead.skip_trace.request");
  const { toast } = useToast();
  // /calling is a keep-alive stage: this page stays mounted (hidden) after a
  // visit, so an ungated interval kept polling every 4s from the background
  // for the life of a run. Gate on tab activity like Dashboard and MapView;
  // the keep-alive re-show revalidation catches up the moment the rep returns.
  const tabActive = useTabActive();
  const traceRunQuery = useQuery({
    queryKey: ["calling", "trace-run"],
    queryFn: getLatestQueueTraceRun,
    enabled: canTrace,
    // Only while a run is live: a finished run's row never changes again.
    refetchInterval: (query) => {
      if (!tabActive) return false;
      const status = query.state.data?.run?.status;
      return status === "queued" || status === "running" ? 4_000 : false;
    },
  });
  const activeRun = traceRunQuery.data?.run
    && ["queued", "running"].includes(traceRunQuery.data.run.status)
    ? traceRunQuery.data.run : null;
  const traceLimit = traceRunQuery.data?.limit ?? 100;
  const traceMutation = useMutation({
    mutationFn: (leadIds: number[]) => startQueueTrace(leadIds),
    onSuccess: (result) => {
      void traceRunQuery.refetch();
      toast({ title: `Tracing ${result.run.requestedLeads} door${result.run.requestedLeads === 1 ? "" : "s"}`,
        description: "This runs in the background. Numbers appear as they come back." });
    },
    onError: (error: Error) => toast({ title: "Couldn't start the trace", description: error.message, variant: "destructive" }),
  });

  // A door with no number is the only thing worth tracing.
  const untraced = useMemo(
    () => (listQuery.data ?? []).filter(candidate => !candidate.maskedPhone),
    [listQuery.data],
  );

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
    <CallingChrome pageTitle>
      <div className="flex-1 space-y-5 px-4 pb-24 pt-4 md:px-6 md:pb-8">
        {/* Layout-first: the tab frame renders immediately and each section
            carries its own small loading state. The whole-page CallingPageSkeleton
            gate is gone — it blanked the entire tab for the status round trip on
            every cold open. A hard status ERROR (with nothing cached) still takes
            over the content area: calling stays locked until compliance answers. */}
        {statusQuery.isError && !statusQuery.data ? (
          <CallingUnknownState retry={() => void statusQuery.refetch()} />
        ) : (
          <>
            {statusQuery.data ? <CallingAvailability status={statusQuery.data} /> : (
              <div className="app-skeleton h-24 rounded-2xl bg-muted" data-testid="calling-status-loading"
                aria-busy="true" aria-label="Checking calling status" />
            )}

            <section aria-label="Calling queue metrics" className="grid grid-cols-3 divide-x divide-border overflow-hidden rounded-2xl border border-border bg-card">
              <MetricCell label="Open" value={chipCounts ? chipCounts[""] : null} />
              <MetricCell label="Eligible" value={chipCounts ? eligible : null} dot="bg-emerald-500" />
              <MetricCell label="Callbacks" value={chipCounts ? callbacks : null} dot="bg-sky-500" />
            </section>

            {(callbackGroups.overdue.length + callbackGroups.today.length) > 0 && (
              <section aria-label="Due callbacks" className="overflow-hidden rounded-2xl border border-sky-500/25 bg-card" data-testid="due-callbacks">
                <div className="border-b border-border px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-info">
                  Due callbacks - {callbackGroups.overdue.length} overdue · {callbackGroups.today.length} today
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
                          
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <div className="space-y-2.5">
              <div className="relative">
                
                <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search address or resident" aria-label="Search calling queue"
                  className="h-11 md:h-9 w-full rounded-xl border border-border bg-card pl-9 pr-3 text-[13px] text-foreground transition-colors placeholder:text-muted-foreground/70 focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-ring/30" />
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Filter calling queue">
                {STAGE_FILTERS.map(filter => {
                  const count = chipCounts?.[filter.value];
                  return (
                    <button key={filter.value} type="button" onClick={() => setStage(filter.value)} aria-pressed={stage === filter.value}
                      data-testid={`stage-chip-${filter.value || "all"}`}
                      className={cn("inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-4 text-xs font-medium transition-colors",
                        stage === filter.value
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border bg-card text-muted-foreground hover:bg-secondary/40 hover:text-foreground")}>
                      {filter.label}
                      {typeof count === "number" && (
                        <span className={cn("inline-flex min-w-5 items-center justify-center rounded-full px-1 text-2xs font-semibold tabular-nums",
                          stage === filter.value ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground")}>
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {!statusQuery.data ? <QueueRowsSkeleton /> : !statusQuery.data.tracedImport?.available ? (
              <section aria-label="Traced numbers unavailable" data-testid="traced-import-unavailable"
                className="rounded-2xl border border-dashed border-amber-500/30 bg-card p-4">
                <h2 className="text-[13px] font-semibold text-foreground">Traced numbers are not in the queue yet</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  The trace provider has been turned off for this organization, so skip-traced doors stay out of
                  calling. Contract status: <span className="font-medium text-foreground">{statusQuery.data.tracedImport?.contractStatus ?? "unapproved"}</span>.
                </p>
              </section>
            ) : tracedQuery.isLoading ? <QueueRowsSkeleton /> : tracedLeads.length ? (
              <section aria-label="Traced numbers" className="overflow-hidden rounded-2xl border border-border bg-card" data-testid="traced-leads">
                <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-2.5">
                  <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Traced numbers</h2>
                  <span className="text-[11px] tabular-nums text-muted-foreground" data-testid="traced-ready-count">
                    {tracedReady} ready · {tracedLeads.length} total
                  </span>
                </header>
                <ul className="divide-y divide-border/60">
                  {tracedLeads.map(item => <TracedRow key={item.queueId} candidate={item} />)}
                </ul>
                <p className="border-t border-border px-4 py-2 text-[11px] leading-4 text-muted-foreground">
                  Scrubbed against the federal and state registries. Opening a lead still runs the full compliance check
                  before any number can be dialled.
                </p>
              </section>
            ) : null}

            {canTrace && untraced.length > 0 ? (
              <section aria-label="Skip trace" data-testid="bulk-trace"
                className="overflow-hidden rounded-2xl border border-border bg-card">
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <h2 className="text-[13px] font-semibold text-foreground">
                      {untraced.length} door{untraced.length === 1 ? "" : "s"} without a number
                    </h2>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                      {activeRun
                        ? `Tracing - ${activeRun.processedLeads} of ${activeRun.requestedLeads} done, ${activeRun.dialablePhones} dialable so far.`
                        : `Run a Tracerfy trace over the first ${Math.min(untraced.length, traceLimit)}. Numbers are scrubbed on arrival; the compliance check still gates every dial.`}
                    </p>
                  </div>
                  <button type="button" data-testid="bulk-trace-start"
                    disabled={!!activeRun || traceMutation.isPending}
                    onClick={() => traceMutation.mutate(untraced.slice(0, traceLimit).map(c => c.leadId))}
                    className="inline-flex min-h-9 shrink-0 items-center rounded-xl bg-primary px-3 text-[13px] font-semibold text-primary-foreground transition-colors disabled:opacity-50">
                    {activeRun ? "Tracing…" : traceMutation.isPending ? "Starting…" : "Trace these doors"}
                  </button>
                </div>
                {activeRun ? (
                  <div className="h-1 w-full bg-secondary" aria-hidden="true">
                    <div className="h-full bg-primary transition-[width] duration-500"
                      style={{ width: `${Math.round((activeRun.processedLeads / Math.max(1, activeRun.requestedLeads)) * 100)}%` }} />
                  </div>
                ) : null}
              </section>
            ) : null}

            {listQuery.isLoading ? <QueueRowsSkeleton /> : listQuery.isError ? (
              <div role="alert" className="rounded-2xl border border-red-500/25 bg-card p-5 text-center">
                
                <h2 className="mt-2.5 text-[13px] font-semibold text-foreground">Queue unavailable</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">No lead can be opened for calling while the queue is unknown.</p>
                <button type="button" onClick={() => void listQuery.refetch()}
                  className="mt-4 min-h-11 rounded-xl border border-border bg-card px-4 text-[13px] font-semibold transition-colors hover:bg-secondary/60">Retry</button>
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
