// ── Field Mode — start a shift, see the HUD, end with a summary ──────────────
//
// Field Mode is the EXISTING clock session plus a heads-up display, not a second
// shift concept. /api/clock/in and /api/clock/out remain the only things that
// open and close a shift, so hourly pay, punch corrections and this screen can
// never disagree about whether somebody was working.
//
// TWO RULES THE BRIEF MAKES NON-NEGOTIABLE, BOTH VISIBLE HERE:
//
//   1. TRACKING IS NEVER SILENT. While a shift is open and the org has
//      collection switched on, this card renders a persistent, unmissable
//      "Location tracking active" indicator. It is driven from the same server
//      field the tracking gate uses, so the indicator cannot say off while
//      collection is on.
//
//   2. GPS NEVER BLOCKS THE WORK. Nothing on this card gates a disposition.
//      Starting Field Mode with location denied is allowed and says so; doors
//      knocked without a usable fix are labelled "not verified" and saved
//      exactly like any other.

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { formatDuration, formatRate, type DerivedMetrics, type RepDailyFacts } from "@shared/repMetrics";
import { formatMetric } from "./MetricCard";

interface FieldModeState {
  hasSeat: boolean;
  fieldMode: boolean;
  shiftStartedAt: string | null;
  sessionId: number | null;
  today: string;
  timezone: string;
  facts: RepDailyFacts;
  metrics: DerivedMetrics;
  doorsAssigned: number;
  doorsRemaining: number;
  lastOutcome: string | null;
  lastOutcomeAt: string | null;
}

interface TrackingState {
  tracking: boolean;
  reason: string | null;
  needsDisclosure: boolean;
  paused: boolean;
  canPause: boolean;
  retentionDays: number;
}

interface ShiftSummary {
  hasSeat: boolean;
  date: string;
  facts: RepDailyFacts;
  metrics: DerivedMetrics;
  comparison: {
    personalBestDoors: number;
    priorAverageDoors: number | null;
    isPersonalBest: boolean;
  };
}

function elapsed(startedAt: string | null): string {
  if (!startedAt) return "—";
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return formatDuration(ms / 1000);
}

export function FieldModeCard() {
  const { toast } = useToast();
  const [summary, setSummary] = useState<ShiftSummary | null>(null);

  const { data: state, isLoading } = useQuery<FieldModeState>({
    queryKey: ["/api/field-mode/state"],
    // A running shift's elapsed time and door counts change while the rep
    // works. 60s is frequent enough to feel live and slow enough that a phone
    // on LTE is not paying for it all day.
    refetchInterval: 60_000,
  });
  const { data: tracking } = useQuery<TrackingState>({ queryKey: ["/api/live-ops/me"] });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/field-mode/state"] });
    queryClient.invalidateQueries({ queryKey: ["/api/clock/status"] });
    queryClient.invalidateQueries({ queryKey: ["/api/live-ops/me"] });
  };

  const start = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/clock/in", {});
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Field Mode on", description: "Your shift has started." });
    },
    onError: (e: any) => toast({
      title: "Could not start Field Mode",
      description: String(e?.message ?? "Try again in a moment."),
      variant: "destructive",
    }),
  });

  const end = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/clock/out", {});
      const res = await apiRequest("GET", "/api/field-mode/summary");
      return res.json() as Promise<ShiftSummary>;
    },
    onSuccess: (data) => {
      invalidate();
      setSummary(data);
    },
    onError: (e: any) => toast({
      title: "Could not end Field Mode",
      description: String(e?.message ?? "Try again in a moment."),
      variant: "destructive",
    }),
  });

  if (isLoading) return <Skeleton className="h-32 rounded-2xl" />;
  if (state && !state.hasSeat) return null;

  const on = !!state?.fieldMode;

  return (
    <>
      <section
        className={`overflow-hidden rounded-2xl border ${on ? "border-primary/40 bg-primary/5" : "border-border bg-card"}`}
        data-testid="field-mode-card"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${on ? "bg-success" : "bg-muted-foreground/40"}`}
                aria-hidden="true"
              />
              <h2 className="text-[15px] font-bold tracking-tight text-foreground">
                {on ? "Field Mode is on" : "Field Mode is off"}
              </h2>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {on
                ? `Started ${state?.shiftStartedAt ? new Date(state.shiftStartedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""} · ${elapsed(state?.shiftStartedAt ?? null)} elapsed`
                : "Start a shift to record your field time and door activity."}
            </p>
          </div>
          <Button
            onClick={() => (on ? end.mutate() : start.mutate())}
            disabled={start.isPending || end.isPending}
            variant={on ? "outline" : "default"}
            data-testid="field-mode-toggle"
          >
            {on ? "End Field Mode" : "Start Field Mode"}
          </Button>
        </div>

        {/* The visible tracking indicator the privacy brief requires. Rendered
            only while a shift is open, because that is the only time precise
            location is collected at all. */}
        {on && tracking?.tracking && (
          <div className="flex flex-wrap items-center gap-2 border-t border-primary/20 bg-primary/10 px-4 py-2.5"
               data-testid="tracking-indicator">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
            <span className="text-[11px] font-semibold text-foreground">Location tracking active</span>
            <span className="text-[11px] text-muted-foreground">
              Recorded only during this shift. Precise points are deleted after {tracking.retentionDays} days.
            </span>
            <a href="/#/clock" className="text-[11px] font-semibold text-primary underline underline-offset-2">
              Details
            </a>
          </div>
        )}
        {on && tracking && !tracking.tracking && (
          <div className="border-t border-border bg-secondary px-4 py-2.5">
            <span className="text-[11px] text-muted-foreground">
              Location is not being recorded{tracking.reason ? ` (${tracking.reason.replace(/_/g, " ")})` : ""}.
              Doors you knock will be saved and marked as not location verified.
            </span>
          </div>
        )}

        {on && (
          <dl className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-4">
            <Hud label="Doors today" value={String(state?.facts.doorsAttempted ?? 0)} />
            <Hud label="Remaining" value={String(state?.doorsRemaining ?? 0)} />
            <Hud label="Contact rate" value={formatRate(state?.metrics.contactRate ?? null)} />
            <Hud label="Last door" value={state?.lastOutcome?.replace(/_/g, " ") ?? "None yet"} />
          </dl>
        )}
      </section>

      {summary && <ShiftSummaryCard summary={summary} onDismiss={() => setSummary(null)} />}
    </>
  );
}

function Hud({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card px-3 py-2.5">
      <dt className="truncate text-2xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-[15px] font-bold capitalize tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

/**
 * The end-of-shift summary.
 *
 * Deliberately opens with what the rep DID before anything comparative, and the
 * comparison line is framed against their own history rather than a teammate's.
 * A shift ending on a leaderboard position is how a tool like this stops being
 * something reps want to open.
 */
function ShiftSummaryCard({ summary, onDismiss }: { summary: ShiftSummary; onDismiss: () => void }) {
  const f = summary.facts;
  const m = summary.metrics;
  return (
    <section className="rounded-2xl border border-border bg-card p-4" data-testid="shift-summary">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-bold tracking-tight text-foreground">Shift complete</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{summary.date}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onDismiss}>Close</Button>
      </div>

      {summary.comparison.isPersonalBest && (
        <p className="mt-3 rounded-lg bg-success/10 px-3 py-2 text-xs font-semibold text-success">
          Personal best: {f.doorsAttempted} doors, past your previous best of {summary.comparison.personalBestDoors}.
        </p>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
        <Row label="Active time" value={formatDuration(f.activeSeconds)} />
        <Row label="Doors visited" value={String(f.doorsVisited)} />
        <Row label="Verified doors" value={String(f.verifiedDoors)} />
        <Row label="Contacts" value={String(f.contacts)} />
        <Row label="Appointments" value={String(f.appointments)} />
        <Row label="Submitted orders" value={String(f.submittedOrders)} />
        <Row label="Distance" value={formatMetric("distanceMeters", f.distanceMeters)} />
        <Row label="Time between doors" value={formatDuration(m.medianSecondsBetweenDoors)} />
        <Row label="Longest gap" value={formatDuration(f.longestInactiveSeconds)} />
      </dl>

      {summary.comparison.priorAverageDoors != null && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Your 30-day average is {summary.comparison.priorAverageDoors.toFixed(0)} doors a day.
        </p>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-2xs text-muted-foreground">{label}</dt>
      <dd className="text-[13px] font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
