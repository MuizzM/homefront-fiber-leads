// ── The floor chat pane — the room, rendered ────────────────────────────────
//
// The feed next door is a scoreboard that scrolls (TeamFeed.tsx says why). This
// is the opposite surface: two-way, informal, and shaped like the text thread
// it exists to replace — bubbles, not cards, because a conversation should read
// like one.
//
// Three rendering rules carry the whole design:
//   · YOUR messages sit right and wear the accent; everyone else sits left
//     under a name and an avatar in their map hue — the same hue their pins
//     and territory wear, so "who said that" resolves the way "whose door is
//     that" already does.
//   · A RUN of messages from one person renders one header, not five. The
//     grouping rule is pure and shared (startsNewGroup), so tests pin it.
//   · Delivery is POLLING — 4s while the pane is mounted. The SSE socket only
//     lives on the map, and the house rule is that only money buzzes a phone,
//     so chat rides the same transport every other non-map surface trusts.
//
// The DRAFT lives in the parent, not here. The hub's other tabs are one tap
// away and actively badged, so "check the board mid-sentence" is the designed
// flow — and this component unmounts on every tab switch. Holding the draft
// locally would silently eat the words on each one; the same reasoning the
// send-failure path uses to put a failed message back in the box.
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, Send, Trash2 } from "lucide-react";
import { repColorOf } from "@shared/repColors";
import {
  chatDayLabel, chatInitials, chatTimeLabel, startsNewGroup, validateChatMessage,
  FLOOR_CHAT_MESSAGE_MAX, type FloorChatMessage, type FloorChatPage,
} from "@shared/floorChat";

export const CHAT_KEY = ["/api/chat"];
export const THREADS_KEY = ["/api/chat/threads"];

/** The floor's GET also carries the all-threads unread total, so every badge
 *  rides the one poll the nav already makes. */
export type FloorChatHome = FloorChatPage & { threadsUnread?: number };

/**
 * The floor, shared by the pane and every badge that counts it — one query
 * key, so the number on the tab can never disagree with what opening it shows.
 *
 * `fast` is what the pane passes while mounted: 4s reads as live for a room
 * this size. Everything else (the hub's tab badge, the sidebar) observes the
 * same cache at the 30s baseline, and react-query polls at the fastest
 * interval any observer asks for.
 */
export function useFloorChat(fast = false, enabled = true) {
  return useQuery<FloorChatHome>({
    queryKey: CHAT_KEY,
    refetchInterval: fast ? 4_000 : 30_000,
    refetchIntervalInBackground: false,
    enabled,
  });
}

/** The lite roster /api/team serves every field role — id, name, hue. */
interface RosterMember { id: number; name: string; color?: string | null }

/** A message that exists on this screen but maybe not yet on the server.
 *  Kept OUTSIDE the query cache on purpose: a poll response landing mid-send
 *  replaces the cache wholesale, and an optimistic entry written into it
 *  vanishes for a beat and reappears — the "did that send?" flicker. Local
 *  state can't be clobbered by a refetch; the ghost hides itself the moment
 *  the server's copy shows up in the list. */
interface GhostMessage extends FloorChatMessage {
  serverId?: number;
}

export function FloorChat({
  threadId, moderatable, draft, onDraftChange, className,
  roomKind = "floor", roomName, onGone,
}: {
  /** Undefined → the floor. A thread id → that DM or group. */
  threadId?: number;
  /** Called when a thread room 404s — removed from the group, or the group
   *  was dissolved under you. The hub routes back to the list. */
  onGone?: () => void;
  /** Whether this viewer may remove OTHER people's messages here. The hub
   *  decides per room kind: capability holders on the floor and in groups,
   *  NOBODY in a DM — the server enforces the same lines; this only keeps
   *  the UI from offering a button the API would 404. */
  moderatable: boolean;
  /** Who hears you here. The empty state and the composer placeholder are
   *  the two places the room states its audience, and a DM wearing the
   *  floor's "everyone reads this" copy would invert its whole promise. */
  roomKind?: "floor" | "dm" | "group";
  roomName?: string;
  draft: string;
  onDraftChange: Dispatch<SetStateAction<string>>;
  className?: string;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  // One pane, any room: the floor keys ["/api/chat"] (shared with the nav
  // badge), a thread keys its own URL. Same page shape either way.
  const base = threadId != null ? `/api/chat/threads/${threadId}` : "/api/chat";
  const roomKey = [base];
  const { data, isLoading, isError, error } = useQuery<FloorChatPage>({
    queryKey: roomKey,
    // A thread that 404s is GONE (removed from the crew, or the room was
    // dissolved) — polling it forever is a request every 4s for a door that
    // no longer exists. Other errors keep polling; field coverage comes back.
    refetchInterval: q =>
      threadId != null && q.state.status === "error" && (q.state.error as any)?.status === 404
        ? false
        : 4_000,
    refetchIntervalInBackground: false,
    retry: (count, e) => ((e as any)?.status === 404 ? false : count < 2),
  });
  const roomGone = threadId != null && isError && (error as any)?.status === 404;

  // Roster for avatar hues. Presentation only — a missing roster row falls
  // back to the member-id hash hue, and a desk author (null member) to slate.
  const { data: roster } = useQuery<RosterMember[]>({ queryKey: ["/api/team"] });
  const memberById = useMemo(() => {
    const m = new Map<number, RosterMember>();
    (Array.isArray(roster) ? roster : []).forEach(r => m.set(r.id, r));
    return m;
  }, [roster]);

  const items = data?.items ?? [];
  const latestId = data?.latestId ?? 0;

  // ── Ghosts: sent-but-not-yet-polled messages ──────────────────────────────
  const [pending, setPending] = useState<GhostMessage[]>([]);
  const serverIds = useMemo(() => new Set(items.map(m => m.id)), [items]);
  // Housekeeping only — the render filter below already hides confirmed
  // ghosts; this stops the array growing for the life of the pane.
  useEffect(() => {
    setPending(p => {
      const next = p.filter(g => g.serverId == null || !serverIds.has(g.serverId));
      return next.length === p.length ? p : next;
    });
  }, [serverIds]);

  // ── History: everything older than the live window ───────────────────────
  // The cache holds the newest page only — it IS the poll payload, and the
  // sidebar badge shares it. But a room that forgets everything older than
  // one page breaks two promises: a long-open pane would watch messages
  // VANISH as new arrivals slide the window, and the whole-room unread count
  // would advertise messages no request could deliver. So the pane keeps its
  // own ledger: every message the window slides past survives here, and
  // "load earlier" pages backwards into it. Inside the live window the server
  // page stays authoritative (that's where deletes are reflected); below it,
  // the ledger is what the rep already saw.
  const [history, setHistory] = useState<FloorChatMessage[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const floorId = items.length ? items[0]!.id : 0;

  useEffect(() => {
    if (!items.length) return;
    setHistory(h => {
      const byId = new Map(h.map(m => [m.id, m]));
      let changed = false;
      for (const m of items) {
        if (!byId.has(m.id)) { byId.set(m.id, m); changed = true; }
      }
      if (!changed) return h;
      return [...byId.values()].sort((a, b) => a.id - b.id);
    });
  }, [items]);

  const earlier = history.filter(m => m.id < floorId);
  const visible: GhostMessage[] = [
    ...earlier,
    ...items,
    ...pending.filter(g => g.serverId == null || !serverIds.has(g.serverId)),
  ];

  // A full first page means the room may extend past what we hold; a short
  // backfill page means we have reached the beginning and the button goes.
  const mayHaveEarlier = !exhausted && floorId > 0 && (items.length >= 60 || earlier.length > 0);

  const loadEarlier = async () => {
    const before = earlier.length ? earlier[0]!.id : floorId;
    if (!before || loadingEarlier) return;
    setLoadingEarlier(true);
    const el = listRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      const page = (await (await apiRequest("GET", `${base}?before=${before}&limit=60`)).json()) as FloorChatPage;
      if (page.items.length < 60) setExhausted(true);
      if (page.items.length) {
        setHistory(h => {
          const byId = new Map(h.map(m => [m.id, m]));
          for (const m of page.items) if (!byId.has(m.id)) byId.set(m.id, m);
          return [...byId.values()].sort((a, b) => a.id - b.id);
        });
        // Prepended content grows the scroll area upward; hold the reader's
        // place or the page they asked for scrolls straight past them.
        requestAnimationFrame(() => {
          const list = listRef.current;
          if (list) list.scrollTop = list.scrollHeight - prevHeight + prevTop;
        });
      }
    } catch (e: any) {
      toast({ title: "Couldn't load earlier messages", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setLoadingEarlier(false);
    }
  };

  // ── One clock for the list ────────────────────────────────────────────────
  // Same 30s tick every sibling list keeps, and here it earns its keep twice:
  // the day separators ("Today") must roll over at midnight even in a room
  // where nobody is talking, because a quiet room never re-renders otherwise.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // ── Read watermark ─────────────────────────────────────────────────────────
  // The pane being open IS reading — same stance as the bell sheet. Optimistic
  // (badge clears now, not after the round trip); the server mark is monotonic
  // so a failed request just means the next poll re-clears.
  const markedRef = useRef(0);
  useEffect(() => {
    if ((data?.unread ?? 0) === 0) return;
    if (latestId <= markedRef.current) {
      // Already marked, yet the cache says unread again: a poll that was
      // computed against the OLD watermark landed after our optimistic zero.
      // The server is right and we already told it — re-clamp the cache
      // without re-POSTing, or the sidebar badge lies for a poll cycle after
      // the rep walks away from a room they just finished reading.
      qc.setQueryData<FloorChatPage>(roomKey, p => (p ? { ...p, unread: 0 } : p));
      return;
    }
    markedRef.current = latestId;
    // Kill any in-flight poll first — one already computed against the old
    // watermark would otherwise land after the optimistic write below.
    void qc.cancelQueries({ queryKey: roomKey });
    qc.setQueryData<FloorChatPage>(roomKey, p => (p ? { ...p, unread: 0 } : p));
    apiRequest("POST", `${base}/read`, { upToId: latestId })
      .then(() => {
        // A thread's read-mark also shrinks the two aggregate badges (the
        // conversation list and the nav's threadsUnread total) — nudge both.
        if (threadId != null) {
          qc.invalidateQueries({ queryKey: THREADS_KEY });
          qc.invalidateQueries({ queryKey: CHAT_KEY });
        }
      })
      .catch(() => {
        markedRef.current = 0; // let the next poll retry
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- roomKey/base derive from threadId
  }, [latestId, data?.unread, qc, threadId]);

  // ── Scroll: pinned to the newest message unless the reader scrolled away ──
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  // Keyed on the last id AND the count: a delete-plus-arrival between two
  // polls changes the list without changing its length.
  const lastVisibleId = visible.length ? visible[visible.length - 1]!.id : 0;
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [visible.length, lastVisibleId]);

  // ── Composer ───────────────────────────────────────────────────────────────
  const check = validateChatMessage(draft);
  const overBy = draft.trim().length - FLOOR_CHAT_MESSAGE_MAX;

  const send = useMutation({
    mutationFn: async (ghost: GhostMessage) =>
      (await apiRequest("POST", base, { body: ghost.body })).json() as Promise<FloorChatMessage>,
    onMutate: (ghost: GhostMessage) => {
      stickRef.current = true;
      setPending(p => [...p, ghost]);
    },
    onSuccess: (msg, ghost) => {
      // Remember which server row this ghost became — it keeps rendering
      // until the poll delivers that row, then hides itself. No gap, no dupe.
      setPending(p => p.map(g => (g.id === ghost.id ? { ...g, serverId: msg.id } : g)));
      qc.invalidateQueries({ queryKey: roomKey });
      // The conversation list previews and sorts by last message.
      if (threadId != null) qc.invalidateQueries({ queryKey: THREADS_KEY });
    },
    onError: (e: any, ghost) => {
      setPending(p => p.filter(g => g.id !== ghost.id));
      // The words come back into the box — losing a typed message to a dead
      // spot in coverage is how a rep stops trusting the room. But never over
      // a NEWER draft: if they started typing something else while this one
      // was in flight, the toast carries the bad news and the new words win.
      onDraftChange(cur => (cur.trim() ? cur : ghost.body));
      toast({ title: "Couldn't send it", description: String(e?.message ?? e), variant: "destructive" });
    },
  });

  const submit = () => {
    if (!check.ok) return;
    const ghost: GhostMessage = {
      id: -Date.now(),
      authorUserId: Number(user?.id ?? 0),
      authorMemberId: (user as any)?.teamMemberId ?? null,
      authorName: user?.name ?? "You",
      body: check.body,
      createdAtMs: Date.now(),
    };
    onDraftChange("");
    send.mutate(ghost);
  };

  // ── Delete confirmation (one dialog for the pane, armed per message) ──────
  const [doomed, setDoomed] = useState<FloorChatMessage | null>(null);
  const remove = useMutation({
    mutationFn: async (id: number) => (await apiRequest("DELETE", `/api/chat/${id}`)).json(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: roomKey });
      // The conversation list previews the last message — a deleted body
      // must not linger there until the next slow poll.
      if (threadId != null) qc.invalidateQueries({ queryKey: THREADS_KEY });
    },
    onError: (e: any) => toast({
      title: "Couldn't remove it", description: String(e?.message ?? e), variant: "destructive",
    }),
  });

  const myUserId = Number(user?.id ?? -1);

  // The room is gone — say so plainly instead of dressing up a 404 as a
  // quiet conversation with a composer that can only fail.
  if (roomGone) {
    return (
      <section
        className={cn("rounded-2xl border border-border bg-card p-8 text-center", className)}
        data-testid="chat-room-gone"
      >
        <p className="text-[13px] font-semibold text-foreground">You're no longer in this conversation.</p>
        <p className="mt-1 text-[13px] text-muted-foreground">It was dissolved, or you were taken off the crew.</p>
        {onGone && (
          <button
            type="button"
            onClick={onGone}
            data-testid="chat-room-gone-back"
            className={cn("mt-4 inline-flex min-h-[44px] items-center rounded-xl bg-secondary px-4 text-sm font-semibold text-foreground", FOCUS)}
          >
            Back to conversations
          </button>
        )}
      </section>
    );
  }

  return (
    <section
      className={cn("flex flex-col overflow-hidden rounded-2xl border border-border bg-card", className)}
      data-testid="chat-room"
    >
      <div
        ref={listRef}
        onScroll={e => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="h-[52dvh] min-h-[320px] overflow-y-auto px-3 py-4"
      >
        {isLoading && <Skeleton className="h-24 w-full rounded-2xl" data-testid="chat-loading" />}

        {/* A fetch failure is not a quiet room - say it, keep polling. */}
        {isError && !roomGone && (
          <p className="pb-2 text-center text-[12px] text-muted-foreground" data-testid="chat-connection-error">
            Couldn't refresh the room - retrying.
          </p>
        )}

        {mayHaveEarlier && (
          <div className="pb-2 text-center">
            <button
              type="button"
              onClick={() => void loadEarlier()}
              disabled={loadingEarlier}
              data-testid="chat-load-earlier"
              className={cn(
                "inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-3.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50",
                FOCUS,
              )}
            >
              {loadingEarlier && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              Load earlier messages
            </button>
          </div>
        )}

        {!isLoading && !isError && !visible.length && (
          // Empty is the normal state on day one, not a failure — and it says
          // who can hear you, because a rep's first question is exactly that.
          <p className="py-12 text-center text-[13px] text-muted-foreground" data-testid="chat-empty">
            {roomKind === "dm"
              ? `Just you and ${roomName ?? "them"} in here. Nobody else can read it.`
              : roomKind === "group"
                ? `Quiet in here. Everyone in ${roomName ?? "this group"} reads this room.`
                : "Quiet in here. Say something - everyone on the floor reads this room."}
          </p>
        )}

        {visible.map((m, i) => {
          const prev = i > 0 ? visible[i - 1] : null;
          const mine = m.authorUserId === myUserId;
          const newDay = !prev || chatDayLabel(prev.createdAtMs, now) !== chatDayLabel(m.createdAtMs, now);
          const newGroup = newDay || startsNewGroup(prev, m);
          const member = m.authorMemberId != null ? memberById.get(m.authorMemberId) : undefined;
          const hue = m.authorMemberId == null
            ? "#94a3b8"
            : repColorOf(member ?? { id: m.authorMemberId });
          const deletable = m.id > 0 && (mine || moderatable);

          return (
            <div key={m.id} data-testid={`chat-message-${m.id}`}>
              {newDay && (
                <div className="my-3 text-center text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                  {chatDayLabel(m.createdAtMs, now)}
                </div>
              )}

              {newGroup && !mine && (
                <div className="mb-1 mt-3 flex items-center gap-2 pl-9 text-[11px] text-muted-foreground">
                  <span className="font-semibold text-foreground/80">{m.authorName}</span>
                  <span className="tabular-nums">{chatTimeLabel(m.createdAtMs)}</span>
                </div>
              )}
              {newGroup && mine && (
                <div className="mb-1 mt-3 pr-1 text-right text-[11px] tabular-nums text-muted-foreground">
                  {chatTimeLabel(m.createdAtMs)}
                </div>
              )}

              <div className={cn("group flex items-end gap-2 py-0.5", mine && "flex-row-reverse")}>
                {/* Avatar renders once per run; spacer keeps the run aligned. */}
                {!mine && (
                  newGroup ? (
                    <span
                      aria-hidden="true"
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-2xs font-bold"
                      style={{ backgroundColor: `${hue}26`, color: hue }}
                    >
                      {chatInitials(m.authorName)}
                    </span>
                  ) : <span className="w-7 shrink-0" aria-hidden="true" />
                )}

                <div
                  className={cn(
                    "max-w-[78%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[13px] leading-snug",
                    mine
                      ? "rounded-br-md bg-primary text-primary-foreground"
                      : "rounded-bl-md border border-border bg-background text-foreground",
                    m.id < 0 && "opacity-60", // ghost until the poll confirms it
                  )}
                >
                  {m.body}
                </div>

                {deletable && (
                  // Destructive control, so it follows the map's row-action
                  // rules: fully visible on touch (no hover to reveal it),
                  // hover-revealed on desktop, NEVER invisible while focused,
                  // and a ≥44px effective target via the inset halo.
                  <button
                    type="button"
                    onClick={() => setDoomed(m)}
                    aria-label={`Remove message from ${m.authorName}`}
                    data-testid={`chat-delete-${m.id}`}
                    className={cn(
                      "relative grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-opacity after:absolute after:-inset-1.5 hover:bg-destructive/10 hover:text-destructive",
                      "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100",
                      FOCUS,
                    )}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Composer — Enter sends, Shift+Enter breaks a line. */}
      <div className="border-t border-border p-2.5">
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            rows={1}
            data-testid="chat-input"
            placeholder={roomKind === "floor" ? "Message the floor" : `Message ${roomName ?? "the room"}`}
            aria-label={roomKind === "floor" ? "Message the floor" : `Message ${roomName ?? "the room"}`}
            maxLength={FLOOR_CHAT_MESSAGE_MAX + 200}
            onChange={e => onDraftChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
            className="max-h-32 min-h-[44px] flex-1 resize-none"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!check.ok || send.isPending}
            aria-label="Send"
            data-testid="chat-send"
            className={cn(
              "grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground disabled:opacity-50",
              FOCUS,
            )}
          >
            {send.isPending
              ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              : <Send className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
        {/* Counts down near the limit, and past it says how far past — a red
            "0 left" tells someone with a 200-character overage nothing. */}
        {FLOOR_CHAT_MESSAGE_MAX - draft.length <= 100 && (
          <p className={cn(
            "mt-1 text-right text-[11px] tabular-nums",
            overBy > 0 ? "text-destructive" : "text-muted-foreground",
          )} data-testid="chat-char-count">
            {overBy > 0 ? `${overBy} over` : `${FLOOR_CHAT_MESSAGE_MAX - draft.length} left`}
          </p>
        )}
        {/* The validator's own sentence, so a disabled send button is never a
            mystery. Only for over-limit — an empty box explains itself. */}
        {overBy > 0 && (
          <p className="mt-1 flex items-start gap-1.5 text-[13px] font-medium text-destructive" data-testid="chat-error">
            
            {!check.ok ? check.error : `Message is over ${FLOOR_CHAT_MESSAGE_MAX} characters.`}
          </p>
        )}
      </div>

      <AlertDialog open={doomed != null} onOpenChange={open => { if (!open) setDoomed(null); }}>
        <AlertDialogContent data-testid="chat-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this message?</AlertDialogTitle>
            <AlertDialogDescription>
              It comes off the floor for everyone. Anyone who already read it, read it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (doomed) remove.mutate(doomed.id); setDoomed(null); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
