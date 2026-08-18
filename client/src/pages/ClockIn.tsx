import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/ui/page-scaffold";
import { ErrorState } from "@/components/ErrorState";
import { TrackingIndicator } from "@/components/liveops/TrackingIndicator";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { elapsedShiftMinutes, isSuspiciousShiftDuration } from "@/lib/shiftDuration";
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

// Local-calendar day key of a timestamp. The server stamps session.date with a
// UTC label (toISOString), which rolls to "tomorrow" at 5–7pm across the US —
// bucketing by that label made the Today tile zero out mid-shift every evening.
// The clockedIn TIMESTAMP is unambiguous, so day/week grouping derives from it
// in the rep's own timezone and ignores the label entirely.
export function localDayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  const today = localDayKey(new Date().toISOString());

  const { data: clockStatus, isLoading: statusLoading, isError: statusError, refetch: refetchStatus } = useQuery<{ clockedIn: boolean; session: ClockSession | null }>({
    queryKey: ["/api/clock/status"],
    queryFn: () => apiRequest("GET", "/api/clock/status").then(r => r.json()),
    refetchInterval: 10000,
  });

  const { data: sessions = [], isLoading: sessionsLoading, isError: sessionsError, refetch: refetchSessions } = useQuery<ClockSession[]>({
    queryKey: ["/api/clock/sessions"],
    queryFn: () => apiRequest("GET", "/api/clock/sessions").then(r => r.json()),
    refetchInterval: 30000,
  });

  const clockInMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/clock/in", {}).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clock/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/clock/sessions"] });
      toast({ title: "Clocked in - have a great shift", severity: "success" });
    },
    onError: (e: any) => toast({ title: "Couldn't clock in", description: e?.message ?? "Check your connection and try again.", variant: "destructive" }),
  });

  const clockOutMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/clock/out", {}).then(r => r.json()),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/clock/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/clock/sessions"] });
      toast({ title: `Clocked out · ${formatDuration(data?.durationMinutes ?? 0)} in field` });
    },
    onError: () => toast({ title: "Couldn't clock out", description: "Your session is still running - try again.", variant: "destructive" }),
  });

  const todaySessions = sessions.filter(s => localDayKey(s.clockedIn) === today);
  const todayMinutes = todaySessions.reduce((sum, s) => sum + (s.durationMinutes ?? 0), 0);
  const activeSessions = sessions.filter(s => !s.clockedOut);

  // Week total — a rolling 7-day window on the clock-in timestamp.
  const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekSessions = sessions.filter(s => new Date(s.clockedIn).getTime() >= weekAgoMs);
  const weekMinutes = weekSessions.reduce((sum, s) => sum + (s.durationMinutes ?? 0), 0);

  const isOnClock = !!clockStatus?.clockedIn;

  return (
    <div className="w-full max-w-4xl mx-auto p-4 pt-5 pb-24 space-y-5 md:p-6 md:space-y-8">
      <PageHeader
        title="Field hours"
        subtitle={`Clock in/out tracker · ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`}
      />

      {/* Location sharing sits on the SHIFT screen deliberately: this is where
          a rep starts and ends the only window in which they can be tracked,
          so it is where the disclosure and the running indicator belong. */}
      <TrackingIndicator />

      {/* Current status */}
      <Card className="bg-card border-border rounded-xl">
        <CardContent className="p-4 md:p-6">
          {statusLoading ? (
            <Skeleton className="h-24 bg-secondary" />
          ) : statusError ? (
            // NEVER show "Off Duty" on a failed fetch — a clocked-in rep would
            // think their hours stopped counting (they didn't; the server has it).
            <ErrorState
              testId="clock-status-error"
              title="Can't reach the server"
              description="Your clock status is unknown right now - if you clocked in, your hours are still counting."
              onRetry={() => refetchStatus()}
              bordered={false}
              className="py-4"
            />
          ) : (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5 md:gap-8">
              <div className="space-y-3 text-center sm:text-left">
                <span
                  className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-wide ${
                    isOnClock ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${isOnClock ? "bg-primary animate-pulse" : "bg-muted-foreground"}`} />
                  {isOnClock ? "In the field" : "Off duty"}
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
                    className="w-full bg-primary hover:bg-primary/90 text-primary-foreground px-8 sm:w-auto"
                    data-testid="button-clock-in"
                  >
                    
                    {clockInMutation.isPending ? "Clocking in…" : "Clock in"}
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    variant="outline"
                    onClick={() => clockOutMutation.mutate()}
                    disabled={clockOutMutation.isPending}
                    className="w-full border-destructive/25 text-destructive hover:bg-destructive/[0.08] px-8 sm:w-auto"
                    data-testid="button-clock-out"
                  >
                    
                    {clockOutMutation.isPending ? "Clocking out…" : "Clock out"}
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
          {/* A failed sessions fetch must never read as "0m worked" - the
              server still has the hours; the em-dash says "unknown", not zero. */}
          <div className="p-3.5 md:p-5">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
               Today
            </div>
            <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-foreground" aria-label={sessionsError ? "Today's hours unavailable" : undefined}>
              {sessionsError ? " - " : formatDuration(todayMinutes)}
            </p>
          </div>
          <div className="p-3.5 md:p-5">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
               This week
            </div>
            <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-foreground" aria-label={sessionsError ? "This week's hours unavailable" : undefined}>
              {sessionsError ? " - " : formatDuration(weekMinutes)}
            </p>
          </div>
          <div className="p-3.5 md:p-5">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
               {isManager ? "Active now" : "My status"}
            </div>
            <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-foreground">{isManager ? (sessionsError ? " - " : activeSessions.length) : (isOnClock ? 1 : 0)}</p>
          </div>
        </div>
      </Card>

      {/* Active sessions (manager) */}
      {isManager && activeSessions.length > 0 && (
        <Card className="bg-card border-border rounded-xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
               Currently in field
              <Badge className="bg-success/10 text-success border-transparent rounded-full ml-1">{activeSessions.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {activeSessions.map(s => {
                const needsReview = isSuspiciousShiftDuration(elapsedShiftMinutes(s.clockedIn));
                return (
                  <div key={s.id} className="px-5 py-3.5 flex items-center justify-between gap-3" data-testid={`active-session-${s.id}`}>
                    <div className="flex items-center gap-3">
                      <div className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                      <div>
                        <p className="text-sm text-foreground font-medium">{s.repName ?? `Rep #${s.repId}`}</p>
                        <p className="text-xs text-muted-foreground">Since {new Date(s.clockedIn).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</p>
                      </div>
                    </div>
                    <Badge
                      className={`${needsReview ? "bg-warning/[0.08] text-warning" : "bg-success/10 text-success"} border-transparent rounded-full text-xs flex items-center gap-1.5`}
                      title={needsReview ? "This session is unusually long and should be reviewed before payroll is finalized." : undefined}
                    >
                      <span className={`w-1 h-1 rounded-full ${needsReview ? "bg-warning" : "bg-success"}`} />
                      {needsReview ? "Review time" : "Active"}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Session history */}
      <Card className="bg-card border-border rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
             Session history
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {sessionsLoading ? (
            <div className="p-4 space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-12 bg-secondary" />)}</div>
          ) : sessionsError ? (
            // A fetch failure is NOT "no sessions yet" - say so, offer retry.
            <ErrorState
              testId="sessions-error"
              title="Couldn't load your sessions"
              description="Your hours are safe on the server - check your connection."
              onRetry={() => refetchSessions()}
              bordered={false}
              className="p-5"
            />
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground p-5">No sessions yet</p>
          ) : (
            <div className="divide-y divide-border max-h-80 overflow-y-auto">
              {sessions.filter(s => s.clockedOut).slice(0, 30).map(s => {
                const needsReview = isSuspiciousShiftDuration(s.durationMinutes);
                return (
                  <div key={s.id} className="px-5 py-3.5 flex items-center justify-between gap-3" data-testid={`session-history-${s.id}`}>
                    <div>
                      {isManager && <p className="text-[11px] uppercase tracking-wide text-primary font-medium">{s.repName ?? `Rep #${s.repId}`}</p>}
                      {/* Date from the timestamp, not the label: new Date("YYYY-MM-DD")
                          parses as UTC midnight and shows YESTERDAY in US timezones. */}
                      <p className="text-sm text-foreground">{new Date(s.clockedIn).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {new Date(s.clockedIn).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                        {" to "}
                        {s.clockedOut ? new Date(s.clockedOut).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : " - "}
                      </p>
                    </div>
                    <Badge
                      className={`${needsReview ? "bg-warning/[0.08] text-warning" : "bg-secondary text-muted-foreground"} border-transparent rounded-full text-xs tabular-nums`}
                      title={needsReview ? "Unusually long session; review the source time before payroll is finalized." : undefined}
                    >
                      {formatDuration(s.durationMinutes ?? 0)}{needsReview ? " · Review" : ""}
                    </Badge>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
