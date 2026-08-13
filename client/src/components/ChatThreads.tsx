// ── The conversation list — every room, one screen ──────────────────────────
//
// Messenger grammar on purpose: the floor pinned first (it is the org's
// default room and must never be hunted for), then DMs and groups by newest
// activity. Every row carries the same unread contract its room keeps, read
// from the same queries — a list that disagrees with the rooms it fronts is
// how people stop trusting either.
//
// Starting a conversation lives here too. A DM is one tap on a teammate —
// idempotent server-side, so "message Bo" never forks a second room. Groups
// are named crews and belong to the same people who hold the floor's
// megaphone; everyone else simply doesn't see the option.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, UserMinus } from "lucide-react";
import { repColorOf } from "@shared/repColors";
import { agoLabel } from "@shared/teamFeed";
import {
  chatInitials, dmDisplayName, validateGroupName, GROUP_NAME_MAX, GROUP_MEMBER_MAX,
  type ChatThreadSummary,
} from "@shared/floorChat";
import { CHAT_KEY, THREADS_KEY, useFloorChat } from "@/components/FloorChat";

/** `title` is a display hint for the opening transition — the header shows
 *  it until the threads query catches up, instead of a "Conversation" flash. */
export type ChatRoomTarget = { t: "floor" } | { t: "thread"; id: number; title?: string };

interface RosterMember { id: number; name: string; color?: string | null }

function useRoster() {
  return useQuery<RosterMember[]>({ queryKey: ["/api/team"] });
}

function hueFor(roster: RosterMember[] | undefined, memberId: number | null): string {
  if (memberId == null) return "#94a3b8";
  const m = (Array.isArray(roster) ? roster : []).find(r => r.id === memberId);
  return repColorOf(m ?? { id: memberId });
}

export function useChatThreads(enabled = true) {
  return useQuery<{ threads: ChatThreadSummary[] }>({
    queryKey: THREADS_KEY,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    enabled,
  });
}

function UnreadPill({ n, testId }: { n: number; testId: string }) {
  if (n <= 0) return null;
  return (
    <span
      data-testid={testId}
      aria-label={`${n} unread`}
      className="min-w-[18px] shrink-0 rounded-full bg-primary px-1 text-center text-2xs font-bold leading-[18px] text-primary-foreground tabular-nums"
    >
      {n > 9 ? "9+" : n}
    </span>
  );
}

export function ChatThreadList({
  onOpen, canManage,
}: {
  onOpen: (target: ChatRoomTarget) => void;
  /** Group creation rides the megaphone capability, decided by the hub. */
  canManage: boolean;
}) {
  const { user } = useAuth();
  const myUserId = Number(user?.id ?? -1);
  const floorQ = useFloorChat();
  const { data: threadsData, isLoading, isError } = useChatThreads();
  const { data: roster } = useRoster();
  const [composing, setComposing] = useState(false);
  // All / Unread, the shipped inbox filter (Depop, eBay via Mobbin). Shown
  // only once there is something to filter - a two-chip control above three
  // conversations is furniture, not a feature.
  const [onlyUnread, setOnlyUnread] = useState(false);

  const allThreads = threadsData?.threads ?? [];
  const floorLast = floorQ.data?.items?.length
    ? floorQ.data.items[floorQ.data.items.length - 1]
    : null;

  // One clock for the whole list — same rule as every sibling list.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const floorUnread = floorQ.data?.unread ?? 0;
  const unreadCount = allThreads.filter(t => t.unread > 0).length + (floorUnread > 0 ? 1 : 0);
  const threads = onlyUnread ? allThreads.filter(t => t.unread > 0) : allThreads;
  const showFloor = !onlyUnread || floorUnread > 0;
  // Leaving the filter on after everything is read would show an empty inbox
  // that looks like lost messages.
  useEffect(() => { if (onlyUnread && unreadCount === 0) setOnlyUnread(false); }, [onlyUnread, unreadCount]);

  return (
    <section className="space-y-3" data-testid="chat-thread-list">
      {(unreadCount > 0 || onlyUnread) && allThreads.length + 1 >= 3 && (
        <div className="flex items-center gap-1.5" role="group" aria-label="Filter conversations">
          {[{ on: false, label: "All" }, { on: true, label: `Unread ${unreadCount}` }].map(chip => (
            <button key={chip.label} type="button" onClick={() => setOnlyUnread(chip.on)}
              aria-pressed={onlyUnread === chip.on}
              data-testid={chip.on ? "threads-filter-unread" : "threads-filter-all"}
              className={cn(
                "inline-flex h-8 items-center rounded-full px-3 text-xs font-semibold transition-colors",
                onlyUnread === chip.on ? "bg-foreground text-background" : "bg-secondary text-muted-foreground hover:text-foreground",
                FOCUS,
              )}>
              {chip.label}
            </button>
          ))}
        </div>
      )}
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        {/* The floor, pinned. Everything else earns its spot by activity. */}
        {showFloor && (
        <button
          type="button"
          onClick={() => onOpen({ t: "floor" })}
          data-testid="thread-floor"
          className={cn(
            "flex min-h-[64px] w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted/40",
            FOCUS,
          )}
        >
          <span aria-hidden="true"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/[0.12] text-[11px] font-bold text-primary">
            ALL
          </span>
          <span className="min-w-0 flex-1">
            <span className={cn("block text-[13px] text-foreground",
              (floorQ.data?.unread ?? 0) > 0 ? "font-bold" : "font-semibold")}>The floor</span>
            <span className={cn("block truncate text-[12px]",
              (floorQ.data?.unread ?? 0) > 0 ? "font-medium text-foreground/80" : "text-muted-foreground")}>
              {floorLast
                ? `${floorLast.authorUserId === myUserId ? "You" : floorLast.authorName}: ${floorLast.body}`
                : "Everyone on the floor, one room."}
            </span>
          </span>
          {floorLast && (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {agoLabel(floorLast.createdAtMs, now)}
            </span>
          )}
          <UnreadPill n={floorUnread} testId="thread-floor-unread" />
        </button>
        )}

        {isLoading && <Skeleton className="m-3 h-16 rounded-xl" data-testid="threads-loading" />}

        {/* A failed fetch is not an empty inbox — presenting it as "no
            conversations" tells someone their DMs vanished. */}
        {!isLoading && isError && (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground" data-testid="threads-error">
            Couldn't load your conversations - check your connection.
          </p>
        )}

        {!isLoading && !isError && !threads.length && (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground" data-testid="threads-empty">
            No conversations yet. Start one - a teammate, or a crew.
          </p>
        )}

        {threads.map(t => {
          const isDm = t.kind === "dm";
          const partner = isDm ? t.members.find(m => m.userId !== myUserId) : null;
          const title = isDm ? dmDisplayName(t.members, myUserId) : (t.name ?? "Group");
          const hue = hueFor(roster, partner?.memberId ?? null);
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onOpen({ t: "thread", id: t.id, title })}
              data-testid={`thread-${t.id}`}
              className={cn(
                "flex min-h-[64px] w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/40",
                FOCUS,
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "grid h-10 w-10 shrink-0 place-items-center text-[11px] font-bold",
                  // A group is a square-ish squircle, a person is a circle -
                  // the shape carries the kind so the row needs no icon.
                  isDm ? "rounded-full" : "rounded-xl bg-secondary",
                )}
                style={isDm ? { backgroundColor: `${hue}26`, color: hue } : undefined}
              >
                <span className={cn(!isDm && "text-muted-foreground")}>{chatInitials(title)}</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-[13px] text-foreground",
                  t.unread > 0 ? "font-bold" : "font-semibold")}>{title}</span>
                <span className={cn("block truncate text-[12px]",
                  t.unread > 0 ? "font-medium text-foreground/80" : "text-muted-foreground")}>
                  {t.lastMessage
                    ? `${t.lastMessage.authorUserId === myUserId ? "You" : t.lastMessage.authorName}: ${t.lastMessage.body}`
                    : isDm ? "Say hello." : `${t.members.length} people`}
                </span>
              </span>
              {t.lastMessage && (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {agoLabel(t.lastMessage.createdAtMs, now)}
                </span>
              )}
              <UnreadPill n={t.unread} testId={`thread-${t.id}-unread`} />
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setComposing(true)}
        data-testid="thread-new"
        className={cn(
          "inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground",
          FOCUS,
        )}
      >
        
        New message
      </button>

      <NewThreadSheet
        open={composing}
        onOpenChange={setComposing}
        canManage={canManage}
        onOpened={(id, title) => { setComposing(false); onOpen({ t: "thread", id, title }); }}
      />
    </section>
  );
}

// ── Starting a conversation ──────────────────────────────────────────────────
function NewThreadSheet({
  open, onOpenChange, canManage, onOpened,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  canManage: boolean;
  onOpened: (threadId: number, title?: string) => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: roster } = useRoster();
  const myMemberId = (user as any)?.teamMemberId ?? null;

  const teammates = useMemo(
    () => (Array.isArray(roster) ? roster : []).filter(r => r.id !== myMemberId),
    [roster, myMemberId],
  );

  // Group builder state - only rendered for canManage.
  const [groupMode, setGroupMode] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const nameCheck = validateGroupName(groupName);
  const nameOverBy = groupName.trim().length - GROUP_NAME_MAX;
  // The creator is the +1 - the picker caps one below the room's ceiling.
  const atCap = picked.size >= GROUP_MEMBER_MAX - 1;

  // A closed sheet forgets. Reopening "New message" mid-shift and finding
  // last week's half-built crew pre-picked is how a wrong group gets made.
  useEffect(() => {
    if (!open) { setGroupMode(false); setGroupName(""); setPicked(new Set()); }
  }, [open]);

  type CreateThreadBody =
    | { kind: "dm"; memberId: number }
    | { kind: "group"; name: string; memberIds: number[] };
  const create = useMutation({
    mutationFn: async (body: CreateThreadBody) =>
      (await apiRequest("POST", "/api/chat/threads", body)).json() as Promise<{ threadId: number }>,
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: THREADS_KEY });
      qc.invalidateQueries({ queryKey: CHAT_KEY });
      // The sheet knows the room's name before the threads query does — hand
      // it along so the header never flashes a placeholder.
      const title = vars.kind === "dm"
        ? teammates.find(t => t.id === vars.memberId)?.name
        : vars.name;
      setGroupMode(false); setGroupName(""); setPicked(new Set());
      onOpened(res.threadId, title || undefined);
    },
    onError: (e: any) => toast({
      title: "Couldn't start it", description: String(e?.message ?? e), variant: "destructive",
    }),
  });

  const togglePick = (id: number) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-md overflow-y-auto p-0" data-testid="new-thread-sheet">
        <SheetHeader className="border-b border-border px-4 py-3">
          <SheetTitle className="text-base">{groupMode ? "New group" : "New message"}</SheetTitle>
        </SheetHeader>

        <div className="space-y-4 p-4">
          {canManage && (
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Conversation type">
              {([
                { id: false, label: "Direct message", hint: "Just the two of you" },
                { id: true, label: "Group", hint: "A named crew" },
              ] as const).map(k => (
                <button
                  key={String(k.id)} type="button" role="radio" aria-checked={groupMode === k.id}
                  onClick={() => setGroupMode(k.id)}
                  data-testid={k.id ? "new-thread-group" : "new-thread-dm"}
                  className={cn(
                    "flex min-h-[56px] flex-col items-start justify-center rounded-xl border px-3 text-left transition-colors",
                    groupMode === k.id ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-secondary/50",
                    FOCUS,
                  )}
                >
                  <span className="text-[13px] font-semibold text-foreground">{k.label}</span>
                  <span className="text-[11px] text-muted-foreground">{k.hint}</span>
                </button>
              ))}
            </div>
          )}

          {groupMode && (
            <div>
              <Label htmlFor="group-name">Group name</Label>
              <Input
                id="group-name" value={groupName} maxLength={GROUP_NAME_MAX + 20}
                placeholder="Lexington crew" data-testid="group-name"
                onChange={e => setGroupName(e.target.value)}
              />
              {nameOverBy > 0 && (
                <p className="mt-1 flex items-start gap-1.5 text-[13px] font-medium text-destructive" data-testid="group-name-error">
                  
                  {!nameCheck.ok ? nameCheck.error : `Name is over ${GROUP_NAME_MAX} characters.`}
                </p>
              )}
            </div>
          )}

          <div className="overflow-hidden rounded-2xl border border-border">
            {!teammates.length && (
              <p className="px-4 py-6 text-center text-[13px] text-muted-foreground" data-testid="roster-empty">
                Nobody else on the roster yet.
              </p>
            )}
            {teammates.map(r => {
              const hue = repColorOf(r);
              const on = picked.has(r.id);
              return (
                <button
                  key={r.id}
                  type="button"
                  disabled={create.isPending || (groupMode && !on && atCap)}
                  onClick={() => (groupMode ? togglePick(r.id) : create.mutate({ kind: "dm", memberId: r.id }))}
                  aria-pressed={groupMode ? on : undefined}
                  data-testid={`pick-member-${r.id}`}
                  className={cn(
                    "flex min-h-[52px] w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted/40 disabled:opacity-50",
                    groupMode && on && "bg-primary/[0.08]",
                    FOCUS,
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-2xs font-bold"
                    style={{ backgroundColor: `${hue}26`, color: hue }}
                  >
                    {chatInitials(r.name)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{r.name}</span>
                  {groupMode && on && null}
                </button>
              );
            })}
          </div>

          {groupMode && (
            <>
              {picked.size === 0 && (
                // The disabled button explains itself, or it reads as broken.
                <p className="text-[13px] text-muted-foreground" data-testid="group-pick-hint">
                  Pick at least one teammate to start a group.
                </p>
              )}
              {atCap && (
                <p className="text-[13px] text-muted-foreground" data-testid="group-cap-hint">
                  That's the ceiling - a group tops out at {GROUP_MEMBER_MAX} people. Past that, use the floor.
                </p>
              )}
              <button
                type="button"
                disabled={!nameCheck.ok || picked.size === 0 || create.isPending}
                onClick={() => create.mutate({ kind: "group", name: groupName, memberIds: [...picked] })}
                data-testid="group-create"
                className={cn(
                  "inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50",
                  FOCUS,
                )}
              >
                {create.isPending && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                Create group{picked.size > 0 ? ` · ${picked.size + 1} people` : ""}
              </button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Group roster - view for everyone in it ───────────────────────────────────
// Three exits, three owners: a MEMBER leaves themselves (no capability - being
// in a room is their choice, not management's); a MANAGER removes others,
// behind a confirm because a mis-tap here silently locks a teammate out; and
// a manager DISBANDS the whole room, which is what removal-one-by-one was
// never meant to approximate.
export function GroupMembersSheet({
  thread, open, onOpenChange, canManage, onLeft,
}: {
  thread: ChatThreadSummary;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  canManage: boolean;
  /** Called after this viewer leaves or the room is disbanded — the hub
   *  routes back to the conversation list. */
  onLeft?: () => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: roster } = useRoster();
  const myUserId = Number(user?.id ?? -1);
  const inRoom = new Set(thread.members.map(m => m.memberId).filter((v): v is number => v != null));
  const addable = (Array.isArray(roster) ? roster : []).filter(r => !inRoom.has(r.id));
  const atCap = thread.members.length >= GROUP_MEMBER_MAX;

  const [removing, setRemoving] = useState<{ userId: number; name: string } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [disbanding, setDisbanding] = useState(false);

  const refreshLists = () => {
    qc.invalidateQueries({ queryKey: THREADS_KEY });
    qc.invalidateQueries({ queryKey: CHAT_KEY });
  };

  const change = useMutation({
    mutationFn: async (body: { addMemberIds?: number[]; removeUserIds?: number[] }) =>
      (await apiRequest("POST", `/api/chat/threads/${thread.id}/members`, body)).json(),
    onSuccess: refreshLists,
    onError: (e: any) => toast({
      title: "Couldn't change the crew", description: String(e?.message ?? e), variant: "destructive",
    }),
  });

  const leave = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/chat/threads/${thread.id}/leave`)).json(),
    onSuccess: () => { refreshLists(); onOpenChange(false); onLeft?.(); },
    onError: (e: any) => toast({
      title: "Couldn't leave", description: String(e?.message ?? e), variant: "destructive",
    }),
  });

  const disband = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", `/api/chat/threads/${thread.id}`)).json(),
    onSuccess: () => { refreshLists(); onOpenChange(false); onLeft?.(); },
    onError: (e: any) => toast({
      title: "Couldn't disband it", description: String(e?.message ?? e), variant: "destructive",
    }),
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-md overflow-y-auto p-0" data-testid="group-members-sheet">
        <SheetHeader className="border-b border-border px-4 py-3">
          <SheetTitle className="text-base">{thread.name ?? "Group"} · {thread.members.length}</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 p-4">
          <div className="overflow-hidden rounded-2xl border border-border">
            {thread.members.map(m => (
              <div key={m.userId} className="flex min-h-[52px] items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0" data-testid={`group-member-${m.userId}`}>
                <span
                  aria-hidden="true"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-2xs font-bold"
                  style={{ backgroundColor: `${hueFor(roster, m.memberId)}26`, color: hueFor(roster, m.memberId) }}
                >
                  {chatInitials(m.name)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
                  {m.name}{m.userId === myUserId && <span className="text-muted-foreground"> · you</span>}
                </span>
                {/* Your own row gets no remove button — "Leave group" below is
                    the deliberate version of that tap. */}
                {canManage && m.userId !== myUserId && (
                  <button
                    type="button"
                    onClick={() => setRemoving({ userId: m.userId, name: m.name })}
                    disabled={change.isPending}
                    aria-label={`Remove ${m.name} from the group`}
                    data-testid={`group-remove-${m.userId}`}
                    className={cn(
                      "relative grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground after:absolute after:-inset-1.5 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50",
                      FOCUS,
                    )}
                  >
                    <UserMinus className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </div>

          {canManage && addable.length > 0 && !atCap && (
            <div>
              <p className="mb-2 text-2xs font-semibold uppercase tracking-widest text-muted-foreground/60">Add people</p>
              <div className="overflow-hidden rounded-2xl border border-border">
                {addable.map(r => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => change.mutate({ addMemberIds: [r.id] })}
                    disabled={change.isPending}
                    data-testid={`group-add-${r.id}`}
                    className={cn(
                      "flex min-h-[52px] w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted/40 disabled:opacity-50",
                      FOCUS,
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-2xs font-bold"
                      style={{ backgroundColor: `${repColorOf(r)}26`, color: repColorOf(r) }}
                    >
                      {chatInitials(r.name)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{r.name}</span>
                    
                  </button>
                ))}
              </div>
            </div>
          )}
          {canManage && atCap && (
            <p className="text-[13px] text-muted-foreground" data-testid="group-cap-full">
              This group is at its {GROUP_MEMBER_MAX}-person ceiling. Past that, use the floor.
            </p>
          )}

          <div className="overflow-hidden rounded-2xl border border-border">
            <button
              type="button"
              onClick={() => setLeaving(true)}
              disabled={leave.isPending}
              data-testid="group-leave"
              className={cn(
                "flex min-h-12 w-full items-center gap-3 px-4 text-left text-[13px] font-medium text-foreground hover:bg-secondary/60 disabled:opacity-50",
                FOCUS,
              )}
            >
              
              <span className="flex-1">Leave group</span>
            </button>
            {canManage && (
              <button
                type="button"
                onClick={() => setDisbanding(true)}
                disabled={disband.isPending}
                data-testid="group-disband"
                className={cn(
                  "flex min-h-12 w-full items-center gap-3 border-t border-border px-4 text-left text-[13px] font-medium text-red-500 hover:bg-red-500/5 disabled:opacity-50",
                  FOCUS,
                )}
              >
                
                <span className="flex-1">Disband group</span>
              </button>
            )}
          </div>
        </div>

        <AlertDialog open={removing != null} onOpenChange={o => { if (!o) setRemoving(null); }}>
          <AlertDialogContent data-testid="group-remove-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {removing?.name} from the group?</AlertDialogTitle>
              <AlertDialogDescription>
                They lose the room and everything in it, immediately. They aren't told why.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep them</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => { if (removing) change.mutate({ removeUserIds: [removing.userId] }); setRemoving(null); }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={leaving} onOpenChange={setLeaving}>
          <AlertDialogContent data-testid="group-leave-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle>Leave {thread.name ?? "this group"}?</AlertDialogTitle>
              <AlertDialogDescription>
                You stop seeing this room. Someone with the keys can always add you back.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Stay</AlertDialogCancel>
              <AlertDialogAction onClick={() => { leave.mutate(); setLeaving(false); }}>
                Leave
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={disbanding} onOpenChange={setDisbanding}>
          <AlertDialogContent data-testid="group-disband-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle>Disband {thread.name ?? "this group"}?</AlertDialogTitle>
              <AlertDialogDescription>
                The room and every message in it go, for everyone, for good.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => { disband.mutate(); setDisbanding(false); }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Disband
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
