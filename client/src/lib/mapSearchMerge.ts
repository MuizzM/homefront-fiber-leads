// ── Map search: loaded pins + the server's index ─────────────────────────────
//
// The map's own search used to read ONLY the pins already in client state. In a
// small market that is every door in the org and everything is findable; at
// production scale the map holds a viewport slice, so most doors were missing
// from it and the panel answered "No lead in your org matches" about a door
// that plainly exists. It could not reproduce on a dev box, where the whole
// table fits in the pin set.
//
// The merge lives here, out of the 10k-line page, so the ordering and the
// dedupe rule can be tested without mounting a map.

export type SearchableDoor = {
  id: number;
  lat?: number | null;
  lng?: number | null;
};

/**
 * Loaded pins first, then whatever else the server found.
 *
 * Local matches lead because they are instant and already ranked by lead score:
 * the row a rep is most likely to want must not move under their thumb when the
 * network answers a moment later. Server rows fill the remainder in the order
 * the server ranked them.
 *
 * Rows without coordinates are dropped. The only thing this list does is fly
 * the camera to a door, and a row that cannot do that is a dead entry.
 */
export function mergeSearchMatches<T extends SearchableDoor>(
  loaded: readonly T[],
  fromServer: readonly T[] | undefined,
  limit = 8,
): T[] {
  const out: T[] = [];
  const seen = new Set<number>();
  for (const door of loaded) {
    if (out.length >= limit) return out;
    if (seen.has(door.id)) continue;
    seen.add(door.id);
    out.push(door);
  }
  for (const door of fromServer ?? []) {
    if (out.length >= limit) break;
    if (seen.has(door.id)) continue;
    if (door.lat == null || door.lng == null) continue;
    seen.add(door.id);
    out.push(door);
  }
  return out;
}
