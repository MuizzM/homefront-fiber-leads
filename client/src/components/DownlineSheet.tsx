import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useCan } from "@/lib/capabilities";
import { usd, usdSigned } from "@/lib/money";
import {
  AlertTriangle, ChevronDown, ChevronRight, Download, GitBranch, ShieldCheck, Users,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import {
  OVERRIDE_STATUS_TONE, overrideStatusLabel,
  type DownlineSheetResponse, type DownlineTreeResponse,
  type OverrideLedgerStatus, type OverrideRowWire,
} from "@shared/commissionOverrides";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import type { TeamMember } from "@shared/schema";

// ── Downline override sheet — the console's third tab ─────────────────────────
// One screen answers, for a team lead or manager: which of my downline sold
// this week, what override money each of them produced for me, what state that
// money is in (payable / on hold / settled — NEVER blended into one figure),
// and what needs a human. Admins can open any leader's sheet via the picker.
// Server-authoritative throughout: every number comes from the override ledger.

// Same tint idiom as the console's StatusChip, keyed by the SHARED tone map so
// this sheet and the rep's own card can never disagree about what a status means.
const OVERRIDE_TONE_CLS: Record<(typeof OVERRIDE_STATUS_TONE)[OverrideLedgerStatus], string> = {
  positive: "bg-emerald-500/15 text-emerald-400",
  muted: "bg-muted text-muted-foreground",
  warning: "bg-amber-500/15 text-amber-400",
  critical: "bg-rose-500/15 text-rose-400",
};

export function OverrideStatusPill({ status }: { status: OverrideLedgerStatus }) {
  return (
    <span className={`inline-flex items-center gap-1 text-2xs font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${OVERRIDE_TONE_CLS[OVERRIDE_STATUS_TONE[status]]}`}>
      <span className="w-1 h-1 rounded-full bg-current" />{overrideStatusLabel(status)}
    </span>
  );
}

// SaleChip idiom (MyCommission) — the sale's own lifecycle, distinct from the
// override row's ledger status beside it.
function SaleChip({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    QUALIFIED: ["counts", "bg-emerald-500/15 text-emerald-400"],
    PENDING: ["pending", "bg-amber-500/15 text-amber-400"],
    REVERSED: ["reversed", "bg-rose-500/15 text-rose-400"],
    DISQUALIFIED: ["disqualified", "bg-rose-500/15 text-rose-400"],
    CANCELLED: ["cancelled", "bg-muted text-muted-foreground"],
  };
  const [label, cls] = map[status] ?? [status.toLowerCase(), "bg-muted text-muted-foreground"];
  return (
    <span className={`inline-flex items-center gap-1 text-2xs font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${cls}`}>
      <span className="w-1 h-1 rounded-full bg-current" />{label}
    </span>
  );
}

const ROLE_SHORT: Record<string, string> = { rep: "Rep", team_lead: "Team Lead", manager: "Manager" };
const roleShort = (role: string) => ROLE_SHORT[role] ?? role;

// Same authed-blob download as the console's week-export.csv: an <a href> can't
// carry the session header, so fetch through apiRequest and hand back a blob.
function downloadSheetCsv(weekRef: string, repId: number | null) {
  const qs = `week=${encodeURIComponent(weekRef)}${repId != null ? `&repId=${repId}` : ""}`;
  apiRequest("GET", `/api/commission/overrides/sheet-export.csv?${qs}`)
    .then(r => r.blob())
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `overrides-${weekRef.slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    });
}

export function DownlineSheet({ weekRef, weekLabel }: { weekRef: string; weekLabel: string }) {
  // read.downline gates the tab itself (the console omits it otherwise);
  // read.all additionally unlocks the view-as picker — an admin/manager may
  // open any leader's sheet, a team lead only ever sees their own tree.
  const canViewAs = useCan("commission.read.all");
  const { user } = useAuth();
  const [repId, setRepId] = useState<number | null>(null); // null = my own sheet
  const [openRep, setOpenRep] = useState<number | null>(null);

  // An admin login may have no team-member row of its own — "my sheet" is then
  // meaningless, so the queries wait until the picker names a target instead of
  // firing a guaranteed 400 and trapping the picker behind the error card.
  const needsTarget = user?.teamMemberId == null && repId == null;

  const sheetQs = `week=${encodeURIComponent(weekRef)}${repId != null ? `&repId=${repId}` : ""}`;
  const { data: sheet, isLoading, isError, refetch } = useQuery<DownlineSheetResponse>({
    queryKey: ["/api/commission/overrides/sheet", weekRef, repId ?? "me"],
    queryFn: () => apiRequest("GET", `/api/commission/overrides/sheet?${sheetQs}`).then(r => r.json()),
    enabled: !needsTarget,
  });

  // The tree distinguishes "no downline at all" (assign reps first) from
  // "downline, but nobody sold this week" — the sheet's rows can't tell them apart.
  const { data: tree } = useQuery<DownlineTreeResponse>({
    queryKey: ["/api/commission/downline", repId ?? "me"],
    queryFn: () => apiRequest("GET", `/api/commission/downline${repId != null ? `?repId=${repId}` : ""}`).then(r => r.json()),
    enabled: !needsTarget,
  });

  const { data: teamData } = useQuery<TeamMember[]>({
    queryKey: ["/api/team"],
    queryFn: () => apiRequest("GET", "/api/team").then(r => r.json()),
    enabled: canViewAs,
  });
  const team = Array.isArray(teamData) ? teamData : [];
  // Only members who can HAVE a downline are worth viewing as.
  const leaders = team.filter(m => m.active && (m.role === "team_lead" || m.role === "manager"));

  // Only claim "no downline" once the tree has affirmatively said so — while it
  // loads, the $0 sheet is the honest render, not an invented empty state.
  const hasDownline = tree == null ? true : tree.members.length > 0;
  const rowsFor = (downlineRepId: number): OverrideRowWire[] =>
    (sheet?.rows ?? []).filter(r => r.downlineRepId === downlineRepId);

  return (
    <div className="space-y-5" role="tabpanel" aria-label="Downline overrides" data-testid="downline-sheet">
      {/* View-as picker + export — read.all only sees the picker at all */}
      <div className="flex items-center gap-2 flex-wrap">
        {canViewAs && (
          <div className="flex items-center gap-2" data-testid="downline-viewas">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Sheet for</span>
            <Select
              value={repId != null ? String(repId) : "me"}
              onValueChange={v => { setRepId(v === "me" ? null : Number(v)); setOpenRep(null); }}
            >
              <SelectTrigger className="h-9 w-56 bg-secondary border-border" data-testid="downline-viewas-trigger">
                <SelectValue placeholder="Select member" />
              </SelectTrigger>
              <SelectContent className="bg-card border-border">
                <SelectItem value="me">Me</SelectItem>
                {leaders.map(m => (
                  <SelectItem key={m.id} value={String(m.id)}>
                    {m.name} · {roleShort(m.role)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {repId != null && sheet && (
            <span className="text-xs text-muted-foreground" data-testid="downline-viewing-as">
              Viewing <span className="text-foreground font-medium">{sheet.viewer.repName}</span>'s downline
            </span>
          )}
          <a href={`/api/commission/overrides/sheet-export.csv?${sheetQs}`}
            onClick={e => { e.preventDefault(); downloadSheetCsv(weekRef, repId); }}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            data-testid="export-overrides-csv">
            <Download className="w-3.5 h-3.5" /> Export CSV
          </a>
        </div>
      </div>

      {needsTarget ? (
        <EmptyState
          icon={Users}
          title="Pick a leader"
          description="Your login has no field profile of its own — choose a team lead or manager above to open their downline sheet."
          bordered
          testId="downline-pick-target"
        />
      ) : isLoading ? (
        <div className="h-48 rounded-2xl bg-card border border-border animate-pulse" data-testid="downline-loading" />
      ) : isError || !sheet ? (
        <div className="rounded-xl bg-card border border-rose-500/30 p-6 text-center" data-testid="downline-error">
          <div className="text-sm font-semibold text-foreground">Couldn't load the downline sheet</div>
          <div className="text-sm text-muted-foreground mt-1">Check your connection and try again — the override ledger is safe.</div>
          <button onClick={() => refetch()}
            className="mt-4 inline-flex items-center justify-center h-10 px-4 rounded-lg bg-secondary border border-border text-sm font-semibold text-foreground active:scale-95 transition-transform">
            Retry
          </button>
        </div>
      ) : !hasDownline ? (
        <EmptyState
          icon={GitBranch}
          title="No downline yet"
          description="Overrides pay uplines on their downline's sales. Assign reps on the Team page and this sheet fills in as they sell."
          bordered
          testId="downline-empty"
        />
      ) : (
        <>
          {/* Totals — payable / on hold / settled stay SEPARATE figures. Certain
              and uncertain money never share a number (the EarningsToday rule). */}
          <div className="rounded-xl bg-card border border-border overflow-hidden" data-testid="override-totals">
            <div className="grid grid-cols-3 divide-x divide-border">
              <div className="px-4 py-3" data-testid="tile-override-payable">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Payable</div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums text-emerald-400">{usd(sheet.totals.payableCents)}</div>
              </div>
              <div className="px-4 py-3" data-testid="tile-override-held">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">On hold</div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums text-muted-foreground">{usd(sheet.totals.heldCents)}</div>
              </div>
              <div className="px-4 py-3" data-testid="tile-override-settled">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Settled</div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">{usd(sheet.totals.settledCents)}</div>
              </div>
            </div>
          </div>

          {/* Needs review — same panel grammar as the week overview's exceptions */}
          {sheet.exceptions.length > 0 ? (
            <div className="rounded-2xl bg-card border border-amber-500/30 overflow-hidden" data-testid="override-exceptions">
              <div className="px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-semibold text-foreground">Needs review before closeout</span>
                <span className="ml-auto text-xs text-muted-foreground">{sheet.exceptions.length}</span>
              </div>
              <div className="divide-y divide-border">
                {sheet.exceptions.map((ex, i) => (
                  <div key={i} className="px-4 py-2.5 flex items-start gap-3 text-sm">
                    <span className="text-2xs font-bold uppercase tracking-wide text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5 mt-0.5 whitespace-nowrap">
                      {ex.type.replace(/_/g, " ").toLowerCase()}
                    </span>
                    <span className="text-muted-foreground">
                      <span className="text-foreground font-medium">{ex.repName}</span>
                      {" — "}{ex.detail}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-card border border-border px-4 py-2.5 flex items-center gap-2 text-sm text-muted-foreground" data-testid="override-exceptions-clear">
              <ShieldCheck className="w-4 h-4 text-emerald-400" /> Nothing needs review — every number is explainable.
            </div>
          )}

          {/* Per-member rollup — tap a row for the exact sales behind its number */}
          <div className="rounded-2xl bg-card border border-border overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <Users className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-semibold">Downline this week</span>
              {weekLabel && <span className="ml-auto text-xs text-muted-foreground">{weekLabel}</span>}
            </div>
            {sheet.rollup.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground" data-testid="downline-no-rows">
                No override earnings this week.
              </div>
            ) : (
              <div className="divide-y divide-border">
                {sheet.rollup.map(m => {
                  const open = openRep === m.repId;
                  return (
                    <div key={m.repId}>
                      <button
                        type="button"
                        onClick={() => setOpenRep(open ? null : m.repId)}
                        aria-expanded={open}
                        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-secondary/40 transition-colors"
                        data-testid={`rollup-row-${m.repId}`}
                      >
                        {open ? <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm text-foreground truncate">{m.repName}</span>
                            <span className="text-[11px] text-muted-foreground">{roleShort(m.role)}</span>
                            <span className="text-2xs font-bold tabular-nums px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground" title={`${m.level} level${m.level === 1 ? "" : "s"} below`}>
                              L{m.level}
                            </span>
                            {!m.active && (
                              <span className="text-2xs font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">Inactive</span>
                            )}
                          </div>
                          <div className="text-[11px] text-muted-foreground mt-0.5 tabular-nums">
                            {m.saleCount} sale{m.saleCount === 1 ? "" : "s"}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0 tabular-nums">
                          <div className="text-sm font-bold text-foreground">{usd(m.payableCents)}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {m.heldCents > 0 && <>{usd(m.heldCents)} held</>}
                            {m.heldCents > 0 && m.settledCents > 0 && " · "}
                            {m.settledCents > 0 && <>{usd(m.settledCents)} settled</>}
                            {m.heldCents === 0 && m.settledCents === 0 && "payable"}
                          </div>
                        </div>
                      </button>

                      {open && (
                        <div className="border-t border-border bg-secondary/20 divide-y divide-border" data-testid={`rollup-detail-${m.repId}`}>
                          {rowsFor(m.repId).map(r => (
                            <div key={r.id} className="px-4 py-2.5 pl-11 flex items-center justify-between gap-3 text-sm" data-testid={`override-row-${r.id}`}>
                              <div className="min-w-0">
                                <div className="text-sm text-foreground truncate">
                                  {r.soldAt ? new Date(r.soldAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"}
                                  <span className="text-muted-foreground"> · {r.downlineRepName} ({roleShort(r.downlineRoleAtEarn)})</span>
                                </div>
                                <div className="mt-1 flex items-center gap-1.5">
                                  {r.saleStatus && <SaleChip status={r.saleStatus} />}
                                  {r.entryType === "CLAWBACK" && (
                                    <span className="text-2xs font-bold uppercase text-rose-400">clawback</span>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center gap-2 flex-shrink-0">
                                <span className={`tabular-nums font-semibold ${r.amountCents < 0 ? "text-rose-400" : "text-foreground"}`}>
                                  {r.amountCents < 0 ? usdSigned(r.amountCents) : usd(r.amountCents)}
                                </span>
                                <OverrideStatusPill status={r.status} />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
