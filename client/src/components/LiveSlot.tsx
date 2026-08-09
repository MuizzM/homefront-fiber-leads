// ── The Live Slot ────────────────────────────────────────────────────────────
//
// Replaces the stack of four incentive cards on Today with exactly one, plus a
// one-line chip for whatever else is running.
//
// Measured on the screen it replaces: MomentumOffer + CampaignStrip +
// MilestoneCard + DoorDropCard render unconditionally, ~440px of cards under a
// ~85px greeting and a ~140px stat block. On a 390x740 phone a rep with
// everything live sees nothing else without scrolling — and a screen that looks
// like a slot machine gets read like one.
//
// The ranking is pure and lives in shared/liveSlot.ts so it can be reasoned
// about and tested without a browser. This file only draws it.
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { ChevronRight } from "lucide-react";
import {
  resolveLiveSlot, msLeft, countdownLabel, isUrgent,
  type LiveItem } from "@shared/liveSlot";
import { usd } from "@shared/moneyFormat";


/** One clock for the card, ticking only while something is actually counting
 *  down. A setInterval running against a ladder with no deadline is a wakeup a
 *  field phone pays for and nobody sees. */
function useTick(active: boolean, everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs]);
  return now;
}

export function LiveSlot({ items, className }: { items: LiveItem[]; className?: string }) {
  // Tick when anything has a deadline at all.
  const hasClock = items.some(i => i.endsAtMs != null);
  const now = useTick(hasClock);
  const { primary, otherCount, otherRewardCents } = resolveLiveSlot(items, now);

  // Absence is the correct rendering of nothing. No "no SPIFFs active"
  // placeholder — an empty state for each of five systems is the clutter this
  // component exists to remove.
  if (!primary) return null;

  const left = msLeft(primary, now);
  const urgent = isUrgent(left);
  const label = countdownLabel(left);

  return (
    <div className={cn("space-y-2", className)} data-testid="live-slot">
      <Link
        href="/incentives"
        data-testid={`live-slot-${primary.kind}`}
        className={cn(
          "block rounded-2xl border p-4 transition-colors active:scale-[.99]",
          urgent
            ? "border-amber-500/50 bg-amber-500/[0.10]"
            : "border-amber-500/30 bg-amber-500/[0.06] hover:border-amber-500/45",
          FOCUS,
        )}
      >
        <div className="flex items-start gap-3">
          

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                Live now
              </span>
              {/* The clock. Under ten minutes it turns red and nothing else on
                  the card competes with it. No pulsing — a permanently animating
                  element reads as cheap and costs battery on a shift-long phone. */}
              {label && (
                <span
                  data-testid="live-slot-countdown"
                  className={cn(
                    "shrink-0 text-[12px] font-bold tabular-nums transition-colors",
                    urgent ? "text-destructive" : "text-amber-700 dark:text-amber-400",
                  )}
                >
                  {label} left
                </span>
              )}
            </div>

            <p className="mt-0.5 text-[14px] font-bold leading-snug text-foreground" data-testid="live-slot-headline">
              {primary.headline}
            </p>
            {primary.nextStep && (
              <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground" data-testid="live-slot-next">
                {primary.nextStep}
              </p>
            )}
          </div>

          <span className="shrink-0 text-[17px] font-bold tabular-nums text-amber-700 dark:text-amber-400">
            {usd(primary.rewardCents)}
          </span>
        </div>

        {primary.pct > 0 && primary.pct < 100 && (
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-amber-500/15" aria-hidden="true">
            <div
              className="h-full rounded-full bg-amber-500 transition-[width] duration-500 ease-out"
              style={{ width: `${primary.pct}%` }}
              data-testid="live-slot-bar"
            />
          </div>
        )}
      </Link>

      {/* Everything else, as ONE line. The combined value is the reason to tap
          through — "2 more active" alone is not a reason to do anything. */}
      {otherCount > 0 && (
        <Link
          href="/incentives"
          data-testid="live-slot-more"
          className={cn(
            "flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-secondary/50",
            FOCUS,
          )}
        >
          <span className="flex-1">
            {otherCount} more running
            {otherRewardCents > 0 && <span className="text-foreground"> · {usd(otherRewardCents)} on the table</span>}
          </span>
          <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
        </Link>
      )}
    </div>
  );
}
