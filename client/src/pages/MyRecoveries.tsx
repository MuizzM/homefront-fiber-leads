// ── Rep: My recoveries ───────────────────────────────────────────────────────
//
// A rep's own orders that stalled, in the order they should work them. The
// server scopes this to their roster seat, so this page has no filter that
// could widen it and no rep picker to get wrong.
//
// The framing matters: these are the rep's own sales, still unpaid. Every case
// here is a commission that has not happened yet and still can.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, StatStrip, StatTile } from "@/components/ui/page-scaffold";
import { CaseDetailPanel, CaseSummaryRow, type RecoveryCaseRow } from "@/features/recovery/RecoveryCase";
import { RECOVERY_PRIORITY_RANK } from "@shared/orderRecovery";

export default function MyRecoveries() {
  const [openCase, setOpenCase] = useState<number | null>(null);

  const cases = useQuery<{ cases: RecoveryCaseRow[]; messagingEnabled: boolean }>({
    queryKey: ["/api/order-recovery/cases"],
  });

  const rows = [...(cases.data?.cases ?? [])].sort(
    (a, b) => RECOVERY_PRIORITY_RANK[a.priority] - RECOVERY_PRIORITY_RANK[b.priority],
  );
  const urgent = rows.filter((r) => r.priority === "urgent").length;
  const dueToday = rows.filter((r) => r.nextActionAt && Date.parse(r.nextActionAt) <= Date.now()).length;

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-16 pt-5 md:px-6" data-testid="my-recoveries-page">
      <PageHeader
        title="My recoveries"
        subtitle="Orders you sold that have not installed yet, and still can."
      />

      <StatStrip columns={3} className="mb-4">
        <StatTile label="Open" value={String(rows.length)} accent testId="my-open" />
        <StatTile label="Urgent" value={String(urgent)} testId="my-urgent" />
        <StatTile label="Due now" value={String(dueToday)} testId="my-due" />
      </StatStrip>

      {openCase != null ? (
        <CaseDetailPanel caseId={openCase} onClose={() => setOpenCase(null)} />
      ) : (
        <Card>
          <CardHeader><CardTitle className="text-base">Work these in order</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {cases.isLoading && <Skeleton className="h-24 w-full" />}
            {!cases.isLoading && cases.isError && (
              // A failed load must not read as "nothing to chase" - that would
              // tell a rep their queue is clear when it may be full.
              <div role="alert" className="flex items-center justify-between gap-3 py-2">
                <p className="text-sm text-muted-foreground">Couldn't load your recoveries - some may still be waiting.</p>
                <Button variant="outline" size="sm" onClick={() => cases.refetch()}>Retry</Button>
              </div>
            )}
            {!cases.isLoading && !cases.isError && rows.length === 0 && (
              <p className="text-sm text-muted-foreground" data-testid="my-empty">
                Nothing to chase. Every order you sold is either moving or already installed.
              </p>
            )}
            {rows.map((row) => (
              <CaseSummaryRow key={row.id} row={row} onOpen={setOpenCase} />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
