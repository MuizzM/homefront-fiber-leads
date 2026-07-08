import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth";
import {
  Users, MapPin, Zap, TrendingUp, DollarSign, Clock,
  Activity, Target, Wifi, Calendar, ArrowUpRight, AlertCircle, Radar
} from "lucide-react";

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

  const today = new Date().toISOString().slice(0, 10);
  const todayHours = clockSessions
    .filter(s => s.date === today)
    .reduce((sum: number, s: any) => sum + (s.durationMinutes ?? 0), 0);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
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
            {stats.knocks.todaySales > 0 ? `🔥 ${stats.knocks.todaySales} sale${stats.knocks.todaySales !== 1 ? "s" : ""} today` : `${stats.knocks.today} door${stats.knocks.today !== 1 ? "s" : ""} today`}
          </Badge>
        )}
      </div>

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
