// ── Training access — the admin's lock/unlock console ───────────────────────
// The gate itself is a policy: new accounts owe training. This is the manual
// control that sits over it, because the policy alone cannot express the cases
// that actually come up:
//
//   a rep who was already on the roster and now needs the course after all
//   a rehire who trained last season
//   someone who trained in person and should not sit through 91 lessons
//   a rep coming back from a bad month who is being put back through it
//
// So the list is EVERYONE, not just the people currently locked. The most common
// admin action here is locking someone who is presently unlocked, and you cannot
// act on a person the list does not show.
//
// The toggle states the consequence in plain words rather than a bare switch:
// "Locked — training only" versus "Unlocked — full app". An admin flipping this
// is deciding whether a person can work today, and that should never be
// ambiguous at a glance.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { Lock, LockOpen, GraduationCap, Search, ShieldCheck, Loader2 } from "lucide-react";

interface RosterRow {
  userId: number;
  name: string;
  email: string;
  role: string;
  completed: number;
  required: number;
  trainingRequired: boolean;
  gated: boolean;
}
interface RosterResponse {
  everyone: RosterRow[];
  reps: RosterRow[];
  requiredLessons: number;
  totalAvailable: number;
}

const EXEMPT = new Set(["admin", "super_admin", "manager", "team_lead"]);

export function TrainingAccessPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");

  const { data, isLoading } = useQuery<RosterResponse>({
    queryKey: ["/api/training/gate/roster"],
    refetchInterval: 60_000,
  });

  const setLock = useMutation({
    mutationFn: async ({ userId, required }: { userId: number; required: boolean }) => {
      const res = await apiRequest("POST", `/api/training/gate/${userId}`, { required });
      return res.json();
    },
    // Optimism is deliberately NOT used here. This decides whether a person can
    // work; showing "unlocked" before the server agreed would be the worst
    // possible thing to be wrong about, so the row waits for the real answer.
    onSuccess: (_r, { required }) => {
      qc.invalidateQueries({ queryKey: ["/api/training/gate/roster"] });
      qc.invalidateQueries({ queryKey: ["/api/training/gate"] });
      toast({ title: required ? "Locked to training" : "Unlocked · full app access" });
    },
    onError: (e: any) => toast({ title: "Couldn't change access", description: String(e?.message ?? e), variant: "destructive" }),
  });

  const rows = useMemo(() => {
    const all = data?.everyone ?? [];
    const q = filter.trim().toLowerCase();
    const matched = q
      ? all.filter(r => r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q))
      : all;
    // Locked first — the people who cannot work are the ones an admin opened
    // this panel to deal with.
    return [...matched].sort((a, b) => {
      if (a.gated !== b.gated) return a.gated ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [data?.everyone, filter]);

  const lockedCount = (data?.everyone ?? []).filter(r => r.gated).length;

  if (isLoading) {
    return <Skeleton className="h-[200px] w-full rounded-2xl" data-testid="training-access-loading" />;
  }

  return (
    <section className="space-y-3" data-testid="training-access">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          Training access
        </SectionLabel>
        <span className="text-[13px] tabular-nums text-muted-foreground" data-testid="training-access-count">
          {lockedCount} locked · {data?.requiredLessons ?? 0} lessons required
        </span>
      </div>

      <p className="text-[13px] text-muted-foreground">
        Locked reps can only reach Training, their profile, and their onboarding paperwork.
        No map, doors, leads, or commission until they finish.
      </p>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          value={filter} onChange={e => setFilter(e.target.value)}
          placeholder="Find a rep by name or email" className="pl-9"
          data-testid="training-access-search" aria-label="Find a rep"
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={GraduationCap} title="Nobody matches" bordered testId="training-access-empty"
          description="No one in your org matches that search." />
      ) : (
        <ul className="space-y-2" data-testid="training-access-list">
          {rows.map(r => {
            const exempt = EXEMPT.has(r.role);
            const busy = setLock.isPending && setLock.variables?.userId === r.userId;
            const pct = r.required > 0
              ? Math.min(100, Math.round((r.completed / r.required) * 100)) : 100;
            return (
              <li key={r.userId} data-testid={`training-row-${r.userId}`}
                  className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3">
                <div className={cn(
                  "grid h-9 w-9 shrink-0 place-items-center rounded-xl",
                  r.gated ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                          : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
                )}>
                  {r.gated ? <Lock className="h-4 w-4" aria-hidden="true" />
                           : <LockOpen className="h-4 w-4" aria-hidden="true" />}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="truncate text-sm font-semibold text-foreground">{r.name}</span>
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{r.role.replace("_", " ")}</span>
                  </div>
                  {/* State in words, not a bare switch — this decides whether a
                      person can work today. */}
                  <p className={cn("text-[13px] font-medium",
                    r.gated ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}
                     data-testid={`training-state-${r.userId}`}>
                    {r.gated
                      ? `Locked to training · ${r.completed} of ${r.required}`
                      : exempt
                        ? "Full app · role is exempt from training"
                        : r.trainingRequired
                          ? `Unlocked · training complete (${r.completed} of ${r.required})`
                          : `Unlocked · training not required`}
                  </p>
                  {r.trainingRequired && !exempt && (
                    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                      <div className={cn("h-full rounded-full", r.gated ? "bg-amber-500" : "bg-emerald-500")}
                           style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>

                {/* Exempt roles get no toggle: the gate does not apply to them,
                    and offering a switch that changes nothing is a lie. */}
                {exempt ? (
                  <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                    Exempt
                  </span>
                ) : (
                  <button
                    type="button" disabled={busy}
                    onClick={() => setLock.mutate({ userId: r.userId, required: !r.trainingRequired })}
                    data-testid={`training-toggle-${r.userId}`}
                    aria-label={r.trainingRequired ? `Remove the training requirement for ${r.name}` : `Require training for ${r.name}`}
                    className={cn(
                      "inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold disabled:opacity-50",
                      r.trainingRequired
                        ? "bg-secondary text-foreground"
                        : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
                      FOCUS,
                    )}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          : r.trainingRequired ? <LockOpen className="h-4 w-4" aria-hidden="true" />
                                               : <Lock className="h-4 w-4" aria-hidden="true" />}
                    {r.trainingRequired ? "Unlock" : "Lock"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
