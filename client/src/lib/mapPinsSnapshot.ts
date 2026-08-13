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
  /** Source-lens segment for the viewport-mode hint ONLY (the mode is a
   *  per-lens fact — see mapViewportModeKey). The pin/window snapshot keys
   *  ignore it: those persist whatever the cache held, lens included. */
  view?: string;
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

/** Shared sweep: remove every key under `prefix` except `keep`. Each persisted
 *  map family (full-feed snapshot, window snapshot, viewport mode) runs it on
 *  its own prefix on both read and write, so a stale-version or previous-user
 *  entry never outlives the first map open of the current identity. */
function prunePrefix(prefix: string, keep: string | undefined, storage: SnapshotStorage | null): void {
  if (!storage) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(prefix) && k !== keep) doomed.push(k);
    }
    for (const k of doomed) storage.removeItem(k);
  } catch {
    /* storage blocked mid-iteration — nothing to prune */
  }
}

/** Remove every snapshot key except `keep` (pass nothing to clear them all).
 *  Runs on both read and write so a stale-version or previous-user snapshot
 *  never outlives the first map open of the current identity. */
export function pruneMapPinsSnapshots(keep?: string, storage: SnapshotStorage | null = defaultStorage()): void {
  prunePrefix(MAP_PINS_SNAPSHOT_PREFIX, keep, storage);
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

// ── Persisted viewport MODE — kills the count-probe leg of the cold-open ─────
// waterfall. The probe (a network RTT) used to be the FIRST hop of every big-
// map cold open: until it answered, viewportMode stayed false, so the window
// loader never armed and no pin fetch could even start. Persisting the last
// KNOWN answer lets a returning big-map user fire their first window fetch the
// moment the map is ready; the probe still runs and its answer reconciles the
// mode (and rewrites this hint) when it lands. The value is a HINT, never
// truth: the full-feed gate (fullFeedEnabled) still waits for the real probe,
// so a stale hint can never double-fetch — it can only start the window path
// early. Keyed per identity and version-swept exactly like the snapshots, so
// one user's mode can never leak to the next login on a shared device.
export const MAP_VIEWPORT_MODE_PREFIX = "hf.mapViewportMode.";
/** Bump when the hint's meaning changes (e.g. a threshold semantics change).
 *  v2: the threshold moved 60k → 75k AND the key gained a lens segment — a v1
 *  hint could answer for the wrong lens (a "latest" boot reading the hint the
 *  "all" probe wrote), so every v1 entry is swept rather than migrated.
 *  v3: the threshold moved 75k → 25k (see MAP_VIEWPORT_MODE_THRESHOLD — the
 *  production measurement that a 69k full feed costs 32.7s). Every device that
 *  had probed between 25k and 75k was holding a "full feed" hint that the new
 *  rule contradicts, and this file's own contract says a threshold change is a
 *  version bump. Left at v2 those devices spend their first boot arming the
 *  wrong path until the probe corrects them — exactly the RTT the hint exists
 *  to save. */
export const MAP_VIEWPORT_MODE_VERSION = 3;

/** The identity stem (note the trailing separator: "u1." can never match
 *  "u12…"). Per-lens keys append scope.view; "all" is the no-lens entry. */
export function mapViewportModeStem(scope: MapPinsSnapshotScope): string {
  return `${MAP_VIEWPORT_MODE_PREFIX}v${MAP_VIEWPORT_MODE_VERSION}.t${scope.tenantId ?? 0}.u${scope.userId ?? 0}.`;
}

export function mapViewportModeKey(scope: MapPinsSnapshotScope): string {
  return `${mapViewportModeStem(scope)}${scope.view ?? "all"}`;
}

/** Sweep every mode hint that is not this identity's — the keys are per-lens
 *  now (one entry per view the identity has probed), so the keep rule is the
 *  identity STEM, not one exact key: pruning on a "latest" read must not eat
 *  the hint the "all" probe wrote seconds earlier. */
export function pruneMapViewportModes(keepIdentityStem?: string, storage: SnapshotStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(MAP_VIEWPORT_MODE_PREFIX) && !(keepIdentityStem && k.startsWith(keepIdentityStem))) doomed.push(k);
    }
    for (const k of doomed) storage.removeItem(k);
  } catch {
    /* storage blocked mid-iteration — nothing to prune */
  }
}

/** The last probe-confirmed mode for this identity AND lens, or null when
 *  unknown (first launch, storage blocked, other-user/stale-version entry —
 *  those are swept as a side effect). null must be treated as "wait for the
 *  probe". Keyed per lens because the mode IS per lens: a 62k "latest" org
 *  with a 180k "all" footprint runs full-feed on one and windows on the
 *  other, and a hint answering for the wrong lens window-fetched orgs that
 *  should stream one feed (and vice versa) for the probe RTT. */
export function readPersistedViewportMode(
  scope: MapPinsSnapshotScope,
  storage: SnapshotStorage | null = defaultStorage(),
): boolean | null {
  if (!storage) return null;
  const key = mapViewportModeKey(scope);
  pruneMapViewportModes(mapViewportModeStem(scope), storage);
  try {
    const raw = storage.getItem(key);
    return raw === "1" ? true : raw === "0" ? false : null;
  } catch {
    return null;
  }
}

/** Store the probe's ANSWER (never the derived hint — only a real probe
 *  response may teach the next cold open). */
export function writePersistedViewportMode(
  scope: MapPinsSnapshotScope,
  viewportMode: boolean,
  storage: SnapshotStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  const key = mapViewportModeKey(scope);
  pruneMapViewportModes(mapViewportModeStem(scope), storage);
  try {
    storage.setItem(key, viewportMode ? "1" : "0");
  } catch {
    /* storage blocked — next boot just waits for the probe as before */
  }
}

// ── WINDOW-scoped snapshot — instant first paint for viewport-mode orgs ──────
// The full-feed snapshot above is category-banned in viewport mode (a bbox
// window is a partial slice of the org), and the mode-flip prune deletes any
// stored one — which left big-map orgs cold-opening on an EMPTY cache, waiting
// a full network round-trip before the first pin painted. This family persists
// the most recent COMPLETE fetched window's pins TOGETHER WITH the window bbox
// so the next cold open can answer "do I hold pins for where the camera will
// open?" — if the persisted camera's view intersects the stored window, the
// cache seeds instantly (born stale) and the immediate boot window fetch
// replaces it (with in-window eviction — see mergeViewportPins' evictWindow).
// Unlike the full-feed snapshot this one CAN refresh every session (every pan
// rewrites it), so it is per-session-fresh by construction and needs no
// mode-entry prune; it is dropped only when the probe answers full-feed (the
// window concept itself is then meaningless). Same keying/sweeping/size rules
// as the full-feed family; the byte cap is tighter because a 25k-row window at
// the cap would not fit and a partial city is plenty for a first paint.
export const MAP_WINDOW_SNAPSHOT_PREFIX = "hf.mapWindowSnapshot.";

/** ~1.5MB: a dense (but sub-cap) window packs well under this; anything bigger
 *  skips the write rather than risk the shared localStorage quota. */
export const MAP_WINDOW_SNAPSHOT_MAX_BYTES = 1_500_000;

export interface MapWindowSnapshotBBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export function mapWindowSnapshotKey(scope: MapPinsSnapshotScope): string {
  return `${MAP_WINDOW_SNAPSHOT_PREFIX}v${MAP_PINS_WIRE_VERSION}.t${scope.tenantId ?? 0}.u${scope.userId ?? 0}`;
}

export function pruneMapWindowSnapshots(keep?: string, storage: SnapshotStorage | null = defaultStorage()): void {
  prunePrefix(MAP_WINDOW_SNAPSHOT_PREFIX, keep, storage);
}

function validWindowBBox(w: unknown): w is [number, number, number, number] {
  return (
    Array.isArray(w) && w.length === 4 && w.every((n) => Number.isFinite(n)) &&
    (w[0] as number) < (w[2] as number) && (w[1] as number) < (w[3] as number)
  );
}

/**
 * Read the current identity's window snapshot: the pins in query-cache shape
 * plus the bbox they were fetched for. null on any invalid payload (missing,
 * corrupt, wrong wire version, malformed bbox) — the cold open then simply
 * waits for the immediate window fetch, exactly like today.
 */
export function readMapWindowSnapshot<T extends Partial<Record<MapPinWireField, unknown>>>(
  scope: MapPinsSnapshotScope,
  storage: SnapshotStorage | null = defaultStorage(),
): { pins: T[]; total: number; window: MapWindowSnapshotBBox } | null {
  if (!storage) return null;
  const key = mapWindowSnapshotKey(scope);
  pruneMapWindowSnapshots(key, storage);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { w?: unknown; p?: unknown };
    if (!validWindowBBox(parsed?.w)) throw new Error("bad window bbox");
    // unpackMapPins hard-fails on a version or row-shape mismatch — the same
    // "stale snapshot must be ignored" contract the full-feed family enforces.
    const { pins, total } = unpackMapPins<T>(parsed.p);
    const [minLng, minLat, maxLng, maxLat] = parsed.w;
    return { pins, total, window: { minLng, minLat, maxLng, maxLat } };
  } catch {
    try { storage.removeItem(key); } catch { /* storage blocked */ }
    return null;
  }
}

/**
 * Persist a COMPLETE fetched window (pins + its bbox) for the given identity.
 * Callers must never pass a truncated window's pins — a sample replayed as a
 * seed would paint a misleading thinned view. Temp optimistic pins (negative
 * ids) are excluded like the full-feed writer. Returns true when stored.
 */
export function writeMapWindowSnapshot<T extends Partial<Record<MapPinWireField, unknown>> & { id?: unknown }>(
  scope: MapPinsSnapshotScope,
  pins: readonly T[],
  window: MapWindowSnapshotBBox,
  storage: SnapshotStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  if (!validWindowBBox([window.minLng, window.minLat, window.maxLng, window.maxLat])) return false;
  const key = mapWindowSnapshotKey(scope);
  pruneMapWindowSnapshots(key, storage);
  try {
    const durable = pins.filter((p) => typeof p.id === "number" && p.id > 0);
    if (durable.length === 0) return false; // an empty window must not clobber a seeded one
    const serialized = JSON.stringify({
      w: [window.minLng, window.minLat, window.maxLng, window.maxLat],
      p: packMapPins(durable),
    });
    if (serialized.length > MAP_WINDOW_SNAPSHOT_MAX_BYTES) {
      storage.removeItem(key); // never let a smaller stale window keep winning
      return false;
    }
    storage.setItem(key, serialized);
    return true;
  } catch {
    return false; // quota exceeded / storage blocked — cold open just fetches
  }
}
