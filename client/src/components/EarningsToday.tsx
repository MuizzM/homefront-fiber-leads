// ── The number a rep opens the app to see ───────────────────────────────────
//
// This replaces "Good morning, Marcus" as the largest thing on the home screen.
// The greeting was 27px bold and occupied the most valuable space above the
// fold while carrying no information at all — a rep opens this screen to find
// out where they stand, not to be greeted.
//
// ── BANKED AND PENDING NEVER MERGE ─────────────────────────────────────────
//
// The headline is money that is CERTAIN: hours already worked plus spiffs
// already in the ledger. Commission on today's sales is shown separately and
// labelled "pending", because a sale closed at 2pm can still fail
// qualification, sit behind a holdback, or charge back. A rep who reads "$340
// today" and is paid $180 on Friday stops trusting every number in the app,
// including the honest ones.
//
// When the rep's plan is percentage or tiered, the server returns null rather
// than a guess, and this shows the sale COUNT with no dollar figure. No number
// beats a wrong number.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { usd } from "@shared/dailyUpside";

export interface EarningsTodayData {
  bankedCents: number;
  hourlyCents: number;
  hourlyMinutes: number;
  spiffCents: number;
  salesToday: number;
  pendingCents: number | null;
  pendingBasis: "flat" | "unknown_structure" | "needs_sale_amounts" | "no_sales";
}

export function useEarningsToday(enabled = true) {
  return useQuery<EarningsTodayData>({
    queryKey: ["/api/me/earnings-today"],
    // Hourly ticks up while the rep is clocked in, so this cannot be static —
    // but a minute is plenty for a number measured in dollars.
    refetchInterval: 60_000,
    enabled,
  });
}

/** Count up to a new value. Money that jumps reads as a glitch; money that
 *  climbs reads as something you just earned. */
function useCountUp(target: number, ms = 300): number {
  const [shown, setShown] = useState(target);
  useEffect(() => {
    if (shown === target) return;
    const from = shown, delta = target - from, start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      // ease-out: fast then settling, so the last digits land softly.
      setShown(Math.round(from + delta * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return shown;
}

export function EarningsToday({ className }: { className?: string }) {
  const { data, isLoading } = useEarningsToday();
  const banked = data?.bankedCents ?? 0;
  const shown = useCountUp(banked);

  if (isLoading && !data) {
    return (
      <div className={cn("min-w-0", className)} data-testid="earnings-today-loading">
        <div className="h-[15px] w-24 rounded bg-muted" />
        <div className="mt-1.5 h-9 w-32 rounded bg-muted" />
      </div>
    );
  }

  const sales = data?.salesToday ?? 0;
  const pending = data?.pendingCents ?? null;

  return (
    <div className={cn("min-w-0", className)} data-testid="earnings-today">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Earned today
      </div>
      <div
        className="mt-0.5 text-[34px] font-bold leading-none tracking-tight tabular-nums text-foreground"
        data-testid="earnings-today-banked"
      >
        {usd(shown)}
      </div>

      {/* The second line is where sales live, always as a COUNT and only
          sometimes as money. */}
      {sales > 0 && (
        <div className="mt-1 text-[13px] text-muted-foreground" data-testid="earnings-today-pending">
          {pending != null ? (
            <>
              <span className="font-semibold text-foreground tabular-nums">+{usd(pending)}</span>{" "}
              pending from {sales} sale{sales === 1 ? "" : "s"}
            </>
          ) : (
            <>
              <span className="font-semibold text-foreground tabular-nums">{sales}</span>{" "}
              sale{sales === 1 ? "" : "s"} today · commission lands on your statement
            </>
          )}
        </div>
      )}
      {sales === 0 && banked > 0 && (
        <div className="mt-1 text-[13px] text-muted-foreground" data-testid="earnings-today-breakdown">
          {data!.hourlyMinutes > 0 && `${Math.floor(data!.hourlyMinutes / 60)}h ${data!.hourlyMinutes % 60}m on the clock`}
          {data!.hourlyMinutes > 0 && data!.spiffCents > 0 && " · "}
          {data!.spiffCents > 0 && `${usd(data!.spiffCents)} in bonuses`}
        </div>
      )}
    </div>
  );
}
