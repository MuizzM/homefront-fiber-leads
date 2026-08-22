/**
 * Versioned, positional wire format for the high-volume map endpoint.
 *
 * Repeating 15 descriptive JSON keys for every lead is expensive to parse and
 * allocate. The packed response sends the schema once in shared code and rows
 * as arrays. The object response remains available for backward compatibility.
 */
// Bumped 2 → 3 when `carrier` was added; 3 → 4 when `assignMark` was added;
// 4 → 5 when `assignedTerritoryId` was added; 5 → 6 when `doNotKnock` was
// added (the compliance "never return" block must show on the pin); 6 → 7 when
// `lastOutcomeAt` was added — the recency clock the server's outcome CAS
// orders writes by (leads.last_outcome_at; the knock join's time for legacy
// rows). The live lead stream carries the same clock on every push, so without
// it on the pin the client cannot re-run the server's ordering rule when a
// push and a refetch race — it was falling back to lastKnockedAt, which a
// central mark (no knock row) never advances.
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
//
// 7 → 8: `freshSources` (the independent-evidence provenance list) and
// `freshConfirmedAt` (the field-verification stamp) joined the projection so
// the FCC source filter and the "Field-verified" pill can be computed on the
// client without a per-lead detail fetch. Both ride along for the bbox-window
// responses as well — the packed schema is the SAME for the full feed and a
// bbox window, only the row set differs.
//
// 8 → 9: `buyerScore` (shared/buyerScore.ts, 1.0 to 10.0 or absent) joined the
// projection so Today's route and the field map can show the household-level
// "will they buy" number without a per-lead detail fetch. The reasons list
// stays on the lead row (detail fetch): it is text, and the full feed is
// shipped for every pin in the tenant.
export const MAP_PINS_WIRE_VERSION = 9 as const;

export const MAP_PIN_WIRE_FIELDS = [
  "id", "lat", "lng", "leadStatus", "address", "city", "state", "zip",
  "fiberStatus", "assignedRepId", "leadScore", "visited", "knockCount",
  "lastOutcome", "lastKnockedAt", "leadTag", "freshConfidence", "carrier",
  "assignMark", "assignedTerritoryId", "doNotKnock", "lastOutcomeAt",
  "freshSources", "freshConfirmedAt", "buyerScore",
] as const;

export type MapPinWireField = typeof MAP_PIN_WIRE_FIELDS[number];

export interface PackedMapPins {
  v: typeof MAP_PINS_WIRE_VERSION;
  total: number;
  rows: unknown[][];
  // Set ONLY on bbox-window responses that hit the server-side row cap: the
  // window holds more pins than were shipped, so the client knows the viewport
  // is a sample, not the whole window. Absent (undefined) on the full feed.
  truncated?: boolean;
  // The window's TRUE row count, shipped alongside truncated:true so the
  // client can (a) render honest aggregate counts instead of a thinned
  // sample and (b) predict whether a zoomed-in window will fit under the cap
  // without paying a discarded fetch. Absent on complete windows and the
  // full feed. Additive: old clients ignore it.
  windowCount?: number;
}

export function packMapPins<T extends Partial<Record<MapPinWireField, unknown>>>(pins: readonly T[], opts?: { truncated?: boolean; total?: number; windowCount?: number }): PackedMapPins {
  return {
    v: MAP_PINS_WIRE_VERSION,
    total: opts?.total ?? pins.length,
    rows: pins.map((pin) => MAP_PIN_WIRE_FIELDS.map((field) => pin[field] ?? null)),
    ...(opts?.truncated ? { truncated: true } : {}),
    ...(opts?.truncated && opts?.windowCount != null ? { windowCount: opts.windowCount } : {}),
  };
}

export function unpackMapPins<T extends Partial<Record<MapPinWireField, unknown>>>(payload: unknown): { pins: T[]; total: number; truncated: boolean; windowCount?: number } {
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
  return {
    pins,
    total: typeof packed.total === "number" ? packed.total : pins.length,
    truncated: packed.truncated === true,
    ...(typeof packed.windowCount === "number" ? { windowCount: packed.windowCount } : {}),
  };
}
