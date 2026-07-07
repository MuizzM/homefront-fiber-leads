import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { Clock, LogIn, LogOut, Calendar, Timer, Users, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";

interface ClockSession {
  id: number; repId: number; userId: number; clockedIn: string;
  clockedOut: string | null; durationMinutes: number | null; notes: string | null;
  date: string; repName?: string;
}

function formatDuration(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function ElapsedTimer({ startTime }: { startTime: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const update = () => setElapsed(Math.floor((Date.now() - new Date(startTime).getTime()) / 1000));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startTime]);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  return (
    <span className="font-mono text-2xl font-bold text-[#3EA394]">
      {String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
    </span>
  );
}

export default function ClockIn() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isManager = user?.role === "admin" || user?.role === "manager";
  const today = new Date().toISOString().slice(0, 10);

  const { data: clockStatus, isLoading: statusLoading } = useQuery<{ clockedIn: boolean; session: ClockSession | null }>({
    queryKey: ["/api/clock/status"],
    queryFn: () => apiRequest("GET", "/api/clock/status").then(r => r.json()),
    refetchInterval: 10000,
  });

  const { data: sessions = [], isLoading: sessionsLoading } = useQuery<ClockSession[]>({
    queryKey: ["/api/clock/sessions"],
    queryFn: () => apiRequest("GET", "/api/clock/sessions").then(r => r.json()),
    refetchInterval: 30000,
  });

  const clockInMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/clock/in", {}).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clock/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/clock/sessions"] });
      toast({ title: "Clocked in successfully" });
    },
    onError: (e: any) => toast({ title: "Error", description: e?.message ?? "Could not clock in", variant: "destructive" }),
  });

  const clockOutMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/clock/out", {}).then(r => r.json()),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/clock/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/clock/sessions"] });
      toast({ title: `Clocked out · ${formatDuration(data?.durationMinutes ?? 0)} in field` });
    },
    onError: () => toast({ title: "Error clocking out", variant: "destructive" }),
  });

  const todaySessions = sessions.filter(s => s.date === today);
  const todayMinutes = todaySessions.reduce((sum, s) => sum + (s.durationMinutes ?? 0), 0);
  const activeSessions = sessions.filter(s => !s.clockedOut);

  // Week total
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const weekSessions = sessions.filter(s => s.date >= weekAgo);
  const weekMinutes = weekSessions.reduce((sum, s) => sum + (s.durationMinutes ?? 0), 0);

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Field Hours</h1>
        <p className="text-sm text-[#7a9ab5]">Clock in/out tracker · {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
      </div>

      {/* Clock widget */}
      <Card className="bg-[#0a1e30] border-[#1a3a52]">
        <CardContent className="p-6">
          {statusLoading ? (
            <Skeleton className="h-24 bg-[#1a3a52]" />
          ) : (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
              <div className="text-center sm:text-left">
                <div className="flex items-center gap-3 mb-2">
                  <div className={`w-3 h-3 rounded-full ${clockStatus?.clockedIn ? "bg-emerald-400 animate-pulse" : "bg-[#4a6a82]"}`} />
                  <span className="text-sm text-[#7a9ab5] font-medium">
                    {clockStatus?.clockedIn ? "In the Field" : "Off Duty"}
                  </span>
                </div>
                {clockStatus?.clockedIn && clockStatus.session ? (
                  <div>
                    <ElapsedTimer startTime={clockStatus.session.clockedIn} />
                    <p className="text-xs text-[#7a9ab5] mt-1">
                      Started {new Date(clockStatus.session.clockedIn).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                ) : (
                  <p className="text-xl text-[#4a6a82]">Not clocked in</p>
                )}
              </div>
              <div className="flex gap-3">
                {!clockStatus?.clockedIn ? (
                  <Button
                    size="lg"
                    onClick={() => clockInMutation.mutate()}
                    disabled={clockInMutation.isPending}
                    className="bg-[#3EA394] hover:bg-[#35897d] text-white px-8"
                    data-testid="button-clock-in"
                  >
                    <LogIn className="w-5 h-5 mr-2" />
                    {clockInMutation.isPending ? "Clocking In..." : "Clock In"}
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    variant="outline"
                    onClick={() => clockOutMutation.mutate()}
                    disabled={clockOutMutation.isPending}
                    className="border-red-500/30 text-red-400 hover:bg-red-500/10 px-8"
                    data-testid="button-clock-out"
                  >
                    <LogOut className="w-5 h-5 mr-2" />
                    {clockOutMutation.isPending ? "Clocking Out..." : "Clock Out"}
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="bg-[#0a1e30] border-[#1a3a52]">
          <CardContent className="p-4 text-center">
            <Clock className="w-5 h-5 text-[#3EA394] mx-auto mb-1" />
            <p className="text-lg font-bold text-white">{formatDuration(todayMinutes)}</p>
            <p className="text-xs text-[#7a9ab5]">Today</p>
          </CardContent>
        </Card>
        <Card className="bg-[#0a1e30] border-[#1a3a52]">
          <CardContent className="p-4 text-center">
            <TrendingUp className="w-5 h-5 text-blue-400 mx-auto mb-1" />
            <p className="text-lg font-bold text-white">{formatDuration(weekMinutes)}</p>
            <p className="text-xs text-[#7a9ab5]">This Week</p>
          </CardContent>
        </Card>
        <Card className="bg-[#0a1e30] border-[#1a3a52]">
          <CardContent className="p-4 text-center">
            <Users className="w-5 h-5 text-purple-400 mx-auto mb-1" />
            <p className="text-lg font-bold text-white">{isManager ? activeSessions.length : (clockStatus?.clockedIn ? 1 : 0)}</p>
            <p className="text-xs text-[#7a9ab5]">{isManager ? "Active Now" : "My Status"}</p>
          </CardContent>
        </Card>
      </div>

      {/* Active sessions (manager) */}
      {isManager && activeSessions.length > 0 && (
        <Card className="bg-[#0a1e30] border-[#1a3a52]">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
              <Timer className="w-4 h-4 text-[#3EA394]" /> Currently in Field
              <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 ml-1">{activeSessions.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-[#1a3a52]">
              {activeSessions.map(s => (
                <div key={s.id} className="px-4 py-3 flex items-center justify-between" data-testid={`active-session-${s.id}`}>
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <div>
                      <p className="text-sm text-white font-medium">{s.repName ?? `Rep #${s.repId}`}</p>
                      <p className="text-xs text-[#7a9ab5]">Since {new Date(s.clockedIn).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</p>
                    </div>
                  </div>
                  <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs">Active</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Session history */}
      <Card className="bg-[#0a1e30] border-[#1a3a52]">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
            <Calendar className="w-4 h-4 text-[#3EA394]" /> Session History
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {sessionsLoading ? (
            <div className="p-4 space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-12 bg-[#1a3a52]" />)}</div>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-[#7a9ab5] p-4">No sessions yet</p>
          ) : (
            <div className="divide-y divide-[#1a3a52] max-h-80 overflow-y-auto">
              {sessions.filter(s => s.clockedOut).slice(0, 30).map(s => (
                <div key={s.id} className="px-4 py-3 flex items-center justify-between" data-testid={`session-history-${s.id}`}>
                  <div>
                    {isManager && <p className="text-xs text-[#3EA394] font-medium">{s.repName ?? `Rep #${s.repId}`}</p>}
                    <p className="text-sm text-white">{new Date(s.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</p>
                    <p className="text-xs text-[#7a9ab5]">
                      {new Date(s.clockedIn).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                      {" → "}
                      {s.clockedOut ? new Date(s.clockedOut).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "—"}
                    </p>
                  </div>
                  <Badge className="bg-[#1a3a52] text-[#7a9ab5] border-[#2a4a62] text-xs">
                    {formatDuration(s.durationMinutes ?? 0)}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
