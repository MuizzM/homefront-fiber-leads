// ── The standing knock ladder, as the rep sees it ────────────────────────────
// A campaign card counts down; this one does not. It is the bonus that is always
// there — the thing a rep with a cold week can still chase on a Wednesday
// afternoon when nothing is closing.
//
// TWO NUMBERS DO ALL THE WORK, and neither is a slogan:
//
//   "38 more verified doors this week for $50"  — an instruction, not a mood
//   the rung strip                              — where the money sits ahead
//
// The word VERIFIED is on the card on purpose. A rep should know the counter is
// distinct doors the GPS confirmed, not taps, before they try the shortcut and
// discover it at payroll. Stating the rule up front is what makes it fair; a
// silent anti-gaming filter just reads as a broken counter.
import { useQuery } from "@tanstack/react-query";
import { useTabActive } from "@/lib/tabActivity";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { usd } from "@shared/moneyFormat";
// `import type` (not `import { type … }`) so the module is erased outright
// rather than left as a side-effect import that still ships the ladder.
import type { MilestoneRung, MilestonePeriod } from "@shared/knockMilestones";

export interface MilestoneCardData {
  enabled: boolean;
  period: MilestonePeriod;
  periodLabel: string;
  rungs: MilestoneRung[];
  progress: {
    doors: number; target: number; remaining: number; pct: number;
    nextRewardCents: number; earnedCents: number; toppedOut: boolean; headline: string;
  } | null;
}

export function useMyMilestones(enabled = true) {
  const tabActive = useTabActive();
  return useQuery<MilestoneCardData>({
    queryKey: ["/api/me/milestones"],
    // Progress only moves when the rep knocks, and every knock already
    // invalidates this key at the call site.
    // Paused while this stage is HIDDEN. useTabActive is stage-scoped (each
    // KeepAliveStages stage gets its own TabActivityProvider), so a rep who
    // opens /today and then works /map all shift left this polling forever
    // behind a display:none div. Four such queries ran at 30-60s each: about
    // five requests a minute, per rep, for a screen nobody was looking at. The
    // stage re-show revalidation refreshes it the moment they return.
    refetchInterval: tabActive ? 60_000 : false,
    enabled,
  });
}

export function MilestoneCard({ compact = false }: { compact?: boolean }) {
  const { data, isLoading } = useMyMilestones();

  if (isLoading) return <Skeleton className="h-[128px] w-full rounded-2xl" data-testid="milestones-loading" />;
  // A disabled ladder renders NOTHING — never an empty rung strip implying a
  // bonus this org does not actually pay.
  if (!data?.enabled || !data.progress) return null;

  const p = data.progress;
  const when = data.period === "day" ? "today" : "this week";

  return (
    <Card className={cn(
      "overflow-hidden rounded-2xl border",
      p.toppedOut ? "border-success/40 bg-success/[0.06]" : "border-border bg-card",
    )} data-testid="milestone-card">
      <CardContent className={cn("p-4", compact && "p-3")}>
        <div className="flex items-start gap-3">
          

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-xl font-bold tabular-nums tracking-tight text-foreground"
                    data-testid="milestone-doors">
                {p.doors}
              </span>
              <span className="text-[13px] font-semibold text-foreground">verified doors {when}</span>
            </div>
            {/* The instruction. This is the line that moves someone off the
                sidewalk, so it is the server's copy verbatim. */}
            <p className="mt-0.5 text-[13px] font-medium text-foreground/90" data-testid="milestone-headline">
              {p.headline}
            </p>
          </div>

          {p.earnedCents > 0 && (
            <span className="shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-success"
                  data-testid="milestone-earned">
              {usd(p.earnedCents)} earned
            </span>
          )}
        </div>

        {!p.toppedOut && (
          <div className="mt-3" aria-hidden="true">
            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
                   style={{ width: `${p.pct}%` }} data-testid="milestone-bar" />
            </div>
          </div>
        )}

        {/* The whole ladder, so a rep can see the money sitting ahead of them
            rather than only the next step. Cleared rungs read as banked. */}
        <div className="mt-3 flex flex-wrap gap-1.5" data-testid="milestone-rungs">
          {data.rungs.map(r => {
            const cleared = p.doors >= r.doors;
            return (
              <span key={r.doors} data-testid={`milestone-rung-${r.doors}`}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums",
                  cleared
                    ? "bg-success/10 text-success"
                    : "bg-secondary text-muted-foreground",
                )}>
                {r.doors}: {usd(r.rewardCents)}
              </span>
            );
          })}
        </div>

        {/* State the rule rather than hiding it. A rep who learns at payroll
            that re-knocks and unverified taps did not count feels cheated; a rep
            who was told up front just knocks more doors, which is the point. */}
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-muted-foreground"
           data-testid="milestone-rule">
          
          <span>Counts each address once, and only when GPS confirms you were there. Paid on your commission statement.</span>
        </p>
      </CardContent>
    </Card>
  );
}

/** Header line for the Spiffs page. Renders nothing when the ladder is off. */
export function MilestoneSection() {
  const { data } = useMyMilestones();
  if (!data?.enabled) return null;
  return (
    <section className="space-y-2" data-testid="milestone-section">
      <SectionLabel className="flex items-center gap-1.5">
        
        Door bonus · {data.periodLabel}
      </SectionLabel>
      <MilestoneCard />
    </section>
  );
}
