// ── Pending-knock overlay — the fix for "the pin changed back" ──────────────
//
// THE BUG. Logging a knock patched the new pin state straight into the
// react-query cache and left it there:
//
//     qc.setQueryData(["/api/leads/map"], patch)   // one shot, then hope
//
// A one-shot patch survives exactly until the next server read replaces it. And
// `/api/leads/map` is read constantly — a 60s poll, the map-changed SSE stream
// firing on ANY teammate's knock, a tab refocus, a route change. Every one of
// those refetches returned server data that did not have the rep's knock yet,
// because the knock was still sitting in the offline queue waiting to flush.
//
// The window is not small. `log()` awaits captureFieldFix() — a GPS read — before
// it flushes, and a cold GPS fix on a phone in a pocket can take seconds. Offline,
// the window is however long the rep is out of signal. Any refetch in that gap
// reverted the pin, and it re-appeared later when the queue drained. That is
// exactly "it changes and then changes back".
//
// THE FIX. The optimistic state stops being a value someone wrote once and
// becomes a DERIVATION of durable queue state, re-applied after every server
// read. The queue already persists unsent knocks to localStorage and survives
// reload; exposing them (QueueSnapshot.pendingOutcomes) means the overlay can
// always be rebuilt. A refetch can no longer lose what it never owned.
//
// The overlay clears itself: once a knock reaches the server it leaves the
// pending set, and the very next read shows server truth. Nothing to expire,
// nothing to garbage-collect, and no way for a stuck overlay to mask reality.

import type { QueryClient } from "@tanstack/react-query";
import { OUTCOME_TO_STATUS, type KnockOutcome } from "@shared/knock";

export type PendingOutcomes = Record<number, { outcome: string; at: string }>;

interface Pin {
  id: number;
  leadStatus?: string;
  visited?: boolean;
  knockCount?: number | null;
  lastOutcome?: string | null;
  lastKnockedAt?: string | null;
  lastOutcomeAt?: string | null;
  [k: string]: unknown;
}

/** Apply one unsent knock to one pin. Exported for the tests that pin the
 *  recolor rules, and used by the merge below. */
export function applyPendingOutcome(pin: Pin, pending: { outcome: string; at: string }): Pin {
  const status = OUTCOME_TO_STATUS[pending.outcome as KnockOutcome];
  return {
    ...pin,
    leadStatus: status ?? pin.leadStatus,
    visited: true,
    // Do NOT increment here. The count is re-derived from server data on every
    // read, so incrementing per merge would climb on every poll — the pin would
    // claim eleven knocks on a door tapped once.
    knockCount: pin.knockCount ?? 0,
    lastOutcome: pending.outcome,
    lastKnockedAt: pending.at || pin.lastKnockedAt,
    lastOutcomeAt: pending.at || pin.lastOutcomeAt,
  };
}

/**
 * Merge unsent knocks over a server map payload.
 *
 * Returns the SAME object when nothing changes, so the caller can skip a
 * pointless cache write (and the render it would cause).
 *
 * A pending knock older than what the server already reports is dropped rather
 * than applied: that means the server has settled a NEWER outcome for the door —
 * a teammate got there, or a manager corrected it — and re-applying the rep's
 * stale tap over it would resurrect an outcome the server's own CAS rejected.
 */
export function mergePendingOutcomes<T extends { pins?: Pin[] }>(
  data: T | undefined,
  pending: PendingOutcomes,
): T | undefined {
  if (!data?.pins?.length) return data;
  const ids = Object.keys(pending);
  if (ids.length === 0) return data;

  let changed = false;
  const pins = data.pins.map(pin => {
    const p = pending[pin.id];
    if (!p) return pin;
    // The server already knows something at least as new — let it stand.
    const serverAt = String(pin.lastOutcomeAt ?? "");
    if (serverAt && p.at && serverAt >= p.at) return pin;
    // Already showing this outcome — nothing to write.
    if (pin.lastOutcome === p.outcome && pin.visited === true) return pin;
    changed = true;
    return applyPendingOutcome(pin, p);
  });
  return changed ? { ...data, pins } : data;
}

/**
 * Re-apply the overlay after every SERVER read of the map.
 *
 * One subscriber rather than a change at each call site: `/api/leads/map` is
 * read from several screens with their own queryFns, and a rule that has to be
 * remembered at every call site is a rule that will be missed at the next one.
 *
 * Only reacts to fetch results (`action.type === "success"`). Our own
 * setQueryData below emits a different action type, so this cannot feed itself.
 */
export function installPendingKnockOverlay(
  qc: QueryClient,
  getPending: () => PendingOutcomes,
): () => void {
  return qc.getQueryCache().subscribe(event => {
    if (event.type !== "updated") return;
    if ((event as any).action?.type !== "success") return;
    const key = event.query.queryKey as unknown[];
    if (!Array.isArray(key) || key[0] !== "/api/leads/map") return;

    const pending = getPending();
    if (!pending || Object.keys(pending).length === 0) return;

    const data = event.query.state.data as { pins?: Pin[] } | undefined;
    const merged = mergePendingOutcomes(data, pending);
    // Reference equality means the read already agreed with the overlay.
    if (merged === data) return;
    qc.setQueryData(key, merged);
  });
}
