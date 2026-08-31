// ── Team Metrics — the supervisor's table and drill-down ─────────────────────
//
// The rows this renders are whatever the SERVER decided the caller may see
// (liveOpsScope: a manager's own branch, a team lead's full subtree). There is
// no client-side filtering standing between the viewer and somebody else's
// numbers, because a filter is not a permission - the API returns only the
// permitted rows, and this component renders what it is given.
//
// The table sorts by any column, and the DEFAULT sort is deliberately doors
// attempted rather than sales. Opening a coaching screen ranked by revenue
// frames every conversation as a sales league table, which is exactly what the
// brief asks this feature not to be.

import { useMutation, useQuery, keepPreviousData } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { useToast } from "@/hooks/use-toast";
import { useModalA11y } from "@/hooks/use-modal-a11y";
import { useCan } from "@/lib/capabilities";
import { MetricCard, CountCard } from "./MetricCard";
import { ChartFrame, FunnelChart, BarChart } from "./charts";
import { PeriodChips, PERIODS, type PeriodKey } from "./MyMetrics";
import {
  CommissionSourceNotice,
  METRICS_REFETCH_MS,
  MetricsErrorState,
} from "./MetricsDataState";
import {
  buildFunnel, formatDuration, formatRate,
  type DerivedMetrics, type RepDailyFacts,
} from "@shared/repMetrics";
import type { TeamBaseline } from "@shared/coachingInsights";

interface TeamRow {
  repId: number;
  repName: string;
  role: string;
  inFieldMode: boolean;
  status: string;
  lastActivityAt: string | null;
  territoryId: number | null;
  facts: RepDailyFacts;
  metrics: DerivedMetrics;
}

interface TeamResponse {
  period: { from: string; to: string; timezone: string };
  rows: TeamRow[];
  kpis: {
    facts: RepDailyFacts;
    metrics: DerivedMetrics;
    activeNow: number;
    repCount: number;
  } | null;
  baseline: TeamBaseline | null;
}

type SortKey =
  | "repName" | "doorsAttempted" | "verifiedDoors" | "contacts" | "doorsPerActiveHour"
  | "medianSecondsBetweenDoors" | "activeSeconds" | "utilizationRate" | "submittedOrders"
  | "installRate" | "followUps";

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "repName", label: "Rep", numeric: false },
  { key: "doorsAttempted", label: "Doors", numeric: true },
  { key: "verifiedDoors", label: "Verified", numeric: true },
  { key: "contacts", label: "Contacts", numeric: true },
  { key: "doorsPerActiveHour", label: "Doors/hr", numeric: true },
  { key: "medianSecondsBetweenDoors", label: "Between doors", numeric: true },
  { key: "activeSeconds", label: "Field time", numeric: true },
  { key: "utilizationRate", label: "Utilization", numeric: true },
  { key: "submittedOrders", label: "Submitted", numeric: true },
  { key: "installRate", label: "Install rate", numeric: true },
  { key: "followUps", label: "Follow-ups", numeric: true },
];

function valueOf(row: TeamRow, key: SortKey): number | string | null {
  if (key === "repName") return row.repName;
  if (key in row.facts) return (row.facts as any)[key] ?? null;
  return (row.metrics as any)[key] ?? null;
}

function renderCell(row: TeamRow, key: SortKey): string {
  const v = valueOf(row, key);
  if (key === "repName") return row.repName;
  if (v == null) return "—";
  switch (key) {
    case "medianSecondsBetweenDoors":
    case "activeSeconds": return formatDuration(v as number);
    case "utilizationRate":
    case "installRate": return formatRate(v as number);
    case "doorsPerActiveHour": return (v as number).toFixed(1);
    default: return String(v);
  }
}

export function TeamMetrics() {
  const [period, setPeriod] = useState<PeriodKey>("today");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "doorsAttempted", dir: "desc",
  });
  const [openRep, setOpenRep] = useState<number | null>(null);

  const { data, isLoading, isError, isFetching, refetch, isPlaceholderData } = useQuery<TeamResponse>({
    queryKey: [`/api/metrics/team?period=${period}`],
    refetchInterval: METRICS_REFETCH_MS,
    // A period switch keeps the previous period's table on screen (dimmed)
    // while the new one loads - the whole workspace, PeriodChips included,
    // used to unmount into a single 256px skeleton on every tap.
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => {
    const list = [...(data?.rows ?? [])];
    list.sort((a, b) => {
      const av = valueOf(a, sort.key);
      const bv = valueOf(b, sort.key);
      // Nulls always sort LAST regardless of direction. A rep with no measurable
      // pace is not the fastest rep on the team, and putting them at the top of
      // an ascending sort would say exactly that.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === "string" || typeof bv === "string"
        ? String(av).localeCompare(String(bv))
        : (av as number) - (bv as number);
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [data?.rows, sort]);

  if (isLoading) return <Skeleton className="h-64 rounded-2xl" />;

  if (isError || !data) {
    return (
      <div className="space-y-5">
        <PeriodChips value={period} onChange={setPeriod} />
        <MetricsErrorState onRetry={() => { void refetch(); }} retrying={isFetching} />
      </div>
    );
  }

  const k = data?.kpis;

  return (
    <div aria-busy={isPlaceholderData || undefined} className={`space-y-5 ${isPlaceholderData ? "opacity-60 transition-opacity" : ""}`}>
      <PeriodChips value={period} onChange={setPeriod} />

      <section>
        {/* Named from the SELECTED period. A heading that says "today" over a
            week's figures is a small lie that makes every number on the row
            wrong by a factor of seven. */}
        <SectionLabel className="mb-2 px-1">
          {PERIODS.find((p) => p.key === period)?.label ?? "Team"} across the team
        </SectionLabel>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <CountCard label="Reps in Field Mode" value={k?.activeNow ?? 0} tone="primary" />
          <MetricCard metricKey="doorsAttempted" value={k?.facts.doorsAttempted ?? null} accent />
          <MetricCard metricKey="doorsPerActiveHour" value={k?.metrics.doorsPerActiveHour ?? null} />
          <MetricCard metricKey="contactRate" value={k?.metrics.contactRate ?? null} />
          <MetricCard metricKey="submissionRate" value={k?.metrics.submissionRate ?? null} />
          <MetricCard metricKey="installRate" value={k?.metrics.installRate ?? null} />
          <MetricCard metricKey="utilizationRate" value={k?.metrics.utilizationRate ?? null} />
          <CountCard label="Follow-ups created" value={k?.facts.followUps ?? 0} tone="warning" />
          <CountCard label="Submitted orders" value={k?.facts.submittedOrders ?? 0} tone="success" />
          <CountCard label="Installed" value={k?.facts.installedOrders ?? 0} tone="success" />
        </div>
      </section>

      <CommissionSourceNotice manager />

      <section>
        <SectionLabel className="mb-2 px-1">Reps</SectionLabel>
        {rows.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card p-6 text-center text-xs text-muted-foreground">
            No reps in your scope have activity in this period.
          </div>
        ) : (
          // The table scrolls INSIDE its own container. The page body must never
          // scroll sideways on a phone.
          <div className="overflow-x-auto rounded-2xl border border-border bg-card">
            <table className="w-full min-w-[820px] text-left text-[12px]">
              <thead>
                <tr className="border-b border-border">
                  {COLUMNS.map((c) => (
                    <th key={c.key} scope="col"
                        aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                        className={`px-3 py-2.5 font-semibold text-muted-foreground ${c.numeric ? "text-right" : ""}`}>
                      <button
                        type="button"
                        onClick={() => setSort((s) =>
                          s.key === c.key ? { key: c.key, dir: s.dir === "asc" ? "desc" : "asc" }
                                          : { key: c.key, dir: c.numeric ? "desc" : "asc" })}
                        className="inline-flex items-center gap-1 hover:text-foreground"
                        aria-label={`Sort by ${c.label}`}
                      >
                        {c.label}
                        {sort.key === c.key && <span aria-hidden="true">{sort.dir === "asc" ? "↑" : "↓"}</span>}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.repId}
                      className="border-b border-border last:border-0 hover:bg-secondary/50"
                      data-testid={`team-row-${r.repId}`}>
                    <td className="px-3 py-2.5">
                      <button type="button" onClick={() => setOpenRep(r.repId)}
                              className="text-left font-semibold text-primary underline underline-offset-2">
                        {r.repName}
                      </button>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className={`h-1.5 w-1.5 rounded-full ${r.inFieldMode ? "bg-success" : "bg-muted-foreground/40"}`}
                              aria-hidden="true" />
                        <span className="text-2xs text-muted-foreground">
                          {r.inFieldMode ? "In Field Mode" : r.lastActivityAt ? `Last door ${new Date(r.lastActivityAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "No activity"}
                        </span>
                      </div>
                    </td>
                    {COLUMNS.slice(1).map((c) => (
                      <td key={c.key} className="px-3 py-2.5 text-right tabular-nums text-foreground">
                        {renderCell(r, c.key)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {openRep != null && <RepDrilldown repId={openRep} period={period} onClose={() => setOpenRep(null)} />}
    </div>
  );
}

// ── Drill-down ───────────────────────────────────────────────────────────────

interface RepDetail {
  repId: number;
  repName: string;
  facts: RepDailyFacts;
  metrics: DerivedMetrics;
  daily: (RepDailyFacts & { metricDate: string })[];
  shifts: { id: number; clockedIn: string; clockedOut: string | null; durationMinutes: number | null; date: string }[];
  insights: {
    id: number; severity: string; title: string; explanation: string;
    suggestedAction: string; periodStart: string; periodEnd: string;
  }[];
  notes: {
    id: number; body: string; sharedWithRep: number; authorName: string | null;
    goalMetric: string | null; goalTarget: number | null; goalDueDate: string | null;
    createdAt: string;
  }[];
}

function RepDrilldown({ repId, period, onClose }: {
  repId: number; period: PeriodKey; onClose: () => void;
}) {
  const { toast } = useToast();
  // Modal contract for the aria-modal claim: focus in, Tab contained,
  // Escape closes, focus restored to the row that opened the drill-down.
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, { active: true, onClose });
  const canNote = useCan("coaching.note.write");
  const [noteBody, setNoteBody] = useState("");
  const [shareWithRep, setShareWithRep] = useState(false);

  const { data, isLoading, isError, isFetching, refetch } = useQuery<RepDetail>({
    queryKey: [`/api/metrics/rep/${repId}?period=${period}`],
    refetchInterval: METRICS_REFETCH_MS,
  });

  const addNote = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/metrics/notes", {
        repId, body: noteBody, sharedWithRep: shareWithRep,
      });
      return res.json();
    },
    onSuccess: () => {
      setNoteBody("");
      queryClient.invalidateQueries({ queryKey: [`/api/metrics/rep/${repId}?period=${period}`] });
      toast({
        title: "Coaching note saved",
        description: shareWithRep ? "Shared with the rep." : "Private to supervisors.",
      });
    },
    onError: (e: any) => toast({
      title: "Could not save the note",
      description: String(e?.message ?? "Try again."),
      variant: "destructive",
    }),
  });

  return (
    <div className="fixed inset-0 z-overlay flex items-end justify-center sm:items-center" role="dialog" aria-modal="true"
         aria-label="Rep detail">
      <button type="button" className="absolute inset-0 bg-overlay backdrop-blur-[2px]" onClick={onClose}
              aria-label="Close" />
      <div ref={panelRef} className="relative max-h-[90dvh] w-full max-w-3xl overflow-y-auto rounded-t-2xl border border-border bg-background p-4 sm:rounded-2xl">
        {isLoading ? (
          <Skeleton className="h-64 rounded-2xl" />
        ) : isError || !data ? (
          <MetricsErrorState
            title="Couldn't load representative details"
            description="This representative's numbers are hidden until the detail request succeeds."
            onRetry={() => { void refetch(); }}
            retrying={isFetching}
            testId="rep-detail-error"
          />
        ) : (
          <>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold tracking-tight text-foreground">{data?.repName}</h2>
                <p className="text-xs text-muted-foreground">Field performance and coaching record</p>
              </div>
              <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MetricCard metricKey="doorsAttempted" value={data?.facts.doorsAttempted ?? null} accent />
              <MetricCard metricKey="contactRate" value={data?.metrics.contactRate ?? null} />
              <MetricCard metricKey="closeRate" value={data?.metrics.closeRate ?? null} />
              <MetricCard metricKey="utilizationRate" value={data?.metrics.utilizationRate ?? null} />
              <MetricCard metricKey="medianSecondsBetweenDoors" value={data?.metrics.medianSecondsBetweenDoors ?? null} />
              <MetricCard metricKey="activeSeconds" value={data?.facts.activeSeconds ?? null} />
              <CountCard label="Callbacks completed" value={data?.facts.followUpsCompleted ?? 0} />
              <MetricCard metricKey="installRate" value={data?.metrics.installRate ?? null} />
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <ChartFrame title="Funnel">
                <FunnelChart stages={data ? buildFunnel(data.facts) : []} />
              </ChartFrame>
              <ChartFrame title="Doors by day">
                <BarChart data={(data?.daily ?? []).map((d) => ({
                  label: d.metricDate.slice(5), value: d.doorsAttempted, secondary: d.contacts,
                }))} />
              </ChartFrame>
            </div>

            <section className="mt-4">
              <SectionLabel className="mb-2 px-1">Shift history</SectionLabel>
              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
                {(data?.shifts ?? []).length === 0 && (
                  <p className="p-4 text-xs text-muted-foreground">No shifts recorded in this period.</p>
                )}
                {(data?.shifts ?? []).slice(0, 10).map((s) => (
                  <div key={s.id} className="flex items-center justify-between px-4 py-2.5 text-[12px]">
                    <span className="text-foreground">{s.date}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {new Date(s.clockedIn).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                      {" to "}
                      {s.clockedOut
                        ? new Date(s.clockedOut).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                        : "open"}
                      {s.durationMinutes != null && ` · ${formatDuration(s.durationMinutes * 60)}`}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="mt-4">
              <SectionLabel className="mb-2 px-1">Coaching opportunities</SectionLabel>
              <div className="space-y-2">
                {(data?.insights ?? []).length === 0 && (
                  <p className="rounded-2xl border border-border bg-card p-4 text-xs text-muted-foreground">
                    No insights for this rep in the current window.
                  </p>
                )}
                {(data?.insights ?? []).map((i) => (
                  <article key={i.id} className="rounded-2xl border border-border bg-card p-3.5">
                    <h4 className="text-[13px] font-semibold text-foreground">{i.title}</h4>
                    <p className="mt-1 text-xs text-muted-foreground">{i.explanation}</p>
                    <p className="mt-1.5 text-xs font-medium text-foreground">{i.suggestedAction}</p>
                  </article>
                ))}
              </div>
            </section>

            {canNote && (
              <section className="mt-4">
                <SectionLabel className="mb-2 px-1">Coaching log</SectionLabel>
                <div className="rounded-2xl border border-border bg-card p-3.5">
                  <Textarea
                    value={noteBody}
                    onChange={(e) => setNoteBody(e.target.value)}
                    placeholder="What did you discuss, and what did you agree to try?"
                    rows={3}
                    data-testid="coaching-note-input"
                  />
                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <input type="checkbox" checked={shareWithRep}
                             onChange={(e) => setShareWithRep(e.target.checked)}
                             className="h-3.5 w-3.5 rounded border-border" />
                      Share this note with the rep
                    </label>
                    <Button size="sm" disabled={!noteBody.trim() || addNote.isPending}
                            onClick={() => addNote.mutate()} data-testid="coaching-note-save">
                      Save note
                    </Button>
                  </div>
                  <p className="mt-2 text-2xs text-muted-foreground">
                    Notes are private to supervisors unless you share them. A shared note appears on the
                    rep's own Metrics screen.
                  </p>
                </div>

                <div className="mt-2 space-y-2">
                  {(data?.notes ?? []).map((n) => (
                    <div key={n.id} className="rounded-xl border border-border bg-card p-3">
                      <p className="text-xs text-foreground">{n.body}</p>
                      <p className="mt-1 text-2xs text-muted-foreground">
                        {n.authorName ?? "Supervisor"} · {new Date(n.createdAt).toLocaleDateString()}
                        {n.sharedWithRep ? " · shared with rep" : " · private"}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
