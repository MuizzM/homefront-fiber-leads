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
  return useQuery<FeedPayload>({
    queryKey: FEED_KEY,
    refetchInterval: 45_000,
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

function FeedRow({ item, now }: { item: FeedItem; now: number }) {
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

export function TeamFeedSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data, isLoading } = useTeamFeed(open);
  // One clock for the whole list, ticking while it is open — otherwise every
  // row's "2m" is frozen at the moment the sheet mounted.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
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
