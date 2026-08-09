import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth";
import { useTabActive } from "@/lib/tabActivity";
import { MapPin, Zap, TrendingUp, DollarSign, Clock, Activity, Target, Wifi, Calendar, AlertCircle, X, ChevronRight } from "lucide-react";
import { OUTCOME_META, isKnockOutcome } from "@shared/knock";
import { KpiTile } from "@/components/KpiTile";

// Only the fields the tiles below actually render — the endpoint stopped
// computing the rest (leads.total/sold, knocks.total, fieldHours) because
// nothing anywhere read them.
interface SaasStats {
  leads: { newFiber: number; unassigned: number };
  team: { total: number; activeClockedIn: number };
  knocks: { today: number; todaySales: number; weekSales: number };
  kinetic: { total: number; live: number };
  revenue: { totalPaid: number; pendingPayout: number };
}

interface ActivityEntry {
  id: number;
  userId: number | null;
  userName: string;
  action: string;
  entityType: string | null;
  entityId: number | null;
  details: any;
  at: string;
}

// Section eyebrow — one consistent label treatment across every zone.
const EYEBROW = "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

// Map a KPI's icon tone → a matching tint for its icon chip, so the metric
// bar reads as a coherent set rather than six loose colored glyphs.

// KPI metric bar — one hairline-divided grid (Cal.com / Intercom pattern)
// instead of eight competing cards. Each cell: a tinted micro-icon chip,
// eyebrow label, big tabular number, sub. Responsive 2→3→6 columns.
function MetricStrip({ items, loading }: {
  items: { label: string; value: string | number; sub?: string; icon: any; tone: string }[];
  loading?: boolean;
}) {
  return (
    <div
      className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3 xl:grid-cols-6"
      data-testid="metric-strip"
    >
      {items.map((m, i) => {
        return (
          <div key={i} className="bg-card px-4 py-3.5 transition-colors hover:bg-secondary/40">
            <div className="flex items-center gap-2">
              
              {/* Wrap, don't clip: at exactly 1280px (six columns, ~100px of
                  label box) `truncate` rendered "NEW FIBER LEA…" and "KINETIC
                  ADDRE…" — a metric whose NAME is cut off is an unlabeled
                  number. Two tight lines beat an ellipsis. */}
              <span className={`min-w-0 leading-tight ${EYEBROW}`}>{m.label}</span>
            </div>
            {loading
              ? <Skeleton className="mt-3 h-7 w-16" />
              : <div className="mt-2 text-[26px] font-bold leading-none tracking-tight tabular-nums text-foreground">{m.value}</div>}
            {m.sub && !loading && <div className="mt-1.5 text-[12px] text-muted-foreground">{m.sub}</div>}
          </div>
        );
      })}
    </div>
  );
}

function actionLabel(action: string) {
  const map: Record<string, string> = {
    "rep.clocked_in": "Clocked in",
    "rep.clocked_out": "Clocked out",
    "lead.created": "Lead created",
    "lead.assigned": "Lead assigned",
    "commission.created": "Commission logged",
    "commission.approved": "Commission approved",
    "commission.paid": "Commission paid",
    "territory.assigned": "Territory assigned",
  };
  return map[action] ?? action.replace(/\./g, " ");
}

// Tint the activity-feed avatar by event family so the log scans at a glance.

function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface LeadStats { total: number; byStatus: Record<string, number> }
interface LeaderRow {
  rep: { id: number; name: string; role: string };
  knocks: number; sales: number; knocksToday: number; salesToday: number;
}
interface FirstSeenLive {
  windowHours: number; count: number; confirmed: number; provisional: number; readyToAssign: number;
  addresses: { id: number; address: string; city: string; firstSeenLiveAt: string; leadId: number | null; confidence: "cross_verified" | "single_source_provisional" }[];
}
interface RepActivity {
  rep: { id: number; name: string; role: string };
  events: { id: number; outcome: string; at: string; address: string | null }[];
}

// Dashboard field tiles use the shared KPI card (fixed width for the thumb-scroll row).
function FieldTile(props: { label: string; value: number | string; tone: string; icon: any; chip: string; accent: string; loading?: boolean }) {
  // Fixed width inside the phone rail; full-width cell once the row becomes a grid.
  return <KpiTile {...props} className="w-[132px] md:w-auto" />;
}

// Tap-a-rep activity card: recent dispositions with the door + timestamp.
function RepActivityCard({ repId, onClose }: { repId: number; onClose: () => void }) {
  const { data } = useQuery<RepActivity>({
    queryKey: [`/api/team/${repId}/activity`],
    queryFn: () => apiRequest("GET", `/api/team/${repId}/activity`).then(r => r.json()),
    staleTime: 30_000,
  });
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center" role="dialog" aria-label="Rep activity">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative flex max-h-[75dvh] w-full flex-col rounded-t-[20px] border border-border bg-card md:max-w-md md:rounded-2xl"
        data-testid="rep-activity-card">
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 pb-3 pt-4">
          <div>
            <div className="text-[15px] font-bold text-foreground">{data?.rep.name ?? "…"}</div>
            <div className={EYEBROW}>Recent activity</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="-mr-2 flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto overscroll-contain px-5 py-3 space-y-2.5" style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}>
          {!data ? (
            <>
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
            </>
          ) : data.events.length === 0 ? (
            <div className="py-6 text-center text-sm italic text-muted-foreground">No activity yet - first door's the hardest.</div>
          ) : (
            data.events.map(e => {
              const meta = isKnockOutcome(e.outcome) ? OUTCOME_META[e.outcome] : null;
              return (
                <div key={e.id} className="flex min-w-0 gap-2.5">
                  {/* Fallback dot reads the muted-foreground token (a plain
                      slate hex ignored the light theme). */}
                  <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full" style={{ background: meta?.color ?? "hsl(var(--muted-foreground))" }} />
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[13px] font-medium text-foreground">{meta?.label ?? e.outcome}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {new Date(e.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </span>
                    </div>
                    {e.address && <div className="mt-0.5 truncate text-[12px] text-muted-foreground">{e.address}</div>}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  // Keep-alive: hidden dashboard stops polling; staleTime revalidates on return.
  const tabActive = useTabActive();
  const isRep = user?.role === "rep";
  const isManager = user?.role === "admin" || user?.role === "manager";

  const { data: stats, isLoading: statsLoading, isError: statsError, refetch: refetchStats } = useQuery<SaasStats>({
    queryKey: ["/api/stats/saas"],
    queryFn: () => apiRequest("GET", "/api/stats/saas").then(r => r.json()),
    refetchInterval: tabActive ? 30000 : false,
  });

  const { data: activity = [], isLoading: actLoading } = useQuery<ActivityEntry[]>({
    queryKey: ["/api/activity-log"],
    queryFn: () => apiRequest("GET", "/api/activity-log?limit=20").then(r => r.json()),
    enabled: isManager,
    refetchInterval: tabActive ? 15000 : false,
  });

  // Every render site below filters to s.date === today, so ask the server for
  // exactly that day - the unparameterized call downloaded the tenant's entire
  // clock history to show one day's rows, and grew forever.
  const sessionsDate = new Date().toISOString().slice(0, 10);
  const { data: clockSessions = [], isLoading: clockLoading } = useQuery<any[]>({
    queryKey: ["/api/clock/sessions", sessionsDate],
    queryFn: () => apiRequest("GET", `/api/clock/sessions?date=${sessionsDate}`).then(r => r.json()),
    enabled: isManager,
  });

  const canSeeTeam = isManager || user?.role === "team_lead";
  const [openRepId, setOpenRepId] = useState<number | null>(null);

  // Rep-scoped lead stats power the field tiles (assigned / dispositioned /
  // sold / follow-ups) — the byStatus map is O(statuses), not O(leads).
  const { data: leadStats, isLoading: leadStatsLoading, isError: leadStatsError } = useQuery<LeadStats>({
    queryKey: ["/api/stats"],
    queryFn: () => apiRequest("GET", "/api/stats").then(r => r.json()),
    staleTime: 30_000,
  });
  const { data: newFiber, isLoading: newFiberLoading, isError: newFiberError, refetch: refetchNewFiber } = useQuery<FirstSeenLive>({
    queryKey: ["/api/scan/first-seen-live"],
    queryFn: () => apiRequest("GET", "/api/scan/first-seen-live?hours=24").then(r => r.json()),
    enabled: isManager,
    staleTime: 60_000,
  });
  const { data: board = [], isLoading: boardLoading } = useQuery<LeaderRow[]>({
    queryKey: ["/api/leaderboard"],
    queryFn: () => apiRequest("GET", "/api/leaderboard").then(r => r.json()),
    enabled: canSeeTeam,
    staleTime: 30_000,
  });

  const statsFailed = statsError || leadStatsError;
  const assigned = statsFailed ? " - " : (leadStats?.total ?? 0);
  const dispositioned = typeof assigned === "number" ? assigned - (leadStats?.byStatus?.prospect ?? 0) : " - ";

  const today = new Date().toISOString().slice(0, 10);
  const todayHours = clockSessions
    .filter(s => s.date === today)
    .reduce((sum: number, s: any) => sum + (s.durationMinutes ?? 0), 0);

  const todaySessionCount = clockSessions.filter((s: any) => s.date === today).length;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 p-4 pt-5 pb-24 md:space-y-7 md:p-6 md:pb-10">
      {/* Header — time-aware, personalized greeting */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">
            {(() => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; })()}, {user?.name?.split(" ")[0] ?? "there"}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            {isRep ? " · Your field summary" : " · Team overview"}
          </p>
        </div>
        {stats && !isRep && (
          <Badge
            className={stats.team.activeClockedIn > 0
              ? "shrink-0 gap-1.5 border-emerald-500/25 bg-emerald-500/15 text-emerald-400"
              : "shrink-0 border-border bg-secondary text-muted-foreground"}
            data-testid="badge-clocked-in"
          >
            {stats.team.activeClockedIn > 0 && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />}
            {stats.team.activeClockedIn} rep{stats.team.activeClockedIn !== 1 ? "s" : ""} in field
          </Badge>
        )}
        {stats && isRep && (
          <Badge className="shrink-0 border-teal-500/30 bg-teal-500/20 text-teal-400">
            {stats.knocks.todaySales > 0 ? `${stats.knocks.todaySales} sale${stats.knocks.todaySales !== 1 ? "s" : ""} today` : `${stats.knocks.today} door${stats.knocks.today !== 1 ? "s" : ""} today`}
          </Badge>
        )}
      </div>

      {/* ── Field summary — thumb-scrollable tiles, the day at a glance ── */}
      <section className="space-y-2.5">
        <h2 className={EYEBROW}>{isRep ? "Your day" : "Today at a glance"}</h2>
        {/* A grid at every width - a glance row must show every number at
            once; a rail that clips "Sold" off the right edge hides the one
            figure the day is scored by. */}
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 lg:grid-cols-5"
          data-testid="field-tiles">
          <FieldTile label="Unassigned" value={stats?.leads.unassigned ?? " - "} loading={statsLoading && !stats} tone="text-amber-400" icon={AlertCircle} chip="bg-amber-500/15" accent="bg-amber-500" />
          <FieldTile label="Assigned" value={assigned} loading={leadStatsLoading && !leadStats} tone="text-foreground" icon={MapPin} chip="bg-secondary" accent="bg-muted-foreground/40" />
          <FieldTile label="Dispositioned" value={dispositioned} loading={leadStatsLoading && !leadStats} tone="text-sky-400" icon={Activity} chip="bg-sky-500/15" accent="bg-sky-500" />
          <FieldTile label="Sold" value={statsFailed ? " - " : (leadStats?.byStatus?.sold ?? 0)} loading={leadStatsLoading && !leadStats} tone="text-emerald-400" icon={DollarSign} chip="bg-emerald-500/15" accent="bg-emerald-500" />
          <FieldTile label="Follow-ups due" value={statsFailed ? " - " : (leadStats?.byStatus?.follow_up ?? 0)} loading={leadStatsLoading && !leadStats} tone="text-yellow-400" icon={Calendar} chip="bg-yellow-500/15" accent="bg-yellow-500" />
        </div>
      </section>

      {/* ── Team today — one row per rep; tap for their recent doors ── */}
      {canSeeTeam && (
        <section data-testid="rep-rows">
          <div className="mb-2 flex items-center justify-between">
            <h2 className={EYEBROW}>Team today</h2>
            {board.length > 0 && (
              <span className="text-[11px] tabular-nums text-muted-foreground">{board.length} rep{board.length !== 1 ? "s" : ""}</span>
            )}
          </div>
          {boardLoading && board.length === 0 ? (
            <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card" data-testid="rep-rows-skeleton">
              {[0, 1, 2].map(i => (
                <div key={i} className="flex h-14 items-center gap-3 px-4">
                  <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-2/5" />
                    <Skeleton className="h-2.5 w-1/4" />
                  </div>
                  <Skeleton className="h-3.5 w-8 shrink-0" />
                </div>
              ))}
            </div>
          ) : board.length === 0 ? (
            <div className="rounded-2xl border border-border bg-card px-4 py-5 text-[13px] italic text-muted-foreground">
              No team activity yet today.
            </div>
          ) : (
          <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
            {board.map(row => (
              <button
                key={row.rep.id}
                type="button"
                onClick={() => setOpenRepId(row.rep.id)}
                data-testid={`rep-row-${row.rep.id}`}
                className="group flex h-14 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-secondary/50 active:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[12px] font-bold text-primary">
                  {row.rep.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-foreground">{row.rep.name}</div>
                  <div className="text-[11px] text-muted-foreground">{row.knocksToday} dispositions today</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[15px] font-bold tabular-nums text-emerald-400">{row.salesToday}</div>
                  <div className="text-2xs text-muted-foreground">sold today</div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
              </button>
            ))}
          </div>
          )}
        </section>
      )}
      {openRepId != null && <RepActivityCard repId={openRepId} onClose={() => setOpenRepId(null)} />}

      {/* ── Fiber changes — every row carries explicit confirmation confidence ── */}
      {isManager && (
        <section data-testid="new-fiber-today">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className={EYEBROW}>Fiber changes · last 24h</h2>
            {newFiber && newFiber.count > 0 && (
              <span className="text-[11px] tabular-nums text-muted-foreground">{newFiber.confirmed} confirmed · {newFiber.provisional} provisional</span>
            )}
          </div>
          {newFiberError ? (
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3" data-testid="new-fiber-error">
              <span className="text-2xs text-muted-foreground">Couldn't load fiber changes.</span>
              <button type="button" onClick={() => refetchNewFiber()} className="text-2xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">
                Retry
              </button>
            </div>
          ) : (newFiberLoading && !newFiber) || !newFiber ? (
            <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card" data-testid="new-fiber-skeleton">
              {[0, 1, 2].map(i => (
                <div key={i} className="flex min-w-0 items-center gap-3 px-4 py-3">
                  <Skeleton className="h-2 w-2 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-2/3" />
                    <Skeleton className="h-2.5 w-2/5" />
                  </div>
                  <Skeleton className="h-[20px] w-20 shrink-0 rounded-full" />
                </div>
              ))}
            </div>
          ) : newFiber.count === 0 ? (
            <div className="rounded-2xl border border-border bg-card px-4 py-5 text-[13px] italic text-muted-foreground">
              No current fiber flips detected in the last 24 hours - the monitor is watching the address pool.
            </div>
          ) : (
            <div className="divide-y divide-border overflow-hidden rounded-2xl border border-orange-500/25 bg-card">
              {newFiber.addresses.slice(0, 5).map(a => (
                <a
                  key={a.id}
                  href={a.leadId ? `#/leads?id=${a.leadId}` : "#/city-scan"}
                  className="group flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/60 active:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  data-testid={`new-fiber-row-${a.id}`}
                >
                  <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-orange-400" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium text-foreground">{a.address}, {a.city}</div>
                    <div className="text-[11px] text-muted-foreground">
                      First observed live {new Date(a.firstSeenLiveAt.includes("T") ? a.firstSeenLiveAt : `${a.firstSeenLiveAt.replace(" ", "T")}Z`).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </div>
                  </div>
                  <span className={`h-[20px] shrink-0 rounded-full px-2 text-2xs font-bold uppercase leading-[20px] tracking-wide ${a.confidence === "cross_verified"
                    ? "bg-emerald-500/15 text-emerald-400" : "bg-orange-500/15 text-orange-400"}`}>
                    {a.confidence === "cross_verified" ? "Cross-verified" : "Provisional"}
                  </span>
                  <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
                </a>
              ))}
              {newFiber.count > 5 && (
                <div className="px-4 py-2 text-[11px] text-muted-foreground">+{newFiber.count - 5} more in the last 24h</div>
              )}
            </div>
          )}
        </section>
      )}

      {/* KPI metric bar - one clean hairline grid (Cal.com / Intercom), not eight cards */}
      <section className="space-y-2.5">
        <h2 className={EYEBROW}>{isManager ? "Performance overview" : "Overview"}</h2>
        {statsError ? (
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3" data-testid="stats-error">
            <span className="text-2xs text-muted-foreground">Couldn't load stats.</span>
            <button type="button" onClick={() => refetchStats()} className="text-2xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">
              Retry
            </button>
          </div>
        ) : (
        <MetricStrip
          loading={statsLoading}
          items={[
            { label: "New fiber leads", icon: Zap, tone: "text-primary",
              value: stats?.leads.newFiber ?? " - ", sub: `${stats?.leads.unassigned ?? 0} unassigned` },
            { label: "Knocks today", icon: Target, tone: "text-sky-400",
              value: stats?.knocks.today ?? " - ", sub: `${stats?.knocks.todaySales ?? 0} sales today` },
            { label: "Week sales", icon: TrendingUp, tone: "text-violet-400",
              value: stats?.knocks.weekSales ?? " - ", sub: "last 7 days" },
            { label: "Pending payout", icon: DollarSign, tone: "text-amber-400",
              value: stats ? `$${stats.revenue.pendingPayout.toFixed(0)}` : " - ", sub: `$${stats?.revenue.totalPaid.toFixed(0) ?? 0} paid` },
            { label: "Kinetic addresses", icon: Wifi, tone: "text-orange-400",
              value: stats?.kinetic.total ?? " - ", sub: `${stats?.kinetic.live ?? 0} live` },
            { label: "Field hours", icon: Clock, tone: "text-rose-400",
              value: isManager ? `${Math.floor(todayHours / 60)}h ${todayHours % 60}m` : " - ", sub: "clocked today" },
          ]}
        />
        )}
      </section>

      {/* Quick Actions — admin/manager only */}
      {isManager && (
        <section className="space-y-2.5">
          <h2 className={EYEBROW}>Quick actions</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <a href="#/city-scan" aria-label="City Scan - find new fiber" className="group relative flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/40 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              
              <div>
                <div className="text-sm font-semibold text-foreground">City Scan</div>
                <div className="text-xs text-muted-foreground">Find new fiber</div>
              </div>
              
            </a>
            <a href="#/leads" aria-label="Leads" className="group relative flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/40 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              
              <div>
                <div className="text-sm font-semibold text-foreground">Leads</div>
                <div className="text-xs text-muted-foreground">{stats?.leads.unassigned ?? 0} unassigned</div>
              </div>
              
            </a>
            <a href="#/team" aria-label="Team" className="group relative flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/40 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              
              <div>
                <div className="text-sm font-semibold text-foreground">Team</div>
                <div className="text-xs text-muted-foreground">{stats?.team.total ?? 0} reps</div>
              </div>
              
            </a>
            <a href="#/map" aria-label="Field Map" className="group relative flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-all hover:border-primary/40 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              
              <div>
                <div className="text-sm font-semibold text-foreground">Field Map</div>
                <div className="text-xs text-muted-foreground">{stats?.team.activeClockedIn ?? 0} active reps</div>
              </div>
              
            </a>
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Activity Feed */}
        {isManager && (
          <Card className="border-border bg-card">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-sm font-semibold text-foreground">
                <span className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2" aria-hidden="true">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                  </span>
                  Live Activity
                </span>
                {activity.length > 0 && <span className="text-[11px] font-medium tabular-nums text-muted-foreground">{activity.length}</span>}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {actLoading ? (
                <div className="space-y-3 px-4 pb-4">
                  {[1,2,3].map(i => <Skeleton key={i} className="h-12 bg-secondary" />)}
                </div>
              ) : activity.length === 0 ? (
                <div className="flex items-center gap-2 px-4 pb-4 text-sm text-muted-foreground">
                  
                  No recent activity
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {activity.map(entry => (
                    <div key={entry.id} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-secondary/50" data-testid={`activity-entry-${entry.id}`}>
                      
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-foreground">{entry.userName}</p>
                        <p className="text-xs text-muted-foreground">{actionLabel(entry.action)}</p>
                        {entry.details?.address && (
                          <p className="truncate text-xs text-muted-foreground">{entry.details.address}</p>
                        )}
                      </div>
                      <span className="flex-shrink-0 text-xs text-muted-foreground">{timeAgo(entry.at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Today's Clock Sessions */}
        {isManager && (
          <Card className="border-border bg-card">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-sm font-semibold text-foreground">
                <span className="flex items-center gap-2">
                  
                  Today's Field Activity
                </span>
                {todaySessionCount > 0 && <span className="text-[11px] font-medium tabular-nums text-muted-foreground">{todaySessionCount}</span>}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {clockLoading ? (
                <div className="divide-y divide-border" data-testid="clock-sessions-skeleton">
                  {[0, 1, 2].map(i => (
                    <div key={i} className="flex items-center justify-between px-4 py-3">
                      <div className="space-y-1.5">
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="h-3 w-40" />
                      </div>
                      <Skeleton className="h-[22px] w-16 rounded-full" />
                    </div>
                  ))}
                </div>
              ) : clockSessions.filter((s: any) => s.date === today).length === 0 ? (
                <div className="flex items-center gap-2 px-4 pb-4 text-muted-foreground">
                  
                  <p className="text-sm">No reps clocked in today</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {clockSessions.filter((s: any) => s.date === today).map((s: any) => (
                    <div key={s.id} className="flex items-center justify-between px-4 py-3 transition-colors hover:bg-secondary/40" data-testid={`clock-session-${s.id}`}>
                      <div>
                        <p className="text-sm font-medium text-foreground">{s.repName}</p>
                        <p className="text-xs text-muted-foreground">
                          In: {new Date(s.clockedIn).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                          {s.clockedOut ? ` · Out: ${new Date(s.clockedOut).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` : ""}
                        </p>
                      </div>
                      <div className="text-right">
                        {s.clockedOut ? (
                          <Badge className="border-border bg-secondary text-xs text-muted-foreground">
                            {Math.floor((s.durationMinutes ?? 0) / 60)}h {(s.durationMinutes ?? 0) % 60}m
                          </Badge>
                        ) : (
                          <Badge className="border-emerald-500/30 bg-emerald-500/20 text-xs text-emerald-400">
                            <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                            Active
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
