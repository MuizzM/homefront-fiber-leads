import { describe, expect, it } from "vitest";
import {
  MAP_PIN_WIRE_FIELDS,
  MAP_PINS_WIRE_VERSION,
  packMapPins,
  unpackMapPins,
} from "../../shared/mapPinsWire";

describe("packed map-pin wire format", () => {
  it("round-trips sparse optional fields without changing pin semantics", () => {
    const pins = [
      { id: 1, lat: 35.82, lng: -80.25, leadStatus: "prospect", address: "1 Main St", city: "Lexington", state: "NC", zip: "27292" },
      { id: 2, lat: 35.81, lng: -80.26, leadStatus: "sold", address: "2 Main St", city: "Lexington", state: "NC", zip: "27292", visited: true, knockCount: 2, lastOutcome: "sold" },
    ];
    const packed = packMapPins(pins);
    expect(packed.v).toBe(MAP_PINS_WIRE_VERSION);
    expect(packed.rows.every((row) => row.length === MAP_PIN_WIRE_FIELDS.length)).toBe(true);
    expect(unpackMapPins<typeof pins[number]>(packed)).toEqual({ pins, total: 2 });
  });

  it("rejects unknown versions and malformed rows", () => {
    expect(() => unpackMapPins({ v: 99, total: 0, rows: [] })).toThrow(/Unsupported/);
    expect(() => unpackMapPins({ v: 1, total: 1, rows: [[1]] })).toThrow(/Invalid map row 0/);
  });

  it("cuts repeated-key JSON substantially at 5,000 leads", () => {
    const pins = Array.from({ length: 5_000 }, (_, i) => ({
      id: i + 1,
      lat: 35.8 + i / 1_000_000,
      lng: -80.25 - i / 1_000_000,
      leadStatus: i % 6 === 0 ? "sold" : "prospect",
      address: `${i + 1} Example Avenue`,
      city: "Lexington",
      state: "NC",
      zip: "27292",
      fiberStatus: "available",
      assignedRepId: (i % 20) + 1,
      leadScore: 80,
      visited: i % 3 === 0,
      knockCount: i % 3 === 0 ? 1 : undefined,
      lastOutcome: i % 6 === 0 ? "sold" : undefined,
    }));
    const objectBytes = Buffer.byteLength(JSON.stringify({ pins, total: pins.length }));
    const packedBytes = Buffer.byteLength(JSON.stringify(packMapPins(pins)));
    expect(packedBytes).toBeLessThan(objectBytes * 0.62);
  });
});
