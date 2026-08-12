// ── Operations: Order Recovery ───────────────────────────────────────────────
//
// The board a manager works from: what the provider says is happening to every
// submitted order, which of those need a person, and what happened to the ones
// that got one.
//
// TWO NUMBERS THAT ARE NOT THE SAME NUMBER. "Installed" comes from the provider
// and means a technician finished. "Paid" comes from the commission file and
// means money arrived. This screen never conflates them, and the commission at
// risk is labelled an estimate because that is what it is: a count multiplied
// by a per-order value an admin configured.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, SectionLabel, StatStrip, StatTile } from "@/components/ui/page-scaffold";
import { CaseDetailPanel, CaseSummaryRow, PRIORITY_LABEL, type RecoveryCaseRow } from "@/features/recovery/RecoveryCase";
import { ORDER_STATUS_LABELS, type NormalizedOrderStatus } from "@shared/orderStatusSource";
import {
  RECOVERY_PRIORITIES, RECOVERY_REASON_LABELS, type RecoveryPriority, type RecoveryReason,
} from "@shared/orderRecovery";

interface MetricsResponse {
  funnel: Record<string, number>;
  recovery: {
    openCases: number;
    byPriority: Record<string, number>;
    byReason: Record<string, number>;
    resolvedTotal: number;
    recoveredTotal: number;
    recoveredInstalled: number;
    conversionRate: number;
    outreachSent: number;
    outreachDelivered: number;
    outreachReplied: number;
    outreachOptOuts: number;
    estimatedCommissionAtRiskCents: number;
    estimatedRecoveredCommissionCents: number;
  };
  estimatedOrderValueCents: number;
}

const money = (cents: number) =>
  `$${Math.round(cents / 100).toLocaleString("en-US")}`;

const FUNNEL_ORDER: NormalizedOrderStatus[] = [
  "submitted", "accepted", "install_scheduled", "installed",
  "failed_install", "missed_appointment", "pending_customer_action",
  "pending_documents", "on_hold", "canceled", "rejected", "unknown",
];

export default function OrderRecovery() {
  const [openCase, setOpenCase] = useState<number | null>(null);
  const [priority, setPriority] = useState<RecoveryPriority | "">("");

  const metrics = useQuery<MetricsResponse>({ queryKey: ["/api/order-recovery/metrics"] });
  const cases = useQuery<{ cases: RecoveryCaseRow[]; messagingEnabled: boolean }>({
    queryKey: ["/api/order-recovery/cases", priority],
    queryFn: async () => {
      const url = priority
        ? `/api/order-recovery/cases?priority=${priority}`
        : "/api/order-recovery/cases";
      const { apiRequest } = await import("@/lib/queryClient");
      return (await apiRequest("GET", url)).json();
    },
  });

  const r = metrics.data?.recovery;

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-16 pt-5 md:px-6" data-testid="order-recovery-page">
      <PageHeader
        title="Order recovery"
        subtitle="Submitted orders that stalled, and what is being done about them."
      />

      {metrics.isLoading && <Skeleton className="mb-4 h-24 w-full" />}

      {r && (
        <>
          <SectionLabel>Where the orders are</SectionLabel>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {FUNNEL_ORDER.filter((s) => (metrics.data?.funnel[s] ?? 0) > 0).map((status) => (
              <div key={status} className="rounded-lg border border-border/60 p-3" data-testid={`funnel-${status}`}>
                <p className="text-xs text-muted-foreground">{ORDER_STATUS_LABELS[status]}</p>
                <p className="text-lg font-semibold">{metrics.data?.funnel[status] ?? 0}</p>
              </div>
            ))}
          </div>

          <SectionLabel>Recovery</SectionLabel>
          <StatStrip columns={4} className="mb-2">
            <StatTile label="Open cases" value={String(r.openCases)} accent testId="stat-open-cases" />
            <StatTile label="Recovered" value={String(r.recoveredTotal)} testId="stat-recovered" />
            <StatTile
              label="Recovered to install"
              value={`${Math.round(r.conversionRate * 100)}%`}
              testId="stat-conversion"
            />
            <StatTile label="Opt-outs" value={String(r.outreachOptOuts)} testId="stat-optouts" />
          </StatStrip>

          <StatStrip columns={4} className="mb-4">
            <StatTile label="Messages sent" value={String(r.outreachSent)} />
            <StatTile label="Delivered" value={String(r.outreachDelivered)} />
            <StatTile label="Replies" value={String(r.outreachReplied)} />
            <StatTile label="Installs recovered" value={String(r.recoveredInstalled)} />
          </StatStrip>

          <Card className="mb-4">
            <CardHeader><CardTitle className="text-base">Commission exposure</CardTitle></CardHeader>
            <CardContent className="text-sm">
              {metrics.data!.estimatedOrderValueCents > 0 ? (
                <div className="flex flex-wrap gap-6">
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">At risk (estimate)</p>
                    <p className="text-lg font-semibold">{money(r.estimatedCommissionAtRiskCents)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Recovered (estimate)</p>
                    <p className="text-lg font-semibold">{money(r.estimatedRecoveredCommissionCents)}</p>
                  </div>
                </div>
              ) : (
                <p className="text-muted-foreground">
                  No per-order value is configured, so no dollar figure is shown. Set one in the recovery policy to
                  turn these counts into an estimate. Real commission comes from the commission file, not from here.
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {openCase != null ? (
        <CaseDetailPanel caseId={openCase} onClose={() => setOpenCase(null)} />
      ) : (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Queue</CardTitle>
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                variant={priority === "" ? "default" : "outline"}
                onClick={() => setPriority("")}
                data-testid="filter-all"
              >
                All
              </Button>
              {RECOVERY_PRIORITIES.map((p) => (
                <Button
                  key={p}
                  size="sm"
                  variant={priority === p ? "default" : "outline"}
                  onClick={() => setPriority(p)}
                  data-testid={`filter-${p}`}
                >
                  {PRIORITY_LABEL[p]}
                  {r?.byPriority[p] ? ` (${r.byPriority[p]})` : ""}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {cases.isLoading && <Skeleton className="h-24 w-full" />}
            {cases.data?.cases.length === 0 && (
              <p className="text-sm text-muted-foreground" data-testid="empty-queue">
                Nothing needs recovery right now.
              </p>
            )}
            {cases.data?.cases.map((row) => (
              <CaseSummaryRow key={row.id} row={row} onOpen={setOpenCase} />
            ))}
          </CardContent>
        </Card>
      )}

      {r && Object.keys(r.byReason).length > 0 && (
        <Card className="mt-4">
          <CardHeader><CardTitle className="text-base">Why cases are open</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {Object.entries(r.byReason).sort((a, b) => b[1] - a[1]).map(([reason, count]) => (
              <div key={reason} className="flex justify-between">
                <span>{RECOVERY_REASON_LABELS[reason as RecoveryReason] ?? reason}</span>
                <span className="text-muted-foreground">{count}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
