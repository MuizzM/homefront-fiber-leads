import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Clock3, LockKeyhole, Search, ShieldAlert, UserRound, Wifi } from "lucide-react";
import { CallingAvailability, CallingChrome, CallingPageSkeleton, CallingUnknownState } from "@/components/calling/CallingChrome";
import { formatDecision, formatStage, getCallingQueue, getCallingStatus, type CallingCandidate } from "@/lib/callingApi";
import { cn } from "@/lib/utils";

const STAGE_FILTERS = [
  { value: "", label: "Open" },
  { value: "ELIGIBLE_MANUAL_CALL", label: "Eligible" },
  { value: "CALLBACK_SCHEDULED", label: "Callbacks" },
  { value: "COMPLIANCE_REVIEW", label: "Review" },
] as const;

function stageTone(stage: string): string {
  if (stage === "ELIGIBLE_MANUAL_CALL") return "border-emerald-500/25 bg-emerald-500/10 text-emerald-400";
  if (stage === "COMPLIANCE_BLOCKED" || stage === "SUPPRESSED") return "border-red-500/25 bg-red-500/10 text-red-400";
  if (stage === "COMPLIANCE_REVIEW") return "border-amber-500/25 bg-amber-500/10 text-amber-400";
  if (stage === "CALLBACK_SCHEDULED") return "border-sky-500/25 bg-sky-500/10 text-sky-400";
  return "border-border bg-secondary text-muted-foreground";
}

function CandidateRow({ candidate }: { candidate: CallingCandidate }) {
  const eligible = candidate.queueStage === "ELIGIBLE_MANUAL_CALL";
  return (
    <Link href={`/calling/lead/${candidate.leadId}`} data-testid={`calling-lead-${candidate.leadId}`}
      className="render-lazy group block rounded-2xl border border-border bg-card p-4 transition hover:border-primary/30 active:scale-[.995]">
      <div className="flex items-start gap-3">
        <span className={cn("mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl",
          eligible ? "bg-emerald-500/12 text-emerald-400" : "bg-secondary text-muted-foreground")}>
          {eligible ? <CheckCircle2 className="h-[19px] w-[19px]" /> : <LockKeyhole className="h-[18px] w-[18px]" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-semibold tracking-tight text-foreground">{candidate.address}</h2>
              <p className="truncate text-xs text-muted-foreground">{candidate.city}, {candidate.state} {candidate.zip}</p>
            </div>
            <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className={cn("inline-flex min-h-6 items-center rounded-full border px-2.5 text-[10px] font-semibold uppercase tracking-wide", stageTone(candidate.queueStage))}>
              {formatStage(candidate.queueStage)}
            </span>
            <span className="inline-flex min-h-6 items-center gap-1 rounded-full bg-primary/10 px-2.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              <Wifi className="h-3 w-3" /> Fresh fiber
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border/70 pt-3 text-xs">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Resident match</div>
              <div className="mt-0.5 flex items-center gap-1.5 truncate text-foreground"><UserRound className="h-3.5 w-3.5 text-muted-foreground" />{candidate.contactName || "Not enriched"}</div>
            </div>
            <div className="min-w-0 text-right">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Phone</div>
              <div className="mt-0.5 truncate font-mono text-foreground">{candidate.maskedPhone || "Not available"}</div>
            </div>
          </div>
          {candidate.lastDecisionStatus && (
            <p className="mt-2 truncate text-[11px] text-muted-foreground">Last check: {formatDecision(candidate.lastDecisionStatus)}</p>
          )}
        </div>
      </div>
    </Link>
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

  return (
    <CallingChrome>
      <div className="flex-1 space-y-4 px-4 pb-24 pt-4 md:px-6 md:pb-8">
        {statusQuery.isLoading ? <CallingPageSkeleton /> : statusQuery.isError || !statusQuery.data ? (
          <CallingUnknownState retry={() => void statusQuery.refetch()} />
        ) : (
          <>
            <CallingAvailability status={statusQuery.data} />

            <section aria-label="Calling queue metrics" className="grid grid-cols-3 overflow-hidden rounded-2xl border border-border bg-card divide-x divide-border">
              <div className="p-3.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Open</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">{queueQuery.data?.length ?? "—"}</div>
              </div>
              <div className="p-3.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Eligible</div>
                <div className="mt-1 text-xl font-semibold tabular-nums text-emerald-400">{queueQuery.data ? eligible : "—"}</div>
              </div>
              <div className="p-3.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Callbacks</div>
                <div className="mt-1 text-xl font-semibold tabular-nums text-sky-400">{queueQuery.data ? callbacks : "—"}</div>
              </div>
            </section>

            <div className="space-y-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search address or resident" aria-label="Search calling queue"
                  className="h-11 w-full rounded-xl border border-border bg-card pl-10 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:outline-none" />
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Filter calling queue">
                {STAGE_FILTERS.map(filter => (
                  <button key={filter.value} type="button" onClick={() => setStage(filter.value)} aria-pressed={stage === filter.value}
                    className={cn("min-h-10 shrink-0 rounded-full border px-4 text-xs font-semibold transition",
                      stage === filter.value ? "border-primary/40 bg-primary/12 text-primary" : "border-border bg-card text-muted-foreground hover:text-foreground")}>
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>

            {queueQuery.isLoading ? <CallingPageSkeleton /> : queueQuery.isError ? (
              <div role="alert" className="rounded-2xl border border-red-500/30 bg-red-500/[0.08] p-5 text-center">
                <ShieldAlert className="mx-auto h-6 w-6 text-red-400" />
                <h2 className="mt-2 text-sm font-semibold text-red-400">Queue unavailable</h2>
                <p className="mt-1 text-xs text-muted-foreground">No lead can be opened for calling while the queue is unknown.</p>
                <button type="button" onClick={() => void queueQuery.refetch()} className="mt-4 min-h-11 rounded-xl border border-border bg-card px-4 text-sm font-semibold">Retry</button>
              </div>
            ) : filtered.length ? (
              <section aria-label="Calling queue" className="space-y-2.5">
                {filtered.map(item => <CandidateRow key={item.queueId} candidate={item} />)}
              </section>
            ) : (
              <div className="rounded-2xl border border-dashed border-border p-8 text-center">
                <Clock3 className="mx-auto h-6 w-6 text-muted-foreground" />
                <h2 className="mt-2 text-sm font-semibold">No leads in this view</h2>
                <p className="mt-1 text-xs text-muted-foreground">Fresh-fiber leads appear here only after the calling pipeline accepts them.</p>
              </div>
            )}
          </>
        )}
      </div>
    </CallingChrome>
  );
}
