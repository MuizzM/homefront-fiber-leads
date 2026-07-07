import { useQuery } from "@tanstack/react-query";
import { Trophy, DoorOpen, PhoneCall, CalendarCheck, Zap, Medal } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  "text-slate-400",    // 2nd
  "text-amber-600",    // 3rd
];

const RANK_BG = [
  "bg-yellow-400/10 border-yellow-400/30",
  "bg-slate-400/10 border-slate-400/30",
  "bg-amber-600/10 border-amber-600/30",
];

const MEDALS = ["🥇", "🥈", "🥉"];

function conversionRate(contacts: number, sales: number) {
  if (contacts === 0) return "0%";
  return `${Math.round((sales / contacts) * 100)}%`;
}

export default function Leaderboard() {
  const { data: board = [], isLoading } = useQuery<LeaderboardEntry[]>({
    queryKey: ["/api/leaderboard"],
    refetchInterval: 30000, // refresh every 30s
  });

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
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Trophy className="w-5 h-5 text-yellow-400" /> Sales Leaderboard
        </h1>
        <p className="text-sm text-muted-foreground mt-1">Live rep performance — ranked by sales</p>
      </div>

      {/* Team totals */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Total Knocks", val: totals.knocks, icon: DoorOpen, color: "text-primary" },
          { label: "Contacts Made", val: totals.contacts, icon: PhoneCall, color: "text-blue-400" },
          { label: "Callbacks", val: totals.callbacks, icon: CalendarCheck, color: "text-amber-400" },
          { label: "Total Sales", val: totals.sales, icon: Zap, color: "text-green-400" },
        ].map(({ label, val, icon: Icon, color }) => (
          <Card key={label} className="bg-card border-border">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <Icon className={`w-4 h-4 ${color}`} />
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
              <div className={`text-2xl font-bold ${color}`}>{val}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Rankings */}
      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Loading leaderboard...</div>
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
        <div className="space-y-2">
          {board.map((entry, idx) => {
            const rankCls = RANK_COLORS[idx] ?? "text-muted-foreground";
            const cardCls = RANK_BG[idx] ?? "bg-card border-border";
            const medal = MEDALS[idx];

            return (
              <Card
                key={entry.rep.id}
                className={`border ${cardCls} transition-colors`}
                data-testid={`row-rep-${entry.rep.id}`}
              >
                <CardContent className="py-3 px-4">
                  <div className="flex items-center gap-3">
                    {/* Rank */}
                    <div className={`text-xl font-bold w-8 text-center flex-shrink-0 ${rankCls}`}>
                      {medal ?? `#${idx + 1}`}
                    </div>

                    {/* Avatar */}
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 ${
                      entry.rep.role === "manager"
                        ? "bg-amber-500/20 text-amber-400"
                        : "bg-primary/20 text-primary"
                    }`}>
                      {entry.rep.name.charAt(0).toUpperCase()}
                    </div>

                    {/* Name + role */}
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm text-foreground">{entry.rep.name}</div>
                      <div className="text-xs text-muted-foreground capitalize">{entry.rep.role}</div>
                    </div>

                    {/* Stats */}
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <StatPill icon={DoorOpen} val={entry.knocks} label="knocks" color="text-muted-foreground" />
                      <StatPill icon={PhoneCall} val={entry.contacts} label="contacts" color="text-blue-400" />
                      <StatPill icon={CalendarCheck} val={entry.callbacks} label="callbacks" color="text-amber-400" />
                      <StatPill icon={Zap} val={entry.sales} label="sales" color="text-green-400" />

                      {/* Conversion rate */}
                      <div className="hidden sm:flex flex-col items-center min-w-[48px]">
                        <div className="text-sm font-bold text-foreground">
                          {conversionRate(entry.contacts, entry.sales)}
                        </div>
                        <div className="text-xs text-muted-foreground">conv.</div>
                      </div>
                    </div>
                  </div>

                  {/* Progress bar — sales as % of team total */}
                  {totals.sales > 0 && (
                    <div className="mt-2 ml-[68px]">
                      <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                        <span>{entry.sales} sales</span>
                        <span>{Math.round((entry.sales / totals.sales) * 100)}% of team</span>
                      </div>
                      <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                        <div
                          className="h-full bg-green-400 rounded-full transition-all duration-500"
                          style={{ width: `${(entry.sales / totals.sales) * 100}%` }}
                        />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatPill({
  icon: Icon, val, label, color
}: {
  icon: React.ElementType; val: number; label: string; color: string;
}) {
  return (
    <div className="flex flex-col items-center min-w-[36px]">
      <div className={`flex items-center gap-0.5 text-sm font-bold ${color}`}>
        <Icon className="w-3 h-3" />
        {val}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
