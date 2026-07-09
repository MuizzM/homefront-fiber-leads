import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  DollarSign, Target, Zap, Trophy, Info, Lock, Layers, CalendarDays,
} from "lucide-react";

// ── Rep-facing "My Commission this week" ──────────────────────────────────────
// Reads GET /api/commission/statements/me/current — the caller's own live week.
// Shows current earnings, the retroactive tier the week landed in, and the
// "close N more sales to re-price the whole week" nudge that makes tiers land.

function usd(cents: number | null | undefined): string {
  const n = (cents || 0) / 100;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: n % 1 === 0 ? 0 : 2 });
}

interface Tier { minimumSales: number; maximumSales: number | null; rateCents: number; label: string; }
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
  structure?: { structure: "FLAT" | "TIERED"; flatRateCents: number | null; tiers: Tier[]; planName: string } | null;
  noPlan?: boolean; noRepProfile?: boolean; locked?: boolean;
}

export default function MyCommission() {
  const { data, isLoading, isError } = useQuery<WeekResponse>({
    queryKey: ["/api/commission/statements/me/current"],
    queryFn: () => apiRequest("GET", "/api/commission/statements/me/current").then(r => r.json()),
  });

  const { data: history = [] } = useQuery<any[]>({
    queryKey: ["/api/commission/statements", "mine"],
    queryFn: () => apiRequest("GET", "/api/commission/statements").then(r => r.json()),
  });

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground">My Commission</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {data?.bounds?.localWeekLabel ? `Week of ${data.bounds.localWeekLabel}` : "This week's earnings"}
          </p>
        </div>
        <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
          <DollarSign className="w-5 h-5 text-primary" />
        </div>
      </div>

      {isLoading && (
        <div className="space-y-4">
          <div className="h-40 rounded-2xl bg-card border border-border animate-pulse" />
          <div className="h-24 rounded-2xl bg-card border border-border animate-pulse" />
        </div>
      )}

      {isError && (
        <div className="rounded-2xl bg-card border border-red-500/30 p-6 text-center text-sm text-muted-foreground">
          Couldn't load your commission right now. Pull to refresh in a moment.
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

      {!isLoading && data && !data.noPlan && !data.noRepProfile && (
        <WeekView data={data} />
      )}

      {/* Past weeks */}
      {history.length > 0 && (
        <div className="rounded-2xl bg-card border border-border overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">Past weeks</span>
          </div>
          <div className="divide-y divide-border">
            {history.slice(0, 8).map((s: any) => (
              <div key={s.id} className="px-4 py-3 flex items-center justify-between" data-testid={`row-week-${s.id}`}>
                <div>
                  <div className="text-sm text-foreground">{s.local_week_label}</div>
                  <div className="text-xs text-muted-foreground">
                    {s.qualified_sale_count} sale{s.qualified_sale_count === 1 ? "" : "s"} · {usd(s.rate_cents)}/sale
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold text-foreground">{usd(s.final_commission_cents)}</div>
                  <StatusPill status={s.status} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
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
  const adjustmentCents = comp?.adjustmentCents ?? stmt?.adjustment_cents ?? 0;
  const retro = comp?.retro ?? null;
  const isTiered = structure?.structure !== "FLAT";
  const tiers = structure?.tiers ?? [];

  return (
    <>
      {/* Hero — this week's commission */}
      <div className="rounded-2xl bg-gradient-to-br from-primary/15 to-primary/5 border border-primary/25 p-5">
        <div className="flex items-center gap-2 text-xs font-semibold text-primary uppercase tracking-wide">
          <Zap className="w-3.5 h-3.5" /> This week
          {data.locked && (
            <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground bg-secondary/60 border border-border px-2 py-0.5 rounded-full">
              <Lock className="w-2.5 h-2.5" /> Finalized
            </span>
          )}
        </div>
        <div className="mt-2 text-4xl font-bold text-foreground tabular-nums" data-testid="text-week-commission">
          {usd(finalCents)}
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          {count} qualified sale{count === 1 ? "" : "s"} · {usd(rateCents)} per sale
          {isTiered && comp?.tierLabel ? ` · ${comp.tierLabel}` : ""}
        </div>
        {adjustmentCents !== 0 && (
          <div className="mt-2 text-xs text-muted-foreground">
            Base {usd(grossCents)} {adjustmentCents > 0 ? "+" : "−"} {usd(Math.abs(adjustmentCents))} adjustment
          </div>
        )}
      </div>

      {/* Next-tier nudge (tiered only) */}
      {isTiered && retro && retro.salesUntilNextTier != null && retro.nextTierRateCents != null && retro.nextTierMinimumSales != null && (
        <div className="rounded-2xl bg-card border border-border p-5">
          <div className="flex items-center gap-2 mb-3">
            <Target className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold text-foreground">
              Close {retro.salesUntilNextTier} more to re-price your whole week
            </span>
          </div>
          <ProgressBar value={count} target={retro.nextTierMinimumSales} />
          <div className="mt-3 grid grid-cols-2 gap-3">
            <MiniStat label="Next rate" value={`${usd(retro.nextTierRateCents)}/sale`} accent />
            <MiniStat label="Projected at that tier" value={usd(retro.nextTierProjectedCommissionCents)} accent />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Tiers are <strong className="text-foreground">retroactive</strong> — hitting {retro.nextTierMinimumSales} sales pays
            {" "}{usd(retro.nextTierRateCents)} on <em>every</em> sale this week, not just the new ones.
          </p>
        </div>
      )}

      {isTiered && retro && retro.salesUntilNextTier == null && count > 0 && (
        <div className="rounded-2xl bg-card border border-emerald-500/30 p-4 flex items-center gap-3">
          <Trophy className="w-5 h-5 text-emerald-400 flex-shrink-0" />
          <span className="text-sm text-foreground">You're in the <strong>top tier</strong> this week — every sale pays {usd(rateCents)}. 🔥</span>
        </div>
      )}

      {/* Tier ladder or flat rate */}
      {isTiered ? (
        <div className="rounded-2xl bg-card border border-border overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Layers className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">Your tier ladder</span>
            {structure?.planName && <span className="ml-auto text-[10px] text-muted-foreground">{structure.planName}</span>}
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
        <div className="rounded-2xl bg-card border border-border p-5 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <DollarSign className="w-5 h-5 text-primary" />
          </div>
          <div>
            <div className="text-sm font-semibold text-foreground">Flat rate plan</div>
            <div className="text-xs text-muted-foreground">{usd(structure?.flatRateCents)} for every qualified sale.</div>
          </div>
        </div>
      )}
    </>
  );
}

function ProgressBar({ value, target }: { value: number; target: number }) {
  const pct = Math.max(0, Math.min(100, target > 0 ? (value / target) * 100 : 0));
  return (
    <div>
      <div className="flex justify-between text-xs text-muted-foreground mb-1.5">
        <span>{value} sales</span>
        <span>{target} to next tier</span>
      </div>
      <div className="h-2.5 rounded-full bg-secondary overflow-hidden">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl bg-secondary/40 border border-border px-3 py-2">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-bold tabular-nums ${accent ? "text-primary" : "text-foreground"}`}>{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    OPEN: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    REVIEW: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    FINALIZED: "bg-primary/15 text-primary border-primary/30",
    PAID: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  };
  return (
    <span className={`inline-block text-[9px] font-semibold border px-1.5 py-0.5 rounded-full mt-0.5 ${map[status] || "bg-secondary text-muted-foreground border-border"}`}>
      {status?.toLowerCase()}
    </span>
  );
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-2xl bg-card border border-border p-8 text-center">
      <div className="w-12 h-12 rounded-2xl bg-secondary/60 border border-border flex items-center justify-center mx-auto mb-3">
        {icon}
      </div>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground mt-1.5 max-w-sm mx-auto leading-relaxed">{body}</p>
    </div>
  );
}
