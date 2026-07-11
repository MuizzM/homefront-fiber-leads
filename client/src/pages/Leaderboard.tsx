import { useQuery } from "@tanstack/react-query";
import { Trophy, DoorOpen, PhoneCall, CalendarCheck, Zap, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import type { TeamMember } from "@shared/schema";

type LeaderboardEntry = {
  rep: TeamMember;
  knocks: number;
  contacts: number;
  callbacks: number;
  sales: number;
};

const RANK_COLORS = [
  "text-yellow-400",   // 1st
  "text-slate-300",    // 2nd
  "text-amber-600",    // 3rd
];

function conversionRate(contacts: number, sales: number) {
  if (contacts === 0) return "0%";
  return `${Math.round((sales / contacts) * 100)}%`;
}

export default function Leaderboard() {
  const { user } = useAuth();
  const { data: board = [], isLoading, isError, refetch } = useQuery<LeaderboardEntry[]>({
    queryKey: ["/api/leaderboard"],
    refetchInterval: 30000, // refresh every 30s
  });

  // The signed-in rep's own row — powers the tinted self-row + rank summary
  // (Duolingo/Deezer leaderboard pattern: you always find yourself instantly).
  const myIdx = board.findIndex(e => e.rep.id === user?.teamMemberId);
  const me = myIdx >= 0 ? board[myIdx] : null;

  const totals = board.reduce(
    (acc, e) => ({
      knocks: acc.knocks + e.knocks,
      contacts: acc.contacts + e.contacts,
      callbacks: acc.callbacks + e.callbacks,
      sales: acc.sales + e.sales,
    }),
    { knocks: 0, contacts: 0, callbacks: 0, sales: 0 }
  );

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2 text-foreground">
            <Trophy className="w-5 h-5 text-muted-foreground" /> Sales Leaderboard
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Rep performance, ranked by sales
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 pt-1" aria-label="Live, updates every 30 seconds">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
          </span>
          <span className="text-[11px] uppercase tracking-wide font-medium text-primary">Live</span>
        </div>
      </div>

      {/* Team totals — hairline metric strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px rounded-xl overflow-hidden border border-border bg-border">
        {[
          { label: "Total Knocks", val: totals.knocks, icon: DoorOpen, accent: false },
          { label: "Contacts Made", val: totals.contacts, icon: PhoneCall, accent: false },
          { label: "Callbacks", val: totals.callbacks, icon: CalendarCheck, accent: false },
          { label: "Total Sales", val: totals.sales, icon: Zap, accent: true },
        ].map(({ label, val, icon: Icon, accent }) => (
          <div key={label} className="bg-card px-4 py-3">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              <Icon className="w-3.5 h-3.5" />
              {label}
            </div>
            <div className={`text-2xl font-bold tabular-nums mt-1 ${accent ? "text-emerald-400" : "text-foreground"}`}>
              {val}
            </div>
          </div>
        ))}
      </div>

      {/* Your rank — pinned summary so a rep never scrolls to find themselves */}
      {me && !isLoading && !isError && (
        <div className="flex items-center gap-3 rounded-xl border border-primary/25 bg-primary/[0.07] px-4 py-3" data-testid="leaderboard-me">
          <div className="w-9 h-9 rounded-full bg-primary/15 text-primary flex items-center justify-center text-sm font-bold flex-shrink-0">
            {me.rep.name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-foreground">Your rank</div>
            <div className="text-xs text-muted-foreground">#{myIdx + 1} of {board.length} · {me.knocks} knocks · {conversionRate(me.contacts, me.sales)} conv.</div>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-xl font-bold tabular-nums text-emerald-400 leading-none">{me.sales}</div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground mt-1">Sales</div>
          </div>
        </div>
      )}

      {/* Rankings */}
      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Loading leaderboard...</div>
      ) : isError ? (
        <Card className="bg-card border-border">
          <CardContent className="py-12 text-center" data-testid="leaderboard-error">
            <Trophy className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-30" />
            <div className="text-sm font-semibold text-foreground">Couldn't load the leaderboard</div>
            <div className="text-sm text-muted-foreground mt-1">Check your connection and try again.</div>
            <button onClick={() => refetch()}
              className="mt-4 inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-secondary border border-border text-sm font-semibold text-foreground">
              <RefreshCw className="w-4 h-4" />Retry
            </button>
          </CardContent>
        </Card>
      ) : board.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="py-12 text-center">
            <Trophy className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-30" />
            <div className="text-sm text-muted-foreground">
              No reps yet. Add team members and start logging door knocks to see rankings.
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="bg-card border-border overflow-hidden">
          {board.map((entry, idx) => {
            const rankCls = RANK_COLORS[idx] ?? "text-muted-foreground";
            const teamPct = totals.sales > 0 ? (entry.sales / totals.sales) * 100 : 0;
            const isManager = entry.rep.role === "manager";
            const isMe = entry.rep.id === user?.teamMemberId;

            return (
              <div
                key={entry.rep.id}
                data-testid={`row-rep-${entry.rep.id}`}
                className={`relative flex items-center gap-3 sm:gap-4 px-4 py-3 border-b border-border last:border-b-0 transition-colors overflow-hidden ${
                  isMe ? "bg-primary/[0.08]" : "hover:bg-muted/40"
                }`}
              >
                {/* Rank */}
                <div className="w-6 flex-shrink-0 text-center">
                  <span className={`text-base font-bold tabular-nums ${rankCls}`}>{idx + 1}</span>
                </div>

                {/* Avatar */}
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 ${
                  isMe
                    ? "bg-primary/15 text-primary"
                    : isManager
                      ? "bg-amber-500/15 text-amber-400"
                      : "bg-secondary text-foreground"
                }`}>
                  {entry.rep.name.charAt(0).toUpperCase()}
                </div>

                {/* Name + role */}
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm text-foreground truncate flex items-center gap-1.5" title={entry.rep.name}>
                    <span className="truncate">{entry.rep.name}</span>
                    {isMe && <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-primary bg-primary/15 rounded-full px-1.5 py-0.5">You</span>}
                  </div>
                  <div className="text-xs text-muted-foreground capitalize">{entry.rep.role}</div>
                </div>

                {/* Secondary metrics — muted, desktop only */}
                <div className="hidden md:flex items-center gap-6 flex-shrink-0">
                  <Metric icon={DoorOpen} val={entry.knocks} label="Knocks" />
                  <Metric icon={PhoneCall} val={entry.contacts} label="Contacts" />
                  <Metric icon={CalendarCheck} val={entry.callbacks} label="Callbacks" />
                  <Metric val={conversionRate(entry.contacts, entry.sales)} label="Conv." />
                </div>

                {/* Primary metric — sales, big + tabular */}
                <div className="text-right flex-shrink-0 min-w-[52px] pl-2 sm:pl-4">
                  <div className="text-xl font-bold tabular-nums text-emerald-400 leading-none">{entry.sales}</div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground mt-1">Sales</div>
                </div>

                {/* Sales share — thin hairline accent along the bottom edge */}
                {totals.sales > 0 && (
                  <div
                    className="absolute bottom-0 left-0 h-0.5 bg-emerald-400/40"
                    style={{ width: `${teamPct}%` }}
                    aria-hidden="true"
                  />
                )}
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

function Metric({
  icon: Icon, val, label
}: {
  icon?: React.ElementType; val: React.ReactNode; label: string;
}) {
  return (
    <div className="flex flex-col items-end min-w-[44px]">
      <div className="flex items-center gap-1 text-sm font-semibold tabular-nums text-foreground">
        {Icon && <Icon className="w-3.5 h-3.5 text-muted-foreground" />}
        {val}
      </div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}
