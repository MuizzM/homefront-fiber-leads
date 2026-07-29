// POLYGON EDITOR — why this file exists.
//
// Reshaping a drawn polygon on the map is the easiest place in the app to ship
// a plausible-looking undo stack that is quietly wrong. The four failures this
// suite exists to prevent, all of which look fine in a click-through demo:
//
//   1. A drag becomes 40 undo steps, because every pointermove pushed history.
//      "Undo" then nudges the vertex a pixel at a time and the operator taps it
//      forty times to get back where they started.
//   2. Redo resurrects an abandoned branch: undo twice, make a different edit,
//      hit redo, and a shape the operator already rejected reappears.
//   3. removeVertex happily takes a triangle down to two points and every
//      downstream consumer (area, containment, rendering) starts lying.
//   4. `dirty` is a flag flipped by any action rather than a comparison, so
//      "unsaved changes" stays lit after the operator has undone everything.
//
// Plus the boring-but-fatal one: mutating the caller's array. The map keeps its
// own reference to the ring it handed us; writing through it desyncs the
// rendered shape from the edit state.

import { describe, it, expect } from "vitest";
import {
  createPolygonEditor, polygonEditorReducer, ringsEqual, canUndo, canRedo,
  moveVertex, addVertex, removeVertex, movePolygon, replaceRing, endGesture, undo, redo, reset,
  MIN_RING_POINTS, POLYGON_HISTORY_LIMIT,
  type Ring, type PolygonEditorState, type PolygonEditorAction,
} from "../../client/src/lib/polygonEditor";

const square = (): Ring => [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const triangle = (): Ring => [[0, 0], [1, 0], [0, 1]];

const apply = (state: PolygonEditorState, ...actions: PolygonEditorAction[]): PolygonEditorState =>
  actions.reduce((s, a) => polygonEditorReducer(s, a), state);

const ed = (ring: Ring = square()) => createPolygonEditor(ring);

/** Deep-freeze so any write inside the reducer throws instead of silently
 *  corrupting the caller's array (ES modules run in strict mode). */
const frozen = (ring: Ring): Ring => {
  ring.forEach((p) => Object.freeze(p));
  return Object.freeze(ring) as Ring;
};

describe("polygon editor — construction owns a private copy of the ring", () => {
  it("starts clean, with no history, on a copy of the caller's ring", () => {
    const source = square();
    const s = ed(source);
    expect(s.ring).toEqual(source);
    expect(s.ring).not.toBe(source);       // never aliased
    expect(s.ring[0]).not.toBe(source[0]); // points copied too, not shared
    expect(s).toMatchObject({ past: [], future: [], dirty: false });
    expect(canUndo(s)).toBe(false);
    expect(canRedo(s)).toBe(false);
  });

  it("refuses to open an editor on something that is not a polygon", () => {
    // A 2-point ring has no valid edit — every guard downstream assumes >= 3.
    expect(() => createPolygonEditor([[0, 0], [1, 1]])).toThrow(RangeError);
    expect(() => createPolygonEditor([[0, 0], [1, 0], [Number.NaN, 1]])).toThrow(RangeError);
    expect(MIN_RING_POINTS).toBe(3);
  });
});

describe("polygon editor — moveVertex", () => {
  it("moves exactly the addressed vertex and leaves the rest untouched", () => {
    const s = apply(ed(), moveVertex(2, [5, 6]));
    expect(s.ring).toEqual([[-1, -1], [1, -1], [5, 6], [-1, 1]]);
    expect(s.dirty).toBe(true);
    expect(s.past).toEqual([square()]); // the pre-move ring is what undo restores
  });

  it("an out-of-range or non-finite move is a no-op, not a corrupted ring", () => {
    // Pointer maths can hand us NaN (unprojecting off-globe) — never store it.
    const s = ed();
    expect(polygonEditorReducer(s, moveVertex(4, [0, 0]))).toBe(s);
    expect(polygonEditorReducer(s, moveVertex(-1, [0, 0]))).toBe(s);
    expect(polygonEditorReducer(s, moveVertex(1.5, [0, 0]))).toBe(s);
    expect(polygonEditorReducer(s, moveVertex(1, [Number.NaN, 0]))).toBe(s);
    expect(polygonEditorReducer(s, moveVertex(1, [0, Infinity]))).toBe(s);
  });

  it("moving a vertex onto its existing position writes no history entry", () => {
    // A click without a drag still emits a move; it must not create an undo step.
    const s = ed();
    expect(polygonEditorReducer(s, moveVertex(0, [-1, -1]))).toBe(s);
  });
});

describe("polygon editor — addVertex / removeVertex", () => {
  it("addVertex inserts immediately after the given index", () => {
    const s = apply(ed(), addVertex(0, [0, -1]));
    expect(s.ring).toEqual([[-1, -1], [0, -1], [1, -1], [1, 1], [-1, 1]]);
  });

  it("addVertex after the last index appends (the ring is not closed)", () => {
    // The closing edge's midpoint handle lives after the last vertex.
    const s = apply(ed(), addVertex(3, [-1, 0]));
    expect(s.ring).toEqual([[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, 0]]);
  });

  it("addVertex with a bad index or coordinate is a no-op", () => {
    const s = ed();
    expect(polygonEditorReducer(s, addVertex(4, [0, 0]))).toBe(s);
    expect(polygonEditorReducer(s, addVertex(-1, [0, 0]))).toBe(s);
    expect(polygonEditorReducer(s, addVertex(0, [0, Number.NaN]))).toBe(s);
  });

  it("removeVertex deletes the addressed vertex", () => {
    const s = apply(ed(), removeVertex(1));
    expect(s.ring).toEqual([[-1, -1], [1, 1], [-1, 1]]);
    expect(s.dirty).toBe(true);
  });

  it("MUTATION-CHECK: removeVertex REFUSES to go below three points", () => {
    // Kills: relaxing the guard to `< MIN_RING_POINTS` (allows a 2-point ring).
    const tri = ed(triangle());
    expect(polygonEditorReducer(tri, removeVertex(0))).toBe(tri); // same object: nothing happened
    expect(tri.ring).toHaveLength(3);
    expect(tri.past).toEqual([]);

    // And from a square: one removal is allowed, the next is refused.
    const once = apply(ed(), removeVertex(3));
    expect(once.ring).toHaveLength(3);
    expect(polygonEditorReducer(once, removeVertex(0))).toBe(once);
  });

  it("removeVertex with an out-of-range index is a no-op", () => {
    const s = ed();
    expect(polygonEditorReducer(s, removeVertex(9))).toBe(s);
    expect(polygonEditorReducer(s, removeVertex(-1))).toBe(s);
  });
});

describe("polygon editor — movePolygon / replaceRing", () => {
  it("movePolygon translates every vertex by the delta", () => {
    const s = apply(ed(), movePolygon(10, -5));
    expect(s.ring).toEqual([[9, -6], [11, -6], [11, -4], [9, -4]]);
  });

  it("a zero or non-finite translation is a no-op", () => {
    const s = ed();
    expect(polygonEditorReducer(s, movePolygon(0, 0))).toBe(s);
    expect(polygonEditorReducer(s, movePolygon(Number.NaN, 1))).toBe(s);
    expect(polygonEditorReducer(s, movePolygon(1, Infinity))).toBe(s);
  });

  it("replaceRing swaps the whole ring in one undoable step", () => {
    const s = apply(ed(), replaceRing(triangle()));
    expect(s.ring).toEqual(triangle());
    expect(s.past).toEqual([square()]);
    expect(apply(s, undo()).ring).toEqual(square());
  });

  it("replaceRing rejects degenerate or non-finite rings", () => {
    const s = ed();
    expect(polygonEditorReducer(s, replaceRing([[0, 0], [1, 1]]))).toBe(s);
    expect(polygonEditorReducer(s, replaceRing([[0, 0], [1, 0], [0, Number.NaN]]))).toBe(s);
    expect(polygonEditorReducer(s, replaceRing(square()))).toBe(s); // identical ring: no churn
  });

  it("replaceRing copies the incoming ring instead of adopting it", () => {
    // The caller may keep editing the array it handed us (or hand us a live one).
    const incoming = triangle();
    const s = apply(ed(), replaceRing(incoming));
    incoming[0][0] = 999;
    incoming.push([7, 7]);
    expect(s.ring).toEqual(triangle());
  });
});

describe("polygon editor — ONE DRAG IS ONE UNDO STEP", () => {
  it("MUTATION-CHECK: 25 consecutive moves of one vertex collapse into a single undo step", () => {
    // Kills: dropping the coalesce key (every pointermove becomes its own entry).
    let s = ed();
    const preDrag = square();
    for (let i = 1; i <= 25; i++) s = apply(s, moveVertex(1, [1 + i * 0.001, -1]));

    expect(s.past).toHaveLength(1);
    expect(s.ring[1]).toEqual([1.025, -1]);

    s = apply(s, undo());
    expect(s.ring).toEqual(preDrag); // ONE undo undoes the whole drag
    expect(s.dirty).toBe(false);
    expect(canUndo(s)).toBe(false);
  });

  it("grabbing a DIFFERENT vertex opens a new history entry", () => {
    let s = ed();
    for (let i = 1; i <= 3; i++) s = apply(s, moveVertex(0, [-1 - i, -1]));
    for (let i = 1; i <= 3; i++) s = apply(s, moveVertex(2, [1 + i, 1]));
    expect(s.past).toHaveLength(2);

    s = apply(s, undo()); // undoes only the second drag
    expect(s.ring).toEqual([[-4, -1], [1, -1], [1, 1], [-1, 1]]);
  });

  it("endGesture() closes the run, so dragging the SAME vertex twice is two steps", () => {
    // Without an explicit pointerup boundary, two separate drags of one handle
    // would merge and a single undo would throw both away.
    let s = ed();
    s = apply(s, moveVertex(1, [2, -1]), endGesture());
    s = apply(s, moveVertex(1, [3, -1]));
    expect(s.past).toHaveLength(2);
    expect(apply(s, undo()).ring[1]).toEqual([2, -1]);
  });

  it("endGesture on an already-closed gesture is a no-op", () => {
    const s = ed();
    expect(polygonEditorReducer(s, endGesture())).toBe(s);
  });

  it("a whole-polygon drag coalesces the same way", () => {
    let s = ed();
    for (let i = 0; i < 8; i++) s = apply(s, movePolygon(1, 1));
    expect(s.past).toHaveLength(1);
    expect(s.ring[0]).toEqual([7, 7]);
    expect(apply(s, undo()).ring).toEqual(square());
  });

  it("undo ends the gesture — a later move of the same vertex is its own step", () => {
    let s = ed();
    s = apply(s, moveVertex(1, [2, -1]), undo());
    s = apply(s, moveVertex(1, [3, -1]));
    expect(s.past).toHaveLength(1);
    expect(apply(s, undo()).ring).toEqual(square());
  });

  it("a non-move action between moves also breaks the run", () => {
    let s = ed();
    s = apply(s, moveVertex(1, [2, -1]), addVertex(0, [0, -1]), moveVertex(1, [4, -4]));
    expect(s.past).toHaveLength(3);
  });
});

describe("polygon editor — undo / redo", () => {
  it("walks backwards and forwards through discrete edits", () => {
    let s = ed();
    s = apply(s, moveVertex(0, [9, 9]), endGesture(), removeVertex(3));
    expect(s.ring).toEqual([[9, 9], [1, -1], [1, 1]]);

    s = apply(s, undo());
    expect(s.ring).toEqual([[9, 9], [1, -1], [1, 1], [-1, 1]]);
    s = apply(s, undo());
    expect(s.ring).toEqual(square());
    expect(s.future).toHaveLength(2); // undo does NOT discard the redo branch

    s = apply(s, redo(), redo());
    expect(s.ring).toEqual([[9, 9], [1, -1], [1, 1]]);
    expect(canRedo(s)).toBe(false);
  });

  it("undo with empty history and redo with empty future are no-ops", () => {
    const s = ed();
    expect(polygonEditorReducer(s, undo())).toBe(s);
    expect(polygonEditorReducer(s, redo())).toBe(s);
  });

  it("MUTATION-CHECK: a new edit after undo destroys the abandoned redo branch", () => {
    // Kills: leaving `future` intact on an editing action — redo would then
    // resurrect a shape the operator explicitly walked back from.
    let s = ed();
    s = apply(s, moveVertex(0, [9, 9]), endGesture(), moveVertex(1, [8, 8]), endGesture());
    s = apply(s, undo(), undo());
    expect(s.ring).toEqual(square());
    expect(s.future).toHaveLength(2); // branch still available *until* we edit

    s = apply(s, moveVertex(2, [7, 7])); // new branch
    expect(s.future).toEqual([]);
    expect(canRedo(s)).toBe(false);

    const afterRedo = polygonEditorReducer(s, redo());
    expect(afterRedo).toBe(s);                    // redo does nothing at all
    expect(afterRedo.ring[0]).toEqual([-1, -1]);  // [9, 9] stays dead
    expect(afterRedo.ring[2]).toEqual([7, 7]);
  });

  it("every editing action clears the redo stack, not just moves", () => {
    const base = apply(ed(), moveVertex(0, [9, 9]), endGesture(), undo());
    for (const action of [
      addVertex(0, [0, -1]), removeVertex(0), movePolygon(1, 1), replaceRing(triangle()),
    ]) {
      expect(polygonEditorReducer(base, action).future).toEqual([]);
    }
    // ...but a REFUSED action leaves the branch alone (nothing happened).
    expect(polygonEditorReducer(base, removeVertex(99)).future).toHaveLength(1);
  });

  it("history entries are snapshots, never aliases of the live ring", () => {
    const s = apply(ed(), moveVertex(0, [9, 9]), endGesture(), moveVertex(1, [8, 8]));
    expect(s.past[0]).not.toBe(s.ring);
    expect(s.past[1]).not.toBe(s.ring);
    expect(s.past[0]).toEqual(square());
    expect(s.past[1]).toEqual([[9, 9], [1, -1], [1, 1], [-1, 1]]);
  });
});

describe("polygon editor — history is capped, dropping the OLDEST", () => {
  const editsBeyondCap = POLYGON_HISTORY_LIMIT + 10;

  /** Run `editsBeyondCap` discrete edits, recording the ring after each. */
  const longSession = () => {
    let s = ed();
    const after: Ring[] = [s.ring];
    for (let i = 1; i <= editsBeyondCap; i++) {
      s = apply(s, moveVertex(i % 2, [i, i]), endGesture());
      after.push(s.ring);
    }
    return { s, after };
  };

  it("MUTATION-CHECK: the cap keeps the NEWEST entries and discards the oldest", () => {
    // Kills: `past.slice(0, LIMIT)` — keeping the oldest would make undo jump
    // back to an edit from minutes ago instead of the one just made.
    const { s, after } = longSession();
    expect(s.past).toHaveLength(POLYGON_HISTORY_LIMIT);

    // One undo returns the immediately-previous ring (newest history intact).
    expect(apply(s, undo()).ring).toEqual(after[editsBeyondCap - 1]);

    // The oldest surviving entry is edit #11's starting point, not the original.
    expect(s.past[0]).toEqual(after[editsBeyondCap - POLYGON_HISTORY_LIMIT]);
    expect(ringsEqual(s.past[0], square())).toBe(false);
  });

  it("undoing the full depth stops at the oldest surviving entry, still dirty", () => {
    let { s } = longSession();
    for (let i = 0; i < POLYGON_HISTORY_LIMIT + 5; i++) s = apply(s, undo());
    expect(canUndo(s)).toBe(false);
    expect(s.ring).not.toEqual(square()); // the original is beyond the horizon
    expect(s.dirty).toBe(true);
    // reset() is the escape hatch that always gets back to the original.
    expect(apply(s, reset()).ring).toEqual(square());
  });

  it("the cap holds across redo as well (redo pushes onto past)", () => {
    let { s } = longSession();
    s = apply(s, undo(), undo(), redo(), redo());
    expect(s.past).toHaveLength(POLYGON_HISTORY_LIMIT);
  });
});

describe("polygon editor — dirty means 'differs from the original', not 'something happened'", () => {
  it("MUTATION-CHECK: dragging a vertex away and back leaves the editor clean", () => {
    // Kills: `dirty: true` set unconditionally by editing actions.
    let s = ed();
    expect(s.dirty).toBe(false);
    s = apply(s, moveVertex(0, [5, 5]));
    expect(s.dirty).toBe(true);
    s = apply(s, moveVertex(0, [-1, -1])); // dragged back onto the original spot
    expect(s.dirty).toBe(false);
    expect(s.past).toHaveLength(1); // still one drag's worth of history
  });

  it("add-then-remove of the same vertex is clean again", () => {
    const s = apply(ed(), addVertex(1, [1, -0.5]), removeVertex(2));
    expect(s.ring).toEqual(square());
    expect(s.dirty).toBe(false);
  });

  it("undoing back to the original clears dirty; redoing sets it again", () => {
    let s = apply(ed(), movePolygon(3, 3), endGesture());
    expect(s.dirty).toBe(true);
    s = apply(s, undo());
    expect(s.dirty).toBe(false);
    s = apply(s, redo());
    expect(s.dirty).toBe(true);
  });

  it("a translation and its exact inverse is clean, even across two gestures", () => {
    const s = apply(ed(), movePolygon(2, -3), endGesture(), movePolygon(-2, 3));
    expect(s.ring).toEqual(square());
    expect(s.dirty).toBe(false);
    expect(s.past).toHaveLength(2);
  });

  it("reset() restores the original, is itself undoable, and is a no-op when clean", () => {
    const clean = ed();
    expect(polygonEditorReducer(clean, reset())).toBe(clean);

    let s = apply(ed(), moveVertex(0, [9, 9]), endGesture(), removeVertex(1));
    s = apply(s, reset());
    expect(s.ring).toEqual(square());
    expect(s.dirty).toBe(false);
    expect(apply(s, undo()).ring).toEqual([[9, 9], [1, 1], [-1, 1]]); // reset was a step
  });

  it("the baseline survives every action — `initial` is immutable", () => {
    const s = apply(
      ed(),
      moveVertex(0, [9, 9]), endGesture(), addVertex(0, [0, 0]), removeVertex(2),
      movePolygon(1, 1), replaceRing(triangle()), undo(), redo(), reset(),
    );
    expect(s.initial).toEqual(square());
  });
});

describe("polygon editor — the caller's arrays are never mutated", () => {
  it("every action leaves the ring passed to createPolygonEditor untouched", () => {
    const source = frozen(square());
    const snapshot = JSON.stringify(source);
    const s = apply(
      ed(source),
      moveVertex(0, [9, 9]), moveVertex(0, [8, 8]), endGesture(),
      addVertex(1, [1, -0.5]), removeVertex(2), movePolygon(0.5, 0.5),
      replaceRing(frozen(triangle())), undo(), redo(), reset(), endGesture(),
    );
    expect(JSON.stringify(source)).toBe(snapshot);
    expect(s.ring).not.toBe(source);
  });

  it("each action returns a fresh ring array, sharing no point objects with the previous one", () => {
    const before = ed();
    for (const action of [
      moveVertex(0, [9, 9]), addVertex(0, [0, -1]), removeVertex(0), movePolygon(1, 1), replaceRing(triangle()),
    ]) {
      const next = polygonEditorReducer(before, action);
      expect(next.ring).not.toBe(before.ring);
      for (const p of next.ring) expect(before.ring).not.toContain(p);
    }
  });

  it("the lngLat handed to an action is copied, not adopted", () => {
    const live: [number, number] = [5, 5];
    const s = apply(ed(), moveVertex(0, live));
    live[0] = 999;
    expect(s.ring[0]).toEqual([5, 5]);
  });

  it("mutating a returned ring cannot corrupt history (undo still restores)", () => {
    const s = apply(ed(), moveVertex(0, [9, 9]));
    s.ring[0][0] = 12345; // a badly-behaved caller
    expect(apply(s, undo()).ring).toEqual(square());
  });
});

describe("polygon editor — ringsEqual", () => {
  it("compares by value, length-first", () => {
    expect(ringsEqual(square(), square())).toBe(true);
    expect(ringsEqual(square(), triangle())).toBe(false);
    expect(ringsEqual(square(), [...square(), [0, 0]])).toBe(false);
    expect(ringsEqual(square(), [[-1, -1], [1, -1], [1, 1], [-1, 1.0000001]])).toBe(false);
  });
});
