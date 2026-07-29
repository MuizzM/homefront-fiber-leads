// A version stamp for "the territory table changed".
//
// repCanAccessLead answers "may this person read this door", and for a rep it
// answers by scanning every territory in the tenant and JSON.parsing each
// assignee list. That is fine once. It is not fine on the SSE path, where the
// question is asked once per event PER CONNECTED SUBSCRIBER — ten reps watching
// a busy area turn one door knock into ten full-table scans.
//
// Measured at 200 areas / 10 subscribers / 100 events: 53.86ms of pure
// authorization work, and 200,000 JSON.parse calls.
//
// The fix is a memo, and the only thing that makes a memo safe on an
// authorization path is invalidation that cannot be forgotten. So the stamp
// lives here, apart from both the reader and the writer, and every territory
// write bumps it UNCONDITIONALLY — not "when assignees changed", because a
// repId edit changes access too, and a bump that reasons about which fields
// matter is a bump that will eventually reason wrong.
//
// Failure mode if this is ever missed: a rep keeps reading doors in an area that
// was reclaimed from them. That is the exact leak the visibility work closed, so
// it stays covered by the reclaim-revokes-access integration test, which goes
// through storage and then hits the API — a stale cache fails it.

let version = 0;

/** Called by every territory write. Cheap enough that "call it always" is the
 *  rule; there is no version of this worth optimising. */
export function bumpTerritoryVersion(): void {
  version++;
}

export function territoryVersion(): number {
  return version;
}

interface Entry {
  version: number;
  value: Set<number>;
}

const cache = new Map<string, Entry>();

/** Bounded so a tenant with many distinct team-lead rosters cannot grow this
 *  without limit. Small: the key space is (tenant, scope), and scopes repeat. */
const MAX_ENTRIES = 500;

/**
 * Memoised per (tenant, scope) and invalidated by the version stamp.
 *
 * Correctness rests on one property: a cached value is returned ONLY when the
 * stamp still matches the one it was computed at. Any territory write anywhere
 * invalidates every entry at once, which is blunt and exactly right — a
 * finer-grained scheme would have to know which scopes an area affects, and
 * getting that wrong grants access rather than merely costing time.
 */
export function cachedScopeLookup(
  key: string,
  compute: () => Set<number>,
): Set<number> {
  const current = version;
  const hit = cache.get(key);
  if (hit && hit.version === current) return hit.value;

  const value = compute();
  // Drop the whole map rather than evict cleverly: entries are only valid for
  // one version anyway, so a full clear on overflow costs nothing real.
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, { version: current, value });
  return value;
}

/** Test seam. Production never needs this — the stamp handles invalidation. */
export function resetTerritoryScopeCache(): void {
  cache.clear();
  version++;
}
