// ── Announcement bus (tenant-scoped, in-process) ────────────────────────────
// Live delivery for team announcements. Deliberately much simpler than
// leadEvents' bus, and the difference is worth stating because the asymmetry
// looks like an oversight otherwise:
//
//   leadEvents keeps a RECONNECT RING because a missed pin patch is invisible —
//   the client has no way to notice a sold door never arrived, so the bus has to
//   replay and to REPORT gaps.
//
//   An announcement has a durable, authoritative home: the team_announcements
//   table, which the client fetches on mount and can refetch at any time. A
//   client that misses a frame sees the announcement the moment it reloads the
//   feed, and the unread count is computed from ids rather than from delivery.
//   So there is nothing here to replay, and a ring would only add a second,
//   staler copy of a record that already exists.
//
// Emission is best-effort by design: publishing an announcement must never be
// able to fail a knock.
import { EventEmitter } from "node:events";
import type { StoredAnnouncement } from "./teamFeedStore";

export interface AnnouncementEvent {
  tenantId: number;
  announcement: StoredAnnouncement;
}

const EVENT = "announcement";
const bus = new EventEmitter();
// One listener per connected field phone, same ceiling as the lead bus. Raised
// rather than disabled — 0 means "unlimited", which is how a listener leak hides.
bus.setMaxListeners(500);

/** Fan out to live subscribers. Returns false when the event was undeliverable. */
export function emitAnnouncement(tenantId: number, announcement: StoredAnnouncement | null): boolean {
  // A tenant-less event is DROPPED rather than broadcast under a placeholder:
  // every read path is an exact tenant match, so "no tenant" cannot mean
  // "everyone" here without becoming a cross-org leak the first time someone
  // relaxes a filter.
  const tid = Number(tenantId);
  if (!announcement || !Number.isInteger(tid) || tid <= 0) return false;
  try {
    bus.emit(EVENT, { tenantId: tid, announcement } satisfies AnnouncementEvent);
    return true;
  } catch {
    return false;   // a dead socket downstream must never fail the caller
  }
}

export function onAnnouncement(listener: (evt: AnnouncementEvent) => void): () => void {
  bus.on(EVENT, listener);
  return () => bus.off(EVENT, listener);
}
