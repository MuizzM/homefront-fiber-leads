// The map search used to read only the pins already loaded into client state,
// so at production scale most doors were unfindable and the panel said "No lead
// in your org matches" about a door that exists. These pin the merge that fixed
// it; the browser-level proof is verify-map-search.mjs.
import { describe, expect, it } from "vitest";
import { mergeSearchMatches } from "../../client/src/lib/mapSearchMerge";

const door = (id: number, extra: Record<string, unknown> = {}) => ({ id, lat: 1, lng: 2, ...extra });

describe("map search merge", () => {
  it("keeps loaded pins first so the top row never moves when the network answers", () => {
    const merged = mergeSearchMatches([door(1), door(2)], [door(9), door(8)]);
    expect(merged.map(d => d.id)).toEqual([1, 2, 9, 8]);
  });

  it("adds doors the map never loaded - the whole point of the fix", () => {
    const merged = mergeSearchMatches([], [door(41), door(42)]);
    expect(merged.map(d => d.id)).toEqual([41, 42]);
  });

  it("never lists the same door twice when the server returns one already on screen", () => {
    const merged = mergeSearchMatches([door(7)], [door(7), door(8)]);
    expect(merged.map(d => d.id)).toEqual([7, 8]);
  });

  // The row's only job is to fly the camera. A door with no coordinates cannot,
  // so it is a dead entry rather than a result.
  it("drops server rows with no coordinates", () => {
    const merged = mergeSearchMatches([], [door(1, { lat: null }), door(2, { lng: null }), door(3)]);
    expect(merged.map(d => d.id)).toEqual([3]);
  });

  it("caps the list, counting loaded pins against the same limit", () => {
    const loaded = [1, 2, 3, 4, 5, 6, 7, 8].map(id => door(id));
    expect(mergeSearchMatches(loaded, [door(99)])).toHaveLength(8);
    expect(mergeSearchMatches(loaded, [door(99)]).some(d => d.id === 99)).toBe(false);
    expect(mergeSearchMatches(loaded.slice(0, 3), [door(99)], 4).map(d => d.id)).toEqual([1, 2, 3, 99]);
  });

  it("survives a server that answered with nothing at all", () => {
    expect(mergeSearchMatches([door(1)], undefined).map(d => d.id)).toEqual([1]);
  });
});
