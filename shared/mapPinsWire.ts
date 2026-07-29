/**
 * Versioned, positional wire format for the high-volume map endpoint.
 *
 * Repeating 15 descriptive JSON keys for every lead is expensive to parse and
 * allocate. The packed response sends the schema once in shared code and rows
 * as arrays. The object response remains available for backward compatibility.
 */
// Bumped 2 → 3 when `carrier` was added; 3 → 4 when `assignMark` was added;
// 4 → 5 when `assignedTerritoryId` was added.
// unpackMapPins hard-fails on a row-length mismatch, so a version skew returns
// empty pins — server + client MUST ship together. `carrier` lets a Frontier
// confirmed-fresh lead paint red instead of Kinetic-green; `assignMark` lets a
// manager's pre-assignment priority/hold triage show on the pin at a glance.
//
// `assignedTerritoryId` is the ONLY link from a door to the crew working it.
// `assignedRepId` names a single primary, but areas are many-to-many
// (territories.assignee_ids), so a shared door painted from the primary alone
// looks like one rep's — which is how two reps knock the same house. The client
// already holds the territory list, so shipping the 4-byte area id lets it
// resolve the full rep set in O(1) per pin instead of a second request or a
// per-lead point-in-polygon scan.
export const MAP_PINS_WIRE_VERSION = 5 as const;

export const MAP_PIN_WIRE_FIELDS = [
  "id", "lat", "lng", "leadStatus", "address", "city", "state", "zip",
  "fiberStatus", "assignedRepId", "leadScore", "visited", "knockCount",
  "lastOutcome", "lastKnockedAt", "leadTag", "freshConfidence", "carrier",
  "assignMark", "assignedTerritoryId",
] as const;

export type MapPinWireField = typeof MAP_PIN_WIRE_FIELDS[number];
export type WirePin = Record<MapPinWireField, unknown>;

export interface PackedMapPins {
  v: typeof MAP_PINS_WIRE_VERSION;
  total: number;
  rows: unknown[][];
}

export function packMapPins<T extends Partial<Record<MapPinWireField, unknown>>>(pins: readonly T[]): PackedMapPins {
  return {
    v: MAP_PINS_WIRE_VERSION,
    total: pins.length,
    rows: pins.map((pin) => MAP_PIN_WIRE_FIELDS.map((field) => pin[field] ?? null)),
  };
}

export function unpackMapPins<T extends Partial<Record<MapPinWireField, unknown>>>(payload: unknown): { pins: T[]; total: number } {
  if (!payload || typeof payload !== "object") throw new Error("Invalid packed map payload");
  const packed = payload as Partial<PackedMapPins>;
  if (packed.v !== MAP_PINS_WIRE_VERSION || !Array.isArray(packed.rows)) {
    throw new Error(`Unsupported map payload version: ${String(packed.v)}`);
  }
  const pins = packed.rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== MAP_PIN_WIRE_FIELDS.length) {
      throw new Error(`Invalid map row ${rowIndex}`);
    }
    const pin: Record<string, unknown> = {};
    for (let i = 0; i < MAP_PIN_WIRE_FIELDS.length; i++) {
      const value = row[i];
      if (value !== null) pin[MAP_PIN_WIRE_FIELDS[i]] = value;
    }
    return pin as T;
  });
  return { pins, total: typeof packed.total === "number" ? packed.total : pins.length };
}
