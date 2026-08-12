// ── Messages — the floor's room ──────────────────────────────────────────────
//
// This page has been three things. First it was a block on the Spiffs page
// nobody found. Then it was a manager-only broadcast console — the composer
// and the sent log — which fixed "where do I tell the floor" and quietly
// created the next problem: the floor still TALKED somewhere else. A text
// thread outside the app carried the questions, the answers, and half the
// morale, and every message there was a reason the app is not where reps look.
//
// So now it is the hub, for everyone on the floor, with three panes:
//
//   CHAT           — the two-way room. Every field role reads and writes.
//   ANNOUNCEMENTS  — the one-way feed. Managers get the composer + sent log
//                    they already had; reps get the feed itself.
//   BOARD          — today's race, compact. The full leaderboard is one tap
//                    away; this keeps the score inside the conversation.
//
// The page opened up (field.app.use, matching the API), but the POWER did not:
// composing, the sent log's read counts, and retraction stay behind the same
// capability the POST route enforces. Opening a room is not the same thing as
// handing everyone the megaphone.
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { can, type Role as AppRole } from "@shared/capabilities";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { PageHeader, SectionLabel } from "@/components/ui/page-scaffold";
import { Skeleton } from "@/components/ui/skeleton";
import { AnnouncementComposer } from "@/components/AnnouncementComposer";
import { FloorChat, useFloorChat } from "@/components/FloorChat";
import { ChatThreadList, GroupMembersSheet, useChatThreads, type ChatRoomTarget } from "@/components/ChatThreads";
import { FeedRow, useTeamFeed, type FeedPayload } from "@/components/TeamFeed";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChevronLeft, Loader2, Megaphone, MessagesSquare, Trash2, Trophy } from "lucide-react";
import { agoLabel, usd, type AnnouncementKind } from "@shared/teamFeed";
import { dmDisplayName } from "@shared/floorChat";
import type { TeamMember } from "@shared/schema";

interface SentItem {
  id: number;
  kind: AnnouncementKind;
  headline: string;
  body: string;
  amountCents?: number;
  actorName: string;
  createdAtMs: number;
  readCount: number;
  audience: number;
}

const SENT_KEY = ["/api/announcements/sent"];
const FEED_KEY = ["/api/announcements"];

type Tab = "chat" | "announcements" | "board";

export default function Messages() {
  const { user } = useAuth();
  const qc = useQueryClient();
  // Same capability the server enforces on POST /api/announcements, not a role
  // check — a team lead holds this permission, and a role list here would hide
  // the composer from people the API would happily let post.
  const canPost = can(user?.role as AppRole | undefined, "commission.structure.manage");

  const [tab, setTab] = useState<Tab>("chat");

  // Which room the chat tab is showing: the conversation list, the floor, or
  // one thread. List-first, messenger-style — the floor is pinned at the top
  // of the list, so the org's room is one tap and never hunted for.
  type RoomView = { t: "list" } | { t: "floor" } | { t: "thread"; id: number; title?: string };
  const [room, setRoom] = useState<RoomView>({ t: "list" });
  const [membersOpen, setMembersOpen] = useState(false);
  const roomThreadId = room.t === "thread" ? room.id : 0;
  // The members sheet belongs to ONE room — carrying its open state into the
  // next room would flash the wrong crew (or a dissolved one).
  useEffect(() => { setMembersOpen(false); }, [roomThreadId]);

  // Drafts live HERE, keyed per room: every tab or room switch unmounts the
  // pane, and state inside it would silently eat a half-typed message each
  // time. A draft follows its room — writing to Bo, checking the floor, and
  // coming back must land you mid-sentence where you left it.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftKey = room.t === "thread" ? `t:${room.id}` : "floor";
  const setDraftFor: Dispatch<SetStateAction<string>> = updater => setDrafts(d => ({
    ...d,
    [draftKey]: typeof updater === "function" ? (updater as (p: string) => string)(d[draftKey] ?? "") : updater,
  }));

  // Both counts live on the tabs, so the hub never hides news behind a pane
  // you are not looking at. Baseline polling here; the chat pane itself raises
  // the same query to its live cadence while mounted. The chat tab's number is
  // floor + threads — every room it fronts, one badge.
  const chatQ = useFloorChat();
  const feedQ = useTeamFeed();
  const threadsQ = useChatThreads(tab === "chat");
  const chatUnread = (chatQ.data?.unread ?? 0) + (chatQ.data?.threadsUnread ?? 0);
  const feedUnread = feedQ.data?.unread ?? 0;

  const activeThread = room.t === "thread"
    ? threadsQ.data?.threads.find(x => x.id === room.id)
    : undefined;
  // Moderation rights per room: capability holders on the floor and in
  // groups; NOBODY inside a DM — mirrored by the server, stated here so the
  // UI never offers a button the API would refuse.
  const roomModeratable = room.t === "thread" ? (activeThread?.kind === "group" && canPost) : canPost;
  const roomTitle = room.t === "thread"
    ? (activeThread
        ? (activeThread.kind === "dm" ? dmDisplayName(activeThread.members, Number(user?.id ?? -1)) : (activeThread.name ?? "Group"))
        // The list/sheet handed the name along; the threads query catches up.
        : (room.title ?? "Conversation"))
    : "The floor";

  // Zombie recovery: the open thread can vanish under you — removed from the
  // crew, or the room dissolved. The moment the fresh list says it's gone,
  // route home instead of leaving a dead room polling a 404 forever.
  const roomVanished = room.t === "thread"
    && threadsQ.isSuccess
    && !threadsQ.data.threads.some(x => x.id === roomThreadId);
  useEffect(() => {
    if (!roomVanished) return;
    setMembersOpen(false);
    setRoom({ t: "list" });
  }, [roomVanished]);

  const TABS: Array<{ id: Tab; label: string; icon: typeof MessagesSquare; badge: number }> = [
    { id: "chat", label: "Chat", icon: MessagesSquare, badge: chatUnread },
    // The feed count rides the tab only for people whose tab IS the feed. A
    // manager's tab is the composer + sent log — opening it reads nothing, so
    // a count there would never clear. Their unread stays on the bell.
    { id: "announcements", label: "Announcements", icon: Megaphone, badge: canPost ? 0 : feedUnread },
    { id: "board", label: "Board", icon: Trophy, badge: 0 },
  ];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 pt-5 pb-24 md:p-6">
      <PageHeader
        title="Messages"
        icon={MessagesSquare}
        subtitle="One room for the whole floor - the chat, the announcements, and the board."
      />

      {/* Same segmented-pill grammar as the leaderboard's range filter. */}
      <div
        className="no-scrollbar inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-xl border border-border bg-secondary/60 p-1"
        role="tablist"
        aria-label="Messages sections"
      >
        {TABS.map(t => {
          const on = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setTab(t.id)}
              data-testid={`tab-${t.id}`}
              className={cn(
                "inline-flex h-11 md:h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs font-semibold transition-colors",
                on ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                FOCUS,
              )}
            >
              
              {t.label}
              {t.badge > 0 && !on && (
                <span
                  data-testid={`tab-${t.id}-unread`}
                  aria-label={`${t.badge} unread`}
                  className="min-w-[18px] rounded-full bg-primary px-1 text-center text-2xs font-bold leading-[18px] text-primary-foreground tabular-nums"
                >
                  {t.badge > 9 ? "9+" : t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tab === "chat" && (
        room.t === "list" ? (
          <ChatThreadList canManage={canPost} onOpen={(target: ChatRoomTarget) => setRoom(target)} />
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setRoom({ t: "list" })}
                aria-label="Back to conversations"
                data-testid="chat-back"
                className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground", FOCUS)}
              >
                <ChevronLeft className="h-5 w-5" aria-hidden="true" />
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-semibold text-foreground" data-testid="chat-room-title">{roomTitle}</p>
                {activeThread?.kind === "group" && (
                  <p className="truncate text-[11px] text-muted-foreground">
                    {activeThread.members.map(m => m.name).join(", ")}
                  </p>
                )}
              </div>
              {activeThread?.kind === "group" && (
                <button
                  type="button"
                  onClick={() => setMembersOpen(true)}
                  aria-label="Group members"
                  data-testid="chat-members"
                  className={cn("inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground", FOCUS)}
                >
                  
                  {activeThread.members.length}
                </button>
              )}
            </div>
            {/* Keyed per room so pane state (ghosts, the history ledger, the
                read watermark) can never bleed between rooms, whatever path
                the navigation takes between them. */}
            <FloorChat
              key={draftKey}
              threadId={room.t === "thread" ? room.id : undefined}
              moderatable={roomModeratable}
              roomKind={room.t === "thread" ? (activeThread?.kind ?? "dm") : "floor"}
              roomName={room.t === "thread" ? roomTitle : undefined}
              onGone={() => {
                qc.invalidateQueries({ queryKey: ["/api/chat/threads"] });
                setRoom({ t: "list" });
              }}
              draft={drafts[draftKey] ?? ""}
              onDraftChange={setDraftFor}
            />
          </div>
        )
      )}
      {activeThread?.kind === "group" && (
        <GroupMembersSheet
          thread={activeThread}
          open={membersOpen}
          onOpenChange={setMembersOpen}
          canManage={canPost}
          onLeft={() => setRoom({ t: "list" })}
        />
      )}

      {tab === "announcements" && (
        canPost
          ? <div className="space-y-6"><AnnouncementComposer /><SentLog /></div>
          : <AnnouncementFeed />
      )}

      {tab === "board" && <BoardPanel />}
    </div>
  );
}

// ── Announcements, read side — what a rep sees on this tab ──────────────────
// The same rows the bell sheet renders, inline. Opening the tab clears the
// bell (one watermark serves both surfaces), exactly like opening the sheet.
function AnnouncementFeed() {
  const { data, isLoading, isError, refetch } = useTeamFeed();
  const qc = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const clear = useMutation({
    mutationFn: async (upToId: number) =>
      (await apiRequest("POST", "/api/announcements/read", { upToId })).json(),
    onMutate: () => {
      qc.setQueryData<FeedPayload>(FEED_KEY, prev => (prev ? { ...prev, unread: 0 } : prev));
    },
    onSettled: () => { qc.invalidateQueries({ queryKey: FEED_KEY }); },
  });

  // One attempt per watermark, not per render: without the ref, a failing
  // read endpoint would loop — optimistic unread:0, invalidate, refetch says
  // unread:1, effect refires, forever. Held at the attempted id on failure,
  // it retries only when something NEW arrives; the bell self-heals the rest.
  const latestId = data?.latestId ?? 0;
  const unread = data?.unread ?? 0;
  const attemptedRef = useRef(0);
  useEffect(() => {
    if (latestId <= attemptedRef.current || unread <= 0) return;
    attemptedRef.current = latestId;
    clear.mutate(latestId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on new news only
  }, [latestId, unread]);

  return (
    <section className="space-y-3" data-testid="announcement-feed">
      <SectionLabel>What the floor's been told</SectionLabel>
      {isLoading && <Skeleton className="h-24 w-full rounded-2xl" data-testid="announcement-feed-loading" />}
      {!isLoading && isError && (
        <div role="alert" className="rounded-2xl border border-border bg-card p-4 text-center" data-testid="announcement-feed-error">
          <p className="text-[13px] text-muted-foreground">Couldn't load the feed - new posts may be waiting.</p>
          <button onClick={() => refetch()} className="mt-2 inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-secondary px-4 text-[13px] font-semibold text-foreground">Retry</button>
        </div>
      )}
      {!isLoading && !isError && !data?.items.length && (
        <p className="rounded-2xl border border-border bg-card p-4 text-center text-[13px] text-muted-foreground" data-testid="announcement-feed-empty">
          Nothing yet today. Wins, streaks, and posts from your managers land here.
        </p>
      )}
      {/* The list shell renders only when there are rows — an empty bordered
          box under the empty-state message read as a broken second widget. */}
      {(data?.items.length ?? 0) > 0 && (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-card px-4">
          {data?.items.map(item => <FeedRow key={item.id} item={item} now={now} />)}
        </ul>
      )}
    </section>
  );
}

// ── The board, compact — today's race without leaving the room ──────────────
type BoardRange = "today" | "7d" | "30d";
const BOARD_RANGES: Array<{ key: BoardRange; label: string }> = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
];

interface BoardEntry {
  rep: TeamMember;
  knocks: number;
  contacts: number;
  callbacks: number;
  sales: number;
}

/** Gold, silver, bronze - same trio the full leaderboard wears.
 *  First and third used to be the identical `text-warning`, and second was a
 *  raw `text-slate-300` at ~1.9:1 on the light card, so the podium was two
 *  indistinguishable places and one unreadable one. */
const PODIUM_TONE = ["text-gold-text", "text-muted-foreground", "text-warning"];

function BoardPanel() {
  const { user } = useAuth();
  const [range, setRange] = useState<BoardRange>("today");
  // Same URL-shaped key the full leaderboard uses, so the two share a cache —
  // opening the full page after this tab paints instantly.
  const url = `/api/leaderboard?range=${range}`;
  const { data: board = [], isLoading, isError } = useQuery<BoardEntry[]>({
    queryKey: [url],
    refetchInterval: 30_000,
  });

  const myIdx = board.findIndex(e => e.rep.id === (user as any)?.teamMemberId);
  const me = myIdx >= 0 ? board[myIdx] : null;
  const podium = board.slice(0, 3);
  const rest = board.slice(3, 8);

  return (
    <section className="space-y-3" data-testid="board-panel">
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-0.5 rounded-xl border border-border bg-secondary/60 p-1">
          {BOARD_RANGES.map(r => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              aria-pressed={range === r.key}
              data-testid={`board-range-${r.key}`}
              className={cn(
                "h-8 whitespace-nowrap rounded-lg px-2.5 text-xs font-semibold transition-colors",
                range === r.key ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                FOCUS,
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <Link
          href="/leaderboard"
          data-testid="board-full-link"
          className={cn("text-xs font-semibold text-primary hover:underline", FOCUS)}
        >
          Full leaderboard
        </Link>
      </div>

      {isLoading && <Skeleton className="h-40 w-full rounded-2xl" data-testid="board-loading" />}

      {!isLoading && isError && (
        <p className="rounded-2xl border border-border bg-card p-4 text-center text-[13px] text-muted-foreground" data-testid="board-error">
          Couldn't load the board. It's still running - check your connection.
        </p>
      )}

      {!isLoading && !isError && !board.length && (
        <p className="rounded-2xl border border-border bg-card p-4 text-center text-[13px] text-muted-foreground" data-testid="board-empty">
          No knocks on the board yet. First door starts the race.
        </p>
      )}

      {!isLoading && !isError && podium.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          {/* Top three — the part of the board people actually race for. */}
          <div className="grid grid-cols-3 gap-2 border-b border-border p-4">
            {podium.map((entry, idx) => (
              <div key={entry.rep.id} className="flex flex-col items-center gap-1 text-center" data-testid={`board-podium-${idx + 1}`}>
                <span className={cn("text-sm font-bold tabular-nums", PODIUM_TONE[idx])}>#{idx + 1}</span>
                <span className="grid h-9 w-9 place-items-center rounded-full bg-secondary text-sm font-bold text-foreground">
                  {entry.rep.name.charAt(0).toUpperCase()}
                </span>
                <span className="max-w-full truncate text-xs font-semibold text-foreground">{entry.rep.name}</span>
                <span className="text-lg font-bold leading-none tabular-nums text-success">{entry.sales}</span>
                <span className="text-2xs uppercase tracking-wide text-muted-foreground">sales</span>
              </div>
            ))}
          </div>

          {rest.map((entry, i) => (
            <div key={entry.rep.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0" data-testid={`board-row-${entry.rep.id}`}>
              <span className="w-5 text-center text-sm font-bold tabular-nums text-muted-foreground">{i + 4}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{entry.rep.name}</span>
              <span className="text-sm font-bold tabular-nums text-success">{entry.sales}</span>
            </div>
          ))}
        </div>
      )}

      {/* You, pinned — nobody should scroll a leaderboard to find themselves. */}
      {me && !isLoading && !isError && (
        <div className="flex items-center gap-3 rounded-xl border border-primary/25 bg-primary/[0.07] px-4 py-3" data-testid="board-me">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-bold text-primary">
            {me.rep.name.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 text-[13px] font-semibold text-foreground">
            You're #{myIdx + 1} of {board.length}
          </span>
          <span className="text-lg font-bold tabular-nums text-success">{me.sales}</span>
        </div>
      )}
    </section>
  );
}

// ── The sent log - unchanged in behavior, now living on the announcements tab ─
/** Everything this org has broadcast, newest first, with what it reached. */
function SentLog() {
  const { data, isLoading } = useQuery<{ items: SentItem[] }>({ queryKey: SENT_KEY });
  // One clock for the list so every row's "2m" ages together instead of
  // freezing at whatever it was when the page mounted.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const items = data?.items ?? [];

  return (
    <section className="space-y-3" data-testid="sent-log">
      <SectionLabel>Already sent</SectionLabel>

      {isLoading && <Skeleton className="h-24 w-full rounded-2xl" data-testid="sent-log-loading" />}

      {!isLoading && !items.length && (
        <p className="rounded-2xl border border-border bg-card p-4 text-center text-[13px] text-muted-foreground" data-testid="sent-log-empty">
          Nothing sent yet. What you post above shows up here, with how many people read it.
        </p>
      )}

      <ul className="space-y-2">
        {items.map(item => <SentRow key={item.id} item={item} now={now} />)}
      </ul>
    </section>
  );
}

function SentRow({ item, now }: { item: SentItem; now: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const isPromo = item.kind === "promo";

  const remove = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", `/api/announcements/${item.id}`)).json(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SENT_KEY });
      qc.invalidateQueries({ queryKey: ["/api/announcements"] });
      toast({
        title: "Post retracted",
        description: isPromo
          // Stated plainly, because the alternative is a manager believing a
          // notification was unsent and not following up with the floor.
          ? "It's off the feed. Phones that already buzzed can't be unbuzzed."
          : "It's off the feed.",
      });
    },
    onError: (e: any) => toast({
      title: "Couldn't retract it", description: String(e?.message ?? e), variant: "destructive",
    }),
  });

  return (
    <li
      className="flex items-start gap-3 rounded-2xl border border-border bg-card p-3"
      data-testid={`sent-item-${item.id}`}
    >
      

      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-snug text-foreground">{item.headline}</p>
        <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{item.body}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/70">{isPromo ? "Promo" : "Update"}</span>
          <span aria-hidden="true">·</span>
          <span>{item.actorName}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{agoLabel(item.createdAtMs, now)}</span>
          {item.amountCents != null && (
            <>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{usd(item.amountCents)}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <ReadCount read={item.readCount} audience={item.audience} />
        </p>
      </div>

      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={remove.isPending}
        aria-label={`Retract "${item.headline}"`}
        data-testid={`sent-delete-${item.id}`}
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50",
          FOCUS,
        )}
      >
        {remove.isPending
          ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          : <Trash2 className="h-4 w-4" aria-hidden="true" />}
      </button>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-testid="sent-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Retract this post?</AlertDialogTitle>
            <AlertDialogDescription>
              “{item.headline}” comes off the feed for everyone who hasn't opened it yet.
              {isPromo && " The phones it already buzzed can't be unbuzzed - if it needs correcting, post the correction."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => remove.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Retract
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** "8 of 14 read".
 *
 *  Read, not delivered. A delivery number counts phones we managed to reach,
 *  which reads as attention and is not - and a manager deciding whether to say
 *  something a second time needs to know how many people actually looked. */
function ReadCount({ read, audience }: { read: number; audience: number }) {
  if (audience <= 0) return <span data-testid="sent-read-count">no one to reach yet</span>;
  return (
    <span className="tabular-nums" data-testid="sent-read-count">
      {read} of {audience} read
    </span>
  );
}
