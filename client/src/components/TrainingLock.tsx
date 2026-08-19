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
import {
  BadgeDollarSign,
  CheckCircle2,
  ChevronRight,
  FileCheck2,
  GraduationCap,
  LockKeyhole,
  UserRound,
} from "lucide-react";
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
      <div className="app-canvas flex-1 overflow-y-auto" data-testid="training-lock-loading">
        <div className="mx-auto w-full max-w-5xl p-4 py-8 sm:p-6 lg:py-12">
          <Skeleton className="h-[430px] w-full rounded-2xl" />
        </div>
      </div>
    );
  }
  if (!data?.gated) return null;

  const p = data.progress;
  return (
    <div className="app-canvas flex-1 overflow-y-auto" data-testid="training-lock">
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4 py-8 pb-24 sm:p-6 lg:py-12">
        <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <CardContent className="grid p-0 md:grid-cols-[minmax(0,1.2fr)_minmax(290px,0.8fr)]">
            <section className="p-6 sm:p-8 lg:p-10" aria-labelledby="training-lock-title">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/[0.08] px-3 py-1.5 text-xs font-semibold text-primary">
                <GraduationCap className="h-4 w-4" aria-hidden="true" />
                Rep workspace
              </div>

              <h1 id="training-lock-title" className="mt-5 text-xl font-bold tracking-tight text-foreground">
                Finish training to unlock your field tools
              </h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                Your workspace is ready. Complete the required lessons to open the map,
                leads, performance, and pay tools used in the field.
              </p>

              <div className="mt-7 flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Training progress</p>
                  <p className="mt-1 text-[15px] font-semibold text-foreground" data-testid="lock-headline">{p.headline}</p>
                </div>
                <span className="text-4xl font-bold tabular-nums tracking-tight text-primary" aria-hidden="true">{p.pct}%</span>
              </div>
              <div className="mt-3">
                <div
                  className="h-2.5 w-full overflow-hidden rounded-full bg-secondary"
                  role="progressbar"
                  aria-label="Required training progress"
                  aria-valuemin={0}
                  aria-valuemax={p.required}
                  aria-valuenow={p.completed}
                  aria-valuetext={`${p.completed} of ${p.required} lessons complete`}
                >
                  <div className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
                       style={{ width: `${p.pct}%` }} data-testid="lock-bar" />
                </div>
                <p className="mt-2 text-[13px] tabular-nums text-muted-foreground" data-testid="lock-count">
                  {p.completed} of {p.required} lessons complete
                </p>
              </div>

              <Link href="/training" data-testid="lock-cta"
                className={cn(
                  "mt-6 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition-[background-color,box-shadow] hover:shadow-md sm:w-auto",
                  FOCUS,
                )}>
                {p.completed > 0 ? "Continue training" : "Start training"}
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </section>

            <aside className="border-t border-border bg-secondary/40 p-6 sm:p-8 md:border-l md:border-t-0" aria-labelledby="training-unlocks-title">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <LockKeyhole className="h-5 w-5" aria-hidden="true" />
              </div>
              <h2 id="training-unlocks-title" className="mt-4 text-base font-bold text-foreground">What you unlock</h2>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">Finish the required path once to open your daily workspace.</p>
              <ul className="mt-5 space-y-3" data-testid="lock-unlocks">
                {TRAINING_GATE_LOCKED_LABELS.map(label => (
                  <li key={label} className="flex items-start gap-2.5 text-[13px] leading-5 text-foreground">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    <span>{label}</span>
                  </li>
                ))}
              </ul>
            </aside>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border border-border bg-card shadow-sm">
          <CardContent className="p-4 sm:p-5">
            <div className="mb-3 px-1">
              <h2 className="text-sm font-bold text-foreground">Available while you train</h2>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">Keep onboarding moving without waiting for the rest of the app to unlock.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {[
                { href: "/profile", label: "Profile", detail: "Check your contact details", Icon: UserRound },
                { href: "/my-documents", label: "My documents", detail: "Review onboarding paperwork", Icon: FileCheck2 },
                { href: "/tax-and-pay", label: "Tax & pay", detail: "Complete required pay setup", Icon: BadgeDollarSign },
              ].map(({ href, label, detail, Icon }) => (
                <Link key={href} href={href} className={cn("group flex min-h-16 items-center gap-3 rounded-xl border border-border bg-background/70 p-3 transition-[background-color,border-color] hover:border-primary/30 hover:bg-primary/[0.04]", FOCUS)}>
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-secondary text-primary"><Icon className="h-[18px] w-[18px]" aria-hidden="true" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-foreground">{label}</span>
                    <span className="block text-xs leading-4 text-muted-foreground">{detail}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
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
