// ── The lock screen a gated rep sees ────────────────────────────────────────
// A new rep opens the app and everything except Training is closed. That is a
// blunt experience, so this screen does the one thing that makes it survivable:
// it states the finish line as a NUMBER and puts the only useful button under it.
//
// "Complete your training to continue" is a wall. "9 lessons left to unlock the
// app" is a task. The difference decides whether a new hire works through it
// tonight or texts their manager that the app is broken.
//
// It also names WHAT is waiting. A rep who can see that the map, their doors,
// and their commission are on the other side has a reason to finish; a blank
// app just looks like a bug.
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronRight } from "lucide-react";
import { TRAINING_GATE_LOCKED_LABELS } from "@shared/trainingGate";

export interface GateStatus {
  gated: boolean;
  exempt: boolean;
  trainingRequired: boolean;
  progress: { completed: number; required: number; remaining: number; pct: number; headline: string };
  totalAvailable: number;
}

export function useTrainingGate(enabled = true) {
  return useQuery<GateStatus>({
    queryKey: ["/api/training/gate"],
    // Cheap, and it decides whether the whole app is reachable — a rep who just
    // finished their last lesson should not have to sign out to be let in.
    staleTime: 15_000,
    enabled,
  });
}

/** The full-page lock. Rendered in place of any route a gated rep cannot reach. */
export function TrainingLock() {
  const { data, isLoading } = useTrainingGate();

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-lg p-4 pt-8" data-testid="training-lock-loading">
        <Skeleton className="h-[320px] w-full rounded-2xl" />
      </div>
    );
  }
  if (!data?.gated) return null;

  const p = data.progress;
  return (
    <div className="mx-auto w-full max-w-lg space-y-4 p-4 pt-8 pb-24" data-testid="training-lock">
      <Card className="overflow-hidden rounded-2xl border border-border bg-card">
        <CardContent className="p-6 text-center">
          

          <h1 className="mt-4 text-xl font-bold tracking-tight text-foreground">
            Finish training to unlock the app
          </h1>

          {/* The number. This is the whole screen — everything else is context. */}
          <p className="mt-1 text-[15px] font-semibold text-foreground" data-testid="lock-headline">
            {p.headline}
          </p>

          <div className="mt-4">
            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
                   style={{ width: `${p.pct}%` }} data-testid="lock-bar" />
            </div>
            <p className="mt-1.5 text-[13px] tabular-nums text-muted-foreground" data-testid="lock-count">
              {p.completed} of {p.required} lessons complete
            </p>
          </div>

          <Link href="/training" data-testid="lock-cta"
            className={cn(
              "mt-5 inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground",
              FOCUS,
            )}>
            {p.completed > 0 ? "Continue training" : "Start training"}
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </CardContent>
      </Card>

      {/* Name what is waiting. A rep who can see the prize finishes; a blank app
          just looks broken. */}
      <Card className="rounded-2xl border border-border bg-card">
        <CardContent className="p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Unlocks when you finish
          </p>
          <ul className="mt-2 space-y-1.5" data-testid="lock-unlocks">
            {TRAINING_GATE_LOCKED_LABELS.map(label => (
              <li key={label} className="flex items-center gap-2 text-[13px] text-foreground">
                
                {label}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12px] text-muted-foreground">
            Your profile and onboarding paperwork stay open, so you can finish your W-9 and
            documents while you work through the lessons.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/** A slim banner for the Training page itself, where the lock screen would be
 *  redundant — the rep is already in the right place, they just need to know
 *  that finishing is what opens the door. */
export function TrainingGateBanner() {
  const { data } = useTrainingGate();
  if (!data?.gated) return null;
  const p = data.progress;
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-primary/30 bg-primary/[0.07] p-3"
         role="status" data-testid="training-gate-banner">
      
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-foreground">{p.headline}</p>
        <p className="text-[12px] text-muted-foreground tabular-nums">
          {p.completed} of {p.required} complete. The rest of the app opens when you finish.
        </p>
      </div>
    </div>
  );
}

/** Shown once, on the Training page, when a rep has just cleared the gate. */
export function TrainingClearedBanner() {
  const { data } = useTrainingGate();
  if (!data || data.gated || data.trainingRequired !== true) return null;
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.07] p-3"
         role="status" data-testid="training-cleared-banner">
      
      <p className="text-[13px] font-semibold text-foreground">
        Training complete. The whole app is unlocked. Go get some doors.
      </p>
    </div>
  );
}
