// ── Team announcements — persistence, scope, and the unread count ───────────
// The copy and the rules are pure and live in shared/teamFeed.ts. This file
// stores an announcement once, hands back the slice a given viewer may see, and
// tracks what they have already read.
//
// TWO THINGS DO THE LOAD-BEARING WORK HERE:
//
//   1. dedupe_key is UNIQUE per tenant. Every publisher is a retryable code path
//      — a re-submitted knock, a replayed offline queue, two servers racing —
//      so "announce once" has to be a database constraint, not a convention. A
//      duplicate insert is IGNORED, not an error: the caller does not care
//      whether it or someone else won the race.
//   2. The viewer filter is applied in SQL, not in the component. An
//      announcement a rep should not see must never reach their device, because
//      "hidden in the UI" is not hidden.

import { rawDb } from "./db";
import { storage, orgTimezoneFor } from "./storage";
import {
  announceSale, announceStreak, visibleTo, buildAuthoredAnnouncement,
  validateAuthoredAnnouncement,
  type Announcement, type AnnouncementKind, type SaleFacts, type StreakFacts,
  type AuthoredAnnouncementInput,
} from "@shared/teamFeed";
import { localWallToUtcMs, localYmdParts } from "@shared/workweek";

export function ensureTeamFeedSchema(): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS team_announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      actor_rep_id INTEGER,
      actor_name TEXT NOT NULL,
      headline TEXT NOT NULL,
      body TEXT NOT NULL,
      amount_cents INTEGER,
      dedupe_key TEXT NOT NULL,
      -- ISO-8601 with milliseconds, always. Same rule as the spiffs ledger, and
      -- for the same reason: this column is range-filtered and ordered as TEXT,
      -- so SQLite's datetime('now') shape would not interleave with it.
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_announcements_dedupe
      ON team_announcements(tenant_id, dedupe_key);
    -- The feed query is always (tenant, newest first) with an optional id floor.
    CREATE INDEX IF NOT EXISTS idx_team_announcements_feed
      ON team_announcements(tenant_id, id DESC);

    CREATE TABLE IF NOT EXISTS team_announcement_reads (
      user_id INTEGER PRIMARY KEY,
      last_read_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
}
ensureTeamFeedSchema();

export interface StoredAnnouncement extends Announcement {
  id: number;
  createdAtMs: number;
}

function mapRow(r: any): StoredAnnouncement {
  return {
    id: Number(r.id),
    kind: String(r.kind) as AnnouncementKind,
    actorRepId: Number(r.actor_rep_id),
    actorName: String(r.actor_name),
    headline: String(r.headline),
    body: String(r.body),
    amountCents: r.amount_cents == null ? undefined : Number(r.amount_cents),
    dedupeKey: String(r.dedupe_key),
    createdAtMs: Date.parse(r.created_at),
  };
}

/**
 * Store an announcement. Returns the row when THIS call created it, and null
 * when it already existed.
 *
 * The null return is what callers gate their live push on — otherwise a retried
 * knock re-broadcasts a sale the floor already heard about, which is worse than
 * not announcing it at all.
 */
export function publish(tenantId: number, a: Announcement, nowMs: number): StoredAnnouncement | null {
  const createdAt = new Date(nowMs).toISOString();
  const info = rawDb.prepare(
    `INSERT OR IGNORE INTO team_announcements
       (tenant_id, kind, actor_rep_id, actor_name, headline, body, amount_cents, dedupe_key, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(tenantId, a.kind, a.actorRepId, a.actorName, a.headline, a.body,
        a.amountCents ?? null, a.dedupeKey, createdAt);
  if (info.changes !== 1) return null;
  return { ...a, id: Number(info.lastInsertRowid), createdAtMs: nowMs };
}

// ── Publishers ──────────────────────────────────────────────────────────────
// Thin wrappers so the knock handler states WHAT happened and never has to
// assemble copy inline. Both return null when the event was already announced.

// The org timezone read is storage's memoized resolver (same value, same
// fallback) rather than a third hand-rolled copy of the tenants query.
function orgTimezone(tenantId: number): string {
  return orgTimezoneFor(tenantId);
}

/** Sales counts for the org's LOCAL day — "3 today" must roll over at midnight
 *  where the rep lives, not at midnight UTC. */
function saleCounts(tenantId: number, repId: number, nowMs: number): { mine: number; team: number } {
  const { y, mo, d } = localYmdParts(nowMs, orgTimezone(tenantId));
  const startIso = new Date(localWallToUtcMs(y, mo, d, 0, 0, orgTimezone(tenantId))).toISOString();
  // knock_log carries its own tenant_id (stamped from the lead at insert, and
  // NULL-tenant legacy rows were adopted by bootstrapDefaultTenant), so the
  // tenant wall reads straight off idx_knock_log_tenant_time as a range scan
  // of today's rows. The old JOIN through leads made every sold-knock
  // announcement walk the tenant's ENTIRE lead index just to apply the wall.
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS team, SUM(CASE WHEN rep_id = ? THEN 1 ELSE 0 END) AS mine
       FROM knock_log
      WHERE tenant_id = ? AND outcome = 'sold'
        AND COALESCE(superseded, 0) = 0
        AND knocked_at >= ?`,
  ).get(repId, tenantId, startIso) as any;
  return { mine: Number(row?.mine ?? 0), team: Number(row?.team ?? 0) };
}

export function publishSale(
  tenantId: number, repId: number, knockId: number, leadId: number, nowMs: number,
): StoredAnnouncement | null {
  const rep = storage.getTeamMemberById(repId);
  const lead = rawDb.prepare(
    `SELECT l.address AS address, t.name AS area_name
       FROM leads l LEFT JOIN territories t ON t.id = l.assigned_territory_id
      WHERE l.id = ? LIMIT 1`,
  ).get(leadId) as any;
  const counts = saleCounts(tenantId, repId, nowMs);

  const facts: SaleFacts = {
    repId, repName: rep?.name ?? null, knockId,
    address: lead?.address ?? null,
    areaName: lead?.area_name ?? null,
    salesToday: counts.mine, teamSalesToday: counts.team,
  };
  return publish(tenantId, announceSale(facts), nowMs);
}

export function publishStreak(
  tenantId: number, repId: number,
  offer: { id: number; amountCents: number; score: number; remainingMs: number },
  nowMs: number,
): StoredAnnouncement | null {
  const rep = storage.getTeamMemberById(repId);
  const facts: StreakFacts = {
    repId, repName: rep?.name ?? null,
    offerId: offer.id, offerAmountCents: offer.amountCents,
    score: offer.score, minutesLeft: offer.remainingMs / 60_000,
  };
  return publish(tenantId, announceStreak(facts), nowMs);
}

// ── Reading ─────────────────────────────────────────────────────────────────

export interface FeedPage {
  items: StoredAnnouncement[];
  unread: number;
  /** Newest id the viewer could see — what to POST back as read. */
  latestId: number;
}

/**
 * The viewer's feed.
 *
 * `actor_rep_id <> viewer` is in the WHERE clause rather than a filter on the
 * client: a rep's own sale must not be shipped to their device and then hidden,
 * and the unread count has to agree with the list it labels.
 */
export function feedFor(
  tenantId: number, viewerRepId: number | null, limit = 40,
): FeedPage {
  const cap = Math.max(1, Math.min(200, Math.trunc(limit) || 40));
  const excludeSelf = viewerRepId != null;
  const rows = rawDb.prepare(
    `SELECT * FROM team_announcements
      WHERE tenant_id = ?
        ${excludeSelf ? "AND (actor_rep_id IS NULL OR actor_rep_id <> ?)" : ""}
      ORDER BY id DESC LIMIT ?`,
  ).all(...(excludeSelf ? [tenantId, viewerRepId, cap] : [tenantId, cap])) as any[];
  const items = rows.map(mapRow);
  return { items, unread: 0, latestId: items.length ? items[0]!.id : 0 };
}

/** Feed plus this user's unread count, in one call — the bell and the list must
 *  never disagree about how many there are. */
export function feedForUser(
  tenantId: number, userId: number, viewerRepId: number | null, limit = 40,
): FeedPage {
  const page = feedFor(tenantId, viewerRepId, limit);
  const mark = rawDb.prepare(
    `SELECT last_read_id AS id FROM team_announcement_reads WHERE user_id = ?`,
  ).get(userId) as any;
  const lastRead = Number(mark?.id ?? 0);
  return { ...page, unread: page.items.filter(i => i.id > lastRead).length };
}

/** Mark everything up to `upToId` read. Monotonic — a stale request from a
 *  second device cannot un-read what the first already cleared. */
export function markRead(userId: number, upToId: number, nowMs: number): number {
  const id = Math.max(0, Math.trunc(Number(upToId) || 0));
  rawDb.prepare(
    `INSERT INTO team_announcement_reads (user_id, last_read_id, updated_at)
     VALUES (?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       last_read_id = MAX(last_read_id, excluded.last_read_id),
       updated_at = excluded.updated_at`,
  ).run(userId, id, new Date(nowMs).toISOString());
  const row = rawDb.prepare(`SELECT last_read_id AS id FROM team_announcement_reads WHERE user_id = ?`).get(userId) as any;
  return Number(row?.id ?? 0);
}

/** Re-export so the SSE fan-out applies exactly the same rule as the feed. */
export { visibleTo };


/**
 * Post a manager-written promo or update.
 *
 * The dedupe key is a SEQUENCE, not a hash of the text: two identical "Push
 * tonight" promos on consecutive Fridays are both real posts, and content
 * hashing would silently swallow the second — the failure mode where a manager
 * types an announcement, sees nothing happen, and types it again.
 */
export function publishAuthored(
  tenantId: number, actorUserId: number | null, authorName: string | null,
  input: AuthoredAnnouncementInput, nowMs: number,
): StoredAnnouncement | null {
  const problem = validateAuthoredAnnouncement(input);
  if (problem) throw Object.assign(new Error(problem), { httpStatus: 400 });

  // MAX(id), not COUNT(*): the sent log can DELETE a bad post, and a counting
  // sequence would hand the next announcement a key a deleted one already used
  // — silently colliding on the UNIQUE index, so the manager types a promo,
  // sees nothing happen, and types it again. MAX(id) cannot do that: a row's
  // seq is always <= its own id (AUTOINCREMENT hands out ids above every id
  // that existed when the seq was read), so a fresh MAX(id)+1 is strictly
  // greater than every live row's seq no matter what has been deleted.
  const row = rawDb.prepare(
    `SELECT MAX(id) AS n FROM team_announcements WHERE tenant_id = ?`,
  ).get(tenantId) as any;
  const seq = Number(row?.n ?? 0) + 1;

  const announcement = buildAuthoredAnnouncement(input, authorName, seq);
  const stored = publish(tenantId, announcement, nowMs);
  if (stored) {
    storage.logActivity(actorUserId, `announcement.${input.kind}.posted`, "tenant", tenantId, {
      title: announcement.headline, amountCents: input.amountCents ?? null,
    }, undefined);
  }
  return stored;
}


// ── The sent log — what the floor has actually been told ────────────────────
//
// A manager writing to every phone in the org is the one action here with no
// undo and no record. Without this they cannot answer "did I already post the
// double-spiff thing?" — so they post it again, and the floor learns that the
// feed repeats itself and stops reading it.
//
// AUTHORED KINDS ONLY. A sale is a record of something that happened; it is
// not a thing anybody sent, and it is not a thing anybody may retract.

export interface SentAnnouncement extends StoredAnnouncement {
  /** People who have opened the feed past this one. */
  readCount: number;
  /** Active people in the org — the denominator readCount is out of. */
  audience: number;
}

/**
 * Read is derived from the SAME last_read_id the bell clears, so the number a
 * manager sees is the number of people who actually opened the feed — not the
 * number of phones we managed to buzz, which is a delivery stat dressed up as
 * an attention stat.
 */
export function sentAuthored(tenantId: number, limit = 30): SentAnnouncement[] {
  const cap = Math.max(1, Math.min(200, Math.trunc(limit) || 30));
  const audience = Number((rawDb.prepare(
    `SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND active = 1`,
  ).get(tenantId) as any)?.n ?? 0);

  const rows = rawDb.prepare(
    `SELECT a.*,
            (SELECT COUNT(*)
               FROM users u
               JOIN team_announcement_reads r ON r.user_id = u.id
              WHERE u.tenant_id = a.tenant_id AND u.active = 1
                AND r.last_read_id >= a.id) AS read_count
       FROM team_announcements a
      WHERE a.tenant_id = ? AND a.kind IN ('promo','update')
      ORDER BY a.id DESC LIMIT ?`,
  ).all(tenantId, cap) as any[];

  return rows.map(r => ({
    ...mapRow(r),
    // Capped at the audience: a user who read and then left the org would
    // otherwise push "12 of 11 read" onto the screen.
    readCount: Math.min(audience, Number(r.read_count ?? 0)),
    audience,
  }));
}

/**
 * Retract a post. Tenant-scoped and kind-scoped in the WHERE clause rather than
 * checked first and deleted second — a delete that takes its authorization from
 * a separate query is a delete that runs when the two disagree.
 *
 * Nothing is done about the phones already buzzed. That is honest: a push
 * notification cannot be recalled, and the UI says so rather than implying this
 * unrings the bell.
 */
export function deleteAuthored(tenantId: number, id: number): boolean {
  const info = rawDb.prepare(
    `DELETE FROM team_announcements
      WHERE tenant_id = ? AND id = ? AND kind IN ('promo','update')`,
  ).run(tenantId, Math.trunc(Number(id) || 0));
  return info.changes === 1;
}
