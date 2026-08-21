import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { usd } from "@/lib/money";
import { CheckCircle2, Printer, Clock, XCircle, RotateCcw, Loader2, Check, UserRoundX, CircleDollarSign } from "lucide-react";
import { CommissionStatement } from "@/components/CommissionStatement";
import { OverrideStatusPill } from "@/components/DownlineSheet";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/ui/page-scaffold";
import { Skeleton } from "@/components/ui/skeleton";
import { calculateRetroactiveCommission } from "@shared/commissionTiers";
import { rankProgress, type Rank } from "@shared/commissionRanks";
import type { MyOverrideWeekResponse } from "@shared/commissionOverrides";

// The statement opens by ID and pulls its own server-assembled document, so the
// rep's paper copy is the same document the PDF renders — house amounts,
// holdback and reserve balance included. The page no longer re-derives a
// statement shape client-side, which is what let the screen and the payroll
// file drift apart (per-door credit from `rate × count`, spiffs and hourly pay
// missing from the total, a hardcoded company name).

// ── Rep-facing "My Commission this week" ──────────────────────────────────────
// Reads GET /api/commission/statements/me/current — the caller's own live week.
// Shows current earnings, the retroactive tier the week landed in, the exact
// doors that count toward pay, and the "close N more sales to re-price the
// whole week" nudge that makes tiers land. Plan acceptance happens here too.

interface Tier { minimumSales: number; maximumSales: number | null; rateCents: number; label: string; }
interface WeekSale {
  id: number; status: string; sold_at: string; qualified_at: string | null;
  reversed_at: string | null; lead_id: number | null; address: string | null; city: string | null;
  installHold?: boolean; payableAfter?: string | null;
}
interface WeekResponse {
  statement: any | null;
  computation?: {
    qualifiedSaleCount: number; rateCents: number; grossCommissionCents: number;
    adjustmentCents: number; finalCommissionCents: number; tierLabel: string | null;
    retro?: {
      salesUntilNextTier: number | null; nextTierMinimumSales: number | null;
      nextTierRateCents: number | null; nextTierProjectedCommissionCents: number | null;
    } | null;
  } | null;
  bounds?: { localWeekLabel: string; weekStartUtc?: string; nextWeekStartUtc?: string } | null;
  structure?: { structure: "FLAT" | "TIERED"; flatRateCents: number | null; tiers: Tier[]; planName: string; acceptedAt: string | null } | null;
  sales?: WeekSale[];
  adjustments?: Array<{ id: number; amount_cents: number; reason: string; type: string; approved_at: string | null }>;
  holdback?: {
    current: { reservePercent: number; reserveCents: number; netPayableCents: number; earnedCents: number };
    ledger: { reservePercent: number; reserveBalanceCents: number; netPaidCents: number; earnedToDateCents: number };
  } | null;
  noPlan?: boolean; noRepProfile?: boolean; locked?: boolean;
}

// A rep must never wonder whether a number is projected, being reviewed, locked,
// or already paid. This badge is ALWAYS present on the week strip.
const WEEK_STATE: Record<string, { label: string; cls: string; icon: "lock" | "check" | null }> = {
  OPEN: { label: "Projected · still live", cls: "bg-warning/10 text-warning", icon: null },
  REVIEW: { label: "Under review", cls: "bg-info/10 text-info", icon: null },
  FINALIZED: { label: "Finalized", cls: "bg-primary/15 text-primary", icon: "lock" },
  PAID: { label: "Paid", cls: "bg-success/10 text-success", icon: "check" },
};

// ── Get paid (Stripe Connect payouts) ────────────────────────────────────────
// The rep connects a bank via a Stripe-hosted onboarding flow, then sees their
// payout history here. Feature is DARK until the server reports enabled:true.
type PayoutStatus = "pending" | "processing" | "paid" | "failed" | "reversed";
interface PayoutHistoryItem {
  id: number | string;
  amountCents: number;
  status: PayoutStatus;
  statementId: number | string | null;
  createdAt: string;
  paidAt: string | null;
}
interface PayoutAccount {
  hasRepProfile: boolean;
  enabled: boolean;
  onboardingStatus: "none" | "pending" | "restricted" | "enabled";
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  history: PayoutHistoryItem[];
}
// Status pill colors per spec: paid → emerald, pending/processing → amber,
// failed → red, reversed → muted. Same tint idiom as the rest of the file, and
// the tinted square also skins the row's leading status-icon tile.
const PAYOUT_STATUS: Record<PayoutStatus, { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }> = {
  paid: { label: "Paid", cls: "bg-success/10 text-success", Icon: CheckCircle2 },
  processing: { label: "Processing", cls: "bg-warning/10 text-warning", Icon: Clock },
  pending: { label: "Pending", cls: "bg-warning/10 text-warning", Icon: Clock },
  failed: { label: "Failed", cls: "bg-destructive/10 text-destructive", Icon: XCircle },
  reversed: { label: "Reversed", cls: "bg-muted text-muted-foreground", Icon: RotateCcw },
};

export default function MyCommission() {


  const [stmtId, setStmtId] = useState<number | null>(null);
  const [showAllWeeks, setShowAllWeeks] = useState(false);
  const { data, isLoading, isError, refetch } = useQuery<WeekResponse>({
    queryKey: ["/api/commission/statements/me/current"],
    queryFn: () => apiRequest("GET", "/api/commission/statements/me/current").then(r => r.json()),
  });

  // "Past weeks" is the CALLER'S history, never the org's. Without ?repId= the
  // server widens the list to the caller's whole read scope — a team lead's
  // downline, a manager's entire tenant — and every row renders the same bare
  // week label, so ten reps' statements looked like ten inexplicable duplicates
  // of the viewer's own week. The server authorizes the param via canReadRep,
  // so it can only narrow, never widen.
  const { user } = useAuth();
  const myRepId = user?.teamMemberId ?? null;
  const { data: history = [], isError: historyError, refetch: refetchHistory } = useQuery<any[]>({
    queryKey: ["/api/commission/statements", "mine", myRepId],
    queryFn: () => apiRequest("GET", `/api/commission/statements?repId=${myRepId}`).then(r => r.json()),
    enabled: myRepId != null,
  });
  // The history endpoint includes the active statement. This page already
  // renders that statement as "This week", so showing it again under "Past
  // weeks" creates a false duplicate. Filter by both immutable id and week
  // start for compatibility with older rows that may omit one field.
  const currentStatementId = data?.statement?.id;
  const currentWeekStart = data?.statement?.week_start_utc ?? data?.bounds?.weekStartUtc;
  const pastHistory = isLoading ? [] : history.filter((statement: any) =>
    statement.id !== currentStatementId
      && (!currentWeekStart || statement.week_start_utc !== currentWeekStart),
  );

  return (
    <div className="w-full max-w-3xl mx-auto p-4 pt-5 pb-24 space-y-5 md:p-6 md:space-y-6">
      <PageHeader
        title="My commission"
        subtitle={data?.bounds?.localWeekLabel ? `Week of ${data.bounds.localWeekLabel}` : "This week's earnings"}
        actions={
          !isLoading && data?.statement?.id && !data.noPlan && !data.noRepProfile ? (
            <button
              type="button"
              onClick={() => setStmtId(Number(data.statement.id))}
              data-testid="open-statement"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-secondary px-3 text-sm font-semibold text-foreground transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Statement
            </button>
          ) : undefined
        }
      />

      {stmtId != null && <CommissionStatement statementId={stmtId} onClose={() => setStmtId(null)} />}

      {isLoading && (
        <div className="space-y-4" role="status" aria-busy="true" aria-label="Loading your commission">
          <Skeleton className="h-40 w-full rounded-2xl" />
          <Skeleton className="h-24 w-full rounded-2xl" />
        </div>
      )}

      {isError && (
        <div className="rounded-xl bg-card border border-destructive/25 p-6 text-center" data-testid="commission-error">
          <div className="text-sm font-semibold text-foreground">Couldn't load your commission</div>
          <div className="text-sm text-muted-foreground mt-1">Check your connection and try again - your money data is safe.</div>
          <button onClick={() => refetch()}
            className="mt-4 inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-secondary px-4 text-sm font-semibold text-foreground transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Retry
          </button>
        </div>
      )}

      {!isLoading && data?.noRepProfile && (
        <EmptyState
          icon={UserRoundX}
          title="No rep profile linked yet"
          description="Your login isn't linked to a sales profile. Ask your manager to finish your onboarding; then your weekly commission will appear here."
        />
      )}

      {!isLoading && data?.noPlan && (
        <EmptyState
          icon={CircleDollarSign}
          title="No commission plan assigned"
          description="You don't have a commission structure assigned for this week yet. Your manager can assign a flat or tiered plan from the Team page."
        />
      )}

      {/* Plan acceptance - the direct-onboarding handshake. Until accepted, the
          terms are front and center with one clear action. */}
      {!isLoading && data?.structure && !data.structure.acceptedAt && (
        <AcceptPlanCard structure={data.structure} />
      )}

      {!isLoading && data && !data.noPlan && !data.noRepProfile && (
        <WeekView data={data} />
      )}

      {/* Sale ledger - includes held/reversed doors so the rep can reconcile why
          the payable total may be lower than the number of completed sales. */}
      {!isLoading && data && (data.sales?.length ?? 0) > 0 && (
        <section className="rounded-xl bg-card border border-border overflow-hidden" data-testid="week-sales">
          <header className="px-4 py-3 border-b border-border flex items-center gap-2">
            
            <span className="text-sm font-semibold tracking-tight text-foreground">This week's sales</span>
            <span className="ml-auto text-[11px] text-muted-foreground">pay status for every door</span>
          </header>
          <div className="divide-y divide-border">
            {data.sales!.map(s => (
              <div key={s.id} className="px-4 py-2.5 flex items-center justify-between gap-3" data-testid={`sale-row-${s.id}`}>
                <div className="min-w-0">
                  <div className={`text-sm truncate ${s.status === "REVERSED" ? "text-muted-foreground line-through" : "text-foreground"}`}>
                    {s.address ?? "Sale"}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {new Date(s.qualified_at ?? s.sold_at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}
                    {s.city ? ` · ${s.city}` : ""}
                  </div>
                  {s.installHold && (
                    <div className="mt-0.5 text-[11px] text-warning" data-testid={`install-hold-detail-${s.id}`}>
                      {s.payableAfter
                        ? `Payable after ${new Date(s.payableAfter).toLocaleDateString()}`
                        : "Waiting for installation confirmation"}
                    </div>
                  )}
                </div>
                <SaleChip status={s.status} installHold={s.installHold} />
              </div>
            ))}
          </div>
          {(data.sales ?? []).some(s => s.installHold) && (
            <div className="px-4 py-2 bg-warning/5 text-[11px] text-muted-foreground border-t border-border" data-testid="install-hold-explainer">
              Install-held sales are qualified, but they are not payable until installation is confirmed and any configured hold period has ended.
            </div>
          )}
          {(data.sales ?? []).some(s => s.status === "REVERSED") && (
            <div className="px-4 py-2 bg-muted/40 text-[11px] text-muted-foreground border-t border-border">
              Reversed doors don't count toward pay. If you think one is wrong, ask your manager to review it.
            </div>
          )}
        </section>
      )}

      {/* Get paid - connect a Stripe payout account + see payout history.
          Self-gating: renders nothing until the server reports payouts enabled. */}
      {!isLoading && !isError && data && !data.noRepProfile && <GetPaidSection />}

      {/* Past weeks - a plain statement list. A failed fetch says so instead of
          silently deleting the section (money history must never just vanish). */}
      {historyError && (
        <section className="rounded-xl bg-card border border-border p-4 text-center" role="alert" data-testid="history-error">
          <div className="text-sm text-muted-foreground">Couldn't load your past weeks.</div>
          <button onClick={() => refetchHistory()}
            className="mt-2 inline-flex items-center justify-center min-h-11 px-4 rounded-lg bg-secondary border border-border text-sm font-semibold text-foreground active:scale-95 transition-transform">
            Retry
          </button>
        </section>
      )}
      {pastHistory.length > 0 && (
        <section className="rounded-xl bg-card border border-border overflow-hidden">
          <header className="px-4 py-3 border-b border-border flex items-center gap-2">
            
            <span className="text-sm font-semibold tracking-tight text-foreground">Past weeks</span>
            {/* Count matches what's on screen — never a number larger than the list. */}
            <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
              {!showAllWeeks && pastHistory.length > 8 ? `last 8 of ${pastHistory.length}` : pastHistory.length}
            </span>
          </header>
          <div className="divide-y divide-border">
            {(showAllWeeks ? pastHistory : pastHistory.slice(0, 8)).map((s: any) => (
              <div key={s.id} className="px-4 py-3 flex items-center justify-between gap-3" data-testid={`row-week-${s.id}`}>
                <div className="min-w-0">
                  <div className="text-sm text-foreground truncate">{s.local_week_label}</div>
                  <div className="text-[11px] text-muted-foreground tabular-nums">
                    {s.qualified_sale_count} sale{s.qualified_sale_count === 1 ? "" : "s"} · {usd(s.rate_cents)}/sale
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-sm font-semibold text-foreground tabular-nums">{usd(s.final_commission_cents)}</span>
                  <StatusPill status={s.status} />
                  <button
                    type="button"
                    onClick={() => setStmtId(Number(s.id))}
                    aria-label={`Open statement for ${s.local_week_label}`}
                    data-testid={`statement-${s.id}`}
                    className="tap-expand inline-flex items-center justify-center h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 active:scale-95 transition-all"
                  >
                    <Printer className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
          {pastHistory.length > 8 && (
            <button
              type="button"
              onClick={() => setShowAllWeeks(v => !v)}
              className="min-h-tap w-full border-t border-border px-4 text-[13px] font-semibold text-primary transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              data-testid="btn-toggle-all-weeks"
            >
              {showAllWeeks ? "Show fewer" : `Show all ${pastHistory.length} weeks`}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

// ── Chargeback reserve (holdback) ─────────────────────────────────────────────
// Grammar from shipped payout UIs (Mobbin): the alias breakdown (earned → cut →
// net as stacked lines), Whatnot's available/processing split, and Linktree's
// pending-vs-lifetime with a plain-language explainer. Only renders when the
// tenant actually runs a reserve (percent > 0) — a disabled tenant sees nothing
// invented. Every number is the authoritative split from the server, so the
// "paid this week" line always reconciles with the hero above it.
// A rep's own reserve, from GET /api/me/reserve. Self-scoped on the SERVER (the
// rep id comes from the session, not a parameter), so this can only ever be the
// caller's own balance.
interface ReserveEntry {
  id: number; kind: "hold" | "drawdown" | "release"; amountCents: number;
  weekLabel: string | null; reason: string; createdAt: string;
}
export interface ReserveSummaryResponse {
  reservePercent: number;
  reserveCapCents: number | null;
  balanceCents: number;
  capRemainingCents: number | null;
  capProgressPercent: number | null;
  atCap: boolean;
  heldToDateCents: number;
  drawnDownToDateCents: number;
  releasedToDateCents: number;
  latestHold: ReserveEntry | null;
  entries: ReserveEntry[];
  noRepProfile?: boolean;
}

// Plain-language labels — a rep should never have to decode "drawdown".
const ENTRY_COPY: Record<ReserveEntry["kind"], { label: string; tone: string }> = {
  hold:     { label: "Held from your pay",      tone: "text-warning" },
  drawdown: { label: "Used for a cancellation", tone: "text-destructive" },
  release:  { label: "Released back to you",    tone: "text-success" },
};

function HoldbackCard({ holdback }: { holdback: NonNullable<WeekResponse["holdback"]> }) {
  const { current, ledger } = holdback;
  // The rep's OWN reserve ledger. Self-scoped on the SERVER — the rep id comes
  // from the session, not from this request — so there is no id here that could
  // ever point at another rep.
  const { data: reserve } = useQuery<ReserveSummaryResponse>({
    queryKey: ["/api/me/reserve"],
    queryFn: () => apiRequest("GET", "/api/me/reserve").then(r => r.json()),
    enabled: (current?.reservePercent ?? 0) > 0,
  });
  if (!current || current.reservePercent <= 0) return null;   // reserve disabled → no card

  // The ledger endpoint is authoritative for the BALANCE (it is the only thing
  // that knows about manual drawdowns and releases); the week payload is
  // authoritative for THIS WEEK's split. Fall back to the week payload's rolled
  // balance if the ledger read hasn't landed yet, so the card never shows a hole.
  const balanceCents = reserve?.balanceCents ?? ledger.reserveBalanceCents;
  const capCents = reserve?.reserveCapCents ?? null;
  const progress = reserve?.capProgressPercent ?? null;
  const atCap = reserve?.atCap ?? false;
  const entries = reserve?.entries ?? [];

  return (
    <div className="rounded-2xl bg-card border border-border overflow-hidden" data-testid="holdback-card">
      <header className="px-4 py-3 border-b border-border flex items-center gap-2">
        
        <span className="text-sm font-semibold tracking-tight text-foreground">Chargeback reserve</span>
        <span className="ml-auto text-[11px] font-semibold text-warning tabular-nums">
          {atCap ? "Fully covered" : `${current.reservePercent}% held`}
        </span>
      </header>

      {/* What this IS, said first and in plain language. */}
      <p className="px-4 pt-3 text-[11px] leading-snug text-muted-foreground" data-testid="reserve-explainer">
        A small part of each week's pay is set aside to cover sales that later cancel or charge back.
        It builds up to a maximum and then stops - nothing more is held after that.
      </p>

      {/* This week's split - earned → -reserve → net paid (the alias pattern). */}
      <dl className="px-4 py-3 space-y-2 text-[13px]">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Earned this week</dt>
          <dd className="tabular-nums text-foreground">{usd(current.earnedCents)}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Reserve held ({current.reservePercent}%)</dt>
          <dd className="tabular-nums text-warning" data-testid="holdback-reserve">-{usd(current.reserveCents)}</dd>
        </div>
        <div className="flex items-center justify-between border-t border-border pt-2">
          <dt className="font-semibold text-foreground">Paid to you this week</dt>
          <dd className="tabular-nums font-bold text-success" data-testid="holdback-net">{usd(current.netPayableCents)}</dd>
        </div>
      </dl>

      {/* Balance + progress toward the cap. Integer percent from the server —
          the bar and the number can never disagree with the ledger. */}
      <div className="px-4 py-3 border-t border-border bg-secondary/30">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Your reserve balance</span>
          <span className="tabular-nums text-base font-bold text-foreground" data-testid="holdback-balance">{usd(balanceCents)}</span>
        </div>

        {capCents != null && (
          <div className="mt-2" data-testid="reserve-cap-progress">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-border"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress ?? 0}
              aria-label="Progress toward your reserve maximum"
            >
              <div
                className={atCap ? "h-full rounded-full bg-success" : "h-full rounded-full bg-warning"}
                style={{ width: `${Math.min(100, Math.max(0, progress ?? 0))}%` }}
              />
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
              <span className="tabular-nums" data-testid="reserve-cap-label">{usd(balanceCents)} of {usd(capCents)} maximum</span>
              <span className="tabular-nums">{progress ?? 0}%</span>
            </div>
          </div>
        )}

        {atCap ? (
          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug font-medium text-success" data-testid="reserve-at-cap">
            
            You're fully covered - nothing more is being held. Your whole commission is paid to you each week.
          </p>
        ) : (
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground" data-testid="reserve-remaining">
            {capCents != null
              ? <>{usd(reserve?.capRemainingCents ?? Math.max(0, capCents - balanceCents))} left before the reserve is full and nothing more is held.</>
              : <>Held as a chargeback reserve across your paid weeks.</>}
          </p>
        )}

        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
          Your reserve is released by your admin - it is never taken automatically. After your contract ends,
          the remaining balance is released within 90 days, less any valid chargebacks, reversals, or amounts owed.
        </p>
      </div>

      {/* History - every hold, chargeback, and release with its date and reason.
          The ledger is append-only, so this list is the complete record. */}
      {entries.length > 0 && (
        <div className="border-t border-border" data-testid="reserve-history">
          <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Reserve history
          </div>
          <ul className="divide-y divide-border">
            {entries.slice(0, 8).map(e => {
              const copy = ENTRY_COPY[e.kind] ?? ENTRY_COPY.hold;
              return (
                <li key={e.id} className="px-4 py-2.5 flex items-start justify-between gap-3" data-testid={`reserve-entry-${e.id}`}>
                  <span className="min-w-0">
                    <span className="block text-[12px] font-medium text-foreground">{copy.label}</span>
                    <span className="block text-[11px] text-muted-foreground truncate">
                      {e.weekLabel ? `${e.weekLabel} · ` : ""}{e.reason}
                    </span>
                  </span>
                  <span className={`shrink-0 text-[13px] font-semibold tabular-nums ${copy.tone}`}>
                    {e.amountCents > 0 ? "+" : "-"}{usd(Math.abs(e.amountCents))}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Override earnings - what my downline earned me this week ──────────────────
// Self-fetching and self-gating, like GetPaidSection: a plain rep with no
// downline and no ledger rows must see NOTHING - no empty card, no explainer
// about a program that doesn't apply to them. Loading and errors also render
// null: this is a bonus layer on the page, never a hole in it.
// Payable and held are SEPARATE figures (the EarningsToday rule: certain and
// uncertain money never share a number), and the statement footer reconciles
// this card against the frozen statement whenever one exists.
function OverrideEarningsCard() {
  const { data, isLoading, isError } = useQuery<MyOverrideWeekResponse>({
    queryKey: ["/api/commission/overrides/me"],
    queryFn: () => apiRequest("GET", "/api/commission/overrides/me").then(r => r.json()),
  });

  if (isLoading || isError || !data) return null;
  // Optional-chained: a payload without the wire shape (older server, proxy
  // error page) must degrade to "no card", never to a crash on a money screen.
  const rows = data.rows ?? [];
  if (!data.hasDownline && rows.length === 0) return null;
  const totals = data.totals ?? { rowCount: 0, payableCents: 0, heldCents: 0, settledCents: 0 };

  const roleLabel: Record<string, string> = { rep: "Rep", team_lead: "Team Lead", manager: "Manager" };

  return (
    <section className="rounded-xl bg-card border border-border overflow-hidden" data-testid="override-earnings-card">
      <header className="px-4 py-3 border-b border-border flex items-center gap-2">
        
        <span className="text-sm font-semibold tracking-tight text-foreground">Override earnings</span>
        <span className="ml-auto text-[11px] text-muted-foreground">from your downline's sales</span>
      </header>

      {/* Payable is the headline; held and settled stand apart as their own
          muted figures - never blended into one number. */}
      <div className="px-4 py-3 flex items-end justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Payable this week</div>
          <div className="mt-0.5 text-2xl font-semibold tracking-tight tabular-nums text-foreground" data-testid="override-payable">
            {usd(totals.payableCents)}
          </div>
        </div>
        <div className="flex items-center gap-4 text-right">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">On hold</div>
            <div className="mt-0.5 text-sm font-semibold tabular-nums text-muted-foreground" data-testid="override-held">
              {usd(totals.heldCents)}
            </div>
          </div>
          {totals.settledCents > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Settled</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums text-muted-foreground" data-testid="override-settled">
                {usd(totals.settledCents)}
              </div>
            </div>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-3 border-t border-border text-xs text-muted-foreground" data-testid="override-no-rows">
          No override earnings this week - they appear as your downline closes doors.
        </div>
      ) : (
        <div className="divide-y divide-border border-t border-border">
          {rows.map(r => (
            <div key={r.id} className="px-4 py-2.5 flex items-center justify-between gap-3" data-testid={`override-row-${r.id}`}>
              <div className="min-w-0">
                <div className="text-sm text-foreground truncate">
                  {r.downlineRepName}
                  <span className="text-muted-foreground"> · {roleLabel[r.downlineRoleAtEarn] ?? r.downlineRoleAtEarn}</span>
                </div>
                <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                  {r.soldAt
                    ? new Date(r.soldAt).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
                    : " - "}
                  {r.saleStatus && <SaleChip status={r.saleStatus} />}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className={`text-sm font-semibold tabular-nums ${r.amountCents < 0 ? "text-destructive" : "text-foreground"}`}>
                  {r.amountCents < 0 ? `-${usd(Math.abs(r.amountCents))}` : usd(r.amountCents)}
                </span>
                <OverrideStatusPill status={r.status} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Reconciliation against the frozen statement - only when one exists. */}
      {data.statementOverrideCents != null && (
        <footer className="px-4 py-2.5 border-t border-border bg-secondary/30 flex items-center justify-between text-xs" data-testid="override-statement-footer">
          <span className="text-muted-foreground">Included in your statement</span>
          <span className="tabular-nums font-semibold text-foreground">{usd(data.statementOverrideCents)}</span>
        </footer>
      )}
    </section>
  );
}

// ── Rank presentation ─────────────────────────────────────────────────────────
// Metal tints tuned for the dark card at AA. Presentation ONLY - names and
// math come from shared/commissionRanks, which projects the same ladder the
// money engine pays from.
// Each tint carries BOTH themes: the base classes are tuned for the dark card,
// and the [.light_&] arbitrary variants re-tune the text for the white card -
// slate-300 on white is 1.26:1, invisible. Bars darken in light mode too so
// the fill stays visible against the light track.
const RANK_TINTS: Record<string, { chip: string; bar: string }> = {
  Bronze:   { chip: "bg-warning/[0.12] text-warning",   bar: "bg-warning [.light_&]:bg-warning" },
  Silver:   { chip: "bg-slate-400/20 text-slate-300 [.light_&]:text-slate-600",   bar: "bg-slate-300 [.light_&]:bg-slate-500" },
  Gold:     { chip: "bg-warning/[0.12] text-warning", bar: "bg-warning [.light_&]:bg-warning" },
  Platinum: { chip: "bg-info/[0.12] text-info",     bar: "bg-info [.light_&]:bg-info" },
};
const rankTint = (name: string) =>
  RANK_TINTS[name] ?? { chip: "bg-violet-400/20 text-violet-300 [.light_&]:text-violet-700", bar: "bg-violet-300 [.light_&]:bg-violet-600" }; // Diamond+

function RankChip({ rank, size = "md" }: { rank: Rank; size?: "sm" | "md" }) {
  const tint = rankTint(rank.name);
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap flex-shrink-0 rounded-full font-bold ${tint.chip} ${size === "md" ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-2xs"}`}>
      
      {rank.name}
    </span>
  );
}

function RankCard({ tiers, count }: { tiers: Tier[]; count: number }) {
  const p = rankProgress(
    tiers.map((t, i) => ({ position: i, minimumSales: t.minimumSales, maximumSales: t.maximumSales, rateCents: t.rateCents, label: t.label ?? "" })),
    count,
  );
  if (!p) return null;  // a broken ladder gets no rank rail, not a wrong one

  // Top of the ladder - a calm "you've maxed it" state, not a goal card.
  if (p.atTop || !p.next) {
    return (
      <div className="rounded-2xl bg-card border border-border p-5" data-testid="rank-card">
        <div className="flex items-center gap-2.5">
          {p.current && <RankChip rank={p.current} />}
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold tracking-tight text-foreground">Top rank reached</span>
              
            </div>
            <p className="text-[12px] text-muted-foreground">Every sale this week pays the top rate.</p>
          </div>
        </div>
        <RankRail p={p} className="mt-4" />
      </div>
    );
  }

  // The financial upside is the headline (per the redesign): remaining sales →
  // the RETROACTIVE gain (the reprice of the whole week, not a marginal rate).
  const next = p.next;
  const tint = rankTint(next.name);
  const currentPayCents = Math.max(0, (p.weekPayAtNextCents ?? 0) - (p.gainAtNextCents ?? 0));
  const total = next.minimumSales;
  // Render discrete checkpoints only when the ladder step is small enough to
  // stay uncluttered; otherwise the bar alone carries the progress.
  const showCheckpoints = total <= 12;
  const nodes = Array.from({ length: total }, (_, i) => i);

  return (
    <div className="rounded-2xl bg-card border border-border overflow-hidden" data-testid="rank-card">
      {/* Next target header - Silver framed prominently (Grab Driver "Next tier"). */}
      <div className="flex items-center justify-between gap-2 px-5 pt-4">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Next target</span>
          {/* RankChip already carries the medal + name - wrapping it in a second
              chip that repeated {next.name} rendered "Bronze Bronze". */}
          <RankChip rank={next} />
        </div>
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning/90">
           Close by Sunday night
        </span>
      </div>

      {/* HERO - the upside, not the tier name. */}
      <div className="px-5 pt-3" data-testid="rank-next">
        <p className="text-[15px] font-semibold text-foreground leading-tight">
          {p.salesToNext} more sale{p.salesToNext === 1 ? "" : "s"} unlock{p.salesToNext === 1 ? "s" : ""}
        </p>
        <div className="mt-0.5 flex items-baseline gap-2">
          <span className="text-[34px] font-bold tracking-tight text-success tabular-nums leading-none" data-testid="rank-hero-gain">
            +{usd(p.gainAtNextCents!)}
          </span>
          <span className="inline-flex items-center gap-1 text-[12px] font-medium text-success/80">
             more this week
          </span>
        </div>
        {/* current → next earnings */}
        <div className="mt-2 flex items-center gap-2 text-[13px] tabular-nums" data-testid="rank-earnings-jump">
          <span className="font-semibold text-muted-foreground">{usd(currentPayCents)}</span>
          
          <span className={`font-bold ${tint.chip.split(" ").slice(1).join(" ")}`}>{usd(p.weekPayAtNextCents!)}</span>
          <span className="text-[11px] text-muted-foreground">· all {total} paid at {usd(next.rateCents)}</span>
        </div>
      </div>

      {/* High-contrast progress + checkpoints (Crypto.com station rail). */}
      <div className="px-5 pt-4">
        <div className="flex items-center justify-between text-[11px] font-semibold">
          <span className="text-foreground tabular-nums">{count}<span className="text-muted-foreground">/{total} sales</span></span>
          <span className="text-muted-foreground">{p.salesToNext} to go</span>
        </div>
        <div className="mt-1.5 h-2.5 rounded-full bg-secondary overflow-hidden" role="progressbar"
          aria-valuenow={count} aria-valuemin={0} aria-valuemax={total}
          aria-label={`${count} of ${total} sales toward ${next.name}`}>
          <div className={`h-full rounded-full transition-all ${tint.bar}`}
            style={{ width: `${Math.max(5, Math.min(100, (count / total) * 100))}%` }} />
        </div>

        {showCheckpoints && (
          <div className="mt-3 flex items-center gap-1.5" data-testid="rank-checkpoints" aria-hidden="true">
            {nodes.map(i => {
              const done = i < count;
              const isUnlock = i === total - 1;   // the final checkpoint unlocks the next rank
              if (isUnlock) {
                return (
                  <div key={i} className="flex flex-1 items-center gap-1.5">
                    <span className="h-0.5 flex-1 rounded-full bg-border" />
                    <span className={`grid place-items-center rounded-full ${done ? tint.bar : `border border-dashed ${tint.chip.split(" ")[0]}`} h-7 w-7`}>
                      <RankChip rank={next} size="sm" />
                    </span>
                  </div>
                );
              }
              return (
                <div key={i} className="flex flex-1 items-center gap-1.5">
                  <span className={`grid h-5 w-5 place-items-center rounded-full ${done ? tint.bar + " text-white" : "bg-secondary text-muted-foreground/50"}`}>
                    {done ? <Check className="w-3 h-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                  </span>
                  {i < total - 2 && <span className={`h-0.5 flex-1 rounded-full ${i < count - 1 ? tint.bar : "bg-border"}`} />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* The full ladder stays visible but SECONDARY (Gold and beyond). */}
      <RankRail p={p} className="mt-4 px-5 pb-5" secondary />
    </div>
  );
}

// The whole climb - every rung visible (Crypto.com stations / Grab criteria).
function RankRail({ p, className = "", secondary = false }: { p: NonNullable<ReturnType<typeof rankProgress>>; className?: string; secondary?: boolean }) {
  return (
    <div className={className}>
      {secondary && <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground/70">The full ladder</p>}
      <div className="grid gap-1.5" data-testid="rank-rail">
        {p.ladder.map(r => {
          const isCurrent = p.current?.bandIndex === r.bandIndex;
          const reached = p.current != null && r.bandIndex <= p.current.bandIndex;
          const isNext = p.next?.bandIndex === r.bandIndex;
          return (
            <div key={r.bandIndex}
              aria-current={isCurrent ? "step" : undefined}
              className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 ${isCurrent ? "bg-primary/[0.08] border border-primary/25" : isNext ? "bg-secondary/60" : "bg-secondary/30"}`}
              data-testid={`rank-rung-${r.name.toLowerCase().replace(/\s/g, "-")}`}>
              <div className="flex items-center gap-2 min-w-0">
                <RankChip rank={r} size="sm" />
                <span className={`truncate text-[11px] ${reached || isNext ? "text-foreground" : "text-muted-foreground"}`}>
                  {r.minimumSales}{r.maximumSales == null ? "+" : `-${r.maximumSales}`} sales
                  {isCurrent && <span className="sr-only"> - your current rank</span>}
                </span>
              </div>
              <span className={`text-xs tabular-nums font-semibold ${reached || isNext ? "text-foreground" : "text-muted-foreground"}`}>
                {usd(r.rateCents)}<span className="font-normal text-muted-foreground">/sale</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekView({ data }: { data: WeekResponse }) {
  const comp = data.computation;
  const structure = data.structure;
  const stmt = data.statement;
  const count = comp?.qualifiedSaleCount ?? stmt?.qualified_sale_count ?? 0;
  const rateCents = comp?.rateCents ?? stmt?.rate_cents ?? 0;
  const finalCents = comp?.finalCommissionCents ?? stmt?.final_commission_cents ?? 0;
  const grossCents = comp?.grossCommissionCents ?? stmt?.gross_commission_cents ?? 0;
  const retro = comp?.retro ?? null;
  const isTiered = structure?.structure !== "FLAT";
  const tiers = structure?.tiers ?? [];
  // Money state - real statement status, falling back to a live projection.
  const stateKey = (stmt?.status ?? (data.locked ? "FINALIZED" : "OPEN")) as string;
  const weekStillOpen = data.bounds?.nextWeekStartUtc
    ? Date.now() < Date.parse(data.bounds.nextWeekStartUtc)
    : false;
  const finalizedEarly = stateKey === "FINALIZED" && weekStillOpen;
  const state = finalizedEarly
    ? { label: "Finalized early", cls: "bg-warning/10 text-warning", icon: "lock" as const }
    : WEEK_STATE[stateKey] ?? WEEK_STATE.OPEN;
  // The rate a rep earns on their FIRST sale (never render "$0 per sale").
  const entryRateCents = isTiered ? (tiers[0]?.rateCents ?? 15000) : (structure?.flatRateCents ?? 0);

  return (
    <>
      {/* Week strip - this week's commission as a hairline-divided finance strip,
          with an ALWAYS-present money-state badge */}
      <div className="rounded-xl bg-card border border-border overflow-hidden">
        <div className="p-5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-primary uppercase tracking-wide">
               This week
            </div>
            <span className={`inline-flex items-center gap-1.5 text-2xs font-bold px-2 py-0.5 rounded-full ${state.cls}`} data-testid="week-state">
              {state.icon === "lock"
                ? null
                : state.icon === "check"
                  ? null
                  : <span className="w-1 h-1 rounded-full bg-current" />}
              {state.label}
            </span>
          </div>
          {/* The one number the rep opens this page for. Gold-as-text, matching
              the money headline on Incentives/Referrals/Mileage per the design
              system - this is the page's single gold element. */}
          <div className="mt-3 text-4xl font-semibold tracking-tight text-gold-text tabular-nums" data-testid="text-week-commission">
            {usd(finalCents)}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {count === 0
              ? <>No qualified sales yet · starts at {usd(entryRateCents)} per sale</>
              : <>{count} qualified sale{count === 1 ? "" : "s"} · {usd(rateCents)} per sale{isTiered && comp?.tierLabel ? ` · ${comp.tierLabel}` : ""}</>}
          </div>
          {stateKey === "OPEN" && (
            <div className="mt-1 text-[11px] text-muted-foreground">This is a live projection - it can still change until the scheduled week close.</div>
          )}
          {finalizedEarly && (
            <div className="mt-2 rounded-lg border border-warning/25 bg-warning/[0.08] px-3 py-2 text-[11px] text-foreground" role="status" data-testid="finalized-early-warning">
              This statement was locked before the scheduled week close. New sales will not change it; ask your manager to review the early finalization if it was not intentional.
            </div>
          )}
          {/* THE number a rep is really asking for: what lands in their pocket
              after the tenant's chargeback reserve. Stated in the hero - not
              buried in the reserve card - whenever a holdback is configured.
              (Gusto/Stripe payout grammar: gross above, take-home called out.) */}
          {data.holdback?.current && data.holdback.current.reservePercent > 0 && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-success/15 bg-success/[0.08] px-3.5 py-2.5" data-testid="hero-net-pay">
              <span className="text-[13px] font-semibold text-foreground">You'll be paid</span>
              <span className="text-right">
                <span className="block text-[18px] font-bold tabular-nums text-success leading-tight" data-testid="hero-net-pay-amount">{usd(data.holdback.current.netPayableCents)}</span>
                <span className="block text-[11px] text-muted-foreground tabular-nums">after {data.holdback.current.reservePercent}% reserve · -{usd(data.holdback.current.reserveCents)} held</span>
              </span>
            </div>
          )}
        </div>

        {/* Hairline-divided metric strip */}
        <div className="grid grid-cols-3 divide-x divide-border border-t border-border">
          <MetricCell label="Qualified" value={String(count)} />
          <MetricCell label="Per sale" value={usd(count === 0 ? entryRateCents : rateCents)} accent />
          <MetricCell label="Gross commission" value={usd(grossCents)} />
        </div>

        {/* Adjustments - a deduction is NEVER an unexplained number */}
        {(data.adjustments?.length ?? 0) > 0 && (
          <div className="border-t border-border p-4 space-y-1.5" data-testid="hero-adjustments">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Gross commission ({count} × {usd(rateCents || entryRateCents)})</span>
              <span className="tabular-nums text-foreground">{usd(grossCents)}</span>
            </div>
            {data.adjustments!.map(a => (
              <div key={a.id} className="flex items-start justify-between text-xs gap-3">
                <span className="text-muted-foreground min-w-0">
                  <span className={a.amount_cents < 0 ? "text-destructive font-semibold" : "text-success font-semibold"}>{a.amount_cents < 0 ? "Deduction" : "Bonus"}</span>
                  {" - "}{a.reason}
                </span>
                <span className={`tabular-nums flex-shrink-0 ${a.amount_cents < 0 ? "text-destructive" : "text-success"}`}>{a.amount_cents > 0 ? "+" : "-"}{usd(Math.abs(a.amount_cents))}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Why the week dropped MORE than one sale - the retroactive rule in
          reverse, said out loud. When a canceled deal pulls the count below a
          band boundary, every surviving sale reprices down too: losing the 7th
          on a 1-6 $175 / 7+ $225 ladder is not -$225, it is -$525. Without
          this panel that difference is an unexplained hole in the number the
          rep saw yesterday, and the complaint lands on their manager. Computed
          with the SAME shared module the server pays from, so the panel can
          never disagree with the paycheck. (Same transparency rule as the
          adjustments block: a deduction is never an unexplained number.) */}
      {(() => {
        if (!isTiered || tiers.length === 0 || stateKey !== "OPEN") return null;
        // Only reversals that had QUALIFIED count toward "what the week would
        // have been" — a sale reversed straight from PENDING (qualified_at is
        // null) never contributed to the count, and including it would show a
        // clawback from a band the rep never actually held.
        const reversedCount = (data.sales ?? []).filter(sale => sale.status === "REVERSED" && sale.qualified_at != null).length;
        if (reversedCount === 0 || count === 0) return null;
        const wouldBe = calculateRetroactiveCommission(count + reversedCount, tiers as any);
        if (wouldBe.rateCents <= rateCents) return null;  // no band was lost
        const dropCents = wouldBe.grossCommissionCents - grossCents;
        return (
          <div className="rounded-xl border border-warning/25 bg-warning/[0.06] p-4" data-testid="band-drop-notice">
            <div className="flex items-center gap-2">
              
              <span className="text-sm font-semibold text-foreground">Why this week dropped more than one sale</span>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {reversedCount === 1 ? "A canceled deal" : `${reversedCount} canceled deals`} pulled you out of the{" "}
              <span className="font-semibold text-foreground">{wouldBe.tierLabel}</span> band - tiers are retroactive,
              so your {count} remaining sale{count === 1 ? "" : "s"} repriced from {usd(wouldBe.rateCents)} to{" "}
              {usd(rateCents)} each. That's {usd(dropCents)} in total, not just the lost sale.
            </p>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Win it back: the week is still open - {retro?.salesUntilNextTier != null
                ? `${retro.salesUntilNextTier} more sale${retro.salesUntilNextTier === 1 ? "" : "s"} puts every door back at the higher rate.`
                : "another qualified sale can restore the band."}
            </p>
          </div>
        );
      })()}

      {/* Override earnings - money the rep's DOWNLINE produced for them. A
          separate additive layer, so it gets its own card between the week
          strip and the reserve; it never folds into the hero number silently. */}
      <OverrideEarningsCard />

      {/* Reserve holdback — this week's earned/held/paid split + running balance.
          Renders only when the tenant runs a reserve; numbers are authoritative. */}
      {data.holdback && <HoldbackCard holdback={data.holdback} />}

      {/* Rank card — the bands with names on them (tiered + open weeks only).
          Grammar from the shipped tier systems on Mobbin: Grab Driver (medal +
          "Next tier:" + progress), Qantas ("Attain Silver" panel), Airtasker
          ("$880 away from Silver"), Crypto.com (the full rung rail with the
          next rung highlighted). Ranks are DERIVED from the rep's own ladder
          via shared/commissionRanks — the badge can never disagree with pay. */}
      {/* OPEN weeks only: a locked statement froze its rates but NOT the tier
          list, so ranking history against today's ladder could re-rank a past
          week after a plan change. The frozen statement is the record. */}
      {isTiered && tiers.length > 0 && stateKey === "OPEN" && <RankCard tiers={tiers} count={count} />}

      {isTiered && retro && retro.salesUntilNextTier == null && count > 0 && (
        <div className="rounded-xl bg-card border border-success/25 p-4 flex items-center gap-3">
          
          <span className="text-sm text-foreground">You're in the <strong>top tier</strong> this week - every sale pays {usd(rateCents)}.</span>
        </div>
      )}

      {/* Tier ladder or flat rate. On OPEN tiered weeks the RankCard above
          already renders every band (rate + range + current/next highlight), so
          repeating the same rows here was pure duplicate scroll - this plain
          card now serves only the weeks where the RankCard is absent (locked
          statements, whose frozen rates are the record). */}
      {isTiered ? (!(tiers.length > 0 && stateKey === "OPEN") &&
        <div className="rounded-xl bg-card border border-border overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            
            <span className="text-sm font-semibold tracking-tight text-foreground">Your tier ladder</span>
            {structure?.planName && <span className="ml-auto text-[11px] text-muted-foreground">{structure.planName}</span>}
          </div>
          <div className="divide-y divide-border">
            {tiers.map((t, i) => {
              const inTier = count >= t.minimumSales && (t.maximumSales == null || count <= t.maximumSales);
              return (
                <div key={i} className={`px-4 py-2.5 flex items-center justify-between ${inTier ? "bg-primary/10" : ""}`} data-testid={`row-tier-${i}`}>
                  <div className="flex items-center gap-2">
                    {inTier && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
                    <span className={`text-sm ${inTier ? "text-foreground font-semibold" : "text-muted-foreground"}`}>
                      {t.minimumSales}{t.maximumSales == null ? "+" : `-${t.maximumSales}`} sales
                    </span>
                  </div>
                  <span className={`text-sm tabular-nums ${inTier ? "text-primary font-bold" : "text-muted-foreground"}`}>
                    {usd(t.rateCents)}/sale
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="rounded-xl bg-card border border-border p-5 flex items-center gap-3">
          
          <div>
            <div className="text-sm font-semibold tracking-tight text-foreground">Flat rate plan</div>
            <div className="text-xs text-muted-foreground">{usd(structure?.flatRateCents)} for every qualified sale.</div>
          </div>
        </div>
      )}
    </>
  );
}

function MetricCell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${accent ? "text-primary" : "text-foreground"}`}>{value}</div>
    </div>
  );
}

function SaleChip({ status, installHold = false }: { status: string; installHold?: boolean }) {
  if (installHold) {
    return (
      <span className="inline-flex items-center gap-1 text-2xs font-bold px-2 py-0.5 rounded-full whitespace-nowrap bg-warning/10 text-warning">
        <span className="w-1 h-1 rounded-full bg-current" />install hold
      </span>
    );
  }
  const map: Record<string, [string, string]> = {
    QUALIFIED: ["counts", "bg-success/10 text-success"],
    PENDING: ["pending", "bg-warning/10 text-warning"],
    REVERSED: ["reversed", "bg-destructive/10 text-destructive"],
    DISQUALIFIED: ["disqualified", "bg-destructive/10 text-destructive"],
    CANCELLED: ["cancelled", "bg-muted text-muted-foreground"],
  };
  const [label, cls] = map[status] ?? [status.toLowerCase(), "bg-muted text-muted-foreground"];
  return (
    <span className={`inline-flex items-center gap-1 text-2xs font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${cls}`}>
      <span className="w-1 h-1 rounded-full bg-current" />{label}
    </span>
  );
}

// The commission-plan handshake: the rep sees the EXACT terms and accepts them.
// The server freezes the terms + a SHA-256 into the assignment (audited).
function AcceptPlanCard({ structure }: { structure: NonNullable<WeekResponse["structure"]> }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const accept = useMutation({
    mutationFn: () => apiRequest("POST", "/api/commission/my-plan/accept").then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Plan accepted", description: "Your commission terms are locked to your file. Go sell." });
      qc.invalidateQueries({ queryKey: ["/api/commission/statements/me/current"] });
      // The Past-weeks list reads a different key - refresh it too so the page
      // never shows a stale history next to a fresh current week.
      qc.invalidateQueries({ queryKey: ["/api/commission/statements"] });
    },
    onError: (e: any) => toast({ title: "Couldn't accept plan", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="rounded-xl border border-primary/40 bg-primary/5 p-5" data-testid="accept-plan-card">
      <div className="flex items-center gap-2 mb-3">
        
        <span className="text-sm font-semibold tracking-tight text-foreground">Review &amp; accept your commission plan</span>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        This is how you're paid: <strong className="text-foreground">{structure.planName}</strong>.
        Weeks run Monday-Sunday in your org's timezone. Accepting freezes these exact terms to your file.
      </p>
      {structure.structure === "TIERED" ? (
        <div className="grid grid-cols-2 gap-2 mb-4">
          {structure.tiers.map((t, i) => (
            <div key={i} className="rounded-lg bg-card border border-border px-3 py-2 flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground leading-tight">
                {t.minimumSales}{t.maximumSales == null ? "+" : `-${t.maximumSales}`} sales
              </span>
              <span className="text-sm font-bold text-primary tabular-nums">{usd(t.rateCents)}<span className="text-2xs text-muted-foreground font-normal">/sale</span></span>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg bg-card border border-border px-3 py-2 mb-4 text-sm">
          <strong className="text-primary tabular-nums">{usd(structure.flatRateCents)}</strong>
          <span className="text-muted-foreground"> for every qualified sale.</span>
        </div>
      )}
      {structure.structure === "TIERED" && structure.tiers.length > 1 && (
        // The example is derived from THIS rep's actual second band - it used
        // to hardcode "Hit 8" from the standard ladder, which stated wrong
        // terms for anyone on a custom plan, on the exact card that freezes
        // terms to their file.
        <p className="text-[11px] text-muted-foreground mb-4">
          Tiers are <strong className="text-foreground">retroactive</strong>: your total weekly sales set one rate for
          <em> every</em> sale. Hit {structure.tiers[1].minimumSales} and all {structure.tiers[1].minimumSales} pay{" "}
          {usd(structure.tiers[1].rateCents)} each.
        </p>
      )}
      <button
        onClick={() => accept.mutate()}
        disabled={accept.isPending}
        className="w-full min-h-tap flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-semibold py-2.5 rounded-xl transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        data-testid="btn-accept-plan"
      >
        {accept.isPending ? "Accepting…" : "I understand and accept this plan"}
      </button>
    </div>
  );
}



function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    OPEN: "bg-warning/10 text-warning",
    REVIEW: "bg-info/10 text-info",
    FINALIZED: "bg-primary/15 text-primary",
    PAID: "bg-success/10 text-success",
  };
  return (
    <span className={`inline-flex items-center gap-1 text-2xs font-semibold px-1.5 py-0.5 rounded-full ${map[status] || "bg-muted text-muted-foreground"}`}>
      <span className="w-1 h-1 rounded-full bg-current" />{status?.toLowerCase()}
    </span>
  );
}

// ── "Get paid" section ────────────────────────────────────────────────────────
// Grounded in Mobbin: Turo's "You're verified!" success banner (enabled state),
// the Stripe Dashboard payments list (payout-history rows), and the Contra/Stripe
// "Add your bank to receive payouts" card + Turo's "Powered by Stripe" trust line
// (connect state). The whole feature stays dark until the server enables it.
function GetPaidSection() {
  const { toast } = useToast();
  const qc = useQueryClient();

  // Return-from-Stripe handshake: if the rep just came back from onboarding
  // (#onboard=done), refresh the Stripe status, refetch the account, then wipe
  // the hash so a reload doesn't refire it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.location.hash.includes("onboard=done")) return;
    apiRequest("POST", "/api/payouts/account/refresh")
      .catch(() => { /* non-fatal — the refetch below still reconciles state */ })
      .finally(() => {
        qc.invalidateQueries({ queryKey: ["/api/payouts/account"] });
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      });
  }, [qc]);

  const {
    data: account,
    isError: isAccountError,
    isFetching: isAccountFetching,
    refetch: refetchAccount,
  } = useQuery<PayoutAccount>({
    queryKey: ["/api/payouts/account"],
    queryFn: () => apiRequest("GET", "/api/payouts/account").then(r => r.json()),
  });

  const connect = useMutation({
    mutationFn: () => apiRequest("POST", "/api/payouts/connect").then(r => r.json()),
    onSuccess: (res: { url?: string }) => {
      if (res?.url) { window.location.href = res.url; return; }
      toast({ title: "Couldn't start setup", description: "No onboarding link came back - try again in a moment.", variant: "destructive" });
    },
    onError: (e: any) => toast({ title: "Payouts aren't ready yet", description: e?.message ?? "Please try again shortly.", variant: "destructive" }),
  });

  if (isAccountError) {
    return (
      <section className="space-y-3" data-testid="get-paid">
        <div className="flex items-center gap-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Get paid
        </div>
        <div
          role="alert"
          className="rounded-xl border border-destructive/25 bg-destructive/[0.06] p-4"
          data-testid="payout-account-error"
        >
          <p className="text-sm font-semibold text-foreground">Couldn't load payout account</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Payout readiness and bank status are hidden until this check succeeds. No payout action is available right now.
          </p>
          <button
            type="button"
            onClick={() => { void refetchAccount(); }}
            disabled={isAccountFetching}
            className="mt-4 inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-background px-4 text-sm font-semibold text-foreground transition-colors hover:bg-secondary disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="payout-account-retry"
          >
            {isAccountFetching ? "Trying again…" : "Try again"}
          </button>
        </div>
      </section>
    );
  }

  // Feature dark until Stripe is configured server-side → render nothing extra.
  if (!account || !account.enabled) return null;

  // Fail closed: a status label alone is not enough to promise that Stripe can
  // actually send money. All three server signals must agree.
  const isReady = account.onboardingStatus === "enabled"
    && account.payoutsEnabled
    && account.detailsSubmitted;
  const connectLabel =
    account.onboardingStatus === "restricted" ? "Reconnect payout account"
    : account.onboardingStatus === "pending" ? "Continue setup"
    : account.onboardingStatus === "enabled" ? "Finish payout setup"
    : "Connect payout account";

  return (
    <section className="space-y-3" data-testid="get-paid">
      <div className="flex items-center gap-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
         Get paid
      </div>

      {isReady ? (
        <>
          {/* Payouts-ready confirmation — Turo "You're verified!" */}
          <div className="rounded-xl border border-success/25 bg-success/[0.08] p-4 flex items-center gap-3" data-testid="payouts-ready">
            
            <div className="min-w-0">
              <div className="text-sm font-semibold tracking-tight text-foreground">Payouts ready</div>
              <div className="text-xs text-muted-foreground">Your commission goes straight to your connected bank.</div>
            </div>
            
          </div>

          {/* Payout history — Stripe Dashboard payments list */}
          <div className="rounded-xl bg-card border border-border overflow-hidden">
            <header className="px-4 py-3 border-b border-border flex items-center gap-2">
              
              <span className="text-sm font-semibold tracking-tight text-foreground">Payout history</span>
              {account.history.length > 0 && (
                <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{account.history.length}</span>
              )}
            </header>
            {account.history.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-sm font-semibold tracking-tight text-foreground">No payouts yet</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto leading-relaxed">
                  Your first payout shows up here once a weekly statement is paid out.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {account.history.map(p => <PayoutRow key={p.id} item={p} />)}
              </div>
            )}
          </div>
        </>
      ) : (
        /* Connect card — Contra/Stripe "Add your bank to receive payouts" */
        <div className="rounded-xl bg-card border border-border p-5" data-testid="get-paid-connect">
          <div className="flex items-start gap-3">
            
            <div className="min-w-0">
              <div className="text-sm font-semibold tracking-tight text-foreground">Set up payouts</div>
              <p className="text-xs text-muted-foreground mt-0.5">Connect your bank to receive commission payouts.</p>
            </div>
          </div>

          {account.onboardingStatus === "pending" && (
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-warning/[0.08] border border-warning/[0.12] px-3 py-2 text-xs text-warning" data-testid="payout-status-note">
              <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" aria-hidden="true" /> Verifying your details…
            </div>
          )}
          {account.onboardingStatus === "restricted" && (
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-destructive/[0.08] border border-destructive/[0.12] px-3 py-2 text-xs text-destructive" data-testid="payout-status-note">
               Action needed - reconnect to finish verification.
            </div>
          )}

          <button
            type="button"
            onClick={() => connect.mutate()}
            disabled={connect.isPending}
            data-testid="connect-payout"
            className="mt-4 w-full inline-flex items-center justify-center gap-2 h-11 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-semibold transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {connect.isPending
              ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              : null}
            {connect.isPending ? "Opening secure setup…" : connectLabel}
          </button>

          <div className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
             Powered by Stripe · bank details handled securely
          </div>
        </div>
      )}
    </section>
  );
}

function PayoutRow({ item }: { item: PayoutHistoryItem }) {
  const when = item.status === "paid" && item.paidAt ? item.paidAt : item.createdAt;
  return (
    <div className="px-4 py-3 flex items-center gap-3" data-testid="payout-history-row">
      
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground tabular-nums">{usd(item.amountCents)}</div>
        <div className="text-[11px] text-muted-foreground tabular-nums truncate">
          {when
            ? new Date(when).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
            : " - "}
          {item.statementId != null ? ` · Statement #${item.statementId}` : ""}
        </div>
      </div>
      <PayoutStatusPill status={item.status} />
    </div>
  );
}

function PayoutStatusPill({ status }: { status: PayoutStatus }) {
  const s = PAYOUT_STATUS[status] ?? PAYOUT_STATUS.pending;
  return (
    <span className={`inline-flex items-center gap-1 text-2xs font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap flex-shrink-0 ${s.cls}`}>
      <span className="w-1 h-1 rounded-full bg-current" />{s.label}
    </span>
  );
}
