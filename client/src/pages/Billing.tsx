// ── Billing & Usage (admin) ───────────────────────────────────────────────────
// The tenant's "banking" surface: plan, billing state, lead-credit meter, plan
// catalog, and the credit ledger. Grounded in Rox/Replit/Vercel/OpenAI billing
// dashboards (Mobbin). Reads the same billingStore summary the metering path
// writes, so what a scan consumes shows up here.
//
// DARK-AWARE: when billing isn't provisioned the API returns enabled:false — the
// page shows an honest "not set up / unlimited internal access" state and still
// lists the plan catalog, rather than faking numbers.

import { useMemo, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { CreditCard, Zap, Infinity as InfinityIcon, TrendingUp, AlertTriangle, CheckCircle2, Clock, ArrowUpRight, ExternalLink } from "lucide-react";

type PlanKey = "starter" | "growth" | "professional" | "enterprise";
interface Plan {
  key: PlanKey; name: string; monthlyCredits: number | null; seats: number | null;
  features: string[]; monthlyPriceUsd: number | null; overagePerCreditUsd: number | null;
}
interface Summary {
  enabled: boolean; planKey: PlanKey | null; planName: string | null;
  state: "trial" | "active" | "past_due" | "suspended" | "canceled" | null;
  access: "full" | "paywall" | "blocked"; scanningAllowed: boolean; unlimited: boolean;
  creditsIncluded: number; creditsRemaining: number | null; creditsUsed: number;
  overageUsed: number; usagePct: number; level: "ok" | "warn" | "critical" | "exhausted";
  overageMode: "stop" | "allow_overage" | "auto_purchase" | "require_approval" | null;
  seatsPaid: number; trialEndsAt: string | null; cycleEnd: string | null;
}
interface LedgerEvent { id: number; delta: number; reason: string; leadId: number | null; overage: number; balanceAfter: number | null; actor: string | null; at: string }

const STATE_META: Record<NonNullable<Summary["state"]>, { label: string; cls: string; Icon: React.ElementType }> = {
  trial:     { label: "Trial",     cls: "bg-blue-500/15 text-blue-400",    Icon: Clock },
  active:    { label: "Active",    cls: "bg-emerald-500/15 text-emerald-400", Icon: CheckCircle2 },
  past_due:  { label: "Past due",  cls: "bg-amber-500/15 text-amber-400",  Icon: AlertTriangle },
  suspended: { label: "Suspended", cls: "bg-red-500/15 text-red-400",      Icon: AlertTriangle },
  canceled:  { label: "Canceled",  cls: "bg-muted text-muted-foreground",  Icon: AlertTriangle },
};
const LEVEL_BAR: Record<Summary["level"], string> = {
  ok: "bg-primary", warn: "bg-amber-500", critical: "bg-red-500", exhausted: "bg-red-500",
};
const REASON_LABEL: Record<string, string> = {
  lead_delivered: "Lead delivered", grant: "Credits granted", purchase: "Credits purchased",
  cycle_reset: "Cycle reset", adjustment: "Adjustment", state_change: "Status change", plan_change: "Plan change",
};

function fmtPrice(usd: number | null): string {
  return usd == null ? "Custom" : usd === 0 ? "Free" : `$${usd.toLocaleString()}/mo`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
function fmtWhen(iso: string): string {
  const d = new Date(iso.includes("T") || iso.includes("Z") ? iso : iso.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// One top stat tile (Rox billing-header pattern).
function StatTile({ label, value, sub, accent }: { label: string; value: React.ReactNode; sub?: React.ReactNode; accent?: boolean }) {
  return (
    <div className="rounded-xl bg-card border border-border px-4 py-3.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 text-[19px] font-semibold tracking-tight tabular-nums ${accent ? "text-primary" : "text-foreground"}`}>{value}</div>
      {sub != null && <div className="mt-0.5 text-[12px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

export default function Billing() {
  const { data: summary, isLoading, isError, refetch } = useQuery<Summary>({
    queryKey: ["/api/billing"],
    queryFn: () => apiRequest("GET", "/api/billing").then(r => r.json()),
    staleTime: 30_000,
  });
  const { data: plansResp } = useQuery<{ plans: Plan[] }>({
    queryKey: ["/api/billing/plans"],
    queryFn: () => apiRequest("GET", "/api/billing/plans").then(r => r.json()),
    staleTime: 300_000,
  });
  const enabled = !!summary?.enabled;
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: access } = useQuery<{ stripe: boolean }>({
    queryKey: ["/api/billing/access"],
    queryFn: () => apiRequest("GET", "/api/billing/access").then(r => r.json()),
    staleTime: 60_000,
  });
  const stripeOn = !!access?.stripe;
  const { data: ledgerResp } = useQuery<{ events: LedgerEvent[] }>({
    queryKey: ["/api/billing/ledger"],
    queryFn: () => apiRequest("GET", "/api/billing/ledger?limit=25").then(r => r.json()),
    enabled,
    staleTime: 30_000,
  });
  const plans = plansResp?.plans ?? [];
  const events = ledgerResp?.events ?? [];

  // Redirect the browser to a Stripe-hosted URL (checkout or billing portal).
  async function goTo(path: string, body: Record<string, unknown>) {
    try {
      const r = await apiRequest("POST", path, body);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Unavailable");
      window.location.href = j.url;
    } catch (e: any) {
      toast({ title: e.message || "Unavailable", variant: "destructive" });
    }
  }
  const startCheckout = (planKey: string) => goTo("/api/billing/checkout", { planKey });
  const openPortal = () => goTo("/api/billing/portal", {});

  // Handle the return from Stripe Checkout (#/billing?checkout=success|cancel).
  useEffect(() => {
    const q = new URLSearchParams((window.location.hash.split("?")[1]) || "");
    const c = q.get("checkout");
    if (c === "success") { toast({ title: "Subscription updated" }); qc.invalidateQueries({ queryKey: ["/api/billing"] }); }
    if (c) window.history.replaceState(null, "", "#/billing");
  }, [qc, toast]);

  const remainingLabel = useMemo(() => {
    if (!summary) return "—";
    if (summary.unlimited) return "Unlimited";
    return `${(summary.creditsRemaining ?? 0).toLocaleString()} left`;
  }, [summary]);

  return (
    <div className="max-w-5xl mx-auto w-full px-4 sm:px-6 py-5 space-y-5" data-testid="billing-page">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <CreditCard className="w-3.5 h-3.5" /> Billing &amp; Usage
          </div>
          <h1 className="mt-0.5 text-[22px] font-semibold tracking-tight text-foreground">Lead credits &amp; plan</h1>
        </div>
        {enabled && summary?.state && (
          <div className="flex items-center gap-2">
            {stripeOn && (
              <button onClick={openPortal} data-testid="manage-billing"
                className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full border border-border text-[12px] font-medium text-foreground hover:bg-secondary">
                <ExternalLink className="w-3.5 h-3.5" /> Manage billing
              </button>
            )}
            <span className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-[12px] font-medium ${STATE_META[summary.state].cls}`} data-testid="billing-state">
              {(() => { const I = STATE_META[summary.state!].Icon; return <I className="w-3.5 h-3.5" />; })()}
              {STATE_META[summary.state].label}
            </span>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : isError ? (
        // A failed fetch is NOT "billing isn't set up". Rendering NotProvisioned
        // here told admins "nothing is metered" during a network blip — the most
        // load-bearing false statement this page could make.
        <div className="rounded-xl bg-card border border-rose-500/30 p-6 text-center" role="alert" data-testid="billing-error">
          <div className="text-sm font-semibold text-foreground">Couldn't load billing</div>
          <div className="mt-1 text-sm text-muted-foreground">Your plan and credits are unchanged — this is a connection problem, not a billing state.</div>
          <button onClick={() => refetch()}
            className="mt-4 inline-flex items-center justify-center min-h-11 px-4 rounded-lg bg-secondary border border-border text-sm font-semibold text-foreground hover:bg-secondary/80">
            Retry
          </button>
        </div>
      ) : !enabled ? (
        <NotProvisioned plans={plans} />
      ) : summary ? (
        <>
          {/* Stat strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatTile label="Plan" value={summary.planName ?? "—"} sub={fmtPrice(plans.find(p => p.key === summary.planKey)?.monthlyPriceUsd ?? null)} />
            <StatTile label="Lead credits" value={summary.unlimited ? "∞" : summary.creditsUsed.toLocaleString()} sub={summary.unlimited ? "Unlimited" : `of ${summary.creditsIncluded.toLocaleString()} used`} accent />
            <StatTile label="Seats" value={summary.seatsPaid || "—"} sub="paid seats" />
            <StatTile label={summary.state === "trial" ? "Trial ends" : "Renews"} value={fmtDate(summary.state === "trial" ? summary.trialEndsAt : summary.cycleEnd)} />
          </div>

          {/* Credit meter (hero) */}
          <section className="rounded-xl bg-card border border-border overflow-hidden" data-testid="billing-meter">
            <div className="px-4 sm:px-5 py-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-primary" />
                  <h2 className="text-[15px] font-semibold tracking-tight text-foreground">This billing cycle</h2>
                </div>
                <div className="text-[13px] text-muted-foreground tabular-nums">{remainingLabel}</div>
              </div>

              {summary.unlimited ? (
                <div className="mt-4 flex items-center gap-2 text-[14px] text-foreground">
                  <InfinityIcon className="w-5 h-5 text-primary" />
                  Unlimited lead credits on {summary.planName}. {summary.creditsUsed.toLocaleString()} delivered this cycle.
                </div>
              ) : (
                <>
                  <div className="mt-3 flex items-end justify-between gap-2">
                    <div className="text-[26px] font-semibold tracking-tight text-foreground tabular-nums">
                      {summary.creditsUsed.toLocaleString()}
                      <span className="text-[15px] font-normal text-muted-foreground"> / {summary.creditsIncluded.toLocaleString()} credits</span>
                    </div>
                    <div className="text-[13px] tabular-nums text-muted-foreground">{summary.usagePct}%</div>
                  </div>
                  <div className="mt-2 h-2 w-full rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={summary.usagePct} aria-valuemin={0} aria-valuemax={100}>
                    <div className={`h-full rounded-full transition-all ${LEVEL_BAR[summary.level]}`} style={{ width: `${Math.min(100, summary.usagePct)}%` }} />
                  </div>
                  <div className="mt-2.5 flex items-center justify-between gap-2 flex-wrap text-[12px]">
                    <span className="text-muted-foreground">
                      A credit is consumed only when a qualified opportunity is delivered.
                    </span>
                    {summary.overageUsed > 0 && (
                      <span className="inline-flex items-center gap-1 text-amber-400 font-medium">
                        <TrendingUp className="w-3.5 h-3.5" /> {summary.overageUsed.toLocaleString()} in overage
                      </span>
                    )}
                  </div>
                  {(summary.level === "critical" || summary.level === "exhausted") && (
                    <div role="alert" className="mt-3 flex items-center gap-2 rounded-lg bg-red-500/10 text-red-400 px-3 py-2 text-[12.5px]">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      {summary.level === "exhausted"
                        ? (summary.overageMode === "stop"
                            ? "Credits exhausted — new lead delivery is paused until the cycle resets or you add credits."
                            : "Credits exhausted — new leads are billing as overage.")
                        : "You've used 90%+ of this cycle's credits."}
                    </div>
                  )}
                </>
              )}
            </div>
          </section>

          <PlanGrid plans={plans} current={summary.planKey} stripeOn={stripeOn} onChoose={startCheckout} />

          {/* Ledger */}
          <section className="rounded-xl bg-card border border-border overflow-hidden">
            <div className="px-4 sm:px-5 py-3.5 border-b border-border">
              <h2 className="text-[15px] font-semibold tracking-tight text-foreground">Credit activity</h2>
            </div>
            {events.length === 0 ? (
              <p className="px-4 sm:px-5 py-6 text-[13px] text-muted-foreground">No credit activity yet. Delivered qualified leads will appear here.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <th className="text-left font-semibold px-4 sm:px-5 py-2.5">When</th>
                      <th className="text-left font-semibold px-3 py-2.5">Event</th>
                      <th className="text-right font-semibold px-3 py-2.5">Change</th>
                      <th className="text-right font-semibold px-4 sm:px-5 py-2.5">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map(e => (
                      <tr key={e.id} className="border-t border-border/60" data-testid="ledger-row">
                        <td className="px-4 sm:px-5 py-2.5 text-muted-foreground whitespace-nowrap tabular-nums">{fmtWhen(e.at)}</td>
                        <td className="px-3 py-2.5 text-foreground">
                          {REASON_LABEL[e.reason] ?? e.reason}
                          {e.leadId != null && <span className="text-muted-foreground"> · #{e.leadId}</span>}
                          {!!e.overage && <span className="ml-1.5 inline-flex items-center h-4 px-1.5 rounded bg-amber-500/15 text-amber-400 text-2xs font-medium">overage</span>}
                        </td>
                        <td className={`px-3 py-2.5 text-right tabular-nums font-medium ${e.delta < 0 ? "text-foreground" : e.delta > 0 ? "text-emerald-400" : "text-muted-foreground"}`}>
                          {e.delta > 0 ? `+${e.delta}` : e.delta}
                        </td>
                        <td className="px-4 sm:px-5 py-2.5 text-right tabular-nums text-muted-foreground">{e.balanceAfter ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

// Plan catalog grid — current plan highlighted, prices show "Custom" until set.
// When Stripe is enabled, non-current paid plans get a checkout button.
function PlanGrid({ plans, current, stripeOn, onChoose }: { plans: Plan[]; current: PlanKey | null; stripeOn?: boolean; onChoose?: (planKey: string) => void }) {
  if (plans.length === 0) return null;
  return (
    <section data-testid="billing-plans">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Plans</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {plans.map(p => {
          const isCurrent = p.key === current;
          const isEnterprise = p.key === "enterprise";
          const canCheckout = !!stripeOn && !!onChoose && !isCurrent && !isEnterprise;
          return (
            <div key={p.key}
              className={`rounded-xl border p-4 flex flex-col ${isCurrent ? "border-primary bg-primary/[0.04]" : "border-border bg-card"}`}
              data-testid={`plan-${p.key}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[14px] font-semibold tracking-tight text-foreground">{p.name}</span>
                {isCurrent && <span className="inline-flex items-center h-5 px-2 rounded-full bg-primary text-primary-foreground text-2xs font-semibold uppercase tracking-wide">Current</span>}
              </div>
              <div className="mt-1.5 text-[17px] font-semibold tracking-tight text-foreground">{fmtPrice(p.monthlyPriceUsd)}</div>
              <div className="mt-2 text-[12.5px] text-muted-foreground tabular-nums">
                {p.monthlyCredits == null ? "Unlimited credits" : `${p.monthlyCredits.toLocaleString()} lead credits`}
                {" · "}
                {p.seats == null ? "Custom seats" : `${p.seats} seats`}
              </div>
              <ul className="mt-3 space-y-1 text-[12px] text-muted-foreground flex-1">
                {p.features.slice(0, 4).map(f => (
                  <li key={f} className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-primary/70 shrink-0" />
                    {f.replace(/_/g, " ")}
                  </li>
                ))}
                {p.features.length > 4 && <li className="text-muted-foreground/70">+{p.features.length - 4} more</li>}
              </ul>
              {canCheckout ? (
                <button onClick={() => onChoose!(p.key)} data-testid={`choose-${p.key}`}
                  className="mt-3 inline-flex items-center justify-center gap-1 h-8 rounded-lg bg-primary text-primary-foreground text-[12.5px] font-medium hover:bg-primary/90">
                  Choose {p.name} <ArrowUpRight className="w-3.5 h-3.5" />
                </button>
              ) : isEnterprise ? (
                <a href="mailto:sales@homefrontsolutionsllc.com?subject=Enterprise%20plan"
                  className="mt-3 inline-flex items-center justify-center h-8 rounded-lg border border-border text-[12.5px] font-medium text-foreground hover:bg-secondary">
                  Contact sales
                </a>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// Dark-by-default state: billing isn't provisioned for this org.
function NotProvisioned({ plans }: { plans: Plan[] }) {
  return (
    <div className="space-y-5">
      <section className="rounded-xl bg-card border border-border px-5 py-6 text-center" data-testid="billing-not-provisioned">
        <div className="mx-auto w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center">
          <InfinityIcon className="w-5 h-5 text-primary" />
        </div>
        <h2 className="mt-3 text-[16px] font-semibold tracking-tight text-foreground">Billing isn't set up for this workspace</h2>
        <p className="mt-1.5 text-[13px] text-muted-foreground max-w-md mx-auto">
          This org runs with unlimited internal access — lead delivery isn't metered and nothing is gated.
          When you're ready to put it on a plan, a platform admin provisions billing and credit metering turns on.
        </p>
      </section>
      <PlanGrid plans={plans} current={null} />
    </div>
  );
}
