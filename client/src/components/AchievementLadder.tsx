// ── The achievement ladder, as the rep sees it ───────────────────────────────
// The recognition bonus below it is a surprise a rep cannot aim at. This is the
// one they can: published rungs, fixed amounts, no dice.
//
//     "1 more sale today for $25"
//
// That sentence is the entire feature. Everything else on this card exists to
// support it — the rung strip so a rep can see the money sitting ahead of them,
// the career row so a long grind still has a next number in it.
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { usd } from "@shared/moneyFormat";
import type { AchievementRung } from "@shared/salesAchievements";

export interface AchievementCardData {
  enabled: boolean;
  dailySales: number;
  careerSales: number;
  nextDaily: AchievementRung | null;
  nextCareer: AchievementRung | null;
  earnedTodayCents: number;
  daily: AchievementRung[];
  career: AchievementRung[];
  headline: string | null;
  onRamp?: boolean;
  dayLabel?: string;
}

export function useMyAchievements(enabled = true) {
  return useQuery<AchievementCardData>({
    queryKey: ["/api/me/achievements"],
    refetchInterval: 60_000,
    enabled,
  });
}

function RungStrip({ rungs, at, testId }: { rungs: AchievementRung[]; at: number; testId: string }) {
  if (!rungs?.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid={testId}>
      {rungs.map(r => {
        const cleared = at >= r.sales;
        return (
          <span key={r.sales} data-testid={`${testId}-${r.sales}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums",
              cleared ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                      : "bg-secondary text-muted-foreground",
            )}>
            {r.sales}: {usd(r.rewardCents)}
          </span>
        );
      })}
    </div>
  );
}

export function AchievementLadder() {
  const { data, isLoading } = useMyAchievements();

  if (isLoading) return <Skeleton className="h-[124px] w-full rounded-2xl" data-testid="achievements-loading" />;
  // Off, or the rep is on the ramp bonus instead — either way, nothing to show.
  if (!data?.enabled) return null;


  return (
    <Card className={cn(
      "overflow-hidden rounded-2xl border",
      data.earnedTodayCents > 0 ? "border-emerald-500/40 bg-emerald-500/[0.06]" : "border-border bg-card",
    )} data-testid="achievement-card">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-xl font-bold tabular-nums tracking-tight text-foreground" data-testid="achievement-daily-sales">
                {data.dailySales}
              </span>
              <span className="text-[13px] font-semibold text-foreground">
                sale{data.dailySales === 1 ? "" : "s"} today
              </span>
            </div>
            {/* The instruction — the line that changes what someone does with
                their afternoon. Server copy, verbatim. */}
            <p className="mt-0.5 text-[13px] font-medium text-foreground/90" data-testid="achievement-headline">
              {data.headline}
            </p>
          </div>

          {data.earnedTodayCents > 0 && (
            <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-emerald-700 dark:text-emerald-400"
                  data-testid="achievement-earned">
              {usd(data.earnedTodayCents)} today
            </span>
          )}
        </div>

        <div className="mt-3 space-y-2">
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Today</p>
            <RungStrip rungs={data.daily} at={data.dailySales} testId="achievement-daily" />
          </div>
          {data.career.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Career · {data.careerSales} sold
              </p>
              <RungStrip rungs={data.career} at={data.careerSales} testId="achievement-career" />
            </div>
          )}
        </div>

        <p className="mt-2 text-[12px] text-muted-foreground" data-testid="achievement-rule">
          Counts qualified sales, one per address. Paid on your commission statement.
        </p>
      </CardContent>
    </Card>
  );
}

/** Header + card. Renders nothing when the ladder is off or the rep is on the
 *  ramp bonus instead. */
export function AchievementSection() {
  const { data } = useMyAchievements();
  if (!data?.enabled) return null;
  return (
    <section className="space-y-2" data-testid="achievement-section">
      <SectionLabel className="flex items-center gap-1.5">
        
        Achievement bonuses
      </SectionLabel>
      <AchievementLadder />
    </section>
  );
}
