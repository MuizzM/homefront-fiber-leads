import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { usd } from "@/lib/money";
import {
  DollarSign, Target, Zap, Trophy, Info, Lock, Layers, CalendarDays,
  FileSignature, CheckCircle2, Home, FileText, Printer,
  Landmark, Wallet, ShieldCheck, Clock, XCircle, RotateCcw, ArrowRight, Loader2, TrendingDown, Medal, Crown, PiggyBank, Sparkles, Check,
} from "lucide-react";
import { CommissionStatement, type StatementModel } from "@/components/CommissionStatement";
import { calculateRetroactiveCommission } from "@shared/commissionTiers";
import { rankProgress, type Rank } from "@shared/commissionRanks";

// Map the live week / a past-week snapshot into the printable statement shape.
function currentWeekModel(data: WeekResponse, repName: string): StatementModel {
  const c = data.computation;
  const label = data.bounds?.localWeekLabel ?? "This week";
  return {
    repName, weekLabel: label,
    status: data.statement?.status ?? "OPEN",
    qualifiedSaleCount: c?.qualifiedSaleCount ?? 0,
    rateCents: c?.rateCents ?? 0,
    grossCents: c?.grossCommissionCents ?? 0,
    adjustmentCents: c?.adjustmentCents ?? 0,
    finalCents: c?.finalCommissionCents ?? 0,
    tierLabel: c?.tierLabel ?? null,
    planName: data.structure?.planName ?? null,
    sales: (data.sales ?? []).map(s => ({ date: s.qualified_at ?? s.sold_at, address: s.address, city: s.city, status: s.status })),
    adjustments: (data.adjustments ?? []).map(a => ({ amount_cents: a.amount_cents, reason: a.reason })),
    statementNo: `HFS-${label.replace(/[^0-9]/g, "").slice(0, 8) || "CUR"}`,
  };
}
function historyModel(s: any, repName: string): StatementModel {
  const gross = s.gross_commission_cents ?? (s.rate_cents ?? 0) * (s.qualified_sale_count ?? 0);
  return {
    repName, weekLabel: s.local_week_label,
    status: s.status,
    qualifiedSaleCount: s.qualified_sale_count ?? 0,
    rateCents: s.rate_cents ?? 0,
    grossCents: gross,
    adjustmentCents: s.adjustment_cents ?? 0,
    finalCents: s.final_commission_cents ?? gross,
    tierLabel: s.tier_label ?? null,
    planName: null, sales: [], adjustments: [],
    statementNo: `HFS-${String(s.id).padStart(5, "0")}`,
  };
}

// ── Rep-facing "My Commission this week" ──────────────────────────────────────
// Reads GET /api/commission/statements/me/current — the caller's own live week.
// Shows current earnings, the retroactive tier the week landed in, the exact
// doors that count toward pay, and the "close N more sales to re-price the
// whole week" nudge that makes tiers land. Plan acceptance happens here too.

interface Tier { minimumSales: number; maximumSales: number | null; rateCents: number; label: string; }
interface WeekSale {
  id: number; status: string; sold_at: string; qualified_at: string | null;
  reversed_at: string | null; lead_id: number | null; address: string | null; city: string | null;
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
  bounds?: { localWeekLabel: string } | null;
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
  OPEN: { label: "Projected · still live", cls: "bg-amber-500/15 text-amber-400", icon: null },
  REVIEW: { label: "Under review", cls: "bg-sky-500/15 text-sky-400", icon: null },
  FINALIZED: { label: "Finalized", cls: "bg-primary/15 text-primary", icon: "lock" },
  PAID: { label: "Paid", cls: "bg-emerald-500/15 text-emerald-400", icon: "check" },
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
  paid: { label: "Paid", cls: "bg-emerald-500/15 text-emerald-400", Icon: CheckCircle2 },
  processing: { label: "Processing", cls: "bg-amber-500/15 text-amber-400", Icon: Clock },
  pending: { label: "Pending", cls: "bg-amber-500/15 text-amber-400", Icon: Clock },
  failed: { label: "Failed", cls: "bg-red-500/15 text-red-400", Icon: XCircle },
  reversed: { label: "Reversed", cls: "bg-muted text-muted-foreground", Icon: RotateCcw },
};

export default function MyCommission() {
  const { user } = useAuth();
  const repName = user?.name ?? "Field Representative";
  const [stmt, setStmt] = useState<StatementModel | null>(null);
  const { data, isLoading, isError, refetch } = useQuery<WeekResponse>({
    queryKey: ["/api/commission/statements/me/current"],
    queryFn: () => apiRequest("GET", "/api/commission/statements/me/current").then(r => r.json()),
  });

  const { data: history = [] } = useQuery<any[]>({
    queryKey: ["/api/commission/statements", "mine"],
    queryFn: () => apiRequest("GET", "/api/commission/statements").then(r => r.json()),
  });

  return (
    <div className="w-full max-w-3xl mx-auto p-4 pt-5 pb-24 space-y-5 md:p-6 md:space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">My Commission</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {data?.bounds?.localWeekLabel ? `Week of ${data.bounds.localWeekLabel}` : "This week's earnings"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!isLoading && data && !data.noPlan && !data.noRepProfile && (
            <button
              type="button"
              onClick={() => setStmt(currentWeekModel(data, repName))}
              data-testid="open-statement"
              className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg bg-secondary border border-border text-sm font-semibold text-foreground active:scale-95 transition-transform"
            >
              <FileText className="w-4 h-4" /> Statement
            </button>
          )}
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <DollarSign className="w-5 h-5 text-primary" />
          </div>
        </div>
      </div>

      {stmt && <CommissionStatement model={stmt} onClose={() => setStmt(null)} />}

      {isLoading && (
        <div className="space-y-4">
          <div className="h-40 rounded-xl bg-card border border-border animate-pulse" />
          <div className="h-24 rounded-xl bg-card border border-border animate-pulse" />
        </div>
      )}

      {isError && (
        <div className="rounded-xl bg-card border border-rose-500/30 p-6 text-center" data-testid="commission-error">
          <div className="text-sm font-semibold text-foreground">Couldn't load your commission</div>
          <div className="text-sm text-muted-foreground mt-1">Check your connection and try again — your money data is safe.</div>
          <button onClick={() => refetch()}
            className="mt-4 inline-flex items-center justify-center h-10 px-4 rounded-lg bg-secondary border border-border text-sm font-semibold text-foreground active:scale-95 transition-transform">
            Retry
          </button>
        </div>
      )}

      {!isLoading && data?.noRepProfile && (
        <EmptyState
          icon={<Info className="w-6 h-6 text-amber-400" />}
          title="No rep profile linked yet"
          body="Your login isn't linked to a sales profile. Ask your manager to finish your onboarding — then your weekly commission shows up here."
        />
      )}

      {!isLoading && data?.noPlan && (
        <EmptyState
          icon={<Target className="w-6 h-6 text-primary" />}
          title="No commission plan assigned"
          body="You don't have a commission structure assigned for this week yet. Your manager can set you up on a flat or tiered plan from the Team page."
        />
      )}

      {/* Plan acceptance — the direct-onboarding handshake. Until accepted, the
          terms are front and center with one clear action. */}
      {!isLoading && data?.structure && !data.structure.acceptedAt && (
        <AcceptPlanCard structure={data.structure} />
      )}

      {!isLoading && data && !data.noPlan && !data.noRepProfile && (
        <WeekView data={data} />
      )}

      {/* What counts — the exact doors behind this week's number */}
      {!isLoading && data && (data.sales?.length ?? 0) > 0 && (
        <section className="rounded-xl bg-card border border-border overflow-hidden" data-testid="week-sales">
          <header className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Home className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-semibold tracking-tight text-foreground">What counts this week</span>
            <span className="ml-auto text-[11px] text-muted-foreground">every door behind your number</span>
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
                </div>
                <SaleChip status={s.status} />
              </div>
            ))}
          </div>
          {(data.sales ?? []).some(s => s.status === "REVERSED") && (
            <div className="px-4 py-2 bg-muted/40 text-[11px] text-muted-foreground border-t border-border">
              Reversed doors don't count toward pay. If you think one is wrong, ask your manager to review it.
            </div>
          )}
        </section>
      )}

      {/* Get paid — connect a Stripe payout account + see payout history.
          Self-gating: renders nothing until the server reports payouts enabled. */}
      {!isLoading && !isError && data && !data.noRepProfile && <GetPaidSection />}

      {/* Past weeks — a plain statement list */}
      {history.length > 0 && (
        <section className="rounded-xl bg-card border border-border overflow-hidden">
          <header className="px-4 py-3 border-b border-border flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-semibold tracking-tight text-foreground">Past weeks</span>
            <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{history.length}</span>
          </header>
          <div className="divide-y divide-border">
            {history.slice(0, 8).map((s: any) => (
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
                    onClick={() => setStmt(historyModel(s, repName))}
                    aria-label={`Open statement for ${s.local_week_label}`}
                    data-testid={`statement-${s.id}`}
                    className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 active:scale-95 transition-all"
                  >
                    <Printer className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
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
function HoldbackCard({ holdback }: { holdback: NonNullable<WeekResponse["holdback"]> }) {
  const { current, ledger } = holdback;
  if (!current || current.reservePercent <= 0) return null;   // reserve disabled → no card
  return (
    <div className="rounded-xl bg-card border border-border overflow-hidden" data-testid="holdback-card">
      <header className="px-4 py-3 border-b border-border flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-amber-500/15 text-amber-400">
          <PiggyBank className="w-4 h-4" aria-hidden="true" />
        </span>
        <span className="text-sm font-semibold tracking-tight text-foreground">Chargeback reserve</span>
        <span className="ml-auto text-[11px] font-semibold text-amber-400 tabular-nums">{current.reservePercent}% held</span>
      </header>

      {/* This week's split — earned → −reserve → net paid (the alias pattern). */}
      <dl className="px-4 py-3 space-y-2 text-[13px]">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Earned this week</dt>
          <dd className="tabular-nums text-foreground">{usd(current.earnedCents)}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">Reserve held ({current.reservePercent}%)</dt>
          <dd className="tabular-nums text-amber-400" data-testid="holdback-reserve">−{usd(current.reserveCents)}</dd>
        </div>
        <div className="flex items-center justify-between border-t border-border pt-2">
          <dt className="font-semibold text-foreground">Paid to you this week</dt>
          <dd className="tabular-nums font-bold text-emerald-400" data-testid="holdback-net">{usd(current.netPayableCents)}</dd>
        </div>
      </dl>

      {/* Running balance (Linktree pending-vs-lifetime) + release explainer. */}
      <div className="px-4 py-3 border-t border-border bg-secondary/30">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Reserve balance</span>
          <span className="tabular-nums text-base font-bold text-foreground" data-testid="holdback-balance">{usd(ledger.reserveBalanceCents)}</span>
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
          Held as a chargeback reserve across your paid weeks. After your contract ends, the remaining
          balance is released within 90 days, less any valid chargebacks, reversals, or amounts owed.
        </p>
      </div>
    </div>
  );
}

// ── Rank presentation ─────────────────────────────────────────────────────────
// Metal tints tuned for the dark card at AA. Presentation ONLY — names and
// math come from shared/commissionRanks, which projects the same ladder the
// money engine pays from.
// Each tint carries BOTH themes: the base classes are tuned for the dark card,
// and the [.light_&] arbitrary variants re-tune the text for the white card —
// slate-300 on white is 1.26:1, invisible. Bars darken in light mode too so
// the fill stays visible against the light track.
const RANK_TINTS: Record<string, { chip: string; bar: string }> = {
  Bronze:   { chip: "bg-amber-600/20 text-amber-500 [.light_&]:text-amber-700",   bar: "bg-amber-500 [.light_&]:bg-amber-600" },
  Silver:   { chip: "bg-slate-400/20 text-slate-300 [.light_&]:text-slate-600",   bar: "bg-slate-300 [.light_&]:bg-slate-500" },
  Gold:     { chip: "bg-yellow-500/20 text-yellow-400 [.light_&]:text-yellow-700", bar: "bg-yellow-400 [.light_&]:bg-yellow-500" },
  Platinum: { chip: "bg-cyan-400/20 text-cyan-300 [.light_&]:text-cyan-700",     bar: "bg-cyan-300 [.light_&]:bg-cyan-600" },
};
const rankTint = (name: string) =>
  RANK_TINTS[name] ?? { chip: "bg-violet-400/20 text-violet-300 [.light_&]:text-violet-700", bar: "bg-violet-300 [.light_&]:bg-violet-600" }; // Diamond+

function RankChip({ rank, size = "md" }: { rank: Rank; size?: "sm" | "md" }) {
  const tint = rankTint(rank.name);
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap flex-shrink-0 rounded-full font-bold ${tint.chip} ${size === "md" ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-[10px]"}`}>
      <Medal className={size === "md" ? "w-3.5 h-3.5" : "w-3 h-3"} aria-hidden="true" />
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

  // Top of the ladder — a calm "you've maxed it" state, not a goal card.
  if (p.atTop || !p.next) {
    return (
      <div className="rounded-2xl bg-card border border-border p-5" data-testid="rank-card">
        <div className="flex items-center gap-2.5">
          {p.current && <RankChip rank={p.current} />}
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold tracking-tight text-foreground">Top rank reached</span>
              <Crown className="w-4 h-4 text-amber-400" aria-hidden="true" />
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
      {/* Next target header — Silver framed prominently (Grab Driver "Next tier"). */}
      <div className="flex items-center justify-between gap-2 px-5 pt-4">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Next target</span>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-bold ${tint.chip}`}>
            <RankChip rank={next} size="sm" /> {next.name}
          </span>
        </div>
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-400/90">
          <Clock className="w-3 h-3" aria-hidden="true" /> Close by Sunday night
        </span>
      </div>

      {/* HERO — the upside, not the tier name. */}
      <div className="px-5 pt-3" data-testid="rank-next">
        <p className="text-[15px] font-semibold text-foreground leading-tight">
          {p.salesToNext} more sale{p.salesToNext === 1 ? "" : "s"} unlock{p.salesToNext === 1 ? "s" : ""}
        </p>
        <div className="mt-0.5 flex items-baseline gap-2">
          <span className="text-[34px] font-bold tracking-tight text-emerald-400 tabular-nums leading-none" data-testid="rank-hero-gain">
            +{usd(p.gainAtNextCents!)}
          </span>
          <span className="inline-flex items-center gap-1 text-[12px] font-medium text-emerald-400/80">
            <Sparkles className="w-3.5 h-3.5" aria-hidden="true" /> more this week
          </span>
        </div>
        {/* current → next earnings */}
        <div className="mt-2 flex items-center gap-2 text-[13px] tabular-nums" data-testid="rank-earnings-jump">
          <span className="font-semibold text-muted-foreground">{usd(currentPayCents)}</span>
          <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
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

// The whole climb — every rung visible (Crypto.com stations / Grab criteria).
function RankRail({ p, className = "", secondary = false }: { p: NonNullable<ReturnType<typeof rankProgress>>; className?: string; secondary?: boolean }) {
  return (
    <div className={className}>
      {secondary && <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">The full ladder</p>}
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
                  {r.minimumSales}{r.maximumSales == null ? "+" : `–${r.maximumSales}`} sales
                  {isCurrent && <span className="sr-only"> — your current rank</span>}
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
  // Money state — real statement status, falling back to a live projection.
  const stateKey = (stmt?.status ?? (data.locked ? "FINALIZED" : "OPEN")) as string;
  const state = WEEK_STATE[stateKey] ?? WEEK_STATE.OPEN;
  // The rate a rep earns on their FIRST sale (never render "$0 per sale").
  const entryRateCents = isTiered ? (tiers[0]?.rateCents ?? 15000) : (structure?.flatRateCents ?? 0);

  return (
    <>
      {/* Week strip — this week's commission as a hairline-divided finance strip,
          with an ALWAYS-present money-state badge */}
      <div className="rounded-xl bg-card border border-border overflow-hidden">
        <div className="p-5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-primary uppercase tracking-wide">
              <Zap className="w-3.5 h-3.5" /> This week
            </div>
            <span className={`inline-flex items-center gap-1.5 text-2xs font-bold px-2 py-0.5 rounded-full ${state.cls}`} data-testid="week-state">
              {state.icon === "lock"
                ? <Lock className="w-2.5 h-2.5" />
                : state.icon === "check"
                  ? <CheckCircle2 className="w-2.5 h-2.5" />
                  : <span className="w-1 h-1 rounded-full bg-current" />}
              {state.label}
            </span>
          </div>
          <div className="mt-3 text-4xl font-semibold tracking-tight text-foreground tabular-nums" data-testid="text-week-commission">
            {usd(finalCents)}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {count === 0
              ? <>No qualified sales yet · starts at {usd(entryRateCents)} per sale</>
              : <>{count} qualified sale{count === 1 ? "" : "s"} · {usd(rateCents)} per sale{isTiered && comp?.tierLabel ? ` · ${comp.tierLabel}` : ""}</>}
          </div>
          {stateKey === "OPEN" && (
            <div className="mt-1 text-[11px] text-muted-foreground">This is a live projection — it can still change until the week closes Sunday night.</div>
          )}
          {/* THE number a rep is really asking for: what lands in their pocket
              after the tenant's chargeback reserve. Stated in the hero — not
              buried in the reserve card — whenever a holdback is configured.
              (Gusto/Stripe payout grammar: gross above, take-home called out.) */}
          {data.holdback?.current && data.holdback.current.reservePercent > 0 && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.08] px-3.5 py-2.5" data-testid="hero-net-pay">
              <span className="text-[13px] font-semibold text-foreground">You'll be paid</span>
              <span className="text-right">
                <span className="block text-[18px] font-bold tabular-nums text-emerald-400 leading-tight" data-testid="hero-net-pay-amount">{usd(data.holdback.current.netPayableCents)}</span>
                <span className="block text-[11px] text-muted-foreground tabular-nums">after {data.holdback.current.reservePercent}% reserve · −{usd(data.holdback.current.reserveCents)} held</span>
              </span>
            </div>
          )}
        </div>

        {/* Hairline-divided metric strip */}
        <div className="grid grid-cols-3 divide-x divide-border border-t border-border">
          <MetricCell label="Qualified" value={String(count)} />
          <MetricCell label="Per sale" value={usd(count === 0 ? entryRateCents : rateCents)} accent />
          <MetricCell label="Base pay" value={usd(grossCents)} />
        </div>

        {/* Adjustments — a deduction is NEVER an unexplained number */}
        {(data.adjustments?.length ?? 0) > 0 && (
          <div className="border-t border-border p-4 space-y-1.5" data-testid="hero-adjustments">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Base pay ({count} × {usd(rateCents || entryRateCents)})</span>
              <span className="tabular-nums text-foreground">{usd(grossCents)}</span>
            </div>
            {data.adjustments!.map(a => (
              <div key={a.id} className="flex items-start justify-between text-xs gap-3">
                <span className="text-muted-foreground min-w-0">
                  <span className={a.amount_cents < 0 ? "text-rose-400 font-semibold" : "text-emerald-400 font-semibold"}>{a.amount_cents < 0 ? "Deduction" : "Bonus"}</span>
                  {" — "}{a.reason}
                </span>
                <span className={`tabular-nums flex-shrink-0 ${a.amount_cents < 0 ? "text-rose-400" : "text-emerald-400"}`}>{a.amount_cents > 0 ? "+" : "−"}{usd(Math.abs(a.amount_cents))}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Why the week dropped MORE than one sale — the retroactive rule in
          reverse, said out loud. When a canceled deal pulls the count below a
          band boundary, every surviving sale reprices down too: losing the 7th
          on a 1-6 $175 / 7+ $225 ladder is not −$225, it is −$525. Without
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
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4" data-testid="band-drop-notice">
            <div className="flex items-center gap-2">
              <TrendingDown className="w-4 h-4 text-amber-400 shrink-0" />
              <span className="text-sm font-semibold text-foreground">Why this week dropped more than one sale</span>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {reversedCount === 1 ? "A canceled deal" : `${reversedCount} canceled deals`} pulled you out of the{" "}
              <span className="font-semibold text-foreground">{wouldBe.tierLabel}</span> band — tiers are retroactive,
              so your {count} remaining sale{count === 1 ? "" : "s"} repriced from {usd(wouldBe.rateCents)} to{" "}
              {usd(rateCents)} each. That's {usd(dropCents)} in total, not just the lost sale.
            </p>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Win it back: the week is still open — {retro?.salesUntilNextTier != null
                ? `${retro.salesUntilNextTier} more sale${retro.salesUntilNextTier === 1 ? "" : "s"} puts every door back at the higher rate.`
                : "another qualified sale can restore the band."}
            </p>
          </div>
        );
      })()}

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
        <div className="rounded-xl bg-card border border-emerald-500/30 p-4 flex items-center gap-3">
          <Trophy className="w-5 h-5 text-emerald-400 flex-shrink-0" />
          <span className="text-sm text-foreground">You're in the <strong>top tier</strong> this week — every sale pays {usd(rateCents)}.</span>
        </div>
      )}

      {/* Tier ladder or flat rate */}
      {isTiered ? (
        <div className="rounded-xl bg-card border border-border overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Layers className="w-4 h-4 text-muted-foreground" />
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
                      {t.minimumSales}{t.maximumSales == null ? "+" : `–${t.maximumSales}`} sales
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
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <DollarSign className="w-5 h-5 text-primary" />
          </div>
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
    },
    onError: (e: any) => toast({ title: "Couldn't accept plan", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="rounded-xl border border-primary/40 bg-primary/5 p-5" data-testid="accept-plan-card">
      <div className="flex items-center gap-2 mb-3">
        <FileSignature className="w-5 h-5 text-primary" />
        <span className="text-sm font-semibold tracking-tight text-foreground">Review &amp; accept your commission plan</span>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        This is how you're paid: <strong className="text-foreground">{structure.planName}</strong>.
        Weeks run Monday–Sunday in your org's timezone. Accepting freezes these exact terms to your file.
      </p>
      {structure.structure === "TIERED" ? (
        <div className="grid grid-cols-2 gap-2 mb-4">
          {structure.tiers.map((t, i) => (
            <div key={i} className="rounded-lg bg-card border border-border px-3 py-2 flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground leading-tight">
                {t.minimumSales}{t.maximumSales == null ? "+" : `–${t.maximumSales}`} sales
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
        // The example is derived from THIS rep's actual second band — it used
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
        className="w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-semibold py-2.5 rounded-xl transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        data-testid="btn-accept-plan"
      >
        <CheckCircle2 className="w-4 h-4" />
        {accept.isPending ? "Accepting…" : "I understand and accept this plan"}
      </button>
    </div>
  );
}



function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    OPEN: "bg-amber-500/15 text-amber-400",
    REVIEW: "bg-sky-500/15 text-sky-400",
    FINALIZED: "bg-primary/15 text-primary",
    PAID: "bg-emerald-500/15 text-emerald-400",
  };
  return (
    <span className={`inline-flex items-center gap-1 text-2xs font-semibold px-1.5 py-0.5 rounded-full ${map[status] || "bg-muted text-muted-foreground"}`}>
      <span className="w-1 h-1 rounded-full bg-current" />{status?.toLowerCase()}
    </span>
  );
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl bg-card border border-border p-8 text-center">
      <div className="w-12 h-12 rounded-xl bg-muted/60 border border-border flex items-center justify-center mx-auto mb-3">
        {icon}
      </div>
      <p className="text-sm font-semibold tracking-tight text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground mt-1.5 max-w-sm mx-auto leading-relaxed">{body}</p>
    </div>
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

  const { data: account } = useQuery<PayoutAccount>({
    queryKey: ["/api/payouts/account"],
    queryFn: () => apiRequest("GET", "/api/payouts/account").then(r => r.json()),
  });

  const connect = useMutation({
    mutationFn: () => apiRequest("POST", "/api/payouts/connect").then(r => r.json()),
    onSuccess: (res: { url?: string }) => {
      if (res?.url) { window.location.href = res.url; return; }
      toast({ title: "Couldn't start setup", description: "No onboarding link came back — try again in a moment.", variant: "destructive" });
    },
    onError: (e: any) => toast({ title: "Payouts aren't ready yet", description: e?.message ?? "Please try again shortly.", variant: "destructive" }),
  });

  // Feature dark until Stripe is configured server-side → render nothing extra.
  if (!account || !account.enabled) return null;

  const isReady = account.onboardingStatus === "enabled";
  const connectLabel =
    account.onboardingStatus === "restricted" ? "Reconnect payout account"
    : account.onboardingStatus === "pending" ? "Continue setup"
    : "Connect payout account";

  return (
    <section className="space-y-3" data-testid="get-paid">
      <div className="flex items-center gap-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Wallet className="w-3.5 h-3.5" /> Get paid
      </div>

      {isReady ? (
        <>
          {/* Payouts-ready confirmation — Turo "You're verified!" */}
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 flex items-center gap-3" data-testid="payouts-ready">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center flex-shrink-0">
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold tracking-tight text-foreground">Payouts ready</div>
              <div className="text-xs text-muted-foreground">Your commission goes straight to your connected bank.</div>
            </div>
            <ShieldCheck className="w-4 h-4 text-emerald-400/70 ml-auto flex-shrink-0" aria-hidden="true" />
          </div>

          {/* Payout history — Stripe Dashboard payments list */}
          <div className="rounded-xl bg-card border border-border overflow-hidden">
            <header className="px-4 py-3 border-b border-border flex items-center gap-2">
              <Landmark className="w-4 h-4 text-muted-foreground" />
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
            <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
              <Landmark className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold tracking-tight text-foreground">Set up payouts</div>
              <p className="text-xs text-muted-foreground mt-0.5">Connect your bank to receive commission payouts.</p>
            </div>
          </div>

          {account.onboardingStatus === "pending" && (
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-400" data-testid="payout-status-note">
              <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" aria-hidden="true" /> Verifying your details…
            </div>
          )}
          {account.onboardingStatus === "restricted" && (
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400" data-testid="payout-status-note">
              <XCircle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" /> Action needed — reconnect to finish verification.
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
              : <ArrowRight className="w-4 h-4" aria-hidden="true" />}
            {connect.isPending ? "Opening secure setup…" : connectLabel}
          </button>

          <div className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
            <Lock className="w-3 h-3" aria-hidden="true" /> Powered by Stripe · bank details handled securely
          </div>
        </div>
      )}
    </section>
  );
}

function PayoutRow({ item }: { item: PayoutHistoryItem }) {
  const s = PAYOUT_STATUS[item.status] ?? PAYOUT_STATUS.pending;
  const when = item.status === "paid" && item.paidAt ? item.paidAt : item.createdAt;
  const Icon = s.Icon;
  return (
    <div className="px-4 py-3 flex items-center gap-3" data-testid="payout-history-row">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${s.cls}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground tabular-nums">{usd(item.amountCents)}</div>
        <div className="text-[11px] text-muted-foreground tabular-nums truncate">
          {when
            ? new Date(when).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
            : "—"}
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
