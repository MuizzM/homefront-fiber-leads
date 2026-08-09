// ── What the floor hears ─────────────────────────────────────────────────────
// Door-knocking is solitary work with long stretches of nothing. A rep twelve
// doors into a dead street has no idea that two blocks over somebody just closed
// one — and that silence is the thing worth fixing, because the cheapest
// motivator available is knowing the doors ARE converting today, for someone
// standing in the same weather.
//
// Two surfaces, one query:
//   · a bell with an unread count, in the header
//   · the feed itself — newest first, dense, no interactions to maintain
//
// DELIBERATELY NOT A SOCIAL FEED. No likes, no comments, no replies. Every one
// of those turns a motivator into an obligation, and an obligation is a thing a
// rep learns to ignore. This is a scoreboard that scrolls.
//
// A rep never sees their own win here — the server filters it out of both the
// list and the count, because being told about the sale you just made reads as
// noise and teaches people to stop looking.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTabActive } from "@/lib/tabActivity";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { BadgeDollarSign, Bell, Flame, Megaphone, PartyPopper } from "lucide-react";
import { agoLabel, type AnnouncementKind } from "@shared/teamFeed";

export interface FeedItem {
  id: number;
  kind: AnnouncementKind;
  actorRepId: number;
  actorName: string;
  headline: string;
  body: string;
  amountCents?: number;
  createdAtMs: number;
}

export interface FeedPayload {
  items: FeedItem[];
  unread: number;
  latestId: number;
}

const FEED_KEY = ["/api/announcements"];

/**
 * The feed, shared by the bell and the list so the badge can never disagree with
 * what opening it shows.
 *
 * Polled as well as pushed: the SSE stream only runs while the map is mounted,
 * so polling is what makes the feed correct on every OTHER screen rather than a
 * surface that silently stops updating when a rep switches tabs.
 */
export function useTeamFeed(enabled = true) {
  // Hidden kept tab: no feed polling for a surface nobody can see. Consumers
  // rendered in the shell (outside any stage) read the default `true` and are
  // unaffected; the Today stage's copy pauses with its tab.
  const tabActive = useTabActive();
  return useQuery<FeedPayload>({
    queryKey: FEED_KEY,
    refetchInterval: tabActive ? 45_000 : false,
    enabled,
  });
}

/** Push a live frame into the cached feed without a refetch. Called from the
 *  map's stream subscription. */
export function applyLiveAnnouncement(qc: ReturnType<typeof useQueryClient>, a: FeedItem): void {
  qc.setQueryData<FeedPayload>(FEED_KEY, prev => {
    if (!prev) return prev;
    // The stream can re-deliver across a reconnect, and the server's dedupe is
    // per-EVENT, not per-delivery. Guarding on id here keeps a reconnect from
    // stacking the same win twice in the list.
    if (prev.items.some(i => i.id === a.id)) return prev;
    return {
      items: [a, ...prev.items].slice(0, 60),
      unread: prev.unread + 1,
      latestId: Math.max(prev.latestId, a.id),
    };
  });
}

const KIND_ICON: Record<AnnouncementKind, typeof Flame> = {
  sale: PartyPopper,
  hot_streak: Flame,
  promo: BadgeDollarSign,
  update: Megaphone,
};

const KIND_TONE: Record<AnnouncementKind, string> = {
  sale: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  hot_streak: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  // A promo has money attached and a deadline behind it — amber, same language
  // the Live Slot uses for "clock running".
  promo: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  // An update is news. Neutral on purpose: it must not compete with the two
  // registers that mean "act now".
  update: "bg-secondary text-muted-foreground",
};

// Exported for the Messages hub's announcements tab — the same row the bell
// sheet renders, so an announcement looks identical wherever it is read.
export function FeedRow({ item, now }: { item: FeedItem; now: number }) {
  const Icon = KIND_ICON[item.kind] ?? PartyPopper;
  return (
    <li className="flex items-start gap-3 py-3" data-testid={`feed-item-${item.id}`}>
      <div className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-xl", KIND_TONE[item.kind])}>
        <Icon className="h-4.5 w-4.5 h-[18px] w-[18px]" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-snug text-foreground">{item.headline}</p>
        <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{item.body}</p>
      </div>
      <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-muted-foreground">
        {agoLabel(item.createdAtMs, now)}
      </span>
    </li>
  );
}

/** Header bell. Renders the count, opens the feed, clears on open. */
export function TeamFeedBell({ className }: { className?: string }) {
  const { data } = useTeamFeed();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const unread = data?.unread ?? 0;

  const clear = useMutation({
    mutationFn: async (upToId: number) => {
      const res = await apiRequest("POST", "/api/announcements/read", { upToId });
      return res.json();
    },
    // The badge clears the moment the sheet opens rather than after the round
    // trip: a count that lingers for 300ms after you've read the thing feels
    // broken, and the server call is monotonic so a failure is self-healing.
    onMutate: () => {
      qc.setQueryData<FeedPayload>(FEED_KEY, prev => (prev ? { ...prev, unread: 0 } : prev));
    },
    onSettled: () => { qc.invalidateQueries({ queryKey: FEED_KEY }); },
  });

  const onOpen = (next: boolean) => {
    setOpen(next);
    if (next && (data?.latestId ?? 0) > 0) clear.mutate(data!.latestId);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => onOpen(true)}
        aria-label={unread > 0 ? `Team activity, ${unread} new` : "Team activity"}
        data-testid="team-feed-bell"
        className={cn("relative grid h-10 w-10 place-items-center rounded-xl text-foreground", FOCUS, className)}
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {unread > 0 && (
          <span
            data-testid="team-feed-unread"
            className="absolute right-1 top-1 min-w-[18px] rounded-full bg-primary px-1 text-[10px] font-bold leading-[18px] text-primary-foreground tabular-nums"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      <TeamFeedSheet open={open} onOpenChange={onOpen} />
    </>
  );
}

/** The newest announcement, inline at the top of the home screen.
 *
 *  The bell alone is not enough for the thing a manager most wants read. A promo
 *  or a schedule change posted at 7am sits behind a badge that a rep walking
 *  between doors has no reason to tap, and "the payout changed today" should not
 *  require curiosity to reach someone.
 *
 *  So: ONE line, only while it is UNREAD, tapping opens the full feed. It
 *  disappears the moment the feed is opened, which is what keeps it from
 *  becoming another permanent slab on a screen that already fought that battle
 *  (see the Live Slot comment in Today.tsx — five systems each wanting a card is
 *  how a home screen turns into a slot machine).
 *
 *  Deliberately NOT separately dismissible: reading it dismisses it. An X would
 *  train reps to swipe the announcement away without reading it, which is the
 *  exact failure this exists to prevent. */
export function TeamFeedHeadline({ className }: { className?: string }) {
  const { data } = useTeamFeed();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const clear = useMutation({
    mutationFn: async (upToId: number) => {
      const res = await apiRequest("POST", "/api/announcements/read", { upToId });
      return res.json();
    },
    // Optimistic: the strip must vanish on tap, not after the round trip.
    onMutate: async (upToId: number) => {
      await qc.cancelQueries({ queryKey: FEED_KEY });
      qc.setQueryData<FeedPayload>(FEED_KEY, prev =>
        prev ? { ...prev, unread: 0, latestId: Math.max(prev.latestId, upToId) } : prev);
    },
    onSettled: () => { qc.invalidateQueries({ queryKey: FEED_KEY }); },
  });

  const unread = data?.unread ?? 0;
  const item = data?.items?.[0];
  const onOpen = (next: boolean) => {
    setOpen(next);
    if (next && (data?.latestId ?? 0) > 0) clear.mutate(data!.latestId);
  };

  // Keep the sheet mounted while it is open even after `unread` drops to 0 —
  // returning null on tap would unmount the sheet along with the strip.
  if ((unread <= 0 || !item) && !open) return null;

  const Icon = item ? (KIND_ICON[item.kind] ?? PartyPopper) : PartyPopper;

  return (
    <>
      {unread > 0 && item && (
        <button
          type="button"
          onClick={() => onOpen(true)}
          data-testid="team-feed-headline"
          aria-label={`${item.headline}. ${unread} new. Open team activity.`}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-xl border border-primary/20 bg-primary/[0.07] px-3 py-2.5 text-left transition-transform active:scale-[.99] hover:border-primary/40",
            FOCUS, className,
          )}
        >
          <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-lg", KIND_TONE[item.kind])}>
            <Icon className="h-[15px] w-[15px]" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold leading-snug text-foreground">{item.headline}</span>
            <span className="block truncate text-[12px] leading-snug text-muted-foreground">{item.body}</span>
          </span>
          {unread > 1 && (
            <span className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-bold leading-[18px] text-primary-foreground tabular-nums">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      )}
      <TeamFeedSheet open={open} onOpenChange={onOpen} />
    </>
  );
}

export function TeamFeedSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data, isLoading } = useTeamFeed(open);
  // One clock for the whole list, ticking while it is open — otherwise every
  // row's "2m" is frozen at the moment the sheet mounted. Hidden kept tab:
  // the tick's re-render is wasted on a display:none tree, so it pauses (ref,
  // not dep — re-arming the interval on every visibility flip resets phase).
  const tabActive = useTabActive();
  const tabActiveRef = useRef(true);
  tabActiveRef.current = tabActive;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const t = setInterval(() => { if (tabActiveRef.current) setNow(Date.now()); }, 30_000);
    return () => clearInterval(t);
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-md p-0" data-testid="team-feed-sheet">
        <SheetHeader className="border-b border-border px-4 py-3">
          <SheetTitle className="text-base">Team activity</SheetTitle>
        </SheetHeader>
        <div className="max-h-[calc(100vh-4rem)] overflow-y-auto px-4">
          {isLoading && <Skeleton className="mt-4 h-24 w-full rounded-2xl" data-testid="team-feed-loading" />}
          {!isLoading && !data?.items.length && (
            // An empty feed is the normal state at 7am, not a failure. It says
            // what will fill it, so nobody wonders whether it is broken.
            <p className="py-10 text-center text-[13px] text-muted-foreground" data-testid="team-feed-empty">
              Nothing yet today. When somebody on the team closes one, it lands here.
            </p>
          )}
          <ul className="divide-y divide-border">
            {data?.items.map(item => <FeedRow key={item.id} item={item} now={now} />)}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Toast the wins that arrive while the app is open.
 *
 * Rate-limited on purpose. On a good Saturday a 12-rep team can close often
 * enough that an unthrottled toast per sale would cover the map a rep is trying
 * to work — and an incentive that gets in the way of the work stops being an
 * incentive. One toast per window; the rest are still in the feed and the count.
 */
export function useAnnouncementToasts(
  notify: (a: FeedItem) => void, windowMs = 45_000,
): (a: FeedItem) => void {
  const lastAt = useRef(0);
  return (a: FeedItem) => {
    const now = Date.now();
    if (now - lastAt.current < windowMs) return;
    lastAt.current = now;
    notify(a);
  };
}
