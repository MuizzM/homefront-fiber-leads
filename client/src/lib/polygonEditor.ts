// POLYGON EDITOR — pure, framework-free edit state for a drawn polygon ring.
//
// The map lets an operator reshape a territory/scan polygon by dragging its
// vertices. That interaction is a *state* problem, not a rendering problem, so
// all of it lives here: no React, no DOM, no Mapbox, no geometry validation.
// The caller (map layer) translates pointer events into actions and paints
// `state.ring`; whether the resulting shape is legal (self-intersection, area
// caps, containment) is somebody else's job.
//
// A ring is `[lng, lat][]` and is NOT closed — the last point is not a repeat
// of the first. Closing it is a rendering/serialisation concern.
//
// Invariants:
//   • Never mutate an input array. Every ring handed back is a fresh array of
//     fresh points, so a caller can keep (and freeze) the array it passed in.
//   • ONE DRAG IS ONE UNDO STEP. A pointer-move stream fires dozens of
//     moveVertex actions; consecutive moves of the SAME vertex collapse into a
//     single history entry (see `coalesceKey`). Touching a different vertex —
//     or calling endGesture() on pointerup — starts a new entry.
//   • A ring never drops below MIN_RING_POINTS. removeVertex refuses instead
//     of producing a degenerate 2-point "polygon".
//   • Any action other than undo/redo CLEARS the redo stack. Undoing twice and
//     then editing abandons that branch — redo must never resurrect it.
//   • History is capped at POLYGON_HISTORY_LIMIT entries; the OLDEST are
//     dropped. The recent edits an operator is actually likely to undo survive.
//   • `dirty` compares the current ring to the ring the editor was created
//     with — it is not "an action happened". Drag a vertex away and back and
//     the editor is clean again, so a Save button correctly goes quiet.

export type LngLat = [number, number];
export type Ring = LngLat[];

/** A polygon needs three points. Below this it is a line, not an area. */
export const MIN_RING_POINTS = 3;

/** Undo depth. Oldest entries are dropped when exceeded, never the newest. */
export const POLYGON_HISTORY_LIMIT = 50;

export interface PolygonEditorState {
  /** The ring as currently edited. Always a fresh array. */
  ring: Ring;
  /** Undo stack, oldest first. `past[past.length - 1]` is one step back. */
  past: Ring[];
  /** Redo stack, nearest first. Cleared by any editing action. */
  future: Ring[];
  /** True iff `ring` differs from `initial` (value equality, not identity). */
  dirty: boolean;
  /** The ring the editor was created with — baseline for `dirty` and reset().
   *  Kept separately because history is capped: once the cap drops the oldest
   *  entries, `past[0]` is no longer the original ring. */
  initial: Ring;
  /** Identity of the gesture that produced the newest history entry, e.g.
   *  "vertex:3" or "polygon". The next action coalesces into that entry only
   *  if it carries the same key. null = the next edit starts a new entry. */
  coalesceKey: string | null;
}

export type PolygonEditorAction =
  | { type: "MOVE_VERTEX"; index: number; lngLat: LngLat }
  | { type: "ADD_VERTEX"; afterIndex: number; lngLat: LngLat }
  | { type: "REMOVE_VERTEX"; index: number }
  | { type: "MOVE_POLYGON"; deltaLng: number; deltaLat: number }
  | { type: "REPLACE_RING"; ring: Ring }
  | { type: "END_GESTURE" }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "RESET" };

// ---------------------------------------------------------------------------
// Action creators — the caller's vocabulary.
// ---------------------------------------------------------------------------

/** Drag a vertex. Consecutive calls for the same `index` are ONE undo step. */
export const moveVertex = (index: number, lngLat: LngLat): PolygonEditorAction =>
  ({ type: "MOVE_VERTEX", index, lngLat });

/** Insert a vertex immediately after `afterIndex` (midpoint handle drag). */
export const addVertex = (afterIndex: number, lngLat: LngLat): PolygonEditorAction =>
  ({ type: "ADD_VERTEX", afterIndex, lngLat });

/** Delete a vertex. Refused when the ring is already at MIN_RING_POINTS. */
export const removeVertex = (index: number): PolygonEditorAction =>
  ({ type: "REMOVE_VERTEX", index });

/** Translate every vertex (dragging the whole shape). Coalesces like a drag. */
export const movePolygon = (deltaLng: number, deltaLat: number): PolygonEditorAction =>
  ({ type: "MOVE_POLYGON", deltaLng, deltaLat });

/** Swap in a whole ring (snap-to-parcel, paste, external edit). */
export const replaceRing = (ring: Ring): PolygonEditorAction =>
  ({ type: "REPLACE_RING", ring });

/** Explicit gesture boundary — call on pointerup so that dragging the SAME
 *  vertex twice is two undo steps rather than one merged blob. */
export const endGesture = (): PolygonEditorAction => ({ type: "END_GESTURE" });

export const undo = (): PolygonEditorAction => ({ type: "UNDO" });
export const redo = (): PolygonEditorAction => ({ type: "REDO" });

/** Restore the ring the editor was created with (undoable). */
export const reset = (): PolygonEditorAction => ({ type: "RESET" });

// ---------------------------------------------------------------------------
// Ring helpers — all copying, no mutation.
// ---------------------------------------------------------------------------

const clonePoint = (p: LngLat): LngLat => [p[0], p[1]];
const cloneRing = (ring: readonly LngLat[]): Ring => ring.map(clonePoint);

const isFinitePoint = (p: unknown): p is LngLat =>
  Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

const isIndex = (i: number, length: number): boolean =>
  Number.isInteger(i) && i >= 0 && i < length;

/** Value equality of two rings — the basis for `dirty` and for no-op guards.
 *  Exact coordinate comparison, no epsilon: undo/reset restore the very same
 *  numbers, so a round-trip is bit-identical by construction. */
export function ringsEqual(a: readonly LngLat[], b: readonly LngLat[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

export const canUndo = (state: PolygonEditorState): boolean => state.past.length > 0;
export const canRedo = (state: PolygonEditorState): boolean => state.future.length > 0;

/** Start editing `ring`. The array is copied, so the caller keeps ownership of
 *  the one it passed in (and this editor can never write through to it). */
export function createPolygonEditor(ring: readonly LngLat[]): PolygonEditorState {
  if (!Array.isArray(ring) || ring.length < MIN_RING_POINTS || !ring.every(isFinitePoint)) {
    throw new RangeError(`createPolygonEditor requires at least ${MIN_RING_POINTS} finite [lng, lat] points`);
  }
  const snapshot = cloneRing(ring);
  return { ring: snapshot, past: [], future: [], dirty: false, initial: cloneRing(ring), coalesceKey: null };
}

/** Drop the OLDEST entries once the cap is exceeded. Losing ancient history is
 *  acceptable; losing the step the operator is about to undo is not. */
function capHistory(past: Ring[]): Ring[] {
  return past.length > POLYGON_HISTORY_LIMIT ? past.slice(past.length - POLYGON_HISTORY_LIMIT) : past;
}

/** Record `next` as the current ring.
 *  - Identical to the current ring → no state change at all (no history churn).
 *  - `key` matching the newest entry's key → coalesce (the drag keeps ONE
 *    history entry, the one holding the pre-drag ring).
 *  - Otherwise push the current ring onto `past`.
 *  Always clears `future`: this is a new branch, the abandoned one is gone. */
function commit(state: PolygonEditorState, next: Ring, key: string | null): PolygonEditorState {
  if (ringsEqual(next, state.ring)) return state;
  const coalescing = key !== null && key === state.coalesceKey;
  return {
    ring: next,
    past: coalescing ? state.past : capHistory([...state.past, state.ring]),
    future: [],
    dirty: !ringsEqual(next, state.initial),
    initial: state.initial,
    coalesceKey: key,
  };
}

/** Pure reducer. Unknown/guard-failing actions return the SAME state object,
 *  so a caller can use referential equality to skip re-renders. */
export function polygonEditorReducer(
  state: PolygonEditorState,
  action: PolygonEditorAction,
): PolygonEditorState {
  switch (action.type) {
    case "MOVE_VERTEX": {
      if (!isIndex(action.index, state.ring.length) || !isFinitePoint(action.lngLat)) return state;
      const next = cloneRing(state.ring);
      next[action.index] = clonePoint(action.lngLat);
      // Keyed by vertex: the whole drag of one handle is a single undo step,
      // while grabbing a different handle opens a new one.
      return commit(state, next, `vertex:${action.index}`);
    }

    case "ADD_VERTEX": {
      if (!isIndex(action.afterIndex, state.ring.length) || !isFinitePoint(action.lngLat)) return state;
      const next = cloneRing(state.ring);
      next.splice(action.afterIndex + 1, 0, clonePoint(action.lngLat));
      // Adding is discrete — never merged into a neighbouring drag.
      return commit(state, next, null);
    }

    case "REMOVE_VERTEX": {
      if (!isIndex(action.index, state.ring.length)) return state;
      // A polygon needs three points; refuse rather than degenerate.
      if (state.ring.length <= MIN_RING_POINTS) return state;
      const next = cloneRing(state.ring);
      next.splice(action.index, 1);
      return commit(state, next, null);
    }

    case "MOVE_POLYGON": {
      if (!Number.isFinite(action.deltaLng) || !Number.isFinite(action.deltaLat)) return state;
      const next = state.ring.map((p): LngLat => [p[0] + action.deltaLng, p[1] + action.deltaLat]);
      // Dragging the shape is one gesture too — a single key for the run.
      return commit(state, next, "polygon");
    }

    case "REPLACE_RING": {
      const incoming = action.ring;
      if (!Array.isArray(incoming) || incoming.length < MIN_RING_POINTS || !incoming.every(isFinitePoint)) {
        return state;
      }
      return commit(state, cloneRing(incoming), null);
    }

    case "END_GESTURE":
      // Close the current gesture so the next edit cannot merge into it.
      return state.coalesceKey === null ? state : { ...state, coalesceKey: null };

    case "UNDO": {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return {
        ring: previous,
        past: state.past.slice(0, -1),
        future: [state.ring, ...state.future],
        dirty: !ringsEqual(previous, state.initial),
        initial: state.initial,
        coalesceKey: null, // an undo always ends the gesture
      };
    }

    case "REDO": {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return {
        ring: next,
        past: capHistory([...state.past, state.ring]),
        future: state.future.slice(1),
        dirty: !ringsEqual(next, state.initial),
        initial: state.initial,
        coalesceKey: null,
      };
    }

    case "RESET":
      // Undoable, and a no-op when the ring is already the original.
      return commit(state, cloneRing(state.initial), null);

    default:
      return state;
  }
}
