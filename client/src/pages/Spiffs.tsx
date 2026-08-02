// Spiffs — the sales-incentive recognition surface.
//
// A rep sees their own spiff feed ("$50 spiff — hot streak!"), a running total,
// and their live HEAT meter (the algorithm's read on how locked-in they are).
// A manager/admin sees the team HEAT leaderboard (the algorithm data) plus, for
// admins, the approve / mark-paid work queue. Spiffs are a recognition ledger
// tracked earned -> approved -> paid; nothing here is commission or payroll.
import { FOCUS } from "@/lib/a11y";
import { useQuery, useMutation } from "@tanstack/react-query";
import { PageHeader, StatStrip, StatTile, SectionLabel } from "@/components/ui/page-scaffold";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { useAuth } from "@/lib/auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Gift, Flame, TrendingUp, Award, Sparkles, CheckCheck, BadgeCheck } from "lucide-react";
import { spiffReasonLabel, spiffReasonBlurb, type PerfSnapshot } from "@shared/spiffEngine";

type SpiffReason = "random" | "streak" | "improvement" | "milestone";

interface SpiffRow {
  id: number; repId: number; saleRef: string | null; amountCents: number;
  reason: string; status: string; createdAt: string;
  approvedBy: number | null; approvedAt: string | null; paidAt: string | null;
}
interface MineResponse {
  spiffs: SpiffRow[]; heat: number; snapshot: PerfSnapshot | null;
  totals: { earnedCents: number; approvedCents: number; paidCents: number; count: number };
}
interface TeamHeatEntry {
  repId: number; name: string | null; role: string | null;
  heat: number; snapshot: PerfSnapshot;
  earnedCents: number; approvedCents: number; paidCents: number; spiffCount: number;
}
interface TeamResponse { reps: TeamHeatEntry[]; pending: (SpiffRow & { repName: string | null })[]; }

const usd = (cents: number) => `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

function reasonIcon(reason: string) {
  switch (reason) {
    case "streak": return Flame;
    case "improvement": return TrendingUp;
    case "milestone": return Award;
    default: return Sparkles;
  }
}

// Heat is the algorithm's 0..100 read on how locked-in a rep is. Warm tint the
// higher it climbs — never a bare colored number.
function heatTone(heat: number): string {
  if (heat >= 70) return "text-orange-400";
  if (heat >= 40) return "text-amber-400";
  if (heat >= 15) return "text-yellow-400";
  return "text-muted-foreground";
}

function HeatMeter({ heat, testId }: { heat: number; testId?: string }) {
  const pct = Math.max(0, Math.min(100, heat));
  return (
    <div className="flex items-center gap-2" data-testid={testId}>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary" role="meter"
           aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Heat score">
        <div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-500" style={{ width: `${pct}%` }} />
      </div>
      <span className={`w-9 shrink-0 text-right text-sm font-bold tabular-nums ${heatTone(pct)}`}>{pct}</span>
    </div>
  );
}

// ── Rep's own feed ────────────────────────────────────────────────────────────
function MySpiffs() {
  const { data, isLoading, isError } = useQuery<MineResponse>({
    queryKey: ["/api/spiffs/mine"],
    refetchInterval: 60_000,
  });

  const runningTotal = data ? data.totals.earnedCents + data.totals.approvedCents + data.totals.paidCents : 0;

  return (
    <section className="space-y-4" data-testid="my-spiffs">
      <StatStrip columns={3}>
        <StatTile label="Spiffs earned" accent testId="stat-total"
          value={isError ? "—" : usd(runningTotal)} icon={Gift} />
        <StatTile label="Awaiting payout" testId="stat-pending"
          value={isError ? "—" : usd((data?.totals.earnedCents ?? 0) + (data?.totals.approvedCents ?? 0))} />
        <StatTile label="Heat" testId="stat-heat"
          value={isError ? "—" : (data?.heat ?? 0)} icon={Flame} />
      </StatStrip>

      <Card>
        <CardContent className="p-4">
          <SectionLabel className="mb-2">Your heat</SectionLabel>
          <HeatMeter heat={data?.heat ?? 0} testId="my-heat" />
          <p className="mt-2 text-[13px] text-muted-foreground">
            The algorithm reads your streak, pace, and improvement. The hotter you run, the more spiffs it triggers.
          </p>
        </CardContent>
      </Card>

      <div>
        <SectionLabel className="mb-2">Recent spiffs</SectionLabel>
        {isLoading ? (
          <div className="space-y-2" data-testid="my-spiffs-loading">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-2xl" />)}
          </div>
        ) : !data || data.spiffs.length === 0 ? (
          <EmptyState icon={Gift} title="No spiffs yet"
            description="Log a sale and you're in the running for a $50 spiff — some land at random, more when you're heating up." />
        ) : (
          <ul className="space-y-2" data-testid="my-spiff-list">
            {data.spiffs.map((s) => {
              const Icon = reasonIcon(s.reason);
              return (
                <li key={s.id} data-testid={`spiff-${s.id}`}
                    className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-500/15 text-amber-400">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{usd(s.amountCents)} spiff</span>
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                        {spiffReasonLabel(s.reason as SpiffReason)}
                      </span>
                    </div>
                    <p className="truncate text-[13px] text-muted-foreground">{spiffReasonBlurb(s.reason as SpiffReason)}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold capitalize text-muted-foreground"
                        data-testid={`spiff-status-${s.id}`}>
                    {s.status}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

// ── Manager/admin: team heat + approve/paid queue ─────────────────────────────
function TeamHeat({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast();
  const { data, isLoading, isError } = useQuery<TeamResponse>({
    queryKey: ["/api/spiffs/team"],
    refetchInterval: 60_000,
  });

  const transition = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: "approve" | "paid" }) => {
      const res = await apiRequest("POST", `/api/spiffs/${id}/${action}`);
      return res.json();
    },
    onSuccess: (_row, { action }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/spiffs/team"] });
      toast({ title: action === "approve" ? "Spiff approved" : "Spiff marked paid" });
    },
    onError: (err: any) => toast({ title: "Couldn't update spiff", description: String(err?.message ?? err), variant: "destructive" }),
  });

  return (
    <section className="space-y-4" data-testid="team-heat">
      <div>
        <SectionLabel className="mb-2">Team heat — the algorithm's read</SectionLabel>
        {isLoading ? (
          <div className="space-y-2" data-testid="team-heat-loading">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full rounded-2xl" />)}
          </div>
        ) : isError || !data || data.reps.length === 0 ? (
          <EmptyState icon={Flame} title="No heat data yet" description="Rep heat appears here as sales come in." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-separate border-spacing-y-1.5 text-sm">
              <thead>
                <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-1">Rep</th>
                  <th className="px-3 py-1 w-40">Heat</th>
                  <th className="px-3 py-1 text-right">Streak</th>
                  <th className="px-3 py-1 text-right">Pace/day</th>
                  <th className="px-3 py-1 text-right">Recent</th>
                  <th className="px-3 py-1 text-right">Spiffs</th>
                </tr>
              </thead>
              <tbody>
                {data.reps.map((r) => (
                  <tr key={r.repId} className="bg-card" data-testid={`heat-row-${r.repId}`}>
                    <td className="rounded-l-xl px-3 py-2 font-medium text-foreground">{r.name ?? `Rep ${r.repId}`}</td>
                    <td className="px-3 py-2"><HeatMeter heat={r.heat} testId={`heat-meter-${r.repId}`} /></td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.snapshot.currentStreakDays}d</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.snapshot.salesVelocityPerDay.toFixed(1)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.snapshot.recentSalesCount}</td>
                    <td className="rounded-r-xl px-3 py-2 text-right tabular-nums font-semibold text-foreground">
                      {usd(r.earnedCents + r.approvedCents + r.paidCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {isAdmin && (
        <div>
          <SectionLabel className="mb-2">Approve &amp; pay</SectionLabel>
          {!data || data.pending.length === 0 ? (
            <EmptyState icon={CheckCheck} title="Nothing to approve" description="Earned spiffs land here for approval, then payout." />
          ) : (
            <ul className="space-y-2" data-testid="spiff-queue">
              {data.pending.map((s) => (
                <li key={s.id} data-testid={`queue-spiff-${s.id}`}
                    className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{usd(s.amountCents)}</span>
                      <span className="text-[13px] text-muted-foreground">{s.repName ?? `Rep ${s.repId}`}</span>
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                        {spiffReasonLabel(s.reason as SpiffReason)}
                      </span>
                    </div>
                    <span className="text-[11px] font-semibold capitalize text-muted-foreground">{s.status}</span>
                  </div>
                  {s.status === "earned" ? (
                    <button type="button" disabled={transition.isPending}
                      onClick={() => transition.mutate({ id: s.id, action: "approve" })}
                      data-testid={`approve-${s.id}`}
                      className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-50 ${FOCUS}`}>
                      <BadgeCheck className="h-4 w-4" aria-hidden="true" /> Approve
                    </button>
                  ) : (
                    <button type="button" disabled={transition.isPending}
                      onClick={() => transition.mutate({ id: s.id, action: "paid" })}
                      data-testid={`paid-${s.id}`}
                      className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-secondary px-3 text-sm font-semibold text-foreground disabled:opacity-50 ${FOCUS}`}>
                      <CheckCheck className="h-4 w-4" aria-hidden="true" /> Mark paid
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export default function Spiffs() {
  const { user } = useAuth();
  const role = user?.role;
  const isManager = role === "manager" || role === "admin" || role === "super_admin";
  const isAdmin = role === "admin" || role === "super_admin";

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 pt-5 pb-24 md:p-6">
      <PageHeader
        title="Spiffs"
        icon={Gift}
        subtitle="$50 recognition bonuses on sales — some random, more when you're locked in."
      />
      <MySpiffs />
      {isManager && <TeamHeat isAdmin={isAdmin} />}
    </div>
  );
}
