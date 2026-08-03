// ── The hot-streak offer ─────────────────────────────────────────────────────
// This is the only card in the app that appears UNBIDDEN, mid-shift, because
// the rep just did something. It gets one job: make the next forty minutes feel
// worth pushing through.
//
// TWO STATES, AND THE COLD ONE MATTERS AS MUCH AS THE HOT ONE.
//
//   ARMED — a live promise with a ticking clock and a dollar amount. Loud,
//   urgent, impossible to mistake for the rest of the UI.
//
//   CLIMBING — no offer yet, but the meter is visible. This is the part most
//   incentive systems get wrong by hiding: a mechanic nobody can see cannot
//   change behaviour. A rep watching "62 / 55 to unlock" learns that
//   conversations move the needle and door-count alone does not, which is
//   exactly the lesson we want them to draw.
//
// The offer is served from a persisted row, not recomputed here, so the amount
// and the deadline on screen are the ones the org has actually committed to.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Flame, Timer, TrendingUp } from "lucide-react";
import { offerCountdown, usd } from "@shared/momentumSpiff";

export interface MomentumCardData {
  enabled: boolean;
  offer: {
    id: number; amountCents: number; expiresAtMs: number; score: number;
    headline: string; callToAction: string; remainingMs: number;
  } | null;
  score: number;
  armAtScore: number;
  nextAmountCents: number;
  doorsInWindow: number;
  conversationsInWindow: number;
  interestSignalsInWindow: number;
  windowMinutes: number;
  earnedTodayCents: number;
}

export function useMomentum(enabled = true) {
  return useQuery<MomentumCardData>({
    queryKey: ["/api/me/momentum"],
    // Tighter than the other incentive cards on purpose: an offer has a clock,
    // and a stale card showing a promise that already expired is worse than no
    // card. Every knock also invalidates this key at the call site.
    refetchInterval: 30_000,
    enabled,
  });
}

/** Ticks every 15s so the countdown stays honest without a per-second render
 *  loop on a phone that is also drawing a map. */
function useTick(active: boolean): number {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN(n => n + 1), 15_000);
    return () => clearInterval(t);
  }, [active]);
  return Date.now();
}

export function MomentumOffer() {
  const { data } = useMomentum();
  const now = useTick(!!data?.offer);

  if (!data?.enabled) return null;

  // ── ARMED ─────────────────────────────────────────────────────────────────
  if (data.offer) {
    const remaining = data.offer.expiresAtMs - now;
    // Under ten minutes the promise is about to go. That has to look different,
    // or "38m left" and "4m left" read the same at arm's length in sunlight.
    const critical = remaining > 0 && remaining <= 10 * 60_000;
    if (remaining <= 0) return null; // expired between polls — never show a dead promise

    return (
      <Card
        data-testid="momentum-offer"
        className={cn(
          "overflow-hidden rounded-2xl border-2",
          critical
            ? "border-red-500/60 bg-red-500/[0.08]"
            : "border-amber-500/60 bg-amber-500/[0.08]",
        )}
      >
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className={cn(
              "grid h-11 w-11 shrink-0 place-items-center rounded-xl",
              critical ? "bg-red-500/20 text-red-600 dark:text-red-400"
                       : "bg-amber-500/20 text-amber-600 dark:text-amber-400",
            )}>
              <Flame className="h-6 w-6" aria-hidden="true" />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-2xl font-bold tabular-nums tracking-tight text-foreground"
                      data-testid="momentum-amount">
                  {usd(data.offer.amountCents)}
                </span>
                <span className="text-[13px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                  You're hot
                </span>
              </div>
              {/* What they DID. Specific, because "you're on fire!" is a slogan
                  and a rep tunes it out the second time they see it. */}
              <p className="mt-0.5 text-[13px] font-medium text-foreground/90" data-testid="momentum-headline">
                {data.offer.headline}
              </p>
            </div>

            <span className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-bold tabular-nums",
              critical ? "bg-red-500/20 text-red-700 dark:text-red-300"
                       : "bg-amber-500/20 text-amber-700 dark:text-amber-300",
            )} data-testid="momentum-countdown">
              <Timer className="h-3.5 w-3.5" aria-hidden="true" />
              {offerCountdown(data.offer.expiresAtMs, now)}
            </span>
          </div>

          {/* The instruction, given the most weight on the card. */}
          <p className="mt-3 rounded-xl bg-background/60 px-3 py-2 text-sm font-semibold text-foreground"
             data-testid="momentum-cta">
            {data.offer.callToAction}
          </p>
        </CardContent>
      </Card>
    );
  }

  // ── CLIMBING ──────────────────────────────────────────────────────────────
  // Only once there is something real to show. A meter at 4/55 on the first
  // door of the day is noise, and a bar that never moves teaches a rep to
  // ignore the whole mechanic.
  if (data.score < Math.round(data.armAtScore * 0.5) || data.nextAmountCents <= 0) return null;

  const pct = Math.max(0, Math.min(100, Math.round((data.score / Math.max(1, data.armAtScore)) * 100)));
  return (
    <Card className="overflow-hidden rounded-2xl border border-border bg-card" data-testid="momentum-meter">
      <CardContent className="p-3">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <TrendingUp className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-foreground" data-testid="momentum-meter-headline">
              Warming up — {usd(data.nextAmountCents)} bonus if you get hot
            </p>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-amber-500 transition-[width] duration-500 ease-out"
                   style={{ width: `${pct}%` }} data-testid="momentum-meter-bar" />
            </div>
          </div>
        </div>
        {/* Names the lever. A rep who reads this once knows that talking to
            people moves it and speed-walking past doors does not. */}
        <p className="mt-2 text-[12px] text-muted-foreground" data-testid="momentum-meter-hint">
          {data.conversationsInWindow} conversation{data.conversationsInWindow === 1 ? "" : "s"} in the last{" "}
          {Math.round(data.windowMinutes / 60)}h. More doors opening = hotter.
        </p>
      </CardContent>
    </Card>
  );
}
