// ── Territory Metrics — utilization and reclaim review ───────────────────────
//
// THE RECLAIM CONTROL ON THIS SCREEN DOES NOT RECLAIM ANYTHING.
//
// It records a DECISION against a recommendation, to an audited row. Moving
// doors still happens through the existing rank-gated territory routes, on the
// Areas screen, by somebody who chose to do it. That separation is the brief's
// requirement ("do not automatically reclaim without an authorized role
// decision") expressed as architecture rather than as a promise: this component
// has no endpoint that could take an area off a rep.
//
// The recommendation itself always shows its full reasoning - assignment age,
// utilization, hours since activity, fresh doors remaining - because a manager
// is about to take work away from somebody based on it, and "the system said
// so" is not something they should have to say.

import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { useToast } from "@/hooks/use-toast";
import { useModalA11y } from "@/hooks/use-modal-a11y";
import { useCan } from "@/lib/capabilities";
import { CountCard } from "./MetricCard";
import { METRICS_REFETCH_MS, MetricsErrorState } from "./MetricsDataState";
import { formatRate } from "@shared/repMetrics";
import {
  TERRITORY_STATUS_TONE,
  type TerritoryFacts,
  type TerritoryHealth,
  type TerritoryStatus,
} from "@shared/territoryHealth";

interface TerritoryRow {
  territoryId: number;
  territoryName: string;
  facts: TerritoryFacts;
  health: TerritoryHealth;
  statusLabel: string;
  riskScore: number;
}

const TONE_CLASS: Record<string, string> = {
  success: "bg-success/15 text-success",
  info: "bg-info/15 text-info",
  neutral: "bg-secondary text-muted-foreground",
  warning: "bg-warning/15 text-warning",
  destructive: "bg-destructive/15 text-destructive",
};

export function TerritoryMetrics() {
  const [statusFilter, setStatusFilter] = useState<TerritoryStatus | "all">("all");
  const [openId, setOpenId] = useState<number | null>(null);

  const { data, isLoading, isError, isFetching, refetch } = useQuery<{ rows: TerritoryRow[] }>({
    queryKey: ["/api/metrics/territories"],
    refetchInterval: METRICS_REFETCH_MS,
  });

  const rows = data?.rows ?? [];
  const filtered = useMemo(
    () => (statusFilter === "all" ? rows : rows.filter((r) => r.health.status === statusFilter)),
    [rows, statusFilter],
  );

  const statuses = useMemo(() => {
    const counts = new Map<TerritoryStatus, number>();
    for (const r of rows) counts.set(r.health.status, (counts.get(r.health.status) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  if (isLoading) return <Skeleton className="h-64 rounded-2xl" />;

  if (isError || !data) {
    return <MetricsErrorState onRetry={() => { void refetch(); }} retrying={isFetching} />;
  }

  const totals = rows.reduce((acc, r) => ({
    eligible: acc.eligible + r.facts.eligibleDoors,
    worked: acc.worked + r.facts.everWorkedDoors,
    untouched: acc.untouched + r.health.untouchedDoors,
    reclaim: acc.reclaim + (r.health.reclaimRecommended ? 1 : 0),
  }), { eligible: 0, worked: 0, untouched: 0, reclaim: 0 });

  return (
    <div className="space-y-5">
      <section>
        <SectionLabel className="mb-2 px-1">Across your areas</SectionLabel>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <CountCard label="Areas" value={rows.length} />
          <CountCard label="Eligible doors" value={totals.eligible.toLocaleString()} tone="primary" />
          <CountCard label="Untouched doors" value={totals.untouched.toLocaleString()} tone="warning" />
          <CountCard label="Flagged for review" value={totals.reclaim} tone={totals.reclaim > 0 ? "warning" : "neutral"} />
        </div>
      </section>

      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        <FilterChip active={statusFilter === "all"} onClick={() => setStatusFilter("all")}>
          All ({rows.length})
        </FilterChip>
        {statuses.map(([status, count]) => (
          <FilterChip key={status} active={statusFilter === status} onClick={() => setStatusFilter(status)}>
            {status.replace(/_/g, " ")} ({count})
          </FilterChip>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-6 text-center text-xs text-muted-foreground">
          No areas match this filter.
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((r) => (
            <TerritoryCard key={r.territoryId} row={r} onReview={() => setOpenId(r.territoryId)} />
          ))}
        </div>
      )}

      {openId != null && (
        <ReclaimReviewDialog
          row={rows.find((r) => r.territoryId === openId)!}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick}
            className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold capitalize transition-colors ${
              active ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"
            }`}>
      {children}
    </button>
  );
}

function TerritoryCard({ row, onReview }: { row: TerritoryRow; onReview: () => void }) {
  const canReview = useCan("territory.reclaim.review");
  const tone = TONE_CLASS[TERRITORY_STATUS_TONE[row.health.status]] ?? TONE_CLASS.neutral;

  return (
    <article className="rounded-2xl border border-border bg-card p-4" data-testid={`territory-${row.territoryId}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-[14px] font-semibold text-foreground">{row.territoryName}</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {row.facts.eligibleDoors.toLocaleString()} eligible doors
            {row.facts.activeRepCount > 0 && ` · ${row.facts.activeRepCount} rep${row.facts.activeRepCount === 1 ? "" : "s"} active`}
            {row.health.hoursSinceActivity != null &&
              ` · last activity ${Math.floor(row.health.hoursSinceActivity)}h ago`}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${tone}`}>
          {row.statusLabel}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Stat label="Utilization" value={formatRate(row.health.utilizationRate)} />
        <Stat label="Coverage" value={formatRate(row.health.coverageRate)} />
        <Stat label="Conversion" value={formatRate(row.health.conversionRate)} />
        <Stat label="Untouched" value={row.health.untouchedDoors.toLocaleString()} />
        <Stat label="Fresh utilization" value={formatRate(row.health.freshUtilizationRate)} />
        <Stat label="Contacts" value={row.facts.contacts.toLocaleString()} />
        <Stat label="Submitted" value={row.facts.submittedOrders.toLocaleString()} />
        <Stat label="Callbacks due" value={row.facts.callbacksDue.toLocaleString()} />
      </dl>

      {row.health.reasons.length > 0 && (
        <ul className="mt-3 space-y-1">
          {row.health.reasons.map((reason, i) => (
            <li key={i} className="text-[11px] leading-relaxed text-muted-foreground">{reason}</li>
          ))}
        </ul>
      )}

      {row.health.reclaimRecommended && (
        <div className="mt-3 rounded-xl border border-warning/30 bg-warning/10 p-3">
          <p className="text-[11px] font-semibold text-foreground">Recommended for manager review</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{row.health.reclaimRationale}</p>
          {canReview && (
            <Button size="sm" variant="outline" className="mt-2.5" onClick={onReview}
                    data-testid={`review-${row.territoryId}`}>
              Record a decision
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-2xs text-muted-foreground">{label}</dt>
      <dd className="text-[13px] font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

const DECISIONS = [
  { key: "kept", label: "Keep with current rep", hint: "No change. The rep keeps the area." },
  { key: "deferred", label: "Check again later", hint: "Revisit after giving it more time." },
  { key: "reassigned", label: "Plan to reassign", hint: "Records the intent. Move the doors on the Areas screen." },
  { key: "reclaimed", label: "Plan to reclaim", hint: "Records the intent. Reclaim on the Areas screen." },
] as const;

function ReclaimReviewDialog({ row, onClose }: { row: TerritoryRow; onClose: () => void }) {
  const { toast } = useToast();
  // Modal contract for the aria-modal claim: focus in, Tab contained,
  // Escape closes, focus restored to the opener.
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, { active: true, onClose });
  const [decision, setDecision] = useState<string>("kept");
  const [note, setNote] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/metrics/territories/${row.territoryId}/review`, {
        decision, note,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/metrics/territories"] });
      toast({
        title: "Decision recorded",
        description: "Written to the audit trail. No doors have moved.",
      });
      onClose();
    },
    onError: (e: any) => toast({
      title: "Could not record the decision",
      description: String(e?.message ?? "Try again."),
      variant: "destructive",
    }),
  });

  return (
    <div className="fixed inset-0 z-overlay flex items-end justify-center sm:items-center" role="dialog" aria-modal="true"
         aria-label="Record a reclaim decision">
      <button type="button" className="absolute inset-0 bg-overlay backdrop-blur-[2px]" onClick={onClose}
              aria-label="Close" />
      <div ref={panelRef} className="relative w-full max-w-lg rounded-t-2xl border border-border bg-background p-4 sm:rounded-2xl">
        <h2 className="text-lg font-bold tracking-tight text-foreground">{row.territoryName}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{row.health.reclaimRationale}</p>

        <div className="mt-4 space-y-1.5">
          {DECISIONS.map((d) => (
            <label key={d.key}
                   className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition-colors ${
                     decision === d.key ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-secondary/50"
                   }`}>
              <input type="radio" name="decision" value={d.key} checked={decision === d.key}
                     onChange={() => setDecision(d.key)} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold text-foreground">{d.label}</span>
                <span className="block text-[11px] text-muted-foreground">{d.hint}</span>
              </span>
            </label>
          ))}
        </div>

        <Textarea className="mt-3" rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="Why did you decide this? Recorded with your name." />

        <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
          This records your decision to the audit trail. It does not move any doors. To actually reclaim or
          reassign, use the Areas screen, where the change is separately permission checked.
        </p>

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="review-save">
            Record decision
          </Button>
        </div>
      </div>
    </div>
  );
}
