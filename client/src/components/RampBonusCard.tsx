// ── The new-hire ramp bonus, as the rep sees it ──────────────────────────────
// Two weeks, $50 a day for finishing the day's training, plus a one-off for
// finishing the whole curriculum. The card exists because a bonus nobody knows
// about changes nobody's behaviour — and because a new hire's first fortnight
// is the stretch where the app has to give them something to be proud of before
// commission can.
//
// It shows the window CLOSING (day 3 of 14) on purpose. The ramp is a bridge to
// the first commission cheque, not a salary, and a rep who can see it expiring
// spends the days rather than drifting through them.
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { BookOpen, CheckCircle2, GraduationCap } from "lucide-react";
import { usd } from "@shared/moneyFormat";

export interface RampCardData {
  visible: boolean;
  inWindow: boolean;
  tenureDay: number;
  windowDays: number;
  daysLeft: number;
  rewardCents: number;
  earnedToday: boolean;
  blockedBy: string | null;
  headline: string;
  cardsToday: number;
  minCardsPerDay: number;
  daysPaid: number;
  completion: {
    enabled: boolean;
    paid: boolean;
    lessonsCompleted: number;
    lessonsTotal: number;
    remaining: number;
    awardCents: number;
    headline: string;
  };
}

export function useMyRampBonus(enabled = true) {
  return useQuery<RampCardData>({
    queryKey: ["/api/me/ramp-bonus"],
    refetchInterval: 60_000,
    enabled,
  });
}

export function RampBonusCard() {
  const { data, isLoading } = useMyRampBonus();

  if (isLoading) return <Skeleton className="h-[136px] w-full rounded-2xl" data-testid="ramp-loading" />;
  // A veteran who already finished renders NOTHING. Dangling a bonus in front
  // of someone who cannot earn it is worse than showing them nothing.
  if (!data?.visible) return null;

  const c = data.completion;
  const lessonPct = c.lessonsTotal > 0
    ? Math.max(0, Math.min(100, Math.round((c.lessonsCompleted / c.lessonsTotal) * 100)))
    : 0;

  return (
    <Card
      className={cn(
        "overflow-hidden rounded-2xl border",
        data.earnedToday ? "border-emerald-500/40 bg-emerald-500/[0.06]" : "border-border bg-card",
      )}
      data-testid="ramp-card"
    >
      <CardContent className="p-4">
        {data.inWindow && (
          <>
            <div className="flex items-start gap-3">
              <div className={cn(
                "grid h-10 w-10 shrink-0 place-items-center rounded-xl",
                data.earnedToday ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-primary/15 text-primary",
              )}>
                {data.earnedToday ? <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                                  : <BookOpen className="h-5 w-5" aria-hidden="true" />}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[13px] font-semibold text-foreground" data-testid="ramp-day">
                    Day {data.tenureDay} of {data.windowDays}
                  </span>
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {data.daysLeft} day{data.daysLeft === 1 ? "" : "s"} left
                  </span>
                </div>
                <p className="mt-0.5 text-[13px] font-medium text-foreground/90" data-testid="ramp-headline">
                  {data.headline}
                </p>
              </div>

              <span className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums",
                data.earnedToday ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                                 : "bg-secondary text-muted-foreground",
              )} data-testid="ramp-reward">
                {data.earnedToday ? `${usd(data.rewardCents)} earned` : `${usd(data.rewardCents)}/day`}
              </span>
            </div>

            {data.daysPaid > 0 && (
              <p className="mt-2 text-[12px] text-muted-foreground" data-testid="ramp-days-paid">
                {data.daysPaid} training day{data.daysPaid === 1 ? "" : "s"} banked so far - {" "}
                {usd(data.daysPaid * data.rewardCents)}.
              </p>
            )}
          </>
        )}

        {/* Finishing the curriculum. Shown to a veteran too: a rep who never
            finished still has this one left to collect. */}
        {c.enabled && (
          <div className={cn("rounded-xl bg-secondary/50 p-3", data.inWindow && "mt-3")} data-testid="ramp-completion">
            <div className="flex items-start gap-2.5">
              <span className={cn(
                "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg",
                c.paid ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-background text-muted-foreground",
              )}>
                <GraduationCap className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <span className="text-[13px] font-semibold text-foreground">Finish your training</span>
                  <span className="text-[11px] font-semibold tabular-nums text-muted-foreground"
                        data-testid="ramp-completion-award">
                    {c.paid ? "Earned" : usd(c.awardCents)}
                  </span>
                </div>
                <p className="text-[12px] text-muted-foreground" data-testid="ramp-completion-headline">
                  {c.headline}
                </p>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-background" aria-hidden="true">
                  <div className={cn("h-full rounded-full transition-[width] duration-500 ease-out",
                                     c.paid ? "bg-emerald-500" : "bg-primary")}
                       style={{ width: `${lessonPct}%` }} data-testid="ramp-completion-bar" />
                </div>
                <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                  {c.lessonsCompleted} of {c.lessonsTotal} lessons
                </p>
              </div>
            </div>
          </div>
        )}

        {data.inWindow && (
          <p className="mt-2 text-[12px] text-muted-foreground" data-testid="ramp-rule">
            Clear every card due that day - at least {data.minCardsPerDay} of them, worked properly. Paid on your commission statement.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Header + card. Renders nothing once there is nothing left to earn. */
export function RampBonusSection() {
  const { data } = useMyRampBonus();
  if (!data?.visible) return null;
  return (
    <section className="space-y-2" data-testid="ramp-section">
      <SectionLabel className="flex items-center gap-1.5">
        <GraduationCap className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        {data.inWindow ? "Your first two weeks" : "Training bonus"}
      </SectionLabel>
      <RampBonusCard />
    </section>
  );
}
