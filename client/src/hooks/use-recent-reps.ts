// ── Recently assigned-to reps ────────────────────────────────────────────────
// A per-DEVICE convenience: the last few reps this manager assigned anything
// to, floated to the top of long pickers so the daily targets are one tap
// instead of a search. localStorage only - never synced, never authoritative,
// and every read/write is wrapped because storage access itself can throw
// (private windows, cleared site data, embedded previews). A rep who was
// deactivated since last use simply never matches a row and disappears.
import { useCallback, useSyncExternalStore } from "react";

const KEY = "hfs.recentReps";
const CAP = 5;

let listeners: Array<() => void> = [];
function emit() {
  for (const l of listeners) l();
}

function read(): number[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n) => Number.isInteger(n)).slice(0, CAP) : [];
  } catch {
    return [];
  }
}

// useSyncExternalStore wants a STABLE snapshot; re-parsing per call returns a
// fresh array identity every render and loops. Cache by the raw string.
let cacheRaw: string | null | undefined;
let cacheValue: number[] = [];
function snapshot(): number[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw !== cacheRaw) {
    cacheRaw = raw;
    cacheValue = read();
  }
  return cacheValue;
}

export function recordRecentRep(id: number): void {
  if (!Number.isInteger(id)) return;
  try {
    const next = [id, ...read().filter((r) => r !== id)].slice(0, CAP);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable - the picker just has no recents. Nothing to do.
  }
  emit();
}

/** The recent rep ids, newest first. Updates live when recordRecentRep runs
 *  anywhere in the app (same-tab; cross-tab staleness is acceptable for a
 *  convenience row). */
export function useRecentReps(): number[] {
  const subscribe = useCallback((cb: () => void) => {
    listeners.push(cb);
    return () => {
      listeners = listeners.filter((l) => l !== cb);
    };
  }, []);
  return useSyncExternalStore(subscribe, snapshot, () => cacheValue);
}
