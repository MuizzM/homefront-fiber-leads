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
    <span className="tabular-nums text-4xl font-semibold tracking-tight text-foreground">
      {String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
    </span>
  );
}

export default function ClockIn() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isManager = user?.role === "admin" || user?.role === "manager";
  const today = new Date().toISOString().slice(0, 10);

  const { data: clockStatus, isLoading: statusLoading, isError: statusError, refetch: refetchStatus } = useQuery<{ clockedIn: boolean; session: ClockSession | null }>({
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

  const isOnClock = !!clockStatus?.clockedIn;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Field Hours</h1>
        <p className="text-sm text-muted-foreground">Clock in/out tracker · {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
      </div>

      {/* Current status */}
      <Card className="bg-card border-border rounded-xl">
        <CardContent className="p-6">
          {statusLoading ? (
            <Skeleton className="h-24 bg-secondary" />
          ) : statusError ? (
            // NEVER show "Off Duty" on a failed fetch — a clocked-in rep would
            // think their hours stopped counting (they didn't; the server has it).
            <div className="text-center py-4" data-testid="clock-status-error">
              <div className="text-sm font-semibold text-foreground">Can't reach the server</div>
              <div className="text-sm text-muted-foreground mt-1">Your clock status is unknown right now — if you clocked in, your hours are still counting.</div>
              <button onClick={() => refetchStatus()}
                className="mt-3 inline-flex items-center justify-center h-9 px-4 rounded-lg bg-secondary border border-border text-sm font-semibold text-foreground active:scale-95 transition-transform">
                Retry
              </button>
            </div>
          ) : (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-8">
              <div className="space-y-3 text-center sm:text-left">
                <span
                  className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-wide ${
                    isOnClock ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${isOnClock ? "bg-primary animate-pulse" : "bg-muted-foreground"}`} />
                  {isOnClock ? "In the Field" : "Off Duty"}
                </span>
                {isOnClock && clockStatus?.session ? (
                  <div>
                    <ElapsedTimer startTime={clockStatus.session.clockedIn} />
                    <p className="text-xs text-muted-foreground mt-1">
                      Started {new Date(clockStatus.session.clockedIn).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                ) : (
                  <p className="text-2xl font-semibold tracking-tight text-muted-foreground">Not clocked in</p>
                )}
              </div>
              <div className="flex justify-center sm:justify-end">
                {!isOnClock ? (
                  <Button
                    size="lg"
                    onClick={() => clockInMutation.mutate()}
                    disabled={clockInMutation.isPending}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground px-8"
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
                    className="border-rose-500/30 text-rose-400 hover:bg-rose-500/10 px-8"
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

      {/* Metric strip */}
      <Card className="bg-card border-border rounded-xl">
        <div className="grid grid-cols-3 divide-x divide-border">
          <div className="p-5">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              <Clock className="w-3.5 h-3.5 text-primary" /> Today
            </div>
            <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-foreground">{formatDuration(todayMinutes)}</p>
          </div>
          <div className="p-5">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              <TrendingUp className="w-3.5 h-3.5 text-muted-foreground" /> This Week
            </div>
            <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-foreground">{formatDuration(weekMinutes)}</p>
          </div>
          <div className="p-5">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              <Users className="w-3.5 h-3.5 text-muted-foreground" /> {isManager ? "Active Now" : "My Status"}
            </div>
            <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-foreground">{isManager ? activeSessions.length : (isOnClock ? 1 : 0)}</p>
          </div>
        </div>
      </Card>

      {/* Active sessions (manager) */}
      {isManager && activeSessions.length > 0 && (
        <Card className="bg-card border-border rounded-xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
              <Timer className="w-4 h-4 text-primary" /> Currently in Field
              <Badge className="bg-emerald-500/15 text-emerald-400 border-transparent rounded-full ml-1">{activeSessions.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {activeSessions.map(s => (
                <div key={s.id} className="px-5 py-3.5 flex items-center justify-between" data-testid={`active-session-${s.id}`}>
                  <div className="flex items-center gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <div>
                      <p className="text-sm text-foreground font-medium">{s.repName ?? `Rep #${s.repId}`}</p>
                      <p className="text-xs text-muted-foreground">Since {new Date(s.clockedIn).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</p>
                    </div>
                  </div>
                  <Badge className="bg-emerald-500/15 text-emerald-400 border-transparent rounded-full text-xs flex items-center gap-1.5">
                    <span className="w-1 h-1 rounded-full bg-emerald-400" /> Active
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Session history */}
      <Card className="bg-card border-border rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
            <Calendar className="w-4 h-4 text-primary" /> Session History
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {sessionsLoading ? (
            <div className="p-4 space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-12 bg-secondary" />)}</div>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground p-5">No sessions yet</p>
          ) : (
            <div className="divide-y divide-border max-h-80 overflow-y-auto">
              {sessions.filter(s => s.clockedOut).slice(0, 30).map(s => (
                <div key={s.id} className="px-5 py-3.5 flex items-center justify-between" data-testid={`session-history-${s.id}`}>
                  <div>
                    {isManager && <p className="text-[11px] uppercase tracking-wide text-primary font-medium">{s.repName ?? `Rep #${s.repId}`}</p>}
                    <p className="text-sm text-foreground">{new Date(s.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {new Date(s.clockedIn).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                      {" → "}
                      {s.clockedOut ? new Date(s.clockedOut).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "—"}
                    </p>
                  </div>
                  <Badge className="bg-secondary text-muted-foreground border-transparent rounded-full text-xs tabular-nums">
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
