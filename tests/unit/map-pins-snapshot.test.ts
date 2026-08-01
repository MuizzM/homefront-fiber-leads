// Last-session pin snapshot — pins paint on the FIRST frame of a cold open.
//
// Part 1: behavioral unit tests of lib/mapPinsSnapshot against a fake Storage
// (round-trip, wire-version mismatch → null, corrupt JSON → null, identity
// scoping, temp-pin exclusion, oversize skip).
// Part 2: source assertions pinning MapView's wiring (seed as initialData that
// is instantly stale; debounced write; viewport mode never snapshots).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAP_PINS_SNAPSHOT_PREFIX,
  MAP_PINS_SNAPSHOT_MAX_BYTES,
  mapPinsSnapshotKey,
  pruneMapPinsSnapshots,
  readMapPinsSnapshot,
  writeMapPinsSnapshot,
  type SnapshotStorage,
} from "@/lib/mapPinsSnapshot";
import { MAP_PINS_WIRE_VERSION, packMapPins } from "@shared/mapPinsWire";

function fakeStorage(): SnapshotStorage & { dump(): Record<string, string> } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
    dump: () => Object.fromEntries(m),
  };
}

const SCOPE_A = { tenantId: 7, userId: 42 };
const SCOPE_B = { tenantId: 7, userId: 99 };
const PINS = [
  { id: 1, lat: 35.5, lng: -80.4, address: "402 Nard Ln", city: "Inman", state: "SC", zip: "29349", leadStatus: "prospect" },
  { id: 2, lat: 35.51, lng: -80.41, address: "404 Nard Ln", city: "Inman", state: "SC", zip: "29349", leadStatus: "sold", visited: 1 },
];

describe("snapshot key", () => {
  it("embeds wire version, tenant, and user — all three invalidation axes", () => {
    const key = mapPinsSnapshotKey(SCOPE_A);
    expect(key.startsWith(MAP_PINS_SNAPSHOT_PREFIX)).toBe(true);
    expect(key).toContain(`v${MAP_PINS_WIRE_VERSION}`);
    expect(key).toContain(".t7");
    expect(key).toContain(".u42");
    expect(mapPinsSnapshotKey(SCOPE_B)).not.toBe(key);
  });
});

describe("round-trip", () => {
  it("write → read returns the pins in query-cache shape ({ pins, total })", () => {
    const s = fakeStorage();
    expect(writeMapPinsSnapshot(SCOPE_A, PINS, s)).toBe(true);
    const snap = readMapPinsSnapshot<(typeof PINS)[number]>(SCOPE_A, s);
    expect(snap).not.toBeNull();
    expect(snap!.total).toBe(2);
    expect(snap!.pins).toHaveLength(2);
    expect(snap!.pins[0]).toMatchObject({ id: 1, address: "402 Nard Ln", lat: 35.5 });
    expect(snap!.pins[1]).toMatchObject({ id: 2, leadStatus: "sold" });
  });

  it("temp optimistic pins (negative ids) never persist", () => {
    const s = fakeStorage();
    writeMapPinsSnapshot(SCOPE_A, [...PINS, { id: -1, lat: 35.52, lng: -80.42, address: "" }], s);
    const snap = readMapPinsSnapshot(SCOPE_A, s)!;
    expect(snap.pins.map((p: any) => p.id)).toEqual([1, 2]);
  });

  it("an all-temp (or empty) pin set writes nothing rather than clobbering a good snapshot", () => {
    const s = fakeStorage();
    writeMapPinsSnapshot(SCOPE_A, PINS, s);
    expect(writeMapPinsSnapshot(SCOPE_A, [{ id: -3, lat: 1, lng: 2 }], s)).toBe(false);
    expect(readMapPinsSnapshot(SCOPE_A, s)!.pins).toHaveLength(2);
    expect(writeMapPinsSnapshot(SCOPE_A, [], s)).toBe(false);
  });
});

describe("invalidation — every bad payload reads as null", () => {
  it("wire-version mismatch under the current key → null, and the entry is dropped", () => {
    const s = fakeStorage();
    const stale = { ...packMapPins(PINS), v: MAP_PINS_WIRE_VERSION - 1 };
    s.setItem(mapPinsSnapshotKey(SCOPE_A), JSON.stringify(stale));
    expect(readMapPinsSnapshot(SCOPE_A, s)).toBeNull();
    expect(s.getItem(mapPinsSnapshotKey(SCOPE_A))).toBeNull();
  });

  it("a previous wire version's KEY is unreachable and pruned on read", () => {
    const s = fakeStorage();
    const oldKey = `${MAP_PINS_SNAPSHOT_PREFIX}v${MAP_PINS_WIRE_VERSION - 1}.t7.u42`;
    s.setItem(oldKey, JSON.stringify(packMapPins(PINS)));
    expect(readMapPinsSnapshot(SCOPE_A, s)).toBeNull();
    expect(s.getItem(oldKey)).toBeNull(); // stale-version snapshot swept
  });

  it("corrupt JSON → null, and the entry is dropped", () => {
    const s = fakeStorage();
    s.setItem(mapPinsSnapshotKey(SCOPE_A), "{not json");
    expect(readMapPinsSnapshot(SCOPE_A, s)).toBeNull();
    expect(s.getItem(mapPinsSnapshotKey(SCOPE_A))).toBeNull();
  });

  it("a row-shape mismatch (foreign object) → null", () => {
    const s = fakeStorage();
    s.setItem(mapPinsSnapshotKey(SCOPE_A), JSON.stringify({ v: MAP_PINS_WIRE_VERSION, rows: [[1, 2]] }));
    expect(readMapPinsSnapshot(SCOPE_A, s)).toBeNull();
  });
});

describe("identity scoping — shared-device safety", () => {
  it("user B can never read user A's snapshot", () => {
    const s = fakeStorage();
    writeMapPinsSnapshot(SCOPE_A, PINS, s);
    expect(readMapPinsSnapshot(SCOPE_B, s)).toBeNull();
  });

  it("reading as a new identity PRUNES the previous identity's snapshot", () => {
    const s = fakeStorage();
    writeMapPinsSnapshot(SCOPE_A, PINS, s);
    readMapPinsSnapshot(SCOPE_B, s);
    expect(s.getItem(mapPinsSnapshotKey(SCOPE_A))).toBeNull();
  });

  it("writing keeps exactly ONE snapshot on the device", () => {
    const s = fakeStorage();
    writeMapPinsSnapshot(SCOPE_A, PINS, s);
    writeMapPinsSnapshot(SCOPE_B, PINS, s);
    const keys = Object.keys(s.dump()).filter((k) => k.startsWith(MAP_PINS_SNAPSHOT_PREFIX));
    expect(keys).toEqual([mapPinsSnapshotKey(SCOPE_B)]);
  });

  it("pruneMapPinsSnapshots with no keeper clears everything under the prefix", () => {
    const s = fakeStorage();
    writeMapPinsSnapshot(SCOPE_A, PINS, s);
    s.setItem("hf.mapFilterStatus.v1", "sold"); // unrelated key must survive
    pruneMapPinsSnapshots(undefined, s);
    expect(Object.keys(s.dump())).toEqual(["hf.mapFilterStatus.v1"]);
  });
});

describe("size guard", () => {
  it("an oversize payload skips the write AND drops any stale copy", () => {
    const s = fakeStorage();
    writeMapPinsSnapshot(SCOPE_A, PINS, s);
    const huge = [{ id: 5, lat: 1, lng: 2, address: "x".repeat(MAP_PINS_SNAPSHOT_MAX_BYTES + 1) }];
    expect(writeMapPinsSnapshot(SCOPE_A, huge, s)).toBe(false);
    expect(readMapPinsSnapshot(SCOPE_A, s)).toBeNull();
  });
});

// ── Part 2: MapView wiring ───────────────────────────────────────────────────
const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "client/src/pages/MapView.tsx"), "utf8");

describe("MapView seeds and writes the snapshot correctly", () => {
  // The ["/api/leads/map"] useQuery options block.
  const queryStart = src.indexOf('queryKey: ["/api/leads/map"]');
  const queryBlock = src.slice(queryStart, src.indexOf("refetchOnWindowFocus", queryStart));

  it("seeds the map query with the snapshot as initialData, scoped to the signed-in identity", () => {
    expect(queryBlock).toContain("initialData: () =>");
    expect(queryBlock).toContain("readMapPinsSnapshot<MapPin>({ tenantId: user?.tenantId, userId: user?.id })");
  });

  it("marks the seed instantly stale so the real fetch replaces it immediately", () => {
    expect(queryBlock).toContain("initialDataUpdatedAt: 0");
  });

  it("writes the snapshot debounced after the full feed settles", () => {
    const writer = src.slice(src.indexOf("const snapshotTimerRef"), src.indexOf("}, [mapPinData, user, viewportMode]);"));
    expect(writer).toContain("setTimeout");
    expect(writer).toContain("MAP_PINS_SNAPSHOT_DEBOUNCE_MS");
    expect(writer).toContain("writeMapPinsSnapshot(scope, pins)");
  });

  it("NEVER snapshots in viewport mode — a bbox window is a partial slice", () => {
    const writer = src.slice(src.indexOf("const snapshotTimerRef"), src.indexOf("}, [mapPinData, user, viewportMode]);"));
    const guard = writer.indexOf("if (!user || viewportMode) return;");
    const write = writer.indexOf("writeMapPinsSnapshot");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(write);
  });
});
