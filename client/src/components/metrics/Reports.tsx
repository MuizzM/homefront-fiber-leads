// ── Reports — org-wide yield by carrier, product, program and team ───────────
//
// The owner/admin question this answers is "where do installed orders come
// from", which is a different question from "how is this rep doing" and lives
// on its own tab for that reason.
//
// TWO HONEST-ABOUT-THE-DATA DECISIONS:
//
//   Carrier, product and program come from the provider order feed
//   (vendor_orders). When that integration is dark - as it is in this org today
//   - those tables are legitimately empty, and the UI says so rather than
//   rendering a convincing chart of zeros.
//
//   Team yield comes from the metrics rollup instead, so it reports something
//   real whether or not the carrier feed is live.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { PeriodChips, type PeriodKey } from "./MyMetrics";
import {
  CommissionSourceNotice,
  METRICS_REFETCH_MS,
  MetricsErrorState,
} from "./MetricsDataState";
import { formatRate, rate } from "@shared/repMetrics";

interface DimensionRow { label: string; submitted: number; installed: number; canceled: number }
interface TeamRow {
  label: string; doorsAttempted: number; contacts: number;
  submitted: number; installed: number;
}

interface ReportsResponse {
  period: { from: string; to: string };
  groups: {
    carrier: DimensionRow[];
    product: DimensionRow[];
    program: DimensionRow[];
    team: TeamRow[];
  };
}

export function Reports() {
  const [period, setPeriod] = useState<PeriodKey>("month");
  const { data, isLoading, isError, isFetching, refetch } = useQuery<ReportsResponse>({
    queryKey: [`/api/metrics/reports?period=${period}`],
    refetchInterval: METRICS_REFETCH_MS,
  });

  if (isLoading) return <Skeleton className="h-64 rounded-2xl" />;

  if (isError || !data) {
    return (
      <div className="space-y-5">
        <PeriodChips value={period} onChange={setPeriod} />
        <MetricsErrorState onRetry={() => { void refetch(); }} retrying={isFetching} />
      </div>
    );
  }

  const g = data?.groups;
  const providerEmpty =
    (g?.carrier.length ?? 0) === 0 && (g?.product.length ?? 0) === 0 && (g?.program.length ?? 0) === 0;

  return (
    <div className="space-y-5">
      <PeriodChips value={period} onChange={setPeriod} />

      <section>
        <SectionLabel className="mb-2 px-1">Yield by team</SectionLabel>
        <TeamTable rows={g?.team ?? []} />
        {/* The two sections COUNT DIFFERENT THINGS and will disagree whenever
            the provider feed holds orders no rep is matched to. Without this
            line, "15 submitted" above "33 submitted" on one screen reads as a
            broken report rather than two lenses. */}
        {!providerEmpty && (
          <p className="mt-2 px-1 text-[11px] leading-relaxed text-muted-foreground">
            Team rows count orders attributed to a rep's field activity. The carrier, product and
            program cards below count every order in the provider feed for the period, including
            orders not yet matched to a rep - so their totals can legitimately differ.
          </p>
        )}
      </section>

      <CommissionSourceNotice manager />

      {providerEmpty ? (
        <section>
          <SectionLabel className="mb-2 px-1">Yield by carrier, product and program</SectionLabel>
          <div className="rounded-2xl border border-border bg-card p-5">
            <p className="text-sm font-semibold text-foreground">No provider order data for this period</p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              Carrier, product and program breakdowns come from the provider order feed. Nothing has been
              imported for this range, so there is nothing to report here rather than a chart of zeros.
              Team yield above is computed from field activity and pays no attention to that feed.
            </p>
          </div>
        </section>
      ) : (
        <>
          <DimensionSection title="Yield by carrier" rows={g?.carrier ?? []} />
          <DimensionSection title="Yield by product" rows={g?.product ?? []} />
          <DimensionSection title="Yield by program" rows={g?.program ?? []} />
        </>
      )}
    </div>
  );
}

function DimensionSection({ title, rows }: { title: string; rows: readonly DimensionRow[] }) {
  if (rows.length === 0) return null;
  const max = Math.max(1, ...rows.map((r) => r.submitted));
  return (
    <section>
      <SectionLabel className="mb-2 px-1">{title}</SectionLabel>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {rows.map((r) => (
          <div key={r.label} className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">{r.label}</span>
              <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                {r.submitted.toLocaleString()} submitted · {r.installed.toLocaleString()} installed
                {" · "}
                {formatRate(rate(r.installed, r.submitted))} install rate
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-chart-1"
                   style={{ width: `${(r.submitted / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function TeamTable({ rows }: { rows: readonly TeamRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card p-6 text-center text-xs text-muted-foreground">
        No field activity recorded in this period.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-card">
      <table className="w-full min-w-[600px] text-left text-[12px]">
        <thead>
          <tr className="border-b border-border">
            {["Team", "Doors", "Contacts", "Submitted", "Installed", "Install rate"].map((h, i) => (
              <th key={h} scope="col"
                  className={`px-3 py-2.5 font-semibold text-muted-foreground ${i > 0 ? "text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-border last:border-0">
              <td className="px-3 py-2.5 font-semibold text-foreground">{r.label}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{(r.doorsAttempted ?? 0).toLocaleString()}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{(r.contacts ?? 0).toLocaleString()}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{(r.submitted ?? 0).toLocaleString()}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{(r.installed ?? 0).toLocaleString()}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatRate(rate(r.installed ?? 0, r.submitted ?? 0))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
