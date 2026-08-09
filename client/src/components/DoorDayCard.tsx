// ── The genuine-day bonus, as the rep sees it ────────────────────────────────
// "60 genuine doors today → $50." The card's whole job is to make the word
// GENUINE visible BEFORE a rep tries the shortcut, not after payroll.
//
// So it shows three things the counter would otherwise hide:
//
//   what counted            the number the ledger will actually pay on
//   what did NOT, and why   re-knocks, doors logged seconds apart, doors past
//                           the hourly ceiling — stated, never silently dropped
//   how long the day is     because 60 doors in 25 minutes is not a day, and a
//                           rep who cleared 60 and got nothing deserves the
//                           reason in words rather than a bug report
//
// A silent anti-gaming filter reads as a broken counter. A stated one reads as
// a rule, and a rep who knows the rule just knocks the doors.
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { usd } from "@shared/moneyFormat";
import { formatSpan } from "@shared/genuineDoors";

export interface DoorDayCardData {
  enabled: boolean;
  target: number;
  counted: number;
  remaining: number;
  pct: number;
  rewardCents: number;
  spanMinutes: number;
  minSpanMinutes: number;
  spanShort: boolean;
  earned: boolean;
  needsReview: boolean;
  headline: string;
  rejected: { same_address: number; too_fast: number; hour_cap: number };
  dayLabel?: string;
  minGapSeconds?: number;
  maxPerRollingHour?: number;
}

export function useMyDoorDay(enabled = true) {
  return useQuery<DoorDayCardData>({
    queryKey: ["/api/me/door-day"],
    refetchInterval: 60_000,
    enabled,
  });
}

export function DoorDayCard() {
  const { data, isLoading } = useMyDoorDay();

  if (isLoading) return <Skeleton className="h-[132px] w-full rounded-2xl" data-testid="door-day-loading" />;
  // A disabled bonus renders NOTHING — never an empty bar implying money this
  // org does not pay.
  if (!data?.enabled) return null;

  const dropped = data.rejected
    ? data.rejected.same_address + data.rejected.too_fast + data.rejected.hour_cap
    : 0;

  return (
    <Card
      className={cn(
        "overflow-hidden rounded-2xl border",
        data.needsReview ? "border-amber-500/40 bg-amber-500/[0.06]"
          : data.earned ? "border-emerald-500/40 bg-emerald-500/[0.06]"
          : "border-border bg-card",
      )}
      data-testid="door-day-card"
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-xl font-bold tabular-nums tracking-tight text-foreground" data-testid="door-day-counted">
                {data.counted}
              </span>
              <span className="text-[13px] font-semibold text-foreground">
                of {data.target} genuine doors today
              </span>
            </div>
            <p className="mt-0.5 text-[13px] font-medium text-foreground/90" data-testid="door-day-headline">
              {data.headline}
            </p>
          </div>

          <span className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums",
            data.earned ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                        : "bg-secondary text-muted-foreground",
          )} data-testid="door-day-reward">
            {data.earned ? `${usd(data.rewardCents)} earned` : usd(data.rewardCents)}
          </span>
        </div>

        {!data.earned && (
          <div className="mt-3" aria-hidden="true">
            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
                   style={{ width: `${data.pct}%` }} data-testid="door-day-bar" />
            </div>
          </div>
        )}

        {/* The clock, shown whenever the doors are there but the day is not —
            otherwise "60 of 60" with no payout is indistinguishable from a bug. */}
        {data.spanShort && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] font-medium text-amber-700 dark:text-amber-400"
             data-testid="door-day-span-warning">
            
            <span>
              Your {data.target} doors landed inside {formatSpan(data.spanMinutes)}. The bonus needs a full{" "}
              {formatSpan(data.minSpanMinutes)} on the doors.
            </span>
          </p>
        )}

        {data.needsReview && (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] font-medium text-amber-700 dark:text-amber-400"
             data-testid="door-day-review">
            
            <span>Today's location data has a problem. This bonus is held until a manager reviews it.</span>
          </p>
        )}

        {/* What did not count, and why. Never silent. */}
        {dropped > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5" data-testid="door-day-rejected">
            {data.rejected.same_address > 0 && (
              <li className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                {data.rejected.same_address} re-knock{data.rejected.same_address === 1 ? "" : "s"}
              </li>
            )}
            {data.rejected.too_fast > 0 && (
              <li className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                {data.rejected.too_fast} logged too close together
              </li>
            )}
            {data.rejected.hour_cap > 0 && (
              <li className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                {data.rejected.hour_cap} past the hourly cap
              </li>
            )}
          </ul>
        )}

        {/* State the rule up front. A rep told the rule knocks more doors; a rep
            who finds out at payroll feels cheated. */}
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-muted-foreground" data-testid="door-day-rule">
          
          <span>
            Each address counts once, only when GPS confirms you were there
            {data.maxPerRollingHour ? `, and at most ${data.maxPerRollingHour} an hour` : ""}. Paid on your commission statement.
          </span>
        </p>
      </CardContent>
    </Card>
  );
}

/** Header + card. Renders nothing when the bonus is off. */
export function DoorDaySection() {
  const { data } = useMyDoorDay();
  if (!data?.enabled) return null;
  return (
    <section className="space-y-2" data-testid="door-day-section">
      <SectionLabel className="flex items-center gap-1.5">
        
        Full day on the doors
      </SectionLabel>
      <DoorDayCard />
    </section>
  );
}
