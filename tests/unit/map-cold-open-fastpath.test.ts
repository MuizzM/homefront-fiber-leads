// Cold-open critical path for viewport-mode (big-map) orgs.
//
// The production complaint: "leads are not loading — so slow". The cold open
// serialized map boot → count-probe RTT → viewportMode flip → moveend bind →
// 300ms debounce → window fetch → first paint, and the mode-flip snapshot
// prune (correct for FULL-FEED snapshots, which can never refresh in viewport
// mode) left these orgs with an EMPTY cache — nothing painted until the whole
// waterfall finished. The fix, pinned here:
//   1. persisted viewport MODE (versioned key, identity-scoped, cross-user
//      swept) — a returning big-map user boots straight into viewport mode;
//   2. the FIRST window fetch after boot skips the 300ms debounce;
//   3. a WINDOW-scoped snapshot (pins + their bbox) seeds the cache instantly
//      when the persisted camera's view intersects it — born stale, replaced
//      (with in-window eviction) by the immediate boot fetch;
//   4. pins/grid fetches stay independent — nothing serializes behind the
//      probe or behind each other.
//
// Part 1: behavioral tests of the new lib surface against a fake Storage.
// Part 2: source assertions pinning MapView's no-waterfall wiring (MapView
// cannot be mounted without a live GL context — same approach as
// map-pins-snapshot.test.ts / map-viewport-wiring.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAP_VIEWPORT_MODE_PREFIX,
  MAP_VIEWPORT_MODE_VERSION,
  MAP_WINDOW_SNAPSHOT_PREFIX,
  MAP_WINDOW_SNAPSHOT_MAX_BYTES,
  MAP_PINS_SNAPSHOT_PREFIX,
  mapViewportModeKey,
  readPersistedViewportMode,
  writePersistedViewportMode,
  pruneMapViewportModes,
  mapWindowSnapshotKey,
  readMapWindowSnapshot,
  writeMapWindowSnapshot,
  pruneMapWindowSnapshots,
  writeMapPinsSnapshot,
  readMapPinsSnapshot,
  type SnapshotStorage,
} from "@/lib/mapPinsSnapshot";
import { MAP_PINS_WIRE_VERSION, packMapPins } from "@shared/mapPinsWire";
import { bboxIntersects, cameraViewBBox, mergeViewportPins } from "@/lib/mapViewport";

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
const WINDOW = { minLng: -80.6, minLat: 35.4, maxLng: -80.2, maxLat: 35.7 };
const PINS = [
  { id: 1, lat: 35.5, lng: -80.4, address: "402 Nard Ln", city: "Inman", state: "SC", zip: "29349", leadStatus: "prospect" },
  { id: 2, lat: 35.51, lng: -80.41, address: "404 Nard Ln", city: "Inman", state: "SC", zip: "29349", leadStatus: "sold", visited: 1 },
];

// ── Part 1a: persisted viewport mode ─────────────────────────────────────────
describe("persisted viewport mode — the no-probe-wait boot hint", () => {
  it("key is versioned and identity-scoped", () => {
    const key = mapViewportModeKey(SCOPE_A);
    expect(key.startsWith(MAP_VIEWPORT_MODE_PREFIX)).toBe(true);
    expect(key).toContain(`v${MAP_VIEWPORT_MODE_VERSION}`);
    expect(key).toContain(".t7");
    expect(key).toContain(".u42");
    expect(mapViewportModeKey(SCOPE_B)).not.toBe(key);
  });

  it("round-trips both answers; unknown identity reads null (= wait for the probe)", () => {
    const s = fakeStorage();
    expect(readPersistedViewportMode(SCOPE_A, s)).toBeNull();
    writePersistedViewportMode(SCOPE_A, true, s);
    expect(readPersistedViewportMode(SCOPE_A, s)).toBe(true);
    writePersistedViewportMode(SCOPE_A, false, s);
    expect(readPersistedViewportMode(SCOPE_A, s)).toBe(false);
  });

  it("cross-user swept: user B reads null AND user A's entry is removed", () => {
    const s = fakeStorage();
    writePersistedViewportMode(SCOPE_A, true, s);
    expect(readPersistedViewportMode(SCOPE_B, s)).toBeNull();
    expect(s.getItem(mapViewportModeKey(SCOPE_A))).toBeNull();
  });

  it("a stale-VERSION key is unreachable and swept on read", () => {
    const s = fakeStorage();
    s.setItem(`${MAP_VIEWPORT_MODE_PREFIX}v${MAP_VIEWPORT_MODE_VERSION - 1}.t7.u42`, "1");
    expect(readPersistedViewportMode(SCOPE_A, s)).toBeNull();
    expect(Object.keys(s.dump()).filter((k) => k.startsWith(MAP_VIEWPORT_MODE_PREFIX))).toEqual([]);
  });

  it("garbage value reads null; prune with no keeper clears only this family", () => {
    const s = fakeStorage();
    s.setItem(mapViewportModeKey(SCOPE_A), "banana");
    expect(readPersistedViewportMode(SCOPE_A, s)).toBeNull();
    writePersistedViewportMode(SCOPE_A, true, s);
    s.setItem("hf.mapCamera.v1", "{}"); // unrelated key must survive
    pruneMapViewportModes(undefined, s);
    expect(Object.keys(s.dump())).toEqual(["hf.mapCamera.v1"]);
  });
});

// ── Part 1b: window-scoped snapshot ──────────────────────────────────────────
describe("window snapshot — instant first paint for viewport orgs", () => {
  it("key embeds wire version + tenant + user (same axes as the full-feed family)", () => {
    const key = mapWindowSnapshotKey(SCOPE_A);
    expect(key.startsWith(MAP_WINDOW_SNAPSHOT_PREFIX)).toBe(true);
    expect(key).toContain(`v${MAP_PINS_WIRE_VERSION}`);
    expect(key).toContain(".t7");
    expect(key).toContain(".u42");
  });

  it("write → read returns pins in query-cache shape PLUS the window bbox", () => {
    const s = fakeStorage();
    expect(writeMapWindowSnapshot(SCOPE_A, PINS, WINDOW, s)).toBe(true);
    const snap = readMapWindowSnapshot<(typeof PINS)[number]>(SCOPE_A, s);
    expect(snap).not.toBeNull();
    expect(snap!.total).toBe(2);
    expect(snap!.pins[0]).toMatchObject({ id: 1, address: "402 Nard Ln", lat: 35.5 });
    expect(snap!.window).toEqual(WINDOW);
  });

  it("temp optimistic pins (negative ids) never persist; an empty window never clobbers", () => {
    const s = fakeStorage();
    writeMapWindowSnapshot(SCOPE_A, [...PINS, { id: -1, lat: 35.52, lng: -80.42 }], WINDOW, s);
    expect(readMapWindowSnapshot(SCOPE_A, s)!.pins.map((p: any) => p.id)).toEqual([1, 2]);
    expect(writeMapWindowSnapshot(SCOPE_A, [], WINDOW, s)).toBe(false);
    expect(readMapWindowSnapshot(SCOPE_A, s)!.pins).toHaveLength(2);
  });

  it("wire-version mismatch → null and dropped (the stale-seed ban, shared wire code)", () => {
    const s = fakeStorage();
    const stale = { w: [WINDOW.minLng, WINDOW.minLat, WINDOW.maxLng, WINDOW.maxLat], p: { ...packMapPins(PINS), v: MAP_PINS_WIRE_VERSION - 1 } };
    s.setItem(mapWindowSnapshotKey(SCOPE_A), JSON.stringify(stale));
    expect(readMapWindowSnapshot(SCOPE_A, s)).toBeNull();
    expect(s.getItem(mapWindowSnapshotKey(SCOPE_A))).toBeNull();
  });

  it("corrupt JSON and malformed bbox both read null and drop the entry", () => {
    const s = fakeStorage();
    s.setItem(mapWindowSnapshotKey(SCOPE_A), "{not json");
    expect(readMapWindowSnapshot(SCOPE_A, s)).toBeNull();
    s.setItem(mapWindowSnapshotKey(SCOPE_A), JSON.stringify({ w: [1, 2, 3], p: packMapPins(PINS) }));
    expect(readMapWindowSnapshot(SCOPE_A, s)).toBeNull();
    s.setItem(mapWindowSnapshotKey(SCOPE_A), JSON.stringify({ w: [2, 2, 1, 1], p: packMapPins(PINS) })); // min >= max
    expect(readMapWindowSnapshot(SCOPE_A, s)).toBeNull();
    expect(s.getItem(mapWindowSnapshotKey(SCOPE_A))).toBeNull();
  });

  it("oversize payload skips the write AND drops the stale copy (1.5MB cap)", () => {
    const s = fakeStorage();
    writeMapWindowSnapshot(SCOPE_A, PINS, WINDOW, s);
    const huge = [{ id: 5, lat: 1, lng: 2, address: "x".repeat(MAP_WINDOW_SNAPSHOT_MAX_BYTES + 1) }];
    expect(writeMapWindowSnapshot(SCOPE_A, huge, WINDOW, s)).toBe(false);
    expect(readMapWindowSnapshot(SCOPE_A, s)).toBeNull();
  });

  it("cross-user swept, and the sweep never touches the OTHER map families", () => {
    const s = fakeStorage();
    writeMapWindowSnapshot(SCOPE_A, PINS, WINDOW, s);
    writePersistedViewportMode(SCOPE_A, true, s);
    writeMapPinsSnapshot(SCOPE_A, PINS, s);
    expect(readMapWindowSnapshot(SCOPE_B, s)).toBeNull();
    expect(s.getItem(mapWindowSnapshotKey(SCOPE_A))).toBeNull(); // previous user swept
    // sibling families untouched by the window sweep
    expect(s.getItem(mapViewportModeKey(SCOPE_A))).toBe("1");
    expect(readMapPinsSnapshot(SCOPE_A, s)).not.toBeNull();
    // ...and pruning window snapshots wholesale (the probe answered full-feed)
    // also leaves the full-feed family alone.
    writeMapWindowSnapshot(SCOPE_A, PINS, WINDOW, s);
    pruneMapWindowSnapshots(undefined, s);
    expect(readMapWindowSnapshot(SCOPE_A, s)).toBeNull();
    expect(readMapPinsSnapshot(SCOPE_A, s)).not.toBeNull();
    expect(Object.keys(s.dump()).some((k) => k.startsWith(MAP_PINS_SNAPSHOT_PREFIX))).toBe(true);
  });
});

// ── Part 1c: the seed gate (camera view ∩ snapshot window) ───────────────────
describe("cameraViewBBox + bboxIntersects — seed only where the camera opens", () => {
  it("the persisted camera over the snapshot window intersects", () => {
    const view = cameraViewBBox([-80.4, 35.5], 15, 390, 844);
    expect(bboxIntersects(view, WINDOW)).toBe(true);
  });

  it("a camera parked in another city does NOT seed", () => {
    const view = cameraViewBBox([-78.6, 35.8], 15, 390, 844); // Raleigh vs the Rockwell window
    expect(bboxIntersects(view, WINDOW)).toBe(false);
  });

  it("view span halves per zoom level and clamps to world bounds", () => {
    const z10 = cameraViewBBox([-80.4, 35.5], 10, 1024, 768);
    const z11 = cameraViewBBox([-80.4, 35.5], 11, 1024, 768);
    expect((z10.maxLng - z10.minLng) / (z11.maxLng - z11.minLng)).toBeCloseTo(2, 5);
    const world = cameraViewBBox([0, 0], 0, 4096, 4096);
    expect(world.minLng).toBeGreaterThanOrEqual(-180);
    expect(world.maxLat).toBeLessThanOrEqual(90);
  });
});

// ── Part 1d: seed replacement — the complete boot window may evict ───────────
describe("mergeViewportPins evictWindow — server truth replaces the seed", () => {
  const keep = { minLng: -81, minLat: 35, maxLng: -80, maxLat: 36 };
  const fetchedWindow = { minLng: -80.6, minLat: 35.4, maxLng: -80.3, maxLat: 35.6 };
  const seeded = [
    { id: 1, lat: 35.5, lng: -80.4 },   // still on the server
    { id: 2, lat: 35.51, lng: -80.41 }, // deleted since last session
    { id: 3, lat: 35.9, lng: -80.9 },   // outside the fetched window — must survive
  ];
  const fetched = [{ id: 1, lat: 35.5, lng: -80.4 }, { id: 4, lat: 35.52, lng: -80.42 }];

  it("a seeded row the complete window disowned is evicted; out-of-window seeds survive", () => {
    const r = mergeViewportPins(seeded, fetched, keep, fetchedWindow);
    expect(r.pins.map((p) => p.id).sort()).toEqual([1, 3, 4]);
    expect(r.pruned).toBe(1);
  });

  it("without evictWindow (sampled fetches, ordinary pans) absence never evicts — the standing rule", () => {
    const r = mergeViewportPins(seeded, fetched, keep);
    expect(r.pins.map((p) => p.id).sort()).toEqual([1, 2, 3, 4]);
    expect(r.pruned).toBe(0);
  });
});

// ── Part 2: MapView wiring (source assertions) ───────────────────────────────
const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "client/src/pages/MapView.tsx"), "utf8");

function block(startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start, `marker not found: ${startMarker}`).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start);
  expect(end, `end marker not found: ${endMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("MapView no-waterfall wiring", () => {
  it("viewportMode uses the probe when answered, else the persisted hint (never on probe error)", () => {
    const b = block("const persistedViewportModeHint", "const viewportModeRef");
    // The hint is per-LENS now (view rides the scope): a "latest" boot must
    // never answer from the mode the "all" probe persisted.
    expect(b).toContain("readPersistedViewportMode({ tenantId: user.tenantId, userId: user.id, view: countView })");
    expect(b).toContain("mapPinCount != null");
    expect(b).toContain("mapPinCount.total > MAP_VIEWPORT_MODE_THRESHOLD");
    expect(b).toContain("!countQuery.isError && (persistedViewportModeHint ?? false)");
  });

  it("only the probe's ANSWER is persisted, and a full-feed answer prunes the window family", () => {
    const b = block("// Teach the NEXT cold open", "}, [mapPinCount?.total, user?.id, user?.tenantId, countView]);");
    expect(b).toContain("if (!user || mapPinCount == null) return;");
    expect(b).toContain("writePersistedViewportMode({ tenantId: user.tenantId, userId: user.id, view: countView }, confirmed)");
    expect(b).toContain("if (!confirmed) pruneMapWindowSnapshots();");
  });

  it("the window-snapshot seed gates on camera-view intersection and seeds the SAME cache entry", () => {
    const b = block("const windowSeedRef", "}, [user?.id, user?.tenantId, viewportMode, qc]);");
    expect(b).toContain("readMapWindowSnapshot<MapPin>({ tenantId: user.tenantId, userId: user.id })");
    expect(b).toContain("readPersistedMapCamera()");
    expect(b).toContain("cameraViewBBox(");
    expect(b).toContain("if (!bboxIntersects(view, snap.window)) return;");
    expect(b).toContain('qc.setQueryData(["/api/leads/map"], { pins: snap.pins, total: snap.pins.length });');
    expect(b).toContain("windowSeedRef.current = snap.window;");
  });

  it("the FIRST window fetch after boot skips the 300ms debounce; later binds/moves keep it", () => {
    const b = block("const firstViewportFetchRef", "}, [mapReady, styleEpoch, viewportMode]);");
    expect(b).toContain("useRef(true)");
    expect(b).toContain("firstViewportFetchRef.current = false;");
    // the boot branch calls the refresher DIRECTLY (no setTimeout wrapping it)
    expect(b).toContain("refreshViewportPinsRef.current(); // boot: no debounce on the first fetch");
    // the debounce survives for real moveends
    expect(b).toContain("setTimeout(() => refreshViewportPinsRef.current(), 300)");
    expect(b).toContain('map.on("moveend", onMoveEnd);');
  });

  it("a COMPLETE window fetch replaces the seed with eviction and rewrites the snapshot (debounced)", () => {
    const b = block("const fetchViewportPins = useCallback", "const fetchViewportPinsRef");
    // The truncated (over-cap) path EARLY-RETURNS into the grid-tier flip, so
    // everything below it runs for complete windows only — eviction, seed
    // reconcile, and the snapshot write need no !truncated guard anymore.
    expect(b).toContain("if (truncated) {");
    expect(b).toContain("refreshViewportPinsRef.current();");
    expect(b).toContain("const evictWindow = windowSeedRef.current ? window : null;");
    expect(b).toContain("mergeViewportPins(prev, fetched, keep, evictWindow)");
    expect(b).toContain("windowSeedRef.current = null; // seed fully reconciled");
    // COMPLETE windows only feed the snapshot; the debounced write itself
    // lives OUTSIDE the fetch body (the #87 purity scan bans timers there).
    expect(b).toContain("scheduleWindowSnapshotWrite(fetched, window);");
    const writer = block("const scheduleWindowSnapshotWrite = useCallback", "const fetchViewportPins = useCallback");
    expect(writer).toContain("writeMapWindowSnapshot(scope, pins, win)");
    expect(writer).toContain("MAP_PINS_SNAPSHOT_DEBOUNCE_MS");
    expect(writer).toContain("snapshotScopeRef.current");
  });

  it("pins and grid fetches are independent — neither chains behind the other", () => {
    const pins = block("const fetchViewportPins = useCallback", "const fetchViewportPinsRef");
    const grid = block("const fetchViewportGrid = useCallback", "const fetchViewportGridRef");
    expect(pins).not.toContain("fetchViewportGrid");
    expect(grid).not.toContain("fetchViewportPins");
    // separate in-flight controllers: a pan can abort one without the other
    expect(pins).toContain("viewportAbortRef.current?.abort()");
    expect(grid).toContain("gridAbortRef.current?.abort()");
  });

  it("the full-feed snapshot path is UNCHANGED (initialData seed + viewport-mode ban)", () => {
    // Guard against this feature accidentally rerouting the small-org path.
    expect(src).toContain("readMapPinsSnapshot<MapPin>({ tenantId: user?.tenantId, userId: user?.id })");
    expect(src).toContain("initialDataUpdatedAt: 0");
    expect(src).toContain("if (!user || viewportMode) return;");
  });
});
