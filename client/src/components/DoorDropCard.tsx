// ── Door drops, as the rep sees them ─────────────────────────────────────────
// Every other incentive card on this screen is a TARGET: hit 100 doors, close by
// 6pm, hold a streak. This one is the opposite, and the copy has to carry that
// difference without lying about it.
//
// WHAT THIS CARD DELIBERATELY DOES NOT SHOW:
//
//   a percentage   — turns a field app into a slot-machine readout, and invites
//                    a rep to work out whether the next door is "worth" knocking
//   a countdown    — "37 doors to go" hands back the deterministic counter this
//                    whole mechanic exists to avoid. The moment a rep can count
//                    to the payout, the doors before it feel worthless.
//   a progress bar — same problem wearing nicer clothes.
//
// What it shows instead is the honest shape: any door can pay, and a long dry
// run means one is coming. That is true, it is all that is true, and it is the
// only framing under which the next door is always the one that might pay.
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { Gift, Sparkles } from "lucide-react";
import { usd } from "@shared/doorDrop";

export interface DoorDropCardData {
  enabled: boolean;
  statusLine: string;
  doorsSinceLastDrop: number;
  dropsToday: number;
  earnedTodayCents: number;
  band: { minCents: number; maxCents: number };
}

export function useMyDoorDrops(enabled = true) {
  return useQuery<DoorDropCardData>({
    queryKey: ["/api/me/door-drops"],
    // Same cadence as the ladder: the only thing that moves this is a knock,
    // and every knock already invalidates this key at the call site.
    refetchInterval: 60_000,
    enabled,
  });
}

export function DoorDropCard({ compact = false }: { compact?: boolean }) {
  const { data, isLoading } = useMyDoorDrops();

  if (isLoading) return <Skeleton className="h-[92px] w-full rounded-2xl" data-testid="door-drops-loading" />;
  // Off means absent. An empty drop card would advertise a bonus this org does
  // not pay, which costs more trust than never mentioning it.
  if (!data?.enabled) return null;

  const wonToday = data.earnedTodayCents > 0;

  return (
    <Card className={cn(
      "overflow-hidden rounded-2xl border",
      wonToday ? "border-amber-500/40 bg-amber-500/[0.06]" : "border-border bg-card",
    )} data-testid="door-drop-card">
      <CardContent className={cn("p-4", compact && "p-3")}>
        <div className="flex items-start gap-3">
          <div className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-xl",
            wonToday ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                     : "bg-primary/15 text-primary",
          )}>
            {wonToday ? <Sparkles className="h-5 w-5" aria-hidden="true" />
                      : <Gift className="h-5 w-5" aria-hidden="true" />}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[13px] font-semibold text-foreground">Door drops</span>
              <span className="text-[12px] tabular-nums text-muted-foreground">
                {usd(data.band.minCents)}–{usd(data.band.maxCents)}
              </span>
            </div>
            {/* The server's copy verbatim — it is the one place that knows how
                dry the run has been, and the phrasing is deliberate. */}
            <p className="mt-0.5 text-[13px] font-medium text-foreground/90" data-testid="door-drop-status">
              {data.statusLine}
            </p>
          </div>

          {wonToday && (
            <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-amber-700 dark:text-amber-400"
                  data-testid="door-drop-earned">
              {usd(data.earnedTodayCents)} today
            </span>
          )}
        </div>

        {/* Same rule statement as the ladder, and for the same reason: a rep who
            finds out at payroll that re-knocks did not count feels cheated. A rep
            told up front knocks more addresses, which is the entire point. */}
        <p className="mt-2 text-[12px] text-muted-foreground" data-testid="door-drop-rule">
          Lands on verified doors only, at random. Paid on your commission statement.
        </p>
      </CardContent>
    </Card>
  );
}

/** Section wrapper for the Spiffs page. Renders nothing when drops are off. */
export function DoorDropSection() {
  const { data } = useMyDoorDrops();
  if (!data?.enabled) return null;
  return (
    <section className="space-y-2" data-testid="door-drop-section">
      <SectionLabel className="flex items-center gap-1.5">
        <Gift className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        Door drops
      </SectionLabel>
      <DoorDropCard />
    </section>
  );
}
