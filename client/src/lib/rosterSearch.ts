// ── Roster search ────────────────────────────────────────────────────────────
// The ONE search semantic for finding a person in a long list. Extracted from
// territory/RepPicker so every picker filters the same way - two search
// behaviours for the same product question ("where is Ann Rivera?") is how a
// manager learns to distrust search boxes. (shared/territoryFilter.ts still
// implements a stricter word-start-only rule for territory names; unifying
// PEOPLE search with TERRITORY search is a product decision, not a tidy-up.)
//
// Scale contract, shared by every consumer:
//   - filter with matchPerson (word-start match, substring fallback)
//   - render at most ROSTER_MAX_ROWS rows and SAY how many are hidden -
//     silent truncation reads as "that rep doesn't exist"
//   - surface recents first only when the list is long and the query is empty

/** Match on any word start, so "riv" finds "Ann Rivera" and "ann" does too -
 *  with a substring fallback, so "iver" finds her as well. */
export function matchPerson(name: string, q: string): boolean {
  const n = name.toLowerCase();
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return needle.split(/\s+/).every(
    (term) => n.split(/\s+/).some((word) => word.startsWith(term)) || n.includes(term),
  );
}

/** Search boxes appear past this many people - below it they are noise. */
export const ROSTER_SEARCH_THRESHOLD = 8;

/** Max rows a people list renders at once; the rest are reachable by typing.
 *  60 is one flick of scroll, and honest capping beats virtualization here:
 *  nobody FINDS a name by scrolling 300 rows - they type. */
export const ROSTER_MAX_ROWS = 60;

/** Pull the recently used people to the front, preserving order inside both
 *  groups. Only meaningful with an empty query on a long list - callers gate
 *  on that so search results never reorder under the cursor. */
export function withRecentsFirst<T extends { id: number }>(list: T[], recentIds: number[]): T[] {
  if (!recentIds.length) return list;
  const rank = new Map(recentIds.map((id, i) => [id, i] as const));
  const recent: T[] = [];
  const rest: T[] = [];
  for (const item of list) (rank.has(item.id) ? recent : rest).push(item);
  recent.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return [...recent, ...rest];
}
