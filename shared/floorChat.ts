// ── The floor chat — the one room where everybody talks ─────────────────────
//
// Announcements are one-way on purpose: a manager writes, the floor reads, and
// nothing about that should change (see shared/teamFeed.ts for why the feed is
// not a social surface). But the CONVERSATION — "anyone worked Maple yet",
// "who's got door hangers", "gate code on Birch is 4412 not 4112" — happens
// today in a text thread outside the app, and every message that lands there
// is one more reason the app is not where the floor looks.
//
// So this is the two-way room next to the one-way feed. Deliberately ONE room
// per org: channels and DMs are unread math, moderation surface, and "which
// thread was that in?" — cost without a request behind it. If the floor ever
// outgrows one room, that is a good problem and a different feature.
//
// Same paranoia as the announcement bus about what crosses the wall: chat is
// org-wide by design, so nothing may ever INTERPOLATE lead data into it. The
// difference is that chat is free text typed by a person — it cannot be
// constrained by construction the way announcement copy is. What we can
// guarantee is that the system never puts a lead id, address, or contact into
// a message on anyone's behalf; a message holds exactly what a human typed.
//
// PURE: no clock, no database, no I/O.

/** Same tier as the other in-app free text (TERRITORY_MESSAGE_MAX): room to
 *  say something real, bounded so one paste cannot wedge every phone's list. */
export const FLOOR_CHAT_MESSAGE_MAX = 2_000;

export interface FloorChatMessage {
  id: number;
  /** users.id — the identity that typed it. Deletion rights key off this. */
  authorUserId: number;
  /** team_members.id when the author is a field identity; null for desk
   *  logins. Presentation only — it picks the avatar hue via repColorOf. */
  authorMemberId: number | null;
  /** Snapshotted at send time ("Marcus T."), same rule as the feed's
   *  actor_name: a rename must not rewrite what the room already read. */
  authorName: string;
  body: string;
  createdAtMs: number;
}

export interface FloorChatPage {
  /** Ascending — a conversation reads down the page, unlike the feed. */
  items: FloorChatMessage[];
  /** Messages this viewer has not scrolled past, across the WHOLE room —
   *  not just the page returned, so the nav badge cannot undercount. */
  unread: number;
  /** Newest id in the room — what to POST back as read. */
  latestId: number;
}

/** Shared by the API and the composer, so the send button disables for exactly
 *  the reasons the server would reject. */
export type ChatMessageCheck =
  | { ok: true; body: string }
  | { ok: false; error: string };

export function validateChatMessage(raw: unknown): ChatMessageCheck {
  if (typeof raw !== "string") return { ok: false, error: "Nothing to send." };
  const body = raw.trim();
  if (!body) return { ok: false, error: "Say something first." };
  if (body.length > FLOOR_CHAT_MESSAGE_MAX) {
    return { ok: false, error: `Message is over ${FLOOR_CHAT_MESSAGE_MAX} characters.` };
  }
  return { ok: true, body };
}

/**
 * Should this message start a new visual group?
 *
 * A run of messages from one person reads as one turn in the conversation, so
 * the name and avatar render once per run, not once per message. Ten minutes
 * of silence breaks the run even for the same author — "brb" and a reply an
 * hour later are two turns, and gluing them together misreads the room.
 */
export const CHAT_GROUP_GAP_MS = 10 * 60_000;

export function startsNewGroup(
  prev: Pick<FloorChatMessage, "authorUserId" | "createdAtMs"> | null | undefined,
  cur: Pick<FloorChatMessage, "authorUserId" | "createdAtMs">,
): boolean {
  if (!prev) return true;
  if (prev.authorUserId !== cur.authorUserId) return true;
  return cur.createdAtMs - prev.createdAtMs > CHAT_GROUP_GAP_MS;
}

/** "Today" / "Yesterday" / "Mon, Aug 3" — the separators between days.
 *  Local-time comparison on purpose: a rep's day rolls over at their midnight,
 *  and toDateString() is DST-safe where hand-rolled epoch division is not. */
export function chatDayLabel(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const now = new Date(nowMs);
  if (d.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(nowMs);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** "2:14 PM" — the time a group started. */
export function chatTimeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** "MT" from "Marcus T." — what fits in an avatar circle. */
export function chatInitials(name: string | null | undefined): string {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0]![0]!;
  const last = parts.length > 1 ? parts[parts.length - 1]![0]! : "";
  return (first + last).toUpperCase();
}

// ── Threads — DMs and groups next to the floor ──────────────────────────────
//
// The floor stays the default room; threads are the conversations beside it.
// Two kinds, two contracts:
//
//   DM     — two people, private. Nobody else can read it, list it, or
//            moderate inside it — including managers. The floor is the org
//            talking; a DM is two colleagues talking, and a room reps suspect
//            is supervised is a room they take back to their personal phones.
//   GROUP  — a named subset ("Lexington crew"), created by the same people
//            who hold the floor's megaphone. Moderation works like the floor,
//            but only for moderators who are IN the room — structural acts
//            (create, membership, delete-the-room) don't require membership,
//            because deleting or re-crewing a room doesn't read it.

export type ChatThreadKind = "dm" | "group";

export const GROUP_NAME_MAX = 60;
/** Rooms bigger than this are the floor wearing a costume — use the floor. */
export const GROUP_MEMBER_MAX = 30;

export type GroupNameCheck =
  | { ok: true; name: string }
  | { ok: false; error: string };

export function validateGroupName(raw: unknown): GroupNameCheck {
  if (typeof raw !== "string") return { ok: false, error: "Give the group a name." };
  const name = raw.trim();
  if (!name) return { ok: false, error: "Give the group a name." };
  if (name.length > GROUP_NAME_MAX) return { ok: false, error: `Name is over ${GROUP_NAME_MAX} characters.` };
  return { ok: true, name };
}

/** One DM per pair, enforced as a UNIQUE key — "message Bo" from anywhere must
 *  land in the same room, never fork a second one. Order-independent. */
export function dmPairKey(userIdA: number, userIdB: number): string {
  const a = Math.min(userIdA, userIdB);
  const b = Math.max(userIdA, userIdB);
  return `dm:${a}:${b}`;
}

export interface ChatThreadMember {
  userId: number;
  /** team_members id when the member is a field identity — drives avatar hue. */
  memberId: number | null;
  name: string;
}

/** One row of the conversation list. */
export interface ChatThreadSummary {
  id: number;
  kind: ChatThreadKind;
  /** Group name; null for DMs — the client names a DM after the other person. */
  name: string | null;
  createdByUserId: number;
  members: ChatThreadMember[];
  unread: number;
  latestId: number;
  lastMessage: { authorUserId: number; authorName: string; body: string; createdAtMs: number } | null;
}

/** What a DM is called on this viewer's screen: the OTHER person. */
export function dmDisplayName(members: ChatThreadMember[], viewerUserId: number): string {
  const other = members.find(m => m.userId !== viewerUserId);
  return other?.name ?? "Direct message";
}
