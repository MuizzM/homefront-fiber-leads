// ── Live SPIFF campaigns, as the rep sees them ───────────────────────────────
// The whole point of a campaign is that a rep can act on it RIGHT NOW, so this
// component is built around three things and nothing else:
//
//   the money      — big, first, unambiguous
//   how close      — a real number in the trigger's own unit ("18 of 40 knocks")
//   how long left  — a countdown that ticks, because urgency decays silently
//
// It deliberately does NOT show slogans, badges, or the campaign's fine print.
// A rep glances at this between doors. Anything that is not "what do I do next"
// is noise, and noise is how a motivation surface becomes wallpaper by Thursday.
//
// Progress comes from the server, computed by the SAME pure function that
// decides the award (shared/spiffCampaign.ts), so the bar can never promise
// something the ledger then refuses to pay.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTabActive } from "@/lib/tabActivity";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionLabel } from "@/components/ui/page-scaffold";
import type { CampaignTrigger } from "@shared/spiffCampaign";

export interface RepCampaign {
  id: number;
  name: string;
  description: string;
  rewardCents: number;
  trigger: CampaignTrigger;
  endsAtMs: number;
  progress: {
    current: number; target: number; pct: number; met: boolean;
    msRemaining: number; headline: string; nextStep: string;
  };
  earnedCents: number;
}

function usd(cents: number): string {
  const v = Math.trunc(Number.isFinite(cents) ? cents : 0);
  const whole = Math.floor(Math.abs(v) / 100).toLocaleString("en-US");
  const rem = Math.abs(v) % 100;
  return rem === 0 ? `$${whole}` : `$${whole}.${String(rem).padStart(2, "0")}`;
}

/** "2h 14m" / "48m" / "Ends soon". Hours+minutes above an hour, minutes below —
 *  seconds would make the whole card twitch once a second for no information. */
export function countdown(ms: number): string {
  if (ms <= 0) return "Ended";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "Ends soon";
  const days = Math.floor(mins / 1440);
  if (days >= 1) return `${days}d ${Math.floor((mins % 1440) / 60)}h left`;
  const hours = Math.floor(mins / 60);
  return hours >= 1 ? `${hours}h ${mins % 60}m left` : `${mins}m left`;
}

/** Under an hour the promise is about to expire — that is the moment the card
 *  has to look different, or the rep reads "2h left" and "12m left" the same. */
const isUrgent = (ms: number) => ms > 0 && ms <= 60 * 60_000;

export function useMyCampaigns(enabled = true) {
  const tabActive = useTabActive();
  return useQuery<{ campaigns: RepCampaign[] }>({
    queryKey: ["/api/me/campaigns"],
    // A minute is the right cadence: progress only moves when the rep knocks,
    // and every knock already invalidates this key at the call site.
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

/** A clock that re-renders once a minute so the countdown stays honest without
 *  a per-second render loop on a phone that is also drawing a map.
 *
 *  `active` is not optional by accident: this hook is called from CampaignCard,
 *  so a board of N campaigns starts N independent timers. A campaign ending
 *  next week has a label that will not change for days — it does not need one.
 *  MomentumOffer and LiveSlot already take the same gate. */
function useMinuteTick(active: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick(n => n + 1), 30_000);
    return () => clearInterval(t);
  }, [active]);
  return Date.now();
}

/** Countdown labels only move inside this window; past it the card reads
 *  "3 days left" and a 30s timer changes nothing on screen. */
const COUNTDOWN_LIVE_MS = 2 * 60 * 60_000;

export function CampaignCard({ campaign, compact = false }: { campaign: RepCampaign; compact?: boolean }) {
  const now = useMinuteTick(campaign.endsAtMs - Date.now() < COUNTDOWN_LIVE_MS);
  const remaining = Math.max(0, campaign.endsAtMs - now);
  const urgent = isUrgent(remaining);
  const { progress } = campaign;

  return (
    <Card
      data-testid={`campaign-${campaign.id}`}
      className={cn(
        "overflow-hidden rounded-2xl border transition-colors",
        progress.met
          ? "border-success/30 bg-success/[0.06]"
          : urgent
            ? "border-warning/50 bg-warning/[0.06]"
            : "border-border bg-card",
      )}
    >
      <CardContent className={cn("p-4", compact && "p-3")}>
        <div className="flex items-start gap-3">
          

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              {/* The money leads. Everything else is context for it. */}
              <span className="text-xl font-bold tabular-nums tracking-tight text-foreground"
                    data-testid={`campaign-reward-${campaign.id}`}>
                {usd(campaign.rewardCents)}
              </span>
              <span className="truncate text-[13px] font-semibold text-foreground">{campaign.name}</span>
            </div>
            <p className="mt-0.5 text-[13px] font-medium text-foreground/90"
               data-testid={`campaign-headline-${campaign.id}`}>
              {progress.headline}
            </p>
          </div>

          <span className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums",
            urgent && !progress.met ? "bg-warning/[0.12] text-warning"
                                    : "bg-secondary text-muted-foreground",
          )} data-testid={`campaign-countdown-${campaign.id}`}>
            
            {countdown(remaining)}
          </span>
        </div>

        {/* The bar is only meaningful for triggers with a real denominator. A
            per-sale campaign has no "80% of the way there" — every sale pays,
            so a bar would invent a finish line that does not exist. */}
        {campaign.trigger.kind !== "per_sale" && (
          <div className="mt-3" aria-hidden="true">
            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-500 ease-out",
                  progress.met ? "bg-success" : urgent ? "bg-warning" : "bg-primary",
                )}
                style={{ width: `${progress.pct}%` }}
                data-testid={`campaign-bar-${campaign.id}`}
              />
            </div>
          </div>
        )}

        {/* The next action, in the rep's own units. This is the line that moves
            someone off the sidewalk — never a slogan. */}
        {progress.nextStep && (
          <p className="mt-2 text-[13px] text-muted-foreground" data-testid={`campaign-next-${campaign.id}`}>
            {progress.nextStep}
          </p>
        )}
        {progress.met && campaign.earnedCents > 0 && (
          <p className="mt-2 text-[13px] font-semibold text-success"
             data-testid={`campaign-earned-${campaign.id}`}>
            {usd(campaign.earnedCents)} earned from this campaign
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The full board for the Spiffs page.
 *
 * Renders NOTHING when there are no live campaigns — an empty "no contests
 * running" panel is a standing reminder that nothing is happening, which is the
 * opposite of what this surface is for.
 */
export function CampaignBoard() {
  const { data, isLoading } = useMyCampaigns();
  const campaigns = data?.campaigns ?? [];

  if (isLoading) {
    return (
      <div className="space-y-2" aria-busy="true" data-testid="campaigns-loading">
        <Skeleton className="h-[104px] w-full rounded-2xl" />
      </div>
    );
  }
  if (!campaigns.length) return null;

  return (
    <section className="space-y-2" data-testid="campaign-board">
      <SectionLabel className="flex items-center gap-1.5">
        
        Live right now
      </SectionLabel>
      {campaigns.map(c => <CampaignCard key={c.id} campaign={c} />)}
    </section>
  );
}

/** One-line strip for the rep's home screen — the single most winnable campaign,
 *  so the app opens on something to chase. "Most winnable" is the one closest to
 *  done, tie-broken by the one ending soonest. */
export function CampaignStrip() {
  const { data } = useMyCampaigns();
  const campaigns = data?.campaigns ?? [];
  if (!campaigns.length) return null;

  const best = [...campaigns].sort((a, b) => {
    if (a.progress.met !== b.progress.met) return a.progress.met ? 1 : -1; // unfinished first
    if (b.progress.pct !== a.progress.pct) return b.progress.pct - a.progress.pct;
    return a.endsAtMs - b.endsAtMs;
  })[0];

  return <CampaignCard campaign={best} compact />;
}
