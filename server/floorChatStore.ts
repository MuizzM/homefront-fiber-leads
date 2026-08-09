// ── Floor chat — persistence and the unread watermark ───────────────────────
// The rules and the copy live in shared/floorChat.ts. This file stores a
// message, hands back a room in reading order, and tracks how far each person
// has read — deliberately the same shape as teamFeedStore, because the bell
// taught us the contracts that matter:
//
//   · The unread count and the list must come from ONE place, or the badge
//     lies about what opening the room will show.
//   · Read marks are MONOTONIC. A stale request from a second device must not
//     un-read what the first already cleared.
//
// What chat does NOT copy from the feed: a dedupe key on messages. Two
// identical "omw" messages a minute apart are both real, and a UNIQUE index
// that swallowed the second would be a bug wearing a constraint's clothes.
// (Threads are the exception — ONE DM per pair IS a uniqueness rule, and it
// lives on the thread, not the message.)
//
// ── Rooms ────────────────────────────────────────────────────────────────────
// One messages table serves every room. thread_id says which:
//   NULL      → the floor. Everyone with field.app.use, no membership row.
//   thread id → a DM or group. Membership rows are the access control, and
//               every read/write path checks them IN SQL — "hidden in the UI"
//               is not hidden, and a DM the server would hand a non-member is
//               not a DM.
//
// PRIVACY LINE, drawn once and enforced here: a DM's content is reachable by
// its two members and nobody else. Managers moderate the floor and the groups
// they are in; they do not moderate — or read — other people's DMs. Structural
// acts on groups (create, membership, delete-the-room) don't require
// membership, because re-crewing or deleting a room doesn't read it.

import { rawDb } from "./db";
import { shortName } from "@shared/teamFeed";
import {
  validateChatMessage, validateGroupName, dmPairKey,
  GROUP_MEMBER_MAX,
  type FloorChatMessage, type FloorChatPage,
  type ChatThreadKind, type ChatThreadMember, type ChatThreadSummary,
} from "@shared/floorChat";

export function ensureFloorChatSchema(): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS floor_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      author_user_id INTEGER NOT NULL,
      author_member_id INTEGER,
      author_name TEXT NOT NULL,
      body TEXT NOT NULL,
      -- ISO-8601 with milliseconds, matching the feed and the spiffs ledger:
      -- this column is ordered as TEXT, so one shape must hold everywhere.
      created_at TEXT NOT NULL
    );
    -- The room query is always (tenant, newest first) with an optional floor.
    CREATE INDEX IF NOT EXISTS idx_floor_chat_room
      ON floor_chat_messages(tenant_id, id DESC);

    CREATE TABLE IF NOT EXISTS floor_chat_reads (
      user_id INTEGER PRIMARY KEY,
      last_read_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS floor_chat_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT,
      -- 'dm:<minUserId>:<maxUserId>' for DMs, NULL for groups. The UNIQUE
      -- index below is what makes "message Bo" idempotent: two devices racing
      -- to open the same DM collide here and both land in one room.
      dm_key TEXT,
      created_by_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_floor_chat_dm
      ON floor_chat_threads(tenant_id, dm_key) WHERE dm_key IS NOT NULL;

    -- Membership IS the access control for a thread. No row, no read.
    CREATE TABLE IF NOT EXISTS floor_chat_thread_members (
      thread_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      added_by_user_id INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_floor_chat_members_user
      ON floor_chat_thread_members(user_id);

    -- Per-(user, thread) watermark. The floor keeps its original single-row
    -- table above - one watermark per user predates threads, and migrating a
    -- live column into a composite key buys nothing but risk.
    CREATE TABLE IF NOT EXISTS floor_chat_thread_reads (
      user_id INTEGER NOT NULL,
      thread_id INTEGER NOT NULL,
      last_read_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, thread_id)
    );
  `);
  // Columns can't be added with IF NOT EXISTS; a duplicate-column error is
  // the "already migrated" signal and nothing else throws that here.
  try {
    rawDb.exec(`ALTER TABLE floor_chat_messages ADD COLUMN thread_id INTEGER`);
  } catch { /* column already exists */ }
  rawDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_floor_chat_thread_msgs
      ON floor_chat_messages(thread_id, id DESC);
  `);
}
ensureFloorChatSchema();

function mapRow(r: any): FloorChatMessage {
  return {
    id: Number(r.id),
    authorUserId: Number(r.author_user_id),
    authorMemberId: r.author_member_id == null ? null : Number(r.author_member_id),
    authorName: String(r.author_name),
    body: String(r.body),
    createdAtMs: Date.parse(r.created_at),
  };
}

export interface ChatAuthor {
  userId: number;
  /** team_members id, or null for a desk login with no field identity. */
  memberId: number | null;
  name: string | null | undefined;
}

// ── The floor ────────────────────────────────────────────────────────────────

/**
 * Post a message to the floor. Throws `{httpStatus: 400}` on the same
 * validation the composer runs, so the two can never disagree about what
 * sends.
 *
 * The author's name is snapshotted as "Marcus T." at write time — the same
 * rule the feed applies to actor_name — so a rename later does not rewrite
 * what the room already read, and a full legal name never sits in a table
 * every phone in the org polls.
 */
export function postChatMessage(
  tenantId: number, author: ChatAuthor, rawBody: unknown, nowMs: number,
): FloorChatMessage {
  return insertMessage(tenantId, null, author, rawBody, nowMs);
}

function insertMessage(
  tenantId: number, threadId: number | null, author: ChatAuthor, rawBody: unknown, nowMs: number,
): FloorChatMessage {
  const check = validateChatMessage(rawBody);
  if (!check.ok) throw Object.assign(new Error(check.error), { httpStatus: 400 });

  const info = rawDb.prepare(
    `INSERT INTO floor_chat_messages
       (tenant_id, thread_id, author_user_id, author_member_id, author_name, body, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    tenantId, threadId, author.userId, author.memberId ?? null,
    shortName(author.name), check.body, new Date(nowMs).toISOString(),
  );
  return {
    id: Number(info.lastInsertRowid),
    authorUserId: author.userId,
    authorMemberId: author.memberId ?? null,
    authorName: shortName(author.name),
    body: check.body,
    createdAtMs: nowMs,
  };
}

/**
 * A room's page, shared by the floor and every thread.
 *
 * Three read shapes, one contract:
 *   · no cursor → the newest `limit` messages, returned ASCENDING so the
 *     client renders a conversation without reversing anything;
 *   · `afterId` → only what arrived since, for the polling loop — a quiet
 *     4-second poll costs a MAX(id) lookup and zero rows, not a page;
 *   · `beforeId` → the page of history ENDING just before that id, for the
 *     "load earlier" affordance. Without this, the badge's whole-room unread
 *     count could promise messages no request would ever deliver — and the
 *     room would simply forget anything older than one page, read or not.
 *
 * `unread` is counted over the WHOLE room in SQL, not filtered over the page:
 * a rep who was gone for three days has more unread than one page holds, and
 * a badge that undercounts teaches people it cannot be trusted. Backfill is
 * what keeps that count honest — every message it promises is reachable.
 */
function roomPage(
  tenantId: number, threadId: number | null, lastRead: number,
  opts: { limit?: number; afterId?: number; beforeId?: number } = {},
): FloorChatPage {
  const cap = Math.max(1, Math.min(200, Math.trunc(opts.limit ?? 60) || 60));
  const afterId = Math.max(0, Math.trunc(opts.afterId ?? 0) || 0);
  const beforeId = Math.max(0, Math.trunc(opts.beforeId ?? 0) || 0);

  // "thread_id IS NULL" for the floor, "thread_id = ?" for a thread — the
  // floor must never leak thread rows now that they share a table.
  const roomWhere = threadId == null ? "thread_id IS NULL" : "thread_id = ?";
  const roomArgs: number[] = threadId == null ? [tenantId] : [tenantId, threadId];

  const latestId = Number((rawDb.prepare(
    `SELECT MAX(id) AS id FROM floor_chat_messages WHERE tenant_id = ? AND ${roomWhere}`,
  ).get(...roomArgs) as any)?.id ?? 0);

  let items: FloorChatMessage[];
  let pageLatest = latestId;
  if (beforeId > 0) {
    // History wins over the poll cursor if a caller ever sends both — a
    // backfill request is explicit user intent; a poll is housekeeping.
    items = (rawDb.prepare(
      `SELECT * FROM floor_chat_messages
        WHERE tenant_id = ? AND ${roomWhere} AND id < ?
        ORDER BY id DESC LIMIT ?`,
    ).all(...roomArgs, beforeId, cap) as any[]).map(mapRow).reverse();
  } else if (afterId > 0) {
    items = (rawDb.prepare(
      `SELECT * FROM floor_chat_messages
        WHERE tenant_id = ? AND ${roomWhere} AND id > ?
        ORDER BY id ASC LIMIT ?`,
    ).all(...roomArgs, afterId, cap) as any[]).map(mapRow);
    // A full page means the cursor read may be TRUNCATED — more arrived than
    // the cap. Report latestId as the last id actually delivered, or a client
    // that marks read at latestId would silently mark messages it never
    // received. The next cursor poll picks up exactly where this one stopped.
    if (items.length === cap) pageLatest = items[items.length - 1]!.id;
  } else {
    items = (rawDb.prepare(
      `SELECT * FROM floor_chat_messages
        WHERE tenant_id = ? AND ${roomWhere} ORDER BY id DESC LIMIT ?`,
    ).all(...roomArgs, cap) as any[]).map(mapRow).reverse();
  }

  const unread = Number((rawDb.prepare(
    `SELECT COUNT(*) AS n FROM floor_chat_messages
      WHERE tenant_id = ? AND ${roomWhere} AND id > ?`,
  ).get(...roomArgs, lastRead) as any)?.n ?? 0);

  return { items, unread, latestId: pageLatest };
}

/** The floor, for one viewer. */
export function chatPageFor(
  tenantId: number, userId: number,
  opts: { limit?: number; afterId?: number; beforeId?: number } = {},
): FloorChatPage {
  const mark = rawDb.prepare(
    `SELECT last_read_id AS id FROM floor_chat_reads WHERE user_id = ?`,
  ).get(userId) as any;
  return roomPage(tenantId, null, Number(mark?.id ?? 0), opts);
}

/** Mark everything up to `upToId` read. Monotonic — same contract as the
 *  feed's watermark, for the same second-device reason. */
export function markChatRead(userId: number, upToId: number, nowMs: number): number {
  const id = Math.max(0, Math.trunc(Number(upToId) || 0));
  rawDb.prepare(
    `INSERT INTO floor_chat_reads (user_id, last_read_id, updated_at)
     VALUES (?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       last_read_id = MAX(last_read_id, excluded.last_read_id),
       updated_at = excluded.updated_at`,
  ).run(userId, id, new Date(nowMs).toISOString());
  const row = rawDb.prepare(
    `SELECT last_read_id AS id FROM floor_chat_reads WHERE user_id = ?`,
  ).get(userId) as any;
  return Number(row?.id ?? 0);
}

// ── Threads ──────────────────────────────────────────────────────────────────

function isThreadMember(threadId: number, userId: number): boolean {
  return !!rawDb.prepare(
    `SELECT 1 FROM floor_chat_thread_members WHERE thread_id = ? AND user_id = ?`,
  ).get(threadId, userId);
}

function threadRow(tenantId: number, threadId: number): any | null {
  return rawDb.prepare(
    `SELECT * FROM floor_chat_threads WHERE tenant_id = ? AND id = ?`,
  ).get(tenantId, Math.trunc(Number(threadId) || 0)) ?? null;
}

function membersOf(threadId: number): ChatThreadMember[] {
  // Joined to users, not snapshotted: a member list is a roster, not history —
  // a rename should show the current name everywhere the roster does.
  return (rawDb.prepare(
    `SELECT m.user_id AS uid, u.team_member_id AS mid, u.name AS name
       FROM floor_chat_thread_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.thread_id = ?
      ORDER BY u.name`,
  ).all(threadId) as any[]).map(r => ({
    userId: Number(r.uid),
    memberId: r.mid == null ? null : Number(r.mid),
    name: shortName(r.name),
  }));
}

function addMembers(threadId: number, userIds: number[], byUserId: number | null, nowMs: number): void {
  const stmt = rawDb.prepare(
    `INSERT OR IGNORE INTO floor_chat_thread_members (thread_id, user_id, added_by_user_id, created_at)
     VALUES (?,?,?,?)`,
  );
  const at = new Date(nowMs).toISOString();
  for (const uid of userIds) stmt.run(threadId, uid, byUserId, at);
}

/**
 * Get-or-create the DM between two people. Idempotent by construction: the
 * UNIQUE (tenant, dm_key) index means two devices racing both land in the
 * same room, and the INSERT OR IGNORE loser simply reads the winner's row.
 */
export function openDm(
  tenantId: number, meUserId: number, otherUserId: number, nowMs: number,
): { threadId: number; created: boolean } {
  const key = dmPairKey(meUserId, otherUserId);
  const info = rawDb.prepare(
    `INSERT OR IGNORE INTO floor_chat_threads (tenant_id, kind, name, dm_key, created_by_user_id, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(tenantId, "dm", null, key, meUserId, new Date(nowMs).toISOString());
  const row = rawDb.prepare(
    `SELECT id FROM floor_chat_threads WHERE tenant_id = ? AND dm_key = ?`,
  ).get(tenantId, key) as any;
  const threadId = Number(row.id);
  // OR IGNORE on membership too — re-opening an existing DM must be a no-op.
  addMembers(threadId, [meUserId, otherUserId], meUserId, nowMs);
  return { threadId, created: info.changes === 1 };
}

/** Create a group. The caller has already resolved and authorized the member
 *  user ids; the creator is always a member — a room you made and cannot see
 *  is a support ticket. Throws {httpStatus:400} on a bad name or empty crew. */
export function createGroup(
  tenantId: number, creatorUserId: number, rawName: unknown, memberUserIds: number[], nowMs: number,
): { threadId: number; name: string } {
  const check = validateGroupName(rawName);
  if (!check.ok) throw Object.assign(new Error(check.error), { httpStatus: 400 });
  const crew = [...new Set([creatorUserId, ...memberUserIds])];
  if (crew.length < 2) {
    throw Object.assign(new Error("Pick at least one member besides yourself."), { httpStatus: 400 });
  }
  if (crew.length > GROUP_MEMBER_MAX) {
    throw Object.assign(new Error(`A group tops out at ${GROUP_MEMBER_MAX} people - past that, use the floor.`), { httpStatus: 400 });
  }
  const info = rawDb.prepare(
    `INSERT INTO floor_chat_threads (tenant_id, kind, name, dm_key, created_by_user_id, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(tenantId, "group", check.name, null, creatorUserId, new Date(nowMs).toISOString());
  const threadId = Number(info.lastInsertRowid);
  addMembers(threadId, crew, creatorUserId, nowMs);
  return { threadId, name: check.name };
}

/**
 * This viewer's conversation list — every thread they belong to, newest
 * activity first, each with the same unread contract the floor keeps. The
 * query fans out per thread; a person's thread list is dozens at most, and a
 * flat join would re-derive the watermark math three times in one statement.
 */
export function myThreads(tenantId: number, userId: number): ChatThreadSummary[] {
  const rows = rawDb.prepare(
    `SELECT t.*
       FROM floor_chat_threads t
       JOIN floor_chat_thread_members me ON me.thread_id = t.id AND me.user_id = ?
      WHERE t.tenant_id = ?`,
  ).all(userId, tenantId) as any[];

  const lastMsgStmt = rawDb.prepare(
    `SELECT * FROM floor_chat_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1`,
  );
  const unreadStmt = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM floor_chat_messages
      WHERE thread_id = ? AND id > COALESCE(
        (SELECT last_read_id FROM floor_chat_thread_reads WHERE user_id = ? AND thread_id = ?), 0)`,
  );

  const summaries = rows.map((t): ChatThreadSummary => {
    const last = lastMsgStmt.get(t.id) as any;
    const lastMapped = last ? mapRow(last) : null;
    return {
      id: Number(t.id),
      kind: String(t.kind) as ChatThreadKind,
      name: t.name == null ? null : String(t.name),
      createdByUserId: Number(t.created_by_user_id),
      members: membersOf(Number(t.id)),
      unread: Number((unreadStmt.get(t.id, userId, t.id) as any)?.n ?? 0),
      latestId: lastMapped?.id ?? 0,
      lastMessage: lastMapped
        ? {
            authorUserId: lastMapped.authorUserId,
            authorName: lastMapped.authorName,
            body: lastMapped.body,
            createdAtMs: lastMapped.createdAtMs,
          }
        : null,
    };
  });

  // Newest conversation first; a silent room sorts by when it was made.
  const activityOf = (s: ChatThreadSummary) =>
    s.lastMessage?.createdAtMs ?? Date.parse(rows.find(r => Number(r.id) === s.id)!.created_at);
  return summaries.sort((a, b) => activityOf(b) - activityOf(a));
}

/** A thread's page — null when the viewer is not a member, and the route
 *  turns that into a 404, never a 403: existence is not confirmed. */
export function threadPageFor(
  tenantId: number, threadId: number, userId: number,
  opts: { limit?: number; afterId?: number; beforeId?: number } = {},
): FloorChatPage | null {
  const t = threadRow(tenantId, threadId);
  if (!t || !isThreadMember(Number(t.id), userId)) return null;
  const mark = rawDb.prepare(
    `SELECT last_read_id AS id FROM floor_chat_thread_reads WHERE user_id = ? AND thread_id = ?`,
  ).get(userId, Number(t.id)) as any;
  return roomPage(tenantId, Number(t.id), Number(mark?.id ?? 0), opts);
}

/** Post into a thread — null (→404) for non-members, same as reading. */
export function postThreadMessage(
  tenantId: number, threadId: number, author: ChatAuthor, rawBody: unknown, nowMs: number,
): FloorChatMessage | null {
  const t = threadRow(tenantId, threadId);
  if (!t || !isThreadMember(Number(t.id), author.userId)) return null;
  const msg = insertMessage(tenantId, Number(t.id), author, rawBody, nowMs);
  markThreadRead(author.userId, Number(t.id), msg.id, nowMs);
  return msg;
}

/** Monotonic, per (user, thread) — the same contract as the floor's mark. */
export function markThreadRead(userId: number, threadId: number, upToId: number, nowMs: number): number {
  const id = Math.max(0, Math.trunc(Number(upToId) || 0));
  // One normalized key for BOTH statements — write truncated and read raw
  // would hand a fractional id a phantom "0" answer for a mark that landed.
  const tid = Math.trunc(Number(threadId) || 0);
  rawDb.prepare(
    `INSERT INTO floor_chat_thread_reads (user_id, thread_id, last_read_id, updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(user_id, thread_id) DO UPDATE SET
       last_read_id = MAX(last_read_id, excluded.last_read_id),
       updated_at = excluded.updated_at`,
  ).run(userId, tid, id, new Date(nowMs).toISOString());
  const row = rawDb.prepare(
    `SELECT last_read_id AS id FROM floor_chat_thread_reads WHERE user_id = ? AND thread_id = ?`,
  ).get(userId, tid) as any;
  return Number(row?.id ?? 0);
}

/** Everything unread across this viewer's threads, for the one badge the nav
 *  shows — computed off the same tables the per-thread counts read, so the
 *  total can never disagree with the list it summarizes. */
export function threadsUnreadTotal(tenantId: number, userId: number): number {
  return Number((rawDb.prepare(
    `SELECT COUNT(*) AS n
       FROM floor_chat_messages m
       JOIN floor_chat_thread_members me ON me.thread_id = m.thread_id AND me.user_id = ?
      WHERE m.tenant_id = ?
        AND m.id > COALESCE(
          (SELECT last_read_id FROM floor_chat_thread_reads r
            WHERE r.user_id = ? AND r.thread_id = m.thread_id), 0)`,
  ).get(userId, tenantId, userId) as any)?.n ?? 0);
}

/** Re-crew a group. Structural, so no membership requirement — but group
 *  only: a DM's roster IS its privacy, and nobody edits it.
 *
 *  The member cap holds HERE too, or it is only a create-time costume check:
 *  a group made at the cap and grown one POST later is the floor wearing a
 *  costume, which is exactly what the cap exists to prevent. And a removal
 *  may not empty the room — a memberless group is unreachable from every
 *  thread list yet still holds messages; dissolving is what DELETE is for. */
export function updateGroupMembers(
  tenantId: number, threadId: number,
  addUserIds: number[], removeUserIds: number[],
  byUserId: number, nowMs: number,
): ChatThreadMember[] | null {
  const t = threadRow(tenantId, threadId);
  if (!t || t.kind !== "group") return null;

  const current = new Set(
    (rawDb.prepare(`SELECT user_id AS uid FROM floor_chat_thread_members WHERE thread_id = ?`)
      .all(Number(t.id)) as any[]).map(r => Number(r.uid)),
  );
  const prospective = new Set(current);
  for (const uid of addUserIds) prospective.add(Math.trunc(Number(uid) || 0));
  for (const uid of removeUserIds) prospective.delete(Math.trunc(Number(uid) || 0));
  prospective.delete(0);
  if (prospective.size > GROUP_MEMBER_MAX) {
    throw Object.assign(new Error(`A group tops out at ${GROUP_MEMBER_MAX} people - past that, use the floor.`), { httpStatus: 400 });
  }
  if (prospective.size === 0) {
    throw Object.assign(new Error("That would empty the group. Disband it instead."), { httpStatus: 400 });
  }

  if (addUserIds.length) addMembers(Number(t.id), addUserIds, byUserId, nowMs);
  if (removeUserIds.length) {
    const del = rawDb.prepare(
      `DELETE FROM floor_chat_thread_members WHERE thread_id = ? AND user_id = ?`,
    );
    for (const uid of removeUserIds) del.run(Number(t.id), Math.trunc(Number(uid) || 0));
  }
  return membersOf(Number(t.id));
}

/**
 * Walk out of a group yourself. Needs no capability — staying in a room is
 * the member's choice, not management's — and works only on groups: leaving
 * a DM would strand your counterpart talking to nobody; deleting your side
 * of a conversation that is half yours isn't a thing either room offers.
 * Returns false when the thread isn't a group you belong to (route 404s).
 */
export function leaveGroup(tenantId: number, threadId: number, userId: number): boolean {
  const t = threadRow(tenantId, threadId);
  if (!t || t.kind !== "group") return false;
  const info = rawDb.prepare(
    `DELETE FROM floor_chat_thread_members WHERE thread_id = ? AND user_id = ?`,
  ).run(Number(t.id), userId);
  if (info.changes !== 1) return false;
  // Last one out dissolves the room. An empty group is unreachable from every
  // thread list — nobody can read it, leave it, or find it to disband it — so
  // keeping its messages would serve exactly no one.
  const left = Number((rawDb.prepare(
    `SELECT COUNT(*) AS n FROM floor_chat_thread_members WHERE thread_id = ?`,
  ).get(Number(t.id)) as any)?.n ?? 0);
  if (left === 0) deleteGroupThread(tenantId, Number(t.id));
  return true;
}

/** Delete a group and everything in it. Group only — a DM is its two
 *  members' history, and no third party gets to erase it. */
export function deleteGroupThread(tenantId: number, threadId: number): boolean {
  const t = threadRow(tenantId, threadId);
  if (!t || t.kind !== "group") return false;
  const id = Number(t.id);
  rawDb.prepare(`DELETE FROM floor_chat_messages WHERE tenant_id = ? AND thread_id = ?`).run(tenantId, id);
  rawDb.prepare(`DELETE FROM floor_chat_thread_members WHERE thread_id = ?`).run(id);
  rawDb.prepare(`DELETE FROM floor_chat_thread_reads WHERE thread_id = ?`).run(id);
  const info = rawDb.prepare(
    `DELETE FROM floor_chat_threads WHERE tenant_id = ? AND id = ? AND kind = 'group'`,
  ).run(tenantId, id);
  return info.changes === 1;
}

// ── Deleting a message ───────────────────────────────────────────────────────

/** What the audit row gets to keep about a removed message: WHOSE words were
 *  removed — never the words themselves, which would smuggle chat content
 *  into a log that outlives the room's own delete. `room` is what lets the
 *  route treat a DM delete differently: logging a DM's threadId would let a
 *  log reader pair up who talks privately to whom, the exact metadata the
 *  un-logged DM-creation path refuses to collect. */
export interface DeletedChatMessage {
  authorUserId: number;
  authorName: string;
  threadId: number | null;
  room: "floor" | "group" | "dm";
}

/**
 * Remove a message, wherever it lives. Authorization stays in each DELETE's
 * WHERE clause (the same rule deleteAuthored follows); the SELECT below feeds
 * the audit row only.
 *
 * The rules, per room:
 *   · your own words — always, in any room you could post in;
 *   · the floor      — any moderator (`canModerate`);
 *   · a group        — a moderator who is IN the group. Moderation is a
 *                      member's act; the capability alone doesn't open doors;
 *   · a DM           — nobody but the author. A DM that managers can reach
 *                      into is not a DM, and the org has been told it is.
 */
export function deleteChatMessage(
  tenantId: number, id: number, byUserId: number, canModerate: boolean,
): DeletedChatMessage | null {
  const msgId = Math.trunc(Number(id) || 0);
  const row = rawDb.prepare(
    `SELECT author_user_id AS uid, author_name AS name, thread_id AS tid
       FROM floor_chat_messages WHERE tenant_id = ? AND id = ?`,
  ).get(tenantId, msgId) as any;

  // Own words first — needs no capability and covers every room.
  let info = rawDb.prepare(
    `DELETE FROM floor_chat_messages
      WHERE tenant_id = ? AND id = ? AND author_user_id = ?`,
  ).run(tenantId, msgId, byUserId);

  if (info.changes !== 1 && canModerate) {
    // Floor moderation.
    info = rawDb.prepare(
      `DELETE FROM floor_chat_messages
        WHERE tenant_id = ? AND id = ? AND thread_id IS NULL`,
    ).run(tenantId, msgId);
    if (info.changes !== 1) {
      // Group moderation — the membership requirement rides IN the clause.
      info = rawDb.prepare(
        `DELETE FROM floor_chat_messages
          WHERE tenant_id = ? AND id = ?
            AND thread_id IN (
              SELECT t.id FROM floor_chat_threads t
                JOIN floor_chat_thread_members m ON m.thread_id = t.id AND m.user_id = ?
               WHERE t.kind = 'group')`,
      ).run(tenantId, msgId, byUserId);
    }
  }

  if (info.changes !== 1) return null;
  let room: DeletedChatMessage["room"] = "floor";
  if (row?.tid != null) {
    const t = rawDb.prepare(`SELECT kind FROM floor_chat_threads WHERE id = ?`).get(Number(row.tid)) as any;
    room = t?.kind === "dm" ? "dm" : "group";
  }
  return {
    authorUserId: Number(row?.uid ?? -1),
    authorName: String(row?.name ?? ""),
    threadId: row?.tid == null ? null : Number(row.tid),
    room,
  };
}
