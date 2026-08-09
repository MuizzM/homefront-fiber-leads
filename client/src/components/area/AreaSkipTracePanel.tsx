// ── Area skip trace + DNC panel ─────────────────────────────────────────────
//
// Two jobs on one surface: start a Tracerfy run for this area, and show what
// came back as a worklist a rep can act on.
//
// THE RULE THIS COMPONENT ENFORCES VISUALLY:
// a number the DNC layer has not cleared is VISIBLE but NOT INTERACTIVE. It
// renders as an inert <span>, never a link or a button, and it says why. This
// is deliberate — hiding blocked numbers would leave a rep wondering whether we
// simply found nothing, and disabling a control that looks clickable invites
// the "just tap it anyway" reflex. Seeing the number and the reason is what
// stops someone hunting for it elsewhere.
//
// No `tel:` anchor is rendered anywhere in this tree, in ANY state. Full
// numbers never reach the browser: the API returns masked display text, and
// dialing goes through the Calling workspace, which re-runs the full
// compliance check and issues a one-use authorization per call.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, PhoneOff, ScanSearch, ShieldCheck } from "lucide-react";

import { FOCUS } from "@/lib/a11y";
import { cn } from "@/lib/utils";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { LeadContacts } from "@/components/LeadContacts";
import type { AreaSkipTraceSummary, DialingListResponse } from "@shared/areaSkipTrace";

type RunEnvelope = {
  areaId: number;
  run: AreaSkipTraceSummary | null;
  eligibleLeads: number;
};

/** Terminal states stop the poll. Anything else means work is still moving. */
function isActive(status: string | undefined): boolean {
  return status === "queued" || status === "running";
}

function summaryLine(run: AreaSkipTraceSummary): string {
  return `Processed ${run.processedLeads} ${run.processedLeads === 1 ? "lead" : "leads"}, `
    + `${run.totalPhones} ${run.totalPhones === 1 ? "phone" : "phones"}, `
    + `${run.dialablePhones} dialable`;
}

export function AreaSkipTracePanel({
  areaId, canRun,
}: {
  areaId: number;
  /** Whether this viewer may spend budget. Read-only viewers still see results. */
  canRun: boolean;
}) {
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  // Show every number, including blocked ones, so the panel can explain what
  // it found rather than silently omitting most of it.
  const [showBlocked, setShowBlocked] = useState(true);

  const runQuery = useQuery<RunEnvelope>({
    queryKey: [`/api/areas/${areaId}/tracerfy-run`],
  });
  const run = runQuery.data?.run ?? null;
  const active = isActive(run?.status);

  const listQuery = useQuery<DialingListResponse>({
    queryKey: [`/api/areas/${areaId}/dialing-list?dialableOnly=${showBlocked ? "false" : "true"}`],
  });

  // Poll only while work is in flight, then stop. A finished run must not keep
  // a timer alive on a page someone left open.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: [`/api/areas/${areaId}/tracerfy-run`] });
    }, 4000);
    return () => clearInterval(timer);
  }, [active, areaId]);

  // When a run finishes, refresh the list once so the new numbers appear
  // without the user reloading.
  useEffect(() => {
    if (run && !isActive(run.status)) {
      queryClient.invalidateQueries({ queryKey: [`/api/areas/${areaId}/dialing-list?dialableOnly=false`] });
      queryClient.invalidateQueries({ queryKey: [`/api/areas/${areaId}/dialing-list?dialableOnly=true`] });
    }
  }, [run?.status, run?.runId, areaId]);

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/areas/${areaId}/tracerfy-run`, {});
      return res.json();
    },
    onSuccess: () => {
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: [`/api/areas/${areaId}/tracerfy-run`] });
      toast({ title: "Skip trace started", severity: "success" });
    },
    onError: (e: any) => {
      setConfirming(false);
      toast({
        title: "Couldn't start the skip trace",
        description: String(e?.message ?? e).slice(0, 200),
        variant: "destructive",
      });
    },
  });

  const eligible = runQuery.data?.eligibleLeads ?? 0;
  const list = listQuery.data;

  return (
    <section className="space-y-4" data-testid="area-panel-phones">
      {/* ── Run control ─────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">Skip trace &amp; DNC scrub</div>
            <p className="mt-1 max-w-prose text-[13px] text-muted-foreground">
              Looks up the owner and phone numbers for every open door in this area, then
              screens each number against the do-not-call lists. Sold and existing-customer
              doors are skipped.
            </p>
          </div>
          {canRun && !confirming && (
            <button
              type="button"
              data-testid="area-action-skip-trace"
              disabled={active || startMutation.isPending}
              onClick={() => setConfirming(true)}
              className={cn(
                "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-border bg-secondary px-3.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/70 disabled:opacity-50",
                FOCUS,
              )}
            >
              {active || startMutation.isPending
                ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                : <ScanSearch className="h-4 w-4" aria-hidden="true" />}
              Run Tracerfy + DNC
            </button>
          )}
        </div>

        {/* Confirm step: this spends real provider budget on a door count the
            operator should see BEFORE they commit, not after. */}
        {confirming && (
          <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3" data-testid="skip-trace-confirm">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
              <div className="min-w-0 text-[13px] text-foreground">
                This will skip trace <strong>{eligible}</strong> {eligible === 1 ? "door" : "doors"} and
                spend provider budget. Sold and already-customer doors are excluded.
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="skip-trace-confirm-yes"
                disabled={startMutation.isPending}
                onClick={() => startMutation.mutate()}
                className={cn("inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-foreground px-3 text-sm font-semibold text-background disabled:opacity-50", FOCUS)}
              >
                {startMutation.isPending && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                Run it
              </button>
              <button
                type="button"
                data-testid="skip-trace-confirm-no"
                onClick={() => setConfirming(false)}
                className={cn("inline-flex min-h-10 items-center rounded-lg border border-border bg-card px-3 text-sm font-semibold text-foreground", FOCUS)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ── Progress / result ──────────────────────────────────────────── */}
        {run && (
          <div className="mt-3 rounded-xl border border-border bg-secondary/30 p-3" data-testid="skip-trace-progress">
            <div className="flex flex-wrap items-center gap-2">
              {active
                ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" />
                : run.status === "completed"
                  ? <ShieldCheck className="h-4 w-4 text-emerald-500" aria-hidden="true" />
                  : <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden="true" />}
              <span className="text-[13px] font-medium text-foreground" data-testid="skip-trace-summary">
                {active
                  ? `Running - ${run.processedLeads} of ${run.eligibleLeads} doors`
                  : summaryLine(run)}
              </span>
            </div>
            {active && (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border" role="progressbar"
                aria-valuenow={run.processedLeads} aria-valuemin={0} aria-valuemax={run.eligibleLeads}>
                <div
                  className="h-full rounded-full bg-foreground/60 transition-[width]"
                  style={{ width: `${run.eligibleLeads ? Math.round((run.processedLeads / run.eligibleLeads) * 100) : 0}%` }}
                />
              </div>
            )}
            {run.failedLeads > 0 && (
              <div className="mt-1.5 text-[12px] text-muted-foreground" data-testid="skip-trace-failures">
                {run.failedLeads} {run.failedLeads === 1 ? "door" : "doors"} could not be traced.
              </div>
            )}
            {run.errorCode && (
              <div className="mt-1.5 text-[12px] text-destructive" data-testid="skip-trace-error">
                Stopped: {run.errorCode.replace(/_/g, " ").toLowerCase()}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── The worklist ────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold text-foreground">Numbers</div>
          <button
            type="button"
            data-testid="toggle-blocked"
            onClick={() => setShowBlocked(v => !v)}
            className={cn("rounded-lg border border-border bg-secondary px-2.5 py-1 text-[12px] font-semibold text-muted-foreground", FOCUS)}
          >
            {showBlocked ? "Dialable only" : "Show all numbers"}
          </button>
        </div>

        {/* Honest about what this list is. A rep who reads "dialable" as
            "cleared to call" has been misled by the product. */}
        <p className="mt-1 text-[12px] text-muted-foreground">
          A worklist, not a call approval - every dial re-runs the full check in the Calling
          workspace. Numbers are masked here.
        </p>


        {listQuery.isLoading && <Skeleton className="mt-3 h-24 w-full" />}

        {/* A failed fetch used to render NOTHING — an empty panel reads as "no
            numbers", which is a different (and wrong) answer. */}
        {listQuery.isError && !listQuery.isLoading && (
          <div role="alert" className="mt-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-foreground" data-testid="skiptrace-error">
            Couldn't load this area's numbers. Check your connection and{" "}
            <button type="button" onClick={() => listQuery.refetch()} className={cn("font-semibold underline underline-offset-2", FOCUS)}>
              try again
            </button>.
          </div>
        )}

        {list && list.entries.length === 0 && !listQuery.isLoading && (
          <div className="mt-3">
            <EmptyState
              icon={PhoneOff}
              title="No numbers yet"
              description={
                run && !isActive(run.status)
                  ? "The skip trace finished without producing numbers that clear DNC screening."
                  : "Run a skip trace to look up owners and phone numbers for this area."
              }
            />
          </div>
        )}

        {list && list.entries.length > 0 && (
          <>
            <ul className="mt-3 space-y-2" data-testid="dialing-list">
              {list.entries.map(entry => (
                <li key={entry.leadId} className="rounded-xl border border-border bg-background/40 p-3" data-testid={`dialing-lead-${entry.leadId}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-[12px] text-muted-foreground" data-testid={`lead-address-${entry.leadId}`}>
                        {entry.address}, {entry.city} {entry.state} {entry.zip}
                      </div>
                    </div>
                  </div>
                  {/* The SAME component the map card and knock sheet use, so a
                      blocked number is inert here for exactly the same reason
                      and by exactly the same tested code. */}
                  <LeadContacts
                    ownerName={entry.ownerName}
                    address={entry.address}
                    phones={entry.phones}
                    className="mt-2"
                  />
                </li>
              ))}
            </ul>
            <div className="mt-3 text-[12px] text-muted-foreground" data-testid="dialing-list-totals">
              {list.dialablePhones} of {list.totalPhones} numbers dialable
              {list.truncated && " - showing the first page only"}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
