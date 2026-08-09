import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useCan } from "@/lib/capabilities";
import { useToast } from "@/hooks/use-toast";
import { usd, usdSigned } from "@/lib/money";
import { estimateStripeConnectCost } from "@shared/payoutCosts";
import {
  Banknote, ChevronLeft, ChevronRight, Lock, CheckCircle2, AlertTriangle,
  Download, Users, Zap, X, FileText, Plus, ShieldCheck, Layers, DollarSign, Printer,
  Send, Loader2, XCircle, Landmark, History, ExternalLink, Info,
} from "lucide-react";
import { CommissionStatement } from "@/components/CommissionStatement";
import { DownlineSheet } from "@/components/DownlineSheet";
import { OverrideConfigCard } from "@/components/OverrideConfigCard";
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
  // Derived server-side from the reports-to tree (never stored) — lets the week
  // be filtered by branch without a second round trip.
  managerId: number | null; managerName: string | null;
  teamLeadId: number | null; teamLeadName: string | null;
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
    <span className={`inline-flex items-center gap-1.5 text-2xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_STYLE[status] || "bg-secondary text-muted-foreground"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[status] || "bg-muted-foreground"}`} />
      {status === "NO_PLAN" ? "no plan" : status.toLowerCase()}
    </span>
  );
}

export default function CommissionConsole() {
  const { toast } = useToast();
  const qc = useQueryClient();
  // Two authority tiers, matching the server gates exactly:
  // read.all (manager+) = see the whole week, export CSV, file PENDING adjustments.
  // payouts.pay (admin) = settle money: finalize, mark paid, approve/reject
  // adjustments, move reserves. The server enforces payouts.pay on
  // /api/commission/week/transition and /adjustments/:id/decide — gating those
  // buttons on read.all rendered them for managers as dead controls that 403'd
  // after a confirm dialog quoting exact dollar totals.
  const canReadAll = useCan("commission.read.all");
  const canPay = useCan("payouts.pay");
  const canManageOrg = useCan("settings.manage.org");    // org settings (house amount)
  const canDownline = useCan("commission.read.downline"); // team_lead+: multi-level override sheet
  const [section, setSection] = useState<"overview" | "pay" | "downline">("overview");
  const [weekOffset, setWeekOffset] = useState(0);       // 0 = current, -1 = last week…
  const [drillRep, setDrillRep] = useState<OverviewRow | null>(null);
  const [confirmAction, setConfirmAction] = useState<"FINALIZE" | "MARK_PAID" | null>(null);
  // Week filters. The DATE dimension is the week nav above — these narrow WHO is
  // shown inside the selected week, which is what a manager closing out a large
  // floor actually needs. Filtering is client-side on purpose: the overview is
  // already one row per rep for the week, so there is nothing to page in.
  const [repQuery, setRepQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [uplineFilter, setUplineFilter] = useState<string>("ALL"); // "mgr:<id>" | "tl:<id>" 

  // Anchor the reference instant ONCE per mount — a fresh Date.now() per render
  // would change the query key every render and refetch forever. The server
  // resolves any instant inside a week to that week's exact bounds.
  const [anchorMs] = useState(() => Date.now());
  const weekRef = new Date(anchorMs + weekOffset * WEEK_MS).toISOString();
  const ovKey = ["/api/commission/week-overview", weekRef];
  const { data: ov, isLoading, isError, refetch: refetchWeek } = useQuery<Overview>({
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
        title: action === "FINALIZE" ? `Week finalized - ${done} statement${done === 1 ? "" : "s"} locked` : `${done} statement${done === 1 ? "" : "s"} marked paid`,
        description: skipped > 0 ? `${skipped} already settled or skipped.` : "Every number on this week is now locked.",
      });
      qc.invalidateQueries({ queryKey: ["/api/commission/week-overview"] });
      // Finalizing/paying settles override rows too — refresh both override surfaces.
      qc.invalidateQueries({ queryKey: ["/api/commission/overrides/sheet"] });
      qc.invalidateQueries({ queryKey: ["/api/commission/overrides/me"] });
      setConfirmAction(null);
    },
    onError: (e: any) => toast({ title: "Closeout failed", description: e.message, variant: "destructive" }),
  });

  // ── Week filters ───────────────────────────────────────────────────────────
  // Applied to the REP TABLE only. Totals, exceptions and the finalize/pay
  // actions deliberately keep reading the UNFILTERED week: a filter is a way to
  // FIND a rep, never a way to change what closing the week will do. Narrowing
  // the payroll figure to whoever is on screen would be the most dangerous
  // possible reading of a filter box.
  const uplineOptions = (() => {
    const managers = new Map<number, string>();
    const leads = new Map<number, string>();
    for (const r of ov?.rows ?? []) {
      if (r.managerId != null && r.managerName) managers.set(r.managerId, r.managerName);
      if (r.teamLeadId != null && r.teamLeadName) leads.set(r.teamLeadId, r.teamLeadName);
    }
    return {
      managers: [...managers].sort((a, b) => a[1].localeCompare(b[1])),
      leads: [...leads].sort((a, b) => a[1].localeCompare(b[1])),
    };
  })();

  const filtersActive = repQuery.trim() !== "" || statusFilter !== "ALL" || uplineFilter !== "ALL";
  const visibleRows = (ov?.rows ?? []).filter(r => {
    const q = repQuery.trim().toLowerCase();
    if (q && !r.repName.toLowerCase().includes(q)) return false;
    if (statusFilter !== "ALL" && r.status !== statusFilter) return false;
    if (uplineFilter !== "ALL") {
      const [kind, rawId] = uplineFilter.split(":");
      const id = Number(rawId);
      if (kind === "mgr" && r.managerId !== id) return false;
      if (kind === "tl" && r.teamLeadId !== id) return false;
    }
    return true;
  });
  const clearFilters = () => { setRepQuery(""); setStatusFilter("ALL"); setUplineFilter("ALL"); };

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
            <Banknote className="w-5 h-5 text-primary" /> Commissions &amp; Pay
          </h1>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mt-1">
            Review earnings · finalize the week · pay reps through Stripe
          </p>
        </div>
        <div className="flex items-center gap-1.5" data-testid="week-nav">
          <Button variant="outline" size="sm" aria-label="Previous week" title="Previous week" className="h-9 w-9 p-0 border-border" onClick={() => setWeekOffset(o => o - 1)} data-testid="week-prev">
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="text-center min-w-[170px]">
            <div className="text-sm font-semibold">{ov?.bounds.localWeekLabel ?? "…"}</div>
            <div className="text-2xs text-muted-foreground">
              {weekOffset === 0
                ? (ov?.weekEnded ? "Week closed - ready to finalize" : "Live · Mon–Sun · updates as doors close")
                : weekOffset > 0 ? "Future week" : "Past week"}
            </div>
          </div>
          <Button variant="outline" size="sm" aria-label="Next week" title="Next week" className="h-9 w-9 p-0 border-border" disabled={weekOffset >= 0}
            onClick={() => setWeekOffset(o => o + 1)} data-testid="week-next">
            <ChevronRight className="w-4 h-4" />
          </Button>
          {weekOffset !== 0 && (
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setWeekOffset(0)}>Today</Button>
          )}
        </div>
      </div>

      <div className="inline-flex w-full sm:w-auto rounded-xl border border-border bg-card p-1" role="tablist" aria-label="Commission workspace">
        <button
          type="button"
          role="tab"
          aria-selected={section === "overview"}
          onClick={() => setSection("overview")}
          className={`h-9 flex-1 sm:flex-none px-4 rounded-lg text-xs font-semibold transition-colors ${section === "overview" ? "bg-secondary text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          data-testid="commission-tab-overview"
        >
          Overview
        </button>
        {/* "Pay reps" is finalize/export/adjust — only roles with
            commission.read.all can act there. Hiding it for team leads (who get
            a read-only Overview) avoids a tab that opens a blank panel. */}
        {canReadAll && (
          <button
            type="button"
            role="tab"
            aria-selected={section === "pay"}
            onClick={() => setSection("pay")}
            className={`h-9 flex-1 sm:flex-none px-4 rounded-lg text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 ${section === "pay" ? "bg-secondary text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            data-testid="commission-tab-pay"
          >
            <Landmark className="w-3.5 h-3.5" /> Pay reps
          </button>
        )}
        {/* Downline overrides — multi-level pay visibility. Omitted (never
            disabled) below team lead, per the capability house rule. */}
        {canDownline && (
          <button
            type="button"
            role="tab"
            aria-selected={section === "downline"}
            onClick={() => setSection("downline")}
            className={`h-9 flex-1 sm:flex-none px-4 rounded-lg text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 ${section === "downline" ? "bg-secondary text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            data-testid="commission-tab-downline"
          >
            <Users className="w-3.5 h-3.5" /> Downline
          </button>
        )}
      </div>

      {isError && (
        <div className="rounded-xl bg-card border border-rose-500/30 p-6 text-center" role="alert">
          <div className="text-sm font-semibold text-foreground">Couldn't load the week</div>
          <div className="text-sm text-muted-foreground mt-1">Check your connection - nothing about the week's money has changed.</div>
          <Button variant="outline" size="sm" className="mt-3 h-9 border-border" onClick={() => refetchWeek()} data-testid="week-retry">
            Retry
          </Button>
        </div>
      )}
      {/* The week skeleton belongs to Overview only — Pay/Downline render their
          own data and shouldn't grow an unrelated pulsing block. */}
      {isLoading && section === "overview" && <div className="h-48 rounded-2xl bg-card border border-border animate-pulse" />}

      {ov && section === "overview" && (
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
                    <span className="text-2xs font-bold uppercase tracking-wide text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5 mt-0.5 whitespace-nowrap">
                      {ex.type.replace(/_/g, " ").toLowerCase()}
                    </span>
                    <span className="text-muted-foreground">
                      <button className="text-foreground font-medium hover:text-primary" onClick={() => { const r = ov.rows.find(x => x.repId === ex.repId); if (r) setDrillRep(r); }}>{ex.repName}</button>
                      {" - "}{ex.detail}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-card border border-border px-4 py-2.5 flex items-center gap-2 text-sm text-muted-foreground" data-testid="exceptions-clear">
              <ShieldCheck className="w-4 h-4 text-emerald-400" /> Nothing needs review - every number is explainable.
            </div>
          )}

          {/* Rep table */}
          <div className="rounded-2xl bg-card border border-border overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-2 flex-wrap">
              <Users className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-semibold">Reps this week</span>
              <span className="ml-auto text-xs text-muted-foreground">tap a row to explain every dollar</span>
            </div>

            {/* Filters — narrow WHO is listed inside the selected week. The week
                itself is the date control above. Totals and the closeout actions
                intentionally ignore these: a filter finds a rep, it never
                changes what finalizing the week will do. */}
            <div className="px-4 py-2.5 border-b border-border flex items-center gap-2 flex-wrap" data-testid="week-filters">
              <input
                type="search"
                value={repQuery}
                onChange={e => setRepQuery(e.target.value)}
                placeholder="Find a rep…"
                aria-label="Filter by rep name"
                data-testid="filter-rep"
                className="h-8 min-w-[150px] flex-1 sm:flex-none rounded-lg border border-border bg-background px-2.5 text-xs outline-none focus:ring-1 focus:ring-primary"
              />
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                aria-label="Filter by statement status"
                data-testid="filter-status"
                className="h-8 rounded-lg border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="ALL">All statuses</option>
                <option value="OPEN">Open</option>
                <option value="REVIEW">In review</option>
                <option value="FINALIZED">Finalized</option>
                <option value="PAID">Paid</option>
                <option value="NO_PLAN">No plan</option>
              </select>
              {(uplineOptions.managers.length > 0 || uplineOptions.leads.length > 0) && (
                <select
                  value={uplineFilter}
                  onChange={e => setUplineFilter(e.target.value)}
                  aria-label="Filter by manager or team lead"
                  data-testid="filter-upline"
                  className="h-8 rounded-lg border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="ALL">All branches</option>
                  {uplineOptions.managers.length > 0 && (
                    <optgroup label="Manager">
                      {uplineOptions.managers.map(([id, name]) => <option key={`mgr-${id}`} value={`mgr:${id}`}>{name}</option>)}
                    </optgroup>
                  )}
                  {uplineOptions.leads.length > 0 && (
                    <optgroup label="Team lead">
                      {uplineOptions.leads.map(([id, name]) => <option key={`tl-${id}`} value={`tl:${id}`}>{name}</option>)}
                    </optgroup>
                  )}
                </select>
              )}
              {filtersActive && (
                <>
                  <span className="text-2xs text-muted-foreground" data-testid="filter-count">
                    {visibleRows.length} of {ov.rows.length}
                  </span>
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={clearFilters} data-testid="filter-clear">Clear</Button>
                </>
              )}
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
              {/* Filters that match nobody must SAY so. Rendering an empty table
                  would read as "this week has no reps", which is a different and
                  much more alarming statement than "your filter is too narrow". */}
              {visibleRows.length === 0 && (
                <div className="px-4 py-10 text-center" data-testid="filter-no-matches">
                  <p className="text-sm font-semibold text-foreground">No reps match these filters</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {ov.rows.length} rep{ov.rows.length === 1 ? " is" : "s are"} producing this week.
                  </p>
                  <Button variant="outline" size="sm" className="mt-3 h-8 text-xs" onClick={clearFilters}>Clear filters</Button>
                </div>
              )}
              {/* Mobile: card list — Rep + Commission + Status never scroll off. */}
              <div className="sm:hidden divide-y divide-border">
                {visibleRows.map(r => (
                  <button key={r.repId} onClick={() => setDrillRep(r)} data-testid={`card-rep-${r.repId}`}
                    className="render-lazy w-full text-left px-4 py-3 active:bg-secondary/50 transition-colors">
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
                        <span className="text-2xs font-bold uppercase text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5">plan not accepted</span>
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
                    {visibleRows.map(r => (
                      <tr key={r.repId} className="hover:bg-secondary/40 cursor-pointer transition-colors focus:outline-none focus:bg-secondary/60 focus-visible:ring-1 focus-visible:ring-primary"
                        role="button" tabIndex={0} aria-label={`Explain ${r.repName}'s ${usd(r.finalCommissionCents)}`}
                        onClick={() => setDrillRep(r)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDrillRep(r); } }}
                        data-testid={`row-rep-${r.repId}`}>
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-foreground flex items-center gap-1.5">
                            {r.repName}
                            {r.structure && !r.planAccepted && (
                              <span className="text-2xs font-bold uppercase text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-1 py-0.5">plan not accepted</span>
                            )}
                          </div>
                          <div className="text-2xs text-muted-foreground flex items-center gap-1">
                            {r.structure === "FLAT" ? <DollarSign className="w-2.5 h-2.5" /> : r.structure === "TIERED" ? <Layers className="w-2.5 h-2.5" /> : null}
                            {r.structure === "FLAT" ? "Flat" : r.structure === "TIERED" ? "Tiered" : "No plan"}
                          </div>
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums">
                          <span className="font-semibold text-foreground">{r.qualifiedSaleCount}</span>
                          {(r.pendingSaleCount > 0 || r.reversedSaleCount > 0) && (
                            <div className="text-2xs text-muted-foreground">
                              {r.pendingSaleCount > 0 && `${r.pendingSaleCount} pending`}
                              {r.pendingSaleCount > 0 && r.reversedSaleCount > 0 && " · "}
                              {r.reversedSaleCount > 0 && `${r.reversedSaleCount} reversed`}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-muted-foreground">
                          {r.rateCents > 0 ? <>{r.tierLabel ?? "Flat"} <span className="text-foreground/80 tabular-nums">{usd(r.rateCents)}</span></> : " - "}
                        </td>
                        <td className="px-2 py-2.5">
                          {r.status === "OPEN" && r.salesUntilNextTier != null && r.marginalJumpCents != null && r.marginalJumpCents > 0 ? (
                            <span className={`text-xs ${r.salesUntilNextTier <= 2 ? "text-amber-400 font-semibold" : "text-muted-foreground"}`}>
                              {r.salesUntilNextTier} to go → <span className="tabular-nums">+{usd(r.marginalJumpCents)}</span>
                            </span>
                          ) : <span className="text-xs text-muted-foreground">-</span>}
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">
                          {r.adjustmentCents !== 0 ? usdSigned(r.adjustmentCents) : " - "}
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
          {canReadAll && (
            <div className="rounded-2xl bg-card border border-border p-3 flex items-center gap-2 flex-wrap" data-testid="closeout-bar">
              <div className="text-xs text-muted-foreground mr-auto">
                {openCount > 0
                  ? <>Sunday closeout: <strong className="text-foreground">{openCount} open</strong> statement{openCount === 1 ? "" : "s"} will be recalculated, then locked.</>
                  : finalizedCount > 0 ? "Week is finalized - export payroll, then mark paid." : "Week is settled."}
              </div>
              <a href={`/api/commission/week-export.csv?week=${encodeURIComponent(weekRef)}`}
                onClick={e => { e.preventDefault(); downloadCsv(weekRef); }}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                data-testid="export-csv">
                <Download className="w-3.5 h-3.5" /> Export CSV
              </a>
              {/* Settling the week requires payouts.pay (the server refuses
                  anything less), so a manager gets an honest review-only note
                  instead of buttons that 403 after a confirm dialog. */}
              {canPay ? (
                <>
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
                </>
              ) : (
                <span className="text-2xs text-muted-foreground" data-testid="closeout-review-only">
                  Review only - an admin finalizes and marks the week paid.
                </span>
              )}
            </div>
          )}

        </>
      )}

      {section === "pay" && canReadAll && (
        <>
          {canManageOrg && <HouseAmountCard />}
          {canManageOrg && <OverrideConfigCard />}
          <PayWorkspace key={weekRef} weekRef={weekRef} canPay={canPay} />
        </>
      )}

      {section === "downline" && canDownline && (
        <DownlineSheet key={weekRef} weekRef={weekRef} weekLabel={ov?.bounds.localWeekLabel ?? ""} />
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
              <p><strong className="text-foreground">{openCount}</strong> open statement{openCount === 1 ? "" : "s"} ({usd(ov?.totals.projectedPayrollCents ?? 0)}) will be recalculated one final time and locked. Locked numbers never change silently - later corrections happen as audited adjustments.</p>
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
      <StatementDrawer row={drillRep} weekRef={weekRef} weekLabel={ov?.bounds.localWeekLabel ?? ""} canAdjust={canReadAll} canDecideAdj={canPay} canMoveReserve={canPay} onClose={() => { setDrillRep(null); qc.invalidateQueries({ queryKey: ["/api/commission/week-overview"] }); qc.invalidateQueries({ queryKey: ["/api/commission/overrides/sheet"] }); qc.invalidateQueries({ queryKey: ["/api/commission/overrides/me"] }); }} />
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

// ── Chargeback reserve — the admin's MANUAL controls ─────────────────────────
// Both movements are manual by product decision: the reserve never auto-draws
// when a sale reverses, and nothing auto-releases on a timer or on departure.
// The panel READS on commission.read.all (manager oversight may look) but the
// two buttons require payouts.pay — moving reserve money is the org owner's
// call, exactly like marking a week paid. Nothing here edits history: every
// action appends an entry to an append-only ledger.
interface ReserveSummary {
  repId: number; reservePercent: number; reserveCapCents: number | null;
  balanceCents: number; capRemainingCents: number | null; capProgressPercent: number | null;
  atCap: boolean; heldToDateCents: number; drawnDownToDateCents: number; releasedToDateCents: number;
  entries: Array<{ id: number; kind: "hold" | "drawdown" | "release"; amountCents: number; weekLabel: string | null; reason: string; createdAt: string }>;
}

const RESERVE_ENTRY_LABEL: Record<string, string> = {
  hold: "Held", drawdown: "Chargeback applied", release: "Released to rep",
};

function ReservePanel({ repId, repName, canMove }: { repId: number; repName: string; canMove: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"drawdown" | "release" | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const key = ["/api/commission/reps", repId, "reserve"];
  const { data } = useQuery<ReserveSummary>({
    queryKey: key,
    queryFn: () => apiRequest("GET", `/api/commission/reps/${repId}/reserve`).then(r => r.json()),
  });

  const move = useMutation({
    mutationFn: () => {
      // A blank amount on a RELEASE means "the whole balance" — the SERVER
      // resolves it, so the client never races the true balance. Dollars are
      // converted to integer cents exactly once, here.
      const body: any = { reason: reason.trim() };
      if (amount.trim() !== "") body.amountCents = Math.round(parseFloat(amount) * 100);
      return apiRequest("POST", `/api/commission/reps/${repId}/reserve/${mode}`, body).then(r => r.json());
    },
    onSuccess: () => {
      toast({
        title: mode === "drawdown" ? "Chargeback applied to the reserve" : "Reserve released",
        description: `${repName}'s reserve ledger has a new entry. Nothing was rewritten - the history is intact.`,
      });
      setMode(null); setAmount(""); setReason("");
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e: any) => toast({ title: "Reserve action failed", description: e.message, variant: "destructive" }),
  });

  if (!data || (data.reservePercent <= 0 && data.balanceCents === 0)) return null;
  const amountCents = amount.trim() === "" ? null : Math.round(parseFloat(amount) * 100);
  const blocked =
    !reason.trim() ? "A reason is required - every reserve movement is audited"
    : mode === "drawdown" && (amountCents == null || !(amountCents > 0)) ? "Enter an amount above $0"
    : amountCents != null && amountCents > data.balanceCents ? `More than the ${usd(data.balanceCents)} balance - the reserve can never go negative`
    : mode === "release" && amountCents == null && data.balanceCents <= 0 ? "There is no balance to release"
    : null;

  return (
    <div data-testid="admin-reserve-panel">
      <div className="text-2xs uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">
        Chargeback reserve
      </div>
      <div className="rounded-2xl border border-border bg-secondary/30 p-3">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-muted-foreground">Balance</span>
          <span className="tabular-nums text-lg font-bold text-foreground" data-testid="admin-reserve-balance">{usd(data.balanceCents)}</span>
        </div>
        <div className="mt-1 text-2xs text-muted-foreground tabular-nums">
          {data.reservePercent}% held weekly
          {data.reserveCapCents != null && <> · max {usd(data.reserveCapCents)}{data.atCap ? " · at the cap, nothing more is held" : ` · ${usd(data.capRemainingCents ?? 0)} to go`}</>}
          {" · "}held {usd(data.heldToDateCents)} · charged back {usd(data.drawnDownToDateCents)} · released {usd(data.releasedToDateCents)}
        </div>

        {canMove && (
          <div className="mt-2.5 flex gap-1.5">
            <Button size="sm" variant="outline" className="h-7 text-2xs border-border"
              onClick={() => { setMode(m => (m === "drawdown" ? null : "drawdown")); setAmount(""); }}
              data-testid="btn-reserve-drawdown">Apply chargeback</Button>
            <Button size="sm" variant="outline" className="h-7 text-2xs border-border"
              onClick={() => { setMode(m => (m === "release" ? null : "release")); setAmount(""); }}
              data-testid="btn-reserve-release">Release</Button>
          </div>
        )}

        {canMove && mode && (
          <div className="mt-2 space-y-2 rounded-xl border border-border bg-card p-2.5">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">$</span>
              <Input type="number" step="0.01" min={0} value={amount} onChange={e => setAmount(e.target.value)}
                placeholder={mode === "release" ? `blank = full balance (${usd(data.balanceCents)})` : "e.g. 150.00"}
                className="bg-secondary border-border h-8 text-sm tabular-nums" data-testid="input-reserve-amount" />
            </div>
            <div>
              <Label className="text-2xs text-muted-foreground">Reason (required, audited)</Label>
              <Input value={reason} onChange={e => setReason(e.target.value)}
                placeholder={mode === "drawdown" ? "e.g. 12 Oak St cancelled in month 2 - carrier chargeback" : "e.g. Contract ended - releasing the remaining balance"}
                className="bg-secondary border-border h-8 text-sm mt-1" data-testid="input-reserve-reason" />
            </div>
            <Button size="sm" className="h-7 text-xs w-full bg-primary hover:bg-primary/90 text-primary-foreground"
              disabled={!!blocked || move.isPending} onClick={() => move.mutate()} data-testid="btn-reserve-submit">
              {move.isPending ? "Working…" : mode === "drawdown" ? "Apply chargeback to reserve" : "Release to rep"}
            </Button>
            {blocked && <p className="text-[11px] text-amber-400 [.light_&]:text-amber-700" data-testid="reserve-blocked-reason">{blocked}</p>}
          </div>
        )}

        {data.entries.length > 0 && (
          <div className="mt-2.5 divide-y divide-border rounded-xl border border-border overflow-hidden">
            {data.entries.slice(0, 6).map(e => (
              <div key={e.id} className="px-2.5 py-1.5 bg-card flex items-start justify-between gap-3 text-xs" data-testid={`admin-reserve-entry-${e.id}`}>
                <span className="min-w-0">
                  <span className="block font-medium text-foreground">{RESERVE_ENTRY_LABEL[e.kind] ?? e.kind}</span>
                  <span className="block text-[11px] text-muted-foreground truncate">{e.weekLabel ? `${e.weekLabel} · ` : ""}{e.reason}</span>
                </span>
                <span className="shrink-0 tabular-nums font-semibold text-foreground">{usdSigned(e.amountCents)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Drill-down: explain every dollar ──────────────────────────────────────────
// Final total → tier math → the exact doors → adjustments → statement lineage.
function StatementDrawer({ row, weekRef, weekLabel, canAdjust, canDecideAdj, canMoveReserve, onClose }: {
  row: OverviewRow | null; weekRef: string; weekLabel: string; canAdjust: boolean; canDecideAdj: boolean; canMoveReserve: boolean; onClose: () => void;
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
      toast({ title: "Adjustment filed", description: "Pending until approved - nothing changes silently." });
      setAdjOpen(false); setAdjAmount(""); setAdjReason("");
      qc.invalidateQueries({ queryKey: ["/api/commission/statements", row?.statementId] });
    },
    onError: (e: any) => toast({ title: "Couldn't file adjustment", description: e.message, variant: "destructive" }),
  });
  const decideAdj = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: "APPROVE" | "REJECT" }) =>
      apiRequest("POST", `/api/commission/adjustments/${id}/decide`, { decision }).then(r => r.json()),
    onSuccess: (_, vars) => {
      toast({ title: vars.decision === "APPROVE" ? "Adjustment approved - statement re-priced" : "Adjustment rejected" });
      qc.invalidateQueries({ queryKey: ["/api/commission/statements", row?.statementId] });
      qc.invalidateQueries({ queryKey: ["/api/commission/week-overview"] });
      // An adjustment can resolve an override exception — refresh both surfaces.
      qc.invalidateQueries({ queryKey: ["/api/commission/overrides/sheet"] });
      qc.invalidateQueries({ queryKey: ["/api/commission/overrides/me"] });
    },
    onError: (e: any) => toast({ title: "Decision failed", description: e.message, variant: "destructive" }),
  });

  const [showStmt, setShowStmt] = useState(false);

  if (!row) return null;
  const stmt = detail?.statement;
  const adjustments: any[] = detail?.adjustments ?? [];

  const saleStatusStyle: Record<string, string> = {
    QUALIFIED: "text-emerald-400", PENDING: "text-amber-400", REVERSED: "text-red-400 line-through", DISQUALIFIED: "text-red-400", CANCELLED: "text-muted-foreground",
  };

  return (
    <Dialog open={!!row} onOpenChange={v => !v && onClose()}>
      <DialogContent className="bg-card border-border text-foreground max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3 pr-6">
            <DialogTitle className="text-base flex items-center gap-2 min-w-0">
              <FileText className="w-4 h-4 text-primary shrink-0" /> <span className="truncate">{row.repName} - {weekLabel}</span>
            </DialogTitle>
            <button
              type="button"
              onClick={() => setShowStmt(true)}
              disabled={row.statementId == null}
              data-testid="print-rep-statement"
              className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-secondary border border-border text-xs font-semibold text-foreground active:scale-95 transition-transform shrink-0 disabled:opacity-50"
            >
              <Printer className="w-3.5 h-3.5" /> Statement
            </button>
          </div>
        </DialogHeader>

        {/* The statement pulls its own server-assembled document by ID, so a
            manager printing a rep's week sees exactly what the rep sees. A row
            with no statement yet (NO_PLAN) has nothing to print. */}
        {showStmt && row.statementId != null && (
          <CommissionStatement statementId={row.statementId} onClose={() => setShowStmt(false)} />
        )}

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
            <div className="mt-2 text-2xs text-muted-foreground">
              Plan v{stmt.plan_version_number} · basis {String(stmt.qualification_basis).toLowerCase().replace("_at", "")} · calc #{stmt.calculation_version} · {stmt.timezone}
              {stmt.finalized_at && <> · locked {new Date(stmt.finalized_at).toLocaleString()}</>}
            </div>
          )}
        </div>

        {/* The exact doors */}
        <div>
          <div className="text-2xs uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">
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
                    <div className="text-2xs text-muted-foreground">
                      {new Date(s.qualified_at ?? s.sold_at).toLocaleString()} {s.city ? `· ${s.city}` : ""}
                    </div>
                  </div>
                  <span className={`text-2xs font-bold uppercase ${saleStatusStyle[s.status] ?? ""}`}>{s.status.toLowerCase()}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Adjustments */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-2xs uppercase tracking-wider text-muted-foreground font-semibold">Adjustments</span>
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
                <Label className="text-2xs text-muted-foreground">Reason (required, audited)</Label>
                <Input value={adjReason} onChange={e => setAdjReason(e.target.value)} placeholder="e.g. Customer cancelled install - clawback per policy"
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
                    <span className={`text-2xs font-bold uppercase ${a.status === "APPROVED" ? "text-emerald-400" : a.status === "REJECTED" ? "text-red-400" : "text-amber-400"}`}>{a.status.toLowerCase()}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{a.reason}</div>
                  {/* Deciding an adjustment moves money — payouts.pay only, same
                      as the server gate. Managers (read.all) file; admins decide. */}
                  {canDecideAdj && a.status === "PENDING" && (
                    <div className="flex gap-1.5 mt-1.5">
                      <Button size="sm" variant="outline" className="h-6 text-2xs border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
                        disabled={decideAdj.isPending} onClick={() => decideAdj.mutate({ id: a.id, decision: "APPROVE" })} data-testid={`btn-approve-adj-${a.id}`}>Approve</Button>
                      <Button size="sm" variant="ghost" className="h-6 text-2xs text-muted-foreground"
                        disabled={decideAdj.isPending} onClick={() => decideAdj.mutate({ id: a.id, decision: "REJECT" })}>Reject</Button>
                    </div>
                  )}
                  {!canDecideAdj && canAdjust && a.status === "PENDING" && (
                    <div className="text-[11px] text-muted-foreground mt-1.5">Awaiting an admin's decision.</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Chargeback reserve - balance, cap, and the manual admin movements. */}
        <ReservePanel repId={row.repId} repName={row.repName} canMove={canMoveReserve} />

        <DialogFooter>
          <Button variant="outline" className="border-border" onClick={onClose}><X className="w-3.5 h-3.5 mr-1" /> Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Pay reps - Stripe Connect payout with review-then-confirm ──────────────────
// After a week is finalized, the owner sends each rep their commission to a
// connected Stripe account. Because this moves REAL money, the flow is a
// deliberate two-step: review the batch + per-rep eligibility here, then
// re-confirm the exact total and rep count in a dialog before a single dollar
// posts. Grounded in Gusto "Review and submit", Deel "Approve payroll?" and
// Fresha "Review pay run" payroll-run confirmations; status pills follow
// Stripe/Whop payment-status color coding.
interface PayoutRow {
  repId: number; repName: string; statementId: number | null;
  status: "OPEN" | "REVIEW" | "FINALIZED" | "PAID" | "NO_PLAN";
  finalCommissionCents: number;
  onboardingStatus: "none" | "pending" | "restricted" | "enabled";
  payoutStatus: "pending" | "processing" | "paid" | "failed" | "reversed" | null;
  eligible: boolean; blockReason: string | null; blockLabel: string | null;
}
interface PayoutWeek {
  stripeEnabled: boolean; week: string; rows: PayoutRow[];
  payableCount: number; payableCents: number;
}
interface PayResult {
  repId: number; paid?: true; skipped?: true; failed?: true;
  reason?: string; amountCents?: number; transferId?: string;
}

interface StripeBalance {
  configured: boolean;
  availableCents: number;
  pendingCents: number;
  currency: "usd";
}

interface PayoutHistoryRow {
  id: number;
  repId: number;
  repName: string;
  statementId: number | null;
  amountCents: number;
  status: "pending" | "processing" | "paid" | "failed" | "reversed";
  failureReason: string | null;
  createdAt: string;
  paidAt: string | null;
}

function PayWorkspace({ weekRef, canPay }: { weekRef: string; canPay: boolean }) {
  const balance = useQuery<StripeBalance>({
    queryKey: ["/api/payouts/balance"],
    queryFn: () => apiRequest("GET", "/api/payouts/balance").then(r => r.json()),
    staleTime: 30_000,
    retry: 1,
  });

  return (
    <div className="space-y-5" role="tabpanel" aria-label="Pay reps">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl bg-card border border-border p-4">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
            <Landmark className="w-3.5 h-3.5" /> Stripe platform balance
          </div>
          {balance.isLoading ? (
            <div className="h-9 w-32 mt-2 rounded-lg bg-secondary animate-pulse" />
          ) : balance.isError ? (
            // A fetch failure is not a configuration fact - say so, and offer
            // the retry. (This card used to render "not configured" on a blip.)
            <div className="mt-2 text-sm">
              <span className="font-semibold text-amber-400">Couldn't load the balance.</span>{" "}
              <button type="button" className="text-primary hover:underline font-semibold" onClick={() => balance.refetch()} data-testid="balance-retry">Retry</button>
            </div>
          ) : balance.data?.configured ? (
            <>
              <div className="mt-1.5 text-2xl font-semibold tabular-nums text-foreground">{usd(balance.data.availableCents)}</div>
              <div className="text-[11px] text-muted-foreground mt-1">{usd(balance.data.pendingCents)} pending</div>
            </>
          ) : (
            <div className="mt-2 text-sm font-semibold text-amber-400">Stripe Connect not configured</div>
          )}
        </div>
        <div className="rounded-2xl bg-card border border-border p-4">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
            <ShieldCheck className="w-3.5 h-3.5" /> Payment authority
          </div>
          <div className="mt-1.5 text-sm font-semibold text-foreground">{canPay ? "Admin approval enabled" : "Review-only access"}</div>
          <p className="text-[11px] text-muted-foreground mt-1">
            {canPay ? "You can review and submit real payouts." : "You can prepare and review the batch. An admin must submit it."}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-sky-500/25 bg-sky-500/[0.06] px-4 py-3 flex items-start gap-2.5 text-xs text-muted-foreground">
        <Info className="w-4 h-4 text-sky-400 mt-px flex-shrink-0" />
        <div>
          <strong className="text-foreground">Fund Stripe before submitting.</strong> Connect transfers use the available Stripe platform balance, not a same-day pull from your bank.
          {canPay && (
            <> <a href="https://dashboard.stripe.com/balance" target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">Open Stripe balance <ExternalLink className="w-3 h-3" /></a></>
          )}
        </div>
      </div>

      <PayRepsPanel
        weekRef={weekRef}
        canPay={canPay}
        availableCents={balance.data?.configured ? balance.data.availableCents : null}
        balanceUnknown={balance.isError}
      />
      <PayoutHistory />
    </div>
  );
}

function PayoutHistory() {
  const { data, isLoading, isError } = useQuery<{ payouts: PayoutHistoryRow[] }>({
    queryKey: ["/api/payouts"],
    queryFn: () => apiRequest("GET", "/api/payouts").then(r => r.json()),
  });
  const rows = data?.payouts ?? [];
  return (
    <section className="rounded-2xl bg-card border border-border overflow-hidden" data-testid="payout-history">
      <header className="px-4 py-3 border-b border-border flex items-center gap-2">
        <History className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-semibold text-foreground">Payout history</span>
        <span className="ml-auto text-[11px] text-muted-foreground">Audited Stripe transfers</span>
      </header>
      {isLoading ? (
        <div className="p-4"><div className="h-14 rounded-xl bg-secondary/40 animate-pulse" /></div>
      ) : isError ? (
        <div className="p-5 text-sm text-muted-foreground">Payout history is temporarily unavailable.</div>
      ) : rows.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">No Stripe payouts have been sent yet.</div>
      ) : (
        <div className="divide-y divide-border">
          {rows.slice(0, 25).map(row => (
            <div key={row.id} className="px-4 py-3 flex items-center gap-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${row.status === "paid" ? "bg-emerald-500/10" : row.status === "failed" ? "bg-red-500/10" : "bg-amber-500/10"}`}>
                {row.status === "paid" ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : row.status === "failed" ? <XCircle className="w-4 h-4 text-red-400" /> : <Loader2 className={`w-4 h-4 text-amber-400 ${row.status === "processing" ? "animate-spin" : ""}`} />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground truncate">{row.repName}</div>
                <div className="text-[11px] text-muted-foreground">
                  {new Date(row.paidAt ?? row.createdAt).toLocaleString()} · statement #{row.statementId ?? " - "}
                </div>
                {row.failureReason && <div className="text-[11px] text-red-400 mt-0.5 truncate">{row.failureReason}</div>}
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-sm font-semibold tabular-nums text-foreground">{usd(row.amountCents)}</div>
                <div className={`text-2xs font-semibold uppercase ${row.status === "paid" ? "text-emerald-400" : row.status === "failed" ? "text-red-400" : "text-amber-400"}`}>{row.status}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// Eligibility/status cell — one glance says pay / paid / blocked, using the same
// semantic tints as the rest of the console (emerald=go/paid, red=failed,
// amber=blocked, sky=in-flight). blockLabel is the terse reason ("Rep hasn't
// connected a payout account", "Already paid").
function PayStatusCell({ r }: { r: PayoutRow }) {
  const base = "inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap";
  if (r.payoutStatus === "paid")
    return <span className={`${base} bg-emerald-500/15 text-emerald-400`}><CheckCircle2 className="w-3 h-3" /> Paid</span>;
  if (r.payoutStatus === "processing")
    return <span className={`${base} bg-sky-500/15 text-sky-400`}><Loader2 className="w-3 h-3 animate-spin" /> Processing</span>;
  if (r.payoutStatus === "failed")
    return <span className={`${base} bg-red-500/15 text-red-400`}><XCircle className="w-3 h-3" /> Failed</span>;
  if (r.payoutStatus === "reversed")
    return <span className={`${base} bg-amber-500/15 text-amber-400`}><AlertTriangle className="w-3 h-3" /> Reversed</span>;
  if (r.eligible)
    return <span className={`${base} bg-emerald-500/10 text-emerald-400`}><CheckCircle2 className="w-3 h-3" /> Ready</span>;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-amber-400" title={r.blockReason ?? undefined}>
      <AlertTriangle className="w-3 h-3 flex-shrink-0" /> {r.blockLabel ?? "Not eligible"}
    </span>
  );
}

// Keyed by weekRef in the parent, so switching weeks resets confirm + results.
function PayRepsPanel({ weekRef, canPay, availableCents, balanceUnknown = false }: { weekRef: string; canPay: boolean; availableCents: number | null; balanceUnknown?: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [results, setResults] = useState<PayResult[] | null>(null);

  // Reuse the console's exact week reference — same instant the commission
  // overview/statement/sales queries use — so this panel always describes the
  // same week the rest of the screen is showing.
  const { data, isLoading } = useQuery<PayoutWeek>({
    queryKey: ["/api/payouts/week", weekRef],
    queryFn: () => apiRequest("GET", `/api/payouts/week?week=${encodeURIComponent(weekRef)}`).then(r => r.json()),
  });

  const pay = useMutation({
    mutationFn: () => apiRequest("POST", "/api/payouts/week/pay", { week: weekRef }).then(r => r.json()),
    onSuccess: (res: { week: string; results: PayResult[]; paidCount: number }) => {
      const list = res.results ?? [];
      setResults(list);
      setConfirmOpen(false);
      const paid = res.paidCount ?? list.filter(x => x.paid).length;
      const failed = list.filter(x => x.failed).length;
      toast({
        title: paid > 0 ? `Paid ${paid} rep${paid === 1 ? "" : "s"}` : "No payouts sent",
        description: failed > 0 ? `${failed} payout${failed === 1 ? "" : "s"} failed - see results below.` : "Paid statements flip to PAID as transfers settle.",
        variant: failed > 0 ? "destructive" : undefined,
      });
      // Refresh both this panel AND the commission overview so paid statements flip to PAID.
      qc.invalidateQueries({ queryKey: ["/api/payouts/week"] });
      qc.invalidateQueries({ queryKey: ["/api/commission/week-overview"] });
      qc.invalidateQueries({ queryKey: ["/api/commission/overrides/sheet"] });
      qc.invalidateQueries({ queryKey: ["/api/commission/overrides/me"] });
    },
    // 503 (payouts disabled) or any transfer error lands here — never leaves the
    // dialog open pretending money moved.
    onError: (e: any) => {
      setConfirmOpen(false);
      toast({ title: "Payouts unavailable", description: e.message, variant: "destructive" });
    },
  });

  const stripeEnabled = data?.stripeEnabled ?? false;
  const rows = data?.rows ?? [];
  const payableCount = data?.payableCount ?? 0;
  const payableCents = data?.payableCents ?? 0;
  const estimatedCost = estimateStripeConnectCost(payableCents, payableCount);
  // Fail CLOSED on the balance guard: while the balance is unknown because its
  // fetch errored, submitting real transfers stays blocked — an unknown balance
  // must never behave like a sufficient one. (A still-loading balance keeps the
  // button armed as before; the panel's own fetch gates the real submit.)
  const insufficientBalance = (availableCents != null && payableCents > availableCents) || balanceUnknown;
  const nameFor = (id: number) => rows.find(r => r.repId === id)?.repName ?? `Rep #${id}`;

  return (
    <div className="rounded-2xl bg-card border border-border overflow-hidden" data-testid="pay-reps-panel">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Banknote className="w-4 h-4 text-primary" />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-primary font-semibold">Pay reps</div>
          <div className="text-sm font-semibold text-foreground">Send commission via Stripe Connect</div>
        </div>
        {stripeEnabled && payableCount > 0 && (
          <span className="ml-auto text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 rounded-full px-2 py-0.5 whitespace-nowrap">
            {payableCount} ready
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="p-4"><div className="h-16 rounded-xl bg-secondary/40 animate-pulse" /></div>
      ) : !stripeEnabled ? (
        /* Disabled / informational — NO pay path exists in this branch. */
        <div className="p-5 flex items-start gap-3" data-testid="pay-reps-disabled">
          <div className="w-9 h-9 rounded-xl bg-secondary border border-border flex items-center justify-center flex-shrink-0">
            <Lock className="w-4 h-4 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">Rep payouts aren't enabled yet</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-md">
              Connect Stripe payouts to send commission straight to your reps' bank accounts from this console. Until then, export the CSV and pay through your existing process.
            </p>
          </div>
        </div>
      ) : (
        <>
          {rows.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground" data-testid="pay-reps-empty">
              No rep statements to pay this week yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[460px]">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border bg-secondary/30">
                    <th scope="col" className="text-left font-semibold px-4 py-2.5">Rep</th>
                    <th scope="col" className="text-right font-semibold px-2 py-2.5">Amount</th>
                    <th scope="col" className="text-right font-semibold px-4 py-2.5">Payout</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map(r => (
                    <tr key={r.repId} data-testid={`payout-row-${r.repId}`}
                      className={r.eligible || r.payoutStatus === "paid" ? "" : "opacity-90"}>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-foreground">{r.repName}</div>
                        {!r.eligible && r.payoutStatus !== "paid" && r.blockReason && (
                          <div className="text-2xs text-muted-foreground mt-0.5">{r.blockReason}</div>
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums font-semibold text-foreground">{usd(r.finalCommissionCents)}</td>
                      <td className="px-4 py-2.5 text-right"><PayStatusCell r={r} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!canPay && (
            <div className="border-t border-border px-4 py-3 flex items-start gap-2 text-xs text-muted-foreground bg-secondary/20" data-testid="payout-review-only">
              <Lock className="w-3.5 h-3.5 mt-px flex-shrink-0" /> This batch is read-only for your role. An admin must approve and submit the payout.
            </div>
          )}

          {canPay && insufficientBalance && (
            <div className="border-t border-red-500/25 px-4 py-3 flex items-start gap-2 text-xs text-red-400 bg-red-500/[0.06]" data-testid="payout-insufficient-balance">
              <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
              {balanceUnknown
                ? <>The Stripe balance couldn't be checked, so submitting is paused. Retry the balance above before paying this batch.</>
                : <>Add {usd(payableCents - (availableCents ?? 0))} to your available Stripe balance before paying this batch.</>}
            </div>
          )}

          {/* Per-rep results of the latest run (paid / failed / skipped) */}
          {results && results.length > 0 && (
            <div className="border-t border-border" data-testid="pay-reps-results">
              <div className="px-4 py-2 text-2xs uppercase tracking-wider text-muted-foreground font-semibold bg-secondary/20">
                Latest payout run
              </div>
              <div className="divide-y divide-border">
                {results.map(res => (
                  <div key={res.repId} className="px-4 py-2 flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium text-foreground min-w-0 truncate">{nameFor(res.repId)}</span>
                    <span className="flex items-center gap-2 flex-shrink-0">
                      {res.reason && <span className="text-[11px] text-muted-foreground">{res.reason}</span>}
                      {res.amountCents != null && <span className="tabular-nums text-muted-foreground">{usd(res.amountCents)}</span>}
                      {res.paid && <span className="text-[11px] font-semibold text-emerald-400 inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Paid</span>}
                      {res.failed && <span className="text-[11px] font-semibold text-red-400 inline-flex items-center gap-1"><XCircle className="w-3 h-3" /> Failed</span>}
                      {res.skipped && <span className="text-[11px] font-semibold text-muted-foreground">Skipped</span>}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Footer: summary + primary action (button disabled when nothing is payable) */}
          <div className="border-t border-border p-3 flex items-center gap-3 flex-wrap bg-secondary/10">
            <div className="text-xs text-muted-foreground mr-auto" data-testid="pay-reps-summary">
              <strong className="text-foreground">{payableCount}</strong> rep{payableCount === 1 ? "" : "s"} · <strong className="text-foreground tabular-nums">{usd(payableCents)}</strong> ready to pay
              {payableCount > 0 && <div className="text-2xs mt-0.5">Estimated Stripe fee for this run: {usd(estimatedCost.payoutRunFeeCents)}*</div>}
            </div>
            {canPay && (
              <Button size="sm" className="h-8 bg-primary hover:bg-primary/90 text-white text-xs"
                disabled={payableCount === 0 || pay.isPending || insufficientBalance}
                onClick={() => setConfirmOpen(true)}
                aria-label={`Pay ${payableCount} reps, ${usd(payableCents)} total`}
                data-testid="pay-reps-btn">
                <Send className="w-3.5 h-3.5 mr-1" /> Pay {payableCount} rep{payableCount === 1 ? "" : "s"}
              </Button>
            )}
          </div>
        </>
      )}

      {/* Confirmation - restates the EXACT total + count before any money moves.
          Reachable only when Stripe is enabled and there is something to pay. */}
      <Dialog open={confirmOpen} onOpenChange={v => !v && setConfirmOpen(false)}>
        <DialogContent className="bg-card border-border text-foreground max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Banknote className="w-4 h-4 text-primary" /> Pay {payableCount} rep{payableCount === 1 ? "" : "s"}?
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-xl bg-secondary/40 border border-border p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Reps to pay</span>
                <span className="font-semibold tabular-nums text-foreground">{payableCount}</span>
              </div>
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-border">
                <span className="font-semibold text-foreground">Total payout</span>
                <span className="tabular-nums font-bold text-lg text-foreground">{usd(payableCents)}</span>
              </div>
              <div className="flex items-center justify-between mt-2 text-xs">
                <span className="text-muted-foreground">Estimated Stripe payout fee*</span>
                <span className="tabular-nums text-foreground">{usd(estimatedCost.payoutRunFeeCents)}</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              This sends each eligible rep their commission to their connected Stripe account for bank payout. It moves real money and can't be undone from here. Only reps marked <span className="text-emerald-400 font-medium">Ready</span> are paid; blocked reps are skipped.
            </p>
            <p className="text-2xs text-muted-foreground">*Estimate uses Stripe's published standard US Connect rate: 0.25% + 25¢ per payout. Active accounts may add $2 per paid rep each month; confirm your account's contracted pricing.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" className="border-border" onClick={() => setConfirmOpen(false)} disabled={pay.isPending}>Cancel</Button>
            <Button className="bg-primary hover:bg-primary/90 text-white" disabled={pay.isPending || payableCount === 0 || insufficientBalance || !canPay}
              onClick={() => pay.mutate()} data-testid="pay-confirm">
              {pay.isPending
                ? <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> Paying…</>
                : <><Send className="w-3.5 h-3.5 mr-1" /> Confirm &amp; pay {usd(payableCents)}</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── House amount per sale ─────────────────────────────────────────────────────
// What the COMPANY books for one qualified sale. It never enters a payout —
// it's the revenue side of the commission statement, so a rep's statement can
// show what the door was worth alongside what they earned on it. Leaving it at
// $0 hides the column entirely rather than printing $0.00 next to every door.
function HouseAmountCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: config } = useQuery<{ houseAmountCents: number }>({
    queryKey: ["/api/commission/config"],
    queryFn: () => apiRequest("GET", "/api/commission/config").then(r => r.json()),
  });
  // `undefined` = "showing the saved value"; a string = the operator is editing.
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const saved = config?.houseAmountCents ?? 0;
  const shown = draft ?? (saved > 0 ? (saved / 100).toFixed(2) : "");

  const save = useMutation({
    mutationFn: (cents: number) =>
      apiRequest("PATCH", "/api/commission/config", { commissionHouseAmountCents: cents }).then(r => r.json()),
    onSuccess: (cfg: any) => {
      setDraft(undefined);
      qc.setQueryData(["/api/commission/config"], cfg);
      toast({
        title: cfg.houseAmountCents > 0 ? `House amount set to ${usd(cfg.houseAmountCents)}` : "House amount cleared",
        description: cfg.houseAmountCents > 0
          ? "Statements now show what each sale is worth to the company beside what the rep earned."
          : "Statements will omit the house column.",
      });
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  const submit = () => {
    const dollars = Number(shown);
    if (shown.trim() === "") return save.mutate(0);
    if (!Number.isFinite(dollars) || dollars < 0) {
      return toast({ title: "Enter a dollar amount", description: "House amount must be zero or more.", variant: "destructive" });
    }
    save.mutate(Math.round(dollars * 100));
  };

  return (
    <div className="rounded-xl bg-card border border-border p-4" data-testid="house-amount-card">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <Label htmlFor="house-amount" className="text-sm font-semibold">House amount per sale</Label>
          <p className="text-[12px] text-muted-foreground mt-0.5 max-w-md">
            What the company books for one qualified sale. Shown on every commission
            statement beside the rep's commission. Leave blank to hide the column.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <Input
              id="house-amount"
              inputMode="decimal"
              placeholder="0.00"
              value={shown}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") submit(); }}
              className="w-32 pl-7 tabular-nums"
              data-testid="house-amount-input"
            />
          </div>
          <Button
            size="sm"
            onClick={submit}
            disabled={save.isPending || draft === undefined}
            data-testid="house-amount-save"
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
