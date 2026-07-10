import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth";
import {
  Users, MapPin, Zap, TrendingUp, DollarSign, Clock,
  Activity, Target, Wifi, Calendar, AlertCircle, Radar, X,
} from "lucide-react";
import { OUTCOME_META, isKnockOutcome } from "@shared/knock";

interface SaasStats {
  leads: { total: number; newFiber: number; sold: number; unassigned: number };
  team: { total: number; activeClockedIn: number };
  knocks: { total: number; today: number; todaySales: number; weekSales: number };
  comingSoon: { total: number; converted: number };
  revenue: { totalPaid: number; pendingPayout: number };
  fieldHours: { total: number };
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

// Soft tinted icon tiles keyed by semantic color — premium, theme-aware look.
const TILE: Record<string, string> = {
  teal:   "bg-primary/15 text-primary",
  blue:   "bg-blue-500/15 text-blue-400",
  purple: "bg-violet-500/15 text-violet-400",
  amber:  "bg-amber-500/15 text-amber-400",
  sky:    "bg-sky-500/15 text-sky-400",
  orange: "bg-orange-500/15 text-orange-400",
  rose:   "bg-rose-500/15 text-rose-400",
  slate:  "bg-muted text-muted-foreground",
};

function StatCard({
  title, value, sub, icon: Icon, accent, loading
}: {
  title: string; value: string | number; sub?: string;
  icon: any; accent: keyof typeof TILE; loading?: boolean;
}) {
  return (
    <Card
      className="bg-card border-border transition-all hover:border-primary/30 hover:shadow-lg hover:shadow-black/20 hover:-translate-y-0.5"
      data-testid={`stat-card-${title.toLowerCase().replace(/\s/g,"-")}`}
    >
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider font-semibold mb-1.5">{title}</p>
            {loading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <p className="text-2xl font-bold text-foreground tabular-nums">{value}</p>
            )}
            {sub && !loading && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
          </div>
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${TILE[accent]}`}>
            <Icon className="w-5 h-5" />
          </div>
        </div>
      </CardContent>
    </Card>
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
    "coming_soon.added": "Coming soon address added",
    "coming_soon.promoted": "Address promoted to lead",
    "territory.assigned": "Territory assigned",
  };
  return map[action] ?? action.replace(/\./g, " ");
}

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
  windowHours: number; count: number; readyToAssign: number;
  addresses: { id: number; address: string; city: string; firstSeenLiveAt: string; availabilityStatus: string; leadId: number | null }[];
}
interface RepActivity {
  rep: { id: number; name: string; role: string };
  events: { id: number; outcome: string; at: string; address: string | null }[];
}

// One horizontally-scrollable tile — number first, label under it.
function FieldTile({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <div className="shrink-0 w-[124px] rounded-2xl bg-card border border-border px-4 py-3.5"
      data-testid={`field-tile-${label.toLowerCase().replace(/\s/g, "-")}`}>
      <div className={`text-[22px] font-bold leading-none tabular-nums ${tone}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground font-medium mt-1.5">{label}</div>
    </div>
  );
}

// Tap-a-rep activity card: recent dispositions with the door + timestamp.
function RepActivityCard({ repId, onClose }: { repId: number; onClose: () => void }) {
  const { data } = useQuery<RepActivity>({
    queryKey: [`/api/team/${repId}/activity`],
    queryFn: () => apiRequest("GET", `/api/team/${repId}/activity`).then(r => r.json()),
    staleTime: 30_000,
  });
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center" role="dialog" aria-label="Rep activity">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full md:max-w-md max-h-[75dvh] rounded-t-[20px] md:rounded-2xl bg-card border border-border flex flex-col"
        data-testid="rep-activity-card">
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-border shrink-0">
          <div>
            <div className="text-[15px] font-bold text-foreground">{data?.rep.name ?? "…"}</div>
            <div className="text-[11px] text-muted-foreground uppercase tracking-wide">Recent activity</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="w-11 h-11 -mr-2 flex items-center justify-center text-muted-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="overflow-y-auto overscroll-contain px-5 py-3 space-y-2.5" style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}>
          {!data ? (
            <>
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
            </>
          ) : data.events.length === 0 ? (
            <div className="text-sm text-muted-foreground italic py-6 text-center">No activity yet — first door's the hardest.</div>
          ) : (
            data.events.map(e => {
              const meta = isKnockOutcome(e.outcome) ? OUTCOME_META[e.outcome] : null;
              return (
                <div key={e.id} className="flex gap-2.5 min-w-0">
                  <span className="w-2 h-2 rounded-full shrink-0 mt-[5px]" style={{ background: meta?.color ?? "#64748b" }} />
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[13px] font-medium text-foreground truncate">{meta?.label ?? e.outcome}</span>
                      <span className="text-[11px] text-muted-foreground shrink-0">
                        {new Date(e.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </span>
                    </div>
                    {e.address && <div className="text-[12px] text-muted-foreground truncate mt-0.5">{e.address}</div>}
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
  const isRep = user?.role === "rep";
  const isManager = user?.role === "admin" || user?.role === "manager";

  const { data: stats, isLoading: statsLoading } = useQuery<SaasStats>({
    queryKey: ["/api/stats/saas"],
    queryFn: () => apiRequest("GET", "/api/stats/saas").then(r => r.json()),
    refetchInterval: 30000,
  });

  const { data: activity = [], isLoading: actLoading } = useQuery<ActivityEntry[]>({
    queryKey: ["/api/activity-log"],
    queryFn: () => apiRequest("GET", "/api/activity-log?limit=20").then(r => r.json()),
    enabled: isManager,
    refetchInterval: 15000,
  });

  const { data: clockSessions = [] } = useQuery<any[]>({
    queryKey: ["/api/clock/sessions"],
    queryFn: () => apiRequest("GET", "/api/clock/sessions").then(r => r.json()),
    enabled: isManager,
  });

  const canSeeTeam = isManager || user?.role === "team_lead";
  const [openRepId, setOpenRepId] = useState<number | null>(null);

  // Rep-scoped lead stats power the field tiles (assigned / dispositioned /
  // sold / follow-ups) — the byStatus map is O(statuses), not O(leads).
  const { data: leadStats } = useQuery<LeadStats>({
    queryKey: ["/api/stats"],
    queryFn: () => apiRequest("GET", "/api/stats").then(r => r.json()),
    staleTime: 30_000,
  });
  const { data: newFiber } = useQuery<FirstSeenLive>({
    queryKey: ["/api/scan/first-seen-live"],
    queryFn: () => apiRequest("GET", "/api/scan/first-seen-live?hours=24").then(r => r.json()),
    enabled: isManager,
    staleTime: 60_000,
  });
  const { data: board = [] } = useQuery<LeaderRow[]>({
    queryKey: ["/api/leaderboard"],
    queryFn: () => apiRequest("GET", "/api/leaderboard").then(r => r.json()),
    enabled: canSeeTeam,
    staleTime: 30_000,
  });

  const assigned = leadStats?.total ?? 0;
  const dispositioned = assigned - (leadStats?.byStatus?.prospect ?? 0);

  const today = new Date().toISOString().slice(0, 10);
  const todayHours = clockSessions
    .filter(s => s.date === today)
    .reduce((sum: number, s: any) => sum + (s.durationMinutes ?? 0), 0);

  return (
    <div className="p-6 pb-10 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground">
            {isRep ? `Welcome back, ${user?.name?.split(" ")[0] ?? "Rep"}` : "Dashboard"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            {isRep && " · Your personal dashboard"}
          </p>
        </div>
        {stats && !isRep && (
          <Badge
            className={stats.team.activeClockedIn > 0
              ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
              : "bg-secondary text-muted-foreground border-border"}
            data-testid="badge-clocked-in"
          >
            {stats.team.activeClockedIn} reps in field
          </Badge>
        )}
        {stats && isRep && (
          <Badge className="bg-teal-500/20 text-teal-400 border-teal-500/30">
            {stats.knocks.todaySales > 0 ? `${stats.knocks.todaySales} sale${stats.knocks.todaySales !== 1 ? "s" : ""} today` : `${stats.knocks.today} door${stats.knocks.today !== 1 ? "s" : ""} today`}
          </Badge>
        )}
      </div>

      {/* ── Field summary — thumb-scrollable tiles, the day at a glance ── */}
      <div className="-mx-6 px-6 flex gap-2.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden pill-row-fade"
        data-testid="field-tiles">
        <FieldTile label="Knocks today" value={stats?.knocks.today ?? "—"} tone="text-foreground" />
        <FieldTile label="Assigned" value={assigned} tone="text-foreground" />
        <FieldTile label="Dispositioned" value={dispositioned} tone="text-sky-400" />
        <FieldTile label="Sold" value={leadStats?.byStatus?.sold ?? 0} tone="text-emerald-400" />
        <FieldTile label="Follow-ups due" value={leadStats?.byStatus?.follow_up ?? 0} tone="text-yellow-400" />
      </div>

      {/* ── Team today — one row per rep; tap for their recent doors ── */}
      {canSeeTeam && board.length > 0 && (
        <div data-testid="rep-rows">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Team today</div>
          <div className="rounded-2xl bg-card border border-border divide-y divide-border overflow-hidden">
            {board.map(row => (
              <button
                key={row.rep.id}
                type="button"
                onClick={() => setOpenRepId(row.rep.id)}
                data-testid={`rep-row-${row.rep.id}`}
                className="w-full h-14 px-4 flex items-center gap-3 text-left active:bg-secondary/60 transition-colors"
              >
                <div className="w-9 h-9 rounded-full bg-primary/15 text-primary flex items-center justify-center text-[12px] font-bold shrink-0">
                  {row.rep.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-medium text-foreground truncate">{row.rep.name}</div>
                  <div className="text-[11px] text-muted-foreground">{row.knocksToday} dispositions today</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[15px] font-bold text-emerald-400 tabular-nums">{row.salesToday}</div>
                  <div className="text-[10px] text-muted-foreground">sold today</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
      {openRepId != null && <RepActivityCard repId={openRepId} onClose={() => setOpenRepId(null)} />}

      {/* ── New Fiber Today — first-observed-by-HomeFront detections from the nightly scan ── */}
      {isManager && newFiber && (
        <div data-testid="new-fiber-today">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">New fiber · last 24h</span>
            {newFiber.count > 0 && (
              <span className="text-[11px] text-muted-foreground">{newFiber.readyToAssign} already leads</span>
            )}
          </div>
          {newFiber.count === 0 ? (
            <div className="rounded-2xl bg-card border border-border px-4 py-5 text-[13px] text-muted-foreground italic">
              No newly live fiber detected in the last 24 hours — the nightly scan is watching {""}
              the address pool.
            </div>
          ) : (
            <div className="rounded-2xl bg-card border border-orange-500/25 divide-y divide-border overflow-hidden">
              {newFiber.addresses.slice(0, 5).map(a => (
                <div key={a.id} className="px-4 py-3 flex items-center gap-3 min-w-0" data-testid={`new-fiber-row-${a.id}`}>
                  <span className="w-2 h-2 rounded-full shrink-0 bg-orange-400 animate-pulse" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium text-foreground truncate">{a.address}, {a.city}</div>
                    <div className="text-[11px] text-muted-foreground">
                      First observed live {new Date(a.firstSeenLiveAt.replace(" ", "T") + "Z").toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </div>
                  </div>
                  <span className={`shrink-0 h-[20px] px-2 rounded-full text-[10px] font-bold uppercase tracking-wide leading-[20px] ${a.leadId
                    ? "bg-emerald-500/15 text-emerald-400" : "bg-orange-500/15 text-orange-400"}`}>
                    {a.leadId ? "Lead created" : "Newly live"}
                  </span>
                </div>
              ))}
              {newFiber.count > 5 && (
                <div className="px-4 py-2 text-[11px] text-muted-foreground">+{newFiber.count - 5} more in the last 24h</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* KPI Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="New Fiber Leads" icon={Zap} accent="teal"
          value={stats?.leads.newFiber ?? "—"}
          sub={`${stats?.leads.unassigned ?? 0} unassigned`}
          loading={statsLoading}
        />
        <StatCard
          title="Knocks Today" icon={Target} accent="blue"
          value={stats?.knocks.today ?? "—"}
          sub={`${stats?.knocks.todaySales ?? 0} sales today`}
          loading={statsLoading}
        />
        <StatCard
          title="Week Sales" icon={TrendingUp} accent="purple"
          value={stats?.knocks.weekSales ?? "—"}
          sub="last 7 days"
          loading={statsLoading}
        />
        <StatCard
          title="Pending Payout" icon={DollarSign} accent="amber"
          value={stats ? `$${stats.revenue.pendingPayout.toFixed(0)}` : "—"}
          sub={`$${stats?.revenue.totalPaid.toFixed(0) ?? 0} paid total`}
          loading={statsLoading}
        />
      </div>

      {/* Second row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Active Reps" icon={Users} accent="slate"
          value={stats?.team.activeClockedIn ?? "—"}
          sub={`of ${stats?.team.total ?? 0} total reps`}
          loading={statsLoading}
        />
        <StatCard
          title="Total Leads" icon={MapPin} accent="sky"
          value={stats?.leads.total ?? "—"}
          sub={`${stats?.leads.sold ?? 0} sold`}
          loading={statsLoading}
        />
        <StatCard
          title="Coming Soon" icon={Wifi} accent="orange"
          value={stats?.comingSoon.total ?? "—"}
          sub={`${stats?.comingSoon.converted ?? 0} converted`}
          loading={statsLoading}
        />
        <StatCard
          title="Field Hours Today" icon={Clock} accent="rose"
          value={isManager ? `${Math.floor(todayHours / 60)}h ${todayHours % 60}m` : "—"}
          sub="total clocked time"
          loading={statsLoading}
        />
      </div>

      {/* Quick Actions — admin/manager only */}
      {isManager && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <a href="#/city-scan" className="group flex flex-col gap-2 rounded-xl border border-border bg-card p-4 hover:border-primary/50 hover:bg-secondary/50 transition-all">
            <Radar className="w-5 h-5 text-primary" />
            <div>
              <div className="text-sm font-semibold text-foreground">City Scan</div>
              <div className="text-xs text-muted-foreground">Find new fiber</div>
            </div>
          </a>
          <a href="#/leads" className="group flex flex-col gap-2 rounded-xl border border-border bg-card p-4 hover:border-primary/50 hover:bg-secondary/50 transition-all">
            <MapPin className="w-5 h-5 text-sky-400" />
            <div>
              <div className="text-sm font-semibold text-foreground">Leads</div>
              <div className="text-xs text-muted-foreground">{stats?.leads.unassigned ?? 0} unassigned</div>
            </div>
          </a>
          <a href="#/team" className="group flex flex-col gap-2 rounded-xl border border-border bg-card p-4 hover:border-primary/50 hover:bg-secondary/50 transition-all">
            <Users className="w-5 h-5 text-purple-400" />
            <div>
              <div className="text-sm font-semibold text-foreground">Team</div>
              <div className="text-xs text-muted-foreground">{stats?.team.total ?? 0} reps</div>
            </div>
          </a>
          <a href="#/map" className="group flex flex-col gap-2 rounded-xl border border-border bg-card p-4 hover:border-primary/50 hover:bg-secondary/50 transition-all">
            <Activity className="w-5 h-5 text-amber-400" />
            <div>
              <div className="text-sm font-semibold text-foreground">Field Map</div>
              <div className="text-xs text-muted-foreground">{stats?.team.activeClockedIn ?? 0} active reps</div>
            </div>
          </a>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Activity Feed */}
        {isManager && (
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" />
                Live Activity
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {actLoading ? (
                <div className="px-4 pb-4 space-y-3">
                  {[1,2,3].map(i => <Skeleton key={i} className="h-12 bg-secondary" />)}
                </div>
              ) : activity.length === 0 ? (
                <p className="text-sm text-muted-foreground px-4 pb-4">No recent activity</p>
              ) : (
                <div className="divide-y divide-border">
                  {activity.map(entry => (
                    <div key={entry.id} className="px-4 py-3 flex items-start gap-3 hover:bg-secondary/50 transition-colors" data-testid={`activity-entry-${entry.id}`}>
                      <div className="w-7 h-7 rounded-full bg-secondary flex items-center justify-center flex-shrink-0 mt-0.5">
                        <Activity className="w-3 h-3 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-foreground font-medium">{entry.userName}</p>
                        <p className="text-xs text-muted-foreground">{actionLabel(entry.action)}</p>
                        {entry.details?.address && (
                          <p className="text-xs text-muted-foreground truncate">{entry.details.address}</p>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground flex-shrink-0">{timeAgo(entry.at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Today's Clock Sessions */}
        {isManager && (
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Calendar className="w-4 h-4 text-primary" />
                Today's Field Activity
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {clockSessions.filter((s: any) => s.date === today).length === 0 ? (
                <div className="px-4 pb-4 flex items-center gap-2 text-muted-foreground">
                  <AlertCircle className="w-4 h-4" />
                  <p className="text-sm">No reps clocked in today</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {clockSessions.filter((s: any) => s.date === today).map((s: any) => (
                    <div key={s.id} className="px-4 py-3 flex items-center justify-between" data-testid={`clock-session-${s.id}`}>
                      <div>
                        <p className="text-sm text-foreground font-medium">{s.repName}</p>
                        <p className="text-xs text-muted-foreground">
                          In: {new Date(s.clockedIn).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                          {s.clockedOut ? ` · Out: ${new Date(s.clockedOut).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` : ""}
                        </p>
                      </div>
                      <div className="text-right">
                        {s.clockedOut ? (
                          <Badge className="bg-secondary text-muted-foreground border-border text-xs">
                            {Math.floor((s.durationMinutes ?? 0) / 60)}h {(s.durationMinutes ?? 0) % 60}m
                          </Badge>
                        ) : (
                          <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block mr-1 animate-pulse" />
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
