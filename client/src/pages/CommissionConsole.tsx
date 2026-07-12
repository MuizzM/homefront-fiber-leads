import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useCan } from "@/lib/capabilities";
import { useToast } from "@/hooks/use-toast";
import { usd, usdSigned } from "@/lib/money";
import {
  Banknote, ChevronLeft, ChevronRight, Lock, CheckCircle2, AlertTriangle,
  Download, Users, Zap, X, FileText, Plus, ShieldCheck, Layers, DollarSign, Printer,
} from "lucide-react";
import { CommissionStatement, type StatementModel } from "@/components/CommissionStatement";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ── Commission Console — the weekly payroll cockpit ───────────────────────────
// One screen answers: how is the org producing, what is projected payroll, who
// is about to move tiers (and what that costs), what needs review, and what is
// final. The Sunday closeout (batch finalize → CSV → mark paid) lives here.
// Server-authoritative: every number on this page comes from the engine.

interface OverviewRow {
  repId: number; repName: string; active: boolean;
  statementId: number | null; status: string;
  qualifiedSaleCount: number; pendingSaleCount: number; reversedSaleCount: number;
  tierLabel: string | null; rateCents: number;
  grossCommissionCents: number; adjustmentCents: number; finalCommissionCents: number;
  structure: "FLAT" | "TIERED" | null; planAccepted: boolean;
  salesUntilNextTier: number | null; nextTierRateCents: number | null;
  nextTierProjectedCommissionCents: number | null; marginalJumpCents: number | null;
}
interface Overview {
  bounds: { weekStartUtc: string; nextWeekStartUtc: string; localWeekLabel: string; timezone: string };
  weekEnded: boolean;
  rows: OverviewRow[];
  totals: { projectedPayrollCents: number; finalizedPayrollCents: number; paidPayrollCents: number; exposureCents: number; qualifiedSales: number; repsWithSales: number };
  exceptions: Array<{ type: string; repId: number; repName: string; detail: string }>;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

const STATUS_STYLE: Record<string, string> = {
  OPEN: "bg-amber-500/15 text-amber-400",
  REVIEW: "bg-sky-500/15 text-sky-400",
  FINALIZED: "bg-primary/15 text-primary",
  PAID: "bg-emerald-500/15 text-emerald-400",
  NO_PLAN: "bg-rose-500/15 text-rose-400",
};
const STATUS_DOT: Record<string, string> = {
  OPEN: "bg-amber-400",
  REVIEW: "bg-sky-400",
  FINALIZED: "bg-primary",
  PAID: "bg-emerald-400",
  NO_PLAN: "bg-rose-400",
};

function StatusChip({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_STYLE[status] || "bg-secondary text-muted-foreground"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[status] || "bg-muted-foreground"}`} />
      {status === "NO_PLAN" ? "no plan" : status.toLowerCase()}
    </span>
  );
}

export default function CommissionConsole() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const canClose = useCan("commission.read.all");        // manager/admin: finalize, pay, export, adjust
  const [weekOffset, setWeekOffset] = useState(0);       // 0 = current, -1 = last week…
  const [drillRep, setDrillRep] = useState<OverviewRow | null>(null);
  const [confirmAction, setConfirmAction] = useState<"FINALIZE" | "MARK_PAID" | null>(null);

  // Anchor the reference instant ONCE per mount — a fresh Date.now() per render
  // would change the query key every render and refetch forever. The server
  // resolves any instant inside a week to that week's exact bounds.
  const [anchorMs] = useState(() => Date.now());
  const weekRef = new Date(anchorMs + weekOffset * WEEK_MS).toISOString();
  const ovKey = ["/api/commission/week-overview", weekRef];
  const { data: ov, isLoading, isError } = useQuery<Overview>({
    queryKey: ovKey,
    queryFn: () => apiRequest("GET", `/api/commission/week-overview?week=${encodeURIComponent(weekRef)}`).then(r => r.json()),
    refetchInterval: weekOffset === 0 ? 60_000 : false,  // live week ticks; history is settled
  });

  const transition = useMutation({
    mutationFn: (action: "FINALIZE" | "MARK_PAID") =>
      apiRequest("POST", "/api/commission/week/transition", { week: weekRef, action }).then(r => r.json()),
    onSuccess: (data: any, action) => {
      const done = data.results.filter((r: any) => r.result === (action === "FINALIZE" ? "FINALIZED" : "PAID")).length;
      const skipped = data.results.length - done;
      toast({
        title: action === "FINALIZE" ? `Week finalized — ${done} statement${done === 1 ? "" : "s"} locked` : `${done} statement${done === 1 ? "" : "s"} marked paid`,
        description: skipped > 0 ? `${skipped} already settled or skipped.` : "Every number on this week is now locked.",
      });
      qc.invalidateQueries({ queryKey: ["/api/commission/week-overview"] });
      setConfirmAction(null);
    },
    onError: (e: any) => toast({ title: "Closeout failed", description: e.message, variant: "destructive" }),
  });

  const openCount = ov?.rows.filter(r => r.status === "OPEN").length ?? 0;
  const finalizedCount = ov?.rows.filter(r => r.status === "FINALIZED").length ?? 0;
  const totalPayroll = (ov?.totals.projectedPayrollCents ?? 0) + (ov?.totals.finalizedPayrollCents ?? 0) + (ov?.totals.paidPayrollCents ?? 0);
  const nearTier = ov?.rows.filter(r => r.status === "OPEN" && r.salesUntilNextTier != null && r.salesUntilNextTier <= 2 && (r.marginalJumpCents ?? 0) > 0) ?? [];

  return (
    <div className="p-4 sm:p-6 pb-24 md:pb-6 max-w-5xl mx-auto space-y-5">
      {/* Header + week nav */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <Banknote className="w-5 h-5 text-primary" /> Commission Console
          </h1>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mt-1">
            Weekly closeout · projected payroll · Sunday finalize
          </p>
        </div>
        <div className="flex items-center gap-1.5" data-testid="week-nav">
          <Button variant="outline" size="sm" className="h-9 w-9 p-0 border-border" onClick={() => setWeekOffset(o => o - 1)} data-testid="week-prev">
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="text-center min-w-[170px]">
            <div className="text-sm font-semibold">{ov?.bounds.localWeekLabel ?? "…"}</div>
            <div className="text-[10px] text-muted-foreground">
              {weekOffset === 0
                ? (ov?.weekEnded ? "Week closed — ready to finalize" : "Live · Mon–Sun · updates as doors close")
                : weekOffset > 0 ? "Future week" : "Past week"}
            </div>
          </div>
          <Button variant="outline" size="sm" className="h-9 w-9 p-0 border-border" disabled={weekOffset >= 0}
            onClick={() => setWeekOffset(o => o + 1)} data-testid="week-next">
            <ChevronRight className="w-4 h-4" />
          </Button>
          {weekOffset !== 0 && (
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setWeekOffset(0)}>Today</Button>
          )}
        </div>
      </div>

      {isError && (
        <div className="rounded-xl bg-card border border-rose-500/30 p-6 text-center text-sm text-muted-foreground">
          Couldn't load the week. Retry in a moment.
        </div>
      )}
      {isLoading && <div className="h-48 rounded-2xl bg-card border border-border animate-pulse" />}

      {ov && (
        <>
          {/* Payroll totals — a hairline-divided metric strip. The ONE total
              dominates; Projected / Finalized / Paid are its unambiguous
              breakdown, never overlapping figures. */}
          <div className="rounded-xl bg-card border border-border overflow-hidden">
            <div className="flex flex-col sm:flex-row divide-y sm:divide-y-0 sm:divide-x divide-border">
              <div className="flex-1 p-4 sm:pr-6" data-testid="tile-total">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-primary font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary" /> Total payroll
                </div>
                <div className="mt-1.5 text-3xl font-semibold tracking-tight tabular-nums text-foreground">{usd(totalPayroll)}</div>
                <div className="text-[11px] text-muted-foreground mt-1">
                  {ov.totals.qualifiedSales} qualified sale{ov.totals.qualifiedSales === 1 ? "" : "s"} · {ov.totals.repsWithSales} rep{ov.totals.repsWithSales === 1 ? "" : "s"} producing
                </div>
              </div>
              <div className="flex-1 p-4" data-testid="tile-projected">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Still projected
                </div>
                <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums text-foreground">{usd(ov.totals.projectedPayrollCents)}</div>
                <div className="text-[11px] text-muted-foreground mt-1">{openCount > 0 ? `${openCount} open week${openCount === 1 ? "" : "s"}` : "All settled"}</div>
              </div>
              <div className="flex-1 p-4" data-testid="tile-finalized">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary" /> Finalized
                </div>
                <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums text-foreground">{usd(ov.totals.finalizedPayrollCents)}</div>
                <div className="text-[11px] text-muted-foreground mt-1">{finalizedCount > 0 ? `${finalizedCount} locked` : "None yet"}</div>
              </div>
              <div className="flex-1 p-4" data-testid="tile-paid">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Paid
                </div>
                <div className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums text-foreground">{usd(ov.totals.paidPayrollCents)}</div>
                <div className="text-[11px] text-muted-foreground mt-1">{ov.totals.paidPayrollCents > 0 ? "Money moved" : "Awaiting payout"}</div>
              </div>
            </div>
            {ov.totals.exposureCents > 0 && (
              <div className="border-t border-border px-4 py-2.5 flex items-start gap-1.5 text-[11px] text-amber-400 bg-amber-500/[0.06]">
                <Zap className="w-3.5 h-3.5 mt-px flex-shrink-0" />
                <span>Could rise <strong className="tabular-nums">+{usd(ov.totals.exposureCents)}</strong> if {nearTier.length} rep{nearTier.length === 1 ? "" : "s"} hit{nearTier.length === 1 ? "s" : ""} the next tier by Sunday</span>
              </div>
            )}
          </div>

          {/* Needs review — actionable, never decorative */}
          {ov.exceptions.length > 0 ? (
            <div className="rounded-2xl bg-card border border-amber-500/30 overflow-hidden" data-testid="exceptions-panel">
              <div className="px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-semibold text-foreground">Needs review before closeout</span>
                <span className="ml-auto text-xs text-muted-foreground">{ov.exceptions.length}</span>
              </div>
              <div className="divide-y divide-border">
                {ov.exceptions.map((ex, i) => (
                  <div key={i} className="px-4 py-2.5 flex items-start gap-3 text-sm">
                    <span className="text-[9px] font-bold uppercase tracking-wide text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5 mt-0.5 whitespace-nowrap">
                      {ex.type.replace(/_/g, " ").toLowerCase()}
                    </span>
                    <span className="text-muted-foreground">
                      <button className="text-foreground font-medium hover:text-primary" onClick={() => { const r = ov.rows.find(x => x.repId === ex.repId); if (r) setDrillRep(r); }}>{ex.repName}</button>
                      {" — "}{ex.detail}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-card border border-border px-4 py-2.5 flex items-center gap-2 text-sm text-muted-foreground" data-testid="exceptions-clear">
              <ShieldCheck className="w-4 h-4 text-emerald-400" /> Nothing needs review — every number is explainable.
            </div>
          )}

          {/* Rep table */}
          <div className="rounded-2xl bg-card border border-border overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <Users className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-semibold">Reps this week</span>
              <span className="ml-auto text-xs text-muted-foreground">tap a row to explain every dollar</span>
            </div>
            {ov.rows.length === 0 ? (
              <div className="p-10 text-center">
                <div className="w-12 h-12 rounded-2xl bg-secondary/60 border border-border flex items-center justify-center mx-auto mb-3">
                  <Users className="w-6 h-6 text-muted-foreground" />
                </div>
                <p className="text-sm font-semibold text-foreground">No reps producing this week yet</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
                  As reps close doors, their statements appear here. Onboard a rep and assign a plan from the Team page to get started.
                </p>
              </div>
            ) : (
              <>
              {/* Mobile: card list — Rep + Commission + Status never scroll off. */}
              <div className="sm:hidden divide-y divide-border">
                {ov.rows.map(r => (
                  <button key={r.repId} onClick={() => setDrillRep(r)} data-testid={`card-rep-${r.repId}`}
                    className="w-full text-left px-4 py-3 active:bg-secondary/50 transition-colors">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-foreground truncate flex items-center gap-1.5">{r.repName}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {r.qualifiedSaleCount} sale{r.qualifiedSaleCount === 1 ? "" : "s"}
                          {r.rateCents > 0 ? ` · ${usd(r.rateCents)}/sale` : ""}
                          {r.tierLabel ? ` · ${r.tierLabel}` : ""}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="font-bold tabular-nums text-foreground">{usd(r.finalCommissionCents)}</div>
                        <StatusChip status={r.status} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-1.5">
                      {r.structure && !r.planAccepted && (
                        <span className="text-[9px] font-bold uppercase text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5">plan not accepted</span>
                      )}
                      {r.status === "OPEN" && r.salesUntilNextTier != null && (r.marginalJumpCents ?? 0) > 0 && (
                        <span className={`text-[11px] ${r.salesUntilNextTier <= 2 ? "text-amber-400 font-semibold" : "text-muted-foreground"}`}>
                          {r.salesUntilNextTier} to next tier → +{usd(r.marginalJumpCents!)}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
              {/* Desktop: full table */}
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm min-w-[640px]">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border bg-secondary/30">
                      <th className="text-left font-semibold px-4 py-2.5">Rep</th>
                      <th className="text-right font-semibold px-2 py-2.5">Sales</th>
                      <th className="text-left font-semibold px-2 py-2.5">Tier · rate</th>
                      <th className="text-left font-semibold px-2 py-2.5">Next tier</th>
                      <th className="text-right font-semibold px-2 py-2.5">Adj</th>
                      <th className="text-right font-semibold px-2 py-2.5">Commission</th>
                      <th className="text-right font-semibold px-4 py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {ov.rows.map(r => (
                      <tr key={r.repId} className="hover:bg-secondary/40 cursor-pointer transition-colors focus:outline-none focus:bg-secondary/60 focus-visible:ring-1 focus-visible:ring-primary"
                        role="button" tabIndex={0} aria-label={`Explain ${r.repName}'s ${usd(r.finalCommissionCents)}`}
                        onClick={() => setDrillRep(r)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDrillRep(r); } }}
                        data-testid={`row-rep-${r.repId}`}>
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-foreground flex items-center gap-1.5">
                            {r.repName}
                            {r.structure && !r.planAccepted && (
                              <span className="text-[8px] font-bold uppercase text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-1 py-0.5">not accepted</span>
                            )}
                          </div>
                          <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                            {r.structure === "FLAT" ? <DollarSign className="w-2.5 h-2.5" /> : r.structure === "TIERED" ? <Layers className="w-2.5 h-2.5" /> : null}
                            {r.structure === "FLAT" ? "Flat" : r.structure === "TIERED" ? "Tiered" : "No plan"}
                          </div>
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums">
                          <span className="font-semibold text-foreground">{r.qualifiedSaleCount}</span>
                          {(r.pendingSaleCount > 0 || r.reversedSaleCount > 0) && (
                            <div className="text-[10px] text-muted-foreground">
                              {r.pendingSaleCount > 0 && `${r.pendingSaleCount} pending`}
                              {r.pendingSaleCount > 0 && r.reversedSaleCount > 0 && " · "}
                              {r.reversedSaleCount > 0 && `${r.reversedSaleCount} reversed`}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-muted-foreground">
                          {r.rateCents > 0 ? <>{r.tierLabel ?? "Flat"} <span className="text-foreground/80 tabular-nums">{usd(r.rateCents)}</span></> : "—"}
                        </td>
                        <td className="px-2 py-2.5">
                          {r.status === "OPEN" && r.salesUntilNextTier != null && r.marginalJumpCents != null && r.marginalJumpCents > 0 ? (
                            <span className={`text-xs ${r.salesUntilNextTier <= 2 ? "text-amber-400 font-semibold" : "text-muted-foreground"}`}>
                              {r.salesUntilNextTier} to go → <span className="tabular-nums">+{usd(r.marginalJumpCents)}</span>
                            </span>
                          ) : <span className="text-xs text-muted-foreground">—</span>}
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                          {r.adjustmentCents !== 0 ? usdSigned(r.adjustmentCents) : "—"}
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums font-bold text-foreground">{usd(r.finalCommissionCents)}</td>
                        <td className="px-4 py-2.5 text-right"><StatusChip status={r.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </div>

          {/* Closeout bar — manager/admin only */}
          {canClose && (
            <div className="rounded-2xl bg-card border border-border p-3 flex items-center gap-2 flex-wrap" data-testid="closeout-bar">
              <div className="text-xs text-muted-foreground mr-auto">
                {openCount > 0
                  ? <>Sunday closeout: <strong className="text-foreground">{openCount} open</strong> statement{openCount === 1 ? "" : "s"} will be recalculated, then locked.</>
                  : finalizedCount > 0 ? "Week is finalized — export payroll, then mark paid." : "Week is settled."}
              </div>
              <a href={`/api/commission/week-export.csv?week=${encodeURIComponent(weekRef)}`}
                onClick={e => { e.preventDefault(); downloadCsv(weekRef); }}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                data-testid="export-csv">
                <Download className="w-3.5 h-3.5" /> Export CSV
              </a>
              <Button size="sm" className="h-8 bg-primary hover:bg-primary/90 text-white text-xs"
                disabled={openCount === 0 || transition.isPending}
                onClick={() => setConfirmAction("FINALIZE")} data-testid="btn-finalize-week">
                <Lock className="w-3.5 h-3.5 mr-1" /> Finalize week
              </Button>
              <Button size="sm" variant="outline" className="h-8 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 text-xs"
                disabled={finalizedCount === 0 || transition.isPending}
                onClick={() => setConfirmAction("MARK_PAID")} data-testid="btn-mark-paid">
                <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Mark paid
              </Button>
            </div>
          )}
        </>
      )}

      {/* Confirm closeout */}
      <Dialog open={!!confirmAction} onOpenChange={v => !v && setConfirmAction(null)}>
        <DialogContent className="bg-card border-border text-foreground max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">
              {confirmAction === "FINALIZE" ? "Finalize this week?" : "Mark finalized statements paid?"}
            </DialogTitle>
          </DialogHeader>
          {confirmAction === "FINALIZE" ? (
            <div className="text-sm text-muted-foreground space-y-2">
              <p><strong className="text-foreground">{openCount}</strong> open statement{openCount === 1 ? "" : "s"} ({usd(ov?.totals.projectedPayrollCents ?? 0)}) will be recalculated one final time and locked. Locked numbers never change silently — later corrections happen as audited adjustments.</p>
              {!ov?.weekEnded && (
                <p className="text-amber-400 flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  This week is still live (ends Sunday night, org time). Finalizing early locks out any sales closed after this moment.
                </p>
              )}
              {ov && ov.exceptions.length > 0 && (
                <p className="text-amber-400 flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  {ov.exceptions.length} item{ov.exceptions.length === 1 ? "" : "s"} still need review.
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              <strong className="text-foreground">{finalizedCount}</strong> finalized statement{finalizedCount === 1 ? "" : "s"} ({usd(ov?.totals.finalizedPayrollCents ?? 0)}) will be marked paid. Do this after money actually moves.
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" className="border-border" onClick={() => setConfirmAction(null)}>Cancel</Button>
            <Button className="bg-primary hover:bg-primary/90 text-white" disabled={transition.isPending}
              onClick={() => confirmAction && transition.mutate(confirmAction)} data-testid="btn-confirm-closeout">
              {transition.isPending ? "Working…" : confirmAction === "FINALIZE" ? `Lock ${openCount} statement${openCount === 1 ? "" : "s"}` : "Mark paid"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Statement drill-down */}
      <StatementDrawer row={drillRep} weekRef={weekRef} weekLabel={ov?.bounds.localWeekLabel ?? ""} canAdjust={canClose} onClose={() => { setDrillRep(null); qc.invalidateQueries({ queryKey: ["/api/commission/week-overview"] }); }} />
    </div>
  );
}

function downloadCsv(weekRef: string) {
  apiRequest("GET", `/api/commission/week-export.csv?week=${encodeURIComponent(weekRef)}`)
    .then(r => r.blob())
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `payroll-${weekRef.slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    });
}

// ── Drill-down: explain every dollar ──────────────────────────────────────────
// Final total → tier math → the exact doors → adjustments → statement lineage.
function StatementDrawer({ row, weekRef, weekLabel, canAdjust, onClose }: {
  row: OverviewRow | null; weekRef: string; weekLabel: string; canAdjust: boolean; onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [adjOpen, setAdjOpen] = useState(false);
  const [adjAmount, setAdjAmount] = useState("");
  const [adjReason, setAdjReason] = useState("");

  const { data: sales = [] } = useQuery<any[]>({
    queryKey: ["/api/commission/reps", row?.repId, "week-sales", weekRef],
    queryFn: () => apiRequest("GET", `/api/commission/reps/${row!.repId}/week-sales?week=${encodeURIComponent(weekRef)}`).then(r => r.json()),
    enabled: !!row,
  });
  const { data: detail } = useQuery<any>({
    queryKey: ["/api/commission/statements", row?.statementId],
    queryFn: () => apiRequest("GET", `/api/commission/statements/${row!.statementId}`).then(r => r.json()),
    enabled: !!row?.statementId,
  });

  const createAdj = useMutation({
    mutationFn: () => apiRequest("POST", "/api/commission/adjustments", {
      statementId: row!.statementId, amountCents: Math.round(parseFloat(adjAmount) * 100), reason: adjReason.trim(), type: "MANUAL",
    }).then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Adjustment filed", description: "Pending until approved — nothing changes silently." });
      setAdjOpen(false); setAdjAmount(""); setAdjReason("");
      qc.invalidateQueries({ queryKey: ["/api/commission/statements", row?.statementId] });
    },
    onError: (e: any) => toast({ title: "Couldn't file adjustment", description: e.message, variant: "destructive" }),
  });
  const decideAdj = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "APPROVE" | "REJECT" }) =>
      apiRequest("POST", `/api/commission/adjustments/${id}/decide`, { decision }).then(r => r.json()),
    onSuccess: (_, vars) => {
      toast({ title: vars.decision === "APPROVE" ? "Adjustment approved — statement re-priced" : "Adjustment rejected" });
      qc.invalidateQueries({ queryKey: ["/api/commission/statements", row?.statementId] });
      qc.invalidateQueries({ queryKey: ["/api/commission/week-overview"] });
    },
    onError: (e: any) => toast({ title: "Decision failed", description: e.message, variant: "destructive" }),
  });

  const [showStmt, setShowStmt] = useState(false);

  if (!row) return null;
  const stmt = detail?.statement;
  const adjustments: any[] = detail?.adjustments ?? [];

  // Build the printable statement for THIS rep's week from the drawer's data.
  const statementModel: StatementModel = {
    repName: row.repName,
    weekLabel,
    status: row.status,
    qualifiedSaleCount: row.qualifiedSaleCount,
    rateCents: row.rateCents,
    grossCents: row.grossCommissionCents,
    adjustmentCents: row.adjustmentCents,
    finalCents: row.finalCommissionCents,
    tierLabel: row.tierLabel,
    planName: stmt?.plan_snapshot?.name ?? null,
    sales: (sales ?? []).map((s: any) => ({ date: s.qualified_at ?? s.sold_at, address: s.address ?? s.external_id, city: s.city, status: s.status })),
    adjustments: (adjustments ?? []).filter((a: any) => a.approved_at || a.status === "APPROVED").map((a: any) => ({ amount_cents: a.amount_cents, reason: a.reason })),
    statementNo: row.statementId ? `HFS-${String(row.statementId).padStart(5, "0")}` : `HFS-${row.repId}-${weekLabel.replace(/[^0-9]/g, "").slice(0, 6)}`,
  };
  const saleStatusStyle: Record<string, string> = {
    QUALIFIED: "text-emerald-400", PENDING: "text-amber-400", REVERSED: "text-red-400 line-through", DISQUALIFIED: "text-red-400", CANCELLED: "text-muted-foreground",
  };

  return (
    <Dialog open={!!row} onOpenChange={v => !v && onClose()}>
      <DialogContent className="bg-card border-border text-foreground max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3 pr-6">
            <DialogTitle className="text-base flex items-center gap-2 min-w-0">
              <FileText className="w-4 h-4 text-primary shrink-0" /> <span className="truncate">{row.repName} — {weekLabel}</span>
            </DialogTitle>
            <button
              type="button"
              onClick={() => setShowStmt(true)}
              data-testid="print-rep-statement"
              className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-secondary border border-border text-xs font-semibold text-foreground active:scale-95 transition-transform shrink-0"
            >
              <Printer className="w-3.5 h-3.5" /> Statement
            </button>
          </div>
        </DialogHeader>

        {showStmt && <CommissionStatement model={statementModel} onClose={() => setShowStmt(false)} />}

        {/* The equation: count × rate = gross, + adjustments = final */}
        <div className="rounded-xl bg-secondary/40 border border-border p-3 text-sm" data-testid="statement-equation">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{row.qualifiedSaleCount} qualified × {usd(row.rateCents)}{row.tierLabel ? ` (${row.tierLabel})` : ""}</span>
            <span className="tabular-nums font-semibold">{usd(row.grossCommissionCents)}</span>
          </div>
          {row.adjustmentCents !== 0 && (
            <div className="flex items-center justify-between mt-1">
              <span className="text-muted-foreground">Approved adjustments</span>
              <span className="tabular-nums">{usdSigned(row.adjustmentCents)}</span>
            </div>
          )}
          <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-border">
            <span className="font-semibold flex items-center gap-1.5">Final <StatusChip status={row.status} /></span>
            <span className="tabular-nums font-bold text-lg">{usd(row.finalCommissionCents)}</span>
          </div>
          {stmt && (
            <div className="mt-2 text-[10px] text-muted-foreground">
              Plan v{stmt.plan_version_number} · basis {String(stmt.qualification_basis).toLowerCase().replace("_at", "")} · calc #{stmt.calculation_version} · {stmt.timezone}
              {stmt.finalized_at && <> · locked {new Date(stmt.finalized_at).toLocaleString()}</>}
            </div>
          )}
        </div>

        {/* The exact doors */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">
            The doors behind this number ({sales.length})
          </div>
          {sales.length === 0 ? (
            <div className="text-sm text-muted-foreground py-3 text-center">No sales recorded this week.</div>
          ) : (
            <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
              {sales.map((s: any) => (
                <div key={s.id} className="px-3 py-2 flex items-center justify-between text-sm bg-card">
                  <div className="min-w-0">
                    <div className={`truncate ${saleStatusStyle[s.status] ?? "text-foreground"}`}>{s.address ?? s.external_id}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {new Date(s.qualified_at ?? s.sold_at).toLocaleString()} {s.city ? `· ${s.city}` : ""}
                    </div>
                  </div>
                  <span className={`text-[10px] font-bold uppercase ${saleStatusStyle[s.status] ?? ""}`}>{s.status.toLowerCase()}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Adjustments */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Adjustments</span>
            {canAdjust && row.statementId && row.status !== "PAID" && (
              <button onClick={() => setAdjOpen(v => !v)} className="text-[11px] text-primary hover:underline flex items-center gap-0.5" data-testid="btn-new-adjustment">
                <Plus className="w-3 h-3" /> New
              </button>
            )}
          </div>
          {adjOpen && (
            <div className="rounded-xl border border-border p-3 mb-2 space-y-2 bg-secondary/30">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-sm">$</span>
                <Input type="number" step="0.01" placeholder="-150.00 for clawback, 50.00 for bonus" value={adjAmount}
                  onChange={e => setAdjAmount(e.target.value)} className="bg-card border-border h-8 text-sm" data-testid="input-adj-amount" />
              </div>
              <div>
                <Label className="text-[10px] text-muted-foreground">Reason (required, audited)</Label>
                <Input value={adjReason} onChange={e => setAdjReason(e.target.value)} placeholder="e.g. Customer cancelled install — clawback per policy"
                  className="bg-card border-border h-8 text-sm mt-1" data-testid="input-adj-reason" />
              </div>
              <Button size="sm" className="h-7 text-xs bg-primary hover:bg-primary/90 text-white w-full"
                disabled={!adjAmount || !adjReason.trim() || createAdj.isPending}
                onClick={() => createAdj.mutate()} data-testid="btn-file-adjustment">
                File pending adjustment
              </Button>
            </div>
          )}
          {adjustments.length === 0 ? (
            <div className="text-xs text-muted-foreground">None.</div>
          ) : (
            <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
              {adjustments.map((a: any) => (
                <div key={a.id} className="px-3 py-2 bg-card text-sm">
                  <div className="flex items-center justify-between">
                    <span className="tabular-nums font-semibold">{usdSigned(a.amount_cents)}</span>
                    <span className={`text-[10px] font-bold uppercase ${a.status === "APPROVED" ? "text-emerald-400" : a.status === "REJECTED" ? "text-red-400" : "text-amber-400"}`}>{a.status.toLowerCase()}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{a.reason}</div>
                  {canAdjust && a.status === "PENDING" && (
                    <div className="flex gap-1.5 mt-1.5">
                      <Button size="sm" variant="outline" className="h-6 text-[10px] border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
                        disabled={decideAdj.isPending} onClick={() => decideAdj.mutate({ id: a.id, decision: "APPROVE" })} data-testid={`btn-approve-adj-${a.id}`}>Approve</Button>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] text-muted-foreground"
                        disabled={decideAdj.isPending} onClick={() => decideAdj.mutate({ id: a.id, decision: "REJECT" })}>Reject</Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" className="border-border" onClick={onClose}><X className="w-3.5 h-3.5 mr-1" /> Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
