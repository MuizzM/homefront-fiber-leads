// ── Last-session pin snapshot — pins on the FIRST frame of a cold open ───────
// Cold-opening the map used to wait a full network round-trip before any pin
// painted. This persists the most recent FULL-FEED pins payload (post-fetch,
// pre-filter — exactly what the ["/api/leads/map"] query cache holds) so the
// next launch can seed the query cache synchronously and paint pins on the
// first frame, with the normal fetch/ETag flow replacing it moments later.
//
// STORAGE CHOICE — localStorage, deliberately:
//   * The read must be SYNCHRONOUS to serve as useQuery initialData (the whole
//     point is the first frame; IndexedDB reads land a tick late).
//   * Pins are compact positional wire rows (packMapPins): a typical tenant
//     (~5k doors) serializes to ~1MB. The only feeds bigger than that live
//     near the 60k viewport-mode threshold (~2-3MB) — and viewport mode never
//     writes a snapshot at all (a bbox window is a partial slice, not the map).
//   * MAX_BYTES caps the worst case below quota risk: an oversized payload
//     skips the write (and drops any stale copy) instead of throwing.
//
// KEYING / INVALIDATION:
//   * The key embeds MAP_PINS_WIRE_VERSION + tenant id + user id. A snapshot
//     from an older wire version is unreachable by key AND rejected by
//     unpackMapPins (double-checked); a snapshot from another user/tenant is
//     unreachable by key, so one user's pins can never paint for the next
//     login on a shared device.
//   * There is at most ONE snapshot per device: every read and write prunes
//     all other hf.mapPinsSnapshot.* keys (old versions, previous users) —
//     the storage-side complement to auth's logout cache purge, which this
//     module cannot hook (auth teardown lives outside the map's ownership).
//   * Corrupt JSON, a foreign shape, or a version mismatch all read as null —
//     the map simply cold-opens the old way.
import {
  MAP_PINS_WIRE_VERSION,
  packMapPins,
  unpackMapPins,
  type MapPinWireField,
} from "@shared/mapPinsWire";

export const MAP_PINS_SNAPSHOT_PREFIX = "hf.mapPinsSnapshot.";

/** Hard byte cap (UTF-16 code units ≈ bytes for this ASCII-heavy JSON). Sized
 *  so even a feed near the viewport-mode threshold cannot blow the ~5MB
 *  localStorage quota shared with the rest of the app. */
export const MAP_PINS_SNAPSHOT_MAX_BYTES = 2_500_000;

/** Debounce for the post-fetch write: pin churn (optimistic knocks, stream
 *  pushes) settles before storage is touched, ~1 write per burst. */
export const MAP_PINS_SNAPSHOT_DEBOUNCE_MS = 2_000;

export interface MapPinsSnapshotScope {
  tenantId: number | null | undefined;
  userId: number | null | undefined;
}

/** Minimal Storage surface so tests can inject a plain fake. */
export interface SnapshotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

function defaultStorage(): SnapshotStorage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null; // storage blocked (private mode) — snapshots just don't exist
  }
}

export function mapPinsSnapshotKey(scope: MapPinsSnapshotScope): string {
  return `${MAP_PINS_SNAPSHOT_PREFIX}v${MAP_PINS_WIRE_VERSION}.t${scope.tenantId ?? 0}.u${scope.userId ?? 0}`;
}

/** Remove every snapshot key except `keep` (pass nothing to clear them all).
 *  Runs on both read and write so a stale-version or previous-user snapshot
 *  never outlives the first map open of the current identity. */
export function pruneMapPinsSnapshots(keep?: string, storage: SnapshotStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(MAP_PINS_SNAPSHOT_PREFIX) && k !== keep) doomed.push(k);
    }
    for (const k of doomed) storage.removeItem(k);
  } catch {
    /* storage blocked mid-iteration — nothing to prune */
  }
}

/**
 * Read the current identity's snapshot: `{ pins, total }` in the exact shape
 * the ["/api/leads/map"] query cache stores, or null when there is no valid
 * snapshot (missing, corrupt JSON, wrong wire version, or foreign scope —
 * foreign scopes are unreachable by key and pruned here as a side effect).
 */
export function readMapPinsSnapshot<T extends Partial<Record<MapPinWireField, unknown>>>(
  scope: MapPinsSnapshotScope,
  storage: SnapshotStorage | null = defaultStorage(),
): { pins: T[]; total: number } | null {
  if (!storage) return null;
  const key = mapPinsSnapshotKey(scope);
  pruneMapPinsSnapshots(key, storage);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    // unpackMapPins hard-fails on a version or row-shape mismatch — exactly the
    // "stale snapshot must be ignored" contract, enforced by shared wire code.
    const { pins, total } = unpackMapPins<T>(JSON.parse(raw));
    return { pins, total };
  } catch {
    // Corrupt / stale-version payload: drop it so it never re-parses.
    try { storage.removeItem(key); } catch { /* storage blocked */ }
    return null;
  }
}

/**
 * Persist the full-feed pins for the given identity. Temp optimistic pins
 * (negative ids — an in-flight one-tap add) are excluded: they are not durable
 * truth and must never resurrect on the next launch. Returns true when a
 * snapshot was actually stored.
 */
export function writeMapPinsSnapshot<T extends Partial<Record<MapPinWireField, unknown>> & { id?: unknown }>(
  scope: MapPinsSnapshotScope,
  pins: readonly T[],
  storage: SnapshotStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  const key = mapPinsSnapshotKey(scope);
  pruneMapPinsSnapshots(key, storage);
  try {
    const durable = pins.filter((p) => typeof p.id === "number" && p.id > 0);
    if (durable.length === 0) return false; // never overwrite a good snapshot with nothing
    const serialized = JSON.stringify(packMapPins(durable));
    if (serialized.length > MAP_PINS_SNAPSHOT_MAX_BYTES) {
      // Too big to store safely — also drop any smaller stale copy rather than
      // let last week's map keep painting first.
      storage.removeItem(key);
      return false;
    }
    storage.setItem(key, serialized);
    return true;
  } catch {
    return false; // quota exceeded / storage blocked — cold open just fetches
  }
}
