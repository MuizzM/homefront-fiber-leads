// ── My Metrics — the rep's own screen ────────────────────────────────────────
//
// The rep is the primary audience for this whole feature, and this is the only
// page most of them will ever open. Three things shape it:
//
//   IT LEADS WITH TODAY, NOT WITH A DATE PICKER. A rep opens this between doors.
//   The default period is today, the scorecard is above the fold, and the
//   filters are a single row of chips rather than a form.
//
//   EVERY NUMBER CAN EXPLAIN ITSELF. Each card carries the formula behind a "?"
//   (MetricCard reads it from shared/repMetrics), because a metric a rep cannot
//   interrogate is a metric they will not trust and should not have to.
//
//   THE COACHING SECTION IS ADDRESSED TO THEM. Every insight the engine
//   produces is written to be read by its subject - no rankings, no shaming, and
//   a concrete action in every one.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { MetricCard, CountCard, formatMetric } from "./MetricCard";
import { ActivityCalendar, BarChart, ChartFrame, FunnelChart, LineChart } from "./charts";
import { FieldModeCard } from "./FieldMode";
import { formatDuration, formatRate, type DerivedMetrics, type FunnelStage, type RepDailyFacts } from "@shared/repMetrics";
import type { TeamBaseline } from "@shared/coachingInsights";

export const PERIODS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "This week" },
  { key: "last_week", label: "Last week" },
  { key: "month", label: "This month" },
] as const;

export type PeriodKey = (typeof PERIODS)[number]["key"];

interface DailyRow extends RepDailyFacts { repId: number; metricDate: string }

interface MeResponse {
  hasSeat: boolean;
  period?: { from: string; to: string; timezone: string };
  facts: RepDailyFacts;
  metrics: DerivedMetrics;
  funnel?: FunnelStage[];
  previous?: { facts: RepDailyFacts; metrics: DerivedMetrics };
  personal?: { facts: RepDailyFacts; metrics: DerivedMetrics };
  teamBaseline?: TeamBaseline | null;
  daily?: DailyRow[];
}

interface Insight {
  id: number;
  severity: "positive" | "neutral" | "coaching_needed" | "urgent";
  title: string;
  explanation: string;
  suggestedAction: string;
  supportingMetrics: { key: string; label: string; value: string; baseline?: string }[] | null;
  dataLink: string | null;
  periodStart: string;
  periodEnd: string;
  acknowledgedAt: string | null;
}

export function PeriodChips({ value, onChange }: { value: PeriodKey; onChange: (p: PeriodKey) => void }) {
  return (
    <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Period">
      {PERIODS.map((p) => (
        <button
          key={p.key}
          type="button"
          role="tab"
          aria-selected={value === p.key}
          onClick={() => onChange(p.key)}
          className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors ${
            value === p.key
              ? "bg-primary text-primary-foreground"
              : "bg-secondary text-muted-foreground hover:text-foreground"
          }`}
          data-testid={`period-${p.key}`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

export function MyMetrics() {
  const [period, setPeriod] = useState<PeriodKey>("today");

  const { data, isLoading } = useQuery<MeResponse>({
    queryKey: [`/api/metrics/me?period=${period}`],
  });
  const { data: hourly } = useQuery<{ hours: { hour: number; doors: number; contacts: number; sales: number }[] }>({
    queryKey: [`/api/metrics/me/hourly?period=${period}`],
  });
  const { data: insightData } = useQuery<{ insights: Insight[] }>({
    queryKey: ["/api/metrics/insights/me"],
  });

  if (isLoading) return <LoadingSkeleton />;

  if (data && !data.hasSeat) {
    return (
      <div className="rounded-2xl border border-border bg-card p-6 text-center">
        <p className="text-sm font-semibold text-foreground">No field seat on this account</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Field metrics are recorded against a roster seat. Ask an admin to link this login to a rep record.
        </p>
      </div>
    );
  }

  const facts = data?.facts;
  const metrics = data?.metrics;
  const prev = data?.previous?.metrics;
  const team = data?.teamBaseline;
  const daily = data?.daily ?? [];

  return (
    <div className="space-y-5">
      <FieldModeCard />

      <PeriodChips value={period} onChange={setPeriod} />

      {/* ── Top KPIs ─────────────────────────────────────────────────────── */}
      <section>
        <SectionLabel className="mb-2 px-1">Performance</SectionLabel>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MetricCard metricKey="doorsAttempted" value={facts?.doorsAttempted ?? null}
                      baseline={data?.previous?.facts.doorsAttempted ?? null} accent />
          <MetricCard metricKey="doorsPerActiveHour" value={metrics?.doorsPerActiveHour ?? null}
                      baseline={team?.doorsPerActiveHour ?? prev?.doorsPerActiveHour ?? null}
                      baselineLabel={team ? "Team median" : "Previous period"} />
          <MetricCard metricKey="contactRate" value={metrics?.contactRate ?? null}
                      baseline={team?.contactRate ?? prev?.contactRate ?? null}
                      baselineLabel={team ? "Team median" : "Previous period"} />
          <MetricCard metricKey="submissionRate" value={metrics?.submissionRate ?? null}
                      baseline={team?.submissionRate ?? prev?.submissionRate ?? null}
                      baselineLabel={team ? "Team median" : "Previous period"} />
          <MetricCard metricKey="installRate" value={metrics?.installRate ?? null}
                      baseline={team?.installRate ?? null} baselineLabel={team ? "Team median" : undefined} />
          <MetricCard metricKey="utilizationRate" value={metrics?.utilizationRate ?? null}
                      baseline={team?.utilizationRate ?? null} baselineLabel={team ? "Team median" : undefined} />
          <MetricCard metricKey="activeSeconds" value={facts?.activeSeconds ?? null}
                      baseline={data?.previous?.facts.activeSeconds ?? null} />
          <MetricCard metricKey="medianSecondsBetweenDoors" value={metrics?.medianSecondsBetweenDoors ?? null}
                      baseline={team?.medianSecondsBetweenDoors ?? null}
                      baselineLabel={team ? "Team median" : undefined} />
        </div>
        {!team && (
          <p className="mt-2 px-1 text-[11px] text-muted-foreground">
            Team comparisons appear once enough teammates have activity in this period for a median that
            does not identify one person.
          </p>
        )}
      </section>

      {/* ── Field scorecard ──────────────────────────────────────────────── */}
      <section>
        <SectionLabel className="mb-2 px-1">Field scorecard</SectionLabel>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          <CountCard label="Doors attempted" value={facts?.doorsAttempted ?? 0} tone="primary" />
          <CountCard label="Verified doors" value={facts?.verifiedDoors ?? 0} />
          <CountCard label="Contacts" value={facts?.contacts ?? 0} tone="primary" />
          <CountCard label="Interested" value={facts?.interestedLeads ?? 0} />
          <CountCard label="Appointments" value={facts?.appointments ?? 0} />
          <CountCard label="Follow-ups due" value={facts?.followUps ?? 0} tone="warning" />
          <CountCard label="Submitted" value={facts?.submittedOrders ?? 0} tone="success" />
          <CountCard label="Installed" value={facts?.installedOrders ?? 0} tone="success" />
          <CountCard label="Doors remaining" value={metrics?.untouchedAssignedDoors ?? 0} />
          <CountCard label="Distance" value={formatMetric("distanceMeters", facts?.distanceMeters ?? null)} />
          <CountCard label="Estimated pay"
                     value={formatMetric("estimatedCommissionCents", facts?.estimatedCommissionCents ?? null)} />
          <CountCard label="Paid"
                     value={formatMetric("paidCommissionCents", facts?.paidCommissionCents ?? null)} tone="success" />
        </div>
      </section>

      {/* ── Coaching ─────────────────────────────────────────────────────── */}
      <CoachingPanel insights={insightData?.insights ?? []} />

      {/* ── Charts ───────────────────────────────────────────────────────── */}
      <div className="grid gap-3 lg:grid-cols-2">
        <ChartFrame title="Conversion funnel"
                    hint="Each step shows how many carried through from the one above.">
          <FunnelChart stages={data?.funnel ?? []} />
        </ChartFrame>

        <ChartFrame title="Door activity by hour"
                    hint="Gold marks the doors where somebody answered.">
          <BarChart
            data={(hourly?.hours ?? []).map((h) => ({
              label: `${h.hour}`,
              value: h.doors,
              secondary: h.contacts,
            }))}
            emptyLabel="No doors logged in this period"
          />
        </ChartFrame>

        <ChartFrame title="Doors and contacts by day">
          <BarChart
            data={daily.map((d) => ({
              label: d.metricDate.slice(5),
              value: d.doorsAttempted,
              secondary: d.contacts,
            }))}
            emptyLabel="No days with activity yet"
          />
        </ChartFrame>

        <ChartFrame title="Time between doors"
                    hint="Median gap per day. Breaks over 45 minutes are excluded.">
          <LineChart
            points={daily.map((d) => ({
              label: d.metricDate.slice(5),
              value: d.medianSecondsBetweenDoors,
            }))}
            format={(v) => formatDuration(v)}
            emptyLabel="Two days of activity needed for a trend"
          />
        </ChartFrame>

        <ChartFrame title="Activity calendar" hint="Darker days are busier.">
          <ActivityCalendar days={daily.map((d) => ({ date: d.metricDate, value: d.doorsAttempted }))} />
        </ChartFrame>

        <ChartFrame title="Follow-up completion"
                    hint="Booked returns worked, against booked returns created.">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-2xl font-bold tabular-nums text-foreground">
                {formatRate(metrics?.callbackCompletionRate ?? null)}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {facts?.followUpsCompleted ?? 0} of {facts?.followUps ?? 0}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-success"
                   style={{ width: `${Math.round((metrics?.callbackCompletionRate ?? 0) * 100)}%` }} />
            </div>
          </div>
        </ChartFrame>
      </div>
    </div>
  );
}

// ── Coaching panel ───────────────────────────────────────────────────────────

const SEVERITY_STYLE: Record<Insight["severity"], { rail: string; chip: string; label: string }> = {
  urgent: { rail: "bg-destructive", chip: "bg-destructive/15 text-destructive", label: "Act today" },
  coaching_needed: { rail: "bg-warning", chip: "bg-warning/15 text-warning", label: "Worth working on" },
  positive: { rail: "bg-success", chip: "bg-success/15 text-success", label: "Going well" },
  neutral: { rail: "bg-info", chip: "bg-info/15 text-info", label: "Heads up" },
};

export function CoachingPanel({ insights }: { insights: readonly Insight[] }) {
  if (insights.length === 0) {
    return (
      <section>
        <SectionLabel className="mb-2 px-1">How to improve</SectionLabel>
        <div className="rounded-2xl border border-border bg-card p-4 text-xs text-muted-foreground">
          Nothing to flag yet. Coaching notes appear once there is enough activity in a week to compare
          fairly, so a quiet day never produces one.
        </div>
      </section>
    );
  }

  return (
    <section>
      <SectionLabel className="mb-2 px-1">How to improve</SectionLabel>
      <div className="space-y-2">
        {insights.map((i) => {
          const style = SEVERITY_STYLE[i.severity] ?? SEVERITY_STYLE.neutral;
          return (
            <article key={i.id}
                     className="relative overflow-hidden rounded-2xl border border-border bg-card p-4"
                     data-testid={`insight-${i.id}`}>
              <span className={`absolute inset-y-0 left-0 w-[3px] ${style.rail}`} aria-hidden="true" />
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[13px] font-semibold text-foreground">{i.title}</h3>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${style.chip}`}>
                  {style.label}
                </span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{i.explanation}</p>
              <p className="mt-2 rounded-lg bg-secondary px-2.5 py-2 text-xs font-medium leading-relaxed text-foreground">
                {i.suggestedAction}
              </p>
              {i.supportingMetrics && i.supportingMetrics.length > 0 && (
                <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-3">
                  {i.supportingMetrics.map((m) => (
                    <div key={m.key} className="min-w-0">
                      <dt className="truncate text-[10px] text-muted-foreground">{m.label}</dt>
                      <dd className="text-[12px] font-semibold tabular-nums text-foreground">
                        {m.value}
                        {m.baseline && <span className="ml-1 font-normal text-muted-foreground">vs {m.baseline}</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="mt-2.5 flex items-center gap-3 text-[11px]">
                <span className="text-muted-foreground">{i.periodStart} to {i.periodEnd}</span>
                {i.dataLink && (
                  <a href={`/#${i.dataLink}`} className="font-semibold text-primary underline underline-offset-2">
                    See the data
                  </a>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-28 rounded-2xl" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
      </div>
      <Skeleton className="h-48 rounded-2xl" />
    </div>
  );
}
