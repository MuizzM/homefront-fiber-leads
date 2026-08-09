import { FOCUS } from "@/lib/a11y";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { StatStrip, StatTile } from "@/components/ui/page-scaffold";
import { Trophy, DoorOpen, PhoneCall, CalendarCheck, Zap } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { useAuth } from "@/lib/auth";
import type { TeamMember } from "@shared/schema";

type RangeKey = "today" | "7d" | "30d" | "1y" | "all" | "custom";
const PRESETS: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d",    label: "7 days" },
  { key: "30d",   label: "30 days" },
  { key: "1y",    label: "1 year" },
  { key: "all",   label: "All time" },
];

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

  // Date-range filter (Steep-style preset segmented control + Vercel/Dropbox custom
  // From–To). Presets go through ?range=, custom through ?since=&until= — the full
  // URL is the query key so switching ranges refetches automatically.
  // Defaults to TODAY — a rep opening the board wants this shift's race, not
  // an all-time list frozen by whoever joined first. All-time is one tap away.
  const [range, setRange] = useState<RangeKey>("today");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");

  const params = new URLSearchParams();
  if (range === "custom") { if (since) params.set("since", since); if (until) params.set("until", until); }
  else if (range !== "all") params.set("range", range);
  const url = `/api/leaderboard${params.toString() ? `?${params}` : ""}`;

  const rangeLabel =
    range === "all"   ? "all time"
    : range === "today" ? "today"
    : range === "7d"  ? "the past 7 days"
    : range === "30d" ? "the past 30 days"
    : range === "1y"  ? "the past year"
    : (since || until) ? `${since || "start"} to ${until || "now"}`
    : "a custom range";

  const { data: board = [], isLoading, isError, refetch } = useQuery<LeaderboardEntry[]>({
    queryKey: [url],
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
    <div className="w-full max-w-6xl mx-auto p-4 pt-5 pb-24 space-y-5 md:p-6 md:space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2 text-foreground">
             Sales leaderboard
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Ranked by sales · <span className="text-foreground/80 font-medium">{rangeLabel}</span>
          </p>
          {/* The counting rule, stated where the numbers are (Strava's pattern:
              "manual activities will not count" sits right on the board). A rep
              whose sale vanished after a correction deserves to read why here,
              not to file a ticket about a broken leaderboard. */}
          <p className="text-[11px] text-muted-foreground/80 mt-0.5" data-testid="leaderboard-counting-rule">
            Only doors still marked sold count - corrected or reversed sales drop off automatically.
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

      {/* Date-range filter — preset segments + custom From–To */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter ranking by date range">
        <div className="no-scrollbar inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-xl border border-border bg-secondary/60 p-1 md:rounded-lg md:p-0.5">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setRange(p.key)}
              aria-pressed={range === p.key}
              data-testid={`range-${p.key}`}
              className={`whitespace-nowrap px-2.5 h-8 rounded-md text-xs font-semibold transition-colors ${FOCUS} ${
                range === p.key ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setRange("custom")}
            aria-pressed={range === "custom"}
            data-testid="range-custom"
            className={`whitespace-nowrap inline-flex items-center gap-1 px-2.5 h-8 rounded-md text-xs font-semibold transition-colors ${FOCUS} ${
              range === "custom" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
             Custom
          </button>
        </div>

        {range === "custom" && (
          <div className="inline-flex items-center gap-2 text-xs">
            <input
              type="date" value={since} max={until || undefined}
              onChange={(e) => setSince(e.target.value)}
              aria-label="From date" data-testid="range-since"
              className="h-8 px-2.5 rounded-lg bg-secondary border border-border text-foreground text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <span className="text-muted-foreground">to</span>
            <input
              type="date" value={until} min={since || undefined}
              onChange={(e) => setUntil(e.target.value)}
              aria-label="To date" data-testid="range-until"
              className="h-8 px-2.5 rounded-lg bg-secondary border border-border text-foreground text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
        )}
      </div>

      {/* Team totals — shared Revolut-grammar strip: eyebrow label above a
          tabular number, ONE accent tile (the number this screen is for).
          A failed or still-loading fetch must NEVER read as "0 sales" — the
          tiles show an honest em-dash until real numbers exist. */}
      <StatStrip columns={4}>
        <StatTile label="Team knocks" value={isLoading || isError ? " - " : totals.knocks} icon={DoorOpen} testId="stat-knocks" />
        <StatTile label="Contacts" value={isLoading || isError ? " - " : totals.contacts} icon={PhoneCall} testId="stat-contacts" />
        <StatTile label="Callbacks" value={isLoading || isError ? " - " : totals.callbacks} icon={CalendarCheck} testId="stat-callbacks" />
        <StatTile label="Team sales" value={isLoading || isError ? " - " : totals.sales} icon={Zap} accent testId="stat-sales" />
      </StatStrip>

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
        // Skeleton rows in the board's real shape — no layout shift when data lands.
        <Card className="bg-card border-border overflow-hidden" data-testid="leaderboard-loading">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex min-h-[64px] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 sm:gap-4">
              <Skeleton className="w-6 h-5" />
              <Skeleton className="w-9 h-9 rounded-full" />
              <div className="flex-1 min-w-0"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-16 mt-2" /></div>
              <Skeleton className="h-7 w-10" />
            </div>
          ))}
        </Card>
      ) : isError ? (
        <Card className="bg-card border-border">
          <CardContent className="py-12 text-center" data-testid="leaderboard-error">
            
            <div className="text-sm font-semibold text-foreground">Couldn't load the leaderboard</div>
            <div className="text-sm text-muted-foreground mt-1">Check your connection and try again.</div>
            <button onClick={() => refetch()}
              className={`mt-4 inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-secondary border border-border text-sm font-semibold text-foreground active:scale-95 transition-transform hover:bg-secondary/70 ${FOCUS}`}>
              Retry
            </button>
          </CardContent>
        </Card>
      ) : board.length === 0 ? (
        <Card className="bg-card border-border">
          <EmptyState
            testId="leaderboard-empty"
            icon={Trophy}
            title="No rankings yet"
            description="Add team members and start logging door knocks to see reps climb the board."
          />
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
                className={`render-lazy relative flex min-h-[64px] items-center gap-3 overflow-hidden border-b border-border px-4 py-3 transition-colors last:border-b-0 sm:gap-4 ${
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
                    {isMe && <span className="shrink-0 text-2xs font-bold uppercase tracking-wide text-primary bg-primary/15 rounded-full px-1.5 py-0.5">You</span>}
                  </div>
                  <div className="text-xs text-muted-foreground capitalize">{entry.rep.role}</div>
                </div>

                {/* Secondary metrics - muted, desktop only */}
                <div className="hidden md:flex items-center gap-6 flex-shrink-0">
                  <Metric icon={DoorOpen} val={entry.knocks} label="Knocks" />
                  <Metric icon={PhoneCall} val={entry.contacts} label="Contacts" />
                  <Metric icon={CalendarCheck} val={entry.callbacks} label="Callbacks" />
                  <Metric val={conversionRate(entry.contacts, entry.sales)} label="Conv." />
                </div>

                {/* Primary metric - sales, big + tabular */}
                <div className="text-right flex-shrink-0 min-w-[52px] pl-2 sm:pl-4">
                  <div className="text-xl font-bold tabular-nums text-emerald-400 leading-none">{entry.sales}</div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground mt-1">Sales</div>
                </div>

                {/* Sales share - thin hairline accent along the bottom edge */}
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
        {Icon && null}
        {val}
      </div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}
