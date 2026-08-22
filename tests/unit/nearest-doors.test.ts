// Nearest doors (shared/nearestDoors.ts): the open doors nearest the rep,
// distance-ordered, with the same "open" rule as Next door.
import { describe, expect, it } from "vitest";
import { rankNearestDoors, AT_DOOR_METERS, NEAREST_DOORS_MAX_METERS } from "../../shared/nearestDoors";

// ~1e-4 deg latitude is ~11 m.
const at = (id: number, dLat: number, over: Record<string, unknown> = {}) => ({
  id, lat: 35.67 + dLat, lng: -80.47, leadStatus: "prospect", ...over,
});
const from = { lat: 35.67, lng: -80.47 };

describe("rankNearestDoors", () => {
  it("orders open doors by distance and caps the list", () => {
    const pins = [at(1, 0.003), at(2, 0.0001), at(3, 0.001), at(4, 0.002)];
    const r = rankNearestDoors(from, pins);
    expect(r.map(d => d.pin.id)).toEqual([2, 3, 4]);
    expect(r[0].atDoor).toBe(true);
    expect(r[1].atDoor).toBe(false);
    expect(r[0].meters).toBeLessThan(AT_DOOR_METERS);
  });

  it("skips worked doors but keeps Not Home, and drops doors past the radius", () => {
    const pins = [
      at(1, 0.0001, { leadStatus: "sold", visited: true, lastOutcome: "sold" }),
      at(2, 0.0002, { leadStatus: "prospect", visited: true, lastOutcome: "not_home" }),
      at(3, 0.0003, { leadStatus: "not_interested", visited: true, lastOutcome: "not_interested" }),
      at(4, 0.0004, { leadStatus: "follow_up", visited: true, lastOutcome: "follow_up" }),
      at(5, 0.1), // ~11 km away
    ];
    expect(rankNearestDoors(from, pins).map(d => d.pin.id)).toEqual([2]);
    expect(NEAREST_DOORS_MAX_METERS).toBeLessThan(11_000);
  });

  it("honours excludes and ties break on lead score then id, never by insertion order", () => {
    const pins = [at(9, 0.0001, { leadScore: 10 }), at(3, 0.0001, { leadScore: 10 }), at(5, 0.0001, { leadScore: 90 })];
    expect(rankNearestDoors(from, pins).map(d => d.pin.id)).toEqual([5, 3, 9]);
    expect(rankNearestDoors(from, pins, { excludeIds: new Set([5]) }).map(d => d.pin.id)).toEqual([3, 9]);
  });

  it("ignores pins without coordinates", () => {
    const pins = [{ id: 1, lat: Number.NaN, lng: -80.47, leadStatus: "prospect" }, at(2, 0.0002)];
    expect(rankNearestDoors(from, pins as any).map(d => d.pin.id)).toEqual([2]);
  });

  it("never offers a do-not-knock door, however close it is", () => {
    const pins = [at(1, 0.0001, { doNotKnock: 1 }), at(2, 0.0002)];
    expect(rankNearestDoors(from, pins).map(d => d.pin.id)).toEqual([2]);
  });
});
