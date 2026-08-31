import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth";
import { useTabActive } from "@/lib/tabActivity";
import { ChevronRight } from "lucide-react";
import { OUTCOME_META, isKnockOutcome, todayISO } from "@shared/knock";
import { KpiTile } from "@/components/KpiTile";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { leadsFilterHandoff } from "@/lib/leadsFilterHandoff";
import { openLeadOnFieldMap } from "@/lib/leadMapNavigation";

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

// One inline error+retry row, so a failed section says "load failed, here's a
// real button" instead of masquerading as an empty state — with a 44px Retry
// (the bare text-2xs links it replaces were well under the tap floor).
function RetryRow({ message, onRetry, testId }: { message: string; onRetry: () => void; testId?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3" data-testid={testId}>
      <span className="text-[13px] text-muted-foreground">{message}</span>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onRetry}>Retry</Button>
    </div>
  );
}

// Map a KPI's icon tone → a matching tint for its icon chip, so the metric
// bar reads as a coherent set rather than six loose colored glyphs.

// KPI metric bar — one hairline-divided grid (Cal.com / Intercom pattern)
// instead of eight competing cards. Each cell: a tinted micro-icon chip,
// eyebrow label, big tabular number, sub. Responsive 2→3→6 columns.
function MetricStrip({ items, loading }: {
  // No `icon`/`tone`: the strip renders a label, a number and a sub-line. Both
  // props were left behind when the icons came out, so the six colours the call
  // site was passing (sky/violet/amber/orange/rose -400) reached no element -
  // dead weight that still had to be read and kept plausible on every edit.
  items: { label: string; value: string | number; sub?: string }[];
  loading?: boolean;
}) {
  // The column count follows the item count: the rep-shaped strip has 4
  // items, and the fixed 2/3/6 grid painted its empty tracks as solid
  // border-colored slabs beside the real tiles from sm up. Static classes
  // only - Tailwind cannot see a computed grid-cols-{n}.
  const cols =
    items.length === 4
      ? "grid-cols-2 xl:grid-cols-4"
      : "grid-cols-2 sm:grid-cols-3 xl:grid-cols-6";
  return (
    <div
      className={`grid gap-px overflow-hidden rounded-xl border border-border bg-border ${cols}`}
      data-testid="metric-strip"
    >
      {items.map((m, i) => {
        return (
          <div key={i} className="bg-card px-4 py-3.5">
            <div className="flex items-center gap-2">
              
              {/* Wrap, don't clip: at exactly 1280px (six columns, ~100px of
                  label box) `truncate` rendered "NEW FIBER LEA…" and "KINETIC
                  ADDRE…" — a metric whose NAME is cut off is an unlabeled
                  number. Two tight lines beat an ellipsis. */}
              <span className={`min-w-0 leading-tight ${EYEBROW}`}>{m.label}</span>
            </div>
            {loading
              ? <Skeleton className="mt-3 h-7 w-16" />
              : <div className="mt-2 text-[26px] font-bold leading-none tracking-tight tabular-nums text-foreground">{typeof m.value === "number" ? m.value.toLocaleString("en-US") : m.value}</div>}
            {m.sub && !loading && <div className="mt-1.5 text-[12px] text-muted-foreground">{m.sub}</div>}
          </div>
        );
      })}
    </div>
  );
}

export function actionLabel(action: string) {
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
  const fallback = action.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!fallback) return "Activity";
  return map[action] ?? `${fallback.charAt(0).toUpperCase()}${fallback.slice(1)}`;
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
  addresses: { id: number; address: string; city: string; state: string; lat: number; lng: number; firstSeenLiveAt: string; leadId: number | null; confidence: "cross_verified" | "single_source_provisional" }[];
}
interface RepActivity {
  rep: { id: number; name: string; role: string };
  events: { id: number; outcome: string; at: string; leadId: number | null; address: string | null; lat: number | null; lng: number | null }[];
}


// Tap-a-rep activity card: recent dispositions with the door + timestamp.
// Bottom sheet of a rep's recent doors. Radix-based Sheet (focus trap, Escape,
// scroll lock, safe-area padding, the keep-alive portal guard) instead of a
// hand-rolled fixed-inset overlay.
function RepActivitySheet({ repId, onClose }: { repId: number | null; onClose: () => void }) {
  const [, navigate] = useLocation();
  const { data, isError, refetch, isFetching } = useQuery<RepActivity>({
    queryKey: [`/api/team/${repId}/activity`],
    queryFn: () => apiRequest("GET", `/api/team/${repId}/activity`).then(r => r.json()),
    enabled: repId != null,
    staleTime: 30_000,
  });
  return (
    <Sheet open={repId != null} onOpenChange={open => !open && onClose()}>
      <SheetContent side="bottom" className="max-h-[75dvh] p-0" data-testid="rep-activity-card">
        <SheetHeader className="border-b border-border px-5 pb-3 pt-4 text-left">
          <SheetTitle className="text-[15px] font-bold text-foreground">{data?.rep.name ?? "Recent activity"}</SheetTitle>
          <SheetDescription className={EYEBROW}>Recent activity</SheetDescription>
        </SheetHeader>
        <div className="overflow-y-auto overscroll-contain px-5 py-3 space-y-1" style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}>
          {isError ? (
            <div className="flex items-center justify-between gap-3 py-4">
              <span className="text-[13px] text-muted-foreground">Couldn't load activity.</span>
              <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>Retry</Button>
            </div>
          ) : !data ? (
            <>
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-2/3" />
            </>
          ) : data.events.length === 0 ? (
            <div className="py-6 text-center text-sm italic text-muted-foreground">No activity yet - first door's the hardest.</div>
          ) : (
            data.events.map(e => {
              const meta = isKnockOutcome(e.outcome) ? OUTCOME_META[e.outcome] : null;
              // Each door is tappable: a manager checking a rep's activity jumps
              // straight to that door on the map. Falls back to a static row when
              // the event carries no lead id.
              const inner = (
                <>
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
                </>
              );
              return e.leadId != null ? (
                <button key={e.id} type="button"
                  onClick={() => { onClose(); openLeadOnFieldMap({ leadId: e.leadId!, lat: e.lat ?? undefined, lng: e.lng ?? undefined }, navigate); }}
                  className="flex min-h-tap w-full min-w-0 items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-secondary/50 active:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  {inner}
                </button>
              ) : (
                <div key={e.id} className="flex min-w-0 items-start gap-2.5 px-2 py-2">{inner}</div>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  // Keep-alive: hidden dashboard stops polling; staleTime revalidates on return.
  const tabActive = useTabActive();
  const isRep = user?.role === "rep";
  const isManager = user?.role === "admin" || user?.role === "manager";

  const { data: stats, isLoading: statsLoading, isError: statsError, refetch: refetchStats } = useQuery<SaasStats>({
    queryKey: ["/api/stats/saas"],
    queryFn: () => apiRequest("GET", "/api/stats/saas").then(r => r.json()),
    refetchInterval: tabActive ? 30000 : false,
  });

  const { data: activity = [], isLoading: actLoading, isError: actError, refetch: refetchActivity } = useQuery<ActivityEntry[]>({
    queryKey: ["/api/activity-log"],
    queryFn: () => apiRequest("GET", "/api/activity-log?limit=20").then(r => r.json()),
    enabled: isManager,
    refetchInterval: tabActive ? 15000 : false,
  });

  // Every render site below filters to s.date === today, so ask the server for
  // exactly that day - the unparameterized call downloaded the tenant's entire
  // clock history to show one day's rows, and grew forever.
  // LOCAL day, not the UTC slice: toISOString rolls to "tomorrow" at 5-7pm
  // across the US, so every evening this card queried the wrong day and
  // "Field hours today" zeroed out while reps were still clocked in - the
  // exact contradiction the header badge then disputed. Today.tsx and
  // FollowUps already use the shared local todayISO for the same reason, and
  // the server now stamps session.date with the org-local day to match.
  const sessionsDate = todayISO();
  const { data: clockSessions = [], isLoading: clockLoading, isError: clockError, refetch: refetchClock } = useQuery<any[]>({
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
  const { data: board = [], isLoading: boardLoading, isError: boardError, refetch: refetchBoard } = useQuery<LeaderRow[]>({
    queryKey: ["/api/leaderboard"],
    queryFn: () => apiRequest("GET", "/api/leaderboard").then(r => r.json()),
    enabled: canSeeTeam,
    staleTime: 30_000,
  });

  const statsFailed = statsError || leadStatsError;
  const assigned = statsFailed ? " - " : (leadStats?.total ?? 0);
  const dispositioned = typeof assigned === "number" ? assigned - (leadStats?.byStatus?.prospect ?? 0) : " - ";

  const today = sessionsDate;
  const todayHours = clockSessions
    .filter(s => s.date === today)
    .reduce((sum: number, s: any) => sum + (s.durationMinutes ?? 0), 0);

  const todaySessionCount = clockSessions.filter((s: any) => s.date === today).length;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 p-4 pt-5 pb-24 md:space-y-7 md:p-6 md:pb-10">
      {/* Header — time-aware, personalized greeting */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-balance text-xl font-bold tracking-tight text-foreground">
            {(() => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; })()}, {user?.name?.split(" ")[0] ?? "there"}
          </h1>
          <p className="mt-0.5 text-pretty text-sm text-muted-foreground">
            {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            {isRep ? " · Your field summary" : " · Team overview"}
          </p>
        </div>
        {stats && !isRep && (
          <Badge
            className={stats.team.activeClockedIn > 0
              ? "shrink-0 gap-1.5 border-success/25 bg-success/10 text-success"
              : "shrink-0 border-border bg-secondary text-muted-foreground"}
            data-testid="badge-clocked-in"
          >
            {stats.team.activeClockedIn > 0 && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-success" />}
            {stats.team.activeClockedIn} rep{stats.team.activeClockedIn !== 1 ? "s" : ""} in field
          </Badge>
        )}
        {stats && isRep && (
          <Badge className="shrink-0 border-primary/25 bg-primary/10 text-primary">
            {stats.knocks.todaySales > 0 ? `${stats.knocks.todaySales} sale${stats.knocks.todaySales !== 1 ? "s" : ""} today` : `${stats.knocks.today} door${stats.knocks.today !== 1 ? "s" : ""} today`}
          </Badge>
        )}
      </div>

      {/* ── Field summary — thumb-scrollable tiles, the day at a glance ── */}
      <section className="space-y-2.5">
        <h2 className={EYEBROW}>{isRep ? "Your day" : "Today at a glance"}</h2>
        {/* A grid at every width - a glance row must show every number at
            once; a rail that clips "Sold" off the right edge hides the one
            figure the day is scored by.

            The tiles LINK: a rep seeing "Follow-ups: 3" gets a tap path to
            those follow-ups instead of a dead stat beside the nav bar.

            Reps do not get "Unassigned": their lead scope is assigned_rep_id IN
            (self), which can never match NULL, so the tile read a permanent 0
            about manager inventory. They get "Doors today" (their own knocks,
            already fetched rep-scoped) instead. */}
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 lg:grid-cols-5"
          data-testid="field-tiles">
          {/* Clean "#/leads" href (a query in the hash 404s this router on hard
              reload); the target status rides sessionStorage, applied by Leads. */}
          {isRep
            ? <KpiTile label="Doors today" value={stats?.knocks.today ?? " - "} loading={statsLoading && !stats} tone="neutral" />
            : <KpiTile label="Unassigned" value={stats?.leads.unassigned ?? " - "} loading={statsLoading && !stats} tone="neutral" href="#/leads" onClick={() => leadsFilterHandoff("all")} />}
          <KpiTile label="Assigned" value={assigned} loading={leadStatsLoading && !leadStats} tone="primary" href="#/leads" onClick={() => leadsFilterHandoff("all")} />
          <KpiTile label="Dispositioned" value={dispositioned} loading={leadStatsLoading && !leadStats} tone="info" />
          <KpiTile label="Sold" value={statsFailed ? " - " : (leadStats?.byStatus?.sold ?? 0)} loading={leadStatsLoading && !leadStats} tone="success" href="#/leads" onClick={() => leadsFilterHandoff("sold")} />
          {/* Spans the base grid's last row so a five-tile glance doesn't strand
              an orphan half-cell on phones; one cell again from md up. */}
          {/* "Follow-ups", not "Follow-ups due": this counts DOORS in the
              follow-up status (what the linked list shows), while a scheduled
              appointment for tomorrow is not yet owed — Today's badge counts
              the actually-due ones from /api/followups. The label must match
              the number it fronts. */}
          <KpiTile label="Follow-ups" value={statsFailed ? " - " : (leadStats?.byStatus?.follow_up ?? 0)} loading={leadStatsLoading && !leadStats} tone="warning" href="#/leads" onClick={() => leadsFilterHandoff("follow_up")} className="col-span-2 md:col-span-1" />
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
          ) : boardError ? (
            // A failed fetch must not read as an idle team: say it failed, and
            // give a real 44px Retry rather than a false "No team activity".
            <RetryRow message="Couldn't load team activity." onRetry={() => refetchBoard()} />
          ) : board.length === 0 ? (
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-4">
              <span className="text-[13px] italic text-muted-foreground">No team activity yet today.</span>
              <Button asChild variant="ghost" size="sm" className="shrink-0 text-primary">
                <a href="#/map">Open field map</a>
              </Button>
            </div>
          ) : (
          <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
            {/* Today's section sorts by today's work, not lifetime rank, so the
                reps actually out knocking float above the idle ones instead of
                the whole roster reading as identical zero rows. */}
            {[...board].sort((a, b) => (b.salesToday - a.salesToday) || (b.knocksToday - a.knocksToday)).map(row => {
              const idle = row.knocksToday === 0 && row.salesToday === 0;
              return (
              <button
                key={row.rep.id}
                type="button"
                onClick={() => setOpenRepId(row.rep.id)}
                data-testid={`rep-row-${row.rep.id}`}
                className="group flex h-14 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-secondary/50 active:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12px] font-bold ${idle ? "bg-secondary text-muted-foreground" : "bg-primary/15 text-primary"}`}>
                  {row.rep.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-foreground">{row.rep.name}</div>
                  <div className="text-[11px] text-muted-foreground">{idle ? "No doors yet today" : `${row.knocksToday} disposition${row.knocksToday !== 1 ? "s" : ""} today`}</div>
                </div>
                {!idle && (
                  <div className="shrink-0 text-right">
                    {/* Green is for a win, so a rep on nothing yet does not get
                        a celebratory zero - and emerald-400 was 1.9:1 on the
                        light card besides. */}
                    <div className={`text-[15px] font-bold tabular-nums ${row.salesToday > 0 ? "text-success" : "text-muted-foreground"}`}>{row.salesToday}</div>
                    <div className="text-2xs text-muted-foreground">sold today</div>
                  </div>
                )}
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
              </button>
              );
            })}
          </div>
          )}
        </section>
      )}
      <RepActivitySheet repId={openRepId} onClose={() => setOpenRepId(null)} />

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
            <RetryRow message="Couldn't load fiber changes." onRetry={() => refetchNewFiber()} testId="new-fiber-error" />
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
            <div className="divide-y divide-border overflow-hidden rounded-2xl border border-warning/15 bg-card">
              {newFiber.addresses.slice(0, 5).map(a => {
                const rowClass = "group flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/60 active:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
                const contents = <>
                  <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-warning" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium text-foreground">{a.address}, {a.city}</div>
                    <div className="text-[11px] text-muted-foreground">
                      First observed live {new Date(a.firstSeenLiveAt.includes("T") ? a.firstSeenLiveAt : `${a.firstSeenLiveAt.replace(" ", "T")}Z`).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </div>
                  </div>
                  <span className={`h-[20px] shrink-0 rounded-full px-2 text-2xs font-bold uppercase leading-[20px] tracking-wide ${a.confidence === "cross_verified"
                    ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}>
                    {a.confidence === "cross_verified" ? "Cross-verified" : "Provisional"}
                  </span>
                  <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
                </>;
                return a.leadId != null ? (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => openLeadOnFieldMap({ leadId: a.leadId!, lat: a.lat, lng: a.lng }, navigate)}
                    className={rowClass}
                    aria-label={`Open ${a.address}, ${a.city} on the Field Map`}
                    data-testid={`new-fiber-row-${a.id}`}
                  >
                    {contents}
                  </button>
                ) : (
                  <Link key={a.id} href="/fiber" className={rowClass} data-testid={`new-fiber-row-${a.id}`}>
                    {contents}
                  </Link>
                );
              })}
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
          <RetryRow message="Couldn't load stats." onRetry={() => refetchStats()} testId="stats-error" />
        ) : (
        <MetricStrip
          loading={statsLoading}
          // Role-shaped: reps used to see a permanently dead "Field hours: -"
          // cell (its clock query is manager-only) plus manager inventory
          // (Kinetic addresses, unassigned counts) as noise on their main
          // screen. A rep's overview is the four numbers their week is scored
          // by; the strip's grid collapses 2-to-3-to-6 either way.
          items={isRep ? [
            { label: "Knocks today", value: stats?.knocks.today ?? " - ", sub: `${stats?.knocks.todaySales ?? 0} sales today` },
            { label: "Week sales", value: stats?.knocks.weekSales ?? " - ", sub: "last 7 days" },
            { label: "Pending payout", value: stats ? `$${Math.round(stats.revenue.pendingPayout).toLocaleString("en-US")}` : " - ", sub: `$${Math.round(stats?.revenue.totalPaid ?? 0).toLocaleString("en-US")} paid` },
            { label: "New fiber leads", value: stats?.leads.newFiber ?? " - ", sub: "fresh doors to work" },
          ] : [
            { label: "New fiber leads", value: stats?.leads.newFiber ?? " - ", sub: `${(stats?.leads.unassigned ?? 0).toLocaleString("en-US")} unassigned` },
            { label: "Knocks today", value: stats?.knocks.today ?? " - ", sub: `${stats?.knocks.todaySales ?? 0} sales today` },
            { label: "Week sales", value: stats?.knocks.weekSales ?? " - ", sub: "last 7 days" },
            { label: "Pending payout", value: stats ? `$${Math.round(stats.revenue.pendingPayout).toLocaleString("en-US")}` : " - ", sub: `$${Math.round(stats?.revenue.totalPaid ?? 0).toLocaleString("en-US")} paid` },
            { label: "Kinetic addresses", value: stats?.kinetic.total ?? " - ", sub: `${stats?.kinetic.live ?? 0} live` },
            { label: "Field hours", value: `${Math.floor(todayHours / 60)}h ${todayHours % 60}m`, sub: "clocked today" },
          ]}
        />
        )}
      </section>

      {/* Quick Actions — admin/manager only */}
      {isManager && (
        <section className="space-y-2.5">
          <h2 className={EYEBROW}>Quick actions</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <a href="#/fiber" aria-label="Fiber tools - scans and new fiber" className="group relative flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-secondary/40 active:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              
              <div>
                <div className="text-sm font-semibold text-foreground">Fiber tools</div>
                <div className="text-xs text-muted-foreground">Find new fiber</div>
              </div>
              
            </a>
            <a href="#/leads" aria-label="Leads" className="group relative flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-secondary/40 active:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              
              <div>
                <div className="text-sm font-semibold text-foreground">Leads</div>
                <div className="text-xs text-muted-foreground">{stats?.leads.unassigned ?? 0} unassigned</div>
              </div>
              
            </a>
            <a href="#/team" aria-label="Team" className="group relative flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-secondary/40 active:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              
              <div>
                <div className="text-sm font-semibold text-foreground">Team</div>
                <div className="text-xs text-muted-foreground">{stats?.team.total ?? 0} reps</div>
              </div>
              
            </a>
            <a href="#/map" aria-label="Field Map" className="group relative flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-secondary/40 active:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              
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
              ) : actError ? (
                /* An outage must never read as an idle team - the exact
                   empty-vs-error masquerade the other cards on this page
                   already distinguish. */
                <div className="px-4 pb-4">
                  <RetryRow message="Couldn't load activity." onRetry={() => refetchActivity()} testId="activity-error" />
                </div>
              ) : activity.length === 0 ? (
                <div className="flex items-center gap-2 px-4 pb-4 text-sm text-muted-foreground">
                  
                  No recent activity
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {activity.map(entry => (
                    <div key={entry.id} className="flex items-start gap-3 px-4 py-3" data-testid={`activity-entry-${entry.id}`}>
                      
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
              ) : clockError ? (
                <div className="px-4 pb-4"><RetryRow message="Couldn't load field activity." onRetry={() => refetchClock()} /></div>
              ) : clockSessions.filter((s: any) => s.date === today).length === 0 ? (
                <div className="flex items-center gap-2 px-4 pb-4 text-muted-foreground">
                  <p className="text-sm">No reps clocked in today</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {clockSessions.filter((s: any) => s.date === today).map((s: any) => (
                    <div key={s.id} className="flex items-center justify-between px-4 py-3" data-testid={`clock-session-${s.id}`}>
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
                          <Badge className="border-success/25 bg-success/[0.12] text-xs text-success">
                            <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
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
